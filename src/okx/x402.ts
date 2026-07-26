import { audit, consumeNonce, releaseNonce, now, savePayment, uid } from '../db.js';
import { config } from '../config.js';
import { fetchWithTimeout } from '../http.js';
import { createHmac } from 'node:crypto';

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

  // 3. Replay protection — a signed authorization is single-use. Reserved
  //    before settlement so concurrent duplicates cannot both spend it; see
  //    step 4 for why an unsettled reservation must be released again.
  const nonce = auth.nonce ?? '';
  if (!nonce) return { ok: false, status: 402, error: 'missing payment nonce' };
  const nonceKey = `${config.x402.network}:${nonce}`;
  if (!consumeNonce(nonceKey)) {
    audit('x402', 'REPLAY_REJECTED', `service=${service.id} nonce=${nonce}`);
    return { ok: false, status: 402, error: 'payment authorization already used (replay rejected)' };
  }

  // 4. Cryptographic verification + on-chain settlement via facilitator.
  //
  // The nonce is reserved above BEFORE this runs, so two concurrent requests
  // carrying the same authorization can never both reach settlement. But a
  // reservation is not a spend: if we never actually settle, holding the nonce
  // would permanently brick a perfectly valid authorization — the buyer's
  // retry would come back "replay rejected" and they could not pay us at all.
  // So every path that ends without a settled payment releases it.
  // Refuse early when settlement cannot possibly succeed. A configured-but-
  // unusable facilitator (URL set, credentials missing) would otherwise burn a
  // network round-trip and hand the buyer a raw OKX error like
  // "50103: OK-ACCESS-KEY can not be empty" — an internal detail they can do
  // nothing with. Fail with the routes that DO work instead.
  const settlement = settlementStatus();
  if (!settlement.available) {
    releaseNonce(nonceKey);
    return {
      ok: false, status: 402,
      error:
        `per-call payment is not currently available (${settlement.reason ?? 'settlement unconfigured'}). ` +
        `Use the free preview at POST /api/hunt/preview, or hire agent ${config.okx.agentId} ` +
        'on the OKX marketplace where tasks settle in USDT via escrow.',
    };
  }

  let transaction = '';
  if (config.x402.facilitatorUrl) {
    const requirements = acceptsV2(service, resource);
    const facilitatorBody = {
      x402Version: payment.x402Version,
      // OKX and modern x402 facilitators expect the DECODED payload; older
      // Coinbase-style ones take the base64 header. Send both — each ignores
      // the field it does not use, and sending only one silently fails on the
      // other implementation.
      paymentPayload: payment,
      paymentHeader,
      paymentRequirements: requirements,
    };
    const verified = await facilitator('/verify', facilitatorBody);
    if (!verified.ok) {
      releaseNonce(nonceKey);
      return { ok: false, status: 402, error: `facilitator rejected payment: ${verified.error}` };
    }
    const settled = await facilitator('/settle', facilitatorBody);
    if (!settled.ok) {
      releaseNonce(nonceKey);
      return { ok: false, status: 402, error: `settlement failed: ${settled.error}` };
    }
    transaction = settled.transaction ?? '';
  } else if (config.x402.devAcceptUnverified) {
    // Explicit dev/test mode: structural checks only, no chain settlement.
    transaction = `dev-unsettled-${uid().slice(0, 8)}`;
    audit('x402', 'DEV_ACCEPT_UNVERIFIED', `service=${service.id} payer=${auth.from}`);
  } else {
    releaseNonce(nonceKey);
    const { reason } = settlementStatus();
    return {
      ok: false, status: 402,
      // Name the working alternative: a buyer agent that cannot pay per call
      // can still get the same work through the OKX marketplace escrow flow.
      error:
        `per-call payment is not currently available (${reason ?? 'settlement unconfigured'}). ` +
        `Use the free preview at POST /api/hunt/preview, or hire agent ${config.okx.agentId} ` +
        'on the OKX marketplace where tasks settle in USDT via escrow.',
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

/** Settlement can involve an on-chain write, so it gets a longer leash than a scan. */
const FACILITATOR_TIMEOUT_MS = 30_000;

/**
 * OKX authenticates its facilitator with the standard OKX API scheme:
 *   OK-ACCESS-SIGN = base64(hmac_sha256(timestamp + METHOD + path + body, secret))
 * Coinbase-style facilitators are open, so the headers are attached only when
 * a key is configured — one client serves both.
 */
function facilitatorHeaders(path: string, body: string): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const { facilitatorApiKey: key, facilitatorApiSecret: secret, facilitatorPassphrase: pass } = config.x402;
  if (!key || !secret) return headers;

  const timestamp = new Date().toISOString();
  const sign = createHmac('sha256', secret).update(`${timestamp}POST${path}${body}`).digest('base64');
  headers['OK-ACCESS-KEY'] = key;
  headers['OK-ACCESS-SIGN'] = sign;
  headers['OK-ACCESS-TIMESTAMP'] = timestamp;
  if (pass) headers['OK-ACCESS-PASSPHRASE'] = pass;
  return headers;
}

/** Facilitator reply, either flat (Coinbase-style) or wrapped in OKX's envelope. */
interface FacilitatorReply {
  code?: string;
  msg?: string;
  data?: FacilitatorReply;
  isValid?: boolean;
  success?: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  errorReason?: string;
  errorMessage?: string;
  transaction?: string;
  txHash?: string;
}

async function facilitator(
  endpoint: '/verify' | '/settle',
  body: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string; transaction?: string }> {
  try {
    const base = config.x402.facilitatorUrl.replace(/\/$/, '');
    const url = base + endpoint;
    const payload = JSON.stringify(body);
    // Sign over the path only (no origin), per the OKX signing scheme.
    const path = new URL(url).pathname;

    const res = await fetchWithTimeout(
      url,
      { method: 'POST', headers: facilitatorHeaders(path, payload), body: payload },
      FACILITATOR_TIMEOUT_MS,
    );

    const raw = (await res.json()) as FacilitatorReply;
    // OKX wraps the result in {code, msg, data}; Coinbase-style returns it
    // flat. Reading the flat shape against an OKX reply yields `undefined`
    // for every field — which reads as "invalid" and rejects EVERY genuine
    // payment, so unwrap before interpreting.
    const envelopeFailed = raw.code !== undefined && raw.code !== '0';
    if (envelopeFailed) {
      return { ok: false, error: `${raw.code}: ${raw.msg ?? 'facilitator error'}` };
    }
    const data = raw.data ?? raw;

    if (endpoint === '/verify') {
      return data.isValid
        ? { ok: true }
        : { ok: false, error: data.invalidMessage ?? data.invalidReason ?? 'invalid' };
    }
    return data.success
      ? { ok: true, transaction: data.transaction ?? data.txHash }
      : { ok: false, error: data.errorMessage ?? data.errorReason ?? 'settlement error' };
  } catch (err) {
    return { ok: false, error: `facilitator unreachable: ${String(err)}` };
  }
}

/**
 * Can a payment actually be settled right now?
 *
 * A facilitator URL alone is not enough: OKX's requires API credentials, and
 * without them every genuine payment is refused. Advertising paid endpoints we
 * cannot settle is over-promising — a buyer agent would sign an authorization,
 * get a 402 back, and rate the agent as broken. So the catalog reports this
 * honestly rather than listing services that cannot complete.
 */
export function settlementStatus(): { available: boolean; reason?: string } {
  if (config.x402.devAcceptUnverified) return { available: true, reason: 'dev-accept mode (no on-chain settlement)' };
  if (!config.x402.facilitatorUrl) return { available: false, reason: 'no facilitator configured (X402_FACILITATOR_URL)' };
  // OKX's facilitator is authenticated; an unauthenticated one needs no key.
  const okxHosted = /okx\.com/i.test(config.x402.facilitatorUrl);
  if (okxHosted && !(config.x402.facilitatorApiKey && config.x402.facilitatorApiSecret)) {
    return { available: false, reason: 'facilitator credentials missing (OKX_API_KEY / OKX_API_SECRET)' };
  }
  return { available: true };
}

/** Public catalog served free at GET /api/services (what okx.ai/agents shows). */
export function serviceCatalog(): Record<string, unknown> {
  const settlement = settlementStatus();
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
      // Stated plainly so a buyer agent can tell, before signing anything,
      // whether a payment can complete. `false` means the per-call HTTP API is
      // not currently accepting payments — the free tier and the OKX
      // marketplace escrow tasks are unaffected.
      settlementAvailable: settlement.available,
      ...(settlement.reason ? { settlementNote: settlement.reason } : {}),
    },
    freeTier: {
      endpoint: 'POST /api/hunt/preview',
      description: 'Free ranked preview: top 3 matches with scores and headline reasons. 3 calls/hour per client.',
      limitPerHour: 3,
    },
    // Where per-call payment cannot settle, the marketplace escrow tasks are
    // the working route — the same work, paid through the OKX task flow.
    marketplace: {
      agentId: config.okx.agentId,
      settledIn: 'USDT via OKX task escrow',
      note: 'Ranked shortlists and tailored application drafts are delivered as OKX agent-to-agent tasks.',
    },
    services: PRICED_SERVICES.map((s) => ({
      id: s.id,
      endpoint: `${s.method} ${s.path}`,
      priceUsd: s.priceUsd,
      priceAtomic: s.priceAtomic,
      description: s.description,
      available: settlement.available,
      input: s.input,
    })),
  };
}
