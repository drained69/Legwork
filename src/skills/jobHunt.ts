import { audit } from '../db.js';
import { scanForUser } from './jobScraper.js';
import { scorePosting } from './matchScorer.js';
import { renderBreakdown } from '../pipeline.js';
import { INJECTION_GUARD, extractJson, llm, untrusted } from '../llm.js';
import { EXTRACTABLE_SKILLS, mentionsSkill } from './skillVocab.js';
import type { Posting, Profile, ScoreBreakdown } from '../types.js';

/** Criteria shape accepted by the per-call API (POST /api/hunt). */
export interface HuntCriteria {
  roles?: string[];
  seniority?: string;
  locations?: string[];
  compFloor?: number;
  skills?: string[];
  factors?: string[];
}

export interface HuntMatch {
  posting: Posting;
  breakdown: ScoreBreakdown;
}

export interface HuntResult {
  matches: HuntMatch[]; // ranked, best first
  found: number;
  sourceErrors: string[];
  /** Salary midpoints of every ON-TOPIC posting that publishes pay, ascending. */
  salaryPoints: number[];
  /** Best relevance achieved: 3 the requested occupation, 1 merely adjacent. */
  bestTier: number;
}

// Re-exported for callers (and tests) that historically imported these from
// this module; the definitions now live in the shared skillVocab module.
export { EXTRACTABLE_SKILLS, mentionsSkill };
const TOP_N = 10;
/**
 * How many postings get the expensive LLM pass.
 *
 * Sized against the tightest free tier in play (Gemini: 15 requests/minute).
 * One hunt spends 1 call parsing the request plus this many scoring, leaving
 * headroom for concurrent traffic. Raising it past the quota does not improve
 * ranking — it just converts scored postings into 429s.
 */
// 2, not 3. The hunt and the writer share one 15-requests/minute budget, and
// a call spent on the writer is worth more: it moves a document from a
// deterministic draft to a tailored one, where a hunt call only rewrites a
// reason string on a ranking that is already deterministic.
const LLM_SCORE_TOP_N = Number(process.env.LLM_SCORE_TOP_N ?? 2);
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
 * One-shot hunt for the paid per-call API: criteria in → ranked matches out.
 * Uses a unique per-call user id so results are never deduped across
 * unrelated callers.
 *
 * Postings are scored CONCURRENTLY: a miner call is latency-budgeted by the
 * Telegraph node, and sequential per-posting LLM scoring (2-5s each × 20+
 * postings) blew that budget on every routed request.
 */
export async function runAdhocHunt(criteria: HuntCriteria, opts?: { llmTimeoutMs?: number; useLlm?: boolean }): Promise<HuntResult> {
    const profile = criteriaToProfile(criteria, `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const scan = await scanForUser(profile);
    // TWO-PASS SCORING: the rubric ranks, the model explains.
    //
    // Scoring used to call the model once per posting — ~20 concurrent calls
    // per hunt. Gemini's free tier allows 15 requests/MINUTE, so one search
    // exhausted the quota and almost every call came back 429.
    //
    // Pass 1 scores the whole board deterministically (comp, location,
    // seniority + keyword heuristics) with no network at all, and THAT is the
    // ranking — one scale applied to every posting, so the shortlist is
    // genuinely ordered best-first and a caller can compare any two rows.
    //
    // Pass 2 spends the LLM only on the top few, and takes only its REASONS,
    // never its numbers. Letting it rewrite scores mixed two incomparable
    // scales in one list: a keyword-scored posting that never earned the LLM
    // pass could outrank an LLM-scored one, which is how a DevOps role came
    // first on a backend search. The model is better at explaining a match in
    // a sentence than a keyword count is; it is not better at being a
    // consistent unit of measurement.
    const cheap = await Promise.all(scan.newPostings.map(async (posting) => ({
        posting,
        breakdown: await scorePosting(profile, posting, { ...opts, useLlm: false }),
    })));
    cheap.sort((a, b) => b.breakdown.total - a.breakdown.total);

    const refinedReasons = await Promise.all(cheap.slice(0, LLM_SCORE_TOP_N).map(async (m) => {
        const llmScored = await scorePosting(profile, m.posting, opts);
        return {
            posting: m.posting,
            // Deterministic totals and sub-scores are kept verbatim; only the
            // human-readable explanations are upgraded.
            breakdown: {
                ...m.breakdown,
                skills: { ...m.breakdown.skills, reason: llmScored.skills.reason },
                culture: { ...m.breakdown.culture, reason: llmScored.culture.reason },
            },
        };
    }));
    const scored = [...refinedReasons, ...cheap.slice(LLM_SCORE_TOP_N)];
    // RELEVANCE GATE. The rubric awards up to ~56 points for location,
    // seniority and comp BEFORE a single skill matches, so an unrelated
    // posting scores in the 40s on any query. Ranking alone therefore cannot
    // separate "best match" from "board filler", and slicing the top N used to
    // answer an accounting search with a truck-driving job at 44/100 — a
    // confident, well-formatted, completely wrong answer, which is worth less
    // than no answer at all.
    //
    // So topicality is judged separately from score: a posting must actually be
    // ABOUT what was asked for. When nothing is topical we return an empty
    // shortlist and say so, rather than dressing up whatever the board sent.
    // Relevance outranks the rubric: the requested occupation comes first, and
    // the rubric only orders postings that are equally on topic. Without this
    // an adjacent role with better pay took the top slot on every search.
    // Relevance FILTERS; the rubric RANKS.
    //
    // Sorting by relevance first put a 29/100 above an 86/100 — correct by
    // topic, but it reads as a broken ranking to anyone looking at the
    // numbers, and the score is the thing we ask readers to trust.
    //
    // So the shortlist is narrowed to the best class of match actually
    // available and then ordered by score, which stays monotonic. A search
    // for a BACKEND engineer that finds real backend roles no longer shows a
    // React role at all; if only adjacent roles exist, they are returned and
    // named as adjacent rather than dressed up as the requested occupation.
    const graded = scored
        .map((m) => ({ ...m, tier: relevanceTier(profile, m.posting) }))
        .filter((m) => m.tier > 0);
    const bestTier = graded.reduce((best, m) => Math.max(best, m.tier), 0);
    // Keep the best class and the one just below it — strictly the best class
    // alone would often leave a single result.
    const floor = Math.max(bestTier - 1, 1);
    const matches = graded
        .filter((m) => m.tier >= floor)
        .sort((a, b) => b.breakdown.total - a.breakdown.total);
    // Pay questions are answered from EVERY on-topic posting that publishes a
    // salary, not just the ten returned. Sampling only the shortlist meant a
    // question like "what does a data analyst earn" often had fewer than three
    // figures to work with and silently fell back to a job listing — which is
    // not an answer to a question about money.
    const salaryPoints = graded
        .map((m) => {
            const { compMin, compMax } = m.posting;
            if (compMin && compMax) return (compMin + compMax) / 2;
            return compMin || compMax || 0;
        })
        .filter((v) => v > 0)
        .sort((a, b) => a - b);
    audit('job-hunt', 'API_HUNT', `found=${scan.found} topical=${graded.length} best_tier=${bestTier} shortlisted=${Math.min(matches.length, TOP_N)}`);
    return { matches: matches.slice(0, TOP_N), found: scan.found, sourceErrors: scan.sourceErrors, salaryPoints, bestTier };
}
/** Words that carry no topic and must never make a posting look relevant. */
const TOPIC_STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'of', 'for', 'in', 'at', 'to', 'with', 'on',
    'job', 'jobs', 'role', 'roles', 'position', 'positions', 'opening', 'openings',
    'work', 'working', 'career', 'careers', 'hiring', 'entry', 'level', 'part',
    'full', 'time', 'remote', 'onsite', 'hybrid', 'senior', 'junior', 'staff',
    'principal', 'lead', 'mid', 'near', 'me', 'my', 'i', 'want', 'need', 'looking',
]);
/**
 * Is this posting actually ABOUT what the caller asked for?
 *
 * Deliberately generous — one solid signal is enough, because the cost of
 * dropping a real match is higher than the cost of keeping a marginal one.
 * What it refuses to do is pass a posting that shares NOTHING with the
 * request but happens to sit in the right city at the right salary.
 */
/**
 * HOW WELL does this posting match what was asked for, 0-3?
 *
 * A boolean gate could only answer "is this on topic at all", so a search for
 * a SENIOR BACKEND ENGINEER put "Senior React Full-stack Developer" and
 * "Senior QA Engineer" at the top: they pass at occupation-FAMILY level, and
 * the rubric never scored title relevance at all — those 86/100s came from
 * pay, location and seniority. The requested occupation has to outrank an
 * adjacent one, so relevance is graded and used as the primary sort key.
 *
 *   3 — the occupation itself: head noun AND a qualifier ("backend engineer")
 *   2 — the head noun alone ("engineer"), or the full role phrase in the body
 *   1 — adjacent: a named skill appears, or the same occupation family
 *   0 — unrelated; dropped from the shortlist entirely
 */
export function relevanceTier(profile: Profile, posting: Posting): 0 | 1 | 2 | 3 {
    const title = posting.title.toLowerCase();
    const full = `${posting.title} ${posting.description}`.toLowerCase();
    let headOnly = false;
    // Topic terms come from the requested roles; skills are a second signal.
    const roleWords = profile.targetRoles
        .flatMap((r) => r.toLowerCase().split(/[^a-z0-9+#.]+/))
        .filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w));
    // No topic was stated at all (bare criteria, or an unparseable request) —
    // there is nothing to be off-topic about, so keep the ranking as-is.
    if (!roleWords.length && !profile.skills.length)
        return 2;
    // A role word in the TITLE is the strongest signal — but for a multi-word
    // role the HEAD noun has to be one of them. Accepting any single word meant
    // "product manager" matched "SaaS Product Support Jedi" on the word
    // "product" alone. The head noun is what names the occupation; the rest
    // only qualifies it.
    for (const role of profile.targetRoles) {
        const words = role.toLowerCase().split(/[^a-z0-9+#.]+/).filter((w) => w.length > 2 && !TOPIC_STOPWORDS.has(w));
        if (!words.length)
            continue;
        const head = words[words.length - 1];
        const headInTitle = title.includes(head) || stemMatches(title, head);
        if (!headInTitle)
            continue;
        // Single-word role ("accounting"): the head alone is the whole claim.
        if (words.length === 1)
            return 3;
        // Multi-word: a qualifier corroborating the head noun means this is
        // the requested occupation, not merely an adjacent one.
        const qualifierInTitle = words.slice(0, -1).some((w) => title.includes(w) || stemMatches(title, w));
        if (qualifierInTitle || title.includes(role.toLowerCase()))
            return 3;
        // Head noun alone: right family of work, wrong specialisation.
        headOnly = true;
    }
    if (headOnly)
        return 2;
    // A named skill anywhere in the posting is a genuine topical hit, but a
    // weaker one than the job title naming the occupation.
    if (profile.skills.some((skill) => mentionsSkill(full, skill)))
        return 1;
    // Same occupation FAMILY. "Backend engineer" and "Web Developer" are
    // adjacent roles a job seeker genuinely wants to see; "Truck Driver" is
    // not. Without this the gate was correct but too blunt — it dropped
    // reasonable neighbours along with the filler.
    const wanted = familiesOf(roleWords.join(' '));
    if (wanted.size) {
        for (const fam of familiesOf(title))
            if (wanted.has(fam))
                return 1;
    }
    // Last resort: the COMPLETE role phrase appears in the posting body.
    // Counting individual role words here was far too loose — "product" and
    // "manager" both appear in almost any job description, which is how a
    // search for a product manager surfaced a Head of Marketing. Requiring the
    // whole phrase keeps the signal without the false positives.
    const phraseInBody = profile.targetRoles.some((role) => {
        const phrase = role.toLowerCase().trim();
        return phrase.includes(' ') && full.includes(phrase);
    });
    return phraseInBody ? 2 : 0;
}

/** Unchanged boolean view of the gate: anything above 0 is on topic. */
export function isTopical(profile: Profile, posting: Posting): boolean {
    return relevanceTier(profile, posting) > 0;
}
/**
 * Occupation families. Membership is what lets an adjacent title through
 * while still refusing an unrelated one — the difference between a useful
 * near-miss and board filler.
 */
const OCCUPATION_FAMILIES = {
    software: /\b(engineer|engineering|developer|development|programmer|architect|devops|sre|swe|coder|full[- ]?stack|frontend|front[- ]end|backend|back[- ]end|platform|infrastructure|mobile|ios|android|qa|test automation)\b/i,
    data: /\b(data|analyst|analytics|scientist|science|statistician|bi|business intelligence|machine learning|ml|ai)\b/i,
    design: /\b(design|designer|ux|ui|user experience|user interface|creative|graphic|product design)\b/i,
    marketing: /\b(marketing|marketer|seo|sem|brand|branding|content|social media|communications|pr|growth)\b/i,
    finance: /\b(account|accounting|accountant|bookkeep|bookkeeper|audit|auditor|finance|financial|controller|payroll|tax|treasury|analyst financial)\b/i,
    health: /\b(nurse|nursing|rn|lpn|crna|physician|doctor|medical|clinical|clinician|healthcare|therapist|pharmac|dental|dentist|caregiver|patient)\b/i,
    sales: /\b(sales|salesperson|account executive|account manager|business development|bdr|sdr|retail associate)\b/i,
    support: /\b(support|customer service|customer success|help ?desk|service desk|call cent)\b/i,
    product: /\b(product manager|product owner|project manager|program manager|scrum|product management)\b/i,
    operations: /\b(operations|logistics|supply chain|warehouse|fulfil|inventory|procurement)\b/i,
    transport: /\b(driver|driving|cdl|trucking|truck|courier|delivery|chauffeur|rideshare)\b/i,
    education: /\b(teacher|teaching|professor|instructor|tutor|educator|faculty|lecturer)\b/i,
    legal: /\b(attorney|lawyer|paralegal|legal|counsel|compliance)\b/i,
    trades: /\b(electrician|plumber|carpenter|welder|machinist|hvac|technician|mechanic|maintenance)\b/i,
    hospitality: /\b(chef|cook|server|bartender|barista|hotel|hospitality|housekeep|waiter|waitress)\b/i,
    hr: /\b(recruit|recruiter|talent|human resources|hr |people ops|staffing)\b/i,
    security: /\b(security|cyber|infosec|soc analyst|penetration|appsec)\b/i,
};
function familiesOf(text: string): Set<string> {
    const found = new Set<string>();
    for (const [name, pattern] of Object.entries(OCCUPATION_FAMILIES)) {
        if (pattern.test(text))
            found.add(name);
    }
    return found;
}
/**
 * Match across the noun/gerund/agent forms of the same occupation, so
 * "accounting" finds "Accountant" and "nursing" finds "Nurse". Job boards
 * title postings with whichever form they please.
 */
function stemMatches(haystack: string, word: string): boolean {
    const stem = word.replace(/(ing|ers|er|ors|or|ants|ant|ists|ist|s)$/, '');
    if (stem.length < 4)
        return false;
    return new RegExp(`\\b${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(haystack);
}
/**
 * Turn a free-text request into hunt criteria.
 *
 * A caller sends natural language ("Find senior React roles, remote, $150k+"), not a
 * filled-in form. This is the bridge that lets the agent serve the request
 * autonomously.
 *
 * SECURITY: the brief is untrusted third-party text. It is wrapped in the
 * standard guard tags and only ever used to fill these six fields — it never
 * becomes an instruction.
 */
export async function criteriaFromBrief(title: string, description = '', opts?: { llmTimeoutMs?: number }): Promise<HuntCriteria> {
    const brief = `${title}\n${description}`.trim();
    // HEURISTIC FIRST. This used to call the model on every request and fall
    // back to the regex extractor only when it failed — sensible when the
    // extractor was weak, wasteful now that it handles field nouns, phrase
    // tightening and ~90 cities. Every skipped call is ~700-1500ms off the
    // response AND one back inside a 15-requests/minute free tier.
    //
    // The model is still worth having for phrasing the regex cannot read, so it
    // is kept for exactly that case: when the cheap path finds no occupation
    // and no skill, there is nothing to search on and the call earns its cost.
    const cheap = heuristicCriteria(brief);
    if (cheap.roles?.length || cheap.skills?.length)
        return cheap;
    const reply = await llm('You extract job-search criteria from a buyer request. ' +
        INJECTION_GUARD +
        ' Reply with ONLY a JSON object: {"roles":string[],"seniority":"junior|mid|senior|staff|principal",' +
        '"locations":string[],"compFloor":number,"skills":string[],"factors":string[]}. ' +
        'Use [] / 0 for anything the request does not state. Never invent a comp floor.', untrusted(brief), 600, opts?.llmTimeoutMs);
    const parsed = reply ? extractJson<Record<string, unknown> & { roles?: string[]; skills?: string[] }>(reply) : null;
    if (parsed && (parsed.roles?.length || parsed.skills?.length))
        return normalizeCriteria(parsed);
    return heuristicCriteria(brief);
}
function normalizeCriteria(c: Record<string, unknown>): HuntCriteria {
    const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).slice(0, 12) : [];
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
    'remote',
    // US
    'san francisco', 'new york', 'seattle', 'austin', 'boston', 'chicago', 'denver',
    'los angeles', 'atlanta', 'portland', 'miami', 'phoenix', 'philadelphia', 'houston',
    'dallas', 'san diego', 'san jose', 'washington', 'nashville', 'charlotte', 'detroit',
    'minneapolis', 'salt lake city', 'las vegas', 'orlando', 'tampa', 'pittsburgh',
    'baltimore', 'sacramento', 'kansas city', 'columbus', 'indianapolis', 'raleigh',
    'st louis', 'cleveland', 'milwaukee', 'new orleans', 'boulder', 'ann arbor',
    // Canada
    'toronto', 'vancouver', 'montreal', 'calgary', 'ottawa',
    // UK / IE
    'london', 'manchester', 'birmingham', 'leeds', 'glasgow', 'edinburgh', 'bristol',
    'cambridge', 'oxford', 'liverpool', 'sheffield', 'cardiff', 'belfast', 'dublin',
    // EU
    'berlin', 'munich', 'hamburg', 'frankfurt', 'amsterdam', 'rotterdam', 'paris',
    'lyon', 'madrid', 'barcelona', 'lisbon', 'porto', 'milan', 'rome', 'zurich',
    'geneva', 'vienna', 'prague', 'warsaw', 'stockholm', 'copenhagen', 'oslo',
    'helsinki', 'brussels',
    // APAC / other
    'bangalore', 'mumbai', 'delhi', 'hyderabad', 'pune', 'chennai', 'singapore',
    'hong kong', 'tokyo', 'seoul', 'sydney', 'melbourne', 'brisbane', 'perth',
    'auckland', 'dubai', 'tel aviv', 'sao paulo', 'mexico city',
];
/**
 * Skill vocabulary for the keyless path lives in skillVocab.ts (shared with
 * the scorer). It exists because production can run WITHOUT an Anthropic key
 * (`llm=false`), so `criteriaFromBrief` falls through to the heuristic —
 * which used to hardcode `skills: []` and drop every stated skill. Skills
 * carry 40 of the 100 rubric points, so an empty list removes the largest
 * scoring axis from every match.
 */
/** Keyless fallback: pull what a regex can honestly see, guess nothing else. */
export function heuristicCriteria(brief: string): HuntCriteria {
    const text = brief.toLowerCase();
    const seniority = ['principal', 'staff', 'senior', 'junior'].find((s) => text.includes(s)) ??
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
export function extractCompFloor(text: string): number | undefined {
    const candidates = [];
    for (const m of text.matchAll(/\$?\s*(\d{2,3})\s*k\b/g))
        candidates.push(Number(m[1]) * 1000);
    for (const m of text.matchAll(/\$\s*([\d,]{5,9})/g))
        candidates.push(Number(m[1].replace(/,/g, '')));
    // A bare 6-figure number ("salary 140000") — only when clearly not a year.
    for (const m of text.matchAll(/\b(\d{6})\b/g))
        candidates.push(Number(m[1]));
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
/**
 * Occupation words the keyless path can recognise.
 *
 * AGENT forms (engineer, accountant, nurse) AND FIELD forms (engineering,
 * accounting, nursing, marketing, sales). Agent forms alone were not enough:
 * people search "accounting jobs" and "marketing jobs" far more often than
 * "accountant" or "marketer", and every one of those extracted no role at
 * all — which sent a bare, topic-free query to the job board and brought
 * back whatever it felt like returning.
 */
const ROLE_NOUNS = new RegExp('\\b(' +
    // agent nouns
    'engineer|developer|programmer|designer|manager|analyst|scientist|architect|' +
    'administrator|consultant|writer|editor|marketer|recruiter|accountant|nurse|' +
    'physician|doctor|therapist|teacher|professor|instructor|technician|mechanic|' +
    'driver|chef|cook|server|cashier|clerk|assistant|associate|specialist|' +
    'coordinator|supervisor|director|officer|attorney|lawyer|paralegal|auditor|' +
    'bookkeeper|salesperson|realtor|agent|researcher|librarian|pharmacist|' +
    'dentist|veterinarian|electrician|plumber|carpenter|welder|machinist|' +
    '.+?smith|' +
    // field / gerund nouns
    'engineering|accounting|marketing|nursing|teaching|sales|design|finance|' +
    'consulting|recruiting|bookkeeping|logistics|operations|security|support|' +
    'research|writing|editing|legal|healthcare|hospitality|construction|' +
    'manufacturing|warehouse|retail|customer service|human resources|data science|' +
    'data|devops|product|project|program|business|administrative|clerical' +
    ')s?\\b', 'i');
/** Trailing location phrases must not become part of the search term. */
const LOCATION_TAIL = /\s+\b(in|near|around|at|based in|within)\b\s+.*$/i;
/**
 * Does this request express job-seeking intent, even without naming a role?
 *
 * "I need a new job", "who is hiring near me", "remote work opportunities" are
 * unmistakably job searches, but they name no occupation — and requiring one
 * made the miner decline 15 of 18 realistic job phrasings, answering "not a
 * job-search query" to people who were plainly asking for work. Declining a
 * real job query is a far worse failure than running a broad search, because
 * the request WAS for us and we sent back nothing.
 */
export const JOB_INTENT =
  /\b(job|jobs|jobbing|work|working|employment|employed|hiring|hire|hires|recruit|recruiting|recruiter|vacancy|vacancies|opening|openings|position|positions|role|roles|career|careers|internship|internships|apprenticeship|graduate scheme|gig|freelance|contract work|opportunit(?:y|ies)|application|applying|apply)\b/i;

/** Boilerplate that carries intent but is useless as a board search term. */
const JOB_INTENT_NOISE =
  /\b(i|we|me|my|need|needs|needed|want|wants|looking|look|find|finding|get|getting|help|please|new|another|some|any|good|best|great|show|give|tell|is|are|am|do|does|did|can|could|would|should|now|right|currently|available|near|nearby|around|here|there|for|to|a|an|the|of|in|on|at|with|and|or|it|that|this|what|which|who|how|much|many|time|switch|switching|change|changing|move|moving|into|out|job|jobs|work|working|employment|hiring|hire|opening|openings|position|positions|role|roles|career|careers|opportunit(?:y|ies)|vacancy|vacancies|listing|listings|posting|postings)\b/gi;

/**
 * Turn a role-less job request into the best board search term available.
 *
 * "internships for computer science students" keeps "internship computer
 * science"; "I need a new job" keeps nothing at all — and an empty term is the
 * honest outcome there, producing a deliberately broad search rather than a
 * confident answer to a question that specified nothing.
 */
export function broadJobTerms(text: string): string {
  const residue = text
    .replace(/[^a-zA-Z0-9+#.\s-]/g, ' ')
    .replace(JOB_INTENT_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Keep "internship"/"graduate"-style qualifiers that the noise filter drops
  // but which genuinely narrow a board search.
  const kept: string[] = [];
  if (/\bintern(ship)?s?\b/i.test(text)) kept.push('internship');
  if (/\b(graduate|new grad|entry[- ]level|junior|no experience)\b/i.test(text)) kept.push('entry level');
  if (/\bpart[- ]?time\b/i.test(text)) kept.push('part time');
  if (/\bapprentice(ship)?\b/i.test(text)) kept.push('apprentice');
  const words = residue.split(' ').filter((w) => w.length > 2).slice(0, 6);
  return [...new Set([...kept, ...words])].join(' ').trim();
}

export function extractRoles(brief: string): string[] {
    const roles: string[] = [];
    for (const fragment of brief.split(/[,.\n;•|]|\band\b/i)) {
        const cleaned = fragment
            .replace(/^\s*(looking for|seeking|find me|find|i want|i need|need|hiring for|who is hiring|open to|interested in|show me|any|are there|what do|what does|how much do)\s+/i, '')
            .replace(/\b(roles?|jobs?|positions?|openings?|vacancies)\b/gi, '')
            // "marketing jobs in Chicago" → "marketing". Without this the city rode
            // along into the board query and matched nothing.
            .replace(LOCATION_TAIL, '')
            .replace(/\b(part|full)[- ]time\b/gi, '')
            .replace(/\b(entry[- ]level|graduate)\b/gi, '')
            .replace(/[^a-z0-9+#./\s-]/gi, ' ')
            .replace(/\s+/g, ' ')
            .trim();
        if (!cleaned || cleaned.length > 60)
            continue;
        const role = tightenRole(cleaned);
        if (!role)
            continue; // must name an actual occupation
        if (!roles.includes(role))
            roles.push(role);
        if (roles.length === 3)
            break;
    }
    return roles;
}
/** Words that may precede an occupation without being part of its name. */
const ROLE_PREFIX_NOISE = new Set([
    'a', 'an', 'the', 'any', 'some', 'good', 'best', 'top', 'great', 'new',
    'remote', 'hybrid', 'onsite', 'local', 'nearby', 'available', 'open',
    'part', 'full', 'time', 'entry', 'level', 'graduate', 'my', 'your',
]);
/**
 * Reduce a cleaned fragment to the occupation itself.
 *
 * The board query is only as good as this string. Passing the whole fragment
 * meant searching for "a data analyst earn" or "remote product manager paying
 * over 180k" — literal phrases no posting contains, which returned nothing at
 * all for perfectly ordinary questions. Keep the role noun plus up to two
 * meaningful words in front of it, and drop the rest.
 */
function tightenRole(fragment: string): string | null {
    const words = fragment.split(/\s+/).filter(Boolean);
    // Last occupation word wins: in "data analyst", "analyst" is the head noun.
    let head = -1;
    for (let i = words.length - 1; i >= 0; i--) {
        if (ROLE_NOUNS.test(words[i])) {
            head = i;
            break;
        }
    }
    if (head === -1)
        return null;
    const qualifiers: string[] = [];
    for (let i = head - 1; i >= 0 && qualifiers.length < 2; i--) {
        const w = words[i].toLowerCase();
        if (ROLE_PREFIX_NOISE.has(w))
            continue;
        // Stop at a word that clearly ends the noun phrase (verbs, prepositions).
        if (/^(earn|earns|earning|pay|pays|paying|make|makes|making|with|over|under|above|below|for|from|to|into|that|who|which|moving|switching|transition|transitioning)$/.test(w))
            break;
        qualifiers.unshift(words[i]);
    }
    return [...qualifiers, words[head]].join(' ').trim() || null;
}
/**
 * Shortlist rendering. compact=false → one-line-per-match summary for chat;
 * full=true → complete per-axis breakdowns (the deliverable / details view).
 */
export function formatShortlist(profile: Profile, matches: HuntMatch[], found: number, full = false): string {
    const lines = [];
    lines.push(`🔎 Job hunt results — top ${matches.length} of ${found} postings, scored against your criteria`);
    lines.push(`Criteria: ${profile.targetRoles.join('/')} • ${profile.seniority} • ${profile.locations.join(', ')} • ` +
        `$${profile.compFloor.toLocaleString()}+ floor` +
        ((profile.factors ?? []).length ? ` • factors: ${(profile.factors ?? []).join(', ')}` : ''));
    lines.push('');
    matches.forEach((m, i) => {
        const comp = m.posting.compMin || m.posting.compMax
            ? `$${(m.posting.compMin ?? 0).toLocaleString()}–$${(m.posting.compMax ?? 0).toLocaleString()}`
            : 'comp not listed';
        lines.push(`${i + 1}. [${m.breakdown.total}/100] ${m.posting.title} @ ${m.posting.company}`);
        lines.push(`   ${comp} • ${m.posting.location}${m.posting.remote ? ' • remote' : ''}`);
        lines.push(`   ${m.posting.url}`);
        if (full) {
            lines.push(renderBreakdown(m.breakdown)
                .split('\n')
                .map((l) => '   ' + l)
                .join('\n'));
        }
        else {
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
    return (`📋 Your hunt criteria — confirm before I start:\n\n` +
        `Roles: ${profile.targetRoles.join(', ')}\n` +
        `Qualification level: ${profile.seniority}\n` +
        `Locations: ${profile.locations.join(', ')} (remote ${profile.remoteOk ? 'ok' : 'no'})\n` +
        `Comp floor: $${profile.compFloor.toLocaleString()}\n` +
        `Skills/qualifications: ${profile.skills.join(', ')}\n` +
        `Priority factors: ${(profile.factors ?? []).join(', ') || 'none'}\n\n` +
        `Nothing runs until you approve.`);
}
/**
 * Split long shortlists into Telegram-safe chunks (<4096 chars).
 *
 * Splitting on line boundaries alone is not enough: a single line longer than
 * the limit (a pasted resume, a run-on job description) would be emitted as an
 * oversized chunk and rejected on send. Such a line is hard-split instead.
 */
export function chunkMessage(text: string, limit = 3500): string[] {
    if (text.length <= limit)
        return [text];
    const chunks = [];
    let current = '';
    const flush = () => {
        if (current)
            chunks.push(current);
        current = '';
    };
    for (const line of text.split('\n')) {
        if (line.length > limit) {
            flush();
            for (let i = 0; i < line.length; i += limit)
                chunks.push(line.slice(i, i + limit));
            continue;
        }
        if (current.length + line.length + 1 > limit)
            flush();
        current += (current ? '\n' : '') + line;
    }
    flush();
    return chunks;
}
//# sourceMappingURL=jobHunt.js.map