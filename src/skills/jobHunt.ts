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

/**
 * Cities the heuristic can recognise by name. Shared with the poller's
 * brief-usability gate so both agree on what counts as a stated location.
 */
export const KNOWN_CITIES = [
  'remote', 'san francisco', 'new york', 'seattle', 'austin', 'boston', 'chicago', 'denver',
  'los angeles', 'atlanta', 'portland', 'miami', 'toronto', 'vancouver', 'london', 'berlin',
  'amsterdam', 'dublin', 'paris', 'madrid', 'lisbon', 'bangalore', 'singapore', 'sydney',
];

/**
 * Skill vocabulary for the keyless path.
 *
 * This exists because production runs WITHOUT an Anthropic key (`llm=false`),
 * so `criteriaFromBrief` always falls through to the heuristic — which used to
 * hardcode `skills: []` and therefore dropped every stated skill. Skills carry
 * 40 of the 100 rubric points, so an empty list does not merely lose detail:
 * it removes the largest scoring axis from every match.
 */
export const EXTRACTABLE_SKILLS = [
  'typescript', 'javascript', 'python', 'go', 'rust', 'java', 'kotlin', 'swift',
  'ruby', 'php', 'scala', 'elixir', 'c++', 'c#', '.net', 'node', 'deno', 'bun',
  'react', 'vue', 'angular', 'svelte', 'next.js', 'django', 'flask', 'fastapi',
  'rails', 'spring', 'graphql', 'grpc', 'rest',
  'postgres', 'mysql', 'sqlite', 'mongodb', 'redis', 'elasticsearch',
  'kafka', 'rabbitmq', 'clickhouse', 'snowflake', 'dynamodb', 'cassandra',
  'aws', 'gcp', 'azure', 'kubernetes', 'docker', 'terraform', 'ansible', 'linux',
  'ci/cd', 'jenkins', 'github actions', 'observability', 'prometheus', 'grafana',
  'machine learning', 'pytorch', 'tensorflow', 'pandas', 'numpy', 'llm', 'nlp',
  'figma', 'sketch', 'solidity', 'ethereum', 'web3',
];

/** Spellings that should register as an entry above. */
const SKILL_ALIASES: Record<string, string[]> = {
  go: ['go', 'golang'],
  postgres: ['postgres', 'postgresql'],
  'next.js': ['next.js', 'nextjs'],
  '.net': ['.net', 'dotnet'],
  javascript: ['javascript', ' js '],
  typescript: ['typescript'],
  kubernetes: ['kubernetes', 'k8s'],
  'machine learning': ['machine learning', 'ml engineering'],
};

/**
 * Does `text` mention this skill as a WORD?
 *
 * Substring matching is unusable for a vocabulary this short: "go" appears
 * inside "django", "golang" and "algorithm", while a padded " go " misses the
 * far more common "Python, Go, Postgres" — which is precisely how the skill
 * the buyer named most prominently went missing. Custom boundaries handle the
 * punctuation-bearing entries (c++, c#, .net, ci/cd) that `\b` gets wrong.
 */
export function mentionsSkill(text: string, skill: string): boolean {
  const forms = SKILL_ALIASES[skill] ?? [skill];
  return forms.some((form) => {
    const body = form.trim();
    const esc = body.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lead = /^[a-z0-9]/.test(body) ? '(?<![a-z0-9])' : '(?<![a-z0-9.])';
    const tail = /[a-z0-9]$/.test(body) ? '(?![a-z0-9])' : '';
    return new RegExp(`${lead}${esc}${tail}`, 'i').test(text);
  });
}

/** Keyless fallback: pull what a regex can honestly see, guess nothing else. */
export function heuristicCriteria(brief: string): HuntCriteria {
  const text = brief.toLowerCase();
  const seniority =
    ['principal', 'staff', 'senior', 'junior'].find((s) => text.includes(s)) ??
    (/\bentry|graduate|intern\b/.test(text) ? 'junior' : 'mid');

  // "$150k" / "150k+" / "$150,000" / "150000". Scan every candidate and take
  // the LARGEST: a brief often mentions several numbers ("5 years", "$140k
  // base, up to $180k"), and first-match previously picked whichever appeared
  // first — frequently the years-of-experience figure.
  const compFloor = extractCompFloor(text);

  const named = KNOWN_CITIES.filter((city) => text.includes(city));
  const locations = named.length ? named : ['remote'];

  const skills = EXTRACTABLE_SKILLS.filter((s) => mentionsSkill(text, s));

  return { roles: extractRoles(brief), seniority, locations, compFloor, skills, factors: [] };
}

/**
 * The buyer's salary FLOOR, normalised to whole dollars.
 *
 * Deliberately the LOWEST plausible figure, not the highest. This value is
 * passed to the job board as `salary_min`, so overshooting filters out valid
 * postings and returns an empty board — the same "0 of 0" outcome this whole
 * change exists to prevent. "$140k+ base, up to $180k" means the floor is
 * 140k; picking 180k would silently discard everything the buyer wanted.
 * Undershooting is recoverable, because the scorer still ranks on comp.
 *
 * Years-of-experience numbers are excluded by the 20k plausibility bound.
 */
export function extractCompFloor(text: string): number {
  const candidates: number[] = [];
  for (const m of text.matchAll(/\$?\s*(\d{2,3})\s*k\b/g)) candidates.push(Number(m[1]) * 1000);
  for (const m of text.matchAll(/\$\s*([\d,]{5,9})/g)) candidates.push(Number(m[1].replace(/,/g, '')));
  // A bare 6-figure number ("salary 140000") — only when clearly not a year.
  for (const m of text.matchAll(/\b(\d{6})\b/g)) candidates.push(Number(m[1]));
  const plausible = candidates.filter((n) => n >= 20_000 && n <= 2_000_000);
  return plausible.length ? Math.min(...plausible) : 0;
}

/**
 * Role phrases, not sentence fragments.
 *
 * These become the job-board query string, so precision matters more than
 * recall: splitting the whole brief on punctuation produced entries like
 * "Looking for someone to help me find" and "$140k+ base", which as a search
 * term match nothing and return an empty board — the "0 of 0" outcome.
 */
export function extractRoles(brief: string): string[] {
  const ROLE_NOUNS =
    /(engineer|developer|designer|manager|analyst|scientist|architect|administrator|consultant|writer|marketer|recruiter|accountant|nurse|teacher)s?\b/i;
  const roles: string[] = [];

  for (const fragment of brief.split(/[,.\n;•|]|\band\b/i)) {
    const cleaned = fragment
      .replace(/^\s*(looking for|seeking|find me|find|i want|i need|need|hiring for|open to|interested in|roles? in|jobs? in|help with)\s+/i, '')
      .replace(/\b(roles?|jobs?|positions?|openings?)\b/gi, '')
      .replace(/[^a-z0-9+#./\s-]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned || cleaned.length > 45) continue;
    if (!ROLE_NOUNS.test(cleaned)) continue; // must name an actual occupation
    if (!roles.includes(cleaned)) roles.push(cleaned);
    if (roles.length === 3) break;
  }
  return roles;
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

/**
 * Split long shortlists into Telegram-safe chunks (<4096 chars).
 *
 * Splitting on line boundaries alone is not enough: a single line longer than
 * the limit (a pasted resume, a run-on job description) would be emitted as an
 * oversized chunk and rejected on send. Such a line is hard-split instead.
 */
export function chunkMessage(text: string, limit = 3500): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = '';

  const flush = (): void => {
    if (current) chunks.push(current);
    current = '';
  };

  for (const line of text.split('\n')) {
    if (line.length > limit) {
      flush();
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) flush();
    current += (current ? '\n' : '') + line;
  }
  flush();
  return chunks;
}
