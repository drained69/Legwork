import { INJECTION_GUARD, extractJson, llm, untrusted } from '../llm.js';
import { mentionsSkill, skillsInText } from './skillVocab.js';
import type { Posting, Profile, ScoreBreakdown } from '../types.js';

/**
 * Rubric: skills 40 / comp 20 / location 15 / seniority 15 / culture 10.
 * Comp, location and seniority are deterministic. Skills and culture use the
 * LLM when available, with keyword-overlap heuristics as the keyless fallback.
 * Every sub-score carries a one-line reason — the match card renders these,
 * so there is never a black-box number.
 */
export async function scorePosting(
  profile: Profile,
  posting: Posting,
  opts?: { llmTimeoutMs?: number; useLlm?: boolean },
): Promise<ScoreBreakdown> {
  const comp = scoreComp(profile, posting);
  const location = scoreLocation(profile, posting);
  const seniority = scoreSeniority(profile, posting);
  // `useLlm: false` scores this posting on deterministic axes and keyword
  // heuristics only, with no network call. The hunt uses it to rank the whole
  // board cheaply before spending its small LLM budget on the shortlist.
  const llmScores = opts?.useLlm === false ? null : await scoreWithLlm(profile, posting, opts);
  const { skills, culture } = llmScores ?? scoreHeuristic(profile, posting);

  const total = Math.round(skills.score + comp.score + location.score + seniority.score + culture.score);
  return { skills, comp, location, seniority, culture, total };
}

// ── deterministic sub-scores ───────────────────────────────────────────────

function scoreComp(profile: Profile, posting: Posting): ScoreBreakdown['comp'] {
  if (posting.compMin == null && posting.compMax == null) {
    return { score: 10, max: 20, reason: 'No comp listed — neutral score' };
  }
  const max = posting.compMax ?? posting.compMin ?? 0;
  const min = posting.compMin ?? posting.compMax ?? 0;
  if (max < profile.compFloor) {
    return { score: 0, max: 20, reason: `Top of range $${max.toLocaleString()} is below your $${profile.compFloor.toLocaleString()} floor` };
  }
  if (min >= profile.compFloor) {
    return { score: 20, max: 20, reason: `Entire range $${min.toLocaleString()}–$${max.toLocaleString()} clears your floor` };
  }
  const overlap = (max - profile.compFloor) / Math.max(1, max - min);
  const score = Math.round(8 + overlap * 12);
  return { score, max: 20, reason: `Range straddles your floor — ${Math.round(overlap * 100)}% of it clears $${profile.compFloor.toLocaleString()}` };
}

function scoreLocation(profile: Profile, posting: Posting): ScoreBreakdown['location'] {
  if (posting.remote && profile.remoteOk) {
    return { score: 15, max: 15, reason: 'Remote role, you accept remote' };
  }
  const loc = posting.location.toLowerCase();
  const match = profile.locations.find((l) => l.toLowerCase() !== 'remote' && loc.includes(l.toLowerCase()));
  if (match) return { score: 13, max: 15, reason: `In your target location (${match})` };
  if (posting.remote) return { score: 12, max: 15, reason: 'Remote role (you prefer specific locations)' };
  return { score: 3, max: 15, reason: `Onsite in ${posting.location} — not in your locations` };
}

const SENIORITY_ORDER = ['intern', 'junior', 'mid', 'senior', 'staff', 'principal'];

function detectSeniority(text: string): string {
  const t = text.toLowerCase();
  if (/\bprincipal\b/.test(t)) return 'principal';
  if (/\bstaff\b/.test(t)) return 'staff';
  if (/\bsenior|sr\.?\b/.test(t)) return 'senior';
  if (/\bjunior|entry[- ]level|jr\.?\b/.test(t)) return 'junior';
  if (/\bintern(ship)?\b/.test(t)) return 'intern';
  return 'mid';
}

function scoreSeniority(profile: Profile, posting: Posting): ScoreBreakdown['seniority'] {
  const want = SENIORITY_ORDER.indexOf(profile.seniority.toLowerCase());
  const have = SENIORITY_ORDER.indexOf(detectSeniority(`${posting.title} ${posting.description}`));
  const dist = Math.abs((want === -1 ? 2 : want) - (have === -1 ? 2 : have));
  const score = Math.max(0, 15 - dist * 5);
  const label = SENIORITY_ORDER[have] ?? 'mid';
  const reason =
    dist === 0 ? `Reads as ${label} — exact match` : `Reads as ${label}, you target ${profile.seniority} (${dist} level${dist > 1 ? 's' : ''} off)`;
  return { score, max: 15, reason };
}

// ── LLM sub-scores (skills + culture) ──────────────────────────────────────

interface LlmScores {
  skills: ScoreBreakdown['skills'];
  culture: ScoreBreakdown['culture'];
}

async function scoreWithLlm(profile: Profile, posting: Posting, opts?: { llmTimeoutMs?: number }): Promise<LlmScores | null> {
  const system =
    `You are a job-match scorer. ${INJECTION_GUARD} ` +
    'Reply with ONLY a JSON object: {"skills": {"score": 0-40, "reason": "one line"}, ' +
    '"culture": {"score": 0-10, "reason": "one line"}}. ' +
    'skills = how well the candidate skills/experience cover the posting requirements. ' +
    'culture = fit between posting culture signals and what the candidate profile implies. Be strict and specific.';
  const user =
    `Candidate skills: ${profile.skills.join(', ')}\n` +
    `Candidate resume summary: ${profile.resumeText.slice(0, 2000) || '(not provided — score skills on the skills list alone)'}\n` +
    `Dealbreakers: ${profile.dealbreakers.join(', ') || 'none'}\n` +
    `Stated priorities (score culture against these when present): ${(profile.factors ?? []).join(', ') || 'none stated'}\n\n` +
    `Job: ${posting.title} at ${posting.company}\n${untrusted(posting.description.slice(0, 4000))}`;
  const reply = await llm(system, user, 400, opts?.llmTimeoutMs);
  if (!reply) return null;
  const parsed = extractJson<{ skills?: { score?: number; reason?: string }; culture?: { score?: number; reason?: string } }>(reply);
  if (!parsed?.skills || !parsed?.culture) return null;
  return {
    skills: { score: clamp(parsed.skills.score, 0, 40), max: 40, reason: parsed.skills.reason ?? 'LLM assessment' },
    culture: { score: clamp(parsed.culture.score, 0, 10), max: 10, reason: parsed.culture.reason ?? 'LLM assessment' },
  };
}

// ── keyless heuristic fallback ─────────────────────────────────────────────

/**
 * Stacks that imply each other in practice: a posting that wants React almost
 * always accepts adjacent frontend skills, "node" implies javascript, etc.
 * Used only for PARTIAL credit — a literal word-boundary match always beats it.
 */
const SKILL_NEIGHBORS: Record<string, string[]> = {
  typescript: ['javascript', 'node', 'react', 'next.js', 'angular', 'vue', 'svelte'],
  javascript: ['typescript', 'node', 'react', 'vue'],
  node: ['javascript', 'typescript'],
  react: ['javascript', 'typescript', 'next.js', 'vue'],
  python: ['django', 'flask', 'fastapi', 'pandas', 'numpy'],
  go: ['golang', 'kubernetes', 'docker'],
  postgres: ['mysql', 'sql', 'database'],
  kubernetes: ['docker', 'terraform', 'aws'],
  aws: ['gcp', 'azure', 'docker', 'kubernetes'],
  'machine learning': ['pytorch', 'tensorflow', 'python', 'nlp'],
};

function scoreHeuristic(profile: Profile, posting: Posting): LlmScores {
  const text = `${posting.title} ${posting.description}`;
  const postingSkills = new Set(skillsInText(text));

  // Word-boundary matching (not substring): "go" must not match "django".
  // Partial credit for adjacent-stack skills so a TypeScript candidate on a
  // JavaScript posting scores meaningfully rather than zero.
  const direct: string[] = [];
  const adjacent: string[] = [];
  for (const skill of profile.skills) {
    if (mentionsSkill(text, skill) || postingSkills.has(skill)) direct.push(skill);
    else if ((SKILL_NEIGHBORS[skill] ?? []).some((n) => postingSkills.has(n))) adjacent.push(skill);
  }
  const denom = profile.skills.length || 1;
  const skillsScore = Math.min(40, Math.round((direct.length + adjacent.length * 0.5) / denom * 40));

  const skillsReason = direct.length
    ? `${direct.length}/${profile.skills.length} of your skills appear${adjacent.length ? ` (${direct.slice(0, 4).join(', ')}) plus adjacent stack (${adjacent.slice(0, 3).join(', ')})` : `: ${direct.slice(0, 4).join(', ')}`}`
    : adjacent.length
      ? `Posting stack is adjacent to your skills (${adjacent.slice(0, 3).join(', ')} → ${[...postingSkills].slice(0, 4).join(', ') || 'related stack'})`
      : profile.skills.length
        ? `Posting stack (${[...postingSkills].slice(0, 4).join(', ') || 'not in vocabulary'}) does not overlap your skills`
        : 'No candidate skills stated — skills axis unscored';

  // Culture axis: when the user stated explicit priority factors, score how
  // many the posting satisfies. Neutral 6/10 only when no factors were given.
  const factors = profile.factors ?? [];
  let culture: LlmScores['culture'];
  if (factors.length) {
    const fHits = factors.filter((f) => text.toLowerCase().includes(f.toLowerCase()));
    culture = {
      score: Math.round((fHits.length / factors.length) * 10),
      max: 10,
      reason: fHits.length
        ? `${fHits.length}/${factors.length} of your factors present: ${fHits.slice(0, 3).join(', ')}`
        : `None of your stated factors (${factors.slice(0, 3).join(', ')}) appear in the posting`,
    };
  } else {
    culture = { score: 6, max: 10, reason: 'No priority factors stated — neutral score' };
  }

  return {
    skills: { score: skillsScore, max: 40, reason: skillsReason },
    culture,
  };
}

function clamp(n: number | undefined, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, Math.round(n ?? lo)));
}
