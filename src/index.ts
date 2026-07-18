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
    await bot.start();
  } else {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — bot disabled (OKX endpoint + scheduler still running).');
    console.log('           Run `npm run demo` for the keyless end-to-end demo.');
  }
}

main().catch((err) => {
  console.error('fatal:', err);
  process.exit(1);
});
