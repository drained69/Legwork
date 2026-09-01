import Database from 'better-sqlite3';
import { randomUUID, createHash } from 'node:crypto';
import { config } from './config.js';
import type {
  Application,
  ApplicationStatus,
  Draft,
  PaymentEvent,
  Posting,
  Profile,
  ScoreBreakdown,
  UsageRecord,
  WalletRecord,
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
  posting_id TEXT NOT NULL,
  status TEXT NOT NULL,
  data TEXT NOT NULL,
  UNIQUE (user_id, posting_id)
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wallets (
  user_id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
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
  service TEXT NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS payment_nonces (
  nonce TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT NOT NULL,
  found INTEGER, new_count INTEGER, duplicates INTEGER
);
CREATE TABLE IF NOT EXISTS redflag_reports (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company TEXT NOT NULL,
  verdict TEXT NOT NULL,
  spend_usd REAL NOT NULL,
  at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redflag_reports_user ON redflag_reports (user_id, at);
CREATE TABLE IF NOT EXISTS redflag_watches (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  company TEXT NOT NULL,
  chat_id INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  last_alert_signal TEXT,
  last_check_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_redflag_watches_due ON redflag_watches (active, last_check_at);
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
 * Move a profile to a new Telegram account. Used when a user connects a wallet
 * that already carries a profile — their saved data follows the wallet.
 */
export function transferProfile(fromUserId: string, toUserId: string): void {
  const p = getProfile(fromUserId);
  if (!p || fromUserId === toUserId) return;
  db.prepare('DELETE FROM profiles WHERE user_id = ?').run(fromUserId);
  p.userId = toUserId;
  saveProfile(p);
  // Seen-postings history follows the profile.
  db.prepare('UPDATE OR IGNORE seen_postings SET user_id = ? WHERE user_id = ?').run(toUserId, fromUserId);
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
      'INSERT INTO applications (id, user_id, posting_id, status, data) VALUES (?, ?, ?, ?, ?)',
    ).run(a.id, a.userId, a.postingId, a.status, JSON.stringify(a));
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
export function getApplicationByPosting(userId: string, postingId: string): Application | undefined {
  const row = db
    .prepare('SELECT data FROM applications WHERE user_id = ? AND posting_id = ?')
    .get(userId, postingId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as Application) : undefined;
}
export function listApplications(userId: string, status?: ApplicationStatus): Application[] {
  const rows = (
    status
      ? db.prepare('SELECT data FROM applications WHERE user_id = ? AND status = ?').all(userId, status)
      : db.prepare('SELECT data FROM applications WHERE user_id = ?').all(userId)
  ) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as Application);
}
export function countApplicationsToday(userId: string): number {
  const today = new Date().toISOString().slice(0, 10);
  const rows = db.prepare('SELECT data FROM applications WHERE user_id = ?').all(userId) as Array<{ data: string }>;
  return rows.filter((r) => (JSON.parse(r.data) as Application).createdAt.startsWith(today)).length;
}

// ── payments ───────────────────────────────────────────────────────────────
export function savePayment(p: PaymentEvent): void {
  db.prepare('INSERT OR REPLACE INTO payments (id, data) VALUES (?, ?)').run(p.id, JSON.stringify(p));
}

export function saveWallet(wallet: WalletRecord): void {
  db.prepare('INSERT OR REPLACE INTO wallets (user_id, address, data) VALUES (?, ?, ?)').run(
    wallet.userId,
    wallet.address.toLowerCase(),
    JSON.stringify(wallet),
  );
}

export function getWallet(userId: string): WalletRecord | undefined {
  const row = db.prepare('SELECT data FROM wallets WHERE user_id = ?').get(userId) as { data: string } | undefined;
  return row ? (JSON.parse(row.data) as WalletRecord) : undefined;
}

export function deleteWallet(userId: string): void {
  db.prepare('DELETE FROM wallets WHERE user_id = ?').run(userId);
}

// ── usage ledger ───────────────────────────────────────────────────────────
export function recordUsage(u: UsageRecord): void {
  db.prepare('INSERT OR REPLACE INTO usage_records (id, user_id, service, at, data) VALUES (?, ?, ?, ?, ?)').run(
    u.id, u.userId, u.service, u.at, JSON.stringify(u),
  );
}
export function listUsage(userId: string, limit = 50): UsageRecord[] {
  const rows = db
    .prepare('SELECT data FROM usage_records WHERE user_id = ? ORDER BY at DESC LIMIT ?')
    .all(userId, limit) as Array<{ data: string }>;
  return rows.map((r) => JSON.parse(r.data) as UsageRecord);
}

/**
 * Replay protection: returns true the FIRST time a nonce is seen, false after.
 *
 * This is a RESERVATION, taken before a payment is recorded so two concurrent
 * requests carrying one transaction cannot both spend it.
 */
export function consumeNonce(nonce: string): boolean {
  const res = db.prepare('INSERT OR IGNORE INTO payment_nonces (nonce, at) VALUES (?, ?)').run(nonce, now());
  return res.changes > 0;
}

/**
 * Undo a reservation that never became a payment.
 */
export function releaseNonce(nonce: string): void {
  db.prepare('DELETE FROM payment_nonces WHERE nonce = ?').run(nonce);
}

// ── scan runs ──────────────────────────────────────────────────────────────
export function recordScanRun(userId: string, found: number, newCount: number, duplicates: number): void {
  db.prepare('INSERT INTO scan_runs (at, user_id, found, new_count, duplicates) VALUES (?, ?, ?, ?, ?)').run(
    now(),
    userId,
    found,
    newCount,
    duplicates,
  );
}

// ── redflag reports (paid due-diligence history) ───────────────────────────

export interface RedflagReportRecord {
  id: string;
  userId: string;
  company: string;
  verdict: string;
  spendUsd: number;
  at: string;
  data: unknown;
}

export function saveRedflagReport(record: RedflagReportRecord): void {
  db.prepare(
    'INSERT OR REPLACE INTO redflag_reports (id, user_id, company, verdict, spend_usd, at, data) VALUES (?, ?, ?, ?, ?, ?, ?)',
  ).run(record.id, record.userId, record.company, record.verdict, record.spendUsd, record.at, JSON.stringify(record.data));
}

export function listRedflagReports(userId: string, limit = 5): RedflagReportRecord[] {
  const rows = db
    .prepare('SELECT id, user_id, company, verdict, spend_usd, at, data FROM redflag_reports WHERE user_id = ? ORDER BY at DESC LIMIT ?')
    .all(userId, limit) as Array<{ id: string; user_id: string; company: string; verdict: string; spend_usd: number; at: string; data: string }>;
  return rows.map((r) => ({ id: r.id, userId: r.user_id, company: r.company, verdict: r.verdict, spendUsd: r.spend_usd, at: r.at, data: JSON.parse(r.data) }));
}

// ── redflag watches (standing company news alerts) ─────────────────────────

export interface RedflagWatch {
  id: string;
  userId: string;
  company: string;
  chatId: number | null;
  active: boolean;
  lastAlertSignal: string | null;
  lastCheckAt: string | null;
  createdAt: string;
}

interface WatchRow {
  id: string; user_id: string; company: string; chat_id: number | null;
  active: number; last_alert_signal: string | null; last_check_at: string | null; created_at: string;
}

const watchFromRow = (r: WatchRow): RedflagWatch => ({
  id: r.id, userId: r.user_id, company: r.company, chatId: r.chat_id,
  active: r.active === 1, lastAlertSignal: r.last_alert_signal, lastCheckAt: r.last_check_at, createdAt: r.created_at,
});

export function createWatch(userId: string, company: string, chatId: number | null): RedflagWatch {
  const watch: RedflagWatch = {
    id: uid(), userId, company: company.trim().slice(0, 120), chatId,
    active: true, lastAlertSignal: null, lastCheckAt: null, createdAt: now(),
  };
  db.prepare(
    'INSERT INTO redflag_watches (id, user_id, company, chat_id, active, last_alert_signal, last_check_at, created_at) VALUES (?, ?, ?, ?, 1, NULL, NULL, ?)',
  ).run(watch.id, watch.userId, watch.company, watch.chatId, watch.createdAt);
  return watch;
}

export function listWatches(userId: string): RedflagWatch[] {
  const rows = db
    .prepare('SELECT * FROM redflag_watches WHERE user_id = ? AND active = 1 ORDER BY created_at DESC')
    .all(userId) as WatchRow[];
  return rows.map(watchFromRow);
}

export function listActiveWatches(): RedflagWatch[] {
  const rows = db.prepare('SELECT * FROM redflag_watches WHERE active = 1').all() as WatchRow[];
  return rows.map(watchFromRow);
}

export function getWatch(id: string): RedflagWatch | undefined {
  const row = db.prepare('SELECT * FROM redflag_watches WHERE id = ?').get(id) as WatchRow | undefined;
  return row ? watchFromRow(row) : undefined;
}

export function deactivateWatch(id: string): boolean {
  return db.prepare('UPDATE redflag_watches SET active = 0 WHERE id = ? AND active = 1').run(id).changes > 0;
}

export function updateWatchCheck(id: string): void {
  db.prepare('UPDATE redflag_watches SET last_check_at = ? WHERE id = ?').run(now(), id);
}

export function updateWatchAlert(id: string, signal: string): void {
  db.prepare('UPDATE redflag_watches SET last_alert_signal = ? WHERE id = ?').run(signal, id);
}

export type { ScoreBreakdown };
export { db };
