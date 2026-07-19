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
  now,
  saveEngagement,
  saveProfile,
  setOnboarding,
  updateApplication,
} from '../db.js';
import { buildDigest } from '../digest.js';
import { runScanCycle, type MatchCard } from '../pipeline.js';
import { resolveSubmissionTarget, submitApplication } from '../skills/applyExecutor.js';
import { tailorApplication } from '../skills/applicationTailor.js';
import { chunkMessage, formatShortlist, runHunt } from '../skills/jobHunt.js';
import {
  PROFILE_FIELDS,
  RULE,
  atsLabel,
  esc,
  isEvmAddress,
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
  if (!profile) {
    kb.text('Set up profile', 'setup:start').row();
  } else {
    if (engagement && engagement.status === 'active') kb.text('Run job hunt', 'hunt:run').row();
    kb.text('My profile', 'profile:view').text('Edit profile', 'profile:edit').row();
  }
  kb.text(profile?.wallet ? 'Wallet' : 'Link wallet', 'wallet:view');
  if (engagement) kb.text('Status', 'nav:status');
  kb.row().text('Help', 'nav:help');
  return kb;
}

function profileEditKeyboard(): InlineKeyboard {
  const fields: ProfileField[] = ['roles', 'seniority', 'locations', 'compFloor', 'skills', 'factors', 'name', 'email', 'resume', 'wallet'];
  const kb = new InlineKeyboard();
  fields.forEach((f, i) => {
    kb.text(PROFILE_FIELDS[f], `edit:${f}`);
    if (i % 2 === 1) kb.row();
  });
  return kb.row().text('‹ Back', 'nav:home');
}

function backHome(): InlineKeyboard {
  return new InlineKeyboard().text('‹ Back to menu', 'nav:home');
}

// ── bot ────────────────────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(config.telegram.token);

  // Command list shown in Telegram's UI menu.
  void bot.api
    .setMyCommands([
      { command: 'start', description: 'Home — status and actions' },
      { command: 'hunt', description: 'Run a job hunt now' },
      { command: 'profile', description: 'View your saved profile' },
      { command: 'edit', description: 'Update a profile field' },
      { command: 'wallet', description: 'Link or view your X Layer wallet' },
      { command: 'status', description: 'Engagement and application status' },
      { command: 'digest', description: 'Summary of applications and matches' },
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
        await ctx.reply(
          `${title('Link not recognised')}\n\nThat code is not valid or has expired. Open the link from your OKX task chat, or start a new engagement on the marketplace.`,
          HTML,
        );
        return;
      }
      if (['settled', 'disputed'].includes(bound.status) || (bound.endsAt && new Date(bound.endsAt) < new Date())) {
        await ctx.reply(
          `${title('Engagement closed')}\n\nThis engagement has ended. Hire Legwork again on the OKX marketplace to start a new one.`,
          HTML,
        );
        return;
      }
      if (bound.userId && bound.userId !== userId) {
        await ctx.reply(`${title('Already linked')}\n\nThis engagement is bound to a different Telegram account.`, HTML);
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
    await ctx.reply(
      renderWelcome({
        firstName: ctx.from?.first_name ?? 'there',
        profile,
        engagement,
        agentId: config.okx.agentId,
        returning: Boolean(profile),
      }),
      { ...HTML, reply_markup: mainMenu(profile, engagement) },
    );

    if (!profile) {
      setOnboarding(userId, 'roles', {});
      await ctx.reply(askSetup('roles'), HTML);
    }
  });

  // ── informational commands ───────────────────────────────────────────────

  bot.command('help', (ctx) => ctx.reply(helpText(), { ...HTML, reply_markup: backHome() }));

  bot.command('profile', async (ctx) => {
    const p = getProfile(String(ctx.from?.id));
    if (!p) return void (await promptSetup(ctx));
    await ctx.reply(renderProfile(p), { ...HTML, reply_markup: new InlineKeyboard().text('Edit profile', 'profile:edit').text('‹ Back', 'nav:home') });
  });

  bot.command('edit', async (ctx) => {
    const p = getProfile(String(ctx.from?.id));
    if (!p) return void (await promptSetup(ctx));
    await ctx.reply(`${title('Edit profile', 'Choose a field to update')}`, { ...HTML, reply_markup: profileEditKeyboard() });
  });

  bot.command('wallet', async (ctx) => showWallet(ctx, String(ctx.from?.id)));

  bot.command('status', async (ctx) => {
    const userId = String(ctx.from?.id);
    const e = getEngagementByUser(userId);
    const p = getProfile(userId);
    if (!e) {
      return void (await ctx.reply(
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
    await ctx.reply(lines.join('\n'), { ...HTML, reply_markup: backHome() });
  });

  bot.command('digest', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await ctx.reply(`${title('No active engagement')}\n\nNothing to summarise yet.`, HTML));
    await ctx.reply(`${title('Digest')}\n\n${esc(buildDigest(e))}`, { ...HTML, reply_markup: backHome() });
  });

  bot.command('pause', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await ctx.reply(`${title('No active engagement')}`, HTML));
    e.status = 'paused';
    saveEngagement(e);
    await ctx.reply(`${title('Paused')}\n\nScanning is on hold. Your profile and history are untouched — use /resume when ready.`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Resume', 'nav:resume'),
    });
  });

  bot.command('resume', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await ctx.reply(`${title('No active engagement')}`, HTML));
    e.status = 'active';
    saveEngagement(e);
    await ctx.reply(`${title('Resumed')}\n\nScanning is live again.`, { ...HTML, reply_markup: mainMenu(getProfile(String(ctx.from?.id)), e) });
  });

  bot.command('hunt', async (ctx) => runHuntFlow(ctx, String(ctx.from?.id)));
  bot.command('scan', async (ctx) => runHuntFlow(ctx, String(ctx.from?.id)));

  // ── callbacks ────────────────────────────────────────────────────────────

  bot.on('callback_query:data', async (ctx) => {
    const userId = String(ctx.from.id);
    const [ns, action, extra] = ctx.callbackQuery.data.split(':');

    // Navigation and profile management
    if (ns === 'nav') {
      await ctx.answerCallbackQuery();
      const p = getProfile(userId);
      const e = getEngagementByUser(userId);
      if (action === 'home') {
        return void (await ctx.reply(
          renderWelcome({ firstName: ctx.from.first_name ?? 'there', profile: p, engagement: e, agentId: config.okx.agentId, returning: true }),
          { ...HTML, reply_markup: mainMenu(p, e) },
        ));
      }
      if (action === 'help') return void (await ctx.reply(helpText(), { ...HTML, reply_markup: backHome() }));
      if (action === 'status') {
        if (!e) return void (await ctx.reply(`${title('No active engagement')}`, HTML));
        return void (await ctx.reply(`${title('Engagement status')}\n\n${esc(buildDigest(e))}`, { ...HTML, reply_markup: backHome() }));
      }
      if (action === 'resume' && e) {
        e.status = 'active';
        saveEngagement(e);
        return void (await ctx.reply(`${title('Resumed')}\n\nScanning is live again.`, { ...HTML, reply_markup: mainMenu(p, e) }));
      }
      return;
    }

    if (ns === 'setup') {
      await ctx.answerCallbackQuery();
      setOnboarding(userId, 'roles', {});
      return void (await ctx.reply(askSetup('roles'), HTML));
    }

    if (ns === 'profile') {
      await ctx.answerCallbackQuery();
      const p = getProfile(userId);
      if (!p) return void (await promptSetup(ctx));
      if (action === 'view') {
        return void (await ctx.reply(renderProfile(p), {
          ...HTML,
          reply_markup: new InlineKeyboard().text('Edit profile', 'profile:edit').text('‹ Back', 'nav:home'),
        }));
      }
      if (action === 'edit') {
        return void (await ctx.reply(title('Edit profile', 'Choose a field to update'), { ...HTML, reply_markup: profileEditKeyboard() }));
      }
      return;
    }

    if (ns === 'edit') {
      await ctx.answerCallbackQuery();
      const field = action as ProfileField;
      if (!(field in PROFILE_FIELDS)) return;
      setOnboarding(userId, `edit:${field}`, {});
      const p = getProfile(userId);
      const current = p ? currentValue(p, field) : '—';
      return void (await ctx.reply(
        `${title(`Update ${PROFILE_FIELDS[field].toLowerCase()}`)}\n\n<b>Current</b>\n${esc(current)}\n\nSend the new value.${
          field === 'wallet' ? '\n<i>Your X Layer address, starting 0x.</i>' : ''
        }`,
        { ...HTML, reply_markup: new InlineKeyboard().text('Cancel', 'edit:cancel') },
      ));
    }

    if (ns === 'wallet') {
      await ctx.answerCallbackQuery();
      if (action === 'link') {
        setOnboarding(userId, 'edit:wallet', {});
        return void (await ctx.reply(walletPrompt(), { ...HTML, reply_markup: new InlineKeyboard().text('Cancel', 'edit:cancel') }));
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
          await ctx.reply(
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
          await ctx.reply(
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
          await ctx.reply(`${title('Tailored résumé', `Version ${draft.version}`)}\n\n${esc(draft.resumeText.slice(0, 3000))}`, HTML);
          await ctx.reply(`${title('Cover letter')}\n\n${esc(draft.coverLetter.slice(0, 3000))}`, HTML);
          break;
        }
        case 'revise': {
          if (app.status !== 'pending_approval') return void (await ctx.answerCallbackQuery({ text: `Locked (${app.status}).` }));
          await ctx.answerCallbackQuery();
          setOnboarding(app.userId, `feedback:${app.id}`, {});
          await ctx.reply(`${title('Request changes')}\n\nTell me what to change and I will redraft it.`, HTML);
          break;
        }
        case 'skip': {
          if (app.status !== 'pending_approval') return void (await ctx.answerCallbackQuery({ text: `Already ${app.status}.` }));
          if (!extra) return;
          await ctx.answerCallbackQuery();
          await ctx.reply(`${title('Skip this role')}\n\nWhy? This tunes future scoring.`, {
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
      await ctx.reply(`${title('Skipped')}\n\nNoted — I will weight <i>${esc(reason)}</i> more heavily going forward.`, HTML);
      return;
    }

    await ctx.answerCallbackQuery();
  });

  // ── free text: setup, edits, draft feedback ──────────────────────────────

  bot.on('message:text', async (ctx) => {
    const userId = String(ctx.from.id);
    const state = getOnboarding(userId);
    if (!state) return;
    const text = ctx.message.text.trim();

    // Draft revision
    if (state.step.startsWith('feedback:')) {
      const appId = state.step.slice('feedback:'.length);
      clearOnboarding(userId);
      const app = getApplication(appId);
      const posting = app && getPosting(app.postingId);
      const profile = getProfile(userId);
      if (!app || !posting || !profile) return void (await ctx.reply('That application is no longer available.'));
      if (app.status !== 'pending_approval') return void (await ctx.reply(`This draft is locked — the application is ${app.status}.`));
      await ctx.reply(`${title('Redrafting')}\n\nApplying your notes…`, HTML);
      const draft = await tailorApplication(profile, posting, text);
      app.draftId = draft.id;
      updateApplication(app);
      await sendMatchCard(bot, ctx.from.id, { application: app, posting, draft, breakdown: app.breakdown });
      return;
    }

    // Single-field edit
    if (state.step.startsWith('edit:')) {
      const field = state.step.slice('edit:'.length) as ProfileField;
      const profile = getProfile(userId);
      if (!profile) {
        clearOnboarding(userId);
        return void (await promptSetup(ctx));
      }
      const applied = applyField(profile, field, text);
      if (!applied.ok) return void (await ctx.reply(`${title('Invalid value')}\n\n${applied.error}`, HTML));
      profile.updatedAt = now();
      saveProfile(profile);
      clearOnboarding(userId);
      audit('telegram', 'PROFILE_UPDATED', `user=${userId} field=${field}`);
      const confirmation =
        field === 'wallet'
          ? `${title('Wallet linked')}\n\n<code>${esc(profile.wallet ?? '')}</code>\n\nThis address is saved to your profile.`
          : `${title('Updated')}\n\n<b>${PROFILE_FIELDS[field]}</b>\n${esc(currentValue(profile, field))}`;
      await ctx.reply(confirmation, { ...HTML, reply_markup: new InlineKeyboard().text('Edit another', 'profile:edit').text('‹ Menu', 'nav:home') });
      return;
    }

    // Guided setup
    const step = state.step as SetupStep;
    if (!SETUP_STEPS.includes(step)) return;
    const partial = state.partial;
    const validated = validateSetup(step, text);
    if (!validated.ok) return void (await ctx.reply(`${title('Let me try that again')}\n\n${validated.error}`, HTML));
    Object.assign(partial, validated.patch);

    const next = SETUP_STEPS[SETUP_STEPS.indexOf(step) + 1];
    if (next) {
      setOnboarding(userId, next, partial);
      return void (await ctx.reply(askSetup(next), HTML));
    }

    // Complete — persist and offer wallet linking.
    const existing = getProfile(userId);
    const profile: Profile = {
      userId,
      name: existing?.name ?? ctx.from.first_name ?? 'Candidate',
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

    await ctx.reply(
      `${renderProfile(profile)}\n\n${RULE}\nSaved. You will not be asked for this again — use <b>Edit profile</b> any time.`,
      {
        ...HTML,
        reply_markup: profile.wallet
          ? new InlineKeyboard().text('Run job hunt', 'hunt:run').row().text('Edit profile', 'profile:edit').text('‹ Menu', 'nav:home')
          : new InlineKeyboard().text('Link X Layer wallet', 'wallet:link').row().text('Run job hunt', 'hunt:run').text('‹ Menu', 'nav:home'),
      },
    );
  });

  bot.catch((err) => console.error('[telegram] error:', err));
  return bot;
}

// ── helpers ────────────────────────────────────────────────────────────────

type Ctx = { reply: (text: string, other?: Record<string, unknown>) => Promise<unknown> };

async function promptSetup(ctx: Ctx): Promise<void> {
  await ctx.reply(
    `${title('No profile yet')}\n\nSet up your profile and I will start matching roles against it.`,
    { ...HTML, reply_markup: new InlineKeyboard().text('Set up profile', 'setup:start') },
  );
}

function walletPrompt(): string {
  return (
    `${title('Link your X Layer wallet')}\n\n` +
    'Send your <b>X Layer address</b> — it begins with <code>0x</code> and is 42 characters long.\n\n' +
    'Used to identify you across OKX engagements and to settle payments. ' +
    '<b>Never send a private key or seed phrase</b> — an address alone is all I need, and it is safe to share.'
  );
}

async function showWallet(ctx: Ctx & { from?: { id: number } }, userId: string): Promise<void> {
  const p = getProfile(userId);
  if (!p?.wallet) {
    return void (await ctx.reply(walletPrompt(), {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Link wallet', 'wallet:link').text('‹ Back', 'nav:home'),
    }));
  }
  await ctx.reply(
    `${title('X Layer wallet', 'Connected')}\n\n<code>${esc(p.wallet)}</code>\n\n<b>Network</b> · X Layer (chain 196)\n<b>Linked</b> · ${
      p.updatedAt?.slice(0, 10) ?? '—'
    }`,
    { ...HTML, reply_markup: new InlineKeyboard().text('Change wallet', 'edit:wallet').text('‹ Back', 'nav:home') },
  );
}

async function runHuntFlow(ctx: Ctx, userId: string): Promise<void> {
  const profile = getProfile(userId);
  if (!profile) return void (await promptSetup(ctx));
  const engagement = getEngagementByUser(userId);
  if (!engagement) {
    return void (await ctx.reply(
      `${title('No active engagement')}\n\nHire Legwork on the OKX marketplace to run a hunt. Your profile is saved and ready.`,
      { ...HTML, reply_markup: backHome() },
    ));
  }
  if (engagement.status === 'paused') {
    return void (await ctx.reply(`${title('Engagement paused')}\n\nUse /resume to continue scanning.`, {
      ...HTML,
      reply_markup: new InlineKeyboard().text('Resume', 'nav:resume'),
    }));
  }

  const c = profileCompleteness(profile);
  if (c.missing.length) {
    return void (await ctx.reply(
      `${title('Profile incomplete')}\n\nStill needed: <b>${esc(c.missing.join(', '))}</b>`,
      { ...HTML, reply_markup: new InlineKeyboard().text('Complete profile', 'profile:edit') },
    ));
  }

  await ctx.reply(`${title('Hunting', 'Scanning sources and scoring against your profile')}`, HTML);

  if (engagement.listing.startsWith('job-hunt')) {
    const result = await runHunt(engagement);
    if (result.sourceErrors.length) {
      await ctx.reply(`${title('Partial results')}\n\nSome sources were unavailable: ${esc(result.sourceErrors.join('; '))}`, HTML);
    }
    if (!result.matches.length) {
      return void (await ctx.reply(
        `${title('No new matches')}\n\nEverything currently listed has already been shown to you. I will keep scanning and message you when something new appears.`,
        { ...HTML, reply_markup: backHome() },
      ));
    }
    for (const chunk of chunkMessage(formatShortlist(profile, result.matches, result.found))) {
      await ctx.reply(chunk, { link_preview_options: { is_disabled: true } });
    }
    return void (await ctx.reply(
      `${title('Hunt complete')}\n\n<b>${result.matches.length}</b> matches from <b>${result.found}</b> postings scanned.`,
      { ...HTML, reply_markup: backHome() },
    ));
  }

  // Full-loop engagements produce individual approval cards.
  const summary = await runScanCycle(engagement);
  await ctx.reply(
    `${title('Hunt complete')}\n\n<b>${summary.found}</b> postings scanned · <b>${summary.cards.length}</b> above your threshold · <b>${summary.scoredBelowThreshold}</b> below${
      summary.cappedOut ? '\n\nDaily limit reached.' : ''
    }`,
    HTML,
  );
}

function currentValue(p: Profile, field: ProfileField): string {
  switch (field) {
    case 'name': return p.name || '—';
    case 'roles': return p.targetRoles.join(', ') || '—';
    case 'seniority': return p.seniority || '—';
    case 'locations': return p.locations.join(', ') || '—';
    case 'compFloor': return p.compFloor ? money(p.compFloor) : '—';
    case 'skills': return p.skills.join(', ') || '—';
    case 'factors': return (p.factors ?? []).join(', ') || '—';
    case 'email': return p.email || '—';
    case 'resume': return p.resumeText ? `${p.resumeText.length} characters on file` : '—';
    case 'wallet': return p.wallet || '— not linked';
  }
}

function applyField(p: Profile, field: ProfileField, text: string): { ok: true } | { ok: false; error: string } {
  switch (field) {
    case 'name': p.name = text; return { ok: true };
    case 'roles': p.targetRoles = splitList(text); return { ok: true };
    case 'seniority': p.seniority = text.toLowerCase(); return { ok: true };
    case 'locations': {
      p.locations = splitList(text);
      p.remoteOk = p.locations.some((l) => l.toLowerCase() === 'remote');
      return { ok: true };
    }
    case 'compFloor': {
      const n = Number(text.replace(/[^0-9]/g, ''));
      if (!n) return { ok: false, error: 'Send a number — for example <i>120000</i>.' };
      p.compFloor = n;
      return { ok: true };
    }
    case 'skills': p.skills = splitList(text); return { ok: true };
    case 'factors': p.factors = text.toLowerCase() === 'none' ? [] : splitList(text); return { ok: true };
    case 'email': {
      if (!/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(text)) return { ok: false, error: 'That does not look like an email address.' };
      p.email = text;
      return { ok: true };
    }
    case 'resume': p.resumeText = text; return { ok: true };
    case 'wallet': {
      if (/^(0x)?[a-fA-F0-9]{64}$/.test(text.trim()) || /\b(seed|mnemonic|private key)\b/i.test(text)) {
        return { ok: false, error: '⚠️ That looks like a private key or seed phrase — <b>never share it with anyone, including me</b>. Send your public address instead (0x…, 42 characters).' };
      }
      if (!isEvmAddress(text)) return { ok: false, error: 'Send a valid X Layer address — <code>0x</code> followed by 40 hex characters.' };
      p.wallet = text.trim();
      return { ok: true };
    }
  }
}

function validateSetup(step: SetupStep, text: string): { ok: true; patch: Record<string, unknown> } | { ok: false; error: string } {
  switch (step) {
    case 'roles': {
      const roles = splitList(text);
      if (!roles.length) return { ok: false, error: 'Send at least one role — for example <i>backend engineer</i>.' };
      return { ok: true, patch: { targetRoles: roles } };
    }
    case 'seniority': return { ok: true, patch: { seniority: text.toLowerCase() } };
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
  await bot.api.sendMessage(chatId, renderMatchCard(posting, breakdown), {
    parse_mode: 'HTML',
    link_preview_options: { is_disabled: true },
    reply_markup: new InlineKeyboard()
      .text('Approve & apply', `app:approve:${application.id}`)
      .text('View draft', `app:draft:${application.id}`)
      .row()
      .text('Request changes', `app:revise:${application.id}`)
      .text('Skip', `app:skip:${application.id}`),
  });
}

export { meter, scoreVerdict };
