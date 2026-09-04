import { config, activeLlmModel, llmProvider } from './config.js';
import { createBot } from './telegram/bot.js';
import { startServer } from './server.js';
import { walletConfigured } from './wallet/baseWallet.js';
import { startWatchPoller } from './track3/watchPoller.js';

/**
 * Legwork — a job-search agent with per-call Base Sepolia payments and a
 * Telegraph miner surface.
 *
 * Process layout:
 *  1. Service API — /api/* per-call endpoints + /miner/* Telegraph routes
 *  2. Telegram bot — the user surface (onboarding, cards, approvals)
 *
 * Deployed publicly, the same API also serves as a Telegraph miner: the
 * miner.yaml at GET /miner.yaml is what gets registered on-chain.
 */
async function main(): Promise<void> {
  console.log('Legwork starting...');
  console.log(`  sources: adzuna=${config.adzuna.enabled} usajobs=${config.usajobs.enabled} (mock fallback when both off)`);
  // `config.llm.enabled` only covers the Anthropic slot, so the banner read
  // "llm=false" while Gemini was answering every call — the one line an
  // operator checks to see whether the model is live, saying the opposite of
  // the truth.
  console.log(`  llm=${llmProvider()} (${activeLlmModel()}) gmail=${config.gmail.enabled}`);

  // Per-call payments are optional (the bot surfaces it when unconfigured) but
  // a half-configured payment setup must never be silent: callers would sign
  // transfers that can never verify.
  console.log(`  chain=Base Sepolia (${config.payments.chainId}) walletVault=${walletConfigured()}`);
  console.log(`  telegraph consumer: node=${config.telegraph.nodeUrl} wallet=${config.telegraph.enabled ? 'configured' : 'NOT SET (Redflag runs degraded)'} budget=$${config.telegraph.maxSpendUsd}`);
  console.log(`  miner surface: /miner/job-hunt, /miner/tailor, /miner.yaml${config.server.publicUrl ? ` (public: ${config.server.publicUrl})` : ' (PUBLIC_URL not set!)'}`);

  const bot = config.telegram.token ? createBot() : null;

  startServer();

  if (bot) {
    console.log('[telegram] starting long polling...');
    // The bot must NEVER take down the service API. A 409 polling conflict
    // (two instances sharing a token) or a network blip would otherwise kill
    // the paid API and the Telegraph miner surface with it.
    bot.start().catch((err) => {
      console.error('[telegram] polling stopped; service API stays up:', err);
    });
  } else {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set; bot disabled (service API still running).');
  }

  // Standing watches: the background Redflag automation. Started after the
  // server and the bot so a failure here can never block either.
  startWatchPoller(bot);
}

// Keep the service alive through background faults: a rejected promise in a
// scan or a Telegram call must not kill the paid API or the miner surface.
process.on('unhandledRejection', (err) => console.error('[unhandledRejection]', err));
process.on('uncaughtException', (err) => console.error('[uncaughtException]', err));

main().catch((err) => {
  console.error('fatal during startup:', err);
  process.exit(1);
});
