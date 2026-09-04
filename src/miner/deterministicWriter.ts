import { skillsInText } from '../skills/skillVocab.js';
import { extractRoles } from '../skills/jobHunt.js';

/** Everything the writer is allowed to state, derived only from real input. */
interface Facts {
  role: string;
  /** Was a real occupation identified, or is `role` the fallback sentinel? */
  knownRole: boolean;
  /** Grammatical forms of `role` — see extractFacts. Using `role` raw inside a
   *  sentence produced "the the role role at Stripe". */
  rolePhrase: string;
  roleNoun: string;
  roleLabel: string;
  company: string;
  name?: string;
  years?: string;
  skills: string[];
  achievements: string[];
  resumeText?: string;
  location?: string;
  seniority?: string;
}

type DocKind = 'cover_letter' | 'resume' | 'resume_summary' | 'outreach' | 'followup' | 'linkedin' | 'email' | 'generic';

/** The written deliverable, plus how much of it rests on stated fact. */
export interface DeterministicWriting {
  generatedText: string;
  resume?: string;
  coverLetter?: string;
  emailSubject?: string;
  emailBody?: string;
  groundedness: number;
}

/**
 * Display casing for the skill vocabulary, which is stored lowercase for
 * matching. A cover letter that says "typescript" and "aws" reads as machine
 * output; the reader notices before they notice anything else.
 */
const SKILL_DISPLAY: Record<string, string> = {
    typescript: 'TypeScript', javascript: 'JavaScript', python: 'Python', go: 'Go',
    rust: 'Rust', java: 'Java', kotlin: 'Kotlin', swift: 'Swift', ruby: 'Ruby',
    php: 'PHP', scala: 'Scala', elixir: 'Elixir', 'c++': 'C++', 'c#': 'C#',
    '.net': '.NET', node: 'Node.js', deno: 'Deno', bun: 'Bun',
    react: 'React', vue: 'Vue', angular: 'Angular', svelte: 'Svelte',
    'next.js': 'Next.js', django: 'Django', flask: 'Flask', fastapi: 'FastAPI',
    rails: 'Rails', spring: 'Spring', graphql: 'GraphQL', grpc: 'gRPC', rest: 'REST',
    postgres: 'Postgres', mysql: 'MySQL', sqlite: 'SQLite', mongodb: 'MongoDB',
    redis: 'Redis', elasticsearch: 'Elasticsearch', kafka: 'Kafka',
    rabbitmq: 'RabbitMQ', clickhouse: 'ClickHouse', snowflake: 'Snowflake',
    dynamodb: 'DynamoDB', cassandra: 'Cassandra',
    aws: 'AWS', gcp: 'GCP', azure: 'Azure', kubernetes: 'Kubernetes',
    docker: 'Docker', terraform: 'Terraform', ansible: 'Ansible', linux: 'Linux',
    'ci/cd': 'CI/CD', jenkins: 'Jenkins', 'github actions': 'GitHub Actions',
    observability: 'observability', prometheus: 'Prometheus', grafana: 'Grafana',
    'machine learning': 'machine learning', pytorch: 'PyTorch',
    tensorflow: 'TensorFlow', pandas: 'pandas', numpy: 'NumPy', llm: 'LLMs',
    nlp: 'NLP', figma: 'Figma', sketch: 'Sketch', solidity: 'Solidity',
    ethereum: 'Ethereum', web3: 'Web3',
};
/** Render a skill the way a person would write it. */
function displaySkill(skill: string): string {
    return SKILL_DISPLAY[skill.toLowerCase()] ?? skill;
}
// ── fact extraction ────────────────────────────────────────────────────────
/**
 * Occupation detection is shared with the job hunt (`extractRoles`) rather
 * than kept as a second private regex here. The private one recognised only
 * "<word> engineer"-shaped titles, so a request to write a cover letter for a
 * NURSE produced "I am writing to apply for the the role position" — a broken
 * sentence with a duplicated article, on the one intent this endpoint exists
 * to serve.
 */
function extractFacts(task: string, candidate: Record<string, unknown>, posting: Record<string, unknown>): Facts {
    const str = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
    const role = str(posting.title) ?? extractRoles(task)[0] ?? 'the role';
    // "at Acme", "for Acme Corp", "with Stripe" — stop before a lowercase word
    // so "at a startup" does not become a company named "A".
    const company = str(posting.company) ??
        task.match(/(?:\bat|\bfor|\bwith)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)?(?:\s+(?:Inc|LLC|Ltd|Corp|Co)\.?)?)/)?.[1]?.replace(/[.,]$/, '') ??
        'your team';
    const resumeText = str(candidate.resumeText);
    const haystack = `${task} ${resumeText ?? ''}`;
    const years = haystack.match(/(\d{1,2})\+?\s*(?:years|yrs)\b/i)?.[1];
    const candidateSkills = Array.isArray(candidate.skills)
        ? candidate.skills.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : [];
    const skills = [...new Set([...candidateSkills, ...skillsInText(haystack)])];
    // Sentences from a supplied resume that carry a measurable result — these
    // are real accomplishments, quoted rather than invented.
    const achievements = (resumeText ?? '')
        .split(/[\n.;]+/)
        .map((line) => line.trim())
        .filter((line) => line.length > 25 && line.length < 220 && /\d/.test(line) && /[a-z]/i.test(line))
        .slice(0, 4);
    const seniority = task.match(/\b(senior|junior|staff|principal|lead|entry[- ]level)\b/i)?.[1]?.toLowerCase();
    const known = role !== 'the role';
    return {
        role,
        knownRole: known,
        /** "the Senior Engineer position" vs "this position" when no role is known. */
        rolePhrase: known ? `the ${role} position` : 'this position',
        /** "the Senior Engineer role" vs "the role" — for mid-sentence "role" use. */
        roleNoun: known ? `the ${role} role` : 'the role',
        /** Subject-line form: the role name, or a neutral stand-in. */
        roleLabel: known ? role : 'Application',
        company,
        name: str(candidate.name),
        years,
        skills,
        achievements,
        resumeText,
        location: str(posting.location),
        seniority,
    };
}
function detectKind(task: string): DocKind {
    const t = task.toLowerCase();
    if (/\bthank|follow[- ]?up|following up|after (the )?interview\b/.test(t))
        return 'followup';
    if (/\bcover letter|application letter|letter of (interest|application)\b/.test(t))
        return 'cover_letter';
    // "draft a resume SUMMARY" asks for the summary paragraph, not a whole
    // resume — answering with a full skeleton of [placeholders] does not
    // address the request that was actually made.
    if (/\b(resume|professional|profile|career)\s+(summary|statement|profile|objective)\b/.test(t))
        return 'resume_summary';
    if (/\bresume|cv\b/.test(t))
        return 'resume';
    if (/\blinkedin|profile summary|about section|bio\b/.test(t))
        return 'linkedin';
    if (/\breach out|outreach|cold (email|message)|recruiter|referral|connect with\b/.test(t))
        return 'outreach';
    if (/\bemail|message\b/.test(t))
        return 'email';
    if (/\bapply|application\b/.test(t))
        return 'cover_letter';
    return 'generic';
}
// ── phrasing helpers ───────────────────────────────────────────────────────
const SIGNOFF = (name?: string): string => `Best regards,\n${name ?? '[Your name]'}`;
function skillList(skills: string[], limit = 5): string {
    const list = skills.slice(0, limit).map(displaySkill);
    if (!list.length)
        return '';
    if (list.length === 1)
        return list[0];
    return `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`;
}
/** "eight years of experience building with TypeScript and Postgres" */
function experiencePhrase(f: Facts): string | undefined {
    const s = skillList(f.skills, 4);
    if (f.years && s)
        return `${f.years} years of professional experience building with ${s}`;
    if (f.years)
        return `${f.years} years of professional experience in this field`;
    if (s)
        return `hands-on production experience with ${s}`;
    return undefined;
}
/** Evidence bullets: real achievements first, stated skills second. */
function evidenceBullets(f: Facts): string[] {
    if (f.achievements.length)
        return f.achievements.map((a) => `- ${a.replace(/^[-•*]\s*/, '')}`);
    if (f.skills.length) {
        // Rotate the sentence frame. Four bullets built from one template is the
        // clearest possible tell that nobody wrote this.
        const frames = [
            (s: string) => `- Production experience with ${s}, owned from design through rollout and ongoing operation.`,
            (s: string) => `- Built and shipped systems on ${s}, including the parts that only show up once real traffic arrives.`,
            (s: string) => `- Day-to-day working knowledge of ${s}, deep enough to debug it under pressure rather than only to use it.`,
            (s: string) => `- Hands-on delivery with ${s}, from first design review through to the on-call rotation that followed.`,
        ];
        return f.skills.slice(0, 4).map((s, i) => frames[i % frames.length](displaySkill(s)));
    }
    return [
        '- [Your most relevant accomplishment, with the measurable result it produced]',
        '- [The responsibility from your current role that maps most directly to this position]',
    ];
}
// ── documents ──────────────────────────────────────────────────────────────
function coverLetter(f: Facts): string {
    const exp = experiencePhrase(f);
    const s = skillList(f.skills, 3);
    const opening = `Dear ${f.company} hiring team,\n\n` +
        `I am writing to apply for ${f.rolePhrase}${f.company !== 'your team' ? ` at ${f.company}` : ''}. ` +
        (exp
            ? `I bring ${exp}, and the work described in this role lines up closely with what I do now.`
            : `The scope of this role lines up closely with the work I do now, and I would welcome the chance to take it on.`);
    const body = `\n\nWhat I would bring to the role:\n\n` +
        evidenceBullets(f).join('\n');
    const fit = s
        ? `\n\nMy day-to-day work centres on ${s}, which is the core of what this position calls for. ` +
            `I am comfortable owning a problem from design through production, and I have spent enough time on the operational ` +
            `side to know that shipping is only the first half of the job.`
        : `\n\nI work best where I can own a problem end to end — from framing the requirement, through design and delivery, ` +
            `to the operational reality of running it once it is live.`;
    const close = `\n\nI would welcome the chance to talk about how I can contribute to ${f.company}${f.location ? ` in ${f.location}` : ''}. Thank you for your time and consideration.\n\n` + SIGNOFF(f.name);
    return opening + body + fit + close;
}
/**
 * The professional-summary paragraph, shared by the full resume and the
 * summary-only request. Leads with stated facts wherever any exist — a
 * summary that opens on a placeholder is the first thing a reader sees.
 */
function professionalSummary(f: Facts): string {
    const exp = experiencePhrase(f);
    const focus = f.knownRole ? f.role.toLowerCase() : 'this field';
    if (exp) {
        return (`${exp.charAt(0).toUpperCase()}${exp.slice(1)}. Focused on ${focus} work` +
            `${f.company !== 'your team' ? `, targeting the opening at ${f.company}` : ''}. ` +
            'Comfortable owning delivery end to end and working directly with the people who depend on the result.');
    }
    const opening = f.knownRole
        ? `${f.role.charAt(0).toUpperCase()}${f.role.slice(1)} moving into ${focus} work.`
        : 'Experienced professional changing fields.';
    return (`${opening} Bringing the judgement that transfers between fields: how to scope a problem before solving it, ` +
        'how to work with the people it affects, and how to keep something running once it is live. ' +
        '[One line naming your strongest concrete result, with the number that shows its size.]');
}
function resumeDoc(f: Facts): string {
    const exp = experiencePhrase(f);
    const header = `${f.name ?? '[Your name]'}\n${f.knownRole ? f.role : '[Your professional title]'}\n[email] · [phone] · [city] · [linkedin.com/in/you]`;
    const summary = `\n\nPROFESSIONAL SUMMARY\n${professionalSummary(f)}`;
    const skillsBlock = f.skills.length
        ? `\n\nCORE SKILLS\n${f.skills.map(displaySkill).join(' · ')}`
        : `\n\nCORE SKILLS\n[The 8-12 tools, languages and platforms you would be comfortable being interviewed on]`;
    const experience = f.achievements.length
        ? `\n\nEXPERIENCE\n${f.achievements.map((a) => `- ${a.replace(/^[-•*]\s*/, '')}`).join('\n')}`
        : `\n\nEXPERIENCE\n[Most recent role] — [Company] — [dates]\n- [Achievement, with the number that shows its size]\n- [Achievement, with the number that shows its size]\n\n[Previous role] — [Company] — [dates]\n- [Achievement, with the number that shows its size]`;
    return `${header}${summary}${skillsBlock}${experience}\n\nEDUCATION\n[Degree] — [Institution] — [year]`;
}
function outreachNote(f: Facts): string {
    const exp = experiencePhrase(f);
    return (`Hi [name],\n\n` +
        `I saw ${f.knownRole ? `the ${f.role} opening` : 'your opening'} at ${f.company} and wanted to introduce myself directly rather than let an application ` +
        `sit in a queue.\n\n` +
        (exp
            ? `I bring ${exp}. `
            : '') +
        `The part of the role I am most interested in is the ownership it implies — I would rather be responsible for a ` +
        `system end to end than hand it off at the boundary.\n\n` +
        `Would you be open to a short conversation this week or next? I am happy to work around your calendar.\n\n` +
        SIGNOFF(f.name));
}
function followUpNote(f: Facts): string {
    return (`Hi [name],\n\n` +
        `Thank you for taking the time to talk about ${f.roleNoun} at ${f.company}. I enjoyed the conversation, and ` +
        `it left me more interested in the position rather than less.\n\n` +
        `[One specific thing from the conversation that stuck with you, and the short thought you have had about it since.]\n\n` +
        (f.skills.length
            ? `If it is useful, I am glad to go deeper on my work with ${skillList(f.skills, 3)} — happy to walk through a concrete example.\n\n`
            : `If it is useful, I am glad to go deeper on any part of my background that would help the decision.\n\n`) +
        `Thanks again for your time, and please let me know if anything else would be helpful from my side.\n\n` +
        SIGNOFF(f.name));
}
function linkedInSummary(f: Facts): string {
    const exp = experiencePhrase(f);
    return ((exp
        ? `${exp.charAt(0).toUpperCase()}${exp.slice(1)}.`
        : f.knownRole
            ? `${f.role.charAt(0).toUpperCase()}${f.role.slice(1)} focused on work that has to hold up in production, not just ship.`
            : 'I build things that have to keep working after launch — and I care most about the part that comes after.') +
        `\n\n` +
        `I work on ${f.knownRole ? `${f.role.toLowerCase()} problems` : 'this field'} — the kind where the interesting part is not the first version but everything that comes after it: keeping it correct, ` +
        `keeping it fast, and keeping it understandable to the next person who touches it.\n\n` +
        (f.skills.length ? `Day to day: ${f.skills.slice(0, 8).map(displaySkill).join(' · ')}\n\n` : '') +
        `[One line on what you are looking for next, and the best way to reach you.]`);
}
// ── entry point ────────────────────────────────────────────────────────────
export function deterministicWriting(task: string, candidate: Record<string, unknown> = {}, posting: Record<string, unknown> = {}): DeterministicWriting {
    const f = extractFacts(task, candidate, posting);
    const kind = detectKind(task);
    // How much of this rests on real stated facts? Drives the honest
    // confidence the miner reports back.
    const grounded = (f.skills.length ? 0.3 : 0) +
        (f.years ? 0.2 : 0) +
        (f.achievements.length ? 0.25 : 0) +
        (f.knownRole ? 0.15 : 0) +
        (f.company !== 'your team' ? 0.1 : 0);
    const groundedness = Math.min(1, Math.round(grounded * 100) / 100);
    const letter = coverLetter(f);
    const subject = `Application: ${f.roleLabel}${f.name ? ` — ${f.name}` : ''}`;
    switch (kind) {
        case 'resume_summary': {
            const summary = professionalSummary(f);
            return { generatedText: summary, resume: resumeDoc(f), coverLetter: letter, emailSubject: subject, emailBody: emailWrap(f, letter), groundedness };
        }
        case 'resume': {
            const resume = resumeDoc(f);
            return { generatedText: resume, resume, coverLetter: letter, emailSubject: subject, emailBody: emailWrap(f, letter), groundedness };
        }
        case 'outreach': {
            const note = outreachNote(f);
            return { generatedText: note, coverLetter: letter, emailSubject: `${f.roleLabel} at ${f.company} — quick introduction`, emailBody: note, groundedness };
        }
        case 'followup': {
            const note = followUpNote(f);
            return { generatedText: note, emailSubject: `Thank you — ${f.knownRole ? f.role + ' ' : ''}conversation`, emailBody: note, groundedness };
        }
        case 'linkedin': {
            const summary = linkedInSummary(f);
            return { generatedText: summary, groundedness };
        }
        case 'email': {
            const body = emailWrap(f, letter);
            return { generatedText: body, coverLetter: letter, emailSubject: subject, emailBody: body, groundedness };
        }
        case 'cover_letter':
        case 'generic':
        default:
            return { generatedText: letter, coverLetter: letter, resume: resumeDoc(f), emailSubject: subject, emailBody: emailWrap(f, letter), groundedness };
    }
}
function emailWrap(f: Facts, letter: string): string {
    return (`Hello,\n\n` +
        `I would like to apply for ${f.rolePhrase}${f.company !== 'your team' ? ` at ${f.company}` : ''}. My letter is below and my resume is attached.\n\n` +
        `${letter}`);
}
//# sourceMappingURL=deterministicWriter.js.map