/**
 * Telegram surface tests.
 *
 * The bot had no coverage at all, which is how a set of "the user just sees
 * nothing happen" bugs accumulated: an over-long message is REJECTED whole by
 * Telegram rather than truncated, and every one of these paths ends in silence
 * rather than an error the user can act on.
 *
 * These exercise the pure/presentation layer and the send pipeline directly —
 * no bot token or network required.
 */
process.env.DATABASE_PATH = ':memory:';
process.env.ANTHROPIC_API_KEY = '';
// Both providers, or dotenv's real key leaks in and the suite makes live API
// calls — slow, quota-burning, and dependent on someone else's uptime.
process.env.ANTHROPIC_AUTH_TOKEN = '';
process.env.GEMINI_API_KEY = '';
process.env.GOOGLE_API_KEY = '';
process.env.ADZUNA_APP_ID = '';
process.env.ADZUNA_APP_KEY = '';
process.env.USAJOBS_API_KEY = '';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { chunkForTelegram, send, stripHtml, TELEGRAM_LIMIT } = await import('../src/telegram/send.js');
const { esc, safeLink, capText, renderProfile, renderMatchCard } = await import('../src/telegram/ui.js');
const type = await import('../src/types.js');

function profile(overrides: Partial<type.Profile> = {}): type.Profile {
  return {
    userId: 'u1', name: 'Ada Lovelace', targetRoles: ['backend engineer'], seniority: 'senior',
    locations: ['remote'], remoteOk: true, compFloor: 120000, skills: ['typescript', 'node'],
    resumeText: 'x'.repeat(400), dealbreakers: [], factors: [], threshold: 0, dailyCap: 10,
    ...overrides,
  };
}

const breakdown = (): type.ScoreBreakdown => ({
  skills: { score: 32, max: 40, reason: 'Strong overlap' },
  comp: { score: 20, max: 20, reason: 'Clears the floor' },
  location: { score: 15, max: 15, reason: 'Remote' },
  seniority: { score: 15, max: 15, reason: 'Exact match' },
  culture: { score: 8, max: 10, reason: 'Async-first' },
  total: 90,
});

// ── message chunking ───────────────────────────────────────────────────────

test('telegram: every chunk fits inside the hard message limit', () => {
  const long = Array.from({ length: 900 }, (_, i) => `line ${i} with some detail about a posting`).join('\n');
  assert.ok(long.length > TELEGRAM_LIMIT, 'fixture must exceed the limit to be meaningful');

  const chunks = chunkForTelegram(long);
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.length <= TELEGRAM_LIMIT, `chunk of ${c.length} would be rejected`);
  assert.equal(chunks.join('\n'), long, 'no content lost');
});

test('telegram: a single unbroken line is hard-split rather than sent oversized', () => {
  const chunks = chunkForTelegram('y'.repeat(12_000));
  for (const c of chunks) assert.ok(c.length <= TELEGRAM_LIMIT);
  assert.equal(chunks.join(''), 'y'.repeat(12_000));
});

test('telegram: the keyboard rides on the final chunk only', async () => {
  const calls: Array<{ text: string; markup: unknown }> = [];
  const reply = async (text: string, other?: Record<string, unknown>) => {
    calls.push({ text, markup: other?.reply_markup });
    return {};
  };

  await send(reply, Array.from({ length: 800 }, (_, i) => `row ${i}`).join('\n'), {
    parse_mode: 'HTML',
    reply_markup: { inline_keyboard: [] },
  });

  assert.ok(calls.length > 1, 'fixture should span multiple messages');
  for (const c of calls.slice(0, -1)) assert.equal(c.markup, undefined, 'buttons must not scroll away mid-message');
  assert.ok(calls[calls.length - 1].markup, 'the last chunk carries the keyboard');
});

// ── failure recovery ───────────────────────────────────────────────────────

test('telegram: a rate limit is retried once, honouring retry_after', async () => {
  const { GrammyError } = await import('grammy');
  let attempts = 0;
  const reply = async (text: string) => {
    attempts++;
    if (attempts === 1) {
      throw new GrammyError(
        'Call to sendMessage failed!',
        { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } },
        'sendMessage',
        {},
      );
    }
    return { text };
  };

  await send(reply, 'hello');
  assert.equal(attempts, 2, 'the message must actually arrive on the retry');
});

test('telegram: an unparseable message is re-sent as plain text rather than dropped', async () => {
  const { GrammyError } = await import('grammy');
  const delivered: Array<{ text: string; mode: unknown }> = [];
  const reply = async (text: string, other?: Record<string, unknown>) => {
    if (other?.parse_mode) {
      throw new GrammyError(
        'Call to sendMessage failed!',
        { ok: false, error_code: 400, description: "Bad Request: can't parse entities: unexpected tag" },
        'sendMessage',
        {},
      );
    }
    delivered.push({ text, mode: other?.parse_mode });
    return {};
  };

  await send(reply, '<b>Shortlist</b>\n1. Engineer', { parse_mode: 'HTML' });

  assert.equal(delivered.length, 1, 'content must still reach the user');
  assert.equal(delivered[0].mode, undefined, 'the retry drops the parse mode');
  assert.equal(delivered[0].text, 'Shortlist\n1. Engineer', 'markup stripped, content intact');
});

test('telegram: stripHtml unwraps links to their label', () => {
  assert.equal(stripHtml('<a href="https://x.test/j/1">View posting</a>'), 'View posting');
  assert.equal(stripHtml('<b>a</b> &amp; <i>b</i>'), 'a & b');
});

// ── escaping ───────────────────────────────────────────────────────────────

test('telegram: a posting URL cannot break out of the href attribute', () => {
  // Job-board URLs are scraped, untrusted input. A quote used to close the
  // attribute and inject markup, which Telegram rejects — losing the card.
  const link = safeLink('https://evil.test/j"><script>x</script>', 'View original posting');
  assert.ok(!/"><script/.test(link), `attribute escaped out of: ${link}`);
  assert.ok(link.includes('&quot;'));
});

test('telegram: a non-http URL is rendered as text, never as a link', () => {
  assert.equal(safeLink('javascript:alert(1)', 'View posting'), 'View posting');
  assert.equal(safeLink('', 'View posting'), 'View posting');
  assert.ok(safeLink('https://ok.test/j/1', 'View posting').startsWith('<a href="https://ok.test/j/1">'));
});

test('telegram: posting titles with angle brackets are escaped in the match card', () => {
  const posting: type.Posting = {
    id: 'p1', source: 'mock', externalId: 'p1', title: 'Engineer <script>alert(1)</script>',
    company: 'A & B Corp', location: 'Remote', remote: true, description: 'd',
    url: 'https://ok.test/j/1', atsHint: 'unknown', fetchedAt: new Date().toISOString(),
  };
  const card = renderMatchCard(posting, breakdown());
  assert.ok(!card.includes('<script>'), 'raw script tag would break parsing');
  assert.ok(card.includes('&lt;script&gt;'));
  assert.ok(card.includes('A &amp; B Corp'));
});

// ── profile bounds ─────────────────────────────────────────────────────────

test('telegram: an enormous stored field cannot break the profile view', () => {
  // Before the cap, a long paste into a free-text field pushed renderProfile
  // past the limit — and because the value was stored, the profile view stayed
  // broken on every future open.
  const rendered = renderProfile(profile({ education: 'E'.repeat(9000), currentTitle: 'T'.repeat(5000) }));
  assert.ok(rendered.length <= TELEGRAM_LIMIT, `profile view is ${rendered.length} chars`);
  assert.ok(rendered.includes('…'), 'over-long values are visibly truncated');
});

test('telegram: capText trims to the limit without throwing on empty input', () => {
  assert.equal(capText('  hello  ', 100), 'hello');
  assert.equal(capText('abcdef', 3), 'abc');
  assert.equal(capText('', 10), '');
});

test('telegram: a full profile renders within one message', () => {
  const rendered = renderProfile(
    profile({
      email: 'ada@example.com', phone: '+1 555 0100', currentLocation: 'London',
      currentTitle: 'Staff Engineer', yearsExperience: 12, education: 'BSc Mathematics',
      certifications: ['AWS SA'], languages: ['English', 'French'],
      linkedin: 'https://linkedin.com/in/ada', github: 'https://github.com/ada',
      portfolio: 'https://ada.dev', compTarget: 180000, employmentTypes: ['full-time'],
      industries: ['fintech'], companySizes: ['51-200'], factors: ['equity', '4-day week'],
      dealbreakers: ['on-call'], workAuthorization: 'UK citizen', needsSponsorship: false,
      willingToRelocate: true, noticePeriod: '1 month', availableFrom: '2026-09-01',
      wallet: '0x4e9bb70743a3a33bc47514389167903f70f69a07',
    }),
  );
  assert.ok(rendered.length <= TELEGRAM_LIMIT, `full profile is ${rendered.length} chars`);
});

// ── escaping helper ────────────────────────────────────────────────────────

test('telegram: esc survives undefined without throwing', () => {
  assert.equal(esc(undefined as unknown as string), '');
  assert.equal(esc('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
});
