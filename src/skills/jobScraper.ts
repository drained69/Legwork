import { config } from '../config.js';
import { markSeen, now, postingHash, recordScanRun, savePosting } from '../db.js';
import type { Posting, Profile } from '../types.js';

// ── source: Adzuna (free tier, real-time — primary live source) ───────────
async function fetchAdzuna(profile: Profile): Promise<Posting[]> {
  const { appId, appKey, country } = config.adzuna;
  const what = encodeURIComponent(profile.targetRoles.join(' '));
  const where = profile.remoteOk ? '' : `&where=${encodeURIComponent(profile.locations[0] ?? '')}`;
  const url =
    `https://api.adzuna.com/v1/api/jobs/${country}/search/1?app_id=${appId}&app_key=${appKey}` +
    `&results_per_page=20&what=${what}${where}&salary_min=${profile.compFloor}&content-type=application/json`;
  const res = await fetch(url);
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
  const res = await fetch(url, {
    headers: {
      'Authorization-Key': config.usajobs.apiKey,
      'User-Agent': config.usajobs.userAgent,
      Host: 'data.usajobs.gov',
    },
  });
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

/** Pull from every enabled source, dedupe against what this user has seen. */
export async function scanForUser(profile: Profile, engagementId: string): Promise<ScanResult> {
  const all: Posting[] = [];
  const sourceErrors: string[] = [];

  if (config.adzuna.enabled) {
    try {
      all.push(...(await fetchAdzuna(profile)));
    } catch (e) {
      sourceErrors.push(`adzuna: ${String(e)}`);
    }
  }
  if (config.usajobs.enabled) {
    try {
      all.push(...(await fetchUsaJobs(profile)));
    } catch (e) {
      sourceErrors.push(`usajobs: ${String(e)}`);
    }
  }
  if (!config.adzuna.enabled && !config.usajobs.enabled) {
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

  recordScanRun(engagementId, all.length, newPostings.length, duplicates);
  return { newPostings, found: all.length, duplicates, sourceErrors };
}
