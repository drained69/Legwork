import { fetchWithTimeout } from '../http.js';

/**
 * Live market-data answers for price questions routed to the miner.
 *
 * The WEB_SEARCH epoch question set includes live-data probes — "What is the
 * current price of Bitcoin in US dollars as of September 2, 2026?" — and the
 * intent's champions answer them from LIVE sources (web-search grounding).
 * Answering from model knowledge is a confident wrong number, which scores as
 * a non-answer. This module answers price questions from CoinGecko's free
 * public API (no key), with the as-of date the question asked for.
 *
 * CoinGecko's free tier allows ~10-30 calls/minute — far above epoch-scoring
 * volume. Failure here is never fatal: the caller falls through to the
 * general-answer path exactly as before.
 */

const COINGECKO_TIMEOUT_MS = 4_000;

/** Assets we can price, by the names and tickers people actually use. */
const ASSETS: Record<string, { id: string; name: string }> = {
  bitcoin: { id: 'bitcoin', name: 'Bitcoin' },
  btc: { id: 'bitcoin', name: 'Bitcoin' },
  ethereum: { id: 'ethereum', name: 'Ethereum' },
  eth: { id: 'ethereum', name: 'Ethereum' },
  solana: { id: 'solana', name: 'Solana' },
  sol: { id: 'solana', name: 'Solana' },
  xrp: { id: 'ripple', name: 'XRP' },
  ripple: { id: 'ripple', name: 'XRP' },
  dogecoin: { id: 'dogecoin', name: 'Dogecoin' },
  doge: { id: 'dogecoin', name: 'Dogecoin' },
  cardano: { id: 'cardano', name: 'Cardano' },
  ada: { id: 'cardano', name: 'Cardano' },
  bnb: { id: 'binancecoin', name: 'BNB' },
  'binance coin': { id: 'binancecoin', name: 'BNB' },
  litecoin: { id: 'litecoin', name: 'Litecoin' },
  ltc: { id: 'litecoin', name: 'Litecoin' },
  chainlink: { id: 'chainlink', name: 'Chainlink' },
  link: { id: 'chainlink', name: 'Chainlink' },
  avalanche: { id: 'avalanche-2', name: 'Avalanche' },
  avax: { id: 'avalanche-2', name: 'Avalanche' },
  polkadot: { id: 'polkadot', name: 'Polkadot' },
  dot: { id: 'polkadot', name: 'Polkadot' },
  tron: { id: 'tron', name: 'TRON' },
  trx: { id: 'tron', name: 'TRON' },
  shiba: { id: 'shiba-inu', name: 'Shiba Inu' },
  shib: { id: 'shiba-inu', name: 'Shiba Inu' },
  pepe: { id: 'pepe', name: 'Pepe' },
  tether: { id: 'tether', name: 'Tether' },
  usdt: { id: 'tether', name: 'Tether' },
  sui: { id: 'sui', name: 'Sui' },
  toncoin: { id: 'the-open-network', name: 'Toncoin' },
  ton: { id: 'the-open-network', name: 'Toncoin' },
};

/**
 * Is this a "what does X cost / what is the price of X" question about a
 * market asset? Deliberately narrow: it must be asking FOR a price, not
 * mentioning one ("jobs paying at least $150k" is not a price question).
 */
const PRICE_QUESTION =
  /\b(price|value|worth|trading at|quoting at|cost)\b/i;

/** Question shape — asking, not commanding. "Find me a role" is not a question. */
const INTERROGATIVE = /^(what|whats|what's|how much|how many|what is|what was|tell me|price|value|worth)\b/i;

/**
 * Does this routed question ask for the live price of an asset we can price?
 *
 * Both conditions must hold: price vocabulary in question form, AND a
 * recognizable asset named. "What is the current price of Bitcoin in US
 * dollars as of September 2, 2026?" → yes. "Find jobs paying over $150k" →
 * no (imperative, no asset).
 */
export function isPriceQuestion(text: string): boolean {
  if (!PRICE_QUESTION.test(text)) return false;
  if (!INTERROGATIVE.test(text.trim())) return false;
  return findAsset(text) !== undefined;
}

/** The asset a price question names, or undefined. */
function findAsset(text: string): { id: string; name: string } | undefined {
  // Longest names first so "binance coin" is not read as "coin".
  const names = Object.keys(ASSETS).sort((a, b) => b.length - a.length);
  for (const name of names) {
    // Word-boundary match; "btc" must not match inside "btcpp".
    if (new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(text)) {
      return ASSETS[name];
    }
  }
  return undefined;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

/** "September 2, 2026" / "Sep 2 2026" / "2026-09-02" → Date, or undefined. */
function findDate(text: string): Date | undefined {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) {
    const d = new Date(Date.UTC(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3])));
    if (!Number.isNaN(d.getTime())) return d;
  }
  const spoken = text.match(new RegExp(`\\b(${MONTHS.join('|')}|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\\w*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, 'i'));
  if (spoken) {
    const month = MONTHS.findIndex((m) => m.startsWith(spoken[1].toLowerCase().slice(0, 3)));
    if (month >= 0) {
      const d = new Date(Date.UTC(Number(spoken[3]), month, Number(spoken[2])));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return undefined;
}

export interface PriceAnswer {
  label: string;
  confidence: number;
  reason: string;
}

/**
 * Answer a price question from live data. Returns null when anything fails —
 * the caller falls through to the general-answer path.
 */
export async function answerPriceQuestion(text: string): Promise<PriceAnswer | null> {
  const asset = findAsset(text);
  if (!asset) return null;
  const when = findDate(text);
  try {
    // A past date asks for that day's price; today or no date asks for live.
    // (CoinGecko history is only meaningful for COMPLETED days.)
    const todayUtc = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
    if (when && when.getTime() < todayUtc.getTime()) {
      const ddMmYyyy = (d: Date): string => `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
      const prev = new Date(when.getTime() - 86_400_000);
      // The question usually asks for the price CHANGE too — fetch the prior
      // day and compute it. One extra free call; skipped silently if it fails.
      const [hist, histPrev] = await Promise.all([
        fetchWithTimeout(
          `https://api.coingecko.com/api/v3/coins/${asset.id}/history?date=${ddMmYyyy(when)}&localization=false`,
          {},
          COINGECKO_TIMEOUT_MS,
        ).then((r) => (r.ok ? (r.json() as Promise<{ market_data?: { current_price?: { usd?: number } } }>) : null)),
        fetchWithTimeout(
          `https://api.coingecko.com/api/v3/coins/${asset.id}/history?date=${ddMmYyyy(prev)}&localization=false`,
          {},
          COINGECKO_TIMEOUT_MS,
        ).then((r) => (r.ok ? (r.json() as Promise<{ market_data?: { current_price?: { usd?: number } } }>) : null)).catch(() => null),
      ]);
      if (!hist) return null;
      const price = hist.market_data?.current_price?.usd;
      if (typeof price !== 'number' || !Number.isFinite(price)) return null;
      const prevPrice = histPrev?.market_data?.current_price?.usd;
      const dateStr = when.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      const changePct = typeof prevPrice === 'number' && prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : undefined;
      const changeText = changePct !== undefined
        ? ` The change from the previous day (${prevPrice ? '$' + formatUsd(prevPrice) : '—'}) was ${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%.`
        : '';
      return {
        label: `${asset.name} price on ${dateStr}: $${formatUsd(price)}${changePct !== undefined ? ` (${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}% vs previous day)` : ''}`,
        confidence: 0.9,
        reason:
          `${asset.name} traded at $${formatUsd(price)} on ${dateStr}, from CoinGecko's historical daily data for that date.${changeText} ` +
          `The figure is the recorded USD price for the day the question asked about, not a model's recollection. ` +
          `For today's live price or other assets, ask without a date.`,
      };
    }

    // Live: current price plus the 24h change the question typically asks about.
    const res = await fetchWithTimeout(
      `https://api.coingecko.com/api/v3/simple/price?ids=${asset.id}&vs_currencies=usd&include_24hr_change=true&include_last_updated_at=true`,
      {},
      COINGECKO_TIMEOUT_MS,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      [id: string]: { usd?: number; usd_24h_change?: number; last_updated_at?: number };
    };
    const row = data[asset.id];
    const price = row?.usd;
    if (typeof price !== 'number' || !Number.isFinite(price)) return null;
    const change = typeof row.usd_24h_change === 'number' ? row.usd_24h_change : undefined;
    const asOf = row.last_updated_at ? new Date(row.last_updated_at * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC' : 'just now';
    const changeText = change !== undefined
      ? ` The price change over the last 24 hours is ${change >= 0 ? '+' : ''}${change.toFixed(2)}%.`
      : '';
    return {
      label: `${asset.name} price: $${formatUsd(price)}${change !== undefined ? ` (${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h)` : ''}`,
      confidence: 0.9,
      reason:
        `The current price of ${asset.name} is $${formatUsd(price)} USD as of ${asOf}, fetched live from CoinGecko at request time.${changeText} ` +
        `This is live market data, not model knowledge — the figure reflects the market at the moment the question was answered.`,
    };
  } catch {
    return null; // network/parse failure → the general-answer path takes over
  }
}

function formatUsd(n: number): string {
  return n >= 100 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
