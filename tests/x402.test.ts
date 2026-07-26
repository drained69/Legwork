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
// Mirrors production (Railway fronts the container), and lets tests address
// the limiter as distinct clients. The untrusted case is covered by the
// spoofing test below, which flips this off at runtime.
process.env.TRUST_PROXY = 'true';

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

// ── engagement-authorized access (prepaid, no double-charge) ───────────────

test('engagement: valid token serves the call without an x402 payment', async () => {
  const db = await import('../src/db.js');
  const { engagementToken } = await import('../src/okx/server.js');
  const engagement = {
    id: 'eng-live-1', okxJobId: 'okx-live-1', taskCode: 'tc1', userId: 'u-live',
    listing: 'job-hunt-weekly', status: 'active' as const, startedAt: new Date().toISOString(),
    endsAt: new Date(Date.now() + 86400_000).toISOString(),
  };
  db.saveEngagement(engagement);
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-engagement-id': engagement.id,
      'x-engagement-token': engagementToken(engagement.id),
      'x-user-wallet': '0x4e9bb70743a3a33bc47514389167903f70f69a07',
    },
    body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
  });
  assert.equal(res.status, 200, 'a prepaid engagement must not be charged again');
  const data = (await res.json()) as { billing: string; result: { matches: unknown[] } };
  assert.equal(data.billing, 'engagement');
  assert.ok(Array.isArray(data.result.matches));
});

test('engagement: forged token is rejected', async () => {
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-engagement-id': 'eng-live-1', 'x-engagement-token': 'deadbeef' },
    body: '{}',
  });
  assert.equal(res.status, 402);
  assert.match(((await res.json()) as { error: string }).error, /invalid engagement token/);
});

test('engagement: expired engagement falls back to payment required', async () => {
  const db = await import('../src/db.js');
  const { engagementToken } = await import('../src/okx/server.js');
  const expired = {
    id: 'eng-expired', okxJobId: 'okx-exp', taskCode: 'tc2', userId: 'u-exp',
    listing: 'job-hunt', status: 'active' as const, startedAt: '2020-01-01T00:00:00Z',
    endsAt: '2020-01-02T00:00:00Z',
  };
  db.saveEngagement(expired);
  const res = await fetch(`${base}/api/hunt`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-engagement-id': expired.id, 'x-engagement-token': engagementToken(expired.id) },
    body: '{}',
  });
  assert.equal(res.status, 402);
  assert.match(((await res.json()) as { error: string }).error, /expired/);
});

test('usage ledger records wallet attribution for every call', async () => {
  const db = await import('../src/db.js');
  const records = db.listUsage('u-ledger');
  assert.equal(records.length, 0, 'clean slate');
  db.recordUsage({
    id: db.uid(), userId: 'u-ledger', engagementId: 'eng-live-1',
    wallet: '0x4e9bb70743a3a33bc47514389167903f70f69a07', service: 'job-hunt',
    endpoint: '/api/hunt', priceUsd: '0.05', paid: false, status: 200, at: db.now(),
  });
  const after = db.listUsage('u-ledger');
  assert.equal(after.length, 1);
  assert.equal(after[0].wallet, '0x4e9bb70743a3a33bc47514389167903f70f69a07');
  assert.equal(after[0].paid, false);
});

// ── nonce reservation is not a spend ───────────────────────────────────────

test('x402: a nonce is released when settlement never happens', async () => {
  // A payment authorization is single-use, so the nonce is reserved BEFORE
  // settlement to stop two concurrent requests spending it. But a reservation
  // that never settles must be given back: otherwise one transient facilitator
  // error permanently bricks a valid authorization and the buyer can never pay.
  const { consumeNonce, releaseNonce } = await import('../src/db.js');
  const nonce = 'eip155:196:0xdeadbeef';

  assert.equal(consumeNonce(nonce), true, 'first use reserves');
  assert.equal(consumeNonce(nonce), false, 'concurrent duplicate is blocked while reserved');

  releaseNonce(nonce);
  assert.equal(consumeNonce(nonce), true, 'a released authorization can be retried');
});

test('x402: an unconfigured facilitator does not consume the buyer authorization', async () => {
  // X402_FACILITATOR_URL is empty in this suite; with dev-accept off, the call
  // is refused. The buyer must be able to retry the SAME authorization once the
  // agent is configured, so the nonce must not have been burned.
  const { verifyAndSettle, PRICED_SERVICES } = await import('../src/okx/x402.js');
  const { config } = await import('../src/config.js');
  const service = PRICED_SERVICES.find((s) => s.id === 'job-hunt')!;
  const nonce = '0x' + 'c0ffee'.padEnd(64, '0');

  config.x402.devAcceptUnverified = false;
  try {
    const first = await verifyAndSettle(makePayment({}, { nonce }), service, '/api/hunt');
    assert.equal(first.ok, false);
    assert.match(first.error ?? '', /facilitator/);

    // The retry must fail for the SAME reason — not "replay rejected".
    const retry = await verifyAndSettle(makePayment({}, { nonce }), service, '/api/hunt');
    assert.equal(retry.ok, false);
    assert.doesNotMatch(retry.error ?? '', /replay/, 'the unsettled authorization was wrongly burned');
  } finally {
    config.x402.devAcceptUnverified = true;
  }
});

// ── free-tier rate limiting cannot be forged ───────────────────────────────

test('preview: with no trusted proxy, a forged X-Forwarded-For cannot mint free-tier quota', async () => {
  // Directly exposed deployment: the limiter must key on the socket peer.
  // Reading the client-supplied leftmost hop, as this once did, let any caller
  // reset their own limit on every single request.
  const { config } = await import('../src/config.js');
  config.okx.trustProxy = false;
  try {
    const seen: number[] = [];
    for (let i = 0; i < 6; i++) {
      const res = await fetch(`${base}/api/hunt/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.9.9.${i}` },
        body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
      });
      seen.push(res.status);
    }
    assert.ok(seen.includes(429), `forged headers bypassed the limit entirely: ${seen.join(',')}`);
  } finally {
    config.okx.trustProxy = true;
  }
});

test('preview: loopback callers are keyed per user, not lumped together', async () => {
  // The Telegram bot calls this API over loopback, so without a per-user key
  // EVERY Telegram user shared one 3/hour bucket and the free preview died for
  // everyone after three uses. A loopback caller is our own process, so its
  // declared key is trustworthy in a way a remote caller's headers are not.
  const call = (user: string) =>
    fetch(`${base}/api/hunt/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-client': `telegram:${user}` },
      body: JSON.stringify({ roles: ['engineer'], skills: ['typescript'] }),
    });

  for (let i = 0; i < 3; i++) assert.equal((await call('alice')).status, 200, `alice call ${i + 1}`);
  assert.equal((await call('alice')).status, 429, 'alice exhausts her own quota');
  assert.equal((await call('bob')).status, 200, 'bob must not inherit alice’s exhausted quota');
});

// ── settlement honesty: never advertise what cannot be paid ────────────────

test('x402: the catalog states plainly whether payments can actually settle', async () => {
  // Advertising paid endpoints we cannot settle is over-promising: a buyer
  // agent signs an authorization, gets a 402, and rates the agent broken.
  const { serviceCatalog, settlementStatus } = await import('../src/okx/x402.js');
  const { config } = await import('../src/config.js');

  // No facilitator, no dev-accept → payments cannot complete.
  config.x402.devAcceptUnverified = false;
  config.x402.facilitatorUrl = '';
  try {
    const status = settlementStatus();
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /facilitator/i);

    const cat = serviceCatalog() as {
      payment: { settlementAvailable: boolean; settlementNote?: string };
      services: Array<{ available: boolean }>;
      marketplace: { settledIn: string };
    };
    assert.equal(cat.payment.settlementAvailable, false, 'the catalog must not claim payments work');
    for (const s of cat.services) assert.equal(s.available, false, 'each service is marked unavailable');
    // The working route stays discoverable.
    assert.match(cat.marketplace.settledIn, /USDT/);
  } finally {
    config.x402.devAcceptUnverified = true;
    config.x402.facilitatorUrl = '';
  }
});

test('x402: an OKX facilitator without credentials is reported unavailable, not "ready"', async () => {
  // A URL alone is not enough — OKX's facilitator is authenticated. Treating a
  // credential-less config as ready would advertise unpayable endpoints.
  const { settlementStatus } = await import('../src/okx/x402.js');
  const { config } = await import('../src/config.js');
  config.x402.devAcceptUnverified = false;
  config.x402.facilitatorUrl = 'https://web3.okx.com/api/v6/pay/x402';
  config.x402.facilitatorApiKey = '';
  try {
    const status = settlementStatus();
    assert.equal(status.available, false);
    assert.match(status.reason ?? '', /credential/i);
  } finally {
    config.x402.facilitatorUrl = '';
    config.x402.devAcceptUnverified = true;
  }
});

test('x402: an unsettleable payment points the buyer at routes that DO work', async () => {
  const { verifyAndSettle, PRICED_SERVICES } = await import('../src/okx/x402.js');
  const { config } = await import('../src/config.js');
  const service = PRICED_SERVICES.find((s) => s.id === 'job-hunt')!;
  config.x402.devAcceptUnverified = false;
  config.x402.facilitatorUrl = '';
  try {
    const res = await verifyAndSettle(makePayment({}, { nonce: '0x' + 'ee'.repeat(32) }), service, '/api/hunt');
    assert.equal(res.ok, false);
    assert.match(res.error ?? '', /preview/i, 'names the free tier');
    assert.match(res.error ?? '', /marketplace/i, 'names the escrow route that works');
  } finally {
    config.x402.devAcceptUnverified = true;
  }
});
