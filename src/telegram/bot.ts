import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import {
  createWatch, deactivateWatch, getOnboarding, getPosting, getProfile, getWallet, getWatch, listRedflagReports, listUsage, listWatches, now,
  savePosting, saveProfile, saveRedflagReport, setOnboarding, clearOnboarding, uid,
} from '../db.js';
import { huntViaApi, previewViaApi, redflagPreviewViaApi, redflagViaApi, scoreViaApi, tailorViaApi, type HuntApiResult, type RedflagApiResult } from './apiClient.js';
import { createUserWallet, disconnectUserWallet, importUserWallet, walletBalances } from '../wallet/baseWallet.js';
import type { Profile } from '../types.js';
import { PROFILE_FIELDS, PROFILE_SECTIONS, RULE, capText, esc, fieldValue, meter, profileCompleteness, renderMatchCard, renderProfile, renderRedflagCard, scoreVerdict, shortAddress, title, type ProfileField } from './ui.js';
import { send } from './send.js';
import type { MatchCard } from '../pipeline.js';

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };
const SETUP = ['roles', 'seniority', 'locations', 'compFloor', 'skills', 'factors'] as const;
type SetupStep = (typeof SETUP)[number];
const PROMPTS: Record<SetupStep, string> = {
  roles: 'Target roles? Separate with commas.', seniority: 'Level? junior, mid, senior, staff or principal.',
  locations: 'Preferred locations? Include remote if applicable.', compFloor: 'Minimum annual salary, numbers only?',
  skills: 'Core skills? Separate with commas.', factors: 'Priorities to score for? Reply none if there are no special priorities.',
};

function id(ctx: { from?: { id: number } }): string { return String(ctx.from?.id); }
function home(): InlineKeyboard { return new InlineKeyboard().text('Menu', 'menu'); }
function menu(profile?: Profile): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  if (!profile) return keyboard.text('Set up profile', 'setup');
  return keyboard.text('Run paid hunt ($0.01)', 'hunt').row().text('Free preview', 'preview').row()
    .text('Score posting ($0.01)', 'score').row().text('Tailor application ($0.01)', 'tailor').row()
    .text('Redflag posting ($0.05)', 'redflag').row().text('Watch a company', 'watch').row()
    .text(profile.wallet ? 'Wallet' : 'Create/import wallet', 'wallet').row().text('Services', 'services');
}

export function createBot(): Bot {
  const bot = new Bot(config.telegram.token);
  bot.command('start', async (ctx) => {
    const profile = getProfile(id(ctx));
    await send(ctx.reply.bind(ctx), `${title('Legwork', 'Your job search from Telegram')}\n\n` +
      'I find jobs, explain the match, and draft applications. Preview is free. Paid services use direct Base Sepolia USDC transfers.\n\n' +
      (profile ? `Wallet · ${profile.wallet ? `<code>${esc(shortAddress(profile.wallet))}</code>` : 'not connected'}` : 'Set up a profile to begin.'),
      { ...HTML, reply_markup: menu(profile) });
  });
  bot.command('menu', async (ctx) => await send(ctx.reply.bind(ctx), `${title('Menu')}\n\nChoose an action.`, { ...HTML, reply_markup: menu(getProfile(id(ctx))) }));
  bot.command('profile', async (ctx) => {
    const profile = getProfile(id(ctx));
    if (!profile) return void (await send(ctx.reply.bind(ctx), 'Set up your profile first.', { ...HTML, reply_markup: menu() }));
    await send(ctx.reply.bind(ctx), renderProfile(profile), { ...HTML, reply_markup: menu(profile) });
  });
  bot.command('wallet', async (ctx) => showWallet(ctx, id(ctx)));
  bot.command('services', async (ctx) => showServices(ctx));
  bot.command('usage', async (ctx) => showUsage(ctx, id(ctx)));
  bot.command('help', async (ctx) => await send(ctx.reply.bind(ctx), `${title('How it works')}\n\nSet up your profile, preview matches for free, then create or import a Base Sepolia wallet to pay per service. Never import a wallet with real funds.\n\n<b>Redflag</b> vets a posting before you apply: scam scan, company news, URL and fact checks bought live from Telegraph miners, plus a market comp benchmark — every flag names its source and cost.`, { ...HTML, reply_markup: home() }));

  bot.callbackQuery('setup', async (ctx) => { await ctx.answerCallbackQuery(); setOnboarding(id(ctx), 'roles', {}); await send(ctx.reply.bind(ctx), `${title('Profile setup', '1 of 6')}\n\n${PROMPTS.roles}`, HTML); });
  bot.callbackQuery('menu', async (ctx) => { await ctx.answerCallbackQuery(); await send(ctx.reply.bind(ctx), `${title('Menu')}\n\nChoose an action.`, { ...HTML, reply_markup: menu(getProfile(id(ctx))) }); });
  bot.callbackQuery('wallet', async (ctx) => { await ctx.answerCallbackQuery(); await showWallet(ctx, id(ctx)); });
  bot.callbackQuery('wallet:create', async (ctx) => {
    await ctx.answerCallbackQuery();
    try {
      const wallet = createUserWallet(id(ctx));
      attachWallet(id(ctx), wallet.address);
      await send(ctx.reply.bind(ctx), `${title('Wallet created', 'Base Sepolia')}\n\n<b>Address</b>\n<code>${esc(wallet.address)}</code>\n\n<b>Private key</b>\n<code>${esc(wallet.privateKey)}</code>\n\n<b>Save this key now.</b> It will not be shown again.`, { ...HTML, reply_markup: home() });
    } catch (error) { await send(ctx.reply.bind(ctx), `${title('Could not create wallet')}\n\n${esc(String(error))}`, { ...HTML, reply_markup: home() }); }
  });
  bot.callbackQuery('wallet:import', async (ctx) => { await ctx.answerCallbackQuery(); setOnboarding(id(ctx), 'wallet:import', {}); await send(ctx.reply.bind(ctx), `${title('Import wallet')}\n\nSend a Base Sepolia private key. It will be encrypted immediately. Use a dedicated testnet wallet only.`, { ...HTML, reply_markup: home() }); });
  bot.callbackQuery('wallet:disconnect', async (ctx) => { await ctx.answerCallbackQuery(); disconnectUserWallet(id(ctx)); const profile = getProfile(id(ctx)); if (profile) { profile.wallet = undefined; saveProfile(profile); } await send(ctx.reply.bind(ctx), `${title('Wallet disconnected')}\n\nThe encrypted key was removed.`, { ...HTML, reply_markup: home() }); });
  bot.callbackQuery('hunt', async (ctx) => { await ctx.answerCallbackQuery(); await runHunt(ctx, id(ctx)); });
  bot.callbackQuery('preview', async (ctx) => { await ctx.answerCallbackQuery(); const profile = getProfile(id(ctx)); if (profile) await runPreview(ctx, profile); });
  bot.callbackQuery('score', async (ctx) => { await ctx.answerCallbackQuery(); setOnboarding(id(ctx), 'service:score', {}); await send(ctx.reply.bind(ctx), `${title('Score posting', '$0.01 on Base Sepolia')}\n\nPaste the job posting. Payment happens only after it is parsed.`, HTML); });
  bot.callbackQuery('tailor', async (ctx) => { await ctx.answerCallbackQuery(); setOnboarding(id(ctx), 'service:tailor', {}); await send(ctx.reply.bind(ctx), `${title('Tailor application', '$0.01 on Base Sepolia')}\n\nPaste the job posting. Payment happens only after it is parsed.`, HTML); });
  bot.callbackQuery('redflag', async (ctx) => { await ctx.answerCallbackQuery(); setOnboarding(id(ctx), 'service:redflag', {}); await send(ctx.reply.bind(ctx), `${title('Redflag', 'Due diligence · $0.05 on Base Sepolia')}\n\nPaste the job posting or offer. I check it for scam patterns, scan company news, verify the URL and claims with live Telegraph miners, and benchmark the pay against the live market.\n\nEvery flag names its source and what it cost.`, HTML); });
  bot.command('redflag', async (ctx) => { const profile = getProfile(id(ctx)); if (!profile) return void (await send(ctx.reply.bind(ctx), 'Set up your profile first.', { ...HTML, reply_markup: menu() })); setOnboarding(id(ctx), 'service:redflag', {}); await send(ctx.reply.bind(ctx), `${title('Redflag', 'Due diligence · $0.05 on Base Sepolia')}\n\nPaste the job posting or offer to vet.`, HTML); });
  bot.command('redflagfree', async (ctx) => {
    const userId = id(ctx);
    setOnboarding(userId, 'redflag:preview', {});
    await send(ctx.reply.bind(ctx), `${title('Free scam scan', 'No payment needed')}\n\nPaste the job posting or offer. I run the local scam-pattern scan and a live comp benchmark — the four network checks (scam, news, URL, facts) run in the $0.05 report.`, HTML);
  });
  bot.command('watch', async (ctx) => {
    const userId = id(ctx);
    const company = (ctx.match ?? '').trim();
    if (!company) return void (await showWatches(ctx, userId));
    if (!config.telegraph.enabled) {
      return void (await send(ctx.reply.bind(ctx), `${title('Watches unavailable')}\n\nThe Telegraph consumer wallet is not configured on this deployment — standing watches cannot buy news checks.`, { ...HTML, reply_markup: home() }));
    }
    const existing = listWatches(userId).find((w) => w.company.toLowerCase() === company.toLowerCase());
    if (existing) {
      return void (await send(ctx.reply.bind(ctx), `${title('Already watching')}\n\nYou already have a watch on <b>${esc(company)}</b>. It re-checks the news every ${config.telegraph.watchIntervalHours} h and alerts you here when new negative coverage appears.`, { ...HTML, reply_markup: watchKeyboard(existing.id) }));
    }
    const watch = createWatch(userId, company, ctx.chat?.id ?? null);
    await send(ctx.reply.bind(ctx), `${title('Watch started', company)}\n\nI re-check ${esc(company)}'s news every ${config.telegraph.watchIntervalHours} hours through a live Telegraph news miner (~$${config.telegraph.watchCheckBudgetUsd.toFixed(2)} per check, on me) and alert you here the moment new negative coverage appears — layoffs, investigations, bankruptcy.\n\nUse <b>/redflag</b> any time for the full picture.`, { ...HTML, reply_markup: watchKeyboard(watch.id) });
  });
  bot.command('vetted', async (ctx) => {
    const reports = listRedflagReports(id(ctx), 5);
    if (!reports.length) return void (await send(ctx.reply.bind(ctx), `${title('Vetting history')}\n\nNo reports yet. Use <b>/redflag</b> to vet a posting, or <b>/redflagfree</b> for the free scan.`, { ...HTML, reply_markup: home() }));
    const lines = reports.map((r) => `${verdictIcon(r.verdict)} <b>${esc(r.company)}</b> · ${esc(r.verdict)} · miner spend $${r.spendUsd.toFixed(2)} · ${esc(r.at.slice(0, 16).replace('T', ' '))} UTC`);
    await send(ctx.reply.bind(ctx), `${title('Vetting history', 'Last 5 reports')}\n\n${lines.join('\n')}`, { ...HTML, reply_markup: home() });
  });
  bot.callbackQuery('watch', async (ctx) => { await ctx.answerCallbackQuery(); await showWatches(ctx, id(ctx)); });
  bot.callbackQuery('services', async (ctx) => { await ctx.answerCallbackQuery(); await showServices(ctx); });

  // Vet a posting straight from its match card — the hunt found it, Redflag
  // checks it before you spend time applying.
  bot.callbackQuery(/^vet:/, async (ctx) => {
    await ctx.answerCallbackQuery('Vetting…');
    const postingId = (ctx.callbackQuery.data ?? '').slice(4);
    const posting = getPosting(postingId);
    if (!posting) return void (await send(ctx.reply.bind(ctx), 'That posting is no longer stored — paste it with /redflag instead.', { ...HTML, reply_markup: home() }));
    const profile = getProfile(id(ctx));
    if (!profile) return void (await send(ctx.reply.bind(ctx), 'Set up your profile first.', { ...HTML, reply_markup: menu() }));
    await runPaidRedflag(ctx, profile, { title: posting.title, company: posting.company, description: posting.description, location: posting.location, url: posting.url });
  });

  // Full paid report on a watched company, straight from an alert.
  bot.callbackQuery(/^watchvet:/, async (ctx) => {
    await ctx.answerCallbackQuery('Vetting…');
    const watchId = (ctx.callbackQuery.data ?? '').slice(9);
    const watch = getWatch(watchId);
    const profile = getProfile(id(ctx));
    if (!watch || !profile) return void (await send(ctx.reply.bind(ctx), 'That watch is no longer active.', { ...HTML, reply_markup: home() }));
    await runPaidRedflag(ctx, profile, { company: watch.company, title: undefined, description: `Company-level vetting of ${watch.company} triggered from a standing watch.`, text: undefined });
  });
  bot.callbackQuery(/^watchstop:/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const watchId = (ctx.callbackQuery.data ?? '').slice(10);
    const watch = getWatch(watchId);
    if (watch && deactivateWatch(watchId)) {
      return void (await send(ctx.reply.bind(ctx), `${title('Watch stopped')}\n\nNo more news checks on <b>${esc(watch.company)}</b>.`, { ...HTML, reply_markup: home() }));
    }
    await send(ctx.reply.bind(ctx), 'That watch was already stopped.', { ...HTML, reply_markup: home() });
  });

  bot.on('message:text', async (ctx) => {
    const userId = id(ctx); const text = ctx.message.text.trim(); const state = getOnboarding(userId);
    if (!state) return void (await send(ctx.reply.bind(ctx), 'Choose an action from /menu.', { ...HTML, reply_markup: menu(getProfile(userId)) }));
    if (state.step === 'wallet:import') {
      clearOnboarding(userId);
      try { const address = importUserWallet(userId, text); attachWallet(userId, address); await send(ctx.reply.bind(ctx), `${title('Wallet imported', 'Base Sepolia')}\n\n<code>${esc(address)}</code>\n\nYour key is encrypted.`, { ...HTML, reply_markup: home() }); }
      catch (error) { await send(ctx.reply.bind(ctx), `${title('Import failed')}\n\n${esc(String(error))}`, { ...HTML, reply_markup: home() }); }
      return;
    }
    if (state.step === 'redflag:preview') {
      clearOnboarding(userId);
      const posting = parsePosting(text) ?? { title: '', company: '', description: '', text };
      const result = await redflagPreviewViaApi(userId, posting);
      if (!result.ok || !result.data) return void (await send(ctx.reply.bind(ctx), `${title('Scan failed')}\n\n${esc(result.error ?? 'Unknown error')}`, { ...HTML, reply_markup: home() }));
      await send(ctx.reply.bind(ctx), renderRedflagCard({ ...result.data, degraded: true }), HTML);
      await send(ctx.reply.bind(ctx), `${title('Free scan complete')}\n\nThe four network checks — scam scan, company news, URL scan, fact-check — run in the <b>full report</b> ($0.05, Base Sepolia).`, { ...HTML, reply_markup: new InlineKeyboard().text('Run full report ($0.05)', 'redflag').row().text('Menu', 'menu') });
      return;
    }
    if (state.step.startsWith('service:')) {
      clearOnboarding(userId); const profile = getProfile(userId); if (!profile) return void (await send(ctx.reply.bind(ctx), 'Set up your profile first.', HTML));
      const posting = parsePosting(text); if (!posting) return void (await send(ctx.reply.bind(ctx), 'Include a title, company, and description.', { ...HTML, reply_markup: home() }));
      if (state.step === 'service:redflag') {
        await runPaidRedflag(ctx, getProfile(userId)!, posting);
        return;
      }
      const result = state.step === 'service:score' ? await scoreViaApi(profile, posting) : await tailorViaApi(profile, posting);
      if (!result.ok) return void (await send(ctx.reply.bind(ctx), `${title('Service failed')}\n\n${esc(result.error ?? 'Unknown error')}`, { ...HTML, reply_markup: home() }));
      await send(ctx.reply.bind(ctx), `${title('Service complete')}\n\n${esc(JSON.stringify(result.data, null, 2).slice(0, 3800))}\n\n<b>Payment</b> · Base Sepolia`, { ...HTML, reply_markup: home() }); return;
    }
    const step = state.step as SetupStep; if (!SETUP.includes(step)) return;
    const partial = state.partial; const values = text.toLowerCase() === 'none' ? [] : text.split(',').map((v) => v.trim()).filter(Boolean);
    if (step === 'roles') partial.targetRoles = values; if (step === 'seniority') partial.seniority = text.toLowerCase(); if (step === 'locations') { partial.locations = values; partial.remoteOk = values.includes('remote'); }
    if (step === 'compFloor') partial.compFloor = Number(text.replace(/[^0-9]/g, '')); if (step === 'skills') partial.skills = values; if (step === 'factors') partial.factors = values;
    const next = SETUP[SETUP.indexOf(step) + 1]; if (next) { setOnboarding(userId, next, partial); return void (await send(ctx.reply.bind(ctx), `${title('Profile setup', `${SETUP.indexOf(next) + 1} of 6`)}\n\n${PROMPTS[next]}`, HTML)); }
    const previous = getProfile(userId); saveProfile({ userId, name: previous?.name ?? ctx.from.first_name ?? 'Candidate', targetRoles: (partial.targetRoles as string[]) ?? [], seniority: String(partial.seniority ?? 'mid'), locations: (partial.locations as string[]) ?? [], remoteOk: Boolean(partial.remoteOk), compFloor: Number(partial.compFloor ?? 0), skills: (partial.skills as string[]) ?? [], factors: (partial.factors as string[]) ?? [], resumeText: previous?.resumeText ?? '', dealbreakers: previous?.dealbreakers ?? [], threshold: previous?.threshold ?? 0, dailyCap: previous?.dailyCap ?? 10, wallet: previous?.wallet, updatedAt: now() }); clearOnboarding(userId); await send(ctx.reply.bind(ctx), `${title('Profile saved')}\n\nCreate a wallet when you are ready to use paid services.`, { ...HTML, reply_markup: menu(getProfile(userId)) });
  });
  bot.catch(async ({ ctx }) => { try { if (ctx.callbackQuery) await ctx.answerCallbackQuery(); await ctx.reply('That action failed. Nothing was charged. Try /menu again.'); } catch {} });
  return bot;
}

function attachWallet(userId: string, address: string): void { const profile = getProfile(userId); if (profile) { profile.wallet = address; saveProfile(profile); } }
function parsePosting(text: string): { title: string; company: string; description: string; location?: string; url?: string } | undefined { const lines = text.split('\n').map((line) => line.trim()).filter(Boolean); if (lines.length < 3) return undefined; return { title: lines[0].slice(0, 200), company: lines[1].slice(0, 200), description: lines.slice(2).join('\n').slice(0, 20_000) }; }
async function showWallet(ctx: { reply: Function }, userId: string): Promise<void> { const profile = getProfile(userId); const wallet = getWallet(userId); if (!profile || !wallet) return void (await send(ctx.reply.bind(ctx), walletPrompt(), { ...HTML, reply_markup: new InlineKeyboard().text('Create wallet', 'wallet:create').row().text('Import wallet', 'wallet:import').row().text('Menu', 'menu') })); const balances = await walletBalances(userId).catch(() => ({ eth: 'unavailable', asset: 'unavailable' })); await send(ctx.reply.bind(ctx), `${title('Base Sepolia wallet', 'Connected')}\n\n<b>Address</b>\n<code>${esc(profile.wallet ?? wallet.address)}</code>\n<b>ETH</b> · ${esc(balances.eth)}\n<b>${esc(config.payments.assetSymbol)}</b> · ${esc(balances.asset ?? 'unavailable')}`, { ...HTML, reply_markup: new InlineKeyboard().text('Disconnect', 'wallet:disconnect').row().text('Menu', 'menu') }); }
function walletPrompt(): string { return `${title('Base Sepolia wallet', 'Pay per service')}\n\nCreate or import a testnet wallet. Use a dedicated wallet only; never import real funds.`; }
async function showServices(ctx: { reply: Function }): Promise<void> { await send(ctx.reply.bind(ctx), `${title('Services & pricing')}\n\n<b>Job hunt</b> · $0.01\n<b>Score posting</b> · $0.01\n<b>Tailor application</b> · $0.01\n<b>Redflag due diligence</b> · $0.05 (buys live scam, news, URL and fact checks from Telegraph miners)\n\nPayments are direct USDC transfers on Base Sepolia.`, { ...HTML, reply_markup: home() }); }
async function showUsage(ctx: { reply: Function }, userId: string): Promise<void> { const rows = listUsage(userId, 10).map((record) => `${record.service} · $${record.priceUsd} · ${record.transactionHash ? shortAddress(record.transactionHash) : 'unpaid'}`).join('\n') || 'No service calls yet.'; await send(ctx.reply.bind(ctx), `${title('Usage')}\n\n<code>${esc(rows)}</code>`, { ...HTML, reply_markup: home() }); }
async function runHunt(ctx: { reply: Function }, userId: string): Promise<void> { const profile = getProfile(userId); if (!profile) return void (await send(ctx.reply.bind(ctx), 'Set up your profile first.', { ...HTML, reply_markup: menu() })); const result = await huntViaApi(profile); if (!result.ok) return void (await send(ctx.reply.bind(ctx), `${title('Hunt failed')}\n\n${esc(result.error ?? 'Unknown error')}`, { ...HTML, reply_markup: home() })); const data = result.data as HuntApiResult; for (const match of data.matches) { savePosting(match.posting); await send(ctx.reply.bind(ctx), renderMatchCard(match.posting, match.breakdown), { ...HTML, reply_markup: new InlineKeyboard().text(`Vet ${match.posting.company.slice(0, 24)} ($0.05)`, `vet:${match.posting.id}`).row().text('Menu', 'menu') }); } await send(ctx.reply.bind(ctx), `${title('Hunt complete')}\n\n${data.matches.length} matches found. Tap <b>Vet</b> on any card to run Redflag due diligence before you apply.\nPayment · Base Sepolia`, { ...HTML, reply_markup: home() }); }
async function runPreview(ctx: { reply: Function }, profile: Profile): Promise<void> { const result = await previewViaApi(profile); if (!result.ok) return void (await send(ctx.reply.bind(ctx), `${title('Preview failed')}\n\n${esc(result.error ?? 'Unknown error')}`, { ...HTML, reply_markup: home() })); await send(ctx.reply.bind(ctx), `${title('Free preview')}\n\n${esc(JSON.stringify(result.data?.matches ?? [], null, 2))}`, { ...HTML, reply_markup: home() }); }
export async function sendMatchCard(bot: Bot, chatId: number, card: MatchCard): Promise<void> { await send(bot.api.sendMessage.bind(bot.api, chatId), renderMatchCard(card.posting, card.breakdown), HTML); }

// ── redflag helpers ─────────────────────────────────────────────────────────

/** One paid report, shared by the paste flow, the match-card button and watch alerts. */
async function runPaidRedflag(ctx: { reply: Function }, profile: Profile, posting: { title?: string; company?: string; description?: string; text?: string; url?: string; location?: string }): Promise<void> {
  const payload = { title: posting.title ?? '', company: posting.company ?? '', description: posting.description ?? '', text: posting.text, url: posting.url, location: posting.location };
  if (!payload.company && !payload.description && !payload.text) {
    return void (await send(ctx.reply.bind(ctx), 'Include a title, company, and description.', { ...HTML, reply_markup: home() }));
  }
  const result = await redflagViaApi(profile, payload);
  if (!result.ok || !result.data) return void (await send(ctx.reply.bind(ctx), `${title('Redflag failed')}\n\n${esc(result.error ?? 'Unknown error')}\n\nNothing was charged.`, { ...HTML, reply_markup: home() }));
  await send(ctx.reply.bind(ctx), renderRedflagCard(result.data), { ...HTML, reply_markup: home() });
  await send(ctx.reply.bind(ctx), `${title('Redflag complete')}\n\n${result.data.flags.length} flag(s) · miner spend $${result.data.spendUsd.toFixed(2)}\nPayment · $0.05 · Base Sepolia`, { ...HTML, reply_markup: home() });
  // Telegram-side copy of the report, keyed by the chat user — /vetted reads it.
  saveRedflagReport({
    id: uid(),
    userId: profile.userId,
    company: result.data.company,
    verdict: result.data.verdict,
    spendUsd: result.data.spendUsd,
    at: now(),
    data: result.data,
  });
}

function watchKeyboard(watchId: string): InlineKeyboard {
  return new InlineKeyboard().text('Run full report ($0.05)', `watchvet:${watchId}`).row().text('Stop watching', `watchstop:${watchId}`).row().text('Menu', 'menu');
}

async function showWatches(ctx: { reply: Function }, userId: string): Promise<void> {
  const watches = listWatches(userId);
  if (!watches.length) {
    return void (await send(ctx.reply.bind(ctx), `${title('Standing watches')}\n\nNone yet. Use <b>/watch Company Name</b> and I re-check their news every ${config.telegraph.watchIntervalHours} hours through a live Telegraph news miner — you get an alert here the moment new negative coverage appears.`, { ...HTML, reply_markup: home() }));
  }
  const lines = watches.map((w) => `🟠 <b>${esc(w.company)}</b> · checked ${w.lastCheckAt ? esc(w.lastCheckAt.slice(0, 16).replace('T', ' ')) + ' UTC' : 'never yet — first check within ' + config.telegraph.watchPollMinutes + ' min'}`);
  const keyboard = new InlineKeyboard();
  for (const w of watches.slice(0, 5)) keyboard.text(`Stop ${w.company.slice(0, 20)}`, `watchstop:${w.id}`).row();
  keyboard.text('Menu', 'menu');
  await send(ctx.reply.bind(ctx), `${title('Standing watches', `Re-checked every ${config.telegraph.watchIntervalHours} h`)}\n\n${lines.join('\n')}`, { ...HTML, reply_markup: keyboard });
}

function verdictIcon(verdict: string): string {
  return verdict === 'avoid' ? '🔴' : verdict === 'caution' ? '🟡' : verdict === 'clear' ? '🟢' : '⚪';
}
