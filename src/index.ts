import { config } from './config.js';
import { createBot } from './telegram/bot.js';
import { startOkxServer } from './okx/server.js';
import { startScheduler } from './scheduler.js';

/**
 * Legwork — an ASP for the OKX AI marketplace.
 *
 * Process layout:
 *  1. OKX A2A endpoint  — inbound task lifecycle + buyer chat (the marketplace side)
 *  2. Telegram bot      — the only user surface (onboarding, cards, approvals)
 *  3. Scheduler         — scans, digests, delivery
 */
async function main(): Promise<void> {
  console.log('Legwork starting…');
  console.log(`  sources: adzuna=${config.adzuna.enabled} usajobs=${config.usajobs.enabled} (mock fallback when both off)`);
  console.log(`  llm=${config.llm.enabled} gmail=${config.gmail.enabled}`);

  const bot = config.telegram.token ? createBot() : null;

  startOkxServer({
    onSettled: async (engagement) => {
      if (bot && engagement.userId) {
        await bot.api
          .sendMessage(Number(engagement.userId), `💰 The buyer accepted delivery on OKX — engagement ${engagement.okxJobId} is settled.`)
          .catch(() => {});
      }
    },
  });

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
