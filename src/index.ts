import { config } from './config.js';
import { createBot } from './telegram/bot.js';
import { startOkxServer } from './okx/server.js';
import { settlementStatus } from './okx/x402.js';
import { pollOnce, startMarketplacePoller } from './okx/poller.js';
import { startScheduler } from './scheduler.js';
import { walletCliAvailable } from './wallet/okxWallet.js';

/**
 * Legwork — an ASP for the OKX AI marketplace.
 *
 * Process layout:
 *  1. Marketplace poller — PULLS tasks addressed to this agent and claims them
 *  2. OKX A2A endpoint   — inbound task lifecycle + buyer chat (the push side)
 *  3. Telegram bot       — the only user surface (onboarding, cards, approvals)
 *  4. Scheduler          — scans, digests, delivery
 *
 * (1) and (2) are two views of the same state. A push is an optimisation; the
 * poll is what guarantees a task addressed to this agent gets claimed before
 * the marketplace expires it, whether or not an envelope ever arrives.
 */
async function main(): Promise<void> {
  console.log('Legwork starting…');
  console.log(`  sources: adzuna=${config.adzuna.enabled} usajobs=${config.usajobs.enabled} (mock fallback when both off)`);
  console.log(`  llm=${config.llm.enabled} gmail=${config.gmail.enabled}`);

  // x402 per-call payments are optional — the marketplace escrow flow is the
  // primary route — but a half-configured facilitator must never be silent:
  // buyers would sign authorizations that can never settle.
  const settlement = settlementStatus();
  console.log(
    settlement.available
      ? `  x402: per-call payments ENABLED${settlement.reason ? ` — ${settlement.reason}` : ''}`
      : `  x402: per-call payments DISABLED — ${settlement.reason}. Free preview and OKX escrow tasks are unaffected.`,
  );

  // Surface wallet availability at boot: without the CLI, sign-in reports
  // itself unavailable in-chat, and that should not be the first time anyone
  // finds out. Probed in the background — never block startup on it.
  void walletCliAvailable().then((ok) =>
    console.log(
      ok
        ? '  wallet: onchainos CLI found — OKX sign-in enabled'
        : '  wallet: onchainos CLI NOT found — OKX sign-in disabled (the Docker build installs it; check that step succeeded). Everything else works.',
    ),
  );

  const bot = config.telegram.token ? createBot() : null;

  startOkxServer({
    onSettled: async (engagement) => {
      if (bot && engagement.userId) {
        await bot.api
          .sendMessage(Number(engagement.userId), `💰 The buyer accepted delivery on OKX — engagement ${engagement.okxJobId} is settled.`)
          .catch(() => {});
      }
    },
    // A pushed system event means the task list moved. Reconcile immediately
    // instead of waiting out the poll interval — whatever the event was, the
    // task list is the authority on what to do about it.
    onSystemEvent: (event, jobId) => {
      console.log(`[okx] system event ${event}${jobId ? ` job=${jobId}` : ''} — reconciling task list`);
      void pollOnce({ bot });
    },
  });

  // A marketplace-side failure must never take down the endpoint or the bot.
  void startMarketplacePoller({ bot }).catch((err) => console.error('[okx-poller] failed to start:', err));

  startScheduler(bot);

  if (bot) {
    console.log('[telegram] starting long polling…');
    // The bot must NEVER take down the OKX endpoint. A 409 polling conflict
    // (two instances sharing a token) or a network blip would otherwise kill
    // the paid x402 API and the marketplace endpoint with it.
    bot.start().catch((err) => {
      console.error('[telegram] polling stopped — OKX endpoint stays up:', err);
    });
  } else {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled (OKX endpoint + scheduler still running).');
    console.log('           Run `npm run demo` for the keyless end-to-end demo.');
  }
}

// Keep the service alive through background faults: a rejected promise in a
// cron scan or a Telegram call must not kill the paid API.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

main().catch((err) => {
  console.error('fatal during startup:', err);
  process.exit(1);
});
