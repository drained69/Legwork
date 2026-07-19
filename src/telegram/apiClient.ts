import { config } from '../config.js';
import { now, recordUsage, uid } from '../db.js';
import { engagementToken } from '../okx/server.js';
import type { Engagement, Posting, Profile, ScoreBreakdown } from '../types.js';

/**
 * Live API client used by the Telegram bot.
 *
 * The bot does NOT call the skills in-process — it makes real HTTP requests to
 * Legwork's own public endpoints, exactly as any third-party agent would. That
 * keeps one code path in production: what the user gets in Telegram is served
 * by the same endpoint OKX buyers pay for.
 *
 * Billing: an OKX engagement is already paid for on the marketplace, so calls
 * made on its behalf carry an engagement token instead of an x402 payment —
 * charging again per call would be double-billing. Every call is written to the
 * usage ledger with the user's X Layer wallet for attribution.
 */

function baseUrl(): string {
  return (config.okx.publicUrl || `http://127.0.0.1:${config.okx.endpointPort}`).replace(/\/$/, '');
}

export interface ApiResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  status: number;
  billing?: string;
}

async function call<T>(
  path: string,
  body: unknown,
  ctx: { profile?: Profile; engagement?: Engagement; service: string; priceUsd: string },
): Promise<ApiResult<T>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };

  // Attribution: which wallet this work was done for.
  if (ctx.profile?.wallet) {
    headers['x-user-wallet'] = ctx.profile.wallet;
    headers['x-user-chain'] = config.x402.network;
  }
  // Authorization: prepaid engagement instead of a per-call x402 charge.
  if (ctx.engagement) {
    headers['x-engagement-id'] = ctx.engagement.id;
    headers['x-engagement-token'] = engagementToken(ctx.engagement.id);
  }

  let status = 0;
  let ok = false;
  let error: string | undefined;
  let data: T | undefined;
  let billing: string | undefined;

  try {
    const res = await fetch(`${baseUrl()}${path}`, { method: 'POST', headers, body: JSON.stringify(body ?? {}) });
    status = res.status;
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok && payload.ok !== false) {
      ok = true;
      data = payload.result as T;
      billing = typeof payload.billing === 'string' ? payload.billing : undefined;
    } else {
      error =
        status === 402
          ? String(payload.error ?? 'This call is not covered by your engagement.')
          : String(payload.error ?? `Request failed (${status})`);
    }
  } catch (err) {
    error = `Could not reach the service: ${String(err)}`;
  }

  if (ctx.profile) {
    recordUsage({
      id: uid(),
      userId: ctx.profile.userId,
      engagementId: ctx.engagement?.id,
      wallet: ctx.profile.wallet,
      service: ctx.service,
      endpoint: path,
      priceUsd: ctx.priceUsd,
      paid: billing !== 'engagement',
      status,
      at: now(),
    });
  }

  return { ok, data, error, status, billing };
}

// ── typed service wrappers ─────────────────────────────────────────────────

export interface HuntApiResult {
  found: number;
  matches: Array<{ posting: Posting; score: number; breakdown: ScoreBreakdown }>;
  sourceErrors: string[];
}

/** Criteria payload derived from the stored profile — sent over the wire. */
export function criteriaFromProfile(p: Profile): Record<string, unknown> {
  return {
    roles: p.targetRoles,
    seniority: p.seniority,
    locations: p.locations,
    compFloor: p.compFloor,
    skills: p.skills,
    factors: p.factors ?? [],
  };
}

export function huntViaApi(profile: Profile, engagement?: Engagement): Promise<ApiResult<HuntApiResult>> {
  return call<HuntApiResult>('/api/hunt', criteriaFromProfile(profile), {
    profile,
    engagement,
    service: 'job-hunt',
    priceUsd: '0.05',
  });
}

export interface PreviewApiResult {
  shown: number;
  totalMatches: number;
  previewsRemainingThisHour: number;
  matches: Array<{ title: string; company: string; location: string; url: string; score: number; why: string[] }>;
}

export function previewViaApi(profile: Profile): Promise<ApiResult<PreviewApiResult>> {
  // The free endpoint returns its payload at the top level, not under `result`.
  return callFlat<PreviewApiResult>('/api/hunt/preview', criteriaFromProfile(profile), profile);
}

async function callFlat<T>(path: string, body: unknown, profile: Profile): Promise<ApiResult<T>> {
  try {
    const res = await fetch(`${baseUrl()}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(profile.wallet ? { 'x-user-wallet': profile.wallet } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    recordUsage({
      id: uid(), userId: profile.userId, wallet: profile.wallet, service: 'preview',
      endpoint: path, priceUsd: '0.00', paid: false, status: res.status, at: now(),
    });
    if (!res.ok) return { ok: false, error: String(payload.error ?? `Request failed (${res.status})`), status: res.status };
    return { ok: true, data: payload as T, status: res.status };
  } catch (err) {
    return { ok: false, error: `Could not reach the service: ${String(err)}`, status: 0 };
  }
}

export interface ScoreApiResult {
  score: number;
  breakdown: ScoreBreakdown;
}

export function scoreViaApi(
  profile: Profile,
  posting: { title: string; company: string; description: string; location?: string; compMin?: number; compMax?: number; url?: string },
  engagement?: Engagement,
): Promise<ApiResult<ScoreApiResult>> {
  return call<ScoreApiResult>('/api/score', { criteria: criteriaFromProfile(profile), posting }, {
    profile,
    engagement,
    service: 'score-posting',
    priceUsd: '0.01',
  });
}

export interface TailorApiResult {
  resume: string;
  coverLetter: string;
  emailSubject: string;
  emailBody: string;
}

export function tailorViaApi(
  profile: Profile,
  posting: { title: string; company: string; description: string; location?: string; url?: string },
  engagement?: Engagement,
): Promise<ApiResult<TailorApiResult>> {
  return call<TailorApiResult>('/api/tailor', {
    candidate: {
      name: profile.name,
      resumeText: profile.resumeText,
      skills: profile.skills,
      email: profile.email,
    },
    posting,
  }, { profile, engagement, service: 'tailor-application', priceUsd: '0.10' });
}

/** Free catalog — powers the menu's live service list. */
export async function fetchCatalog(): Promise<{
  services: Array<{ id: string; endpoint: string; priceUsd: string; description: string }>;
  freeTier?: { endpoint: string; limitPerHour: number };
  payment?: { network: string; assetSymbol: string };
} | null> {
  try {
    const res = await fetch(`${baseUrl()}/api/services`);
    if (!res.ok) return null;
    return (await res.json()) as never;
  } catch {
    return null;
  }
}

export async function serviceHealthy(): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl()}/health`);
    return res.ok;
  } catch {
    return false;
  }
}
