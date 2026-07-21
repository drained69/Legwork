import { audit, getProfile, saveEngagement } from '../db.js';
import { scanForUser } from './jobScraper.js';
import { scorePosting } from './matchScorer.js';
import { renderBreakdown } from '../pipeline.js';
import { INJECTION_GUARD, extractJson, llm, untrusted } from '../llm.js';
import type { Engagement, Posting, Profile, ScoreBreakdown } from '../types.js';

/**
 * job-hunt — the simplest Legwork product on OKX.
 *
 * The user supplies specific criteria (roles, location, qualification level,
 * comp floor, skills, priority factors), APPROVES the criteria summary, and
 * the agent hunts: scan sources → score every posting against the criteria →
 * return a ranked shortlist where every rank is explained. No resume, no
 * email access, no submission — pure discovery.
 */

export interface HuntMatch {
  posting: Posting;
  breakdown: ScoreBreakdown;
}

export interface HuntResult {
  matches: HuntMatch[]; // ranked, best first
  found: number;
  sourceErrors: string[];
}

const TOP_N = 10;

export async function runHunt(engagement: Engagement): Promise<HuntResult> {
  if (!engagement.userId) return { matches: [], found: 0, sourceErrors: ['engagement not bound to a user'] };
  const profile = getProfile(engagement.userId);
  if (!profile) return { matches: [], found: 0, sourceErrors: ['no criteria on file'] };

  const scan = await scanForUser(profile, engagement.id);
  const scored: HuntMatch[] = [];
  for (const posting of scan.newPostings) {
    scored.push({ posting, breakdown: await scorePosting(profile, posting) });
  }
  scored.sort((a, b) => b.breakdown.total - a.breakdown.total);
  const matches = scored.slice(0, TOP_N);

  // Persist the full shortlist on the engagement — it IS the OKX deliverable.
  if (matches.length) {
    engagement.shortlist = formatShortlist(profile, matches, scan.found, true);
    saveEngagement(engagement);
  }
  audit('job-hunt', 'HUNT_RUN', `eng=${engagement.id} found=${scan.found} shortlisted=${matches.length}`);
  return { matches, found: scan.found, sourceErrors: scan.sourceErrors };
}

/** Criteria shape accepted by the paid per-call API (POST /api/hunt). */
export interface HuntCriteria {
  roles?: string[];
  seniority?: string;
  locations?: string[];
  compFloor?: number;
  skills?: string[];
  factors?: string[];
}

export function criteriaToProfile(c: HuntCriteria, userId: string): Profile {
  const locations = c.locations ?? ['remote'];
  return {
    userId,
    name: 'API caller',
    targetRoles: c.roles ?? [],
    seniority: c.seniority ?? 'mid',
    locations,
    remoteOk: locations.some((l) => l.toLowerCase() === 'remote'),
    compFloor: Number(c.compFloor ?? 0),
    skills: c.skills ?? [],
    resumeText: '',
    dealbreakers: [],
    factors: c.factors ?? [],
    threshold: 0,
    dailyCap: 10,
  };
}

/**
 * One-shot hunt for the paid x402 API: criteria in → ranked matches out.
 * Uses a unique per-call user id so results are never deduped across
 * unrelated buyers/calls.
 */
export async function runAdhocHunt(criteria: HuntCriteria): Promise<HuntResult> {
  const profile = criteriaToProfile(criteria, `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const scan = await scanForUser(profile, 'api-call');
  const scored: HuntMatch[] = [];
  for (const posting of scan.newPostings) {
    scored.push({ posting, breakdown: await scorePosting(profile, posting) });
  }
  scored.sort((a, b) => b.breakdown.total - a.breakdown.total);
  audit('job-hunt', 'API_HUNT', `found=${scan.found} shortlisted=${Math.min(scored.length, TOP_N)}`);
  return { matches: scored.slice(0, TOP_N), found: scan.found, sourceErrors: scan.sourceErrors };
}

/**
 * Turn a marketplace buyer's free-text brief into hunt criteria.
 *
 * A task published on OKX carries a title + description ("Find senior React
 * roles, remote, $150k+"), not a filled-in form. This is the bridge that lets
 * the agent serve a task autonomously instead of waiting for the buyer to
 * finish a Telegram onboarding they may never start.
 *
 * SECURITY: the brief is untrusted third-party text. It is wrapped in the
 * standard guard tags and only ever used to fill these six fields — it never
 * becomes an instruction.
 */
export async function criteriaFromBrief(title: string, description = ''): Promise<HuntCriteria> {
  const brief = `${title}\n${description}`.trim();
  const reply = await llm(
    'You extract job-search criteria from a buyer request. ' +
      INJECTION_GUARD +
      ' Reply with ONLY a JSON object: {"roles":string[],"seniority":"junior|mid|senior|staff|principal",' +
      '"locations":string[],"compFloor":number,"skills":string[],"factors":string[]}. ' +
      'Use [] / 0 for anything the request does not state. Never invent a comp floor.',
    untrusted(brief),
    600,
  );
  const parsed = reply ? extractJson<HuntCriteria>(reply) : null;
  if (parsed && (parsed.roles?.length || parsed.skills?.length)) return normalizeCriteria(parsed);
  return heuristicCriteria(brief);
}

function normalizeCriteria(c: HuntCriteria): HuntCriteria {
  const arr = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 12) : [];
  return {
    roles: arr(c.roles),
    seniority: typeof c.seniority === 'string' && c.seniority.trim() ? c.seniority.trim() : 'mid',
    locations: arr(c.locations).length ? arr(c.locations) : ['remote'],
    compFloor: Number.isFinite(Number(c.compFloor)) ? Math.max(0, Number(c.compFloor)) : 0,
    skills: arr(c.skills),
    factors: arr(c.factors),
  };
}

/** Keyless fallback: pull what a regex can honestly see, guess nothing else. */
export function heuristicCriteria(brief: string): HuntCriteria {
  const text = brief.toLowerCase();
  const seniority =
    ['principal', 'staff', 'senior', 'junior'].find((s) => text.includes(s)) ??
    (/\bentry|graduate|intern\b/.test(text) ? 'junior' : 'mid');
  // "$150k" / "$150,000" / "150k+"
  const comp = /\$?\s*(\d{2,3})\s*k\b/.exec(text) ?? /\$\s*([\d,]{5,9})/.exec(text);
  const compFloor = comp ? (comp[0].includes('k') ? Number(comp[1]) * 1000 : Number(comp[1].replace(/,/g, ''))) : 0;
  const locations = /\bremote\b/.test(text) ? ['remote'] : ['remote'];
  // The role is the most useful signal we can extract without a model: keep
  // the meaningful words of the brief and let the scorer do the rest.
  const roles = brief
    .split(/[,.\n;]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 2 && s.length < 60 && /[a-z]/i.test(s))
    .slice(0, 3);
  return { roles, seniority, locations, compFloor, skills: [], factors: [] };
}

/**
 * Shortlist rendering. compact=false → one-line-per-match summary for chat;
 * full=true → complete per-axis breakdowns (the deliverable / details view).
 */
export function formatShortlist(profile: Profile, matches: HuntMatch[], found: number, full = false): string {
  const lines: string[] = [];
  lines.push(`🔎 Job hunt results — top ${matches.length} of ${found} postings, scored against your criteria`);
  lines.push(
    `Criteria: ${profile.targetRoles.join('/')} • ${profile.seniority} • ${profile.locations.join(', ')} • ` +
      `$${profile.compFloor.toLocaleString()}+ floor` +
      ((profile.factors ?? []).length ? ` • factors: ${(profile.factors ?? []).join(', ')}` : ''),
  );
  lines.push('');
  matches.forEach((m, i) => {
    const comp =
      m.posting.compMin || m.posting.compMax
        ? `$${(m.posting.compMin ?? 0).toLocaleString()}–$${(m.posting.compMax ?? 0).toLocaleString()}`
        : 'comp not listed';
    lines.push(`${i + 1}. [${m.breakdown.total}/100] ${m.posting.title} @ ${m.posting.company}`);
    lines.push(`   ${comp} • ${m.posting.location}${m.posting.remote ? ' • remote' : ''}`);
    lines.push(`   ${m.posting.url}`);
    if (full) {
      lines.push(
        renderBreakdown(m.breakdown)
          .split('\n')
          .map((l) => '   ' + l)
          .join('\n'),
      );
    } else {
      // Compact: the two most informative axes.
      lines.push(`   Skills ${m.breakdown.skills.score}/40 — ${m.breakdown.skills.reason}`);
      lines.push(`   Comp ${m.breakdown.comp.score}/20 — ${m.breakdown.comp.reason}`);
    }
    lines.push('');
  });
  if (!matches.length) {
    lines.push('No new postings matched this cycle. The hunt keeps running — fresh sources are scanned automatically.');
  }
  lines.push('Every score above is rubric-based (skills 40 / comp 20 / location 15 / qualification 15 / factors 10) — no black boxes.');
  return lines.join('\n');
}

/** Criteria summary shown for approval BEFORE the hunt runs. */
export function formatCriteriaSummary(profile: Profile): string {
  return (
    `📋 Your hunt criteria — confirm before I start:\n\n` +
    `Roles: ${profile.targetRoles.join(', ')}\n` +
    `Qualification level: ${profile.seniority}\n` +
    `Locations: ${profile.locations.join(', ')} (remote ${profile.remoteOk ? 'ok' : 'no'})\n` +
    `Comp floor: $${profile.compFloor.toLocaleString()}\n` +
    `Skills/qualifications: ${profile.skills.join(', ')}\n` +
    `Priority factors: ${(profile.factors ?? []).join(', ') || 'none'}\n\n` +
    `Nothing runs until you approve.`
  );
}

/** Split long shortlists into Telegram-safe chunks (<4096 chars). */
export function chunkMessage(text: string, limit = 3500): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = '';
    }
    current += (current ? '\n' : '') + line;
  }
  if (current) chunks.push(current);
  return chunks;
}
