import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { config } from './config.js';
import { criteriaToProfile, runAdhocHunt, type HuntCriteria } from './skills/jobHunt.js';
import { scorePosting } from './skills/matchScorer.js';
import { tailorApplication } from './skills/applicationTailor.js';
import { runRedflag, runRedflagPreview, type RedflagInput, type RedflagReport } from './skills/redflag.js';
import { findService, serviceCatalog, type PricedService } from './payments/services.js';
import { verifyServicePayment } from './payments/verify.js';
import { handleMinerRoute, isMinerRoute } from './miner.js';
import { llmHealth } from './llm.js';
import { telegraphHealth } from './telegraph/client.js';
import { getRedflagReport, now, recentRedflagReports, redflagSpendSince, redflagStats, saveRedflagReport, uid } from './db.js';
import { REDFLAG_PAGE_HTML } from './web/redflagPage.js';
import { renderReportPage } from './web/reportPage.js';
import { json, readBody } from './http.js';
import { createHash } from 'node:crypto';
import type { Posting, Profile } from './types.js';

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function clientIp(req: IncomingMessage): string {
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

const previewHits = new Map<string, number[]>();
const redflagPreviewHits = new Map<string, number[]>();
const redflagWebHits = new Map<string, number[]>();
const PREVIEW_LIMIT = 3;
const PREVIEW_WINDOW_MS = 60 * 60 * 1000;

function rateAllowed(hits: Map<string, number[]>, ip: string, limit = PREVIEW_LIMIT): { ok: boolean; remaining: number; retryAfterSec: number } {
  const cutoff = Date.now() - PREVIEW_WINDOW_MS;
  const list = (hits.get(ip) ?? []).filter((time) => time > cutoff);
  if (list.length >= limit) return { ok: false, remaining: 0, retryAfterSec: Math.ceil((list[0] + PREVIEW_WINDOW_MS - Date.now()) / 1000) };
  list.push(Date.now());
  hits.set(ip, list);
  return { ok: true, remaining: limit - list.length, retryAfterSec: 0 };
}

function previewAllowed(ip: string): { ok: boolean; remaining: number; retryAfterSec: number } {
  return rateAllowed(previewHits, ip);
}

/** The public origin for share links — PUBLIC_URL when set, else the request's own host. */
function publicOrigin(req: IncomingMessage): string {
  if (config.server.publicUrl) return config.server.publicUrl.replace(/\/+$/, '');
  const host = req.headers.host;
  const proto = host?.includes('localhost') ? 'http' : 'https';
  return host ? `${proto}://${host}` : '';
}

async function runService(service: PricedService, body: Record<string, unknown>, payerWallet?: string): Promise<unknown> {
  if (service.id === 'job-hunt') {
    const result = await runAdhocHunt(body as HuntCriteria);
    return { found: result.found, matches: result.matches.map((match) => ({ posting: match.posting, score: match.breakdown.total, breakdown: match.breakdown })), sourceErrors: result.sourceErrors };
  }
  if (service.id === 'score-posting') {
    const criteria = (body.criteria ?? {}) as HuntCriteria;
    const input = (body.posting ?? {}) as Partial<Posting>;
    if (!input.title || !input.company || !input.description) throw new Error('posting requires title, company, description');
    const posting: Posting = { id: 'api', source: 'api', externalId: 'api', title: input.title, company: input.company, location: input.location ?? '', remote: /remote/i.test(`${input.location ?? ''} ${input.description}`), compMin: input.compMin, compMax: input.compMax, description: input.description, url: input.url ?? '', atsHint: 'unknown', fetchedAt: new Date().toISOString() };
    const breakdown = await scorePosting(criteriaToProfile(criteria, 'api-score'), posting);
    return { score: breakdown.total, breakdown };
  }
  if (service.id === 'tailor-application') {
    const candidate = (body.candidate ?? {}) as { name?: string; resumeText?: string; skills?: string[]; email?: string };
    const input = (body.posting ?? {}) as Partial<Posting>;
    if (!candidate.name || !candidate.resumeText || !candidate.skills) throw new Error('candidate requires name, resumeText, skills');
    if (!input.title || !input.company || !input.description) throw new Error('posting requires title, company, description');
    const profile: Profile = { userId: `api-tailor-${Date.now()}`, name: candidate.name, targetRoles: [], seniority: 'mid', locations: [], remoteOk: true, compFloor: 0, skills: candidate.skills, resumeText: candidate.resumeText, dealbreakers: [], threshold: 0, dailyCap: 10, email: candidate.email };
    const posting: Posting = { id: `api-${Date.now()}`, source: 'api', externalId: 'api', title: input.title, company: input.company, location: input.location ?? '', remote: false, compMin: input.compMin, compMax: input.compMax, description: input.description, url: input.url ?? '', atsHint: input.atsHint ?? 'unknown', fetchedAt: new Date().toISOString() };
    const draft = await tailorApplication(profile, posting);
    return { resume: draft.resumeText, coverLetter: draft.coverLetter, emailSubject: draft.emailSubject, emailBody: draft.emailBody };
  }
  if (service.id === 'redflag-vetting') {
    const input = (body.redflag ?? body) as Partial<RedflagInput>;
    const text = [input.text, input.description, input.company].filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    if (!text.length) throw new Error('send a job posting (company/description/text) to vet');
    const result = await runRedflag(input as RedflagInput);
    const degraded = !result.checks.some((c) => c.source === 'telegraph' && (c.status === 'ok' || c.status === 'cached'));
    // Reports persist as dispute evidence: what was checked, what it cost,
    // and what the buyer's money bought.
    saveRedflagReport({
      id: uid(),
      userId: `wallet:${String(payerWallet ?? 'anonymous')}`,
      company: result.company,
      verdict: result.verdict,
      spendUsd: result.spendUsd,
      at: now(),
      data: result,
    });
    return { ...result, degraded };
  }
  throw new Error(`no handler for service ${service.id}`);
}

async function handlePreview(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const gate = previewAllowed(clientIp(req));
  if (!gate.ok) return json(res, 429, { ok: false, error: `Free preview limit reached (${PREVIEW_LIMIT}/hour)`, retryAfterSeconds: gate.retryAfterSec });
  const raw = await readBody(req, res);
  if (raw === null) return;
  try {
    const result = await runAdhocHunt(raw ? JSON.parse(raw) as HuntCriteria : {});
    const matches = result.matches.slice(0, 3).map((match) => ({ title: match.posting.title, company: match.posting.company, location: match.posting.location, url: match.posting.url, score: match.breakdown.total, why: [match.breakdown.skills.reason, match.breakdown.comp.reason] }));
    json(res, 200, { ok: true, shown: matches.length, totalMatches: result.matches.length, previewsRemainingThisHour: gate.remaining, matches });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error) });
  }
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

async function handlePaidRoute(service: PricedService, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const transactionHash = req.headers['x-payment-tx'];
  const payer = req.headers['x-user-wallet'];
  if (typeof transactionHash !== 'string' || typeof payer !== 'string') {
    return json(res, 402, { ok: false, error: 'Payment required', payment: { chain: 'Base Sepolia', chainId: config.payments.chainId, asset: config.payments.asset, symbol: config.payments.assetSymbol, amount: service.priceAtomic, priceUsd: service.priceUsd, payTo: config.payments.payTo } });
  }
  const raw = await readBody(req, res);
  if (raw === null) return;
  let body: Record<string, unknown>;
  try {
    body = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch (error) {
    return json(res, 400, { ok: false, error: `request body is not valid JSON: ${String(error)}` });
  }
  try {
    const payment = await verifyServicePayment(transactionHash, payer, service);
    if (!payment.ok) return json(res, 402, { ok: false, error: payment.error });
    const result = await runService(service, body, payer);
    json(res, 200, { ok: true, service: service.id, billing: 'base-sepolia', transactionHash, result });
  } catch (error) {
    json(res, 400, { ok: false, error: String(error), paid: true, transactionHash });
  }
}

export function startServer(port: number = config.server.endpointPort): Server {
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '').split('?')[0];
      if (req.method === 'GET' && path === '/health')
        return json(res, 200, {
          ok: true,
          agent: 'Legwork',
          chain: 'Base Sepolia',
          miner: 'legwork-job-hunter',
          // Key validity, not just presence: a dead key silently degrades every
          // scored response to the heuristic/template path.
          llm: llmHealth(),
          // The consumer side of Telegraph: Redflag buys miner answers here.
          telegraph: telegraphHealth(),
          sources: { adzuna: config.adzuna.enabled, usajobs: config.usajobs.enabled },
        });
      if (req.method === 'GET' && path === '/api/services') return json(res, 200, serviceCatalog());
      // The Redflag web app — paste a posting; free scan and operator-paid
      // full vetting, one page. The Track 3 consumer surface.
      if (req.method === 'GET' && (path === '/redflag' || path === '/redflag/')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(REDFLAG_PAGE_HTML);
        return;
      }
      if (req.method === 'POST' && path === '/api/hunt/preview') return handlePreview(req, res);
      if (req.method === 'POST' && path === '/api/redflag/preview') return handleRedflagPreview(req, res);
      if (req.method === 'POST' && path === '/api/redflag/web') return handleRedflagWeb(req, res);
      // Public network-usage stats + the recent-verdicts feed: what this app
      // has bought from Telegraph miners, counted from the reports ledger.
      if (req.method === 'GET' && path === '/api/stats') {
        return json(res, 200, { ok: true, ...redflagStats(), recent: recentRedflagReports(8) });
      }
      // Shareable report pages — the receipt for a vetting, by unguessable id.
      if (req.method === 'GET' && path.startsWith('/report/')) {
        const id = path.slice('/report/'.length).replace(/\/+$/, '');
        const record = /^[0-9a-f-]{36}$/i.test(id) ? getRedflagReport(id) : undefined;
        if (!record) {
          res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
          res.end('<!doctype html><meta charset="utf-8"><body style="background:#0c0f14;color:#e6e9ef;font:16px ui-sans-serif;padding:3rem"><h1>404 — no such report</h1><p><a href="/redflag" style="color:#7fb0ff">← back to Redflag</a></p></body>');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderReportPage(record, publicOrigin(req)));
        return;
      }
      if (req.method === 'GET' && path.startsWith('/api/report/')) {
        const id = path.slice('/api/report/'.length).replace(/\/+$/, '');
        const record = /^[0-9a-f-]{36}$/i.test(id) ? getRedflagReport(id) : undefined;
        if (!record) return json(res, 404, { ok: false, error: 'no such report' });
        return json(res, 200, { ok: true, report: record });
      }
      if (isMinerRoute(req.method, path)) return handleMinerRoute(req, res, path);
      const service = findService(req.method, path);
      if (service) return handlePaidRoute(service, req, res);
      res.writeHead(404);
      res.end();
    })().catch((error) => {
      console.error('[server] handler error:', error);
      if (!res.headersSent) json(res, 500, { ok: false, error: 'internal error' });
    });
  });
  server.listen(port, () => console.log(`[server] listening on :${(server.address() as { port: number }).port}`));
  return server;
}
