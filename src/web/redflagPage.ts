/**
 * The Redflag web demo — a single static page served at GET /redflag.
 *
 * Hand-rolled on purpose: no build tooling, no CDN assets, one HTML string
 * served straight from memory. The page calls the FREE preview endpoint
 * (local scam scan + live comp benchmark, zero miner spend); the paid
 * network checks are exactly what the "unlock" panel describes.
 */

export const REDFLAG_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redflag — job-offer due diligence</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #0c0f14; color: #e6e9ef; padding: 2rem 1rem 4rem;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  header h1 { font-size: 1.6rem; margin: 0 0 .25rem; }
  header h1 .flag { color: #ff5d5d; }
  header p.sub { color: #9aa3b2; margin: 0 0 1.5rem; }
  .card { background: #141923; border: 1px solid #232b3a; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
  textarea {
    width: 100%; min-height: 150px; resize: vertical; border-radius: 8px;
    border: 1px solid #2a3446; background: #0f131b; color: #e6e9ef; padding: .75rem;
    font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace;
  }
  textarea:focus { outline: 2px solid #3d6bff; border-color: transparent; }
  button {
    margin-top: .75rem; background: #3d6bff; color: #fff; border: 0; border-radius: 8px;
    padding: .65rem 1.2rem; font-weight: 600; font-size: .95rem; cursor: pointer;
  }
  button:disabled { opacity: .5; cursor: wait; }
  .verdict { display: inline-flex; align-items: center; gap: .5rem; font-weight: 700; font-size: 1.15rem; }
  .verdict.clear { color: #4ade80; } .verdict.caution { color: #fbbf24; }
  .verdict.avoid { color: #ff5d5d; } .verdict.unknown { color: #9aa3b2; }
  .meta { color: #9aa3b2; font-size: .85rem; margin-top: .35rem; }
  .flag { border-left: 3px solid #2a3446; padding: .6rem .85rem; margin: .6rem 0; background: #0f131b; border-radius: 0 8px 8px 0; }
  .flag.red { border-color: #ff5d5d; } .flag.yellow { border-color: #fbbf24; }
  .flag.green { border-color: #4ade80; } .flag.info { border-color: #64748b; }
  .flag b { display: block; margin-bottom: .15rem; }
  .flag .src { color: #7c8798; font-size: .8rem; }
  .checks { list-style: none; padding: 0; margin: .75rem 0 0; font-size: .9rem; }
  .checks li { padding: .3rem 0; border-bottom: 1px dashed #232b3a; }
  .checks li:last-child { border-bottom: 0; }
  .ok::before { content: "✓ "; color: #4ade80; }
  .skip::before { content: "– "; color: #fbbf24; }
  .fail::before { content: "✗ "; color: #ff5d5d; }
  .unlock { border: 1px dashed #3d6bff55; }
  .unlock h3 { margin: 0 0 .5rem; font-size: 1rem; }
  .unlock code { background: #0f131b; padding: .1rem .4rem; border-radius: 4px; font-size: .85em; }
  .example { color: #7c8798; font-size: .85rem; margin-top: .5rem; }
  .example a { color: #3d6bff; cursor: pointer; }
  footer { color: #5b6575; font-size: .8rem; margin-top: 2rem; text-align: center; }
  .hidden { display: none; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🚩 <span class="flag">Redflag</span> — job-offer due diligence</h1>
    <p class="sub">Paste a job posting or offer. Redflag scans it for scam patterns and benchmarks the pay against the live market — and in the paid report, buys live scam, news, URL and fact-checks from Telegraph miners, every flag naming its source and cost.</p>
  </header>

  <div class="card">
    <label for="posting"><b>Job posting or offer</b></label>
    <textarea id="posting" placeholder="Senior Backend Engineer at Acme Corp
Remote-first, $170k–$210k. Apply at https://acme.example/careers — or paste the whole offer email."></textarea>
    <p class="example">Try an example: <a id="load-clean">a clean posting</a> · <a id="load-scam">a classic scam</a></p>
    <button id="run">Run free scan</button>
    <span class="meta" id="status"></span>
  </div>

  <div class="card hidden" id="result"></div>

  <div class="card unlock">
    <h3>What the paid report adds — $0.05</h3>
    <p style="margin:.25rem 0 .6rem; color:#9aa3b2; font-size:.92rem">
      The free scan above runs locally. The full report also buys four live checks
      from other miners on the Telegraph network and shows the receipt:
    </p>
    <ul class="checks">
      <li class="skip">Recruiting-scam scan — FRAUD_DETECTION miner (~$0.01)</li>
      <li class="skip">Company news: layoffs, funding, scandals — NEWS_SEARCH miner (~$0.01)</li>
      <li class="skip">Career-page URL scan — URL_SCAN miner (~$0.01)</li>
      <li class="skip">Posting claims fact-check — FACT_CHECK miner (~$0.01)</li>
    </ul>
    <p style="margin:.75rem 0 0; font-size:.92rem; color:#9aa3b2">
      Call <code>POST /api/redflag</code> with a Base Sepolia USDC payment header,
      or use the <b>/redflag</b> command in the Telegram bot. You can also
      <b>/watch</b> a company and get alerted when negative news breaks.
    </p>
  </div>

  <footer>Legwork · your job search, run from Telegram · a consumer of the Telegraph network</footer>
</div>

<script>
const SEVERITY = { red: ['🔴','red'], yellow: ['🟡','yellow'], green: ['🟢','green'], info: ['⚪','info'] };
const VERDICT = { clear:'🟢 Clear', caution:'🟡 Caution', avoid:'🔴 Avoid', unknown:'⚪ Unknown' };

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

el('load-clean').onclick = () => el('posting').value =
  'Senior Backend Engineer at Shopify\\nRemote-first, $170k–$210k. TypeScript payments team. Apply at https://jobs.shopify.com/careers';
el('load-scam').onclick = () => el('posting').value =
  'Data Entry Specialist at Global Logistics Ltd\\nEarn $600/day working from home! No interview required — immediate start. A $49 application fee covers your training kit. Send your bank account details now. Contact us only via Telegram @quickhire_jobs.';

el('run').onclick = async () => {
  const text = el('posting').value.trim();
  if (!text) { el('status').textContent = 'Paste a posting first.'; return; }
  el('run').disabled = true; el('status').textContent = 'Scanning…';
  try {
    const res = await fetch('/api/redflag/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    const body = await res.json();
    if (!res.ok || !body.ok) throw new Error(body.error || ('HTTP ' + res.status));
    render(body.result);
    el('status').textContent = 'Free scan · ' + (body.previewsRemainingThisHour ?? '–') + ' free scans left this hour';
  } catch (e) {
    el('status').textContent = 'Failed: ' + e.message;
  } finally { el('run').disabled = false; }
};

function render(r) {
  const out = [];
  out.push('<div class="verdict ' + esc(r.verdict) + '">' + (VERDICT[r.verdict] || r.verdict) +
           ' — ' + esc(r.company) + (r.role ? ' (' + esc(r.role) + ')' : '') + '</div>');
  out.push('<div class="meta">confidence ' + Math.round(r.confidence * 100) + '% · free local scan</div>');
  if (r.flags.length) {
    out.push('<div style="margin-top:.75rem"><b>Flags</b></div>');
    for (const f of r.flags.slice(0, 6)) {
      const [icon] = SEVERITY[f.severity] || ['⚪','info'];
      out.push('<div class="flag ' + esc(f.severity) + '"><b>' + icon + ' ' + esc(f.title) + '</b>' +
               esc(f.detail) + '<div class="src">source: ' + esc(f.source) + '</div></div>');
    }
  }
  if (r.questions && r.questions.length) {
    out.push('<div style="margin-top:.75rem"><b>Ask them</b></div><ul style="margin:.4rem 0 0; padding-left:1.2rem">' +
      r.questions.slice(0, 4).map((q) => '<li>' + esc(q) + '</li>').join('') + '</ul>');
  }
  out.push('<ul class="checks">');
  for (const c of r.checks) {
    const cls = (c.status === 'ok' || c.status === 'cached') ? 'ok' : (c.status === 'skipped' ? 'skip' : 'fail');
    out.push('<li class="' + cls + '">' + esc(c.label) + ' · ' + esc(c.summary || c.status) + '</li>');
  }
  out.push('</ul>');
  out.push('<div class="meta">miner spend $' + Number(r.spendUsd || 0).toFixed(2) + ' — the paid report adds the four network checks above</div>');
  el('result').innerHTML = out.join('');
  el('result').classList.remove('hidden');
}
</script>
</body>
</html>`;
