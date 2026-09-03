import type { RedflagReportRecord } from '../db.js';

/**
 * The shareable report page — GET /report/:id.
 *
 * A full vetting rendered as a standalone document: the verdict, every flag
 * with the miner that produced it (name, intent, cost, signal hash), the
 * check receipt, and the questions to ask. This is the "verified intelligence
 * with a receipt" story of the Telegraph network made visible: each check
 * names the independent miner that answered and what that answer cost.
 */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const SEVERITY_ICON: Record<string, string> = { red: '🔴', yellow: '🟡', green: '🟢', info: '⚪' };
const VERDICT_ICON: Record<string, string> = { clear: '🟢', caution: '🟡', avoid: '🔴', unknown: '⚪' };

export function renderReportPage(record: RedflagReportRecord, publicUrl: string): string {
  const report = record.data as {
    verdict?: string;
    company?: string;
    role?: string;
    confidence?: number;
    flags?: Array<{ severity: string; title: string; detail: string; source: string; confidence?: number; costUsd?: number }>;
    questions?: string[];
    checks?: Array<{ id: string; label: string; status: string; source: string; miner?: string; intent?: string; costUsd?: number; signalHash?: string; summary: string }>;
    spendUsd?: number;
    budgetUsd?: number;
  };
  const verdict = report.verdict ?? 'unknown';
  const when = new Date(record.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

  const flags = (report.flags ?? []).map((f) => `
    <div class="flag ${esc(f.severity)}">
      <b>${SEVERITY_ICON[f.severity] ?? '⚪'} ${esc(f.title)}</b>
      <p>${esc(f.detail)}</p>
      <div class="src">source: ${esc(f.source)}${f.costUsd ? ` · paid $${f.costUsd.toFixed(2)}` : ''}${typeof f.confidence === 'number' ? ` · confidence ${(f.confidence * 100).toFixed(0)}%` : ''}</div>
    </div>`).join('');

  const checks = (report.checks ?? []).map((c) => {
    const statusIcon = c.status === 'ok' ? '✓' : c.status === 'cached' ? '↻' : c.status === 'skipped' ? '–' : '✗';
    const statusClass = c.status === 'ok' || c.status === 'cached' ? 'ok' : c.status === 'skipped' ? 'skip' : 'fail';
    return `
    <li class="${statusClass}">
      <span class="tick">${statusIcon}</span>
      <div>
        <b>${esc(c.label)}</b>
        <span class="badge">${c.source === 'telegraph' ? 'telegraph miner' : c.source === 'legwork' ? 'legwork live data' : 'local heuristics'}</span>
        ${c.miner ? `<span class="badge miner">${esc(c.miner)}</span>` : ''}
        ${c.intent ? `<span class="badge">${esc(c.intent)}</span>` : ''}
        ${c.costUsd ? `<span class="badge cost">$${c.costUsd.toFixed(2)}</span>` : ''}
        <p>${esc(c.summary)}</p>
        ${c.signalHash ? `<div class="src">signal ${esc(c.signalHash)}</div>` : ''}
      </div>
    </li>`;
  }).join('');

  const questions = (report.questions ?? []).map((q) => `<li>${esc(q)}</li>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redflag report — ${esc(record.company)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #0c0f14; color: #e6e9ef; padding: 2rem 1rem 4rem; }
  .wrap { max-width: 760px; margin: 0 auto; }
  .crumbs { color: #7c8798; font-size: .85rem; margin-bottom: 1rem; }
  .crumbs a { color: #3d6bff; text-decoration: none; }
  .card { background: #141923; border: 1px solid #232b3a; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
  .verdict { display: inline-flex; align-items: center; gap: .5rem; font-weight: 800; font-size: 1.4rem; }
  .verdict.clear { color: #4ade80; } .verdict.caution { color: #fbbf24; }
  .verdict.avoid { color: #ff5d5d; } .verdict.unknown { color: #9aa3b2; }
  .meta { color: #9aa3b2; font-size: .85rem; margin-top: .35rem; }
  h2 { font-size: 1.05rem; margin: 1.4rem 0 .6rem; }
  .flag { border-left: 3px solid #2a3446; padding: .6rem .85rem; margin: .6rem 0; background: #0f131b; border-radius: 0 8px 8px 0; }
  .flag.red { border-color: #ff5d5d; } .flag.yellow { border-color: #fbbf24; }
  .flag.green { border-color: #4ade80; } .flag.info { border-color: #64748b; }
  .flag b { display: block; margin-bottom: .15rem; }
  .flag p { margin: .2rem 0 .3rem; font-size: .93rem; color: #c4ccd8; }
  .src { color: #7c8798; font-size: .78rem; word-break: break-all; }
  .checks { list-style: none; padding: 0; margin: .5rem 0 0; }
  .checks li { display: flex; gap: .6rem; padding: .55rem 0; border-bottom: 1px dashed #232b3a; }
  .checks li:last-child { border-bottom: 0; }
  .tick { flex: 0 0 auto; font-weight: 700; }
  .ok .tick { color: #4ade80; } .skip .tick { color: #fbbf24; } .fail .tick { color: #ff5d5d; }
  .checks p { margin: .25rem 0 0; font-size: .88rem; color: #c4ccd8; }
  .badge { display: inline-block; background: #0f131b; border: 1px solid #232b3a; border-radius: 5px; padding: 0 .4rem; margin-left: .35rem; font-size: .72rem; color: #9aa3b2; vertical-align: middle; }
  .badge.miner { color: #7fb0ff; border-color: #3d6bff55; }
  .badge.cost { color: #4ade80; border-color: #4ade8055; }
  ul.qs { margin: .4rem 0 0; padding-left: 1.2rem; }
  footer { color: #5b6575; font-size: .8rem; margin-top: 2rem; text-align: center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="crumbs"><a href="/redflag">🚩 Redflag</a> → report ${esc(record.id.slice(0, 8))}</div>

  <div class="card">
    <div class="verdict ${esc(verdict)}">${VERDICT_ICON[verdict] ?? '⚪'} ${esc(verdict.toUpperCase())}</div>
    <div class="meta"><b style="color:#e6e9ef">${esc(record.company)}</b>${report.role ? ` — ${esc(report.role)}` : ''}</div>
    <div class="meta">vetted ${esc(when)} · confidence ${Math.round((report.confidence ?? 0) * 100)}% · miner spend $${(record.spendUsd ?? 0).toFixed(2)}</div>
  </div>

  ${flags ? `<h2>Findings</h2>${flags}` : ''}

  ${checks ? `<h2>The receipt — every check, its source, its cost</h2><div class="card"><ul class="checks">${checks}</ul></div>` : ''}

  ${questions ? `<h2>Questions to ask them</h2><div class="card"><ul class="qs">${questions}</ul></div>` : ''}

  <footer>Redflag — due diligence bought from live Telegraph miners · powered by <a href="https://telegraphprotocol.com" style="color:#5b6575">Telegraph</a></footer>
</div>
</body>
</html>`;
}
