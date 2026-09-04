/**
 * Outbound HTTP with a mandatory deadline, plus small inbound-server helpers.
 *
 * Node's global fetch has no overall timeout — only undici's per-stage
 * headers/body timeouts (~300s each), and a server that trickles bytes can
 * hold a connection well past even those. A slow source has to lose to the
 * clock, not take the caller down with it.
 *
 * Every outbound call in this codebase goes through here.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { config } from './config.js';

/** Default ceiling for a single outbound request. */
export const DEFAULT_TIMEOUT_MS = 20_000;

export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<Response> {
  // AbortSignal.timeout fires on total elapsed time, which is the property we
  // actually want — per-stage timeouts can each reset on a trickle.
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await fetch(url, { ...init, signal });
  } catch (err) {
    // A timeout arrives as an opaque AbortError/TimeoutError; name it so the
    // caller's error string says what happened rather than "This operation
    // was aborted".
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new Error(`timeout after ${timeoutMs}ms`);
    }
    throw err;
  }
}

// ── inbound server helpers ─────────────────────────────────────────────────

export function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(data));
}

export function readBody(req: IncomingMessage, res: ServerResponse): Promise<string | null> {
  return new Promise((resolve) => {
    let body = '';
    let overflow = false;
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        overflow = true;
        res.writeHead(413);
        res.end('payload too large');
        req.destroy();
        resolve(null);
      }
    });
    req.on('end', () => resolve(overflow ? null : body));
  });
}

/**
 * Body reader for the miner surface, where any non-2xx scores exactly 0.
 *
 * `readBody` answers an oversized body with a bare 413 — correct for the paid
 * direct API, fatal for a routed miner call: the engine stores an empty answer
 * and the scorer never reads our body. Here an oversized body is TRUNCATED at
 * the cap and the request still answers 200. A 1 MB prefix of a resume is
 * plenty to write from; a 413 is worth nothing.
 *
 * Never rejects, never touches the response, never resolves null.
 */
export function readBodyTruncating(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve) => {
    let body = '';
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve(body);
    };
    req.on('data', (chunk) => {
      if (done) return;
      body += chunk;
      if (body.length > limitBytes) {
        body = body.slice(0, limitBytes);
        // Stop reading, but answer from what we already have.
        req.destroy();
        finish();
      }
    });
    req.on('end', finish);
    // A client that dies mid-upload must not hang the handler forever.
    req.on('error', finish);
    req.on('aborted', finish);
  });
}

// ── request identity + per-IP rate limiting ─────────────────────────────────
// Shared by the core API surfaces and the Track 3 web app: the free tiers are
// metered per client IP, and the identity behind that IP must be derived the
// same way everywhere (loopback gets the internal-client attribution, proxies
// get the last forwarded hop only when trusted).

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function clientIp(req: IncomingMessage): string {
  const socketIp = req.socket.remoteAddress ?? 'unknown';
  if (isLoopback(socketIp)) {
    const key = req.headers['x-internal-client'];
    if (typeof key === 'string' && key.length) return `internal:${key.slice(0, 100)}`;
  }
  if (!config.trustProxy) return socketIp;
  const forwarded = req.headers['x-forwarded-for'];
  const chain = (Array.isArray(forwarded) ? forwarded.join(',') : forwarded ?? '').split(',').map((value) => value.trim()).filter(Boolean);
  return chain.at(-1) ?? socketIp;
}

/** Window for the per-IP free-tier rate limits (one hour). */
export const PREVIEW_WINDOW_MS = 60 * 60 * 1000;
/** Default free-tier allowance per window. */
export const PREVIEW_LIMIT = 3;

export function rateAllowed(hits: Map<string, number[]>, ip: string, limit = PREVIEW_LIMIT): { ok: boolean; remaining: number; retryAfterSec: number } {
  const cutoff = Date.now() - PREVIEW_WINDOW_MS;
  const list = (hits.get(ip) ?? []).filter((time) => time > cutoff);
  if (list.length >= limit) return { ok: false, remaining: 0, retryAfterSec: Math.ceil((list[0] + PREVIEW_WINDOW_MS - Date.now()) / 1000) };
  list.push(Date.now());
  hits.set(ip, list);
  return { ok: true, remaining: limit - list.length, retryAfterSec: 0 };
}
