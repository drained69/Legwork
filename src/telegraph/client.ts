import { createHash } from 'node:crypto';
import { Wallet } from 'ethers';
import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { config } from '../config.js';
import { fetchWithTimeout } from '../http.js';

/**
 * Telegraph engine client — the CONSUMER side of the protocol.
 *
 * Legwork registers as a miner; Redflag turns around and BUYS answers from
 * other miners through the same node's engine (`POST /engine/v1/ask`). The
 * call is gated by x402: the first request returns a 402 challenge, we sign a
 * USDC transfer (EIP-3009, gasless) and retry with the payment header.
 *
 * Cost discipline, in order:
 *  1. PROBE — fire the request unpaid. The 402 challenge names the price
 *     (atomic 6-dec USDC) without settling anything; x402 only charges on a
 *     2xx. A check whose price exceeds its remaining budget is skipped here,
 *     before a single cent moves.
 *  2. SPEND CONTROLS — the x402 client is built per call with
 *     maxAmountPerPayment pinned to the same ceiling, so even a price that
 *     changed between probe and pay cannot exceed the budget.
 *  3. CACHE — identical queries within the TTL reuse the stored signal; the
 *     demo economics do not pay twice for the same company's news.
 */

/** Engine call budget. Probes are free; paid calls include miner latency. */
const PROBE_TIMEOUT_MS = 12_000;
const PAID_TIMEOUT_MS = 30_000;
/**
 * The devnode sits behind Cloudflare, which intermittently DROPS (never
 * resets) unfamiliar TLS fingerprints — a connect timeout, not an outage.
 * One quick retry absorbs it; the payer never loses money on a dropped
 * request because x402 settles only on a 2xx.
 */
const TRANSPORT_RETRIES = 2;
const TRANSPORT_RETRY_DELAY_MS = 1_500;

function isTransportFailure(error: unknown): boolean {
  const cause = (error as { cause?: { code?: string } })?.cause?.code ?? '';
  const message = error instanceof Error ? error.message : String(error);
  return /fetch failed|ENOTFOUND|ECONNRE|UND_ERR|timeout after/i.test(message) || cause.startsWith('UND_ERR') || cause.includes('ECONNRE');
}

async function fetchRetry(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= TRANSPORT_RETRIES; attempt += 1) {
    try {
      return await fetchWithTimeout(url, init, timeoutMs);
    } catch (err) {
      lastError = err;
      if (!isTransportFailure(err) || attempt === TRANSPORT_RETRIES) throw err;
      await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS));
    }
  }
  throw lastError;
}

export interface EngineAskOptions {
  query: string;
  /** Structured hints merged into the routed request body. */
  context?: Record<string, unknown>;
  /**
   * Expected canonical intent. When the auto-routed ask fails (e.g. the
   * node's LLM router is down), the call falls back to a DIRECT ask against
   * a discovered miner for this intent — no router in the path.
   */
  intent?: string;
  /**
   * Keywords ranking DIRECT-fallback miner choice: miners whose slug/name
   * match more keywords are tried first. Without this, "first active miner
   * for the intent" can pick a semantically distant one (a crypto price
   * lookup for a URL scan) and burn budget on an out-of-coverage answer.
   */
  preferMiner?: string[];
  /** Refuse to pay more than this for the answer. */
  maxCostUsd?: number;
  timeoutMs?: number;
  /** Skip the cache (and do not populate it). */
  noCache?: boolean;
}

export interface EngineAskResult {
  ok: boolean;
  /** Miner that served the call — surfaced in every Redflag flag's provenance. */
  minerId?: string;
  minerName?: string;
  intent?: string;
  result?: unknown;
  costUsd?: number;
  signalHash?: string;
  durationMs?: number;
  warnings?: string[];
  /** true when the check was declined before payment (budget/deps), not failed. */
  skipped?: boolean;
  cached?: boolean;
  error?: string;
}

/** One entry of the 402 challenge's accepts[] array. */
interface PaymentRequirement {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
}

interface PaymentChallenge {
  x402Version?: number;
  error?: string;
  accepts?: PaymentRequirement[];
}

/** Minimal miner summary from the free discovery endpoint. */
export interface MinerSummary {
  id: string;
  slug: string;
  name: string;
  supported_intents?: string[];
  min_price_usdc?: number;
  activation_status?: string;
  endpoints?: Array<{ path: string; method: string }>;
  input_schema?: { properties?: Record<string, { type?: string; maxLength?: number; pattern?: string }> };
}

export function telegraphReady(): boolean {
  return config.telegraph.enabled;
}

export function telegraphNodeUrl(): string {
  return config.telegraph.nodeUrl.replace(/\/$/, '');
}

/** Free discovery: live miners, optionally filtered server-side by intent. */
export async function listMiners(intent?: string): Promise<MinerSummary[] | null> {
  const url = `${telegraphNodeUrl()}/api/miners${intent ? `?intent=${encodeURIComponent(intent)}` : ''}`;
  try {
    const res = await fetchRetry(url, { method: 'GET', headers: { accept: 'application/json' } }, PROBE_TIMEOUT_MS);
    if (!res.ok) return null;
    const data = (await res.json()) as MinerSummary[];
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

/** Discovery results go stale as miners register/deregister — 60s is enough. */
const discoveryCache = new Map<string, { at: number; miners: MinerSummary[] }>();
const DISCOVERY_TTL_MS = 60_000;

async function minersForIntent(intent: string): Promise<MinerSummary[]> {
  const hit = discoveryCache.get(intent);
  if (hit && Date.now() - hit.at < DISCOVERY_TTL_MS) return hit.miners;
  const miners = (await listMiners(intent)) ?? [];
  const active = miners.filter((m) => (m.activation_status ?? 'active') === 'active');
  discoveryCache.set(intent, { at: Date.now(), miners: active });
  return active;
}

// ── x402 plumbing ───────────────────────────────────────────────────────────

/** The ethers signer shape @x402/evm's ExactEvmScheme signs through. */
function evmSigner(): { address: `0x${string}`; signTypedData: (message: Record<string, unknown>) => Promise<`0x${string}`> } | null {
  if (!config.telegraph.privateKey) return null;
  try {
    const wallet = new Wallet(config.telegraph.privateKey);
    return {
      address: wallet.address as `0x${string}`,
      signTypedData: async (message) =>
        (await wallet.signTypedData(
          message.domain as never,
          message.types as never,
          message.message as never,
        )) as `0x${string}`,
    };
  } catch {
    return null;
  }
}

function paidFetch(maxUsd: number): ((input: string, init?: RequestInit) => Promise<Response>) | null {
  const signer = evmSigner();
  if (!signer) return null;
  const client = new x402Client()
    .register(`eip155:${config.telegraph.chainId}`, new ExactEvmScheme(signer as never))
    // Belt-and-braces: the probe already gates on price, but a demand
    // multiplier tick between probe and pay must never exceed the budget.
    // NOTE: this is a DOLLAR amount (parsed by the client as money), not an
    // atomic token amount.
    .setSpendControls({ maxAmountPerPayment: maxUsd });
  const wrapped = wrapFetchWithPayment(fetch as never, client as never) as unknown as (
    input: string,
    init?: RequestInit,
  ) => Promise<Response>;
  return (input, init) => wrapped(input, init);
}

/** Base64 → JSON of the PAYMENT-REQUIRED header, tolerating base64url padding. */
function decodeChallenge(header: string | null): PaymentChallenge | null {
  if (!header) return null;
  try {
    const json = Buffer.from(header, 'base64').toString('utf8');
    const parsed = JSON.parse(json) as PaymentChallenge;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The EVM accept entry (the only network our wallet can sign for). */
function evmAccept(challenge: PaymentChallenge): PaymentRequirement | undefined {
  const prefix = `eip155:${config.telegraph.chainId}`;
  return (
    challenge.accepts?.find((a) => a.network === prefix && a.scheme === 'exact') ??
    challenge.accepts?.find((a) => a.network?.startsWith('eip155:'))
  );
}

// ── response parsing ────────────────────────────────────────────────────────

interface EngineResponse {
  miner_id?: string | number;
  miner_name?: string;
  intent?: string;
  result?: unknown;
  cost_usd?: number;
  duration_ms?: number;
  signal_hash?: string;
  warnings?: string[];
}

function parseEngineResponse(data: EngineResponse): EngineAskResult {
  return {
    ok: true,
    minerId: data.miner_id != null ? String(data.miner_id) : undefined,
    minerName: data.miner_name,
    intent: data.intent,
    result: data.result,
    costUsd: typeof data.cost_usd === 'number' ? data.cost_usd : undefined,
    signalHash: data.signal_hash,
    durationMs: data.duration_ms,
    warnings: data.warnings,
  };
}

// ── cache ───────────────────────────────────────────────────────────────────

const cache = new Map<string, { at: number; value: EngineAskResult }>();

function cacheKey(opts: EngineAskOptions): string {
  return createHash('sha256').update(JSON.stringify({ q: opts.query, c: opts.context ?? {}, i: opts.intent ?? '' })).digest('hex');
}

// ── the ask ─────────────────────────────────────────────────────────────────

/**
 * The full payment pipeline for one engine URL: unpaid probe (402 names the
 * price), budget gate, x402 payment, response parse. Never charges for a
 * non-2xx.
 */
async function askPaid(
  url: string,
  body: unknown,
  maxCostUsd: number | undefined,
  timeoutMs: number | undefined,
): Promise<EngineAskResult> {
  const init: RequestInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };

  // 1. Unpaid probe: learn the price. A 402 costs nothing.
  let probe: Response;
  try {
    probe = await fetchRetry(url, init, timeoutMs ?? PROBE_TIMEOUT_MS);
  } catch (err) {
    return { ok: false, error: `engine unreachable: ${err instanceof Error ? err.message : String(err)}` };
  }

  if (probe.status !== 402) {
    // Not payment-gated: either a direct answer (fine) or an error the node
    // reports before billing.
    try {
      const data = (await probe.json()) as EngineResponse & { error?: string };
      if (probe.ok) return parseEngineResponse(data);
      return { ok: false, error: data.error ?? `engine returned ${probe.status}` };
    } catch {
      return { ok: false, error: `engine returned ${probe.status}` };
    }
  }

  // 2. Decode the challenge and price-gate before paying.
  const challenge = decodeChallenge(probe.headers.get('payment-required') ?? probe.headers.get('paying-required'));
  const accept = challenge ? evmAccept(challenge) : undefined;
  if (!accept?.amount) {
    return { ok: false, error: 'no payable EVM option in the payment challenge' };
  }
  const priceUsd = Number(accept.amount) / 1e6;
  if (maxCostUsd !== undefined && priceUsd > maxCostUsd + 1e-9) {
    return {
      ok: false,
      skipped: true,
      error: `priced at $${priceUsd.toFixed(2)} — over the $${maxCostUsd.toFixed(2)} remaining budget`,
    };
  }

  // 3. Pay and retry. Spend controls pin the ceiling to the probed price.
  const payer = paidFetch(priceUsd);
  if (!payer) return { ok: false, skipped: true, error: 'Telegraph wallet not configured' };
  let paid: Response | undefined;
  try {
    for (let attempt = 0; attempt <= TRANSPORT_RETRIES && !paid; attempt += 1) {
      try {
        paid = await payer(url, init);
      } catch (err) {
        // A dropped request was never settled — safe to re-attempt. The
        // wrapper signs a fresh authorization per attempt.
        if (!isTransportFailure(err) || attempt === TRANSPORT_RETRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, TRANSPORT_RETRY_DELAY_MS));
      }
    }
  } catch (err) {
    return { ok: false, error: `payment failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!paid) return { ok: false, error: 'payment did not complete' };

  try {
    const data = (await paid.json()) as EngineResponse & { error?: string };
    if (paid.ok) return parseEngineResponse(data);
    // A 402 AFTER payment usually means the proof was rejected or re-challenged
    // — surface the node's own words, not just the status.
    return { ok: false, error: data.error ?? `engine returned ${paid.status} after payment` };
  } catch {
    const text = await paid.text().catch(() => '');
    return { ok: false, error: `engine returned ${paid.status} after payment${text ? `: ${text.slice(0, 200)}` : ''}` };
  }
}

/** Field names miners typically read free-text queries from. */
const TEXT_FIELD_ALIASES = ['query', 'q', 'question', 'text', 'prompt', 'input', 'message', 'content', 'url', 'search', 'statement', 'claim', 'target', 'domain'];

/**
 * Build a direct-ask payload from a miner's declared input schema: put the
 * query text into the field the miner actually reads. Returns null when no
 * plausible text field exists (this miner serves structured calls only).
 */
export function buildDirectPayload(miner: MinerSummary, text: string): Record<string, unknown> | null {
  const props = miner.input_schema?.properties ?? {};
  const cap = (value: string, maxLength?: number): string => (maxLength ? value.slice(0, maxLength) : value);
  const payload: Record<string, unknown> = {};
  // A miner that offers "include an answer" wants to be asked for it.
  if (props.include_answer?.type === 'boolean') payload.include_answer = true;
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === 'string' && TEXT_FIELD_ALIASES.includes(name)) {
      payload[name] = cap(text, def.maxLength);
      return payload;
    }
  }
  for (const [name, def] of Object.entries(props)) {
    if (def?.type === 'string' && !def.pattern) {
      payload[name] = cap(text, def.maxLength);
      return payload;
    }
  }
  return null;
}

/** How many discovered miners a direct fallback will try before giving up. */
const DIRECT_MINER_ATTEMPTS = 2;

/** Rank discovered miners: keyword hits in slug/name first, price second. */
function rankMiners(miners: MinerSummary[], keywords: string[]): MinerSummary[] {
  if (!keywords.length) return miners;
  const score = (miner: MinerSummary): number => {
    const hay = `${miner.slug} ${miner.name}`.toLowerCase();
    return keywords.reduce((hits, kw) => hits + (kw && hay.includes(kw.toLowerCase()) ? 1 : 0), 0);
  };
  return [...miners].sort((a, b) => {
    const byKeywords = score(b) - score(a);
    if (byKeywords !== 0) return byKeywords;
    return (a.min_price_usdc ?? 0) - (b.min_price_usdc ?? 0);
  });
}

/**
 * Buy an answer from the engine. Auto-routed first (the node's LLM router
 * picks a miner); if that fails and an intent was given, fall back to direct
 * asks against discovered miners for that intent — immune to router outages.
 */
export async function engineAsk(opts: EngineAskOptions): Promise<EngineAskResult> {
  if (!opts.noCache) {
    const hit = cache.get(cacheKey(opts));
    if (hit && Date.now() - hit.at < config.telegraph.cacheTtlSec * 1000) {
      return { ...hit.value, cached: true };
    }
  }

  if (!telegraphReady()) {
    return { ok: false, skipped: true, error: 'Telegraph wallet not configured (TELEGRAPH_PRIVATE_KEY)' };
  }

  const remember = (result: EngineAskResult): EngineAskResult => {
    if (!opts.noCache && result.ok) cache.set(cacheKey(opts), { at: Date.now(), value: result });
    return result;
  };

  // Auto-routed ask.
  const routed = await askPaid(
    `${telegraphNodeUrl()}/engine/v1/ask`,
    { query: opts.query, ...(opts.context ? { context: opts.context } : {}) },
    opts.maxCostUsd,
    opts.timeoutMs,
  );
  if (routed.ok) return remember(routed);

  // Direct fallback: name the miner, skip the (possibly broken) router.
  if (!opts.intent) return routed;
  const miners = await minersForIntent(opts.intent);
  const ranked = rankMiners(miners, opts.preferMiner ?? []);
  let lastError = routed.error ?? 'auto-routed ask failed';
  let attempted = 0;
  for (const miner of ranked) {
    if (attempted >= DIRECT_MINER_ATTEMPTS) break;
    const endpoint = miner.endpoints?.find((e) => e.method.toUpperCase() === 'POST') ?? miner.endpoints?.[0];
    if (!endpoint) continue;
    const payload = buildDirectPayload(miner, opts.query);
    if (!payload) continue;
    attempted += 1;
    const direct = await askPaid(
      `${telegraphNodeUrl()}/engine/v1/ask/${encodeURIComponent(miner.id)}`,
      { method: endpoint.method.toUpperCase(), endpoint: endpoint.path, payload },
      opts.maxCostUsd,
      opts.timeoutMs,
    );
    if (direct.ok) return remember({ ...direct, intent: direct.intent ?? opts.intent });
    lastError = `${direct.error ?? 'direct ask failed'} (miner ${miner.slug})`;
    // Only the price-gate skip is final — a budget decision is not retried
    // against other miners, since they are compared to the same ceiling.
    if (direct.skipped) return direct;
  }
  return { ok: false, error: `routing failed: ${lastError}` };
}

/** Liveness of the Telegraph consumer side, for /health. */
export function telegraphHealth(): { configured: boolean; nodeUrl: string; cacheEntries: number } {
  return { configured: telegraphReady(), nodeUrl: telegraphNodeUrl(), cacheEntries: cache.size };
}
