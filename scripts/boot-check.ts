/**
 * Boot + bot-construction check (not part of npm test — dev tooling).
 * Verifies the full process starts: server, watch poller banner, bot handlers
 * register, and the new routes answer — with everything external disabled.
 */
process.env.DATABASE_PATH = ':memory:';
// Dummy token: grammy's constructor requires non-empty, but the bot is never
// started — construction only registers handlers, no network.
process.env.TELEGRAM_BOT_TOKEN = '123456:TEST-boot-check';
process.env.ANTHROPIC_API_KEY = '';
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.GEMINI_API_KEY = '';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.TELEGRAPH_PRIVATE_KEY = '';
process.env.PORT = '0';

const { config } = await import('../src/config.js');
const { startServer } = await import('../src/server.js');
const { startWatchPoller } = await import('../src/track3/watchPoller.js');

// 1. Bot handlers register without a network (grammy constructor is offline).
const { createBot } = await import('../src/telegram/bot.js');
const bot = createBot();
console.log('bot constructed: OK (handlers registered at construction)');

// 2. Server + watch poller boot.
const server = startServer(0);
await new Promise<void>((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const timer = startWatchPoller(null); // no bot → alert delivery disabled path
console.log('watch poller:', timer ? 'started' : 'disabled (no telegraph key — expected here)');

// 3. Every new route answers on a live boot.
const page = await fetch(`${base}/redflag`);
console.log('GET /redflag:', page.status);
const preview = await fetch(`${base}/api/redflag/preview`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ text: 'Engineer at BootCo, remote, $100k. https://bootco.example/jobs' }),
});
console.log('POST /api/redflag/preview:', preview.status);
const paid = await fetch(`${base}/api/redflag`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
console.log('POST /api/redflag (unpaid):', paid.status, '(402 expected)');
const health = await fetch(`${base}/health`);
const healthData = (await health.json()) as { telegraph?: { configured: boolean } };
console.log('GET /health:', health.status, 'telegraph.configured =', healthData.telegraph?.configured);

timer?.unref?.();
await new Promise<void>((resolve) => server.close(() => resolve()));
console.log('BOOT CHECK PASSED');
process.exit(0);
