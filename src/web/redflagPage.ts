/**
 * The Redflag web app — GET /redflag.
 *
 * The Telegraph consumer surface: paste a job posting, get a vetting. The
 * free scan runs locally; the FULL vetting buys four live checks from
 * independent Telegraph miners (operator-paid, rate- and budget-capped) and
 * renders the receipt — which miner answered, with what confidence, at what
 * cost — because the provenance IS the product.
 *
 * Hand-rolled on purpose: no build tooling, no CDN assets, one HTML string
 * served straight from memory.
 */

export const REDFLAG_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Redflag — vet any job offer before you apply</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; background: #0c0f14; color: #e6e9ef; padding: 2rem 1rem 4rem; }
  .wrap { max-width: 860px; margin: 0 auto; }
  header h1 { font-size: 1.9rem; margin: 0 0 .35rem; letter-spacing: -.02em; }
  header h1 .flag { color: #ff5d5d; }
  header p.sub { color: #9aa3b2; margin: 0 0 1.25rem; max-width: 46rem; }
  header p.sub b { color: #c4ccd8; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .6rem; margin-bottom: 1.25rem; }
  .stat { background: #141923; border: 1px solid #232b3a; border-radius: 10px; padding: .7rem .85rem; }
  .stat .n { font-size: 1.25rem; font-weight: 800; }
  .stat .l { color: #7c8798; font-size: .74rem; text-transform: uppercase; letter-spacing: .06em; margin-top: .1rem; }
  .card { background: #141923; border: 1px solid #232b3a; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; }
  textarea { width: 100%; min-height: 150px; resize: vertical; border-radius: 8px; border: 1px solid #2a3446; background: #0f131b; color: #e6e9ef; padding: .75rem; font: 14px/1.5 ui-monospace, "SF Mono", Menlo, monospace; }
  textarea:focus { outline: 2px solid #3d6bff; border-color: transparent; }
  .btnrow { display: flex; gap: .6rem; flex-wrap: wrap; margin-top: .75rem; align-items: center; }
  button { border: 0; border-radius: 8px; padding: .65rem 1.2rem; font-weight: 700; font-size: .95rem; cursor: pointer; }
  button:disabled { opacity: .5; cursor: wait; }
  .primary { background: #3d6bff; color: #fff; }
  .ghost { background: transparent; color: #7fb0ff; border: 1px solid #3d6bff66; }
  .ghost:hover { background: #3d6bff18; }
  .status { color: #9aa3b2; font-size: .85rem; }
  .verdict { display: inline-flex; align-items: center; gap: .5rem; font-weight: 800; font-size: 1.25rem; }
  .verdict.clear { color: #4ade80; } .verdict.caution { color: #fbbf24; }
  .verdict.avoid { color: #ff5d5d; } .verdict.unknown { color: #9aa3b2; }
  .meta { color: #9aa3b2; font-size: .85rem; margin-top: .35rem; }
  .flag { border-left: 3px solid #2a3446; padding: .6rem .85rem; margin: .6rem 0; background: #0f131b; border-radius: 0 8px 8px 0; }
  .flag.red { border-color: #ff5d5d; } .flag.yellow { border-color: #fbbf24; }
  .flag.green { border-color: #4ade80; } .flag.info { border-color: #64748b; }
  .flag b { display: block; margin-bottom: .15rem; }
  .flag p { margin: .2rem 0 .3rem; font-size: .93rem; color: #c4ccd8; }
  .flag .src { color: #7c8798; font-size: .78rem; }
  .checks { list-style: none; padding: 0; margin: .5rem 0 0; font-size: .92rem; }
  .checks li { display: flex; gap: .6rem; padding: .55rem 0; border-bottom: 1px dashed #232b3a; }
  .checks li:last-child { border-bottom: 0; }
  .tick { flex: 0 0 auto; font-weight: 700; }
  .ok .tick { color: #4ade80; } .skip .tick { color: #fbbf24; } .fail .tick { color: #ff5d5d; }
  .checks p { margin: .25rem 0 0; font-size: .88rem; color: #c4ccd8; }
  .badge { display: inline-block; background: #0f131b; border: 1px solid #232b3a; border-radius: 5px; padding: 0 .4rem; margin-left: .35rem; font-size: .72rem; color: #9aa3b2; vertical-align: middle; }
  .badge.miner { color: #7fb0ff; border-color: #3d6bff55; }
  .badge.cost { color: #4ade80; border-color: #4ade8055; }
  .src { color: #7c8798; font-size: .78rem; word-break: break-all; }
  .share { margin-top: .8rem; padding: .7rem .9rem; background: #0f131b; border: 1px dashed #3d6bff55; border-radius: 8px; font-size: .9rem; }
  .share a { color: #7fb0ff; word-break: break-all; }
  ul.qs { margin: .4rem 0 0; padding-left: 1.2rem; }
  .how { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .6rem; }
  .how .cell { background: #0f131b; border: 1px solid #232b3a; border-radius: 10px; padding: .8rem .9rem; font-size: .88rem; color: #c4ccd8; }
  .how .cell b { display: block; color: #e6e9ef; margin-bottom: .2rem; }
  .how .intent { color: #7fb0ff; font-size: .74rem; font-family: ui-monospace, Menlo, monospace; }
  .example { color: #7c8798; font-size: .85rem; margin-top: .5rem; }
  .example a { color: #3d6bff; cursor: pointer; }
  .recent { list-style: none; padding: 0; margin: .4rem 0 0; }
  .recent li { display: flex; justify-content: space-between; gap: 1rem; padding: .45rem 0; border-bottom: 1px dashed #232b3a; font-size: .92rem; }
  .recent li:last-child { border-bottom: 0; }
  .recent a { color: #c4ccd8; text-decoration: none; }
  .recent a:hover { color: #7fb0ff; }
  .recent .when { color: #7c8798; font-size: .8rem; flex: 0 0 auto; }
  .pill { display: inline-block; border-radius: 999px; padding: 0 .55rem; font-size: .74rem; font-weight: 700; }
  .pill.clear { background: #4ade8022; color: #4ade80; } .pill.caution { background: #fbbf2422; color: #fbbf24; }
  .pill.avoid { background: #ff5d5d22; color: #ff5d5d; } .pill.unknown { background: #9aa3b222; color: #9aa3b2; }
  footer { color: #5b6575; font-size: .8rem; margin-top: 2rem; text-align: center; line-height: 1.7; }
  footer a { color: #5b6575; }
  .hidden { display: none; }
  h2 { font-size: 1.05rem; margin: 1.6rem 0 .6rem; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🚩 <span class="flag">Redflag</span> — vet any job offer before you apply</h1>
    <p class="sub">Paste a posting or offer email. Redflag scans it for scam patterns, benchmarks the pay against <b>live job boards</b>, and — in the full vetting — buys live scam, news, URL and fact-checks from <b>independent miners on the Telegraph network</b>. Every flag names the miner that produced it, its confidence, and what it cost.</p>
  </header>

  <div class="stats" id="stats"></div>

  <div class="card">
    <label for="posting"><b>Job posting or offer</b></label>
    <textarea id="posting" placeholder="Senior Backend Engineer at Acme Corp
Remote-first, $170k–$210k. Apply at https://acme.example/careers — or paste the whole offer email."></textarea>
    <p class="example">Try an example: <a id="load-clean">a clean posting</a> · <a id="load-scam">a classic scam</a></p>
    <div class="btnrow">
      <button class="ghost" id="run-free">Run free scan</button>
      <button class="primary" id="run-full">Run full vetting — on us</button>
      <span class="status" id="status"></span>
    </div>
    <p class="status" style="margin:.6rem 0 0">The full vetting buys ~$0.04–0.08 of live checks from Telegraph miners (FRAUD_DETECTION, NEWS_SEARCH, URL_SCAN, FACT_CHECK). We pay; you get the receipt.</p>
  </div>

  <div class="card hidden" id="result"></div>

  <h2>How the full vetting works — four live checks, four independent miners</h2>
  <div class="how">
    <div class="cell"><b>Recruiting-scam scan <span class="intent">FRAUD_DETECTION</span></b>Is this posting fake-recruiter bait, fee harvesting or identity theft?</div>
    <div class="cell"><b>Company news <span class="intent">NEWS_SEARCH</span></b>Layoffs, funding trouble, scandals, exec departures — checked live.</div>
    <div class="cell"><b>Career-page URL scan <span class="intent">URL_SCAN</span></b>Phishing or malware on the link they want you to click.</div>
    <div class="cell"><b>Claims fact-check <span class="intent">FACT_CHECK</span></b>Are the salary, funding and awards the posting claims actually true?</div>
  </div>

  <h2>Recent verdicts</h2>
  <div class="card"><ul class="recent" id="recent"><li class="status">Loading…</li></ul></div>

  <footer>Redflag is the consumer side of <a href="https://legwork-production-88e5.up.railway.app/miner.yaml">Legwork</a> — a job-search agent that earns on Telegraph as a miner and spends on it as a customer.<br>Also in Telegram: <b>/redflag</b> for vettings, <b>/watch Company</b> for standing news alerts.</footer>
</div>

<script>
const SEVERITY = { red: ['🔴','red'], yellow: ['🟡','yellow'], green: ['🟢','green'], info: ['⚪','info'] };
const VERDICT = { clear:'🟢 Clear', caution:'🟡 Caution', avoid:'🔴 Avoid', unknown:'⚪ Unknown' };

const el = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

el('load-clean').onclick = () => el('posting').value =
  'Senior Backend Engineer at Shopify\\nRemote-first, $170k–$210k. TypeScript payments team. Apply at https://jobs.shopify.com/careers';
el('load-scam').onclick = () => el('posting').value =
  'Data Entry Specialist at Global Logistics Ltd\\nEarn $600/day working from home! No interview required — immediate start. A $49 application fee covers your training kit. Send your bank account details now. Contact us only via Telegram @quickhire_jobs.';

// ── live stats ──────────────────────────────────────────────────────────────
(async () => {
  try {
    const res = await fetch('/api/stats');
    const s = await res.json();
    el('stats').innerHTML =
      stat(s.totalReports, 'vettings run') +
      stat(s.checksBought, 'miner checks bought') +
      stat('$' + Number(s.minerSpendUsd || 0).toFixed(2), 'paid to miners') +
      stat(s.distinctMinersUsed, 'distinct miners used');
    const feed = (s.recent || []).map((r) =>
      '<li><a href="/report/' + esc(r.id) + '">' + esc(r.company || '(unnamed company)') + '</a>' +
      '<span><span class="pill ' + esc(r.verdict) + '">' + esc(r.verdict) + '</span> <span class="when">' + ago(r.at) + '</span></span></li>').join('');
    el('recent').innerHTML = feed || '<li class="status">No vettings yet — run the first one above.</li>';
  } catch { el('recent').innerHTML = '<li class="status">Stats unavailable.</li>'; }
})();
const stat = (n, l) => '<div class="stat"><div class="n">' + esc(n) + '</div><div class="l">' + esc(l) + '</div></div>';
const ago = (iso) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return mins + 'm ago';
  if (mins < 1440) return Math.round(mins / 60) + 'h ago';
  return Math.round(mins / 1440) + 'd ago';
};

// ── free scan ───────────────────────────────────────────────────────────────
el('run-free').onclick = async () => {
  const text = el('posting').value.trim();
  if (!text) { el('status').textContent = 'Paste a posting first.'; return; }
  await run('/api/redflag/preview', { text }, 'Scanning…', 'free scan', false);
};

// ── full vetting (operator-paid Telegraph miner checks) ────────────────────
el('run-full').onclick = async () => {
  const text = el('posting').value.trim();
  if (!text) { el('status').textContent = 'Paste a posting first.'; return; }
  await run('/api/redflag/web', { text }, 'Buying checks from Telegraph miners…', 'full vetting', true);
};

async function run(url, body, busy, what, full) {
  el('run-free').disabled = el('run-full').disabled = true;
  el('status').textContent = busy;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
    render(data.result || data.report, data.shareUrl, full);
    el('status').textContent = what + ' done';
  } catch (e) {
    el('status').textContent = 'Failed: ' + e.message;
  } finally { el('run-free').disabled = el('run-full').disabled = false; }
}

function render(r, shareUrl, full) {
  const out = [];
  out.push('<div class="verdict ' + esc(r.verdict) + '">' + (VERDICT[r.verdict] || r.verdict) +
           ' — ' + esc(r.company) + (r.role ? ' (' + esc(r.role) + ')' : '') + '</div>');
  out.push('<div class="meta">confidence ' + Math.round((r.confidence || 0) * 100) + '% · ' +
           (full ? 'full vetting' : 'free local scan') +
           ' · miner spend $' + Number(r.spendUsd || 0).toFixed(2) + ' of $' + Number(r.budgetUsd || 0).toFixed(2) + '</div>');
  if (r.flags && r.flags.length) {
    out.push('<div style="margin-top:.75rem"><b>Findings</b></div>');
    for (const f of r.flags.slice(0, 8)) {
      const [icon] = SEVERITY[f.severity] || ['⚪','info'];
      out.push('<div class="flag ' + esc(f.severity) + '"><b>' + icon + ' ' + esc(f.title) + '</b>' +
               '<p>' + esc(f.detail) + '</p><div class="src">source: ' + esc(f.source) +
               (f.costUsd ? ' · paid $' + Number(f.costUsd).toFixed(2) : '') + '</div></div>');
    }
  }
  if (r.questions && r.questions.length) {
    out.push('<div style="margin-top:.75rem"><b>Ask them</b></div><ul class="qs">' +
      r.questions.slice(0, 4).map((q) => '<li>' + esc(q) + '</li>').join('') + '</ul>');
  }
  out.push('<div style="margin-top:.75rem"><b>The receipt</b></div><ul class="checks">');
  for (const c of (r.checks || [])) {
    const cls = (c.status === 'ok' || c.status === 'cached') ? 'ok' : (c.status === 'skipped' ? 'skip' : 'fail');
    const tick = c.status === 'ok' ? '✓' : c.status === 'cached' ? '↻' : c.status === 'skipped' ? '–' : '✗';
    out.push('<li class="' + cls + '"><span class="tick">' + tick + '</span><div><b>' + esc(c.label) + '</b>' +
      (c.source === 'telegraph' ? '<span class="badge miner">' + esc(c.miner || 'telegraph miner') + '</span>' :
        '<span class="badge">' + (c.source === 'legwork' ? 'legwork live data' : 'local') + '</span>') +
      (c.intent ? '<span class="badge">' + esc(c.intent) + '</span>' : '') +
      (c.costUsd ? '<span class="badge cost">$' + Number(c.costUsd).toFixed(2) + '</span>' : '') +
      '<p>' + esc(c.summary || c.status) + '</p>' +
      (c.signalHash ? '<div class="src">signal ' + esc(c.signalHash) + '</div>' : '') + '</div></li>');
  }
  out.push('</ul>');
  if (shareUrl) out.push('<div class="share">🔗 Share this report: <a href="' + esc(shareUrl) + '">' + esc(shareUrl) + '</a></div>');
  else out.push('<div class="share">The free scan runs locally — run the <b>full vetting</b> to buy the four live miner checks and get a shareable report.</div>');
  el('result').innerHTML = out.join('');
  el('result').classList.remove('hidden');
  el('result').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
</script>
</body>
</html>`;
