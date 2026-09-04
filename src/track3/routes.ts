import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { config } from '../config.js';
import { createWatch, deactivateWatch, getRedflagReport, getWatchByReport, now, recordAppEvent, recentRedflagReports, redflagSpendSince, redflagStats, saveRedflagReport, uid } from '../db.js';
import { runRedflag, runRedflagPreview, type RedflagInput } from './redflag.js';
import { REDFLAG_PAGE_HTML } from './redflagPage.js';
import { renderReportPage } from './reportPage.js';
import { huntSignal } from '../miner/miner.js';
import { clientIp, json, PREVIEW_LIMIT, rateAllowed, readBody } from '../http.js';

/**
 * Track 3 — the Telegraph consumer web app (https://docs.telegraphprotocol.com).
 *
 * The SPEND side of the flywheel: the public web surface where Legwork's
 * wallet buys answers from other Telegraph miners. One page serves both
 * sides of the network — the free hunt tool runs the exact signal the
 * miner serves (see handleHuntWeb), and the vetting tool pays four network
 * checks on the visitor's behalf. Report pages are the shareable receipts,
 * and double as the inbox for standing web watches.
 *
 * Mounted from server.ts exactly like the miner surface: isTrack3Route
 * claims the request, handleTrack3Route answers it.
 */

const redflagPreviewHits = new Map<string, number[]>();
const redflagWebHits = new Map<string, number[]>();
const huntWebHits = new Map<string, number[]>();
/** The free hunt tool is the chatty demo surface — more headroom than vetting. */
const HUNT_WEB_LIMIT = 6;

/** The public origin for share links — PUBLIC_URL when set, else the request's own host. */
function publicOrigin(req: IncomingMessage): string {
  if (config.server.publicUrl) return config.server.publicUrl.replace(/\/+$/, '');
  const host = req.headers.host;
  const proto = host?.includes('localhost') ? 'http' : 'https';
  return host ? `${proto}://${host}` : '';
}

/**
 * The free Redflag tier: local scam scan + live comp benchmark, zero miner
 * spend, rate-limited like the hunt preview. Paid network checks are listed
 * as skipped with a pointer to the paid report — a preview never pretends
 * to be a full vetting.
 */
async function handleRedflagPreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gate = rateAllowed(redflagPreviewHits, clientIp(req));
  if (!gate.ok) return json(res, 429, { ok: false, error: `Free scan limit reached (${PREVIEW_LIMIT}/hour)`, retryAfterSeconds: gate.retryAfterSec });
  const raw = await readBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch (error) {
    return json(res, 400, { ok: false, error: `request body is not valid JSON: ${String(error)}` });
  }
  const input = (body.redflag ?? body) as Partial<RedflagInput>;
  const hasSubject = [input.text, input.description, input.company].some((v) => typeof v === 'string' && v.trim().length > 0);
  if (!hasSubject) return json(res, 400, { ok: false, error: 'paste a job posting or offer to scan (text, description or company)' });
  try {
    const result = await runRedflagPreview(input as RedflagInput);
    json(res, 200, { ok: true, verdict: result.verdict, previewsRemainingThisHour: gate.remaining, result });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error) });
  }
}

/**
 * The FULL vetting behind the public "Run full vetting" button — the
 * Telegraph consumer surface. Legwork's wallet buys the four live miner
 * checks; the visitor pays nothing. Two guardrails keep a public,
 * operator-paid endpoint honest: a per-IP rate limit, and a daily spend
 * ceiling read from the reports ledger (so it survives restarts). The daily
 * remainder is passed to the runner as its per-report budget, which means a
 * single vetting can also never blow THROUGH the cap mid-flight — a check
 * that would exceed it is skipped before payment, same as always.
 */
async function handleRedflagWeb(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!config.telegraph.enabled) {
    return json(res, 503, {
      ok: false,
      error: 'Network checks are not configured on this deployment (no Telegraph wallet) — the free scan still works.',
    });
  }
  const gate = rateAllowed(redflagWebHits, clientIp(req), config.telegraph.webFullRatePerHour);
  if (!gate.ok) return json(res, 429, { ok: false, error: `Full-vetting limit reached (${config.telegraph.webFullRatePerHour}/hour) — the free scan is still available.`, retryAfterSeconds: gate.retryAfterSec });
  const raw = await readBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch (error) {
    return json(res, 400, { ok: false, error: `request body is not valid JSON: ${String(error)}` });
  }
  const input = (body.redflag ?? body) as Partial<RedflagInput>;
  const hasSubject = [input.text, input.description, input.company].some((v) => typeof v === 'string' && v.trim().length > 0);
  if (!hasSubject) return json(res, 400, { ok: false, error: 'paste a job posting or offer to vet (text, description or company)' });

  // Daily ceiling from the ledger: everything the web surface has spent since
  // UTC midnight. The per-report budget is the smaller of the configured
  // per-report ceiling and what remains of the day's.
  const todayStart = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z').toISOString();
  const spentToday = redflagSpendSince('web:', todayStart);
  const dailyRemaining = config.telegraph.webDailyBudgetUsd - spentToday;
  if (dailyRemaining <= 0.004) {
    return json(res, 429, {
      ok: false,
      error: `Today's vetting budget ($${config.telegraph.webDailyBudgetUsd.toFixed(2)}) is used up — the free scan still works, and the button is back tomorrow.`,
    });
  }
  const budgetUsd = Math.min(config.telegraph.maxSpendUsd, dailyRemaining);

  try {
    const result = await runRedflag(input as RedflagInput, { budgetUsd });
    // Anonymous identity for the ledger: hashed IP, never the raw address.
    const ipHash = createHash('sha256').update(clientIp(req)).digest('hex').slice(0, 12);
    const id = uid();
    saveRedflagReport({
      id,
      userId: `web:${ipHash}`,
      company: result.company,
      verdict: result.verdict,
      spendUsd: result.spendUsd,
      at: now(),
      data: result,
    });
    const origin = publicOrigin(req);
    return json(res, 200, { ok: true, shareUrl: origin ? `${origin}/report/${id}` : `/report/${id}`, fullRemainingThisHour: gate.remaining, budgetUsd, report: result });
  } catch (error) {
    return json(res, 500, { ok: false, error: `vetting failed: ${String(error)}` });
  }
}

/**
 * The FREE job-hunt tool behind the homepage — the EARN side of the flywheel,
 * on the web. It runs the exact same signal pipeline the Telegraph miner
 * serves (`huntSignal`): free-text criteria parsing, live boards, pay-question
 * synthesis, general answers. A visitor experiences precisely what the
 * network's buyers get, which is the demo that matters for a miner that is
 * also an app.
 */
async function handleHuntWeb(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gate = rateAllowed(huntWebHits, clientIp(req), HUNT_WEB_LIMIT);
  if (!gate.ok) return json(res, 429, { ok: false, error: `Hunt limit reached (${HUNT_WEB_LIMIT}/hour) — back in a few minutes.`, retryAfterSeconds: gate.retryAfterSec });
  const raw = await readBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch (error) {
    return json(res, 400, { ok: false, error: `request body is not valid JSON: ${String(error)}` });
  }
  const query = typeof body.query === 'string' ? body.query.trim() : '';
  if (!query) return json(res, 400, { ok: false, error: 'type a job search — e.g. "senior backend engineer, TypeScript, remote, $150k+" or "what does a data analyst earn in New York"' });
  if (query.length > 2000) return json(res, 400, { ok: false, error: 'query too long — keep it under 2000 characters' });
  try {
    const signal = await huntSignal({ query });
    return json(res, 200, { ok: true, query, huntsRemainingThisHour: gate.remaining, signal });
  } catch (error) {
    console.error('[server] hunt/web failed:', error);
    return json(res, 500, { ok: false, error: 'hunt failed — try again in a moment' });
  }
}

/**
 * Start (or stop) a WEB watch from a report page: no Telegram chat, the page
 * itself is the inbox. The poller appends new-negative-coverage findings to
 * the report, and the reader sees them on return.
 */
async function handleReportWatch(req: IncomingMessage, res: ServerResponse, reportId: string, start: boolean): Promise<void> {
  const record = getRedflagReport(reportId);
  if (!record) return json(res, 404, { ok: false, error: 'no such report' });
  if (start) {
    if (!config.telegraph.enabled) {
      return json(res, 503, { ok: false, error: 'Network checks are not configured on this deployment — standing watches unavailable.' });
    }
    if (getWatchByReport(reportId)) {
      return json(res, 200, { ok: true, alreadyWatching: true, intervalHours: config.telegraph.watchIntervalHours });
    }
    const watch = createWatch(`web:report:${reportId}`, record.company, null, reportId);
    return json(res, 200, { ok: true, watchId: watch.id, intervalHours: config.telegraph.watchIntervalHours, firstCheckWithinMin: config.telegraph.watchPollMinutes });
  }
  const watch = getWatchByReport(reportId);
  if (!watch) return json(res, 404, { ok: false, error: 'this report has no active watch' });
  deactivateWatch(watch.id);
  return json(res, 200, { ok: true, stopped: true });
}

/**
 * Claim the Track 3 web-app routes: the consumer app page, the web hunt
 * tool, the free scan and operator-paid vetting, the stats feed, the
 * shareable report pages and their web watches.
 */
export function isTrack3Route(method: string | undefined, path: string): boolean {
  if (method === 'GET' && (path === '/' || path === '/redflag' || path === '/redflag/')) return true;
  if (method === 'POST' && path === '/api/hunt/web') return true;
  if (method === 'POST' && path === '/api/redflag/preview') return true;
  if (method === 'POST' && path === '/api/redflag/web') return true;
  if (method === 'GET' && path === '/api/stats') return true;
  if (method === 'GET' && path.startsWith('/report/')) return true;
  if (method === 'GET' && path.startsWith('/api/report/')) return true;
  if (method === 'POST' && path.startsWith('/api/report/') && (path.endsWith('/watch') || path.endsWith('/unwatch'))) return true;
  return false;
}

export async function handleTrack3Route(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  // The Legwork web app — paste a posting; free scan and operator-paid
  // full vetting, one page. Served at BOTH / and /redflag.
  if (req.method === 'GET' && (path === '/' || path === '/redflag' || path === '/redflag/')) {
    recordAppEvent('visit');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(REDFLAG_PAGE_HTML);
    return;
  }
  // The free job-hunt tool — the miner's own skill, on the web.
  if (req.method === 'POST' && path === '/api/hunt/web') return handleHuntWeb(req, res);
  if (req.method === 'POST' && path === '/api/redflag/preview') return handleRedflagPreview(req, res);
  if (req.method === 'POST' && path === '/api/redflag/web') return handleRedflagWeb(req, res);
  // Public network-usage stats + the recent-verdicts feed: what this app
  // has bought from Telegraph miners, counted from the reports ledger.
  if (req.method === 'GET' && path === '/api/stats') {
    return json(res, 200, { ok: true, ...redflagStats(), recent: recentRedflagReports(8) });
  }
  // Shareable report pages — the receipt for a vetting, by unguessable id.
  if (req.method === 'GET' && path.startsWith('/report/')) {
    recordAppEvent('visit');
    const id = path.slice('/report/'.length).replace(/\/+$/, '');
    const record = /^[0-9a-f-]{36}$/i.test(id) ? getRedflagReport(id) : undefined;
    if (!record) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="background:#0c0f14;color:#e6e9ef;font:16px ui-sans-serif;padding:3rem"><h1>404 — no such report</h1><p><a href="/redflag" style="color:#7fb0ff">← back to Legwork</a></p></body>');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(renderReportPage(record, publicOrigin(req), getWatchByReport(record.id)));
    return;
  }
  if (req.method === 'GET' && path.startsWith('/api/report/')) {
    const id = path.slice('/api/report/'.length).replace(/\/+$/, '');
    const record = /^[0-9a-f-]{36}$/i.test(id) ? getRedflagReport(id) : undefined;
    if (!record) return json(res, 404, { ok: false, error: 'no such report' });
    return json(res, 200, { ok: true, report: record, watch: getWatchByReport(record.id) ? { active: true } : undefined });
  }
  // Web watches: start / stop from the report page.
  if (req.method === 'POST' && path.startsWith('/api/report/') && path.endsWith('/watch')) {
    const id = path.slice('/api/report/'.length, -'/watch'.length);
    return handleReportWatch(req, res, /^[0-9a-f-]{36}$/i.test(id) ? id : '', true);
  }
  if (req.method === 'POST' && path.startsWith('/api/report/') && path.endsWith('/unwatch')) {
    const id = path.slice('/api/report/'.length, -'/unwatch'.length);
    return handleReportWatch(req, res, /^[0-9a-f-]{36}$/i.test(id) ? id : '', false);
  }
}
