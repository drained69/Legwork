import type { Engagement, Posting, Profile, ScoreBreakdown } from '../types.js';

/**
 * Shared presentation layer for the Telegram surface.
 *
 * House style:
 *  - HTML parse mode (safer than Markdown for user-supplied text)
 *  - One bold title line, a thin rule, then content — no emoji soup
 *  - Every number the user sees is explained somewhere on the same screen
 */

export const RULE = '━━━━━━━━━━━━━━━━━━━━';

/** Escape user/posting text before it enters an HTML-parsed message. */
export function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function title(text: string, subtitle?: string): string {
  return `<b>${esc(text)}</b>${subtitle ? `\n<i>${esc(subtitle)}</i>` : ''}\n${RULE}`;
}

/** 0x1234…abcd — never show a full address unprompted. */
export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

export function isEvmAddress(value: string): boolean {
  return /^0x[a-fA-F0-9]{40}$/.test(value.trim());
}

export function money(n: number): string {
  return `$${n.toLocaleString('en-US')}`;
}

/** Compact score meter: ▰▰▰▰▰▰▱▱▱▱ 62 */
export function meter(score: number, max = 100, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((score / max) * width)));
  return `${'▰'.repeat(filled)}${'▱'.repeat(width - filled)} ${score}`;
}

export function scoreVerdict(score: number): string {
  if (score >= 85) return 'Excellent match';
  if (score >= 70) return 'Strong match';
  if (score >= 55) return 'Worth a look';
  return 'Weak match';
}

// ── profile rendering ──────────────────────────────────────────────────────

export const PROFILE_FIELDS = {
  name: 'Name',
  roles: 'Target roles',
  seniority: 'Level',
  locations: 'Locations',
  compFloor: 'Minimum salary',
  skills: 'Skills',
  factors: 'Priorities',
  email: 'Email',
  resume: 'Résumé',
  wallet: 'X Layer wallet',
} as const;

export type ProfileField = keyof typeof PROFILE_FIELDS;

export function renderProfile(p: Profile): string {
  const rows: string[] = [];
  const row = (label: string, value: string) => rows.push(`<b>${label}</b>\n${value}`);

  row(PROFILE_FIELDS.name, esc(p.name || '—'));
  row(PROFILE_FIELDS.roles, esc(p.targetRoles.join(', ') || '—'));
  row(PROFILE_FIELDS.seniority, esc(p.seniority || '—'));
  row(PROFILE_FIELDS.locations, esc(p.locations.join(', ') || '—') + (p.remoteOk ? ' · remote OK' : ''));
  row(PROFILE_FIELDS.compFloor, p.compFloor ? money(p.compFloor) : '—');
  row(PROFILE_FIELDS.skills, esc(p.skills.join(', ') || '—'));
  row(PROFILE_FIELDS.factors, esc((p.factors ?? []).join(', ') || '—'));
  row(PROFILE_FIELDS.email, esc(p.email || '—'));
  row(PROFILE_FIELDS.resume, p.resumeText ? `${p.resumeText.length.toLocaleString()} characters on file` : '— (not required for job hunting)');
  row(PROFILE_FIELDS.wallet, p.wallet ? `<code>${esc(p.wallet)}</code>` : '— not linked');

  return `${title('Your profile', 'Saved — you never re-enter this')}\n\n${rows.join('\n\n')}`;
}

export function profileCompleteness(p: Profile): { done: number; total: number; missing: string[] } {
  const checks: Array<[boolean, string]> = [
    [p.targetRoles.length > 0, PROFILE_FIELDS.roles],
    [Boolean(p.seniority), PROFILE_FIELDS.seniority],
    [p.locations.length > 0, PROFILE_FIELDS.locations],
    [p.compFloor > 0, PROFILE_FIELDS.compFloor],
    [p.skills.length > 0, PROFILE_FIELDS.skills],
  ];
  const missing = checks.filter(([ok]) => !ok).map(([, label]) => label);
  return { done: checks.length - missing.length, total: checks.length, missing };
}

// ── welcome ────────────────────────────────────────────────────────────────

export interface WelcomeState {
  firstName: string;
  profile?: Profile;
  engagement?: Engagement;
  agentId: string;
  returning: boolean;
}

export function renderWelcome(s: WelcomeState): string {
  const lines: string[] = [];

  lines.push(`<b>Legwork</b>`);
  lines.push(`<i>Your job search, managed end to end</i>`);
  lines.push(RULE);
  lines.push('');
  lines.push(
    s.returning
      ? `Welcome back, ${esc(s.firstName)}.`
      : `Welcome, ${esc(s.firstName)}.`,
  );
  lines.push('');

  if (!s.returning) {
    lines.push(
      'I scan job boards on your behalf, score every posting against your profile on a transparent 100-point rubric, ' +
        'and draft tailored applications. Nothing is ever sent without your explicit approval.',
    );
    lines.push('');
  }

  // Status block — the answer to "where do I stand?"
  lines.push('<b>Status</b>');

  const wallet = s.profile?.wallet;
  lines.push(wallet ? `Wallet · <code>${esc(shortAddress(wallet))}</code> connected` : 'Wallet · not linked');

  if (s.profile) {
    const c = profileCompleteness(s.profile);
    lines.push(
      c.missing.length === 0
        ? `Profile · complete (${c.done}/${c.total})`
        : `Profile · ${c.done}/${c.total} — missing ${esc(c.missing.join(', ').toLowerCase())}`,
    );
  } else {
    lines.push('Profile · not set up');
  }

  if (s.engagement) {
    const ends = s.engagement.endsAt ? ` · ends ${s.engagement.endsAt.slice(0, 10)}` : '';
    lines.push(`Engagement · ${esc(listingLabel(s.engagement.listing))} — ${esc(s.engagement.status)}${ends}`);
  } else {
    lines.push('Engagement · none active');
  }

  lines.push('');
  lines.push(
    s.profile
      ? 'Choose an action below.'
      : 'Set up your profile to begin — it takes about a minute, and you will never enter it again.',
  );

  return lines.join('\n');
}

export function listingLabel(listing: string): string {
  const labels: Record<string, string> = {
    'job-hunt': 'Job Hunt (24h)',
    'job-hunt-weekly': 'Job Hunt Weekly',
    'tailor-one-application': 'Tailored Application',
    'job-search-sprint-7d': 'Full Search Sprint',
  };
  return labels[listing] ?? listing;
}

// ── match card ─────────────────────────────────────────────────────────────

export function renderMatchCard(posting: Posting, b: ScoreBreakdown, index?: number, total?: number): string {
  const comp =
    posting.compMin || posting.compMax
      ? `${money(posting.compMin ?? 0)} – ${money(posting.compMax ?? 0)}`
      : 'Not disclosed';

  const counter = index && total ? ` · ${index} of ${total}` : '';
  const lines = [
    `<b>${esc(posting.title)}</b>`,
    `${esc(posting.company)} · ${esc(posting.location)}${posting.remote ? ' · Remote' : ''}`,
    RULE,
    '',
    `<b>${meter(b.total)}/100</b> — ${scoreVerdict(b.total)}${counter}`,
    '',
    `<b>Salary</b> · ${esc(comp)}`,
    `<b>Applied via</b> · ${esc(atsLabel(posting.atsHint))}`,
    '',
    '<b>Score breakdown</b>',
    axis('Skills', b.skills.score, b.skills.max, b.skills.reason),
    axis('Salary', b.comp.score, b.comp.max, b.comp.reason),
    axis('Location', b.location.score, b.location.max, b.location.reason),
    axis('Level', b.seniority.score, b.seniority.max, b.seniority.reason),
    axis('Priorities', b.culture.score, b.culture.max, b.culture.reason),
    '',
    `<a href="${esc(posting.url)}">View original posting</a>`,
  ];
  return lines.join('\n');
}

function axis(label: string, score: number, max: number, reason: string): string {
  return `<b>${label} ${score}/${max}</b> — ${esc(reason)}`;
}

export function atsLabel(hint?: string): string {
  const labels: Record<string, string> = {
    greenhouse: 'Greenhouse',
    lever: 'Lever',
    workday: 'Workday',
    email: 'Email application',
    unknown: 'Company site',
  };
  return labels[hint ?? 'unknown'] ?? 'Company site';
}
