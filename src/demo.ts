/**
 * Keyless end-to-end demo: simulates the full loop without any API keys.
 *
 *   OKX task assigned → deep link → onboard → scan (mock postings) →
 *   score (heuristics) → tailor (template) → match cards → approve one →
 *   approval-gated submission → digest → deliverable back to OKX.
 *
 * Run: npm run demo
 */
import { handleEnvelope, deliverEngagement } from './okx/server.js';
import { getEngagementByJob, saveEngagement, saveProfile, updateApplication, now } from './db.js';
import { runScanCycle, renderBreakdown } from './pipeline.js';
import { submitApplication } from './skills/applyExecutor.js';
import { buildDigest } from './digest.js';
import { getPosting, getProfile, getDraft } from './db.js';

const hr = () => console.log('\n' + '─'.repeat(72) + '\n');

async function demo(): Promise<void> {
  console.log('LEGWORK DEMO — full loop, no API keys required');
  hr();

  // 1. Buyer hires Legwork on the OKX Task Marketplace → task_assigned event
  console.log('1) OKX marketplace: buyer hires "Job Search Sprint (7 days)"');
  const jobId = `okx-job-${Date.now()}`;
  const response = handleEnvelope({
    jobId,
    message: { source: 'system', event: 'task_assigned', jobId },
    sender: { role: 'USER', agentId: 'buyer-agent-0x123' },
  });
  console.log('   OKX task chat reply:', (response as { reply?: string }).reply);

  const engagement = getEngagementByJob(jobId)!;
  hr();

  // 2. Buyer opens the deep link → binds Telegram user → onboards
  console.log(`2) Telegram: buyer opens t.me deep link (?start=${engagement.taskCode}) and onboards`);
  const userId = `demo-user-${Date.now()}`; // fresh user each run — dedupe is per-user
  engagement.userId = userId;
  engagement.status = 'active';
  saveEngagement(engagement);
  saveProfile({
    userId,
    name: 'Alex Rivera',
    targetRoles: ['backend engineer', 'full-stack engineer'],
    seniority: 'senior',
    locations: ['remote', 'Austin, TX'],
    remoteOk: true,
    compFloor: 110000,
    skills: ['typescript', 'node.js', 'postgresql', 'redis', 'aws', 'react'],
    resumeText:
      'Senior software engineer with 7 years of experience. Built payment infrastructure at a fintech ' +
      '(Node.js, TypeScript, PostgreSQL) handling $2M/day. Led a team of 4. Previously full-stack at a ' +
      'health-tech startup (React, Node). BSc Computer Science.',
    dealbreakers: ['fully onsite'],
    threshold: 60,
    dailyCap: 5,
    email: 'alex.rivera@example.com',
  });
  console.log('   Profile saved for Alex Rivera (senior, remote-ok, $110k floor).');
  hr();

  // 3. Scan → score → tailor → match cards
  console.log('3) Scan cycle: scrape (mock sources) → rubric score → tailor drafts');
  const summary = await runScanCycle(engagement);
  console.log(`   ${summary.found} postings found → ${summary.cards.length} above threshold, ${summary.scoredBelowThreshold} below.\n`);
  for (const card of summary.cards) {
    console.log(`   🎯 ${card.breakdown.total}/100 — ${card.posting.title} @ ${card.posting.company} (${card.posting.atsHint})`);
    console.log(renderBreakdown(card.breakdown).split('\n').map((l) => '      ' + l).join('\n'));
    console.log('');
  }
  if (!summary.cards.length) throw new Error('demo expected at least one match card');
  hr();

  // 4. Executor gate check: try submitting WITHOUT approval (must refuse)
  const top = summary.cards.sort((a, b) => b.breakdown.total - a.breakdown.total)[0];
  console.log(`4) Trust loop: attempt submission WITHOUT approval for "${top.posting.title}"`);
  const refused = await submitApplication(top.application, getProfile(userId)!, top.posting);
  console.log(`   Executor says: ${refused.error} ✔ (hard gate works)`);
  hr();

  // 5. Owner taps Approve → executor submits
  console.log('5) Owner taps ✅ Approve on the match card → final email preview → 🚀 Send');
  const draft = getDraft(top.application.draftId!)!;
  console.log(`   Email subject: ${draft.emailSubject}`);
  console.log(`   Cover letter preview: ${draft.coverLetter.slice(0, 160).replace(/\n/g, ' ')}…`);
  top.application.status = 'approved';
  top.application.approvalAt = now();
  updateApplication(top.application);
  const result = await submitApplication(top.application, getProfile(userId)!, getPosting(top.posting.id)!);
  console.log(`   ✅ ${result.receipt}`);
  hr();

  // 6. Skip one with a reason (rubric-tuning signal)
  const other = summary.cards.find((c) => c !== top);
  if (other) {
    other.application.status = 'skipped';
    other.application.skipReason = 'comp';
    updateApplication(other.application);
    console.log(`6) Owner skips "${other.posting.title}" (reason: comp) — logged for rubric tuning`);
    hr();
  }

  // 7. Digest + delivery back through OKX
  console.log('7) Weekly digest (also the OKX deliverable):\n');
  console.log(buildDigest(engagement).split('\n').map((l) => '   ' + l).join('\n'));
  hr();

  console.log('8) Engagement ends → deliverable submitted via OKX task lifecycle');
  deliverEngagement(engagement);
  saveEngagement(engagement);

  // 9. Buyer accepts delivery on OKX → settlement
  const settle = handleEnvelope({
    jobId,
    message: { source: 'system', event: 'delivery_accepted', jobId },
  });
  console.log(`   delivery_accepted handled: ${JSON.stringify(settle)} → engagement settled, payment logged.`);
  hr();
  console.log('DEMO COMPLETE — full loop: OKX hire → Telegram approval → submission → OKX settlement.');
}

demo().catch((err) => {
  console.error('demo failed:', err);
  process.exit(1);
});
