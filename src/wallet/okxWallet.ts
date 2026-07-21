import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { audit } from '../db.js';

const run = promisify(execFile);

/**
 * OKX Agentic Wallet — browser social login, per Telegram user.
 *
 * Flow (onchainos CLI >= 4.x, `wallet login`):
 *   1. `wallet login --phase init`               → { loginUrl, authSessionId }
 *   2. user opens loginUrl and signs in at OKX   (Google / Apple / Email)
 *   3. `wallet login --phase poll --session-id`  → session persisted, account returned
 *
 * There is deliberately no email/OTP path here: OKX does not expose one to the
 * CLI. The one-time code is entered on OKX's own page, never in this chat —
 * which is the safer arrangement anyway, since Legwork never handles the code.
 *
 * Multi-tenancy: the CLI keeps its session (keyring, tokens) inside its home
 * directory. Each Telegram user therefore gets an isolated ONCHAINOS_HOME, so
 * one user's session can never leak into another's.
 *
 * Custody: keys are generated inside OKX's TEE and never leave it. Legwork
 * never sees, stores, or can export a private key — only the public address.
 */

const WALLET_ROOT = process.env.WALLET_HOME_ROOT || path.join(process.env.DATABASE_PATH?.startsWith('/data') ? '/data' : '.', 'wallets');
const CLI = process.env.ONCHAINOS_BIN || 'onchainos';
const TIMEOUT_MS = 90_000;

/** The CLI blocks up to 5 min on `--phase poll`; cap it well below Telegram's patience. */
const POLL_TIMEOUT_MS = Number(process.env.WALLET_POLL_TIMEOUT_MS ?? 45_000);

function homeFor(userId: string): string {
  // userId is a Telegram numeric id; keep it filesystem-safe regardless.
  const safe = userId.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = path.join(WALLET_ROOT, safe);
  mkdirSync(dir, { recursive: true });
  return dir;
}

interface CliResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  confirming?: boolean;
}

/** Last JSON object printed on a stream — the CLI logs plain text above it. */
function lastJson(stream: string | undefined): string | undefined {
  return (stream ?? '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
}

async function cli<T>(userId: string, args: string[], timeoutMs = TIMEOUT_MS): Promise<CliResult<T>> {
  try {
    const { stdout } = await run(CLI, ['wallet', ...args], {
      env: { ...process.env, ONCHAINOS_HOME: homeFor(userId) },
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    const line = lastJson(stdout);
    if (!line) return { ok: false, error: 'no JSON in CLI output' };
    const parsed = JSON.parse(line) as { ok?: boolean; data?: T; msg?: string; message?: string; confirming?: boolean };
    return {
      ok: parsed.ok !== false,
      data: parsed.data,
      error: parsed.ok === false ? parsed.msg ?? parsed.message ?? 'wallet command failed' : undefined,
      confirming: parsed.confirming,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; killed?: boolean; message?: string };
    // Exit code 2 = "confirming": the CLI wants an explicit re-run with --force.
    const out = lastJson(e.stdout);
    if (out) {
      try {
        const parsed = JSON.parse(out) as { msg?: string; message?: string; confirming?: boolean };
        const msg = parsed.msg ?? parsed.message ?? '';
        return {
          ok: false,
          // The CLI answered, so never fall back to the "not installed" text —
          // that would misdiagnose an OKX-side error as a missing binary.
          error: msg ? cleanError(msg) : 'OKX rejected that request. Please try again.',
          confirming: e.code === 2 || parsed.confirming,
        };
      } catch {
        /* fall through */
      }
    }
    if (e.killed) return { ok: false, error: 'TIMEOUT' };
    return { ok: false, error: cleanError(e.stderr ?? e.message ?? String(err)) };
  }
}

function cleanError(raw: string): string {
  const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('[')) ?? raw;
  const cleaned = line.replace(/^error:\s*/i, '').trim().slice(0, 300);
  // ENOENT / empty stderr means the CLI itself is missing — say so plainly
  // rather than surfacing a blank error to the user.
  if (!cleaned || /ENOENT|not found|No such file/i.test(cleaned)) {
    return 'The OKX wallet service is not available from this deployment right now.';
  }
  // OKX returns region codes that mean nothing to a user; translate per the
  // OKX wallet troubleshooting guide.
  if (/\b(50125|80001)\b/.test(cleaned)) {
    return 'OKX wallet is not available in your region right now.';
  }
  if (/not logged in/i.test(cleaned)) {
    return 'That sign-in session has expired. Start again to get a fresh link.';
  }
  return cleaned;
}

/**
 * Is the OKX CLI available in this environment?
 *
 * Cached: this is asked on every wallet button press, and whether a binary
 * exists on PATH does not change while the process is running. A negative
 * result is re-probed periodically so a sidecar install can be picked up
 * without a restart.
 */
let cliProbe: { available: boolean; at: number } | undefined;
const CLI_PROBE_TTL_MS = 5 * 60_000;

export async function walletCliAvailable(): Promise<boolean> {
  const fresh = cliProbe && (cliProbe.available || Date.now() - cliProbe.at < CLI_PROBE_TTL_MS);
  if (fresh) return cliProbe!.available;
  let available: boolean;
  try {
    await run(CLI, ['--version'], { timeout: 15_000 });
    available = true;
  } catch {
    available = false;
  }
  cliProbe = { available, at: Date.now() };
  return available;
}

export interface WalletStatus {
  loggedIn: boolean;
  email?: string;
  accountName?: string;
  accountCount?: number;
  loginType?: string;
}

export async function walletStatus(userId: string): Promise<WalletStatus> {
  const res = await cli<{
    loggedIn?: boolean;
    email?: string;
    currentAccountName?: string;
    accountCount?: number;
    loginType?: string;
  }>(userId, ['status']);
  if (!res.ok || !res.data) return { loggedIn: false };
  return {
    loggedIn: Boolean(res.data.loggedIn),
    email: res.data.email || undefined,
    accountName: res.data.currentAccountName || undefined,
    accountCount: res.data.accountCount,
    loginType: res.data.loginType || undefined,
  };
}

export interface LoginSession {
  ok: boolean;
  loginUrl?: string;
  sessionId?: string;
  error?: string;
}

/**
 * Step 1 — mint the OKX login URL.
 *
 * `--phase init` also best-effort opens a browser, which is a no-op on a
 * headless server. The returned URL is what actually matters: we hand it to
 * the user as a button so they sign in on their own device.
 */
export async function startLogin(userId: string): Promise<LoginSession> {
  const res = await cli<{ loginUrl?: string; authSessionId?: string }>(userId, ['login', '--phase', 'init']);
  if (!res.ok || !res.data?.loginUrl || !res.data?.authSessionId) {
    return { ok: false, error: res.error ?? 'OKX did not return a sign-in link.' };
  }
  audit('wallet', 'LOGIN_INIT', `user=${userId}`); // never log the URL: it is a bearer credential
  return { ok: true, loginUrl: res.data.loginUrl, sessionId: res.data.authSessionId };
}

export interface LoginResult {
  ok: boolean;
  pending?: boolean;
  address?: string;
  email?: string;
  loginType?: string;
  accountName?: string;
  isNew?: boolean;
  error?: string;
}

/**
 * Step 2 — poll for the completed sign-in.
 *
 * `pending` (rather than an error) means the user has not finished on OKX's
 * page yet; the same sessionId stays valid, so the caller can simply poll again.
 */
export async function pollLogin(userId: string, sessionId: string): Promise<LoginResult> {
  const res = await cli<Record<string, unknown>>(
    userId,
    ['login', '--phase', 'poll', '--session-id', sessionId],
    POLL_TIMEOUT_MS,
  );

  if (!res.ok) {
    if (res.error === 'TIMEOUT' || /timeout|pending|not.*complete/i.test(res.error ?? '')) {
      return { ok: false, pending: true };
    }
    return { ok: false, error: res.error ?? 'Sign-in could not be confirmed.' };
  }

  const data = res.data ?? {};
  // The address may come back on the poll payload; fall back to an explicit
  // lookup so a schema change cannot silently strand the connection.
  const address = extractEvmAddress(data) ?? (await xlayerAddress(userId));
  if (!address) return { ok: false, error: 'Signed in, but OKX returned no wallet address.' };

  audit('wallet', 'LOGIN_VERIFIED', `user=${userId} isNew=${data.isNew}`);
  return {
    ok: true,
    address,
    email: str(data.email),
    loginType: str(data.loginType),
    accountName: str(data.accountName),
    isNew: Boolean(data.isNew),
  };
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim() ? v.trim() : undefined;
}

const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

/**
 * Pull an EVM address out of a CLI payload.
 *
 * The CLI groups addresses by chain category and has changed that shape
 * between releases, so this prefers the documented keys and only then falls
 * back to a bounded search for anything address-shaped. Solana keys are
 * excluded explicitly — an X Layer profile must never be keyed on one.
 */
export function extractEvmAddress(payload: unknown): string | undefined {
  const preferred = ['xlayer', 'xLayer', 'evm', 'evmAddress', 'xlayerAddress', 'address'];
  const seen = new Set<unknown>();

  const fromNode = (node: unknown): string | undefined => {
    if (typeof node === 'string') return EVM_ADDRESS.test(node) ? node : undefined;
    if (Array.isArray(node)) {
      for (const item of node) {
        const hit = fromNode(item);
        if (hit) return hit;
      }
      return undefined;
    }
    if (!node || typeof node !== 'object') return undefined;
    if (seen.has(node)) return undefined;
    seen.add(node);
    const obj = node as Record<string, unknown>;
    for (const key of preferred) {
      if (key in obj) {
        const hit = fromNode(obj[key]);
        if (hit) return hit;
      }
    }
    for (const [key, value] of Object.entries(obj)) {
      if (/sol(ana)?/i.test(key)) continue;
      const hit = fromNode(value);
      if (hit) return hit;
    }
    return undefined;
  };

  return fromNode(payload);
}

/** The user's X Layer address for the active account. */
export async function xlayerAddress(userId: string): Promise<string | undefined> {
  const res = await cli<unknown>(userId, ['addresses', '--chain', 'xlayer']);
  if (!res.ok || !res.data) return undefined;
  return extractEvmAddress(res.data);
}

/** Exposed for tests: the per-user session directory. */
export function homeForTest(userId: string): string {
  return homeFor(userId);
}

/** Sign the user out on this device (session only — the wallet itself persists). */
export async function walletLogout(userId: string): Promise<boolean> {
  const res = await cli(userId, ['logout']);
  if (res.ok) audit('wallet', 'LOGGED_OUT', `user=${userId}`);
  return res.ok;
}
