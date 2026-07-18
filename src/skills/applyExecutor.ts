import { audit, getDraft, now, saveDraft, updateApplication } from '../db.js';
import { config } from '../config.js';
import type { Application, Draft, Posting, Profile } from '../types.js';

/**
 * apply-executor — approval-gated, always.
 *
 * HARD GATE: refuses to run unless the application record carries a recorded
 * approval event (status 'approved' + approvalAt timestamp + draft id).
 * The draft is frozen (immutable) at submission time as dispute evidence.
 */
export interface SubmitResult {
  ok: boolean;
  receipt?: string;
  error?: string;
}

/**
 * Where a submission will go. Resolved from the posting BEFORE approval so
 * the owner sees the exact recipient in the final preview — a posting that
 * embeds a hostile email address is visible, not silently used.
 */
export type SubmissionTarget = { method: 'email'; to: string } | { method: 'link'; url: string };

export function resolveSubmissionTarget(posting: Posting): SubmissionTarget {
  const email = extractEmail(posting.description);
  return email ? { method: 'email', to: email } : { method: 'link', url: posting.url };
}

export async function submitApplication(
  app: Application,
  profile: Profile,
  posting: Posting,
): Promise<SubmitResult> {
  // ── the gate ─────────────────────────────────────────────────────────────
  if (app.status === 'submitted') {
    audit('apply-executor', 'REFUSED_DOUBLE_SUBMIT', `app=${app.id}`);
    return { ok: false, error: 'Refused: this application was already submitted.' };
  }
  if (app.status !== 'approved' || !app.approvalAt || !app.draftId) {
    audit('apply-executor', 'REFUSED_NO_APPROVAL', `app=${app.id} status=${app.status}`);
    return { ok: false, error: 'Refused: no recorded approval for this application.' };
  }
  const draft = getDraft(app.draftId);
  if (!draft) return { ok: false, error: 'Refused: approved draft not found.' };

  // Freeze the draft — dispute evidence must be immutable.
  if (!draft.immutable) {
    draft.immutable = true;
    saveDraft(draft);
  }

  let result: SubmitResult;
  const target = resolveSubmissionTarget(posting);
  if (target.method === 'email' && config.gmail.enabled) {
    result = await sendViaGmail(profile, draft, target.to);
  } else if (target.method === 'email') {
    // Keyless demo mode: simulate the email path.
    result = {
      ok: true,
      receipt: `SIMULATED email to ${target.to} at ${now()} (Gmail OAuth not configured) — subject: "${draft.emailSubject}"`,
    };
  } else {
    // Direct-link path: no programmatic submit available for this ATS yet —
    // record the prepared application and hand the user the link.
    result = {
      ok: true,
      receipt: `Prepared for ${posting.atsHint ?? 'unknown'} ATS at ${now()} — apply link: ${posting.url}. Draft frozen as v${draft.version}.`,
    };
  }

  if (result.ok) {
    app.status = 'submitted';
    app.submittedAt = now();
    app.receipt = result.receipt;
    updateApplication(app);
    audit('apply-executor', 'SUBMITTED', `app=${app.id} posting=${app.postingId} draft=${draft.id} v${draft.version}`);
  } else {
    app.status = 'failed';
    app.receipt = result.error;
    updateApplication(app);
    audit('apply-executor', 'FAILED', `app=${app.id} err=${result.error}`);
  }
  return result;
}

function extractEmail(text: string): string | undefined {
  return text.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0];
}

// ── Gmail send (user's real address, gmail.send scope only) ────────────────

async function getAccessToken(): Promise<string> {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: config.gmail.clientId,
      client_secret: config.gmail.clientSecret,
      refresh_token: config.gmail.refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`Gmail token refresh failed: ${res.status}`);
  const data = (await res.json()) as { access_token: string };
  return data.access_token;
}

async function sendViaGmail(profile: Profile, draft: Draft, to: string): Promise<SubmitResult> {
  try {
    const token = await getAccessToken();
    const rfc822 =
      `To: ${to}\r\n` +
      `Subject: ${draft.emailSubject}\r\n` +
      `Content-Type: text/plain; charset=utf-8\r\n\r\n` +
      draft.emailBody;
    const raw = Buffer.from(rfc822).toString('base64url');
    const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) return { ok: false, error: `Gmail send failed: ${res.status} ${await res.text()}` };
    const data = (await res.json()) as { id: string };
    return { ok: true, receipt: `Email sent to ${to} at ${now()} via Gmail (message id ${data.id})` };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
