import { latestDraftVersion, now, saveDraft, uid } from '../db.js';
import { INJECTION_GUARD, extractJson, llm, untrusted } from '../llm.js';
import type { Draft, Posting, Profile } from '../types.js';

/**
 * Drafts a tailored resume variant + cover letter + application email.
 * HARD RULE (enforced in the prompt and the fallback): never fabricate
 * skills, employers, titles, or dates — only reorder and emphasize what is
 * actually in the profile.
 */
export async function tailorApplication(
  profile: Profile,
  posting: Posting,
  feedback?: string,
): Promise<Draft> {
  const generated = (await tailorWithLlm(profile, posting, feedback)) ?? tailorFallback(profile, posting);
  const draft: Draft = {
    id: uid(),
    postingId: posting.id,
    userId: profile.userId,
    version: latestDraftVersion(profile.userId, posting.id) + 1,
    resumeText: generated.resume,
    coverLetter: generated.coverLetter,
    emailSubject: `Application: ${posting.title} — ${profile.name}`,
    emailBody: generated.emailBody,
    createdAt: now(),
    immutable: false,
  };
  saveDraft(draft);
  return draft;
}

interface Generated {
  resume: string;
  coverLetter: string;
  emailBody: string;
}

async function tailorWithLlm(profile: Profile, posting: Posting, feedback?: string): Promise<Generated | null> {
  const system =
    `You tailor job applications. ${INJECTION_GUARD} ` +
    'ABSOLUTE RULE: never invent skills, employers, job titles, dates, degrees, or accomplishments ' +
    'that are not in the candidate resume. You may only reorder, rephrase, and emphasize real content. ' +
    'Reply with ONLY JSON: {"resume": "...", "coverLetter": "...", "emailBody": "..."}. ' +
    'resume = plain-text tailored resume. coverLetter = 3 short paragraphs, specific to the company. ' +
    'emailBody = brief professional email (the resume and cover letter travel with it).';
  const user =
    `Candidate: ${profile.name}\nResume:\n${profile.resumeText.slice(0, 6000)}\n\n` +
    `Target ATS style: ${posting.atsHint ?? 'unknown'}\n` +
    (feedback ? `Owner revision request (trusted): ${feedback}\n` : '') +
    `Job: ${posting.title} at ${posting.company} (${posting.location})\n` +
    untrusted(posting.description.slice(0, 5000));
  const reply = await llm(system, user, 3000);
  if (!reply) return null;
  const parsed = extractJson<Partial<Generated>>(reply);
  if (!parsed?.resume || !parsed.coverLetter || !parsed.emailBody) return null;
  return { resume: parsed.resume, coverLetter: parsed.coverLetter, emailBody: parsed.emailBody };
}

/** Keyless fallback: template assembly from real profile content only. */
function tailorFallback(profile: Profile, posting: Posting): Generated {
  const text = `${posting.title} ${posting.description}`.toLowerCase();
  const matched = profile.skills.filter((s) => text.includes(s.toLowerCase()));
  const ordered = [...matched, ...profile.skills.filter((s) => !matched.includes(s))];

  const resume =
    `${profile.name}\n${profile.email ?? ''}\n\n` +
    `TARGET ROLE: ${posting.title}\n\n` +
    `KEY SKILLS (most relevant first): ${ordered.join(', ')}\n\n` +
    `${profile.resumeText}`;

  const coverLetter =
    `Dear ${posting.company} hiring team,\n\n` +
    `I'm applying for the ${posting.title} role. My background aligns directly with what you're looking for` +
    (matched.length ? ` — in particular ${matched.slice(0, 3).join(', ')}` : '') +
    `.\n\nMy experience:\n${profile.resumeText.slice(0, 400)}\n\n` +
    `I'd welcome the chance to talk about how I can contribute. Thank you for your consideration.\n\n` +
    `Best regards,\n${profile.name}`;

  const emailBody =
    `Hello,\n\nPlease find my application for the ${posting.title} position at ${posting.company}. ` +
    `My tailored resume and cover letter are included below.\n\n---\n\n${coverLetter}\n\n---\n\nRESUME\n\n${resume}\n\n` +
    `Best regards,\n${profile.name}`;

  return { resume, coverLetter, emailBody };
}
