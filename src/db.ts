import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { config } from './config.js';
import type {
  Application,
  ApplicationStatus,
  Draft,
  Engagement,
  EngagementStatus,
  PaymentEvent,
  Posting,
  Profile,
  ScoreBreakdown,
  UsageRecord,
} from './types.js';

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS profiles (
  user_id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS postings (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS seen_postings (
  user_id TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  PRIMARY KEY (user_id, posting_id)
);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  posting_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  engagement_id TEXT NOT NULL,
  posting_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (engagement_id, posting_id)
);
CREATE TABLE IF NOT EXISTS engagements (
  id TEXT PRIMARY KEY,
  okx_job_id TEXT NOT NULL UNIQUE,
  task_code TEXT NOT NULL UNIQUE,
  user_id TEXT,
  status TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE IF NOT EXISTS onboarding_state (
  user_id TEXT PRIMARY KEY,
  step TEXT NOT NULL,
  partial TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  engagement_id TEXT,
  service TEXT NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS x402_nonces (
  nonce TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  engagement_id TEXT NOT NULL,
  found INTEGER, new_count INTEGER, duplicates INTEGER
);
`);

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();

export function postingHash(company: string, title: string, location: string): string {
  return createHash('sha256')
    .update(`${company.toLowerCase().trim()}|${title.toLowerCase().trim()}|${location.toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 16);
}

// ── audit ──────────────────────────────────────────────────────────────────
export function audit(actor: string, action: string, detail?: string): void {
  db.prepare('INSERT INTO audit_log (at, actor, action, detail) VALUES (?, ?, ?, ?)').run(
    now(),
    actor,
    action,
    detail ?? null,
  );
}

// ── profiles ───────────────────────────────────────────────────────────────
export function saveProfile(p: Profile): void {
  db.prepare('INSERT OR REPLACE INTO profiles (user_id, data) VALUES (?, ?)').run(p.userId, JSON.stringify(p));
}
export function getProfile(userId: string): Profile | undefined {
  const row = db.prepare('SELECT data FROM profiles WHERE user_id = ?').get(userId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Profile) : undefined;
}

/**
 * Wallet is an identity key: one wallet belongs to at most ONE profile.
 * Lookup is case-insensitive (EVM addresses compare lowercased).
 */
export function getProfileByWallet(wallet: string): Profile | undefined {
  const target = wallet.trim().toLowerCase();
  const rows = db.prepare('SELECT data FROM profiles').all() as Array<{ data: string }>;
  for (const r of rows) {
    const p = JSON.parse(r.data) as Profile;
    if (p.wallet && p.wallet.toLowerCase() === target) return p;
  }
  return undefined;
}

/**
 * Move a profile (and its live engagements) to a new Telegram account.
 * Used when a user connects a wallet that already carries a profile — their
 * saved data follows the wallet.
 */
export function transferProfile(fromUserId: string, toUserId: string): void {
  const p = getProfile(fromUserId);
  if (!p || fromUserId === toUserId) return;
  db.prepare('DELETE FROM profiles WHERE user_id = ?').run(fromUserId);
  p.userId = toUserId;
  saveProfile(p);
  // Seen-postings history and live engagements follow the profile.
  db.prepare('UPDATE OR IGNORE seen_postings SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
  db.prepare('SELECT id, data FROM engagements WHERE user_id = ?')
    .all(fromUserId)
    .forEach((row) => {
      const e = JSON.parse((row as { data: string }).data) as Engagement;
      if (!['settled', 'disputed'].includes(e.status)) {
        e.userId = toUserId;
        saveEngagement(e);
      }
    });
  audit('db', 'PROFILE_TRANSFERRED', `wallet-based transfer ${fromUserId} -> ${toUserId}`);
}

// ── onboarding state machine persistence ──────────────────────────────────
export function setOnboarding(userId: string, step: string, partial: Record<string, unknown>): void {
  db.prepare('INSERT OR REPLACE INTO onboarding_state (user_id, step, partial) VALUES (?, ?, ?)').run(
    userId,
    step,
    JSON.stringify(partial),
  );
}
export function getOnboarding(userId: string): { step: string; partial: Record<string, unknown> } | undefined {
  const row = db.prepare('SELECT step, partial FROM onboarding_state WHERE user_id = ?').get(userId) as
    | { step: string; partial: string }
    | undefined;
  return row ? { step: row.step, partial: JSON.parse(row.partial) } : undefined;
}
export function clearOnboarding(userId: string): void {
  db.prepare('DELETE FROM onboarding_state WHERE user_id = ?').run(userId);
}

// ── postings ───────────────────────────────────────────────────────────────
export function savePosting(p: Posting): void {
  db.prepare('INSERT OR REPLACE INTO postings (id, data) VALUES (?, ?)').run(p.id, JSON.stringify(p));
}
export function getPosting(id: string): Posting | undefined {
  const row = db.prepare('SELECT data FROM postings WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Posting) : undefined;
}
export function markSeen(userId: string, postingId: string): boolean {
  const res = db
    .prepare('INSERT OR IGNORE INTO seen_postings (user_id, posting_id) VALUES (?, ?)')
    .run(userId, postingId);
  return res.changes > 0; // true if newly seen
}

// ── drafts ─────────────────────────────────────────────────────────────────
export function saveDraft(d: Draft): void {
  db.prepare('INSERT OR REPLACE INTO drafts (id, posting_id, user_id, data) VALUES (?, ?, ?, ?)').run(
    d.id,
    d.postingId,
    d.userId,
    JSON.stringify(d),
  );
}
export function getDraft(id: string): Draft | undefined {
  const row = db.prepare('SELECT data FROM drafts WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Draft) : undefined;
}
export function latestDraftVersion(userId: string, postingId: string): number {
  const rows = db
    .prepare('SELECT data FROM drafts WHERE user_id = ? AND posting_id = ?')
    .all(userId, postingId) as Array<{ data: string }>;
  return rows.reduce((m, r) => Math.max(m, (JSON.parse(r.data) as Draft).version), 0);
}

// ── applications ───────────────────────────────────────────────────────────
export function createApplication(a: Application): boolean {
  try {
    db.prepare(
      'INSERT INTO applications (id, user_id, engagement_id, posting_id, status, data) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(a.id, a.userId, a.engagementId, a.postingId, a.status, JSON.stringify(a));
    return true;
  } catch {
    return false; // UNIQUE violation → already exists (idempotency)
  }
}
export function updateApplication(a: Application): void {
  db.prepare('UPDATE applications SET status = ?, data = ? WHERE id = ?').run(a.status, JSON.stringify(a), a.id);
}
export function getApplication(id: string): Application | undefined {
  const row = db.prepare('SELECT data FROM applications WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Application) : undefined;
}
export function getApplicationByPosting(engagementId: string, postingId: string): Application | undefined {
  const row = db
    .prepare('SELECT data FROM applications WHERE engagement_id = ? AND posting_id = ?')
    .get(engagementId, postingId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Application) : undefined;
}
export function listApplications(engagementId: string, status?: ApplicationStatus): Application[] {
  const rows = (
    status
      ? db.prepare('SELECT data FROM applications WHERE engagement_id = ? AND status = ?').all(engagementId, status)
      : db.prepare('SELECT data FROM applications WHERE engagement_id = ?').all(engagementId)
  ) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as Application);
}
export function countApplicationsToday(userId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare('SELECT data FROM applications WHERE user_id = ?').all(userId) as Array<{ data: string }>;
  return rows.filter((r) => (JSON.parse(r.data) as Application).createdAt.startsWith(today)).length;
}

// ── engagements ────────────────────────────────────────────────────────────
export function saveEngagement(e: Engagement): void {
  db.prepare(
    'INSERT OR REPLACE INTO engagements (id, okx_job_id, task_code, user_id, status, data) VALUES (?, ?, ?, ?, ?, ?)',
  ).run(e.id, e.okxJobId, e.taskCode, e.userId ?? null, e.status, JSON.stringify(e));
}
export function getEngagementByCode(taskCode: string): Engagement | undefined {
  const row = db.prepare('SELECT data FROM engagements WHERE task_code = ?').get(taskCode) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as Engagement) : undefined;
}
export function getEngagementById(id: string): Engagement | undefined {
  const row = db.prepare('SELECT data FROM engagements WHERE id = ?').get(id) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Engagement) : undefined;
}
export function getEngagementByJob(okxJobId: string): Engagement | undefined {
  const row = db.prepare('SELECT data FROM engagements WHERE okx_job_id = ?').get(okxJobId) as
    | { data: string }
    | undefined;
  return row ? (JSON.parse(row.data) as Engagement) : undefined;
}
export function getEngagementByUser(userId: string): Engagement | undefined {
  const rows = db.prepare('SELECT data FROM engagements WHERE user_id = ?').all(userId) as Array<{ data: string }>;
  const live = rows
    .map((r) => JSON.parse(r.data) as Engagement)
    .filter((e) => !['settled', 'disputed'].includes(e.status));
  return live[live.length - 1];
}
export function listEngagements(status?: EngagementStatus): Engagement[] {
  const rows = (
    status
      ? db.prepare('SELECT data FROM engagements WHERE status = ?').all(status)
      : db.prepare('SELECT data FROM engagements').all()
  ) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as Engagement);
}

// ── payments ───────────────────────────────────────────────────────────────
export function savePayment(p: PaymentEvent): void {
  db.prepare('INSERT OR REPLACE INTO payments (id, data) VALUES (?, ?)').run(p.id, JSON.stringify(p));
}

// ── usage ledger ───────────────────────────────────────────────────────────
export function recordUsage(u: UsageRecord): void {
  db.prepare('INSERT OR REPLACE INTO usage_records (id, user_id, engagement_id, service, at, data) VALUES (?, ?, ?, ?, ?, ?)').run(
    u.id, u.userId, u.engagementId ?? null, u.service, u.at, JSON.stringify(u),
  );
}
export function listUsage(userId: string, limit = 50): UsageRecord[] {
  const rows = db
    .prepare('SELECT data FROM usage_records WHERE user_id = ? ORDER BY at DESC LIMIT ?')
    .all(userId, limit) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as UsageRecord);
}
export function countUsage(engagementId: string): number {
  const row = db.prepare('SELECT COUNT(*) as n FROM usage_records WHERE engagement_id = ?').get(engagementId) as { n: number };
  return row.n;
}

/**
 * Replay protection: returns true the FIRST time a nonce is seen, false after.
 *
 * This is a RESERVATION, taken before settlement so two concurrent requests
 * carrying one authorization cannot both spend it. A caller that does not go
 * on to settle must `releaseNonce` — see x402.ts step 4.
 */
export function consumeNonce(nonce: string): boolean {
  const res = db.prepare('INSERT OR IGNORE INTO x402_nonces (nonce, at) VALUES (?, ?)').run(nonce, now());
  return res.changes > 0;
}

/**
 * Undo a reservation that never became a payment.
 *
 * Without this, a transient facilitator outage would permanently brick a valid
 * payment authorization: the buyer's retry hits "replay rejected" and they can
 * never pay for that call. Only safe because it is called exclusively on paths
 * where no settlement occurred.
 */
export function releaseNonce(nonce: string): void {
  db.prepare('DELETE FROM x402_nonces WHERE nonce = ?').run(nonce);
}

// ── scan runs ──────────────────────────────────────────────────────────────
export function recordScanRun(engagementId: string, found: number, newCount: number, duplicates: number): void {
  db.prepare('INSERT INTO scan_runs (at, engagement_id, found, new_count, duplicates) VALUES (?, ?, ?, ?, ?)').run(
    now(),
    engagementId,
    found,
    newCount,
    duplicates,
  );
}

export type { ScoreBreakdown };
export { db };
