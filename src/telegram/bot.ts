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
import { renderBreakdown, runScanCycle, type MatchCard } from '../pipeline.js';
import { submitApplication } from '../skills/applyExecutor.js';
import { tailorApplication } from '../skills/applicationTailor.js';
import type { Profile } from '../types.js';

/**
 * Telegram is the ONLY user surface. Every screen is a message, card, or
 * inline button in this thread. Engagements begin on the OKX marketplace;
 * the /start <taskcode> deep link binds the buyer to this chat.
 */

// ── onboarding state machine ───────────────────────────────────────────────

const STEPS = ['name', 'roles', 'seniority', 'locations', 'compFloor', 'skills', 'resume', 'email'] as const;
type Step = (typeof STEPS)[number];

const PROMPTS: Record<Step, string> = {
  name: '👋 Welcome to Legwork. Your OKX task is now bound to this thread.\n\nFirst — what name should appear on your applications?',
  roles: 'What roles are you targeting? (comma-separated, e.g. "backend engineer, platform engineer")',
  seniority: 'What seniority level? (junior / mid / senior / staff)',
  locations: 'Which locations work for you? Include "remote" if acceptable. (comma-separated)',
  compFloor: "What's your minimum acceptable annual comp in USD? (number only, e.g. 110000)",
  skills: 'List your key skills. (comma-separated, e.g. "typescript, node.js, postgresql, aws")',
  resume: 'Paste your resume as text (or a detailed experience summary). This is the source of truth — Legwork never invents anything that isn\'t in it.',
  email: 'Finally, what email address should applications come from? (Replies from employers land there.)',
};

function nextStep(step: Step): Step | null {
  const i = STEPS.indexOf(step);
  return i >= 0 && i < STEPS.length - 1 ? STEPS[i + 1] : null;
}

// ── bot ────────────────────────────────────────────────────────────────────

export function createBot(): Bot {
  const bot = new Bot(config.telegram.token);

  bot.command('start', async (ctx) => {
    const userId = String(ctx.from?.id);
    const code = ctx.match?.trim();
    if (!code) {
      await ctx.reply(
        'Legwork runs engagements purchased on the OKX AI marketplace.\n' +
        'Hire "Legwork — Job Search Sprint" there and open the deep link OKX gives you to begin.',
      );
      return;
    }
    const engagement = getEngagementByCode(code);
    if (!engagement) {
      await ctx.reply('That code is not valid or has expired. Check the link OKX sent in your task chat.');
      return;
    }
    if (engagement.userId && engagement.userId !== userId) {
      await ctx.reply('This engagement is already bound to another Telegram account.');
      return;
    }
    engagement.userId = userId;
    engagement.status = getProfile(userId) ? 'active' : 'onboarding';
    saveEngagement(engagement);
    audit('telegram', 'ENGAGEMENT_BOUND', `job=${engagement.okxJobId} user=${userId}`);

    if (getProfile(userId)) {
      await ctx.reply('✅ Engagement linked. Your existing profile is loaded — scanning starts on the next cycle. Use /scan to run one now, /profile to review.');
    } else {
      setOnboarding(userId, 'name', {});
      await ctx.reply(PROMPTS.name);
    }
  });

  bot.command('help', (ctx) =>
    ctx.reply(
      'Commands:\n' +
      '/profile — view your profile\n/rubric — score threshold & daily cap\n' +
      '/scan — run a scan cycle now\n/status — engagement & application status\n' +
      '/digest — on-demand digest\n/pause /resume — pause or resume scanning\n' +
      '/revoke — kill email access & pause everything\n/help — this message',
    ),
  );

  bot.command('profile', async (ctx) => {
    const p = getProfile(String(ctx.from?.id));
    if (!p) return void (await ctx.reply('No profile yet — open your OKX engagement link to onboard.'));
    await ctx.reply(
      `👤 ${p.name} <${p.email ?? 'no email'}>\n` +
      `Roles: ${p.targetRoles.join(', ')}\nSeniority: ${p.seniority}\n` +
      `Locations: ${p.locations.join(', ')} (remote ${p.remoteOk ? 'ok' : 'no'})\n` +
      `Comp floor: $${p.compFloor.toLocaleString()}\nSkills: ${p.skills.join(', ')}\n` +
      `Threshold: ${p.threshold}  •  Daily cap: ${p.dailyCap}`,
    );
  });

  bot.command('rubric', async (ctx) => {
    const userId = String(ctx.from?.id);
    const p = getProfile(userId);
    if (!p) return void (await ctx.reply('No profile yet.'));
    const arg = ctx.match?.trim();
    const m = arg?.match(/^(threshold|cap)\s+(\d+)$/i);
    if (m) {
      if (m[1].toLowerCase() === 'threshold') p.threshold = Math.min(100, Math.max(0, Number(m[2])));
      else p.dailyCap = Math.min(20, Math.max(1, Number(m[2])));
      saveProfile(p);
      await ctx.reply(`✅ Updated. Threshold ${p.threshold}, daily cap ${p.dailyCap}.`);
    } else {
      await ctx.reply(
        `Rubric: skills 40 / comp 20 / location 15 / seniority 15 / culture 10.\n` +
        `Threshold: ${p.threshold} — daily cap: ${p.dailyCap}\n\n` +
        'Adjust with: /rubric threshold 75  or  /rubric cap 5',
      );
    }
  });

  bot.command('pause', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await ctx.reply('No active engagement.'));
    e.status = 'paused';
    saveEngagement(e);
    await ctx.reply('⏸ Paused. No scans or cards until /resume.');
  });

  bot.command('resume', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await ctx.reply('No active engagement.'));
    e.status = 'active';
    saveEngagement(e);
    await ctx.reply('▶️ Resumed. Next scan will run on schedule (or /scan now).');
  });

  bot.command('revoke', async (ctx) => {
    const userId = String(ctx.from?.id);
    const e = getEngagementByUser(userId);
    if (e) {
      e.status = 'paused';
      saveEngagement(e);
    }
    audit('telegram', 'REVOKED', `user=${userId}`);
    await ctx.reply(
      '🛑 Engagement paused. To fully revoke Gmail access, remove Legwork at ' +
      'https://myaccount.google.com/connections — tokens stop working immediately.',
    );
  });

  bot.command('status', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await ctx.reply('No active engagement. Hire Legwork on the OKX marketplace to start.'));
    await ctx.reply(`Engagement ${e.okxJobId} — ${e.status}\nEnds: ${e.endsAt?.slice(0, 10) ?? 'open'}\n\n${buildDigest(e)}`);
  });

  bot.command('digest', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e) return void (await ctx.reply('No active engagement.'));
    await ctx.reply(buildDigest(e));
  });

  bot.command('scan', async (ctx) => {
    const e = getEngagementByUser(String(ctx.from?.id));
    if (!e || e.status !== 'active') return void (await ctx.reply('No active engagement (is it paused?).'));
    await ctx.reply('🔍 Scanning sources…');
    try {
      const summary = await runScanCycle(e);
      for (const card of summary.cards) await sendMatchCard(bot, Number(e.userId), card);
      await ctx.reply(
        `Scan done: ${summary.found} postings found, ${summary.cards.length} match cards sent, ` +
        `${summary.scoredBelowThreshold} below your threshold.` +
        (summary.cappedOut ? ' Daily cap reached.' : '') +
        (summary.sourceErrors.length ? `\n⚠️ Source errors: ${summary.sourceErrors.join('; ')}` : ''),
      );
    } catch (err) {
      // Every background failure that blocks the user becomes a message.
      await ctx.reply(`❌ Scan failed: ${String(err)}`);
    }
  });

  // ── inline button callbacks (idempotent) ─────────────────────────────────

  bot.on('callback_query:data', async (ctx) => {
    const [action, appId, extra] = ctx.callbackQuery.data.split(':');
    const app = getApplication(appId);
    if (!app) return void (await ctx.answerCallbackQuery({ text: 'Not found (stale card?)' }));
    const posting = getPosting(app.postingId);
    const profile = getProfile(app.userId);
    if (!posting || !profile) return void (await ctx.answerCallbackQuery({ text: 'Missing data' }));

    switch (action) {
      case 'approve': {
        if (app.status !== 'pending_approval') {
          return void (await ctx.answerCallbackQuery({ text: `Already ${app.status}.` })); // double-tap guard
        }
        const draft = app.draftId ? getDraft(app.draftId) : undefined;
        if (!draft) return void (await ctx.answerCallbackQuery({ text: 'Draft missing' }));
        app.status = 'approved';
        app.approvalAt = now();
        updateApplication(app);
        audit('telegram', 'APPROVED', `app=${app.id} by user=${app.userId}`);
        await ctx.answerCallbackQuery({ text: 'Approved' });
        // Show the EXACT content before it fires — final send is one more tap.
        await ctx.reply(
          `📧 Final review — this exact email will be sent:\n\nSubject: ${draft.emailSubject}\n\n${draft.emailBody.slice(0, 2500)}`,
          { reply_markup: new InlineKeyboard().text('🚀 Send now', `send:${app.id}`).text('↩️ Cancel', `cancel:${app.id}`) },
        );
        break;
      }
      case 'send': {
        if (app.status === 'submitted') return void (await ctx.answerCallbackQuery({ text: 'Already sent.' }));
        if (app.status !== 'approved') return void (await ctx.answerCallbackQuery({ text: `Cannot send (${app.status})` }));
        await ctx.answerCallbackQuery({ text: 'Sending…' });
        const result = await submitApplication(app, profile, posting);
        await ctx.reply(
          result.ok
            ? `✅ Submitted: ${posting.title} @ ${posting.company}\n${result.receipt}`
            : `❌ Submission failed: ${result.error}`,
          result.ok ? undefined : { reply_markup: new InlineKeyboard().text('🔁 Retry', `send:${app.id}`) },
        );
        break;
      }
      case 'cancel': {
        if (app.status === 'approved') {
          app.status = 'pending_approval';
          app.approvalAt = undefined;
          updateApplication(app);
        }
        await ctx.answerCallbackQuery({ text: 'Cancelled — back to pending.' });
        break;
      }
      case 'draft': {
        const draft = app.draftId ? getDraft(app.draftId) : undefined;
        if (!draft) return void (await ctx.answerCallbackQuery({ text: 'Draft missing' }));
        await ctx.answerCallbackQuery();
        await ctx.reply(`📄 Tailored resume (v${draft.version}):\n\n${draft.resumeText.slice(0, 3000)}`);
        await ctx.reply(`✉️ Cover letter:\n\n${draft.coverLetter.slice(0, 3000)}`);
        break;
      }
      case 'change': {
        await ctx.answerCallbackQuery();
        setOnboarding(app.userId, `feedback:${app.id}`, {});
        await ctx.reply('✏️ What should change in the draft? Reply with your notes and I\'ll regenerate.');
        break;
      }
      case 'skip': {
        if (app.status !== 'pending_approval') {
          return void (await ctx.answerCallbackQuery({ text: `Already ${app.status}.` }));
        }
        if (!extra) {
          await ctx.answerCallbackQuery();
          await ctx.reply('Why skip? (feeds rubric tuning)', {
            reply_markup: new InlineKeyboard()
              .text('Comp', `skip:${app.id}:comp`).text('Location', `skip:${app.id}:location`).row()
              .text('Role fit', `skip:${app.id}:rolefit`).text('Company', `skip:${app.id}:company`).text('Other', `skip:${app.id}:other`),
          });
        } else {
          app.status = 'skipped';
          app.skipReason = extra;
          updateApplication(app);
          audit('telegram', 'SKIPPED', `app=${app.id} reason=${extra}`);
          await ctx.answerCallbackQuery({ text: 'Skipped' });
          await ctx.reply(`⏭ Skipped ${posting.title} @ ${posting.company} (${extra}).`);
        }
        break;
      }
      default:
        await ctx.answerCallbackQuery();
    }
  });

  // ── free-text messages: onboarding + draft feedback ──────────────────────

  bot.on('message:text', async (ctx) => {
    const userId = String(ctx.from.id);
    const state = getOnboarding(userId);
    if (!state) return; // not in a flow — ignore chatter

    // Draft revision loop
    if (state.step.startsWith('feedback:')) {
      const appId = state.step.slice('feedback:'.length);
      clearOnboarding(userId);
      const app = getApplication(appId);
      const posting = app && getPosting(app.postingId);
      const profile = getProfile(userId);
      if (!app || !posting || !profile) return void (await ctx.reply('Could not find that application anymore.'));
      await ctx.reply('Regenerating draft with your notes…');
      const draft = await tailorApplication(profile, posting, ctx.message.text);
      app.draftId = draft.id;
      updateApplication(app);
      await sendMatchCard(bot, ctx.from.id, { application: app, posting, draft, breakdown: app.breakdown });
      return;
    }

    // Onboarding steps
    const step = state.step as Step;
    const partial = state.partial;
    const text = ctx.message.text.trim();
    switch (step) {
      case 'name': partial.name = text; break;
      case 'roles': partial.targetRoles = splitList(text); break;
      case 'seniority': partial.seniority = text.toLowerCase(); break;
      case 'locations': {
        const locs = splitList(text);
        partial.locations = locs;
        partial.remoteOk = locs.some((l) => l.toLowerCase() === 'remote');
        break;
      }
      case 'compFloor': {
        const n = Number(text.replace(/[^0-9]/g, ''));
        if (!n) return void (await ctx.reply('Please send a number, e.g. 110000'));
        partial.compFloor = n;
        break;
      }
      case 'skills': partial.skills = splitList(text); break;
      case 'resume': partial.resumeText = text; break;
      case 'email': partial.email = text; break;
    }

    const next = nextStep(step);
    if (next) {
      setOnboarding(userId, next, partial);
      await ctx.reply(PROMPTS[next]);
      return;
    }

    // Done — persist profile, activate engagement, confirm back (editable).
    const profile: Profile = {
      userId,
      name: String(partial.name ?? ''),
      targetRoles: (partial.targetRoles as string[]) ?? [],
      seniority: String(partial.seniority ?? 'mid'),
      locations: (partial.locations as string[]) ?? [],
      remoteOk: Boolean(partial.remoteOk),
      compFloor: Number(partial.compFloor ?? 0),
      skills: (partial.skills as string[]) ?? [],
      resumeText: String(partial.resumeText ?? ''),
      dealbreakers: [],
      threshold: 70,
      dailyCap: 5,
      email: String(partial.email ?? ''),
    };
    saveProfile(profile);
    clearOnboarding(userId);
    const e = getEngagementByUser(userId);
    if (e) {
      e.status = 'active';
      saveEngagement(e);
    }
    audit('telegram', 'ONBOARDED', `user=${userId}`);
    await ctx.reply(
      `✅ Profile saved:\n\n${profile.name} <${profile.email}>\nRoles: ${profile.targetRoles.join(', ')}\n` +
      `Seniority: ${profile.seniority}\nLocations: ${profile.locations.join(', ')}\n` +
      `Comp floor: $${profile.compFloor.toLocaleString()}\nSkills: ${profile.skills.join(', ')}\n\n` +
      `Score threshold ${profile.threshold}, daily cap ${profile.dailyCap} (adjust via /rubric).\n` +
      `Scanning is live — run /scan to pull matches right now.`,
    );
  });

  bot.catch((err) => console.error('[telegram] error:', err));
  return bot;
}

function splitList(text: string): string[] {
  return text.split(',').map((s) => s.trim()).filter(Boolean);
}

// ── the match card (core screen) ───────────────────────────────────────────

export async function sendMatchCard(bot: Bot, chatId: number, card: MatchCard): Promise<void> {
  const { posting, breakdown, application } = card;
  const comp =
    posting.compMin || posting.compMax
      ? `$${(posting.compMin ?? 0).toLocaleString()}–$${(posting.compMax ?? 0).toLocaleString()}`
      : 'not listed';
  const text =
    `🎯 Match ${breakdown.total}/100 — ${posting.title}\n` +
    `🏢 ${posting.company} • ${posting.location}${posting.remote ? ' • remote' : ''}\n` +
    `💰 ${comp} • ATS: ${posting.atsHint}\n` +
    `🔗 ${posting.url}\n\n` +
    `${renderBreakdown(breakdown)}\n\n` +
    `A tailored resume + cover letter are drafted and waiting for your call.`;
  await bot.api.sendMessage(chatId, text, {
    reply_markup: new InlineKeyboard()
      .text('✅ Approve & apply', `approve:${application.id}`)
      .text('📝 View draft', `draft:${application.id}`)
      .row()
      .text('✏️ Request changes', `change:${application.id}`)
      .text('⏭ Skip', `skip:${application.id}`),
  });
}
