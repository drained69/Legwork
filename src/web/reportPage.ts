import type { RedflagReportRecord, RedflagWatch } from '../db.js';

/**
 * The shareable report page — GET /report/:id.
 *
 * A full vetting rendered as a standalone verification document: an explained
 * verdict score, every finding with the miner that produced it (name, intent,
 * cost, signal hash), the check receipt, the questions to ask — plus the
 * web-watch controls (the page itself is the inbox for standing news checks)
 * and OG/Twitter meta so a shared link renders as the verdict it carries.
 *
 * Shares the design language of the main app (see redflagPage.ts): near-black
 * canvas, subtle borders, restrained accent, semantic green/amber/red, mono
 * for scores and technical identifiers.
 */

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}

const SEVERITY_ICON: Record<string, string> = { red: '!', yellow: '△', green: '✓', info: 'i' };
const VERDICT_LABEL: Record<string, string> = { clear: 'Likely legitimate', caution: 'Proceed with caution', avoid: 'High scam risk', unknown: 'Not enough signal' };

export function renderReportPage(record: RedflagReportRecord, publicUrl: string, watch?: RedflagWatch): string {
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
    updates?: Array<{ company: string; text: string; miner?: string; costUsd?: number; at: string }>;
  };
  const verdict = report.verdict ?? 'unknown';
  const score = Math.round((report.confidence ?? 0) * 100);
  const when = new Date(record.at).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
  const shareUrl = publicUrl ? `${publicUrl}/report/${record.id}` : `/report/${record.id}`;
  const topFlag = report.flags?.find((f) => f.severity === 'red' || f.severity === 'yellow');
  const telegraphCount = report.checks?.filter((c) => c.source === 'telegraph').length ?? 0;
  const ogDescription =
    `${(VERDICT_LABEL[verdict] ?? verdict)} — ${record.company}${report.role ? ` (${report.role})` : ''}. ` +
    `${telegraphCount} live checks bought from independent Telegraph miners ($${(record.spendUsd ?? 0).toFixed(2)}).` +
    (topFlag ? ` Top finding: ${topFlag.title}.` : '');

  // score ring geometry (r=44, stroke=7)
  const R = 44, STROKE = 7, C = 2 * Math.PI * R;
  const dash = (C * (1 - Math.max(0, Math.min(100, score)) / 100)).toFixed(1);
  const ringColor = score >= 70 ? 'var(--pos)' : score >= 45 ? 'var(--warn)' : verdict === 'avoid' ? 'var(--danger)' : 'var(--muted)';

  const flags = (report.flags ?? []).map((f) => `
    <div class="finding ${esc(f.severity)}">
      <b>${SEVERITY_ICON[f.severity] ?? 'i'} ${esc(f.title)}</b>
      <p>${esc(f.detail)}</p>
      <div class="src">${esc(f.source)}${f.costUsd ? ` · paid $${f.costUsd.toFixed(2)}` : ''}${typeof f.confidence === 'number' ? ` · confidence ${(f.confidence * 100).toFixed(0)}%` : ''}</div>
    </div>`).join('');

  const checks = (report.checks ?? []).map((c) => {
    const cls = c.status === 'ok' || c.status === 'cached' ? 'ok' : c.status === 'skipped' ? 'skip' : 'fail';
    const tick = c.status === 'ok' ? '✓' : c.status === 'cached' ? '↻' : c.status === 'skipped' ? '–' : '✗';
    return `
    <li class="${cls}">
      <span class="tick">${tick}</span>
      <div>
        <span class="rl">${esc(c.label)}</span>
        <div class="tags">
          <span class="badge">${c.source === 'telegraph' ? 'telegraph miner' : c.source === 'legwork' ? 'legwork live data' : 'local heuristics'}</span>
          ${c.miner ? `<span class="badge miner">${esc(c.miner)}</span>` : ''}
          ${c.intent ? `<span class="badge">${esc(c.intent)}</span>` : ''}
          ${c.costUsd ? `<span class="badge cost">$${c.costUsd.toFixed(2)}</span>` : ''}
        </div>
        <p>${esc(c.summary)}</p>
        ${c.signalHash ? `<div class="sig">signal ${esc(c.signalHash)}</div>` : ''}
      </div>
    </li>`;
  }).join('');

  const questions = (report.questions ?? []).map((q) => `<li>${esc(q)}</li>`).join('');

  const updates = (report.updates ?? []).map((u) => `
    <div class="finding yellow">
      <b>△ New negative coverage — ${esc(u.company)}</b>
      <p>${esc(u.text)}</p>
      <div class="src">via ${esc(u.miner ?? 'telegraph miner')}${u.costUsd ? ` · paid $${u.costUsd.toFixed(2)}` : ''} · ${esc(u.at.replace('T', ' ').slice(0, 16))} UTC</div>
    </div>`).join('');

  const watchStatus = watch
    ? `<div class="watchbox active"><div><b>Watching ${esc(record.company)}</b><span class="status">News re-checked through a live Telegraph miner every few hours; new negative coverage appears here.</span></div>
       <button id="unwatch" class="btn btn-ghost">Stop watching</button></div>`
    : `<div class="watchbox"><div><b>Keep watching this company</b><span class="status">We re-check their news through a live Telegraph miner every few hours and add negative coverage here. On us, ~$0.01 per check.</span></div>
       <button id="watch" class="btn btn-primary">Watch ${esc(record.company)}</button></div>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Legwork — ${esc(VERDICT_LABEL[verdict] ?? verdict)}: ${esc(record.company)}</title>
<meta property="og:title" content="Verification: ${esc(VERDICT_LABEL[verdict] ?? verdict)} — ${esc(record.company)}">
<meta property="og:description" content="${esc(ogDescription)}">
<meta property="og:type" content="article">
${publicUrl ? `<meta property="og:url" content="${esc(shareUrl)}">` : ''}
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Verification: ${esc(VERDICT_LABEL[verdict] ?? verdict)} — ${esc(record.company)}">
<meta name="twitter:description" content="${esc(ogDescription)}">
<style>
  :root {
    color-scheme: dark;
    --bg: #08090c; --bg-soft: #0b0d12; --surface: #0f1218; --surface-2: #12161e;
    --border: #1c2230; --border-strong: #29313f;
    --text: #e9ecf2; --text-2: #b7bfce; --muted: #8a93a4; --faint: #626b7d;
    --accent: #5b84ff; --accent-soft: #5b84ff1f; --accent-line: #5b84ff44;
    --pos: #35d29a; --pos-soft: #35d29a1c; --warn: #f2b04e; --warn-soft: #f2b04e1c; --danger: #f26565; --danger-soft: #f265651c;
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
    --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px;
    --radius: 10px; --ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 400 16px/1.6 var(--sans); letter-spacing: -0.006em; -webkit-font-smoothing: antialiased; padding: 0 var(--s5) var(--s7); }
  .wrap { max-width: 760px; margin: 0 auto; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  :focus-visible { outline: none; box-shadow: var(--ring); border-radius: 8px; }
  .mono { font-family: var(--mono); }
  .topbar { display: flex; align-items: center; height: 60px; border-bottom: 1px solid var(--border); margin-bottom: var(--s6); }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 650; letter-spacing: -0.02em; color: var(--text); }
  .brand:hover { text-decoration: none; }
  .brand .dot { width: 10px; height: 10px; border-radius: 3px; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .crumb { color: var(--faint); font-size: .85rem; margin-left: auto; font-family: var(--mono); }

  .hero { display: flex; align-items: center; gap: var(--s6); flex-wrap: wrap; }
  .ring { position: relative; width: 102px; height: 102px; flex: 0 0 auto; }
  .ring svg { transform: rotate(-90deg); }
  .ring .num { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--mono); font-weight: 650; font-size: 1.7rem; }
  .verdict-label { font-size: 1.6rem; font-weight: 650; letter-spacing: -0.02em; }
  .verdict-label.clear { color: var(--pos); } .verdict-label.caution { color: var(--warn); }
  .verdict-label.avoid { color: var(--danger); } .verdict-label.unknown { color: var(--muted); }
  .subject { color: var(--text); font-weight: 600; margin-top: var(--s3); font-size: 1.05rem; }
  .meta { color: var(--muted); font-size: .86rem; margin-top: 4px; }

  .share { display: flex; gap: var(--s2); flex-wrap: wrap; align-items: center; margin-top: var(--s5); }
  .btn { border: 1px solid transparent; border-radius: 9px; padding: 9px 15px; font: 600 .88rem var(--sans); cursor: pointer; text-decoration: none; display: inline-flex; align-items: center; transition: background .15s, border-color .15s; }
  .btn:hover { text-decoration: none; }
  .btn-primary { background: var(--accent); color: #fff; } .btn-primary:hover { background: #6f93ff; }
  .btn-ghost { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); } .btn-ghost:hover { border-color: var(--accent-line); }
  .btn:disabled { opacity: .55; cursor: progress; }
  .copied { color: var(--pos); font-size: .84rem; }
  .hidden { display: none; }

  section { border-top: 1px solid var(--border); padding-top: var(--s5); margin-top: var(--s6); }
  .subhead { font-family: var(--mono); font-size: .74rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin-bottom: var(--s4); }

  .watchbox { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); flex-wrap: wrap; border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s4) var(--s5); margin-top: var(--s6); background: var(--surface); }
  .watchbox.active { border-color: var(--warn-soft); }
  .watchbox b { display: block; font-size: .95rem; }
  .watchbox .status { display: block; color: var(--muted); font-size: .82rem; margin-top: 3px; max-width: 46ch; }

  .finding { border-left: 2px solid var(--border-strong); padding: var(--s2) 0 var(--s2) var(--s4); margin: var(--s3) 0; }
  .finding.red { border-color: var(--danger); } .finding.yellow { border-color: var(--warn); }
  .finding.green { border-color: var(--pos); } .finding.info { border-color: var(--faint); }
  .finding b { font-size: .92rem; } .finding p { color: var(--text-2); font-size: .88rem; margin: 4px 0 0; }
  .finding .src { color: var(--faint); font-size: .76rem; margin-top: 5px; word-break: break-all; }

  .receipt { list-style: none; padding: 0; margin: 0; }
  .receipt li { display: flex; gap: var(--s3); padding: var(--s3) 0; border-bottom: 1px solid var(--border); }
  .receipt li:last-child { border-bottom: 0; }
  .receipt .tick { flex: 0 0 auto; width: 20px; text-align: center; font-weight: 700; }
  .receipt li.ok .tick { color: var(--pos); } .receipt li.skip .tick { color: var(--warn); } .receipt li.fail .tick { color: var(--danger); }
  .receipt .rl { font-weight: 550; font-size: .9rem; }
  .receipt .tags { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 6px; }
  .receipt p { color: var(--text-2); font-size: .85rem; margin: 5px 0 0; }
  .receipt .sig { font-family: var(--mono); color: var(--faint); font-size: .74rem; margin-top: 5px; }
  .badge { display: inline-flex; align-items: center; font-family: var(--mono); font-size: .72rem; color: var(--muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px; }
  .badge.miner { color: var(--accent); border-color: var(--accent-line); }
  .badge.cost { color: var(--pos); border-color: var(--pos-soft); }
  .qs { margin: 0; padding-left: 1.1rem; color: var(--text-2); } .qs li { margin: var(--s2) 0; font-size: .9rem; }
  footer { border-top: 1px solid var(--border); margin-top: var(--s7); padding-top: var(--s5); color: var(--faint); font-size: .82rem; text-align: center; }
  footer a { color: var(--muted); }
  @media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
  @media (max-width: 520px) { body { padding: 0 var(--s4) var(--s6); } .hero { gap: var(--s4); } }
</style>
</head>
<body>
<div class="wrap">
  <div class="topbar">
    <a class="brand" href="/"><span class="dot"></span>Legwork</a>
    <span class="crumb">report ${esc(record.id.slice(0, 8))}</span>
  </div>

  <div class="hero">
    <div class="ring">
      <svg width="102" height="102" viewBox="0 0 102 102" aria-hidden="true">
        <circle cx="51" cy="51" r="${R}" fill="none" stroke="var(--border-strong)" stroke-width="${STROKE}"/>
        <circle cx="51" cy="51" r="${R}" fill="none" stroke="${ringColor}" stroke-width="${STROKE}" stroke-linecap="round" stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${dash}"/>
      </svg>
      <span class="num">${score}</span>
    </div>
    <div>
      <div class="verdict-label ${esc(verdict)}">${esc(VERDICT_LABEL[verdict] ?? verdict)}</div>
      <div class="subject">${esc(record.company)}${report.role ? ` — ${esc(report.role)}` : ''}</div>
      <div class="meta">Verified ${esc(when)} · confidence ${score}% · ${telegraphCount} live miner checks · spend $${(record.spendUsd ?? 0).toFixed(2)}</div>
      <div class="share">
        <a class="btn btn-ghost" href="https://x.com/intent/tweet?text=${encodeURIComponent(`Legwork verification on ${record.company}: ${VERDICT_LABEL[verdict] ?? verdict} — checked with live independent Telegraph miners`)}&url=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">Post on X</a>
        <a class="btn btn-ghost" href="https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}" target="_blank" rel="noopener">LinkedIn</a>
        <button class="btn btn-ghost" id="copylink" type="button">Copy link</button>
        <span class="copied hidden" id="copied">copied ✓</span>
      </div>
    </div>
  </div>

  ${watchStatus}

  ${updates ? `<section><div class="subhead">Since your vetting — standing watch</div>${updates}</section>` : ''}
  ${flags ? `<section><div class="subhead">Findings</div>${flags}</section>` : ''}
  ${checks ? `<section><div class="subhead">The receipt — every check, its source and cost</div><ul class="receipt">${checks}</ul></section>` : ''}
  ${questions ? `<section><div class="subhead">Questions to ask them</div><ul class="qs">${questions}</ul></section>` : ''}

  <footer>Due diligence bought from live independent Telegraph miners · <a href="/">Legwork</a> · powered by <a href="https://telegraphprotocol.com">Telegraph</a></footer>
</div>
<script>
  var rid = location.pathname.replace(/\\/+$/, '').split('/').pop() || '';
  var el = function (id) { return document.getElementById(id); };
  function bindWatch(id, path) {
    var b = el(id); if (!b) return;
    b.onclick = function () {
      b.disabled = true;
      fetch('/api/report/' + rid + path, { method: 'POST' })
        .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
        .then(function (res) { if (!res.ok || !res.d.ok) throw new Error(res.d.error || ('HTTP')); location.reload(); })
        .catch(function (e) { alert('Failed: ' + e.message); b.disabled = false; });
    };
  }
  bindWatch('watch', '/watch');
  bindWatch('unwatch', '/unwatch');
  var copy = el('copylink');
  if (copy) copy.onclick = function () {
    navigator.clipboard.writeText(location.href).then(function () {
      el('copied').classList.remove('hidden');
      setTimeout(function () { el('copied').classList.add('hidden'); }, 2000);
    });
  };
</script>
</body>
</html>`;
}
