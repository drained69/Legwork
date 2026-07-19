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
  // Identity & contact
  name: 'Full name',
  email: 'Email',
  phone: 'Phone',
  currentLocation: 'Current location',
  wallet: 'X Layer wallet',
  // Professional
  currentTitle: 'Current title',
  yearsExperience: 'Years of experience',
  seniority: 'Level',
  skills: 'Skills',
  resume: 'Résumé',
  education: 'Education',
  certifications: 'Certifications',
  languages: 'Languages',
  // Links
  linkedin: 'LinkedIn',
  github: 'GitHub',
  portfolio: 'Portfolio',
  // Preferences
  roles: 'Target roles',
  locations: 'Preferred locations',
  compFloor: 'Minimum salary',
  compTarget: 'Target salary',
  employmentTypes: 'Employment type',
  industries: 'Industries',
  companySizes: 'Company size',
  factors: 'Priorities',
  dealbreakers: 'Dealbreakers',
  // Eligibility
  workAuthorization: 'Work authorization',
  needsSponsorship: 'Needs sponsorship',
  willingToRelocate: 'Open to relocation',
  noticePeriod: 'Notice period',
  availableFrom: 'Available from',
} as const;

export type ProfileField = keyof typeof PROFILE_FIELDS;

export const PROFILE_SECTIONS: Array<{ label: string; fields: ProfileField[] }> = [
  { label: 'Identity & contact', fields: ['name', 'email', 'phone', 'currentLocation', 'wallet'] },
  { label: 'Professional', fields: ['currentTitle', 'yearsExperience', 'seniority', 'skills', 'resume', 'education', 'certifications', 'languages'] },
  { label: 'Links', fields: ['linkedin', 'github', 'portfolio'] },
  { label: 'What you want', fields: ['roles', 'locations', 'compFloor', 'compTarget', 'employmentTypes', 'industries', 'companySizes', 'factors', 'dealbreakers'] },
  { label: 'Eligibility & availability', fields: ['workAuthorization', 'needsSponsorship', 'willingToRelocate', 'noticePeriod', 'availableFrom'] },
];

export function fieldValue(p: Profile, field: ProfileField): string {
  const list = (a?: string[]) => (a && a.length ? a.join(', ') : '');
  const bool = (b?: boolean) => (b === undefined ? '' : b ? 'Yes' : 'No');
  switch (field) {
    case 'name': return p.name;
    case 'email': return p.email ?? '';
    case 'phone': return p.phone ?? '';
    case 'currentLocation': return p.currentLocation ?? '';
    case 'wallet': return p.wallet ?? '';
    case 'currentTitle': return p.currentTitle ?? '';
    case 'yearsExperience': return p.yearsExperience ? `${p.yearsExperience}` : '';
    case 'seniority': return p.seniority;
    case 'skills': return list(p.skills);
    case 'resume': return p.resumeText ? `${p.resumeText.length.toLocaleString()} characters on file` : '';
    case 'education': return p.education ?? '';
    case 'certifications': return list(p.certifications);
    case 'languages': return list(p.languages);
    case 'linkedin': return p.linkedin ?? '';
    case 'github': return p.github ?? '';
    case 'portfolio': return p.portfolio ?? '';
    case 'roles': return list(p.targetRoles);
    case 'locations': return list(p.locations) + (p.remoteOk ? ' · remote OK' : '');
    case 'compFloor': return p.compFloor ? money(p.compFloor) : '';
    case 'compTarget': return p.compTarget ? money(p.compTarget) : '';
    case 'employmentTypes': return list(p.employmentTypes);
    case 'industries': return list(p.industries);
    case 'companySizes': return list(p.companySizes);
    case 'factors': return list(p.factors);
    case 'dealbreakers': return list(p.dealbreakers);
    case 'workAuthorization': return p.workAuthorization ?? '';
    case 'needsSponsorship': return bool(p.needsSponsorship);
    case 'willingToRelocate': return bool(p.willingToRelocate);
    case 'noticePeriod': return p.noticePeriod ?? '';
    case 'availableFrom': return p.availableFrom ?? '';
  }
}

export function renderProfile(p: Profile): string {
  const blocks: string[] = [];
  for (const section of PROFILE_SECTIONS) {
    const rows = section.fields
      .map((f) => {
        const v = fieldValue(p, f);
        const display = f === 'wallet' && v ? `<code>${esc(v)}</code>` : esc(v || '—');
        return `<b>${PROFILE_FIELDS[f]}</b> · ${display}`;
      })
      .join('\n');
    blocks.push(`<u>${section.label}</u>\n${rows}`);
  }
  const filled = PROFILE_SECTIONS.flatMap((s) => s.fields).filter((f) => fieldValue(p, f)).length;
  const total = PROFILE_SECTIONS.flatMap((s) => s.fields).length;
  return (
    `${title('Your profile', `${filled} of ${total} fields complete — saved, never re-entered`)}\n\n` +
    blocks.join('\n\n')
  );
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
  return s.returning ? renderReturningWelcome(s) : renderFirstRunWelcome(s);
}

/**
 * First run: this is the only chance to explain what Legwork is and how to
 * use it, so it leads with the product, not with a status table.
 */
function renderFirstRunWelcome(s: WelcomeState): string {
  return [
    `👋 <b>Welcome to Legwork, ${esc(s.firstName)}</b>`,
    `<i>Your job search, run from Telegram</i>`,
    RULE,
    '',
    'Applying to jobs at volume is a part-time job in itself: finding postings, judging which are worth it, ' +
      'rewriting your CV for each one, then filling in yet another form.',
    '',
    '<b>Legwork does that work for you.</b> I search job boards, score every posting against your real profile, ' +
      'and write tailored applications — while you keep the final say on everything that goes out in your name.',
    '',
    '<b>How it works</b>',
    '',
    '<b>1 · Tell me about yourself</b>',
    'Your target roles, level, locations, salary floor and skills. About a minute — then it is saved for good, ' +
      'and you never type it again. Update any detail whenever you like.',
    '',
    '<b>2 · I hunt and score</b>',
    'I scan live job boards and score each posting out of 100: skills 40, salary 20, location 15, level 15, ' +
      'your own priorities 10. Every score comes with the reason behind it — never an unexplained "94% match".',
    '',
    '<b>3 · I draft your application</b>',
    'For roles worth pursuing I write a tailored CV and cover letter, drawn strictly from your real experience. ' +
      'Nothing is invented.',
    '',
    '<b>4 · You approve — then it sends</b>',
    'You see the exact recipient and the exact wording first. Nothing is ever submitted without your explicit tap.',
    '',
    RULE,
    '<b>Getting started</b>',
    '',
    '• <b>Set up your profile</b> below to begin',
    '• <b>Free preview</b> — see your top 3 matches at no cost, before paying for anything',
    '• <b>/menu</b> — every action in one place',
    '• <b>/help</b> — how scoring and approvals work',
    '',
    'Optionally link an X Layer wallet to run paid engagements from the OKX marketplace. ' +
      'A wallet is <b>not</b> required to set up your profile or try a preview.',
  ].join('\n');
}

/** Returning users get an orientation line, then the facts. */
function renderReturningWelcome(s: WelcomeState): string {
  const lines: string[] = [
    `<b>Welcome back to Legwork, ${esc(s.firstName)}</b>`,
    `<i>Your job search, run from Telegram</i>`,
    RULE,
    '',
    '<b>Status</b>',
  ];

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
    lines.push('Engagement · none active — free preview still available');
  }

  lines.push('');
  if (!s.profile) {
    lines.push('Set up your profile to begin — about a minute, and you will never enter it again.');
  } else {
    const c = profileCompleteness(s.profile);
    lines.push(
      c.missing.length
        ? `Complete the missing details to sharpen your match scores, or pick an action below.`
        : 'Pick an action below, or open <b>/menu</b> for everything I can do.',
    );
  }

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
