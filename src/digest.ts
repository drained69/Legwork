import { listApplications } from './db.js';
import type { Engagement } from './types.js';

/**
 * Weekly / end-of-engagement digest. Doubles as the OKX task deliverable:
 * applications sent, response rate, top-scoring skips with reasons.
 */
export function buildDigest(engagement: Engagement): string {
  const apps = listApplications(engagement.id);
  const submitted = apps.filter((a) => a.status === 'submitted' || a.status === 'interview' || a.status === 'rejected');
  const skipped = apps.filter((a) => a.status === 'skipped');
  const pending = apps.filter((a) => a.status === 'pending_approval');
  const interviews = apps.filter((a) => a.status === 'interview');
  const responses = interviews.length + apps.filter((a) => a.status === 'rejected').length;
  const responseRate = submitted.length ? Math.round((responses / submitted.length) * 100) : 0;

  const lines: string[] = [];
  lines.push(`📊 Legwork digest — engagement ${engagement.okxJobId}`);
  lines.push('');
  lines.push(`Applications submitted: ${submitted.length}`);
  lines.push(`Awaiting your approval: ${pending.length}`);
  lines.push(`Skipped: ${skipped.length}`);
  lines.push(`Responses so far: ${responses} (${responseRate}% of submitted)  •  Interviews: ${interviews.length}`);
  lines.push('');

  if (submitted.length) {
    lines.push('✅ Sent:');
    for (const a of submitted.slice(0, 10)) {
      lines.push(`  • [${a.score}] ${shortReceipt(a.receipt)} (${a.submittedAt?.slice(0, 10) ?? ''})`);
    }
    lines.push('');
  }

  const topSkips = skipped.sort((a, b) => b.score - a.score).slice(0, 5);
  if (topSkips.length) {
    lines.push('⏭ Top-scoring postings you skipped (rubric-tuning signal):');
    for (const a of topSkips) {
      lines.push(`  • [${a.score}] posting ${a.postingId} — reason: ${a.skipReason ?? 'not given'}`);
    }
    lines.push('');
  }

  lines.push('Every application above was individually approved by you before sending.');
  return lines.join('\n');
}

function shortReceipt(receipt?: string): string {
  if (!receipt) return 'submitted';
  return receipt.length > 90 ? receipt.slice(0, 87) + '…' : receipt;
}

/** Dispute-evidence bundle: approvals, draft versions, receipts. */
export function buildEvidenceBundle(engagement: Engagement): string {
  const apps = listApplications(engagement.id);
  const rows = apps.map((a) =>
    [
      a.id,
      a.postingId,
      a.status,
      `score=${a.score}`,
      `approvedAt=${a.approvalAt ?? '-'}`,
      `draft=${a.draftId ?? '-'}`,
      `receipt=${a.receipt ?? '-'}`,
    ].join(' | '),
  );
  return `EVIDENCE BUNDLE — OKX job ${engagement.okxJobId}\n${rows.join('\n') || '(no applications)'}`;
}
