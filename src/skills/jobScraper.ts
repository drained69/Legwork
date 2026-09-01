import { config } from '../config.js';
import { markSeen, now, postingHash, recordScanRun, savePosting } from '../db.js';
import { fetchWithTimeout } from '../http.js';
import type { Posting, Profile } from '../types.js';

/**
 * A job board is a third-party dependency inside a scan. It gets one deadline;
 * missing it degrades the scan to the other sources instead of blocking the
 * whole request.
 *
 * 6s, not 15s. Boards are fetched concurrently, so the scan costs whatever the
 * SLOWEST one costs — a 15s ceiling let one sulking board hold a scored
 * response hostage for 15s while the other two had already answered in under
 * two. Measured scans run 0.4-2.1s, so this is generous headroom and a much
 * tighter tail.
 */
const SOURCE_TIMEOUT_MS = 6_000;

// ── source: Adzuna (free tier, real-time — primary live source) ───────────
async function fetchAdzuna(profile: Profile): Promise<Posting[]> {
  const { appId, appKey, country } = config.adzuna;
  // Roles + the caller's top skills become the keyword query: without the
  // skills, a "TypeScript engineer" hunt returns Java postings and every
  // match then scores 0 on the 40-point skills axis.
  const terms = [...profile.targetRoles, ...(profile.skills ?? []).slice(0, 3)];
  const what = encodeURIComponent(terms.join(' '));
  const where = profile.remoteOk ? '' : `&where=${encodeURIComponent(profile.locations[0] ?? '')}`;
  const url =
    `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${appId}&app_key=${appKey}` +
    `&results_per_page=20&what=${what}${where}&salary_min=${profile.compFloor}&content-type=application/json`;
  const res = await fetchWithTimeout(url, {}, SOURCE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Adzuna ${res.status}`);
  const data = (await res.json()) as {
    results: Array<{
      id: string;
      title: string;
      company?: { display_name?: string };
      location?: { display_name?: string };
      salary_min?: number;
      salary_max?: number;
      description: string;
      redirect_url: string;
    }>;
  };
  return data.results.map((r) => normalize('adzuna', r.id, r.title, r.company?.display_name ?? 'Unknown',
    r.location?.display_name ?? '', r.description, r.redirect_url, r.salary_min, r.salary_max));
}

// ── source: USAJOBS (free, clean structured salary — backup source) ───────
async function fetchUsaJobs(profile: Profile): Promise<Posting[]> {
  const url =
    `https://data.usajobs.gov/api/search?Keyword=${encodeURIComponent(profile.targetRoles.join(' '))}` +
    `&ResultsPerPage=20`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: {
        'Authorization-Key': config.usajobs.apiKey,
        'User-Agent': config.usajobs.userAgent,
        Host: 'data.usajobs.gov',
      },
    },
    SOURCE_TIMEOUT_MS,
  );
  if (!res.ok) throw new Error(`USAJOBS ${res.status}`);
  const data = (await res.json()) as {
    SearchResult: {
      SearchResultItems: Array<{
        MatchedObjectId: string;
        MatchedObjectDescriptor: {
          PositionTitle: string;
          OrganizationName: string;
          PositionLocationDisplay: string;
          PositionRemuneration?: Array<{ MinimumRange?: string; MaximumRange?: string }>;
          UserArea?: { Details?: { JobSummary?: string } };
          PositionURI: string;
        };
      }>;
    };
  };
  return data.SearchResult.SearchResultItems.map((item) => {
    const d = item.MatchedObjectDescriptor;
    const pay = d.PositionRemuneration?.[0];
    return normalize('usajobs', item.MatchedObjectId, d.PositionTitle, d.OrganizationName,
      d.PositionLocationDisplay, d.UserArea?.Details?.JobSummary ?? '', d.PositionURI,
      pay?.MinimumRange ? Number(pay.MinimumRange) : undefined,
      pay?.MaximumRange ? Number(pay.MaximumRange) : undefined);
  });
}

// ── source: mock fixtures (keyless demo mode + offline dev) ────────────────
const MOCK_POSTINGS: Array<Parameters<typeof normalize>> = [
  ['mock', 'm1', 'Senior TypeScript Engineer', 'Northwind Labs', 'Remote (US)',
    'We are hiring a senior TypeScript engineer to build our real-time trading infrastructure. ' +
    'Stack: Node.js, TypeScript, PostgreSQL, Redis, AWS. You will own services end to end. ' +
    'We value written communication, small teams, and shipping weekly. Apply via jobs@northwindlabs.example with resume attached.',
    'https://example.com/jobs/m1', 120000, 165000],
  ['mock', 'm2', 'Backend Engineer (Node.js)', 'Contoso Health', 'Austin, TX (hybrid)',
    'Contoso Health builds patient scheduling software used by 400 clinics. Seeking a backend engineer ' +
    'with Node.js, TypeScript and SQL experience. Greenhouse application. Mission-driven, 4-day onsite.',
    'https://boards.greenhouse.io/contoso/jobs/m2', 95000, 130000],
  ['mock', 'm3', 'Staff Platform Engineer', 'Fabrikam AI', 'Remote (global)',
    'Fabrikam AI is scaling its inference platform. Kubernetes, Go, TypeScript tooling. Staff level: ' +
    'you set technical direction across 3 teams. Async-first culture, quarterly onsites. Lever ATS.',
    'https://jobs.lever.co/fabrikam/m3', 180000, 240000],
  ['mock', 'm4', 'Junior Web Developer', 'Tailspin Toys', 'Columbus, OH (onsite)',
    'Entry-level role maintaining our Shopify storefront and internal React dashboards. Great mentorship. ' +
    'Onsite five days a week. Workday application portal.',
    'https://tailspin.wd5.myworkdayjobs.com/m4', 55000, 70000],
  ['mock', 'm5', 'Full-Stack Engineer', 'Proseware', 'Remote (US)',
    'Proseware (fintech, Series B) needs a full-stack engineer: TypeScript, React, Node, Postgres. ' +
    'You will pair directly with founders. Fast feedback culture, equity-heavy comp. Email applications ' +
    'to careers@proseware.example.',
    'https://example.com/jobs/m5', 110000, 150000],
];

// ── source: Remotive (free, keyless, remote-first — widens coverage) ──────
/**
 * Adzuna skews US-onsite and USAJOBS is federal-only, which left remote
 * searches — a large share of real job hunting — leaning on a single board.
 * Remotive needs no credential, so it keeps working when a key expires and
 * costs nothing to run.
 */
async function fetchRemotive(profile: Profile): Promise<Posting[]> {
  const terms = [...profile.targetRoles, ...(profile.skills ?? []).slice(0, 2)].join(' ').trim();
  const url =
    'https://remotive.com/api/remote-jobs?limit=20' +
    (terms ? `&search=${encodeURIComponent(terms)}` : '');
  const res = await fetchWithTimeout(url, {}, SOURCE_TIMEOUT_MS);
  if (!res.ok) throw new Error(`Remotive ${res.status}`);
  const data = (await res.json()) as {
    jobs?: Array<{
      id: number | string;
      url: string;
      title: string;
      company_name?: string;
      candidate_required_location?: string;
      salary?: string;
      description?: string;
    }>;
  };
  return (data.jobs ?? []).map((j) => {
    const { min, max } = parseSalaryRange(j.salary);
    return normalize(
      'remotive',
      String(j.id),
      j.title,
      j.company_name ?? 'Unknown',
      j.candidate_required_location || 'Remote',
      stripHtml(j.description ?? ''),
      j.url,
      min,
      max,
    );
  });
}

/** Remotive descriptions are HTML; the scorer reads them as prose. */
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Remotive reports pay as free text ("$100,000 - $120,000", "80k-100k USD",
 * or ""), so it is parsed rather than trusted. Anything unrecognised returns
 * undefined — the comp axis already scores an unlisted salary as neutral,
 * which is honest, whereas a mis-parsed number would silently distort the
 * ranking.
 */
export function parseSalaryRange(raw?: string): { min?: number; max?: number } {
  if (!raw || !raw.trim()) return {};
  const nums: number[] = [];
  for (const m of raw.matchAll(/(\d[\d,.]*)\s*(k\b)?/gi)) {
    const digits = Number(m[1].replace(/,/g, ''));
    if (!Number.isFinite(digits) || digits <= 0) continue;
    const value = m[2] ? digits * 1000 : digits;
    // Ignore figures too small to be an annual salary (hourly rates, years).
    if (value >= 10_000) nums.push(value);
  }
  if (!nums.length) return {};
  const min = Math.min(...nums);
  const max = Math.max(...nums);
  return { min, max: max === min ? undefined : max };
}

function fetchMock(): Posting[] {
  return MOCK_POSTINGS.map((args) => normalize(...args));
}

// ── normalization ──────────────────────────────────────────────────────────
function normalize(
  source: string,
  externalId: string,
  title: string,
  company: string,
  location: string,
  description: string,
  url: string,
  compMin?: number,
  compMax?: number,
): Posting {
  const text = `${location} ${description}`.toLowerCase();
  const remote = /remote|work from home|anywhere/.test(text);
  let atsHint = 'unknown';
  if (/greenhouse/.test(url) || /greenhouse/i.test(description)) atsHint = 'greenhouse';
  else if (/lever\.co/.test(url) || /lever ats/i.test(description)) atsHint = 'lever';
  else if (/workday/i.test(url) || /workday/i.test(description)) atsHint = 'workday';
  else if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(description)) atsHint = 'email';
  return {
    id: postingHash(company, title, location),
    source,
    externalId,
    title,
    company,
    location,
    remote,
    compMin,
    compMax,
    description,
    url,
    atsHint,
    fetchedAt: now(),
  };
}

// ── public API ─────────────────────────────────────────────────────────────
export interface ScanResult {
  newPostings: Posting[];
  found: number;
  duplicates: number;
  sourceErrors: string[];
}

/** Pull from every enabled source, dedupe against what this user has seen.
 *
 *  Sources are fetched CONCURRENTLY: they are independent APIs, and a
 *  miner call is latency-budgeted by the Telegraph node — sequential scans
 *  doubled worst-case latency for zero benefit.
 */
export async function scanForUser(profile: Profile): Promise<ScanResult> {
  const all: Posting[] = [];
  const sourceErrors: string[] = [];

  const tasks: Array<{ name: string; run: () => Promise<Posting[]> }> = [];
  if (config.adzuna.enabled) tasks.push({ name: 'adzuna', run: () => fetchAdzuna(profile) });
  if (config.usajobs.enabled) tasks.push({ name: 'usajobs', run: () => fetchUsaJobs(profile) });
  // Keyless: always available, and the only live source if every key expires.
  if (config.remotive.enabled) tasks.push({ name: 'remotive', run: () => fetchRemotive(profile) });

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));
  settled.forEach((result, i) => {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    } else {
      sourceErrors.push(`${tasks[i].name}: ${String(result.reason)}`);
    }
  });
  if (!tasks.length) {
    all.push(...fetchMock()); // keyless demo mode
  }

  // Intra-batch dedupe on stable hash, then per-user seen filter.
  const unique = new Map<string, Posting>();
  for (const p of all) if (!unique.has(p.id)) unique.set(p.id, p);

  const newPostings: Posting[] = [];
  let duplicates = all.length - unique.size;
  for (const p of unique.values()) {
    savePosting(p);
    if (markSeen(profile.userId, p.id)) newPostings.push(p);
    else duplicates++;
  }

  recordScanRun(profile.userId, all.length, newPostings.length, duplicates);
  return { newPostings, found: all.length, duplicates, sourceErrors };
}
