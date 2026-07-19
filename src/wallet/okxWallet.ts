import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { audit } from '../db.js';

const run = promisify(execFile);

/**
 * OKX Agentic Wallet — email + OTP login, per Telegram user.
 *
 * Flow (documented in the OKX user tutorial / wallet skill):
 *   1. `wallet login <email>`  → OKX emails a one-time code
 *   2. `wallet verify <code>`  → session established, wallet created/restored
 *   3. `wallet addresses`      → the user's X Layer address
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

async function cli<T>(userId: string, args: string[]): Promise<CliResult<T>> {
  try {
    const { stdout } = await run(CLI, ['wallet', ...args], {
      env: { ...process.env, ONCHAINOS_HOME: homeFor(userId) },
      timeout: TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    });
    const line = stdout.trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    if (!line) return { ok: false, error: 'no JSON in CLI output' };
    const parsed = JSON.parse(line) as { ok?: boolean; data?: T; msg?: string; message?: string; confirming?: boolean };
    return {
      ok: parsed.ok !== false,
      data: parsed.data,
      error: parsed.ok === false ? parsed.msg ?? parsed.message ?? 'wallet command failed' : undefined,
      confirming: parsed.confirming,
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number; message?: string };
    // Exit code 2 = "confirming": the CLI wants an explicit re-run with --force.
    const out = (e.stdout ?? '').trim().split('\n').filter((l) => l.trim().startsWith('{')).pop();
    if (out) {
      try {
        const parsed = JSON.parse(out) as { msg?: string; message?: string; confirming?: boolean };
        return {
          ok: false,
          error: parsed.msg ?? parsed.message ?? 'OKX could not complete that request. Check the email address and try again.',
          confirming: e.code === 2 || parsed.confirming,
        };
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: cleanError(e.stderr ?? e.message ?? String(err)) };
  }
}

function cleanError(raw: string): string {
  const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('[')) ?? raw;
  const cleaned = line.replace(/^error:\s*/i, '').trim().slice(0, 300);
  // ENOENT / empty stderr means the CLI itself is missing — say so plainly
  // rather than surfacing a blank error to the user.
  if (!cleaned || /ENOENT|not found/i.test(cleaned)) {
    return 'The OKX wallet service is not available from this deployment right now.';
  }
  return cleaned;
}

/** Is the OKX CLI available in this environment? */
export async function walletCliAvailable(): Promise<boolean> {
  try {
    await run(CLI, ['--version'], { timeout: 15_000 });
    return true;
  } catch {
    return false;
  }
}

export interface WalletStatus {
  loggedIn: boolean;
  email?: string;
  accountName?: string;
  accountCount?: number;
}

export async function walletStatus(userId: string): Promise<WalletStatus> {
  const res = await cli<{ loggedIn?: boolean; email?: string; currentAccountName?: string; accountCount?: number }>(
    userId,
    ['status'],
  );
  if (!res.ok || !res.data) return { loggedIn: false };
  return {
    loggedIn: Boolean(res.data.loggedIn),
    email: res.data.email || undefined,
    accountName: res.data.currentAccountName || undefined,
    accountCount: res.data.accountCount,
  };
}

/** Step 1 — send the one-time code to the user's email. */
export async function startEmailLogin(userId: string, email: string): Promise<{ ok: boolean; error?: string }> {
  const res = await cli(userId, ['login', email, '--locale', 'en_US', '--chain', 'xlayer']);
  if (res.ok) {
    audit('wallet', 'OTP_SENT', `user=${userId}`); // never log the email itself
    return { ok: true };
  }
  // A stale session on this user's home can block a fresh login — retry once forced.
  if (res.confirming || /last time|already/i.test(res.error ?? '')) {
    const forced = await cli(userId, ['login', email, '--locale', 'en_US', '--chain', 'xlayer', '--force']);
    if (forced.ok) {
      audit('wallet', 'OTP_SENT_FORCED', `user=${userId}`);
      return { ok: true };
    }
    return { ok: false, error: forced.error };
  }
  return { ok: false, error: res.error };
}

export interface VerifyResult {
  ok: boolean;
  address?: string;
  isNew?: boolean;
  error?: string;
}

/** Step 2 — verify the emailed code; the wallet is created or restored. */
export async function verifyEmailOtp(userId: string, code: string): Promise<VerifyResult> {
  const res = await cli<{ isNew?: boolean }>(userId, ['verify', code.trim(), '--chain', 'xlayer']);
  if (!res.ok) return { ok: false, error: res.error ?? 'Verification failed' };
  const address = await xlayerAddress(userId);
  audit('wallet', 'OTP_VERIFIED', `user=${userId} isNew=${res.data?.isNew}`);
  return { ok: true, address, isNew: res.data?.isNew };
}

/** The user's X Layer address for the active account. */
export async function xlayerAddress(userId: string): Promise<string | undefined> {
  const res = await cli<{ xlayer?: Array<{ address?: string }>; evm?: Array<{ address?: string }> }>(userId, [
    'addresses',
    '--chain',
    'xlayer',
  ]);
  if (!res.ok || !res.data) return undefined;
  return res.data.xlayer?.[0]?.address ?? res.data.evm?.[0]?.address;
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
