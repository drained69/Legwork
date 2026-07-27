import { Bot, InlineKeyboard } from 'grammy';
import { config } from '../config.js';
import {
  audit,
  clearOnboarding,
  getApplication,
  getDraft,
  getEngagementByCode,
  getEngagementByUser,
  getOnboarding,
  getPosting,
  getProfile,
  getProfileByWallet,
  now,
  saveEngagement,
  saveProfile,
  setOnboarding,
  transferProfile,
  updateApplication,
} from '../db.js';
import { buildDigest } from '../digest.js';
import { type MatchCard } from '../pipeline.js';
import { resolveSubmissionTarget, submitApplication } from '../skills/applyExecutor.js';
import { tailorApplication } from '../skills/applicationTailor.js';
import { send } from './send.js';
import {
  PROFILE_FIELDS,
  PROFILE_SECTIONS,
  RULE,
  fieldValue,
  atsLabel,
  capText,
  esc,
  listingLabel,
  meter,
  money,
  profileCompleteness,
  renderMatchCard,
  renderProfile,
  renderWelcome,
  scoreVerdict,
  shortAddress,
  title,
  type ProfileField,
} from './ui.js';
import {
  fetchCatalog,
  huntViaApi,
  previewViaApi,
  scoreViaApi,
  serviceHealthy,
  tailorViaApi,
} from './apiClient.js';
import { listUsage } from '../db.js';
import { pollLogin, startLogin, walletCliAvailable, walletLogout, walletStatus } from '../wallet/okxWallet.js';
import type { Engagement, Profile } from '../types.js';

/**
 * Telegram is the only user-facing surface.
 *
 * Design principles:
 *  - Persistent profile: collected once, editable field-by-field forever after.
 *  - Wallet-aware: X Layer address is linked once and shown on every welcome.
 *  - Nothing irreversible happens without an explicit tap.
 */

const HTML = { parse_mode: 'HTML' as const, link_preview_options: { is_disabled: true } };

/**
 * The sender's id, or null when the update carries no user.
 *
 * `ctx.from` is optional in the Telegram API — channel posts and anonymous
 * group admins have none. `String(ctx.from?.id)` yielded the literal string
 * "undefined", so every such update read and wrote ONE shared profile under
 * that key: one anonymous user could see another's résumé and wallet. Handlers
 * must bail when this returns null.
 */
function senderId(ctx: { from?: { id: number } }): string | null {
  const id = ctx.from?.id;
  return typeof id === 'number' ? String(id) : null;
}

// ── setup conversation ─────────────────────────────────────────────────────

const SETUP_STEPS = ['roles', 'seniority', 'locations', 'compFloor', 'skills', 'factors'] as const;
type SetupStep = (typeof SETUP_STEPS)[number];

const SETUP_PROMPTS: Record<SetupStep, { q: string; hint: string }> = {
  roles: { q: 'Which roles are you targeting?', hint: 'Separate with commas — e.g. <i>backend engineer, platform engineer</i>' },
  seniority: { q: 'What level are you applying at?', hint: 'One of: <i>junior · mid · senior · staff</i>' },
  locations: { q: 'Where would you work?', hint: 'Separate with commas. Include <i>remote</i> if that works for you.' },
  compFloor: { q: 'What is your minimum acceptable salary?', hint: 'Annual, numbers only — e.g. <i>120000</i>' },
  skills: { q: 'What are your core skills?', hint: 'Separate with commas — these carry the most scoring weight.' },
  factors: { q: 'Any priorities I should score for?', hint: 'e.g. <i>equity, 4-day week, healthcare</i> — or reply <i>none</i>' },
};

function stepIndex(step: SetupStep): string {
  return `Step ${SETUP_STEPS.indexOf(step) + 1} of ${SETUP_STEPS.length}`;
}

function askSetup(step: SetupStep): string {
  const { q, hint } = SETUP_PROMPTS[step];
  return `${title('Profile setup', stepIndex(step))}\n\n<b>${esc(q)}</b>\n${hint}`;
}

// ── keyboards ──────────────────────────────────────────────────────────────

function mainMenu(profile?: Profile, engagement?: Engagement): InlineKeyboard {
  const kb = new InlineKeyboard();
  // First run: one obvious next step, plus the two things a newcomer asks for.
  if (!profile) {
    return kb
      .text('▶️  Set up my profile', 'setup:start')
      .row()
      .text('☰  Menu', 'menu:open')
      .text('❓  How it works', 'nav:help');
  }
  kb.text('☰  Menu — all activities', 'menu:open').row();
  if (engagement?.status === 'active') kb.text('Run job hunt', 'act:hunt');
  else kb.text('Free preview hunt', 'act:preview');
  kb.text('My profile', 'profile:view').row();
  kb.text(profile.wallet ? 'Wallet' : 'Link wallet', 'wallet:view').text('Help', 'nav:help');
  return kb;
}

/** The full activity menu — every action the bot can perform. */
function activityMenu(profile?: Profile, engagement?: Engagement): InlineKeyboard {
  const kb = new InlineKeyboard();
  const live = engagement?.status === 'active';
  kb.text('🔎  Job hunt — ranked matches', live ? 'act:hunt' : 'act:hunt_locked').row();
  kb.text('👁  Free preview (top 3)', 'act:preview').row();
  kb.text('📊  Score a posting', 'act:score').row();
  kb.text('✍️  Tailor an application', 'act:tailor').row();
  kb.text('👤  My profile', 'profile:view').text('✏️  Edit', 'profile:edit').row();
  kb.text(profile?.wallet ? '💳  Wallet' : '💳  Link wallet', 'wallet:view').row();
  kb.text('🧾  Usage & billing', 'act:usage').text('📈  Status', 'nav:status').row();
  kb.text('🛠  Services & pricing', 'act:catalog').text('❓  Help', 'nav:help').row();
  kb.text('‹ Back', 'nav:home');
  return kb;
}

/** Section picker, then field picker — keeps keyboards small and readable. */
function editSectionKeyboard(): InlineKeyboard {
  const kb = new InlineKeyboard();
  PROFILE_SECTIONS.forEach((sec, i) => {
    kb.text(sec.label, `sect:${i}`);
    kb.row();
  });
  return kb.text('‹ Back', 'nav:home');
}

function editFieldKeyboard(sectionIndex: number): InlineKeyboard {
  const kb = new InlineKeyboard();
  const section = PROFILE_SECTIONS[sectionIndex];
  section.fields.forEach((f, i) => {
    kb.text(PROFILE_FIELDS[f], `edit:${f}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('‹ Sections', 'profile:edit');
}

/**
 * Is this engagement live enough to cover a paid service call?
 *
 * The bot cannot pay per call: it holds no wallet it may sign x402
 * authorizations with, so `apiClient` either presents an engagement token or
 * the request is refused. Anything paid is therefore engagement-only, and the
 * menu must say so before the user does any work.
 */
export function engagementCovers(e?: Engagement): boolean {
  if (!e) return false;
  if (!['active', 'onboarding', 'delivering'].includes(e.status)) return false;
  return !e.endsAt || new Date(e.endsAt) > new Date();
}

/** One explanation for every engagement-only action, naming what does work. */
export function needsEngagement(what: string): string {
  return (
    `${title(`${what} needs an active engagement`)}\n\n` +
    'Paid services run under an engagement bought on the OKX marketplace — they are not charged per message here.\n\n' +
    '<b>Free right now</b>\n· Preview hunt — your top 3 matches, scored and explained\n· Profile, wallet and status\n\n' +
    `<b>To unlock the rest</b>\nHire Legwork (agent ${esc(config.okx.agentId)}) on the OKX marketplace. ` +
    'Every call then runs under that engagement at no extra charge.'
  );
}

function needsEngagementKb(): InlineKeyboard {
  return new InlineKeyboard().text('Free preview', 'act:preview').row().text('Services & pricing', 'act:catalog').text('‹ Menu', 'menu:open');
}

function backHome(): InlineKeyboard {
  return new InlineKeyboard().text('‹ Back to menu', 'nav:home');
}

// ── bot ────────────────────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(config.telegram.token);

  /**
   * Identity gate. Everything downstream keys storage on `ctx.from.id`, and an
   * update without a sender (channel post, anonymous group admin) would key it
   * on the string "undefined" — a single shared profile holding one user's
   * résumé, wallet and engagement, readable by the next anonymous sender.
   * Dropping those updates here means no handler can reintroduce the bug.
   */
  bot.use(async (ctx, next) => {
    if (!senderId(ctx)) return;
    await next();
  });

  // Command list shown in Telegram's UI menu.
  void bot.api
    .setMyCommands([
      { command: 'start', description: 'Home — status and actions' },
      { command: 'menu', description: 'All activities' },
      { command: 'hunt', description: 'Run a job hunt now' },
      { command: 'profile', description: 'View your saved profile' },
      { command: 'edit', description: 'Update a profile field' },
      { command: 'wallet', description: 'Link or view your X Layer wallet' },
      { command: 'status', description: 'Engagement and application status' },
      { command: 'digest', description: 'Summary of applications and matches' },
      { command: 'usage', description: 'Service calls and billing' },
      { command: 'services', description: 'Live services and pricing' },
      { command: 'pause', description: 'Pause scanning' },
      { command: 'resume', description: 'Resume scanning' },
      { command: 'help', description: 'How Legwork works' },
    ])
    .catch(() => {});

  // ── /start — welcome + status ────────────────────────────────────────────

  bot.command('start', async (ctx) => {
    const userId = String(ctx.from?.id);
    const code = ctx.match?.trim();
    let engagement = getEngagementByUser(userId);

    // Deep link from an OKX task binds this chat to that engagement.
    if (code) {
      const bound = getEngagementByCode(code);
      if (!bound) {
        await send(ctx.reply.bind(ctx),
          `${title('Link not recognised')}\n\nThat code is not valid or has expired. Open the link from your OKX task chat, or start a new engagement on the marketplace.`,
          HTML,
        );
        return;
      }
      if (['settled', 'disputed'].includes(bound.status) || (bound.endsAt && new Date(bound.endsAt) < new Date())) {
        await send(ctx.reply.bind(ctx),
          `${title('Engagement closed')}\n\nThis engagement has ended. Hire Legwork again on the OKX marketplace to start a new one.`,
          HTML,
        );
        return;
      }
      if (bound.userId && bound.userId !== userId) {
        await send(ctx.reply.bind(ctx),`${title('Already linked')}\n\nThis engagement is bound to a different Telegram account.`, HTML);
        return;
      }
      bound.userId = userId;
      const existing = getProfile(userId);
      bound.status = existing ? 'active' : 'onboarding';
      saveEngagement(bound);
      audit('telegram', 'ENGAGEMENT_BOUND', `job=${bound.okxJobId} user=${userId}`);
      engagement = bound;
    }

    const profile = getProfile(userId);
    await send(ctx.reply.bind(ctx),
      renderWelcome({
        firstName: ctx.from?.first_name ?? 'there',
        profile,
        engagement,
        agentId: config.okx.agentId,
        returning: Boolean(profile),
      }),
      { ...HTML, reply_markup: mainMenu(profile, engagement) },
    );

    // First run: do NOT jump straight into questions — the welcome explains
    // what Legwork is, and the user starts setup when they choose to.
  });

  // ── informational commands ───────────────────────────────────────────────

  bot.command('menu', async (ctx) => {
    const userId = String(ctx.from?.id);
    const p = getProfile(userId);
    const e = getEngagementByUser(userId);
    await send(ctx.reply.bind(ctx),menuText(p, e), { ...HTML, reply_markup: activityMenu(p, e) });
  });

  bot.command('usage', async (ctx) => showUsage(ctx, String(ctx.from?.id), getEngagementByUser(String(ctx.from?.id))));
  bot.command('services', async (ctx) => showCatalog(ctx));

  bot.command('help', (ctx) => send(ctx.reply.bind(ctx), helpText(), { ...HTML, reply_markup: backHome() }));

  bot.command('profile', async (ctx) => {
    const p = getProfile(String(ctx.from?.id));
    if (!p) return void (await promptSetup(ctx));
    await send(ctx.reply.bind(ctx),renderProfile(p), { ...HTML, reply_markup: new InlineKeyboard().text('Edit profile', 'profile:edit').text('‹ Back', 'nav:home') });
  });

  bot.command('edit', async (ctx) => {
    const p = getProfile(String(ctx.from?.id));
    if (!p) return void (await promptSetup(ctx));
    await send(ctx.reply.bind(ctx),`${title('Edit profile', 'Choose a section')}`, { ...HTML, reply_markup: editSectionKeyboard() });
  });

  bot.command('wallet', async (ctx) => showWallet(ctx, String(ctx.from?.id)));

  bot.command('status', async (ctx) => {
    const userId = String(ctx.from?.id);
    const e = getEngagementByUser(userId);
    const p = getProfile(userId);
    if (!e) {
      return void (await send(ctx.reply.bind(ctx),
        `${title('No active engagement')}\n\nHire Legwork on the OKX marketplace to start one — your profile stays saved either way.`,
        { ...HTML, reply_markup: backHome() },
      ));
    }
    const lines = [
      title('Engagement status'),
      '',
      `<b>Plan</b> · ${esc(listingLabel(e.listing))}`,
      `<b>State</b> · ${esc(e.status)}`,
      `<b>Started</b> · ${e.startedAt.slice(0, 10)}`,
      e.endsAt ? `<b>Ends</b> · ${e.endsAt.slice(0, 10)}` : '',
      p?.wallet ? `<b>Wallet</b> · <code>${esc(shortAddress(p.wallet))}</code>` : '',
      '',
      esc(buildDigest(e)),
    ].filter(Boolean);
    await send(ctx.reply.bind(ctx),lines.join('\n'), { ...HTML, reply_markup: backHome() });
  });

  bot.command('digest', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await send(ctx.reply.bind(ctx),`${title('No active engagement')}\n\nNothing to summarise yet.`, HTML));
    await send(ctx.reply.bind(ctx),`${title('Digest')}\n\n${esc(buildDigest(e))}`, { ...HTML, reply_markup: backHome() });
  });

  bot.command('pause', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await send(ctx.reply.bind(ctx),`${title('No active engagement')}`, HTML));
    e.status = 'paused';
    saveEngagement(e);
    await send(ctx.reply.bind(ctx),`${title('Paused')}\n\nScanning is on hold. Your profile and history are untouched — use /resume when ready.`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Resume', 'nav:resume'),
    });
  });

  bot.command('resume', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await send(ctx.reply.bind(ctx),`${title('No active engagement')}`, HTML));
    e.status = 'active';
    saveEngagement(e);
    await send(ctx.reply.bind(ctx),`${title('Resumed')}\n\nScanning is live again.`, { ...HTML, reply_markup: mainMenu(getProfile(String(ctx.from?.id)), e) });
  });

  bot.command('hunt', async (ctx) => runHuntFlow(ctx, String(ctx.from?.id)));
  bot.command('scan', async (ctx) => runHuntFlow(ctx, String(ctx.from?.id)));

  // ── callbacks ────────────────────────────────────────────────────────────

  bot.on('callback_query:data', async (ctx) => {
    const userId = String(ctx.from.id);
    const [ns, action, extra] = ctx.callbackQuery.data.split(':');

    // ── activity menu ──────────────────────────────────────────────────────
    if (ns === 'menu') {
      await ctx.answerCallbackQuery();
      const p = getProfile(userId);
      const e = getEngagementByUser(userId);
      return void (await send(ctx.reply.bind(ctx),menuText(p, e), { ...HTML, reply_markup: activityMenu(p, e) }));
    }

    // ── live API-backed activities ─────────────────────────────────────────
    if (ns === 'act') {
      const p = getProfile(userId);
      const e = getEngagementByUser(userId);
      if (!p && action !== 'catalog') {
        await ctx.answerCallbackQuery();
        return void (await promptSetup(ctx));
      }
      await ctx.answerCallbackQuery();

      switch (action) {
        case 'hunt_locked':
          return void (await send(ctx.reply.bind(ctx),
            `${title('Hunt requires an active engagement')}\n\nHire Legwork on the OKX marketplace to unlock full ranked hunts, or run a free preview now.`,
            { ...HTML, reply_markup: new InlineKeyboard().text('Free preview', 'act:preview').text('‹ Menu', 'menu:open') },
          ));
        case 'hunt':
          return void (await runHuntFlow(ctx, userId));
        case 'preview':
          return void (await runPreviewFlow(ctx, p!));
        case 'score': {
          // Gate BEFORE asking for a posting. Scoring is only reachable through
          // an engagement — the bot has no way to make a per-call payment on the
          // user's behalf — so prompting first and failing after the paste sent
          // people to a bare "Payment required" with their work already typed.
          if (!engagementCovers(e)) return void (await send(ctx.reply.bind(ctx), needsEngagement('Scoring a posting'), { ...HTML, reply_markup: needsEngagementKb() }));
          setOnboarding(userId, 'act:score', {});
          return void (await send(ctx.reply.bind(ctx),
            `${title('Score a posting', 'Covered by your engagement')}\n\nPaste the job posting — title, company and description. I will score it against your profile on the 100-point rubric.`,
            { ...HTML, reply_markup: new InlineKeyboard().text('Cancel', 'edit:cancel') },
          ));
        }
        case 'tailor': {
          if (!engagementCovers(e)) return void (await send(ctx.reply.bind(ctx), needsEngagement('Tailored drafts'), { ...HTML, reply_markup: needsEngagementKb() }));
          if (!p!.resumeText) {
            return void (await send(ctx.reply.bind(ctx),
              `${title('Résumé needed')}\n\nTailoring writes from your real experience only. Add your résumé first — it is stored and reused.`,
              { ...HTML, reply_markup: new InlineKeyboard().text('Add résumé', 'edit:resume').text('‹ Menu', 'menu:open') },
            ));
          }
          setOnboarding(userId, 'act:tailor', {});
          return void (await send(ctx.reply.bind(ctx),
            `${title('Tailor an application', 'Covered by your engagement')}\n\nPaste the job posting — title, company and description. I will draft a tailored résumé, cover letter and application email.`,
            { ...HTML, reply_markup: new InlineKeyboard().text('Cancel', 'edit:cancel') },
          ));
        }
        case 'usage':
          return void (await showUsage(ctx, userId, e));
        case 'catalog':
          return void (await showCatalog(ctx));
      }
      return;
    }

    // ── profile edit: section picker ───────────────────────────────────────
    if (ns === 'sect') {
      await ctx.answerCallbackQuery();
      const idx = Number(action);
      const section = PROFILE_SECTIONS[idx];
      if (!section) return;
      const p = getProfile(userId);
      if (!p) return void (await promptSetup(ctx));
      const rows = section.fields.map((f) => `<b>${PROFILE_FIELDS[f]}</b> · ${esc(fieldValue(p, f) || '—')}`).join('\n');
      return void (await send(ctx.reply.bind(ctx),`${title(section.label, 'Choose a field to update')}\n\n${rows}`, {
        ...HTML,
        reply_markup: editFieldKeyboard(idx),
      }));
    }

    // Navigation and profile management
    if (ns === 'nav') {
      await ctx.answerCallbackQuery();
      const p = getProfile(userId);
      const e = getEngagementByUser(userId);
      if (action === 'home') {
        return void (await send(ctx.reply.bind(ctx),
          renderWelcome({ firstName: ctx.from.first_name ?? 'there', profile: p, engagement: e, agentId: config.okx.agentId, returning: true }),
          { ...HTML, reply_markup: mainMenu(p, e) },
        ));
      }
      if (action === 'help') return void (await send(ctx.reply.bind(ctx),helpText(), { ...HTML, reply_markup: backHome() }));
      if (action === 'status') {
        if (!e) return void (await send(ctx.reply.bind(ctx),`${title('No active engagement')}`, HTML));
        return void (await send(ctx.reply.bind(ctx),`${title('Engagement status')}\n\n${esc(buildDigest(e))}`, { ...HTML, reply_markup: backHome() }));
      }
      if (action === 'resume' && e) {
        e.status = 'active';
        saveEngagement(e);
        return void (await send(ctx.reply.bind(ctx),`${title('Resumed')}\n\nScanning is live again.`, { ...HTML, reply_markup: mainMenu(p, e) }));
      }
      return;
    }

    if (ns === 'setup') {
      await ctx.answerCallbackQuery();
      setOnboarding(userId, 'roles', {});
      return void (await send(ctx.reply.bind(ctx),askSetup('roles'), HTML));
    }

    if (ns === 'profile') {
      await ctx.answerCallbackQuery();
      const p = getProfile(userId);
      if (!p) return void (await promptSetup(ctx));
      if (action === 'view') {
        return void (await send(ctx.reply.bind(ctx),renderProfile(p), {
          ...HTML,
          reply_markup: new InlineKeyboard().text('Edit profile', 'profile:edit').text('‹ Back', 'nav:home'),
        }));
      }
      if (action === 'edit') {
        return void (await send(ctx.reply.bind(ctx),title('Edit profile', 'Choose a section'), { ...HTML, reply_markup: editSectionKeyboard() }));
      }
      return;
    }

    if (ns === 'edit') {
      await ctx.answerCallbackQuery();
      if (action === 'cancel') {
        clearOnboarding(userId);
        return void (await send(ctx.reply.bind(ctx),`${title('Cancelled')}\n\nNothing was changed.`, { ...HTML, reply_markup: backHome() }));
      }
      const field = action as ProfileField;
      if (!(field in PROFILE_FIELDS)) return;
      setOnboarding(userId, `edit:${field}`, {});
      const p = getProfile(userId);
      const current = p ? fieldValue(p, field) || '—' : '—';
      return void (await send(ctx.reply.bind(ctx),
        `${title(`Update ${PROFILE_FIELDS[field].toLowerCase()}`)}\n\n<b>Current</b>\n${esc(current)}\n\nSend the new value.${
          field === 'wallet' ? '\n<i>Your X Layer address, starting 0x.</i>' : ''
        }`,
        { ...HTML, reply_markup: new InlineKeyboard().text('Cancel', 'edit:cancel') },
      ));
    }

    // Wallet-profile conflict resolution (both sides had data)
    if (ns === 'wladopt') {
      await ctx.answerCallbackQuery();
      const state = getOnboarding(userId);
      if (state?.step !== 'walletadopt') {
        return void (await send(ctx.reply.bind(ctx),`${title('Expired')}\n\nThat choice is no longer pending. Open /wallet to link again.`, { ...HTML, reply_markup: backHome() }));
      }
      const wallet = String(state.partial.wallet ?? '');
      const fromUserId = String(state.partial.fromUserId ?? '');
      // Undefined for Google/Apple sign-ins, which carry no email address.
      const walletEmail = String(state.partial.email ?? '') || undefined;
      clearOnboarding(userId);
      if (action === 'yes') {
        // The wallet's profile wins — it replaces the chat's current one.
        transferProfile(fromUserId, userId);
        const loaded = getProfile(userId)!;
        loaded.walletEmail = walletEmail;
        saveProfile(loaded);
        audit('telegram', 'WALLET_PROFILE_ADOPTED', `wallet=${wallet} -> user=${userId}`);
        return void (await send(ctx.reply.bind(ctx),
          `${title('Profile loaded', 'Restored from your wallet')}\n\n${renderProfile(loaded)}`,
          { ...HTML, reply_markup: new InlineKeyboard().text('Run job hunt', 'act:hunt').text('‹ Menu', 'menu:open') },
        ));
      }
      // Keep current profile: wallet moves to it (one wallet = one profile,
      // so it must be detached from the old one).
      const current = getProfile(userId);
      const other = getProfile(fromUserId);
      if (other && other.wallet?.toLowerCase() === wallet.toLowerCase()) {
        other.wallet = undefined;
        saveProfile(other);
      }
      if (current) {
        current.wallet = wallet;
        current.walletEmail = walletEmail;
        current.updatedAt = now();
        saveProfile(current);
      }
      audit('telegram', 'WALLET_REBOUND', `wallet=${wallet} kept current profile of user=${userId}`);
      return void (await send(ctx.reply.bind(ctx),
        `${title('Wallet linked')}\n\n<code>${esc(wallet)}</code> is now attached to your current profile. The wallet's previous profile was detached.`,
        { ...HTML, reply_markup: backHome() },
      ));
    }

    if (ns === 'wallet') {
      await ctx.answerCallbackQuery();
      if (action === 'link') return void (await beginWalletLogin(ctx, userId));
      if (action === 'check') {
        const state = getOnboarding(userId);
        const sessionId = String(state?.partial?.sessionId ?? '');
        // No live session (bot restarted, or the user never started one).
        if (state?.step !== 'wallet:pending' || !sessionId) return void (await beginWalletLogin(ctx, userId));

        await send(ctx.reply.bind(ctx),`${title('Checking with OKX')}`, HTML);
        const res = await pollLogin(userId, sessionId);

        if (res.pending) {
          return void (await send(ctx.reply.bind(ctx),
            `${title('Not signed in yet')}\n\nFinish signing in on the OKX page, then tap <b>I’ve signed in</b> again.`,
            { ...HTML, reply_markup: walletPendingKeyboard(String(state.partial.loginUrl ?? '')) },
          ));
        }
        if (!res.ok || !res.address) {
          clearOnboarding(userId);
          return void (await send(ctx.reply.bind(ctx),
            `${title('Sign-in failed')}\n\n${esc(res.error ?? 'OKX could not confirm that sign-in.')}`,
            { ...HTML, reply_markup: new InlineKeyboard().text('Start again', 'wallet:link').text('‹ Menu', 'nav:home') },
          ));
        }
        clearOnboarding(userId);
        return void (await completeWalletConnection(ctx, userId, res.address, res.email, Boolean(res.isNew), res.loginType));
      }
      if (action === 'logout') {
        await walletLogout(userId);
        const p = getProfile(userId);
        if (p) {
          p.wallet = undefined;
          p.walletEmail = undefined;
          p.updatedAt = now();
          saveProfile(p);
        }
        return void (await send(ctx.reply.bind(ctx),
          `${title('Wallet disconnected')}\n\nYour OKX session on this bot has ended. Your wallet and funds are untouched — sign in again any time.`,
          { ...HTML, reply_markup: backHome() },
        ));
      }
      return void (await showWallet(ctx, userId));
    }

    if (ns === 'hunt') {
      await ctx.answerCallbackQuery();
      if (action === 'run') return void (await runHuntFlow(ctx, userId));
      if (action === 'approve') {
        const e = getEngagementByUser(userId);
        if (!e) return;
        e.status = 'active';
        saveEngagement(e);
        audit('telegram', 'CRITERIA_APPROVED', `eng=${e.id}`);
        return void (await runHuntFlow(ctx, userId));
      }
      return;
    }

    // ── application actions ────────────────────────────────────────────────
    if (ns === 'app') {
      const appId = extra ?? '';
      const app = getApplication(appId);
      if (!app) return void (await ctx.answerCallbackQuery({ text: 'This card is no longer available.' }));
      const posting = getPosting(app.postingId);
      const profile = getProfile(app.userId);
      if (!posting || !profile) return void (await ctx.answerCallbackQuery({ text: 'Missing data.' }));

      switch (action) {
        case 'approve': {
          if (app.status !== 'pending_approval') {
            return void (await ctx.answerCallbackQuery({ text: `Already ${app.status}.` }));
          }
          const draft = app.draftId ? getDraft(app.draftId) : undefined;
          if (!draft) return void (await ctx.answerCallbackQuery({ text: 'Draft missing.' }));
          app.status = 'approved';
          app.approvalAt = now();
          updateApplication(app);
          audit('telegram', 'APPROVED', `app=${app.id}`);
          await ctx.answerCallbackQuery({ text: 'Approved' });
          const target = resolveSubmissionTarget(posting);
          const destination =
            target.method === 'email' ? `<b>To</b> · ${esc(target.to)}` : `<b>Via</b> · ${esc(atsLabel(posting.atsHint))} — ${esc(target.url)}`;
          await send(ctx.reply.bind(ctx),
            `${title('Final review', 'This is exactly what will be sent')}\n\n${destination}\n<b>Subject</b> · ${esc(draft.emailSubject)}\n\n${esc(
              draft.emailBody.slice(0, 2200),
            )}`,
            {
              ...HTML,
              reply_markup: new InlineKeyboard().text('Send now', `app:send:${app.id}`).text('Cancel', `app:cancel:${app.id}`),
            },
          );
          break;
        }
        case 'send': {
          if (app.status === 'submitted') return void (await ctx.answerCallbackQuery({ text: 'Already sent.' }));
          if (app.status === 'failed' && app.approvalAt && app.draftId) {
            app.status = 'approved';
            updateApplication(app);
          }
          if (app.status !== 'approved') return void (await ctx.answerCallbackQuery({ text: `Cannot send (${app.status}).` }));
          await ctx.answerCallbackQuery({ text: 'Sending…' });
          const result = await submitApplication(app, profile, posting);
          await send(ctx.reply.bind(ctx),
            result.ok
              ? `${title('Application sent')}\n\n<b>${esc(posting.title)}</b>\n${esc(posting.company)}\n\n${esc(result.receipt ?? '')}`
              : `${title('Submission failed')}\n\n${esc(result.error ?? 'Unknown error')}`,
            result.ok ? HTML : { ...HTML, reply_markup: new InlineKeyboard().text('Retry', `app:send:${app.id}`) },
          );
          break;
        }
        case 'cancel': {
          if (app.status === 'approved') {
            app.status = 'pending_approval';
            app.approvalAt = undefined;
            updateApplication(app);
          }
          await ctx.answerCallbackQuery({ text: 'Cancelled' });
          break;
        }
        case 'draft': {
          const draft = app.draftId ? getDraft(app.draftId) : undefined;
          if (!draft) return void (await ctx.answerCallbackQuery({ text: 'Draft missing.' }));
          await ctx.answerCallbackQuery();
          await send(ctx.reply.bind(ctx),`${title('Tailored résumé', `Version ${draft.version}`)}\n\n${esc(draft.resumeText.slice(0, 3000))}`, HTML);
          await send(ctx.reply.bind(ctx),`${title('Cover letter')}\n\n${esc(draft.coverLetter.slice(0, 3000))}`, HTML);
          break;
        }
        case 'revise': {
          if (app.status !== 'pending_approval') return void (await ctx.answerCallbackQuery({ text: `Locked (${app.status}).` }));
          await ctx.answerCallbackQuery();
          setOnboarding(app.userId, `feedback:${app.id}`, {});
          await send(ctx.reply.bind(ctx),`${title('Request changes')}\n\nTell me what to change and I will redraft it.`, HTML);
          break;
        }
        case 'skip': {
          if (app.status !== 'pending_approval') return void (await ctx.answerCallbackQuery({ text: `Already ${app.status}.` }));
          if (!extra) return;
          await ctx.answerCallbackQuery();
          await send(ctx.reply.bind(ctx),`${title('Skip this role')}\n\nWhy? This tunes future scoring.`, {
            ...HTML,
            reply_markup: new InlineKeyboard()
              .text('Salary', `skip:reason:${app.id}|comp`)
              .text('Location', `skip:reason:${app.id}|location`)
              .row()
              .text('Role fit', `skip:reason:${app.id}|rolefit`)
              .text('Company', `skip:reason:${app.id}|company`)
              .text('Other', `skip:reason:${app.id}|other`),
          });
          break;
        }
      }
      return;
    }

    if (ns === 'skip' && action === 'reason') {
      const [appId, reason] = (extra ?? '').split('|');
      const app = getApplication(appId);
      if (!app) return void (await ctx.answerCallbackQuery({ text: 'Not found.' }));
      if (app.status !== 'pending_approval') return void (await ctx.answerCallbackQuery({ text: `Already ${app.status}.` }));
      app.status = 'skipped';
      app.skipReason = reason;
      updateApplication(app);
      audit('telegram', 'SKIPPED', `app=${app.id} reason=${reason}`);
      await ctx.answerCallbackQuery({ text: 'Skipped' });
      await send(ctx.reply.bind(ctx),`${title('Skipped')}\n\nNoted — I will weight <i>${esc(reason)}</i> more heavily going forward.`, HTML);
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // ── free text: setup, edits, draft feedback ──────────────────────────────

  bot.on('message:text', async (ctx) => {
    const userId = String(ctx.from.id);
    const state = getOnboarding(userId);
    const text = ctx.message.text.trim();

    // Nothing pending: the bot used to return silently, so a user who typed
    // "hi" — or pasted a posting without tapping a button first — got no
    // response at all and had no way to tell a dead bot from a quiet one.
    if (!state) {
      if (looksLikeSecret(text)) return void (await send(ctx.reply.bind(ctx), secretWarning(), { ...HTML, reply_markup: backHome() }));
      const p = getProfile(userId);
      const e = getEngagementByUser(userId);
      return void (await send(
        ctx.reply.bind(ctx),
        p
          ? `${title('Not sure what to do with that')}\n\nI act on the buttons below rather than free text. Pick an action, or send /menu any time.`
          : `${title('Let’s start with your profile')}\n\nOnce it is set up I can hunt, score and draft against it.`,
        { ...HTML, reply_markup: p ? activityMenu(p, e) : new InlineKeyboard().text('Set up profile', 'setup:start') },
      ));
    }

    // Draft revision
    if (state.step.startsWith('feedback:')) {
      const appId = state.step.slice('feedback:'.length);
      clearOnboarding(userId);
      const app = getApplication(appId);
      const posting = app && getPosting(app.postingId);
      const profile = getProfile(userId);
      if (!app || !posting || !profile) return void (await send(ctx.reply.bind(ctx),'That application is no longer available.'));
      if (app.status !== 'pending_approval') return void (await send(ctx.reply.bind(ctx),`This draft is locked — the application is ${app.status}.`));
      await send(ctx.reply.bind(ctx),`${title('Redrafting')}\n\nApplying your notes…`, HTML);
      const draft = await tailorApplication(profile, posting, text);
      app.draftId = draft.id;
      updateApplication(app);
      await sendMatchCard(bot, ctx.from.id, { application: app, posting, draft, breakdown: app.breakdown });
      return;
    }

    // Live API activities that need a pasted posting
    if (state.step === 'act:score' || state.step === 'act:tailor') {
      const profile = getProfile(userId);
      if (!profile) {
        clearOnboarding(userId);
        return void (await promptSetup(ctx));
      }
      const posting = parsePosting(text);
      if (!posting) {
        return void (await send(ctx.reply.bind(ctx),
          `${title('Could not read that posting')}\n\nInclude at least a job title, a company name and the description. Paste the posting text directly.`,
          { ...HTML, reply_markup: new InlineKeyboard().text('Cancel', 'edit:cancel') },
        ));
      }
      clearOnboarding(userId);
      const engagement = getEngagementByUser(userId);

      if (state.step === 'act:score') {
        await send(ctx.reply.bind(ctx),`${title('Scoring', 'Calling the live service')}`, HTML);
        const res = await scoreViaApi(profile, posting, engagement);
        if (!res.ok) {
          return void (await send(ctx.reply.bind(ctx),`${title('Scoring failed')}\n\n${esc(res.error ?? 'Unknown error')}`, {
            ...HTML,
            reply_markup: backHome(),
          }));
        }
        const b = res.data!.breakdown;
        return void (await send(ctx.reply.bind(ctx),
          `${title(posting.title, posting.company)}\n\n<b>${meter(b.total)}/100</b> — ${scoreVerdict(b.total)}\n\n` +
            `<b>Skills ${b.skills.score}/${b.skills.max}</b> — ${esc(b.skills.reason)}\n` +
            `<b>Salary ${b.comp.score}/${b.comp.max}</b> — ${esc(b.comp.reason)}\n` +
            `<b>Location ${b.location.score}/${b.location.max}</b> — ${esc(b.location.reason)}\n` +
            `<b>Level ${b.seniority.score}/${b.seniority.max}</b> — ${esc(b.seniority.reason)}\n` +
            `<b>Priorities ${b.culture.score}/${b.culture.max}</b> — ${esc(b.culture.reason)}\n\n${RULE}\n` +
            `<b>Billing</b> · ${res.billing === 'engagement' ? 'covered by your engagement' : '$0.01 per call'}`,
          { ...HTML, reply_markup: new InlineKeyboard().text('Tailor for this role', 'act:tailor').text('‹ Menu', 'menu:open') },
        ));
      }

      await send(ctx.reply.bind(ctx),`${title('Drafting', 'Calling the live service')}`, HTML);
      const res = await tailorViaApi(profile, posting, engagement);
      if (!res.ok) {
        return void (await send(ctx.reply.bind(ctx),`${title('Tailoring failed')}\n\n${esc(res.error ?? 'Unknown error')}`, {
          ...HTML,
          reply_markup: backHome(),
        }));
      }
      const d = res.data!;
      await send(ctx.reply.bind(ctx),`${title('Tailored résumé', posting.title)}\n\n${esc(d.resume.slice(0, 3000))}`, HTML);
      await send(ctx.reply.bind(ctx),`${title('Cover letter')}\n\n${esc(d.coverLetter.slice(0, 3000))}`, HTML);
      return void (await send(ctx.reply.bind(ctx),
        `${title('Application email')}\n\n<b>Subject</b> · ${esc(d.emailSubject)}\n\n${esc(d.emailBody.slice(0, 2500))}\n\n${RULE}\n` +
          `<b>Billing</b> · ${res.billing === 'engagement' ? 'covered by your engagement' : '$0.10 per call'}\n` +
          `<i>Nothing has been sent — these drafts are yours to use.</i>`,
        { ...HTML, reply_markup: backHome() },
      ));
    }

    // ── OKX wallet sign-in happens on OKX's own page, not in this chat ───
    // Nothing typed here can advance it, so nudge back to the button. The
    // secret-shaped guard stays: a user mid-sign-in may paste the wrong thing.
    if (state.step.startsWith('wallet:')) {
      if (looksLikeSecret(text)) return void (await send(ctx.reply.bind(ctx),secretWarning(), { ...HTML, reply_markup: backHome() }));
      // Steps other than `pending` are from the retired email/OTP flow: a user
      // mid-sign-in across a deploy. Restart them rather than stranding them —
      // without this they fall through to a silent return and a dead chat.
      if (state.step !== 'wallet:pending') {
        clearOnboarding(userId);
        return void (await beginWalletLogin(ctx, userId));
      }
      return void (await send(ctx.reply.bind(ctx),
        `${title('Finish on the OKX page')}\n\nSigning in happens on OKX’s site — there is nothing to type here. ` +
          'Open the link, sign in, then tap <b>I’ve signed in</b>.',
        { ...HTML, reply_markup: walletPendingKeyboard(String(state.partial.loginUrl ?? '')) },
      ));
    }

    // Single-field edit
    if (state.step.startsWith('edit:')) {
      const field = state.step.slice('edit:'.length) as ProfileField;

      // ── wallet is special: it is an identity key, not just a field ───────
      // It can only be set by proving control through OKX, never by typing.
      if (field === 'wallet') return void (await beginWalletLogin(ctx, userId));

      const profile = getProfile(userId);
      if (!profile) {
        clearOnboarding(userId);
        return void (await promptSetup(ctx));
      }
      const applied = applyField(profile, field, text);
      if (!applied.ok) return void (await send(ctx.reply.bind(ctx),`${title('Invalid value')}\n\n${applied.error}`, HTML));
      profile.updatedAt = now();
      saveProfile(profile);
      clearOnboarding(userId);
      audit('telegram', 'PROFILE_UPDATED', `user=${userId} field=${field}`);
      await send(ctx.reply.bind(ctx),
        `${title('Updated')}\n\n<b>${PROFILE_FIELDS[field]}</b>\n${esc(fieldValue(profile, field) || '—')}`,
        { ...HTML, reply_markup: new InlineKeyboard().text('Edit another', 'profile:edit').text('‹ Menu', 'nav:home') },
      );
      return;
    }

    // Guided setup
    const step = state.step as SetupStep;
    if (!SETUP_STEPS.includes(step)) return;
    const partial = state.partial;
    const validated = validateSetup(step, text);
    if (!validated.ok) return void (await send(ctx.reply.bind(ctx),`${title('Let me try that again')}\n\n${validated.error}`, HTML));
    Object.assign(partial, validated.patch);

    const next = SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1];
    if (next) {
      setOnboarding(userId, next, partial);
      return void (await send(ctx.reply.bind(ctx),askSetup(next), HTML));
    }

    // Complete — persist and offer wallet linking.
    const existing = getProfile(userId);
    const profile: Profile = {
      userId,
      name: existing?.name || ctx.from.first_name || 'Candidate', // || not ??: wallet-first shell profiles carry name ''
      targetRoles: (partial.targetRoles as string[]) ?? [],
      seniority: String(partial.seniority ?? 'mid'),
      locations: (partial.locations as string[]) ?? [],
      remoteOk: Boolean(partial.remoteOk),
      compFloor: Number(partial.compFloor ?? 0),
      skills: (partial.skills as string[]) ?? [],
      factors: (partial.factors as string[]) ?? [],
      resumeText: existing?.resumeText ?? '',
      dealbreakers: existing?.dealbreakers ?? [],
      threshold: existing?.threshold ?? 0,
      dailyCap: existing?.dailyCap ?? 10,
      email: existing?.email,
      wallet: existing?.wallet,
      updatedAt: now(),
    };
    saveProfile(profile);
    clearOnboarding(userId);
    const e = getEngagementByUser(userId);
    if (e && e.status === 'onboarding') {
      e.status = 'active';
      saveEngagement(e);
    }
    audit('telegram', 'PROFILE_SAVED', `user=${userId}`);

    await send(ctx.reply.bind(ctx),
      `${renderProfile(profile)}\n\n${RULE}\nSaved. You will not be asked for this again — use <b>Edit profile</b> any time.`,
      {
        ...HTML,
        reply_markup: profile.wallet
          ? new InlineKeyboard().text('Run job hunt', 'hunt:run').row().text('Edit profile', 'profile:edit').text('‹ Menu', 'nav:home')
          : new InlineKeyboard().text('Link X Layer wallet', 'wallet:link').row().text('Run job hunt', 'hunt:run').text('‹ Menu', 'nav:home'),
      },
    );
  });

  /**
   * Last line of defence. A handler that throws used to log and leave the user
   * facing silence — indistinguishable from a dead bot, and with an inline
   * keyboard still spinning if the callback was never answered. Close both.
   */
  bot.catch(async ({ error, ctx }) => {
    console.error('[telegram] handler error:', error);
    try {
      // Clears the button's loading state; harmless if already answered.
      if (ctx.callbackQuery) await ctx.answerCallbackQuery().catch(() => {});
      await ctx.reply(
        `${title('Something went wrong')}\n\nThat action did not complete. Nothing was sent or charged — try again, or send /menu.`,
        { ...HTML, reply_markup: backHome() },
      );
    } catch (replyErr) {
      console.error('[telegram] could not deliver the error notice:', replyErr);
    }
  });
  return bot;
}

// ── helpers ────────────────────────────────────────────────────────────────

type Ctx = { reply: (text: string, other?: Record<string, unknown>) => Promise<unknown> };

async function promptSetup(ctx: Ctx): Promise<void> {
  await send(ctx.reply.bind(ctx),
    `${title('No profile yet')}\n\nSet up your profile and I will start matching roles against it.`,
    { ...HTML, reply_markup: new InlineKeyboard().text('Set up profile', 'setup:start') },
  );
}

function walletPrompt(): string {
  return (
    `${title('Connect your OKX wallet', 'Sign in at OKX')}\n\n` +
    'Tap <b>Get sign-in link</b> and I’ll ask OKX for a one-time sign-in page. ' +
    'You sign in there with <b>Google, Apple or email</b> — whichever your OKX account uses — ' +
    'then come back and tap <b>I’ve signed in</b>.\n\n' +
    'Your X Layer wallet is connected on return, and created automatically if you don’t have one yet.\n\n' +
    '<b>Legwork never sees your keys or your password.</b> You authenticate on OKX’s own site; ' +
    'keys are generated inside OKX’s secure enclave and cannot leave it. I only ever receive your public address.\n\n' +
    '<i>Never send a private key or seed phrase to anyone, including me.</i>'
  );
}

function looksLikeSecret(text: string): boolean {
  return /^(0x)?[a-fA-F0-9]{64}$/.test(text.trim()) || /\b(seed|mnemonic|private key)\b/i.test(text);
}

function secretWarning(): string {
  return (
    `${title('Never share that')}\n\n⚠️ That looks like a private key or seed phrase. ` +
    '<b>Never share it with anyone, including me.</b>\n\n' +
    'Legwork never needs it — you sign in on OKX’s own page.'
  );
}

function loginTypeLabel(loginType?: string): string {
  const map: Record<string, string> = { email: 'Email', google: 'Google', apple: 'Apple', ak: 'API Key' };
  return map[String(loginType ?? '').toLowerCase()] ?? 'OKX account';
}

/** Keyboard shown while a sign-in is in flight. */
function walletPendingKeyboard(loginUrl: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (loginUrl) kb.url('Open OKX sign-in', loginUrl).row();
  return kb.text('I’ve signed in', 'wallet:check').row().text('Cancel', 'edit:cancel');
}

/**
 * Starts the OKX browser sign-in: mint a login URL and hand it to the user.
 *
 * The URL is a bearer credential for one session, so it is sent only to the
 * chat that requested it and never logged.
 */
async function beginWalletLogin(ctx: Ctx, userId: string): Promise<void> {
  if (!(await walletCliAvailable())) {
    return void (await send(ctx.reply.bind(ctx),
      `${title('Wallet sign-in unavailable')}\n\nThe OKX wallet service is not reachable from this deployment right now. ` +
        'Everything else — profile, hunts, scoring and drafts — works normally.',
      { ...HTML, reply_markup: backHome() },
    ));
  }

  await send(ctx.reply.bind(ctx),`${title('Contacting OKX', 'Preparing your sign-in link')}`, HTML);
  const session = await startLogin(userId);
  if (!session.ok || !session.loginUrl || !session.sessionId) {
    clearOnboarding(userId);
    return void (await send(ctx.reply.bind(ctx),
      `${title('Could not start sign-in')}\n\n${esc(session.error ?? 'Unknown error')}`,
      { ...HTML, reply_markup: new InlineKeyboard().text('Try again', 'wallet:link').text('‹ Menu', 'nav:home') },
    ));
  }

  setOnboarding(userId, 'wallet:pending', { sessionId: session.sessionId, loginUrl: session.loginUrl });
  await send(ctx.reply.bind(ctx),
    `${title('Sign in at OKX', 'Then come back here')}\n\n` +
      '1. Open the OKX sign-in page below\n' +
      '2. Sign in with Google, Apple or email\n' +
      '3. Return here and tap <b>I’ve signed in</b>\n\n' +
      '<i>The link works once and expires shortly. It is personal to you — don’t forward it.</i>',
    { ...HTML, reply_markup: walletPendingKeyboard(session.loginUrl) },
  );
}

/**
 * Completes an OKX-verified wallet connection.
 *
 * The address here is PROVEN — the user signed in on OKX's own page and OKX
 * returned the address from its TEE. That is what makes wallet-as-identity
 * safe: connecting a wallet loads the profile behind it.
 *
 * `email` is undefined for Google/Apple sign-ins, which carry no address; the
 * display falls back to the method name while walletEmail stays genuinely
 * empty rather than holding a provider name.
 *
 * Invariant: one wallet ↔ one profile, enforced at this single entry point.
 */
async function completeWalletConnection(
  ctx: Ctx,
  userId: string,
  address: string,
  email: string | undefined,
  isNew: boolean,
  loginType?: string,
): Promise<void> {
  const owner = getProfileByWallet(address);
  const current = getProfile(userId);
  const via = email || loginTypeLabel(loginType);

  const connected = (extra: string, kb: InlineKeyboard) =>
    send(
      ctx.reply.bind(ctx),
      `${title(isNew ? 'Wallet created' : 'Wallet connected', esc(via))}\n\n` +
        `<b>X Layer address</b>\n<code>${esc(address)}</code>\n\n${extra}`,
      { ...HTML, reply_markup: kb },
    );

  // Already this account's wallet — refresh the record and move on.
  if (owner && owner.userId === userId) {
    owner.wallet = address;
    owner.walletEmail = email;
    owner.updatedAt = now();
    saveProfile(owner);
    return void (await connected('Your wallet session has been refreshed.', backHome()));
  }

  // The wallet carries a profile from another Telegram account → load it.
  if (owner) {
    if (current) {
      setOnboarding(userId, 'walletadopt', { wallet: address, fromUserId: owner.userId, email });
      return void (await send(ctx.reply.bind(ctx),
        `${title('This wallet already has a profile', esc(owner.name || 'Saved profile'))}\n\n` +
          `<code>${esc(address)}</code> carries an existing Legwork profile ` +
          `(${esc(owner.targetRoles.join(', ') || 'no roles set')}).\n\n` +
          'You also have a profile in this chat. Which should this account use?',
        {
          ...HTML,
          reply_markup: new InlineKeyboard()
            .text('Load the wallet profile', 'wladopt:yes')
            .row()
            .text('Keep my current profile', 'wladopt:no'),
        },
      ));
    }
    transferProfile(owner.userId, userId);
    const loaded = getProfile(userId)!;
    loaded.walletEmail = email;
    saveProfile(loaded);
    audit('telegram', 'WALLET_PROFILE_LOADED', `user=${userId}`);
    await connected('Your saved profile, history and engagements have been restored.', new InlineKeyboard());
    return void (await send(ctx.reply.bind(ctx),renderProfile(loaded), {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Run job hunt', 'act:hunt').text('‹ Menu', 'menu:open'),
    }));
  }

  // Wallet is new to Legwork.
  if (current) {
    current.wallet = address;
    current.walletEmail = email;
    current.updatedAt = now();
    saveProfile(current);
    audit('telegram', 'WALLET_LINKED', `user=${userId}`);
    return void (await connected(
      'This wallet is now attached to your profile. Signing in to the same OKX account anywhere restores it.',
      backHome(),
    ));
  }

  // No profile yet — anchor a fresh one to the wallet and start setup.
  const shell: Profile = {
    userId, name: '', targetRoles: [], seniority: 'mid', locations: [], remoteOk: false,
    compFloor: 0, skills: [], resumeText: '', dealbreakers: [], factors: [],
    threshold: 0, dailyCap: 10, wallet: address, walletEmail: email, updatedAt: now(),
  };
  saveProfile(shell);
  setOnboarding(userId, 'roles', {});
  audit('telegram', 'WALLET_LINKED_NEW', `user=${userId}`);
  await connected('Now let\u2019s set up the profile this wallet will carry.', new InlineKeyboard());
  await send(ctx.reply.bind(ctx),askSetup('roles'), HTML);
}

async function showWallet(ctx: Ctx & { from?: { id: number } }, userId: string): Promise<void> {
  const p = getProfile(userId);
  const status = await walletStatus(userId);

  if (!status.loggedIn || !p?.wallet) {
    return void (await send(ctx.reply.bind(ctx),walletPrompt(), {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Get sign-in link', 'wallet:link').text('\u2039 Back', 'nav:home'),
    }));
  }

  await send(ctx.reply.bind(ctx),
    `${title('OKX Agentic Wallet', 'Connected')}\n\n` +
      `<b>Signed in as</b> · ${esc(status.email ?? p.walletEmail ?? loginTypeLabel(status.loginType))}\n` +
      `<b>X Layer address</b>\n<code>${esc(p.wallet)}</code>\n\n` +
      `<b>Network</b> · X Layer (chain 196) — gas-free\n` +
      `<b>Account</b> · ${esc(status.accountName ?? 'Account 1')}\n` +
      `<b>Connected</b> · ${p.updatedAt?.slice(0, 10) ?? '\u2014'}\n\n` +
      '<i>Keys are held in OKX\u2019s secure enclave. Legwork can never access or export them.</i>',
    {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Disconnect', 'wallet:logout').text('\u2039 Back', 'nav:home'),
    },
  );
}

async function runHuntFlow(ctx: Ctx, userId: string): Promise<void> {
  const profile = getProfile(userId);
  if (!profile) return void (await promptSetup(ctx));
  const engagement = getEngagementByUser(userId);
  if (!engagement) {
    return void (await send(ctx.reply.bind(ctx),
      `${title('No active engagement')}\n\nA full ranked hunt needs an engagement from the OKX marketplace. You can run a free preview right now instead.`,
      { ...HTML, reply_markup: new InlineKeyboard().text('Free preview', 'act:preview').text('‹ Menu', 'menu:open') },
    ));
  }
  if (engagement.status === 'paused') {
    return void (await send(ctx.reply.bind(ctx),`${title('Engagement paused')}\n\nUse /resume to continue scanning.`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Resume', 'nav:resume'),
    }));
  }

  const c = profileCompleteness(profile);
  if (c.missing.length) {
    return void (await send(ctx.reply.bind(ctx),`${title('Profile incomplete')}\n\nStill needed: <b>${esc(c.missing.join(', '))}</b>`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Complete profile', 'profile:edit'),
    }));
  }

  await send(ctx.reply.bind(ctx),`${title('Hunting', 'Calling the live scoring service')}`, HTML);

  // LIVE call to Legwork's own public API — same endpoint external agents pay for.
  const res = await huntViaApi(profile, engagement);
  if (!res.ok) {
    return void (await send(ctx.reply.bind(ctx),`${title('Hunt failed')}\n\n${esc(res.error ?? 'Unknown error')}`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Try again', 'act:hunt').text('‹ Menu', 'menu:open'),
    }));
  }
  const data = res.data!;
  if (data.sourceErrors?.length) {
    await send(ctx.reply.bind(ctx),`${title('Partial results')}\n\nSome sources were unavailable: ${esc(data.sourceErrors.join('; '))}`, HTML);
  }
  if (!data.matches.length) {
    return void (await send(ctx.reply.bind(ctx),
      `${title('No new matches')}\n\nEverything currently listed has already been shown to you. I keep scanning and will message you when something new appears.`,
      { ...HTML, reply_markup: backHome() },
    ));
  }

  for (const [i, m] of data.matches.entries()) {
    await send(ctx.reply.bind(ctx),renderMatchCard(m.posting, m.breakdown, i + 1, data.matches.length), {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
    });
  }
  await send(ctx.reply.bind(ctx),
    `${title('Hunt complete')}\n\n<b>${data.matches.length}</b> matches from <b>${data.found}</b> postings scanned.\n` +
      `<b>Billing</b> · ${res.billing === 'engagement' ? 'covered by your engagement' : 'per-call'}` +
      (profile.wallet ? `\n<b>Wallet</b> · <code>${esc(shortAddress(profile.wallet))}</code>` : ''),
    { ...HTML, reply_markup: backHome() },
  );
}

async function runPreviewFlow(ctx: Ctx, profile: Profile): Promise<void> {
  const c = profileCompleteness(profile);
  if (c.missing.length) {
    return void (await send(ctx.reply.bind(ctx),`${title('Profile incomplete')}\n\nStill needed: <b>${esc(c.missing.join(', '))}</b>`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Complete profile', 'profile:edit'),
    }));
  }
  await send(ctx.reply.bind(ctx),`${title('Free preview', 'Top 3 matches — no charge')}`, HTML);
  const res = await previewViaApi(profile);
  if (!res.ok) {
    return void (await send(ctx.reply.bind(ctx),`${title('Preview unavailable')}\n\n${esc(res.error ?? 'Unknown error')}`, {
      ...HTML,
      reply_markup: backHome(),
    }));
  }
  const d = res.data!;
  if (!d.matches?.length) {
    return void (await send(ctx.reply.bind(ctx),`${title('No matches right now')}\n\nNothing new matched your criteria this pass.`, {
      ...HTML,
      reply_markup: backHome(),
    }));
  }
  const lines = d.matches.map(
    (m, i) =>
      `<b>${i + 1}. ${esc(m.title)}</b>\n${esc(m.company)} · ${esc(m.location)}\n${meter(m.score)}/100 — ${scoreVerdict(m.score)}\n` +
      m.why.map((w) => `· ${esc(w)}`).join('\n') +
      `\n<a href="${esc(m.url)}">View posting</a>`,
  );
  await send(ctx.reply.bind(ctx),
    `${title('Preview results', `Showing ${d.shown} of ${d.totalMatches}`)}\n\n${lines.join('\n\n')}\n\n${RULE}\n` +
      `Previews left this hour · ${d.previewsRemainingThisHour}`,
    { ...HTML, reply_markup: new InlineKeyboard().text('Full ranked hunt', 'act:hunt').text('‹ Menu', 'menu:open') },
  );
}

async function showUsage(ctx: Ctx, userId: string, engagement?: Engagement): Promise<void> {
  const records = listUsage(userId, 20);
  const profile = getProfile(userId);
  if (!records.length) {
    return void (await send(ctx.reply.bind(ctx),`${title('Usage & billing')}\n\nNo service calls yet.`, { ...HTML, reply_markup: backHome() }));
  }
  const covered = records.filter((r) => !r.paid).length;
  const rows = records
    .slice(0, 10)
    .map((r) => `${r.at.slice(0, 16).replace('T', ' ')} · ${esc(r.service)} · ${r.paid ? `$${r.priceUsd}` : 'engagement'} · ${r.status}`)
    .join('\n');
  await send(ctx.reply.bind(ctx),
    `${title('Usage & billing', `${records.length} recent calls`)}\n\n` +
      (profile?.wallet ? `<b>Wallet</b> · <code>${esc(profile.wallet)}</code>\n` : '') +
      (engagement ? `<b>Engagement</b> · ${esc(listingLabel(engagement.listing))}\n` : '') +
      `<b>Covered by engagement</b> · ${covered} of ${records.length}\n\n<code>${rows}</code>`,
    { ...HTML, reply_markup: backHome() },
  );
}

async function showCatalog(ctx: Ctx): Promise<void> {
  const [catalog, healthy] = await Promise.all([fetchCatalog(), serviceHealthy()]);
  if (!catalog) {
    return void (await send(ctx.reply.bind(ctx),`${title('Services unavailable')}\n\nCould not reach the service catalog.`, {
      ...HTML,
      reply_markup: backHome(),
    }));
  }
  // The catalog reports whether a payment can actually settle. Quoting a
  // per-call price the buyer cannot pay is the over-promise that gets an agent
  // rejected, so say how each service is really reachable from here.
  const payable = catalog.payment?.settlementAvailable === true;
  const rows = catalog.services
    .map((s) => {
      const how = payable ? `$${esc(s.priceUsd)} per call` : 'included in an engagement';
      return `<b>${esc(s.id)}</b> · ${how}\n<code>${esc(s.endpoint)}</code>\n${esc(s.description)}`;
    })
    .join('\n\n');
  await send(ctx.reply.bind(ctx),
    `${title('Services & pricing', healthy ? 'Live' : 'Service unreachable')}\n\n${rows}` +
      (catalog.freeTier ? `\n\n<b>Free tier</b> · ${esc(catalog.freeTier.endpoint)} — ${catalog.freeTier.limitPerHour}/hour, no charge` : '') +
      (payable
        ? (catalog.payment ? `\n\n<b>Settlement</b> · ${esc(catalog.payment.assetSymbol)} on ${esc(catalog.payment.network)}` : '')
        : `\n\n<b>How to buy</b> · Per-call payment is not open here. Hire Legwork (agent ${esc(config.okx.agentId)}) ` +
          'on the OKX marketplace — tasks settle in USDT via escrow and every call is then covered.'),
    { ...HTML, reply_markup: backHome() },
  );
}

function menuText(profile?: Profile, engagement?: Engagement): string {
  const lines = [title('Menu', 'Everything Legwork can do'), ''];
  if (!profile) {
    lines.push('Set up your profile first — every activity below scores against it.');
    return lines.join('\n');
  }
  lines.push(
    engagement?.status === 'active'
      ? `Engagement · <b>${esc(listingLabel(engagement.listing))}</b> — calls are covered.`
      : 'No active engagement — free preview is available, full hunts need a marketplace engagement.',
  );
  if (profile.wallet) lines.push(`Wallet · <code>${esc(shortAddress(profile.wallet))}</code>`);
  lines.push('', 'Each action calls the live Legwork service.');
  return lines.join('\n');
}

function applyField(p: Profile, field: ProfileField, text: string): { ok: true } | { ok: false; error: string } {
  const list = () => splitList(text);
  const num = () => Number(text.replace(/[^0-9]/g, ''));
  const yesNo = (): boolean | undefined => {
    const t = text.trim().toLowerCase();
    if (['yes', 'y', 'true'].includes(t)) return true;
    if (['no', 'n', 'false'].includes(t)) return false;
    return undefined;
  };
  const url = (label: string): { ok: true } | { ok: false; error: string } => {
    if (!/^https?:\/\/\S+$/i.test(text.trim())) return { ok: false, error: `Send a full ${label} URL starting with https://` };
    return { ok: true };
  };

  switch (field) {
    // Identity & contact
    case 'name': p.name = capText(text, 100); return { ok: true };
    case 'email': {
      if (!/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(text)) return { ok: false, error: 'That does not look like an email address.' };
      p.email = text.trim();
      return { ok: true };
    }
    case 'phone': {
      if (!/^[+\d][\d\s().-]{6,}$/.test(text.trim())) return { ok: false, error: 'Send a valid phone number, including country code.' };
      p.phone = text.trim();
      return { ok: true };
    }
    case 'currentLocation': p.currentLocation = capText(text, 120); return { ok: true };
    case 'wallet':
      // Wallet is never set from free text — it is proven via OKX sign-in.
      return { ok: false, error: 'Use <b>/wallet</b> to sign in with OKX — wallets cannot be typed in by hand.' };

    // Professional
    case 'currentTitle': p.currentTitle = capText(text, 120); return { ok: true };
    case 'yearsExperience': {
      const n = num();
      if (!Number.isFinite(n) || n < 0 || n > 60) return { ok: false, error: 'Send a number of years — for example <i>7</i>.' };
      p.yearsExperience = n;
      return { ok: true };
    }
    case 'seniority': {
      const t = text.trim().toLowerCase();
      const allowed = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal'];
      if (!allowed.includes(t)) return { ok: false, error: `Choose one of: <i>${allowed.join(' · ')}</i>` };
      p.seniority = t;
      return { ok: true };
    }
    case 'skills': {
      const v = list();
      if (!v.length) return { ok: false, error: 'Send at least one skill.' };
      p.skills = v;
      return { ok: true };
    }
    case 'resume': {
      if (text.trim().length < 50) return { ok: false, error: 'Send your résumé text — at least a few sentences of real experience.' };
      // Bounded because it is shipped to the tailoring API on every call; the
      // scorer only reads the first 2000 characters anyway.
      p.resumeText = capText(text, 20_000);
      return { ok: true };
    }
    case 'education': p.education = capText(text, 400); return { ok: true };
    case 'certifications': p.certifications = text.toLowerCase() === 'none' ? [] : list(); return { ok: true };
    case 'languages': p.languages = text.toLowerCase() === 'none' ? [] : list(); return { ok: true };

    // Links
    case 'linkedin': { const r = url('LinkedIn'); if (!r.ok) return r; p.linkedin = text.trim(); return { ok: true }; }
    case 'github': { const r = url('GitHub'); if (!r.ok) return r; p.github = text.trim(); return { ok: true }; }
    case 'portfolio': { const r = url('portfolio'); if (!r.ok) return r; p.portfolio = text.trim(); return { ok: true }; }

    // Preferences
    case 'roles': {
      const v = list();
      if (!v.length) return { ok: false, error: 'Send at least one target role.' };
      p.targetRoles = v;
      return { ok: true };
    }
    case 'locations': {
      const v = list();
      if (!v.length) return { ok: false, error: 'Send at least one location, or <i>remote</i>.' };
      p.locations = v;
      p.remoteOk = v.some((l) => l.toLowerCase() === 'remote');
      return { ok: true };
    }
    case 'compFloor': {
      const n = num();
      if (!n) return { ok: false, error: 'Send a number — for example <i>120000</i>.' };
      p.compFloor = n;
      return { ok: true };
    }
    case 'compTarget': {
      const n = num();
      if (!n) return { ok: false, error: 'Send a number — for example <i>150000</i>.' };
      if (p.compFloor && n < p.compFloor) return { ok: false, error: `Your target should be at or above your ${money(p.compFloor)} floor.` };
      p.compTarget = n;
      return { ok: true };
    }
    case 'employmentTypes': p.employmentTypes = list(); return { ok: true };
    case 'industries': p.industries = text.toLowerCase() === 'none' ? [] : list(); return { ok: true };
    case 'companySizes': p.companySizes = list(); return { ok: true };
    case 'factors': p.factors = text.toLowerCase() === 'none' ? [] : list(); return { ok: true };
    case 'dealbreakers': p.dealbreakers = text.toLowerCase() === 'none' ? [] : list(); return { ok: true };

    // Eligibility & availability
    case 'workAuthorization': p.workAuthorization = capText(text, 120); return { ok: true };
    case 'needsSponsorship': {
      const v = yesNo();
      if (v === undefined) return { ok: false, error: 'Reply <i>yes</i> or <i>no</i>.' };
      p.needsSponsorship = v;
      return { ok: true };
    }
    case 'willingToRelocate': {
      const v = yesNo();
      if (v === undefined) return { ok: false, error: 'Reply <i>yes</i> or <i>no</i>.' };
      p.willingToRelocate = v;
      return { ok: true };
    }
    case 'noticePeriod': p.noticePeriod = capText(text, 80); return { ok: true };
    case 'availableFrom': p.availableFrom = capText(text, 80); return { ok: true };
  }
}

function validateSetup(step: SetupStep, text: string): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  switch (step) {
    case 'roles': {
      const roles = splitList(text);
      if (!roles.length) return { ok: false, error: 'Send at least one role — for example <i>backend engineer</i>.' };
      return { ok: true, patch: { targetRoles: roles } };
    }
    case 'seniority': {
      // Validated to the same list the edit path enforces. Accepting free text
      // here stored values the scorer cannot read (`SENIORITY_ORDER.indexOf`
      // returns -1), so the level axis silently fell back to "mid" for the
      // rest of the engagement — with the profile still displaying the word
      // the user typed, so nothing looked wrong.
      const t = text.trim().toLowerCase();
      const allowed = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal'];
      const match = allowed.find((a) => a === t) ?? allowed.find((a) => t.includes(a));
      if (!match) return { ok: false, error: `Choose one of: <i>${allowed.join(' · ')}</i>` };
      return { ok: true, patch: { seniority: match } };
    }
    case 'locations': {
      const locations = splitList(text);
      if (!locations.length) return { ok: false, error: 'Send at least one location, or <i>remote</i>.' };
      return { ok: true, patch: { locations, remoteOk: locations.some((l) => l.toLowerCase() === 'remote') } };
    }
    case 'compFloor': {
      const n = Number(text.replace(/[^0-9]/g, ''));
      if (!n) return { ok: false, error: 'Send a number only — for example <i>120000</i>.' };
      return { ok: true, patch: { compFloor: n } };
    }
    case 'skills': {
      const skills = splitList(text);
      if (!skills.length) return { ok: false, error: 'Send at least one skill — these carry the most scoring weight.' };
      return { ok: true, patch: { skills } };
    }
    case 'factors':
      return { ok: true, patch: { factors: text.toLowerCase() === 'none' ? [] : splitList(text) } };
  }
}

/**
 * Best-effort parse of a pasted job posting. Title and company are taken from
 * the first two non-empty lines when not explicitly labelled.
 */
function parsePosting(text: string): { title: string; company: string; description: string; location?: string } | null {
  const labelled = (key: string): string | undefined =>
    text.match(new RegExp(`^\\s*${key}\\s*[:\\-]\\s*(.+)$`, 'im'))?.[1]?.trim();

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2 || text.trim().length < 40) return null;

  const title = labelled('title') ?? labelled('role') ?? labelled('position') ?? lines[0];
  const company = labelled('company') ?? labelled('employer') ?? lines[1];
  const location = labelled('location') ?? labelled('where');
  const description = text.trim();
  if (!title || !company) return null;
  return { title: title.slice(0, 200), company: company.slice(0, 200), description, location };
}

function splitList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

function helpText(): string {
  return [
    title('How Legwork works'),
    '',
    '<b>1 · Profile</b>',
    'You tell me your roles, level, locations, salary floor, skills and priorities — once. It is stored and reused for every hunt.',
    '',
    '<b>2 · Hunt</b>',
    'I scan job boards and score every posting on a 100-point rubric: skills 40, salary 20, location 15, level 15, your priorities 10. Every score is explained.',
    '',
    '<b>3 · Draft</b>',
    'For strong matches I write a tailored résumé and cover letter, using only what is genuinely in your profile.',
    '',
    '<b>4 · Approve</b>',
    'Nothing is submitted without your explicit approval. You see the exact recipient and message before it sends.',
    '',
    RULE,
    '<b>Commands</b>',
    '/hunt · run a hunt now',
    '/profile · view saved details',
    '/edit · update any field',
    '/wallet · link or view your X Layer wallet',
    '/status · engagement and applications',
    '/pause · /resume · control scanning',
  ].join('\n');
}

// ── match card (used by the scheduler too) ─────────────────────────────────

export async function sendMatchCard(bot: Bot, chatId: number, card: MatchCard): Promise<void> {
  const { posting, breakdown, application } = card;
  // Routed through `send` like every other message: the scheduler pushes these
  // unprompted, so a flood-control 429 or an unescapable posting title would
  // otherwise drop a match the user never knew existed.
  await send(
    (text, other) => bot.api.sendMessage(chatId, text, other as never),
    renderMatchCard(posting, breakdown),
    {
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: new InlineKeyboard()
        .text('Approve & apply', `app:approve:${application.id}`)
        .text('View draft', `app:draft:${application.id}`)
        .row()
        .text('Request changes', `app:revise:${application.id}`)
        .text('Skip', `app:skip:${application.id}`),
    },
  );
}

export { meter, scoreVerdict };
