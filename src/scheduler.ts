import cron from 'node-cron';
import type { Bot } from 'grammy';
import { getProfile, listEngagements, saveEngagement } from './db.js';
import { runScanCycle } from './pipeline.js';
import { sendMatchCard } from './telegram/bot.js';
import { buildDigest } from './digest.js';
import { deliverEngagementOnChain } from './okx/server.js';
import { chunkMessage, formatShortlist, runHunt } from './skills/jobHunt.js';

/**
 * Background cadence:
 *  - every 6h: scan cycle per active engagement → match cards to Telegram
 *  - Mondays 09:00: weekly digest per active engagement
 *  - hourly: expire engagements past endsAt → deliver through OKX
 */
export function startScheduler(bot: Bot | null): void {
  cron.schedule('0 */6 * * *', async () => {
    for (const e of listEngagements('active')) {
      try {
        // Hunt listings: fresh shortlist of new matches (deduped per user) —
        // no drafts, no application cards.
        if (e.listing.startsWith('job-hunt')) {
          const result = await runHunt(e);
          if (bot && e.userId && result.matches.length) {
            const profile = getProfile(e.userId)!;
            for (const chunk of chunkMessage(formatShortlist(profile, result.matches, result.found))) {
              await bot.api.sendMessage(Number(e.userId), chunk).catch(() => {});
            }
          }
          continue;
        }
        const summary = await runScanCycle(e);
        if (bot && e.userId) {
          for (const card of summary.cards) await sendMatchCard(bot, Number(e.userId), card);
          if (summary.sourceErrors.length) {
            await bot.api.sendMessage(Number(e.userId), `⚠️ Some job sources failed this cycle: ${summary.sourceErrors.join('; ')}`);
          }
        }
      } catch (err) {
        console.error(`[scheduler] scan failed for ${e.id}:`, err);
        if (bot && e.userId) {
          await bot.api.sendMessage(Number(e.userId), `❌ Scheduled scan failed: ${String(err)}. Will retry next cycle.`).catch(() => {});
        }
      }
    }
  });

  cron.schedule('0 9 * * 1', async () => {
    for (const e of listEngagements('active')) {
      if (bot && e.userId) await bot.api.sendMessage(Number(e.userId), buildDigest(e)).catch(() => {});
    }
  });

  cron.schedule('0 * * * *', async () => {
    // `delivering` is included deliberately. A failed delivery leaves the
    // engagement in that status, and sweeping only `active` meant the retry
    // this code promised the user could never actually happen — the engagement
    // was stranded mid-delivery for good. Anything already confirmed reaching
    // the buyer is skipped, so a success is never re-sent.
    const due = [...listEngagements('active'), ...listEngagements('delivering')].filter(
      (e) => e.endsAt && new Date(e.endsAt) < new Date() && !e.deliverableSentAt,
    );

    for (const e of due) {
      // Deliver to the buyer, not just locally: an engagement that "completes"
      // without a `deliver` transaction still hits the marketplace's submit
      // timeout and auto-refunds the buyer.
      const { ok, deliverable, error } = await deliverEngagementOnChain(e);
      saveEngagement(e);
      if (!ok) console.error(`[scheduler] delivery failed for ${e.okxJobId}: ${error} — retrying next hour`);
      if (bot && e.userId) {
        await bot.api
          .sendMessage(
            Number(e.userId),
            (ok
              ? '🏁 Engagement complete — deliverable submitted to OKX for acceptance:\n\n'
              : `🏁 Engagement complete. Delivery to the buyer failed (${error}) and will be retried hourly — your results:\n\n`) +
              deliverable.slice(0, 3500),
          )
          .catch(() => {});
      }
    }
  });

  console.log('[scheduler] cron jobs registered (scan 6h, digest Mon 09:00, delivery hourly)');
}
