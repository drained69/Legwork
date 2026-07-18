import { audit, consumeNonce, now, savePayment, uid } from '../db.js';
import { config } from '../config.js';

/**
 * x402 seller-side implementation (OKX Agent Payments Protocol).
 *
 * Flow:
 *   1. Client calls a paid endpoint with no payment → HTTP 402 with:
 *        - `PAYMENT-REQUIRED` header: base64 JSON challenge   (x402 v2)
 *        - `x402Version` JSON body                            (x402 v1 compat)
 *      The challenge advertises `accepts[]`: scheme `exact`, network, asset,
 *      amount (base units), payTo, and an outputSchema describing the call's
 *      input parameters so buyer agents can self-serve.
 *   2. Client replays with the `X-PAYMENT` header (base64 JSON payment proof).
 *   3. We verify: version, scheme, network, recipient, amount ≥ price,
 *      validity window, nonce replay — then verify+settle via the configured
 *      x402 facilitator (or dev-accept mode for local testing).
 *   4. Success → run the service, attach `PAYMENT-RESPONSE` header
 *      (base64 JSON settlement receipt) to the 200.
 *
 * ALL per-call prices are capped at $0.10 (100000 base units at 6 decimals) —
 * enforced by an assertion at module load.
 */

// ── priced service catalog ─────────────────────────────────────────────────

export interface PricedService {
  id: string;
  method: 'POST';
  path: string;
  description: string;
  priceUsd: string; // human
  priceAtomic: string; // base units of the configured asset
  input: Record<string, unknown>; // JSON Schema of the request body
}

const usd = (dollars: number): string => String(Math.round(dollars * 10 ** config.x402.assetDecimals));

export const PRICED_SERVICES: PricedService[] = [
  {
    id: 'job-hunt',
    method: 'POST',
    path: '/api/hunt',
    description:
      'Ranked job shortlist: send criteria (roles, location, qualification, comp floor, skills, priority factors), ' +
      'get up to 10 scored matches with per-axis explanations.',
    priceUsd: '0.05',
    priceAtomic: usd(0.05),
    input: {
      type: 'object',
      required: ['roles', 'skills'],
      properties: {
        roles: { type: 'array', items: { type: 'string' }, description: 'target roles' },
        seniority: { type: 'string', description: 'junior | mid | senior | staff' },
        locations: { type: 'array', items: { type: 'string' }, description: 'acceptable locations, include "remote" if ok' },
        compFloor: { type: 'number', description: 'minimum annual comp, USD' },
        skills: { type: 'array', items: { type: 'string' } },
        factors: { type: 'array', items: { type: 'string' }, description: 'priority factors to score for' },
      },
    },
  },
  {
    id: 'score-posting',
    method: 'POST',
    path: '/api/score',
    description: 'Score ONE job posting against candidate criteria on the 100-point rubric (skills 40 / comp 20 / location 15 / seniority 15 / factors 10). Every axis explained.',
    priceUsd: '0.01',
    priceAtomic: usd(0.01),
    input: {
      type: 'object',
      required: ['criteria', 'posting'],
      properties: {
        criteria: { type: 'object', description: 'same shape as /api/hunt body' },
        posting: {
          type: 'object',
          required: ['title', 'company', 'description'],
          properties: {
            title: { type: 'string' }, company: { type: 'string' }, location: { type: 'string' },
            description: { type: 'string' }, compMin: { type: 'number' }, compMax: { type: 'number' },
            url: { type: 'string' },
          },
        },
      },
    },
  },
  {
    id: 'tailor-application',
    method: 'POST',
    path: '/api/tailor',
    description: 'Tailored resume variant + cover letter + application email for one posting. Never fabricates — only reorders and emphasizes real candidate content.',
    priceUsd: '0.10',
    priceAtomic: usd(0.1),
    input: {
      type: 'object',
      required: ['candidate', 'posting'],
      properties: {
        candidate: {
          type: 'object',
          required: ['name', 'resumeText', 'skills'],
          properties: {
            name: { type: 'string' }, resumeText: { type: 'string' },
            skills: { type: 'array', items: { type: 'string' } }, email: { type: 'string' },
          },
        },
        posting: { type: 'object', required: ['title', 'company', 'description'] },
      },
    },
  },
];

// HARD CAP: no per-call price above $0.10.
const CAP_ATOMIC = BigInt(usd(0.1));
for (const s of PRICED_SERVICES) {
  if (BigInt(s.priceAtomic) > CAP_ATOMIC) {
    throw new Error(`pricing violation: ${s.id} exceeds the $0.10 per-call cap`);
  }
}

export function findService(method: string | undefined, path: string): PricedService | undefined {
  return PRICED_SERVICES.find((s) => s.method === method && s.path === path);
}

// ── 402 challenge ──────────────────────────────────────────────────────────

function acceptsV2(service: PricedService, resource: string) {
  return {
    scheme: 'exact',
    network: config.x402.network,
    asset: config.x402.asset,
    amount: service.priceAtomic,
    payTo: config.x402.payTo,
    resource,
    description: service.description,
    mimeType: 'application/json',
    maxTimeoutSeconds: 300,
    outputSchema: { input: { type: 'http', method: service.method, bodyType: 'json', body: service.input } },
    extra: {
      // EIP-712 domain of the payment token — REQUIRED for `exact` + EIP-3009
      // signing (buyer CLIs fail without `name`; `version` defaults to "2").
      name: config.x402.assetName,
      version: config.x402.assetVersion,
      assetTransferMethod: 'eip3009',
      symbol: config.x402.assetSymbol,
      decimals: config.x402.assetDecimals,
    },
  };
}

export function buildChallenge(service: PricedService, resource: string): {
  headerValue: string; // PAYMENT-REQUIRED (v2)
  bodyV1: Record<string, unknown>; // x402 v1 body
} {
  // v2 payload shape the OKX buyer CLI decodes: {x402Version, resource, accepts}
  const v2 = {
    x402Version: 2,
    resource: {
      url: resource,
      method: service.method,
      description: service.description,
      mimeType: 'application/json',
    },
    accepts: [acceptsV2(service, resource)],
  };
  const bodyV1 = {
    x402Version: 1,
    error: 'Payment required',
    accepts: [
      {
        ...acceptsV2(service, resource),
        maxAmountRequired: service.priceAtomic, // v1 field name
      },
    ],
  };
  return { headerValue: Buffer.from(JSON.stringify(v2)).toString('base64'), bodyV1 };
}

/** x402 payment proof header names, in precedence order (v2 first, v1 legacy). */
export const PAYMENT_HEADERS = ['payment-signature', 'x-payment'] as const;

/** Decode base64 OR base64url (the buyer CLI may emit either). */
function decodeB64(input: string): string {
  const normalized = input.trim().replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(normalized, 'base64').toString('utf8');
}

// ── X-PAYMENT verification + settlement ────────────────────────────────────

interface PaymentPayload {
  x402Version?: number;
  scheme?: string;
  network?: string;
  payload?: {
    signature?: string;
    authorization?: PaymentAuthorization;
    permit2Authorization?: PaymentAuthorization; // Permit2 / upto variants
  };
}

interface PaymentAuthorization {
  from?: string;
  to?: string;
  value?: string;
  validAfter?: string | number;
  validBefore?: string | number;
  deadline?: string | number; // Permit2 uses `deadline` instead of validBefore
  nonce?: string;
}

export interface VerifyResult {
  ok: boolean;
  status: number; // HTTP status to respond with on failure
  error?: string;
  payer?: string;
  transaction?: string;
  responseHeader?: string; // PAYMENT-RESPONSE value on success
}

export async function verifyAndSettle(paymentHeader: string, service: PricedService, resource: string): Promise<VerifyResult> {
  // 1. Decode (accepts base64 and base64url)
  let payment: PaymentPayload;
  try {
    payment = JSON.parse(decodeB64(paymentHeader)) as PaymentPayload;
    if (!payment || typeof payment !== 'object') throw new Error('not an object');
  } catch {
    return { ok: false, status: 400, error: 'payment header is not valid base64 JSON' };
  }

  // 2. Structural checks against our requirements
  if (payment.x402Version !== 1 && payment.x402Version !== 2) {
    return { ok: false, status: 402, error: 'unsupported x402Version' };
  }
  if (payment.scheme !== 'exact') {
    return { ok: false, status: 402, error: `unsupported scheme "${payment.scheme}" — this agent accepts scheme "exact"` };
  }
  if (payment.network !== config.x402.network) {
    return { ok: false, status: 402, error: `wrong network "${payment.network}" — expected ${config.x402.network}` };
  }
  // The wire carries either `authorization` (EIP-3009) or `permit2Authorization`
  // (Permit2 variants) — accept both shapes.
  const auth = payment.payload?.authorization ?? payment.payload?.permit2Authorization;
  if (!auth || !payment.payload?.signature) {
    return { ok: false, status: 402, error: 'missing payment authorization/signature' };
  }
  if ((auth.to ?? '').toLowerCase() !== config.x402.payTo.toLowerCase()) {
    return { ok: false, status: 402, error: 'payment recipient does not match this agent' };
  }
  let value: bigint;
  try {
    value = BigInt(auth.value ?? '0');
  } catch {
    return { ok: false, status: 400, error: 'invalid payment value' };
  }
  if (value < BigInt(service.priceAtomic)) {
    return {
      ok: false, status: 402,
      error: `insufficient payment: ${value} < required ${service.priceAtomic} (${config.x402.assetSymbol} base units)`,
    };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const expiry = auth.validBefore ?? auth.deadline; // EIP-3009 | Permit2
  if (expiry != null && Number(expiry) < nowSec) {
    return { ok: false, status: 402, error: 'payment authorization expired' };
  }
  if (auth.validAfter != null && Number(auth.validAfter) > nowSec) {
    return { ok: false, status: 402, error: 'payment authorization not yet valid' };
  }

  // 3. Replay protection — a signed authorization is single-use.
  const nonce = auth.nonce ?? '';
  if (!nonce) return { ok: false, status: 402, error: 'missing payment nonce' };
  if (!consumeNonce(`${config.x402.network}:${nonce}`)) {
    audit('x402', 'REPLAY_REJECTED', `service=${service.id} nonce=${nonce}`);
    return { ok: false, status: 402, error: 'payment authorization already used (replay rejected)' };
  }

  // 4. Cryptographic verification + on-chain settlement via facilitator.
  let transaction = '';
  if (config.x402.facilitatorUrl) {
    const requirements = acceptsV2(service, resource);
    const verified = await facilitator('/verify', { x402Version: payment.x402Version, paymentHeader, paymentRequirements: requirements });
    if (!verified.ok) return { ok: false, status: 402, error: `facilitator rejected payment: ${verified.error}` };
    const settled = await facilitator('/settle', { x402Version: payment.x402Version, paymentHeader, paymentRequirements: requirements });
    if (!settled.ok) return { ok: false, status: 402, error: `settlement failed: ${settled.error}` };
    transaction = settled.transaction ?? '';
  } else if (config.x402.devAcceptUnverified) {
    // Explicit dev/test mode: structural checks only, no chain settlement.
    transaction = `dev-unsettled-${uid().slice(0, 8)}`;
    audit('x402', 'DEV_ACCEPT_UNVERIFIED', `service=${service.id} payer=${auth.from}`);
  } else {
    return {
      ok: false, status: 402,
      error: 'payment verification unavailable: agent has no facilitator configured (X402_FACILITATOR_URL)',
    };
  }

  // 5. Record the charge (auditable revenue trail).
  savePayment({
    id: uid(),
    kind: 'x402_charge',
    amount: service.priceAtomic,
    currency: config.x402.assetSymbol,
    raw: JSON.stringify({ service: service.id, payer: auth.from, transaction, nonce }).slice(0, 1000),
    at: now(),
  });
  audit('x402', 'CHARGED', `service=${service.id} amount=${service.priceAtomic} payer=${auth.from} tx=${transaction}`);

  const responseHeader = Buffer.from(
    JSON.stringify({
      success: true,
      transaction,
      network: config.x402.network,
      payer: auth.from ?? '',
      amount: service.priceAtomic,
      asset: config.x402.asset,
    }),
  ).toString('base64');

  return { ok: true, status: 200, payer: auth.from, transaction, responseHeader };
}

async function facilitator(
  endpoint: '/verify' | '/settle',
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; transaction?: string }> {
  try {
    const res = await fetch(config.x402.facilitatorUrl.replace(/\/$/, '') + endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as { isValid?: boolean; success?: boolean; invalidReason?: string; errorReason?: string; transaction?: string; txHash?: string };
    if (endpoint === '/verify') {
      return data.isValid ? { ok: true } : { ok: false, error: data.invalidReason ?? 'invalid' };
    }
    return data.success
      ? { ok: true, transaction: data.transaction ?? data.txHash }
      : { ok: false, error: data.errorReason ?? 'settlement error' };
  } catch (err) {
    return { ok: false, error: `facilitator unreachable: ${String(err)}` };
  }
}

/** Public catalog served free at GET /api/services (what okx.ai/agents shows). */
export function serviceCatalog(): Record<string, unknown> {
  return {
    agent: 'Legwork',
    category: 'Resume & Career Workflows',
    payment: {
      protocol: 'x402',
      schemes: ['exact'],
      network: config.x402.network,
      asset: config.x402.asset,
      assetSymbol: config.x402.assetSymbol,
      payTo: config.x402.payTo,
      maxPricePerCallUsd: '0.10',
    },
    freeTier: {
      endpoint: 'POST /api/hunt/preview',
      description: 'Free ranked preview: top 3 matches with scores and headline reasons. 3 calls/hour per client.',
      limitPerHour: 3,
    },
    services: PRICED_SERVICES.map((s) => ({
      id: s.id,
      endpoint: `${s.method} ${s.path}`,
      priceUsd: s.priceUsd,
      priceAtomic: s.priceAtomic,
      description: s.description,
      input: s.input,
    })),
  };
}
