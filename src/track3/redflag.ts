import { audit } from '../db.js';
import { INJECTION_GUARD, extractJson, llm, untrusted } from '../llm.js';
import { engineAsk as realEngineAsk, type EngineAskResult } from './telegraph.js';
import { runAdhocHunt } from '../skills/jobHunt.js';
import { config } from '../config.js';

/**
 * Redflag — job-offer due diligence, built ON the Telegraph network.
 *
 * Legwork finds and scores jobs; Redflag answers the question every applicant
 * has at the next step: "is this company — and this posting — what it claims
 * to be?" It fans out to LIVE Telegraph miners through the node's engine and
 * pays per call in USDC:
 *
 *   FRAUD_DETECTION  → is the posting a recruiting scam?
 *   NEWS_SEARCH      → layoffs, funding, scandals at the company
 *   URL_SCAN         → is the career-page URL phishing/malware?
 *   FACT_CHECK       → are the posting's claims true?
 *
 * Two checks are free and always run: a local scam-pattern scan and a comp
 * benchmark against Legwork's own live job-board hunt. Every flag in the
 * final report carries its source (which miner served it) and its cost, so
 * the buyer sees exactly what their money bought.
 *
 * Degradation is honest: a skipped/failed check is reported as such, never
 * silently omitted — an honest "could not verify" beats an invented "clear".
 */

export interface RedflagInput {
  company?: string;
  title?: string;
  description?: string;
  location?: string;
  url?: string;
  compMin?: number;
  compMax?: number;
  /** Free-text alternative: the pasted posting or offer in any shape. */
  text?: string;
}

export type FlagSeverity = 'red' | 'yellow' | 'green' | 'info';

export interface RedflagFlag {
  severity: FlagSeverity;
  title: string;
  detail: string;
  source: string; // "telegraph:miner-slug (INTENT)" | "legwork:comp-benchmark" | "local:heuristics"
  confidence: number;
  costUsd?: number;
}

export interface RedflagCheck {
  id: 'fraud' | 'news' | 'urlscan' | 'facts' | 'comp' | 'heuristics';
  label: string;
  status: 'ok' | 'skipped' | 'failed' | 'cached';
  source: 'telegraph' | 'legwork' | 'local';
  miner?: string;
  intent?: string;
  costUsd: number;
  signalHash?: string;
  summary: string;
}

export type RedflagVerdict = 'clear' | 'caution' | 'avoid' | 'unknown';

export interface RedflagReport {
  label: string;
  confidence: number;
  reason: string;
  verdict: RedflagVerdict;
  company: string;
  role?: string;
  flags: RedflagFlag[];
  questions: string[];
  checks: RedflagCheck[];
  spendUsd: number;
  budgetUsd: number;
}

// ── fact extraction ─────────────────────────────────────────────────────────

export interface RedflagFacts {
  company: string;
  title?: string;
  url?: string;
  claims: string[];
}

const LLM_TIMEOUT_MS = 8_000;

/**
 * Pull the vetting subject out of whatever the caller sent. Structured input
 * wins; free text is parsed (LLM when configured, regex fallback). The text is
 * untrusted third-party content — wrapped in the standard guard tags and used
 * only to fill these four fields, never as instructions.
 */
export async function extractFacts(input: RedflagInput): Promise<RedflagFacts> {
  if (input.company) {
    return {
      company: input.company.trim().slice(0, 120),
      title: input.title?.trim().slice(0, 120) || undefined,
      url: firstUrl(input.url ?? input.description ?? input.text ?? ''),
      claims: claimsFrom(input),
    };
  }
  const text = `${input.title ?? ''}\n${input.description ?? ''}\n${input.text ?? ''}`.trim();
  const viaLlm = await factsViaLlm(text);
  if (viaLlm?.company) return viaLlm;
  return heuristicFacts(text);
}

async function factsViaLlm(text: string): Promise<RedflagFacts | null> {
  if (!text.trim()) return null;
  const reply = await llm(
    'You extract the subject of a job-posting vetting request. ' +
      INJECTION_GUARD +
      ' Reply with ONLY JSON: {"company": string, "title": string, "url": string, "claims": string[]}. ' +
      'company = the hiring organization\'s name; title = the role; url = any http(s) link present; ' +
      'claims = up to 3 short factual claims the posting makes that could be checked (salary figures, ' +
      'funding stage, awards, remote policy). Use "" and [] when absent. Never invent values.',
    untrusted(text.slice(0, 6000)),
    500,
    LLM_TIMEOUT_MS,
  );
  const parsed = reply ? extractJson<Partial<RedflagFacts>>(reply) : null;
  if (!parsed?.company) return null;
  return {
    company: String(parsed.company).trim().slice(0, 120),
    title: parsed.title?.trim().slice(0, 120) || undefined,
    url: parsed.url?.trim() || undefined,
    claims: Array.isArray(parsed.claims) ? parsed.claims.filter((c) => typeof c === 'string' && c.trim()).slice(0, 3) : [],
  };
}

function heuristicFacts(text: string): RedflagFacts {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  // "Senior Engineer at Acme Corp" / "Acme Corp is hiring" beat the line-shape
  // guess — free text rarely puts the company alone on line 2.
  let company: string | undefined;
  const at = text.match(/\b(?:at|@|with|for)\s+([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,2})/);
  if (at?.[1] && !/^(the|this|that|our)$/i.test(at[1])) company = at[1];
  if (!company) {
    const hiring = text.match(/([A-Z][\w&.-]*(?:\s+[A-Z][\w&.-]*){0,2})\s+(?:is\s+)?(?:hiring|is\s+recruiting)/);
    if (hiring?.[1]) company = hiring[1];
  }
  // Telegram paste shape: line 1 title, line 2 company — but only when line 2
  // actually looks like a company name, not the first sentence of the posting.
  if (!company && lines.length >= 2 && looksLikeCompanyName(lines[1])) company = lines[1].slice(0, 120);

  let title: string | undefined = lines[0]?.slice(0, 120);
  if (!title || title === company || (company && title.endsWith(` ${company}`))) {
    const role = text.match(/((?:senior|junior|staff|lead|principal)?\s*[a-z]+(?:\s+[a-z]+)?\s+(?:engineer|developer|designer|manager|analyst|scientist|architect|recruiter|nurse|accountant))/i);
    title = role?.[0]?.trim().slice(0, 120) || undefined;
  }
  return {
    company: (company ?? '').trim().slice(0, 120),
    title,
    url: firstUrl(text),
    claims: claimsFrom({ description: text, compMin: undefined, compMax: undefined }),
  };
}

/** A company name is short, capitalized, and free of sentence punctuation. */
function looksLikeCompanyName(line: string): boolean {
  const words = line.trim().split(/\s+/);
  if (!words.length || words.length > 5) return false;
  if (/[$\d.,;:!?/]/.test(line)) return false;
  return /^[A-Z]/.test(words[0]);
}

function firstUrl(text: string): string | undefined {
  const m = text.match(/https?:\/\/[^\s"'<>)]+/);
  return m?.[0].replace(/[.,;]+$/, '').slice(0, 300);
}

function claimsFrom(input: RedflagInput): string[] {
  const text = `${input.title ?? ''}\n${input.description ?? ''}\n${input.text ?? ''}`;
  const claims: string[] = [];
  for (const sentence of text.split(/[.\n]/)) {
    const s = sentence.trim();
    if (s.length < 8 || s.length > 200) continue;
    if (/(\$\s?\d|\d{2,3}k\b|series [a-c]\b|funded|remote|fortune|forbes|inc\.\s?5000|best places to work|unicorn|ipo)/i.test(s)) {
      claims.push(s);
      if (claims.length === 3) break;
    }
  }
  return claims;
}

// ── local scam heuristics (free, always runs) ───────────────────────────────

export interface HeuristicFlag {
  severity: FlagSeverity;
  title: string;
  detail: string;
}

/**
 * Classic recruiting-scam patterns. Deterministic — the same posting always
 * yields the same flags, which makes the keyless path testable and the paid
 * path auditable (the LLM synthesizes; it does not invent the baseline).
 */
export function scamHeuristics(input: RedflagInput, facts: RedflagFacts): HeuristicFlag[] {
  const text = `${input.title ?? ''} ${input.description ?? ''} ${input.text ?? ''}`.trim();
  const t = text.toLowerCase();
  const flags: HeuristicFlag[] = [];

  const red = (title: string, detail: string): void => { flags.push({ severity: 'red', title, detail }); };
  const yellow = (title: string, detail: string): void => { flags.push({ severity: 'yellow', title, detail }); };

  if (/(application|registration|training|processing|background check|equipment)\s*(fee|cost|charge)|pay\s+(a|the|an)\s*\$?\d+\s*(fee|deposit)|fee\s+is\s+required|pay\s+before/i.test(t)) {
    red('Payment demanded to apply', 'Legitimate employers never charge application, training or equipment fees.');
  }
  if (/(gift card|cash a check|cheque|wire transfer|bitcoin|crypto(wallet)?\s+(deposit|payment)|usdt|send funds)/i.test(t)) {
    red('Payment-channel red flag', 'Gift cards, check cashing or crypto deposits in a hiring context are hallmarks of employment fraud.');
  }
  if (/(telegram|whatsapp|signal)\s*(only|exclusively|-only)|contact\s+(us\s+)?(me\s+)?(only\s+)?(via|on|through)\s+(telegram|whatsapp|signal)/i.test(t)) {
    red('Chat-app-only contact', 'Recruiting that refuses email or an ATS and insists on Telegram/WhatsApp is a known scam pattern.');
  }
  if (/(ssn|social security number|bank (account|details)|driver'?s? licence|driver'?s? license|passport)\s*(number)?\s*(before|upfront|first|now|to apply|prior)/i.test(t)) {
    red('Sensitive data demanded upfront', 'Requests for SSN, bank details or ID numbers before any interview are identity-theft bait.');
  }
  if (/(no interview|required|needed)[^.]{0,30}(hire|start|job)|immediate start[^.]{0,20}(no|without)\s+interview/i.test(t)) {
    red('Hired without an interview', '"No interview required" is not a hiring shortcut — it is the scam itself.');
  }

  if (/(earn|make|pay(ing)?)\s+\$?\d{3,}(\s*[-–]\s*\$?\d{3,})?\s*(\/|per\s)\s*(day|week)/i.test(t)) {
    const m = t.match(/(?:earn|make|pay(?:ing)?)\s+\$?(\d{3,})/);
    const dayly = m && /day/.test(t.slice(t.indexOf(m[1]), t.indexOf(m[1]) + 40));
    if (m && (Number(m[1]) >= 400 || (dayly && Number(m[1]) >= 300))) {
      yellow('Too-good-to-be-true pay', 'Day/week rates this high for unspecified work are a classic bait hook.');
    }
  }
  const freeMail = text.match(/[\w.+-]+@(gmail|hotmail|yahoo|outlook|proton)\.\w+/i);
  if (freeMail && facts.company && facts.company.length > 2) {
    yellow('Free-email contact for a named company', `A "recruiter" for ${facts.company} writing from ${freeMail[0]} is not verifiable — real staff write from the company domain.`);
  }
  if (!facts.company) {
    yellow('No company identified', 'The posting never names the employer — anonymity makes every other check impossible.');
  }
  return flags;
}

// ── comp benchmark (free, Legwork's own hunt) ───────────────────────────────

interface CompBenchmark {
  flag: RedflagFlag | null;
  marketMedian?: number;
}

async function compBenchmark(input: RedflagInput, facts: RedflagFacts): Promise<CompBenchmark> {
  const source = 'legwork:comp-benchmark';
  const role = (input.title ?? facts.title ?? '').trim();
  if (!role) return { flag: null };
  try {
    const hunt = await runAdhocHunt(
      { roles: [role], locations: [input.location?.trim() || 'remote'] },
      { llmTimeoutMs: 6_000 },
    );
    const comps = hunt.matches
      .map((m) => (m.posting.compMin && m.posting.compMax ? (m.posting.compMin + m.posting.compMax) / 2 : m.posting.compMin ?? m.posting.compMax))
      .filter((v): v is number => typeof v === 'number' && v > 0)
      .sort((a, b) => a - b);
    if (!comps.length) {
      return { flag: { severity: 'info', title: 'Comp benchmark unavailable', detail: `Live boards carried no salary data for comparable ${role} roles — nothing to compare the offer against.`, source, confidence: 0.3 } };
    }
    const median = comps[Math.floor(comps.length / 2)];
    const stated = input.compMin ?? input.compMax ?? statedComp(`${input.description ?? ''} ${input.text ?? ''}`);
    if (!stated) {
      return {
        marketMedian: median,
        flag: { severity: 'info', title: 'Comp not stated — market median available', detail: `Comparable ${role} roles pay around $${Math.round(median).toLocaleString()}. Ask for the range early.`, source, confidence: 0.6 },
      };
    }
    if (stated > median * 1.6) {
      return {
        marketMedian: median,
        flag: { severity: 'yellow', title: 'Offer is far above market', detail: `Stated $${stated.toLocaleString()} vs ~$${Math.round(median).toLocaleString()} median for comparable roles — out-of-market pay is the most common bait in job scams.`, source, confidence: 0.7 },
      };
    }
    if (stated < median * 0.6) {
      return {
        marketMedian: median,
        flag: { severity: 'yellow', title: 'Offer is well below market', detail: `Stated $${stated.toLocaleString()} vs ~$${Math.round(median).toLocaleString()} median for comparable roles — negotiate or skip.`, source, confidence: 0.7 },
      };
    }
    return {
      marketMedian: median,
      flag: { severity: 'green', title: 'Comp is in market range', detail: `Stated $${stated.toLocaleString()} sits within the live market for comparable roles (~$${Math.round(median).toLocaleString()} median across ${comps.length} postings).`, source, confidence: 0.75 },
    };
  } catch {
    return { flag: { severity: 'info', title: 'Comp benchmark failed', detail: 'The live job boards could not be scanned for this comparison.', source, confidence: 0.3 } };
  }
}

function statedComp(text: string): number | undefined {
  const k = text.match(/\$\s?(\d{2,3})\s?k/i);
  if (k) return Number(k[1]) * 1000;
  const full = text.match(/\$\s?([\d,]{5,9})/);
  if (full) return Number(full[1].replace(/,/g, ''));
  return undefined;
}

// ── telegraph checks (paid, budget-gated) ───────────────────────────────────

type EngineAsk = (opts: { query: string; intent?: string; preferMiner?: string[]; maxCostUsd?: number }) => Promise<EngineAskResult>;

interface TelegraphCheck {
  id: RedflagCheck['id'];
  label: string;
  intent: string;
  /** Ranks DIRECT-fallback miner choice when the node's router is down. */
  minerKeywords: string[];
  query: (facts: RedflagFacts, input: RedflagInput) => string | null;
}

/** Ranks DIRECT-fallback news miner choice when the node's router is down. */
export const NEWS_MINER_KEYWORDS = ['news', 'search', 'tavily', 'gnews', 'web', 'verity'];

/**
 * The canonical company-news query — shared by the report's news check and
 * the standing watches, so a watch tick and a report within the cache TTL
 * reuse ONE paid signal for the same company instead of paying twice.
 */
export function companyNewsQuery(company: string): string {
  return `Latest news about ${company}: layoffs, hiring freezes, funding rounds, bankruptcy, acquisitions, scandals, executive departures`;
}

/**
 * Conservative per-check price used to decide whether the report budget can
 * afford to run every check in parallel. Above the $0.01 floor these utility
 * miners charge, so the parallel path is taken only when there is genuine
 * headroom; a tighter budget falls back to sequential greedy spend.
 */
const EXPECTED_CHECK_COST_USD = 0.02;

const TELEGRAPH_CHECKS: TelegraphCheck[] = [
  {
    id: 'fraud',
    label: 'Recruiting-scam scan',
    intent: 'FRAUD_DETECTION',
    minerKeywords: ['fraud', 'scam', 'phish', 'detector', 'verity', 'security', 'safe'],
    query: (facts, input) => {
      const excerpt = `${input.title ?? facts.title ?? ''} at ${facts.company || 'an unnamed company'}\n${(input.description ?? input.text ?? '').slice(0, 1500)}`;
      return `Analyze this job posting for recruitment scam and fraud indicators (fake recruiter, fee harvesting, identity theft bait, too-good-to-be-true pay): ${excerpt}`;
    },
  },
  {
    id: 'news',
    label: 'Company news',
    intent: 'NEWS_SEARCH',
    minerKeywords: NEWS_MINER_KEYWORDS,
    query: (facts) => (facts.company ? companyNewsQuery(facts.company) : null),
  },
  {
    id: 'urlscan',
    label: 'Career-page URL scan',
    intent: 'URL_SCAN',
    minerKeywords: ['url', 'scan', 'phish', 'netwire', 'safe', 'ssl', 'cert'],
    query: (facts) => (facts.url ? `Scan this URL for phishing, malware and scam indicators: ${facts.url}` : null),
  },
  {
    id: 'facts',
    label: 'Posting claims fact-check',
    intent: 'FACT_CHECK',
    minerKeywords: ['fact', 'check', 'verify', 'claim', 'verity', 'truth'],
    query: (facts) => (facts.claims.length ? `Fact-check these claims from a job posting by ${facts.company || 'an unnamed company'}: ${facts.claims.join(' | ')}` : null),
  },
];

/**
 * A miner answered, but with an "out of coverage" / "wrong tool" style reply
 * rather than a real signal — the direct fallback's failure mode. Paid for,
 * but worth almost nothing to the verdict.
 */
export function isThinAnswer(distilled: { label?: string; text: string }): boolean {
  return /out_of_coverage|out of coverage|no .{0,40}(supplied|provided|available)|could not be analyzed|not (?:supported|applicable|available)|unavailable/i.test(
    `${distilled.label ?? ''} ${distilled.text.slice(0, 400)}`,
  );
}

/** Distill a miner's raw result into text the synthesizer (or fallback) reads. */
export function distillResult(result: unknown): { label?: string; reason?: string; confidence?: number; text: string } {
  if (result == null) return { text: '(miner returned no content)' };
  if (typeof result === 'string') return { text: result.slice(0, 1500) };
  if (typeof result === 'object') {
    const r = result as Record<string, unknown>;
    const label = pickString(r, ['label', 'verdict', 'answer', 'summary', 'title']);
    const reason = pickString(r, ['reason', 'reasoning', 'explanation', 'detail', 'details', 'content', 'text', 'description']);
    const confidence = typeof r.confidence === 'number' ? r.confidence : undefined;
    // Search-shaped miners (Tavily et al.): an array of results, each with a
    // title/snippet. Top three become the reason; the answer field is often
    // null and the raw JSON blob helps nobody.
    if (!label && !reason && Array.isArray(r.results)) {
      const hits = (r.results as Array<Record<string, unknown>>).slice(0, 3);
      const joined = hits
        .map((hit) => [pickString(hit, ['title']), pickString(hit, ['content', 'snippet', 'summary'])].filter(Boolean).join(' — '))
        .filter(Boolean)
        .join(' | ');
      if (joined) return { label: `${hits.length}+ sources`, reason: joined.slice(0, 1500), text: joined.slice(0, 1500) };
    }
    if (label || reason) return { label, reason, confidence, text: [label, reason].filter(Boolean).join(' — ').slice(0, 1500) };
    return { text: JSON.stringify(result).slice(0, 1500) };
  }
  return { text: String(result).slice(0, 1500) };
}

/** First non-empty string among the candidate fields, trimmed and capped. */
function pickString(record: Record<string, unknown>, fields: string[]): string | undefined {
  for (const field of fields) {
    const v = record[field];
    if (typeof v === 'string' && v.trim()) return v.trim().slice(0, 800);
  }
  return undefined;
}

// ── synthesis ───────────────────────────────────────────────────────────────

interface Synthesis {
  verdict: RedflagVerdict;
  summary: string;
  flags: Array<{ severity: FlagSeverity; title: string; detail: string; source: string; confidence: number }>;
  questions: string[];
}

async function synthesize(
  facts: RedflagFacts,
  input: RedflagInput,
  telegraph: Array<{ check: TelegraphCheck; result: EngineAskResult }>,
  heuristicFlags: HeuristicFlag[],
  compFlag: RedflagFlag | null,
): Promise<Synthesis> {
  const evidence = telegraph
    .map(({ check, result }) => {
      const d = distillResult(result.result);
      return `[${check.label} via ${result.minerName ?? 'miner'} (${check.intent}) confidence=${d.confidence ?? 'n/a'}] ${d.text}`;
    })
    .join('\n');

  const reply = await llm(
    'You are Redflag, a job-offer due-diligence analyst. You receive a job posting plus evidence from ' +
      'independent verification services (miners on the Telegraph network) and local scam heuristics. ' +
      INJECTION_GUARD +
      ' Weigh the evidence and reply with ONLY JSON: {"verdict": "clear"|"caution"|"avoid", "summary": string, ' +
      '"flags": [{"severity": "red"|"yellow"|"green"|"info", "title": string, "detail": string, "source": string, ' +
      '"confidence": number}], "questions": string[]}. Verdict: avoid = scam indicators or serious verified red flags; ' +
      'caution = unresolved warnings; clear = checks passed. flags = the 3-6 most decision-relevant findings, each with ' +
      'the source that produced it (use the miner name shown in the evidence, "local:heuristics" or "legwork:comp-benchmark"). ' +
      'questions = up to 4 sharp questions the candidate should ask the employer. Base every flag on the evidence; never invent facts.',
    untrusted(
      `Subject: ${facts.title ?? 'role'} at ${facts.company || '(company not identified)'}\n` +
        `Posting: ${(input.description ?? input.text ?? '').slice(0, 3000)}\n\n` +
        `Local scam heuristics: ${JSON.stringify(heuristicFlags)}\n` +
        `Comp benchmark: ${compFlag ? `${compFlag.severity} — ${compFlag.title}: ${compFlag.detail}` : 'unavailable'}\n\n` +
        `Telegraph miner evidence:\n${evidence || '(no telegraph checks ran)'}`,
    ),
    1200,
    LLM_TIMEOUT_MS,
  );

  const parsed = reply ? extractJson<Partial<Synthesis>>(reply) : null;
  if (parsed?.verdict && parsed.flags?.length) {
    return {
      verdict: normalizeVerdict(parsed.verdict),
      summary: parsed.summary ?? '',
      flags: parsed.flags
        .filter((f) => f.title && f.detail)
        .slice(0, 6)
        .map((f) => ({ severity: normalizeSeverity(f.severity), title: String(f.title).slice(0, 120), detail: String(f.detail).slice(0, 400), source: String(f.source).slice(0, 120), confidence: clamp01(f.confidence) })),
      questions: (parsed.questions ?? []).filter((q) => typeof q === 'string' && q.trim()).slice(0, 4),
    };
  }
  return fallbackSynthesis(facts, telegraph, heuristicFlags, compFlag);
}

function fallbackSynthesis(
  facts: RedflagFacts,
  telegraph: Array<{ check: TelegraphCheck; result: EngineAskResult }>,
  heuristicFlags: HeuristicFlag[],
  compFlag: RedflagFlag | null,
): Synthesis {
  const flags: Synthesis['flags'] = heuristicFlags.map((f) => ({ ...f, source: 'local:heuristics', confidence: 0.8 }));
  const questions: string[] = [];

  for (const { check, result } of telegraph) {
    if (!result.ok) continue;
    const d = distillResult(result.result);
    const alarming = isAlarmingText(d.text);
    flags.push({
      severity: alarming ? 'red' : 'green',
      title: alarming ? `${check.label}: warning` : `${check.label}: nothing alarming`,
      detail: d.text.slice(0, 400) || `Checked by ${result.minerName ?? 'miner'} — no issues reported.`,
      source: `telegraph:${result.minerName ?? 'miner'}`,
      confidence: d.confidence ?? 0.6,
    });
    if (check.id === 'news' && alarming) questions.push('Ask directly about the negative news coverage and what changed since.');
  }

  if (compFlag) {
    flags.push({ severity: compFlag.severity, title: compFlag.title, detail: compFlag.detail, source: compFlag.source, confidence: compFlag.confidence });
    if (compFlag.severity === 'yellow') questions.push('Ask them to confirm the compensation range in writing before proceeding.');
  }
  if (heuristicFlags.some((f) => f.severity === 'red')) {
    questions.push('Ask why the process deviates from a normal hiring flow — and get the answer in writing.');
  }
  if (!questions.length) questions.push('Ask about team structure and who you would report to.', 'Ask what the interview process looks like from here.');

  const verdict = verdictFromFlags(flags);
  const okChecks = telegraph.filter(({ result }) => result.ok).length;
  const summary =
    `${heuristicFlags.length ? `${heuristicFlags.length} local scam pattern(s) matched. ` : ''}` +
    `${okChecks} of ${telegraph.length} network checks completed` +
    (compFlag ? `; comp benchmark ${compFlag.severity === 'green' ? 'in market' : compFlag.severity === 'yellow' ? 'off market' : 'unavailable'}.` : '.');

  return { verdict, summary, flags: dedupeFlags(flags).slice(0, 8), questions: questions.slice(0, 4) };
}

export function verdictFromFlags(flags: Array<{ severity: FlagSeverity }>): RedflagVerdict {
  if (flags.some((f) => f.severity === 'red')) return 'avoid';
  if (flags.some((f) => f.severity === 'yellow')) return 'caution';
  if (flags.length) return 'clear';
  return 'unknown';
}

/**
 * Remove negated risk words before the alarming-word scan: a miner answering
 * "No scam indicators" is a PASS, and must not trip the scam keyword.
 */
export function stripNegations(text: string): string {
  return text.replace(
    /\b(?:no|zero|not|none|without|free of|no evidence of|no signs? of|didn'?t|did not|wasn'?t)\s+(?:\w+\s+){0,2}\b(scam|fraud|phishing|malware|layoffs?|bankruptcy|investigations?|lawsuits?|data breaches?|ransomware)\b/gi,
    '',
  );
}

/**
 * Does this text contain REAL risk words (negations stripped)? Shared by the
 * fallback synthesis and the standing-watch poller so both judge "alarming"
 * identically.
 */
export function isAlarmingText(text: string): boolean {
  return /\b(scams?|fraud|phishing|malware|layoffs?|bankrupt\w*|investigations?|lawsuits?|data breaches?|ransomware)\b/i.test(stripNegations(text));
}

function dedupeFlags(flags: Synthesis['flags']): Synthesis['flags'] {
  const seen = new Set<string>();
  return flags.filter((f) => {
    const key = `${f.severity}:${f.title.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── the report ──────────────────────────────────────────────────────────────

export async function runRedflag(
  input: RedflagInput,
  opts?: { engineAsk?: EngineAsk; budgetUsd?: number },
): Promise<RedflagReport> {
  const ask = opts?.engineAsk ?? ((o: Parameters<EngineAsk>[0]) => realEngineAsk(o) as Promise<EngineAskResult>);
  const budgetUsd = opts?.budgetUsd ?? config.telegraph.maxSpendUsd;

  const facts = await extractFacts(input);
  const checks: RedflagCheck[] = [];
  let spendUsd = 0;
  let confidence = 0.5;

  // The comp benchmark is a live job-board scan (~2-4s) whose result is only
  // needed at synthesis. It is independent of the paid miner checks, so it
  // runs CONCURRENTLY with them rather than before — overlapping the two
  // slowest phases instead of summing them. The scam heuristics are synchronous.
  const heuristicFlags = scamHeuristics(input, facts);
  const compPromise = compBenchmark(input, facts);

  checks.push({ id: 'heuristics', label: 'Local scam-pattern scan', status: 'ok', source: 'local', costUsd: 0, summary: heuristicFlags.length ? `${heuristicFlags.length} pattern(s) matched` : 'No classic scam patterns matched' });

  const telegraphEvidence: Array<{ check: TelegraphCheck; result: EngineAskResult }> = [];

  /**
   * Visitor-facing text for a failed paid check. The raw engine error
   * ("routing failed: engine returned 402 after payment (miner txlens)") is
   * internal jargon a consumer cannot act on — and it lands on PUBLIC report
   * pages. Translate the failure classes a visitor can understand, keep the
   * exact wording for the audit log.
   */
  const publicFailureSummary = (error: string | undefined): string => {
    const raw = (error ?? '').toLowerCase();
    if (raw.includes('402') || raw.includes('payment')) return 'Check not completed — the network would not accept payment for this check. Nothing was charged.';
    if (raw.includes('unreachable') || raw.includes('timeout') || raw.includes('econnrefused')) return 'Check not completed — the verification network was unreachable. Nothing was charged.';
    if (raw.includes('not configured')) return 'Check not run — the Telegraph consumer wallet is not configured on this deployment.';
    return error ? `Check not completed — ${error.slice(0, 160)}` : 'Check failed. Nothing was charged.';
  };

  /** Fold one miner result into the running spend, checks and confidence. */
  const recordResult = (check: TelegraphCheck, result: EngineAskResult): void => {
    const cost = result.ok ? (result.costUsd ?? 0.01) : 0;
    spendUsd = Math.round((spendUsd + cost) * 1e6) / 1e6;
    if (result.ok) {
      const distilled = distillResult(result.result);
      const thin = isThinAnswer(distilled);
      telegraphEvidence.push({ check, result });
      checks.push({
        id: check.id, label: check.label, status: result.cached ? 'cached' : 'ok', source: 'telegraph',
        miner: result.minerName, intent: check.intent, costUsd: cost, signalHash: result.signalHash,
        summary: distilled.text.slice(0, 300) || 'No content returned',
      });
      // A paid-but-thin answer ("out of coverage") does not inflate confidence
      // the way a real signal does.
      confidence += result.cached ? 0.05 : thin ? 0 : 0.1;
    } else {
      if (!result.skipped) audit('redflag', 'CHECK_FAILED', `${check.id}: ${result.error ?? 'check failed'}`);
      checks.push({ id: check.id, label: check.label, status: result.skipped ? 'skipped' : 'failed', source: 'telegraph', intent: check.intent, costUsd: 0, summary: result.skipped ? (result.error ?? 'check skipped') : publicFailureSummary(result.error) });
      confidence -= result.skipped ? 0.05 : 0.15;
    }
  };

  if (config.telegraph.enabled || opts?.engineAsk) {
    // Evaluate each check's query once, keeping TELEGRAPH_CHECKS order for a
    // stable report regardless of which path runs.
    const evaluated = TELEGRAPH_CHECKS.map((check) => ({ check, query: check.query(facts, input) }));
    const runnable = evaluated.filter((e): e is { check: TelegraphCheck; query: string } => Boolean(e.query));

    // PARALLEL when the budget comfortably covers every runnable check at a
    // conservative per-check price, SEQUENTIAL when it is tight.
    //
    // The four miner calls used to run one after another — ~27s of a visitor
    // staring at a spinner on the flagship "Run full vetting" button. They are
    // independent lookups (fraud, news, URL, fact-check) against different
    // miners, and x402 pays each with its own random EIP-3009 nonce, so firing
    // them at once is safe and cuts the wait to the slowest single check.
    //
    // The catch is the budget: the greedy sequential model lets ONE check use
    // the whole remaining budget, so a naive parallel split would change
    // spending behaviour (and could starve a high-priority check). So parallel
    // runs only when each check's equal share still clears a realistic price
    // — i.e. the budget can afford them all. When it cannot, the sequential
    // path preserves the exact greedy contract (and its tests).
    const fairShareUsd = runnable.length ? Math.floor((budgetUsd / runnable.length) * 1e6) / 1e6 : 0;
    const parallel = runnable.length > 0 && fairShareUsd >= EXPECTED_CHECK_COST_USD;

    if (parallel) {
      // Each call is capped at an equal share, so even if every miner charges
      // its maximum the total can never exceed the budget.
      const settled = await Promise.all(
        runnable.map(({ check, query }) =>
          ask({ query, intent: check.intent, preferMiner: check.minerKeywords, maxCostUsd: fairShareUsd }).then(
            (result) => result,
            (error): EngineAskResult => ({ ok: false, error: error instanceof Error ? error.message : String(error) }),
          ),
        ),
      );
      const resultById = new Map(runnable.map((e, i) => [e.check.id, settled[i]]));
      for (const { check, query } of evaluated) {
        if (!query) {
          checks.push({ id: check.id, label: check.label, status: 'skipped', source: 'telegraph', intent: check.intent, costUsd: 0, summary: 'Nothing to check (input lacked the needed fact)' });
          continue;
        }
        recordResult(check, resultById.get(check.id) as EngineAskResult);
      }
    } else {
      // Tight budget: greedy priority spend, each check gated on what is left.
      for (const { check, query } of evaluated) {
        if (!query) {
          checks.push({ id: check.id, label: check.label, status: 'skipped', source: 'telegraph', intent: check.intent, costUsd: 0, summary: 'Nothing to check (input lacked the needed fact)' });
          continue;
        }
        const remaining = Math.round((budgetUsd - spendUsd) * 1e6) / 1e6;
        if (remaining <= 0) {
          checks.push({ id: check.id, label: check.label, status: 'skipped', source: 'telegraph', intent: check.intent, costUsd: 0, summary: 'Report budget exhausted' });
          confidence -= 0.05;
          continue;
        }
        recordResult(check, await ask({ query, intent: check.intent, preferMiner: check.minerKeywords, maxCostUsd: remaining }));
      }
    }
  } else {
    for (const check of TELEGRAPH_CHECKS) {
      checks.push({ id: check.id, label: check.label, status: 'skipped', source: 'telegraph', intent: check.intent, costUsd: 0, summary: 'Telegraph wallet not configured' });
      confidence -= 0.05;
    }
  }

  const comp = await compPromise;
  checks.splice(1, 0, comp.flag
    ? { id: 'comp', label: 'Comp benchmark (live boards)', status: 'ok', source: 'legwork', costUsd: 0, summary: comp.flag.title }
    : { id: 'comp', label: 'Comp benchmark (live boards)', status: 'skipped', source: 'legwork', costUsd: 0, summary: 'No role identified to benchmark against' });

  const synthesis = await synthesize(facts, input, telegraphEvidence, heuristicFlags, comp.flag);
  if (synthesis.flags.length && telegraphEvidence.length) confidence += 0.05;
  confidence = Math.max(0.1, Math.min(0.95, confidence));

  // THE HONESTY GATE. When the Telegraph side was in play but NOT ONE paid
  // check came back, the report's only evidence is local — a "clear" verdict
  // would claim independent verification that never happened (every check
  // failed, or every check was skipped for budget). Cap it at "caution" and
  // say why, so a public report never reads as a vetted CLEAR while its
  // receipt is four ✗ marks. ("avoid" survives: local scam patterns are
  // evidence FOR a risk, not a claim of verification.)
  const networkChecks = checks.filter((c) => c.source === 'telegraph');
  const networkOk = networkChecks.filter((c) => c.status === 'ok' || c.status === 'cached').length;
  if (synthesis.verdict === 'clear' && networkChecks.length > 0 && networkOk === 0) {
    const failed = networkChecks.filter((c) => c.status === 'failed').length;
    synthesis.verdict = 'caution';
    synthesis.flags.unshift({
      severity: 'yellow',
      title: 'Independent verification did not run',
      detail: failed > 0
        ? `${failed} of ${networkChecks.length} network checks were attempted and none completed (payment or routing failures). This verdict rests on local checks only — nothing was charged.`
        : `None of the ${networkChecks.length} network checks could be bought (budget or input limits). This verdict rests on local checks only — nothing was charged.`,
      source: 'legwork:network-status',
      confidence: 0.95,
    });
    synthesis.summary = `${synthesis.summary} 0 of ${networkChecks.length} network checks completed — verdict capped at caution (local checks only).`.trim();
  }

  // A flag sourced from a telegraph miner carries what that miner's answer
  // cost — the buyer sees what their money bought, flag by flag.
  const flags: RedflagFlag[] = synthesis.flags.map((flag) => ({
    ...flag,
    costUsd: flag.source.startsWith('telegraph:')
      ? checks.find((c) => c.source === 'telegraph' && c.miner !== undefined && flag.source.includes(c.miner))?.costUsd
      : undefined,
  }));

  const verdictEmoji: Record<RedflagVerdict, string> = { clear: 'Clear', caution: 'Caution', avoid: 'Avoid', unknown: 'Unknown' };
  const label = `${verdictEmoji[synthesis.verdict]} — ${facts.company || 'unnamed company'}${facts.title ? ` (${facts.title})` : ''}: ${synthesis.flags.filter((f) => f.severity === 'red' || f.severity === 'yellow').length} warning(s) across ${checks.filter((c) => c.status === 'ok' || c.status === 'cached').length} checks`;

  const reason =
    `${synthesis.summary} ${synthesis.flags
      .map((f) => `[${f.severity}] ${f.title} (${f.source})`)
      .join('; ')}. Miner spend: $${spendUsd.toFixed(2)} of $${budgetUsd.toFixed(2)} budget.`.trim();

  audit('redflag', 'REPORT', `company=${facts.company || 'unknown'} verdict=${synthesis.verdict} spend=$${spendUsd.toFixed(2)} checks=${checks.filter((c) => c.status === 'ok' || c.status === 'cached').length}/${checks.length}`);

  return {
    label,
    confidence: Math.round(confidence * 100) / 100,
    reason,
    verdict: synthesis.verdict,
    company: facts.company || '(not identified)',
    role: facts.title,
    flags,
    questions: synthesis.questions,
    checks,
    spendUsd,
    budgetUsd,
  };
}

// ── presentation ────────────────────────────────────────────────────────────

const SEVERITY_ICON: Record<FlagSeverity, string> = { red: '🔴', yellow: '🟡', green: '🟢', info: '⚪' };

/** Plain-text card (API detail view, logs). Telegram rendering lives in ui.ts. */
export function formatRedflagCard(report: RedflagReport): string {
  const lines: string[] = [];
  lines.push(`${SEVERITY_ICON[report.verdict === 'clear' ? 'green' : report.verdict === 'caution' ? 'yellow' : report.verdict === 'avoid' ? 'red' : 'info']} ${report.label}`);
  lines.push('');
  for (const flag of report.flags) {
    lines.push(`${SEVERITY_ICON[flag.severity]} ${flag.title} — ${flag.detail} [${flag.source}${flag.costUsd ? `, $${flag.costUsd.toFixed(2)}` : ''}]`);
  }
  if (report.questions.length) {
    lines.push('');
    lines.push('Questions to ask:');
    for (const q of report.questions) lines.push(`• ${q}`);
  }
  lines.push('');
  lines.push(`Checks: ${report.checks.map((c) => `${c.label}: ${c.status}${c.costUsd ? ` ($${c.costUsd.toFixed(2)})` : ''}`).join(' · ')}`);
  lines.push(`Miner spend: $${report.spendUsd.toFixed(2)} / $${report.budgetUsd.toFixed(2)} budget · confidence ${report.confidence}`);
  return lines.join('\n');
}

// ── small helpers ───────────────────────────────────────────────────────────

function clamp01(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : 0.5;
  return Math.max(0.05, Math.min(0.95, v));
}

function normalizeVerdict(v: unknown): RedflagVerdict {
  return v === 'clear' || v === 'caution' || v === 'avoid' ? v : 'unknown';
}

function normalizeSeverity(s: unknown): FlagSeverity {
  return s === 'red' || s === 'yellow' || s === 'green' || s === 'info' ? s : 'info';
}

// ── the free preview ────────────────────────────────────────────────────────

/**
 * The free tier: local scam-pattern scan + live comp benchmark, zero miner
 * spend. Paid network checks (scam scan, news, URL, fact-check) are listed
 * as skipped with an honest pointer to the paid report — the preview never
 * pretends to be a full vetting.
 */
export async function runRedflagPreview(input: RedflagInput): Promise<RedflagReport> {
  const ask: EngineAsk = async () => ({
    ok: false,
    skipped: true,
    error: 'Runs in the paid report ($0.05) — this preview is the free local scan',
  });
  // Budget stays at the default: spend is zero anyway (the injected ask never
  // buys), and passing 0 would short-circuit the checks with "budget
  // exhausted" before the honest preview message is attached.
  return runRedflag(input, { engineAsk: ask });
}
