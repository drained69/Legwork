/**
 * x402 seller-side tests: 402 challenge shape, paid replay, underpayment,
 * nonce replay attack, wrong recipient/network, price cap, free catalog.
 *
 * Runs a real HTTP server on an ephemeral port with dev-accept mode
 * (structural verification without a facilitator).
 */
// Force-isolate from any real .env: set empty strings BEFORE the app loads —
// dotenv never overrides an already-defined variable, `delete` would let it.
process.env.DATABASE_PATH = ':memory:';
process.env.X402_DEV_ACCEPT_UNVERIFIED = 'true';
process.env.X402_PAY_TO = '0xAgentWallet00000000000000000000000000001';
process.env.X402_NETWORK = 'eip155:196';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';
process.env.ANTHROPIC_API_KEY = '';
process.env.X402_FACILITATOR_URL = '';

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { Server } from 'node:http';

const { startOkxServer } = await import('../src/okx/server.js');
const { PRICED_SERVICES } = await import('../src/okx/x402.js');

let server: Server;
let base = '';

before(async () => {
  server = startOkxServer({}, 0);
  await once(server, 'listening');
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

function makePayment(overrides: Record<string, unknown> = {}, authOverrides: Record<string, unknown> = {}): string {
  const payment = {
    x402Version: 2,
    scheme: 'exact',
    network: 'eip155:196',
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: '0xBuyerAgent0000000000000000000000000000002',
        to: '0xAgentWallet00000000000000000000000000001',
        value: '50000', // $0.05 — the hunt price
        validAfter: '0',
        validBefore: String(Math.floor(Date.now() / 1000) + 300),
        nonce: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'),
        ...authOverrides,
      },
    },
    ...overrides,
  };
  return Buffer.from(JSON.stringify(payment)).toString('base64');
}

// ── pricing cap ────────────────────────────────────────────────────────────

test('x402: every service is priced at or under $0.10 per call', () => {
  assert.ok(PRICED_SERVICES.length >= 3);
  for (const s of PRICED_SERVICES) {
    assert.ok(Number(s.priceUsd) <= 0.1, `${s.id} at $${s.priceUsd} breaks the $0.10 cap`);
    assert.ok(BigInt(s.priceAtomic) <= 100000n, `${s.id} atomic price over cap`);
  }
});

// ── free catalog ───────────────────────────────────────────────────────────

test('x402: GET /api/services is free and advertises payment terms', async () => {
  const res = await fetch(`${base}/api/services`);
  assert.equal(res.status, 200);
  const data = (await res.json()) as {
    payment: { protocol: string; maxPricePerCallUsd: string; payTo: string };
    services: Array<{ id: string; priceUsd: string }>;
  };
  assert.equal(data.payment.protocol, 'x402');
  assert.equal(data.payment.maxPricePerCallUsd, '0.10');
  assert.equal(data.payment.payTo, '0xAgentWallet00000000000000000000000000001');
  assert.equal(data.services.length, PRICED_SERVICES.length);
});

// ── free preview (try-before-you-pay) ──────────────────────────────────────

test('preview: free call returns top-3 with scores and an upgrade pointer', async () => {
  const res = await fetch(`${base}/api/hunt/preview`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': '10.0.0.1' },
    body: JSON.stringify({ roles: ['backend engineer'], skills: ['typescript'] }),
  });
  assert.equal(res.status, 200, 'preview must be free — no payment header sent');
  const data = (await res.json()) as {
    preview: boolean; shown: number; totalMatches: number;
    matches: Array<{ score: number; why: string[] }>;
    upgrade: { endpoint: string; priceUsd: string };
  };
  assert.equal(data.preview, true);
  assert.ok(data.shown <= 3, 'preview caps at 3 matches');
  assert.ok(data.totalMatches >= data.shown, 'must disclose how many were withheld');
  assert.ok(data.matches[0].why.length === 2, 'preview shows headline reasons');
  assert.equal(data.upgrade.endpoint, 'POST /api/hunt');
});

test('preview: rate limit blocks farming the free tier', async () => {
  const ip = '10.0.0.99';
  const call = () =>
    fetch(`${base}/api/hunt/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
    });
  for (let i = 0; i < 3; i++) assert.equal((await call()).status, 200, `call ${i + 1} should pass`);
  const blocked = await call();
  assert.equal(blocked.status, 429, '4th call in the window must be rate-limited');
  assert.ok(blocked.headers.get('retry-after'), 'must tell the caller when to retry');
});

test('catalog advertises the free tier so directories can surface it', async () => {
  const data = (await (await fetch(`${base}/api/services`)).json()) as {
    freeTier: { endpoint: string; limitPerHour: number };
  };
  assert.equal(data.freeTier.endpoint, 'POST /api/hunt/preview');
  assert.equal(data.freeTier.limitPerHour, 3);
});

// ── 402 challenge ──────────────────────────────────────────────────────────

test('x402: unpaid call returns 402 with PAYMENT-REQUIRED header (v2) and x402Version body (v1)', async () => {
  const res = await fetch(`${base}/api/hunt`, { method: 'POST', body: '{}' });
  assert.equal(res.status, 402);

  // v2: PAYMENT-REQUIRED header decodes to the challenge
  const header = res.headers.get('payment-required');
  assert.ok(header, 'PAYMENT-REQUIRED header missing');
  const v2 = JSON.parse(Buffer.from(header!, 'base64').toString()) as {
    x402Version: number;
    resource: { url: string; method: string };
    accepts: Array<{
      scheme: string; network: string; amount: string; payTo: string;
      outputSchema: { input: { type: string } };
      extra: { name: string; version: string; assetTransferMethod: string };
    }>;
  };
  assert.equal(v2.x402Version, 2);
  // OKX buyer CLI decodes {x402Version, resource, accepts}
  assert.ok(v2.resource, 'v2 payload must carry a top-level resource object');
  assert.equal(v2.resource.method, 'POST');
  // EIP-712 domain required for `exact` + EIP-3009 signing
  assert.ok(v2.accepts[0].extra.name, 'extra.name (EIP-712 domain) required or buyers cannot sign');
  assert.equal(v2.accepts[0].extra.assetTransferMethod, 'eip3009');
  assert.equal(v2.accepts[0].scheme, 'exact');
  assert.equal(v2.accepts[0].network, 'eip155:196');
  assert.equal(v2.accepts[0].amount, '50000'); // $0.05
  assert.equal(v2.accepts[0].payTo, '0xAgentWallet00000000000000000000000000001');
  assert.equal(v2.accepts[0].outputSchema.input.type, 'http', 'buyer agents need the input schema');

  // v1: body carries x402Version + maxAmountRequired
  const v1 = (await res.json()) as { x402Version: number; accepts: Array<{ maxAmountRequired: string }> };
  assert.equal(v1.x402Version, 1);
  assert.equal(v1.accepts[0].maxAmountRequired, '50000');
});

// ── paid replay ────────────────────────────────────────────────────────────

test('x402: valid X-PAYMENT replay returns 200 + PAYMENT-RESPONSE receipt + real results', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': makePayment() },
    body: JSON.stringify({ roles: ['backend engineer'], skills: ['typescript', 'node.js'], compFloor: 100000, locations: ['remote'] }),
  });
  assert.equal(res.status, 200);

  const receiptHeader = res.headers.get('payment-response');
  assert.ok(receiptHeader, 'PAYMENT-RESPONSE header missing');
  const receipt = JSON.parse(Buffer.from(receiptHeader!, 'base64').toString()) as {
    success: boolean; payer: string; amount: string; network: string;
  };
  assert.equal(receipt.success, true);
  assert.equal(receipt.amount, '50000');
  assert.equal(receipt.payer, '0xBuyerAgent0000000000000000000000000000002');

  const data = (await res.json()) as { ok: boolean; result: { matches: Array<{ score: number }> } };
  assert.equal(data.ok, true);
  assert.ok(data.result.matches.length >= 1, 'paid call must return actual matches');
});

test('x402: score-posting paid call works end to end at $0.01', async () => {
  const res = await fetch(`${base}/api/score`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'X-PAYMENT': makePayment({}, { value: '10000' }) },
    body: JSON.stringify({
      criteria: { skills: ['typescript'], seniority: 'senior', compFloor: 100000, locations: ['remote'] },
      posting: { title: 'Senior TypeScript Dev', company: 'Acme', description: 'Remote typescript role', compMin: 120000, compMax: 150000, location: 'Remote' },
    }),
  });
  assert.equal(res.status, 200);
  const data = (await res.json()) as { result: { score: number; breakdown: { skills: { reason: string } } } };
  assert.ok(data.result.score > 0);
  assert.ok(data.result.breakdown.skills.reason.length > 5);
});

// ── payment rejections ─────────────────────────────────────────────────────

test('x402: underpayment is rejected with a fresh challenge', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'X-PAYMENT': makePayment({}, { value: '1' }) },
    body: '{}',
  });
  assert.equal(res.status, 402);
  const body = (await res.json()) as { error: string };
  assert.match(body.error, /insufficient payment/);
  assert.ok(res.headers.get('payment-required'), 'rejection must re-issue the challenge');
});

test('x402: nonce replay is rejected (double-spend of one authorization)', async () => {
  const payment = makePayment(); // fixed nonce inside
  const first = await fetch(`${base}/api/hunt`, {
    method: 'POST', headers: { 'X-PAYMENT': payment }, body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
  });
  assert.equal(first.status, 200);
  const second = await fetch(`${base}/api/hunt`, {
    method: 'POST', headers: { 'X-PAYMENT': payment }, body: '{}',
  });
  assert.equal(second.status, 402);
  const body = (await second.json()) as { error: string };
  assert.match(body.error, /already used/);
});

test('x402: wrong recipient is rejected', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'X-PAYMENT': makePayment({}, { to: '0xSomeoneElse000000000000000000000000000003' }) },
    body: '{}',
  });
  assert.equal(res.status, 402);
  assert.match(((await res.json()) as { error: string }).error, /recipient/);
});

test('x402: wrong network is rejected', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'X-PAYMENT': makePayment({ network: 'eip155:1' }) },
    body: '{}',
  });
  assert.equal(res.status, 402);
  assert.match(((await res.json()) as { error: string }).error, /network/);
});

test('x402: expired authorization is rejected', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'X-PAYMENT': makePayment({}, { validBefore: String(Math.floor(Date.now() / 1000) - 10) }) },
    body: '{}',
  });
  assert.equal(res.status, 402);
  assert.match(((await res.json()) as { error: string }).error, /expired/);
});

test('x402: PAYMENT-SIGNATURE header (v2 standard) is accepted', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': makePayment() },
    body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
  });
  assert.equal(res.status, 200, 'v2 buyers send PAYMENT-SIGNATURE — rejecting it means an infinite 402 loop');
  assert.ok(res.headers.get('payment-response'));
});

test('x402: base64url-encoded payment header is accepted', async () => {
  const b64url = makePayment().replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': b64url },
    body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
  });
  assert.equal(res.status, 200, 'CLI may emit base64url');
});

test('x402: permit2Authorization payload shape is accepted', async () => {
  const payment = {
    x402Version: 2, scheme: 'exact', network: 'eip155:196',
    payload: {
      signature: '0x' + 'cd'.repeat(65),
      permit2Authorization: {
        from: '0xBuyerAgent0000000000000000000000000000002',
        to: '0xAgentWallet00000000000000000000000000001',
        value: '50000',
        deadline: String(Math.floor(Date.now() / 1000) + 300), // Permit2 uses deadline
        nonce: '0x' + Math.random().toString(16).slice(2).padEnd(64, '0'),
      },
    },
  };
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'PAYMENT-SIGNATURE': Buffer.from(JSON.stringify(payment)).toString('base64') },
    body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
  });
  assert.equal(res.status, 200, 'Permit2 variants carry permit2Authorization + deadline');
});

test('x402: garbage payment header returns 400', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'PAYMENT-SIGNATURE': '!!!not-base64-json!!!' },
    body: '{}',
  });
  assert.equal(res.status, 400);
});
