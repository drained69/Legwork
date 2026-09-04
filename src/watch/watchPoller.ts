import { createHash } from 'node:crypto';
import type { Bot } from 'grammy';
import { config } from '../config.js';
import { appendReportUpdate, audit, listActiveWatches, now, updateWatchAlert, updateWatchCheck } from '../db.js';
import { engineAsk as realEngineAsk, type EngineAskResult } from '../telegraph/client.js';
import { companyNewsQuery, distillResult, isAlarmingText, NEWS_MINER_KEYWORDS } from '../skills/redflag.js';

/**
 * Standing watches — Redflag's automation layer.
 *
 * A subscriber names a company ("watch Stripe"); every REDFLAG_WATCH_INTERVAL
 * hours the poller buys ONE news check for it through the Telegraph engine
 * and, when genuinely new negative coverage appears (fingerprint differs from
 * the last alerted signal), delivers a Telegram alert.
 *
 * Cost discipline mirrors the report pipeline: each check is price-probed
 * against its per-check budget, and the whole tick is capped by
 * REDFLAG_WATCH_TICK_BUDGET_USD so a hundred subscribers cannot drain the
 * wallet in one sweep. A failed or unreachable check is retried next tick —
 * it never alerts and never costs more than one probe.
 */

type EngineAsk = (opts: { query: string; intent?: string; preferMiner?: string[]; maxCostUsd?: number }) => Promise<EngineAskResult>;
type AlertSender = (chatId: number, text: string) => Promise<void>;

export interface WatchTickResult {
  due: number;
  checked: number;
  alerted: number;
  skipped: number;
  spentUsd: number;
  errors: string[];
}

/** Is this watch due for its check? (null lastCheckAt → due immediately) */
export function isWatchDue(lastCheckAt: string | null, intervalHours: number, nowMs: number = Date.now()): boolean {
  if (!lastCheckAt) return true;
  return nowMs - Date.parse(lastCheckAt) >= intervalHours * 60 * 60 * 1000;
}

/** Stable fingerprint of one check's evidence — changes when coverage changes. */
export function signalFingerprint(text: string): string {
  return createHash('sha256').update(text.trim().toLowerCase().slice(0, 2000)).digest('hex').slice(0, 32);
}

/** The alert a subscriber receives when new negative coverage appears. */
export function renderWatchAlert(company: string, headline: string, miner: string, costUsd: number): string {
  return (
    `🟡 <b>Watch: ${company}</b>\n` +
    `New negative coverage since the last check:\n\n` +
    `${headline.slice(0, 500)}\n\n` +
    `<i>source: ${miner}${costUsd ? ` · $${costUsd.toFixed(2)}` : ''}</i>\n\n` +
    `Run <b>/redflag</b> with the posting for a full vetting, or tap below.`
  );
}

/**
 * One poller tick: check every due watch, alert on new alarming coverage.
 * All dependencies injectable for tests.
 */
export async function runWatchTick(deps?: {
  ask?: EngineAsk;
  send?: AlertSender;
  nowMs?: number;
  intervalHours?: number;
  checkBudgetUsd?: number;
  tickBudgetUsd?: number;
}): Promise<WatchTickResult> {
  const ask = deps?.ask ?? realEngineAsk;
  const send = deps?.send ?? (async () => {});
  const intervalHours = deps?.intervalHours ?? config.telegraph.watchIntervalHours;
  const checkBudgetUsd = deps?.checkBudgetUsd ?? config.telegraph.watchCheckBudgetUsd;
  const tickBudgetUsd = deps?.tickBudgetUsd ?? config.telegraph.watchTickBudgetUsd;
  const nowMs = deps?.nowMs ?? Date.now();

  const watches = listActiveWatches().filter((w) => isWatchDue(w.lastCheckAt, intervalHours, nowMs));
  const result: WatchTickResult = { due: watches.length, checked: 0, alerted: 0, skipped: 0, spentUsd: 0, errors: [] };
  let spent = 0;

  for (const watch of watches) {
    const remainingTick = Math.round((tickBudgetUsd - spent) * 1e6) / 1e6;
    if (remainingTick <= 0) {
      result.skipped += 1;
      continue;
    }
    const perCheck = Math.min(checkBudgetUsd, remainingTick);
    let res: EngineAskResult;
    try {
      res = await ask({ query: companyNewsQuery(watch.company), intent: 'NEWS_SEARCH', preferMiner: NEWS_MINER_KEYWORDS, maxCostUsd: perCheck });
    } catch (err) {
      result.errors.push(`${watch.company}: ${err instanceof Error ? err.message : String(err)}`);
      updateWatchCheck(watch.id); // a crashed check still counts as attempted
      continue;
    }
    updateWatchCheck(watch.id);
    if (!res.ok) {
      // Skipped (budget) or failed (unreachable) — retry next tick either way.
      if (res.skipped) result.skipped += 1;
      else result.errors.push(`${watch.company}: ${res.error ?? 'check failed'}`);
      continue;
    }
    result.checked += 1;
    spent = Math.round((spent + (res.costUsd ?? 0.01)) * 1e6) / 1e6;
    result.spentUsd = spent;

    const distilled = distillResult(res.result);
    if (!isAlarmingText(`${distilled.label ?? ''} ${distilled.text}`)) continue;

    const fingerprint = signalFingerprint(distilled.text);
    if (fingerprint === watch.lastAlertSignal) continue; // same story, already alerted

    updateWatchAlert(watch.id, fingerprint);
    if (watch.chatId) {
      try {
        await send(watch.chatId, renderWatchAlert(watch.company, distilled.text, res.minerName ?? 'telegraph miner', res.costUsd ?? 0.01));
        result.alerted += 1;
      } catch (err) {
        result.errors.push(`${watch.company}: alert delivery failed (${err instanceof Error ? err.message : String(err)})`);
      }
    } else if (watch.reportId) {
      // WEB WATCH: the shareable report page is the inbox. A web watch has no
      // Telegram chat, so the finding is appended to the report itself and
      // appears when the reader returns. A missing report (deleted row) must
      // not break the tick — the watch simply has nowhere left to deliver.
      const delivered = appendReportUpdate(watch.reportId, {
        company: watch.company,
        text: distilled.text,
        miner: res.minerName ?? 'telegraph miner',
        costUsd: res.costUsd ?? 0.01,
        at: now(),
      });
      if (delivered) result.alerted += 1;
      else result.errors.push(`${watch.company}: report for web watch no longer exists`);
    }
  }

  if (result.due) {
    audit('watch', 'TICK', `due=${result.due} checked=${result.checked} alerted=${result.alerted} skipped=${result.skipped} spent=$${result.spentUsd.toFixed(2)}`);
  }
  return result;
}

/**
 * Start the background poller. The interval handle must NEVER keep a failed
 * tick from running again, and a throw inside a tick must never kill the
 * process — same containment rule as the Telegram poller.
 */
export function startWatchPoller(bot: Bot | null): NodeJS.Timeout | null {
  if (!config.telegraph.enabled) {
    console.log('[watch] TELEGRAPH_PRIVATE_KEY not set — standing watches disabled');
    return null;
  }
  if (!bot) {
    console.log('[watch] no Telegram bot — watches run but cannot deliver alerts');
  }
  const everyMs = Math.max(1, config.telegraph.watchPollMinutes) * 60 * 1000;
  const timer = setInterval(() => {
    runWatchTick({
      send: bot
        ? async (chatId, text) => {
            await bot.api.sendMessage(chatId, text, { parse_mode: 'HTML', link_preview_options: { is_disabled: true } });
          }
        : undefined,
    }).catch((err) => console.error('[watch] tick failed (will retry next interval):', err));
  }, everyMs);
  timer.unref?.();
  console.log(`[watch] poller started — every ${config.telegraph.watchPollMinutes} min, checks every ${config.telegraph.watchIntervalHours} h per company`);
  return timer;
}
