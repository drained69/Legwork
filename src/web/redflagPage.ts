/**
 * The Legwork web app — GET / and GET /redflag.
 *
 * A single-page premium workspace over BOTH sides of the Telegraph flywheel:
 *   · HUNT — the earn side: the exact signal pipeline our registered miner
 *     serves, free for any visitor (live boards, explained scores, live pay
 *     synthesis).
 *   · VET — the spend side: Redflag buys live checks from independent
 *     Telegraph miners (operator-paid, rate- and budget-capped) and renders
 *     the receipt as a live verification pipeline.
 *
 * Design system is inline on purpose — no build tooling, no CDN assets, one
 * HTML string served straight from memory. The client JS uses string
 * concatenation (never template literals) so nothing collides with the outer
 * TS template literal. Every fetch targets an existing endpoint with an
 * unchanged payload; this file is UI only.
 */

export const REDFLAG_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Legwork — job search, independently verified</title>
<meta name="description" content="Legwork searches live job boards and verifies every opportunity through an independent trust network. Explained 0–100 scores; scam, news, URL and claims checks bought from independent Telegraph miners.">
<meta property="og:title" content="Legwork — job search, independently verified">
<meta property="og:description" content="Search live job boards with explained scores. Vet any offer with scam, news, URL and fact-checks bought from independent Telegraph miners — every check names its miner and cost.">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="Legwork — job search, independently verified">
<meta name="twitter:description" content="Search live boards with explained scores; vet offers with checks bought from independent Telegraph miners.">
<style>
  :root {
    color-scheme: dark;
    /* ── surfaces ── */
    --bg: #08090c;
    --bg-soft: #0b0d12;
    --surface: #0f1218;
    --surface-2: #12161e;
    --surface-3: #161b25;
    --border: #1c2230;
    --border-strong: #29313f;
    /* ── text ── */
    --text: #e9ecf2;
    --text-2: #b7bfce;
    --muted: #8a93a4;
    --faint: #626b7d;
    /* ── accent + semantic ── */
    --accent: #5b84ff;
    --accent-soft: #5b84ff1f;
    --accent-line: #5b84ff44;
    --pos: #35d29a;
    --pos-soft: #35d29a1c;
    --warn: #f2b04e;
    --warn-soft: #f2b04e1c;
    --danger: #f26565;
    --danger-soft: #f265651c;
    /* ── type ── */
    --sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    /* ── spacing scale (8pt) ── */
    --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 64px; --s9: 96px;
    --radius: 10px; --radius-sm: 8px; --radius-lg: 14px;
    --ring: 0 0 0 2px var(--bg), 0 0 0 4px var(--accent);
    --shadow: 0 1px 2px rgba(0,0,0,.4), 0 8px 30px rgba(0,0,0,.28);
    --maxw: 1080px;
  }
  * { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 400 16px/1.6 var(--sans); letter-spacing: -0.006em;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
  }
  ::selection { background: var(--accent-soft); }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  h1, h2, h3 { margin: 0; font-weight: 650; letter-spacing: -0.02em; line-height: 1.15; }
  p { margin: 0; }
  button { font-family: inherit; }
  :focus-visible { outline: none; box-shadow: var(--ring); border-radius: var(--radius-sm); }
  .mono { font-family: var(--mono); font-feature-settings: "tnum" 1; letter-spacing: 0; }
  .wrap { max-width: var(--maxw); margin: 0 auto; padding: 0 var(--s5); }
  [hidden] { display: none !important; }

  /* ── header ─────────────────────────────────────────────────────────── */
  .appbar {
    position: sticky; top: 0; z-index: 50;
    background: color-mix(in srgb, var(--bg) 86%, transparent);
    backdrop-filter: saturate(140%) blur(10px);
    border-bottom: 1px solid var(--border);
  }
  .appbar .row { display: flex; align-items: center; gap: var(--s5); height: 60px; }
  .brand { display: inline-flex; align-items: center; gap: 9px; font-weight: 650; letter-spacing: -0.02em; font-size: 1.06rem; color: var(--text); }
  .brand:hover { text-decoration: none; }
  .brand .dot { width: 10px; height: 10px; border-radius: 3px; background: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
  .nav { display: flex; gap: var(--s2); margin-left: auto; align-items: center; }
  .nav a { color: var(--muted); font-size: .9rem; padding: 7px 11px; border-radius: 7px; }
  .nav a:hover { color: var(--text); background: var(--surface-2); text-decoration: none; }
  .live { display: inline-flex; align-items: center; gap: 7px; color: var(--muted); font-size: .78rem; padding: 6px 11px; border: 1px solid var(--border); border-radius: 999px; }
  .live .pulse { width: 7px; height: 7px; border-radius: 50%; background: var(--pos); box-shadow: 0 0 0 0 var(--pos); animation: pulse 2.4s infinite; }
  @keyframes pulse { 0% { box-shadow: 0 0 0 0 var(--pos-soft); } 70% { box-shadow: 0 0 0 6px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
  .menu-btn { display: none; margin-left: auto; background: var(--surface-2); border: 1px solid var(--border); color: var(--text); border-radius: 8px; width: 40px; height: 40px; cursor: pointer; font-size: 1.1rem; }

  /* ── hero ───────────────────────────────────────────────────────────── */
  .hero { padding: var(--s9) 0 var(--s7); position: relative; overflow: hidden; }
  .hero::before {
    content: ""; position: absolute; inset: -40% 0 auto 0; height: 520px; z-index: -1;
    background: radial-gradient(60% 60% at 50% 0%, #5b84ff14, transparent 70%);
    pointer-events: none;
  }
  .eyebrow { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: .74rem; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); margin-bottom: var(--s4); }
  .eyebrow .tick { color: var(--pos); }
  .hero h1 { font-size: clamp(2.1rem, 5.4vw, 3.5rem); max-width: 16ch; }
  .hero .lede { color: var(--text-2); font-size: clamp(1rem, 1.6vw, 1.18rem); max-width: 54ch; margin-top: var(--s4); }

  /* ── search ─────────────────────────────────────────────────────────── */
  .searchbar { margin-top: var(--s6); max-width: 720px; }
  .searchfield { display: flex; gap: var(--s2); background: var(--surface); border: 1px solid var(--border-strong); border-radius: 12px; padding: 7px 7px 7px var(--s4); align-items: center; transition: border-color .15s, box-shadow .15s; }
  .searchfield:focus-within { border-color: var(--accent-line); box-shadow: 0 0 0 4px var(--accent-soft); }
  .searchfield svg { flex: 0 0 auto; color: var(--muted); }
  .searchfield input { flex: 1; min-width: 0; background: transparent; border: 0; color: var(--text); font: 400 1.02rem var(--sans); padding: 12px 0; }
  .searchfield input::placeholder { color: var(--faint); }
  .searchfield input:focus { outline: none; }
  .btn { border: 1px solid transparent; border-radius: 9px; padding: 12px 18px; font-weight: 600; font-size: .95rem; cursor: pointer; transition: background .15s, border-color .15s, transform .06s, opacity .15s; white-space: nowrap; }
  .btn:active { transform: translateY(1px); }
  .btn:disabled { opacity: .55; cursor: progress; }
  .btn-primary { background: var(--accent); color: #fff; }
  .btn-primary:hover:not(:disabled) { background: #6f93ff; }
  .btn-ghost { background: var(--surface-2); color: var(--text); border-color: var(--border-strong); }
  .btn-ghost:hover:not(:disabled) { border-color: var(--accent-line); color: #fff; }
  .btn-quiet { background: transparent; color: var(--accent); border-color: transparent; padding: 10px 12px; }
  .btn-quiet:hover:not(:disabled) { background: var(--accent-soft); }
  .examples { margin-top: var(--s4); display: flex; flex-wrap: wrap; gap: var(--s2); align-items: center; }
  .examples .label { color: var(--faint); font-size: .82rem; margin-right: var(--s1); }
  .chip { background: var(--surface-2); border: 1px solid var(--border); color: var(--text-2); font-size: .82rem; padding: 6px 11px; border-radius: 999px; cursor: pointer; transition: border-color .15s, color .15s; }
  .chip:hover { border-color: var(--accent-line); color: var(--text); }
  .secondary-cta { margin-top: var(--s5); color: var(--muted); font-size: .92rem; }
  .secondary-cta a { font-weight: 550; }
  .inline-status { color: var(--muted); font-size: .86rem; min-height: 1.2em; }
  .inline-status.err { color: var(--danger); }

  /* ── section scaffolding ────────────────────────────────────────────── */
  section { padding: var(--s8) 0; border-top: 1px solid var(--border); scroll-margin-top: 72px; }
  section.flush { border-top: 0; padding-top: 0; }
  .section-head { max-width: 62ch; margin-bottom: var(--s6); }
  .section-head .kicker { font-family: var(--mono); font-size: .74rem; letter-spacing: .14em; text-transform: uppercase; color: var(--accent); }
  .section-head h2 { font-size: clamp(1.5rem, 3vw, 2rem); margin-top: var(--s3); }
  .section-head p { color: var(--text-2); margin-top: var(--s3); font-size: 1.02rem; }

  /* ── job result cards ───────────────────────────────────────────────── */
  .results-meta { display: flex; align-items: center; gap: var(--s3); color: var(--muted); font-size: .86rem; margin-bottom: var(--s4); }
  .results-grid { display: grid; gap: var(--s3); }
  .job {
    display: grid; grid-template-columns: 72px 1fr auto; gap: var(--s5); align-items: start;
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: var(--s5); transition: border-color .15s, background .15s, transform .12s;
  }
  .job:hover { border-color: var(--border-strong); background: var(--surface-2); }
  .ring { position: relative; width: 64px; height: 64px; }
  .ring svg { transform: rotate(-90deg); display: block; }
  .ring .val { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--mono); font-weight: 600; font-size: 1.18rem; }
  .job .title { font-size: 1.06rem; font-weight: 600; letter-spacing: -0.01em; }
  .job .company { color: var(--text-2); font-size: .92rem; margin-top: 2px; }
  .job .facts { display: flex; flex-wrap: wrap; gap: var(--s2) var(--s4); margin-top: var(--s3); color: var(--muted); font-size: .85rem; }
  .job .facts .pay { color: var(--text); font-family: var(--mono); font-size: .82rem; }
  .signals { display: flex; flex-wrap: wrap; gap: var(--s2); margin-top: var(--s3); }
  .sig { display: inline-flex; align-items: center; gap: 6px; font-size: .78rem; padding: 4px 9px; border-radius: 7px; border: 1px solid var(--border); color: var(--text-2); background: var(--surface-2); }
  .sig .g { color: var(--pos); } .sig .b { color: var(--accent); } .sig .a { color: var(--warn); }
  .sig .sc { font-family: var(--mono); color: var(--muted); }
  .job .why { color: var(--text-2); font-size: .88rem; margin-top: var(--s3); max-width: 62ch; }
  .job .side { display: flex; flex-direction: column; gap: var(--s2); align-items: stretch; text-align: right; min-width: 128px; }
  .job .band { font-size: .8rem; font-weight: 600; }
  .band.hi { color: var(--pos); } .band.mid { color: var(--accent); } .band.lo { color: var(--warn); } .band.min { color: var(--muted); }
  .answer-card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s5) var(--s6); }
  .answer-card .a-label { font-size: 1.12rem; font-weight: 600; }
  .answer-card .a-body { color: var(--text-2); margin-top: var(--s3); }

  /* ── trust pipeline ─────────────────────────────────────────────────── */
  .pipeline { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; position: relative; }
  .pnode { position: relative; padding: var(--s5) var(--s4); border: 1px solid var(--border); background: var(--surface); }
  .pnode:not(:last-child) { border-right: 0; }
  .pnode:first-child { border-radius: var(--radius) 0 0 var(--radius); }
  .pnode:last-child { border-radius: 0 var(--radius) var(--radius) 0; }
  .pnode .idx { font-family: var(--mono); font-size: .72rem; color: var(--faint); }
  .pnode .pname { font-weight: 600; font-size: .95rem; margin-top: var(--s2); }
  .pnode .pdesc { color: var(--muted); font-size: .84rem; margin-top: var(--s2); line-height: 1.5; }
  .pnode .intent { display: inline-block; margin-top: var(--s3); font-family: var(--mono); font-size: .72rem; color: var(--accent); background: var(--accent-soft); padding: 2px 7px; border-radius: 5px; }
  .pnode .arrow { position: absolute; right: -9px; top: 50%; transform: translateY(-50%); z-index: 2; width: 18px; height: 18px; border-radius: 50%; background: var(--bg); color: var(--faint); display: grid; place-items: center; font-size: .7rem; }
  .pnode.final { background: linear-gradient(180deg, var(--accent-soft), transparent); border-color: var(--accent-line); }
  .pnode.final .pname { color: #fff; }

  /* ── vet workspace ──────────────────────────────────────────────────── */
  .vet-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s5); align-items: start; }
  .panel { background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: var(--s6); }
  .vet textarea {
    width: 100%; min-height: 200px; resize: vertical; background: var(--bg-soft);
    border: 1px solid var(--border-strong); border-radius: var(--radius); color: var(--text);
    padding: var(--s4); font: 400 .9rem/1.6 var(--mono); transition: border-color .15s, box-shadow .15s;
  }
  .vet textarea:focus { outline: none; border-color: var(--accent-line); box-shadow: 0 0 0 4px var(--accent-soft); }
  .vet textarea::placeholder { color: var(--faint); }
  .vet .btnrow { display: flex; gap: var(--s2); margin-top: var(--s4); align-items: center; flex-wrap: wrap; }
  .vet .hint { color: var(--faint); font-size: .82rem; margin-top: var(--s3); }
  .vet .hint a { cursor: pointer; }
  .vet-out .placeholder { color: var(--faint); font-size: .92rem; text-align: center; padding: var(--s7) var(--s4); }

  /* verification progress pipeline (live) */
  .vsteps { list-style: none; padding: 0; margin: 0; }
  .vstep { display: flex; align-items: flex-start; gap: var(--s3); padding: var(--s3) 0; border-bottom: 1px solid var(--border); opacity: .4; transition: opacity .3s; }
  .vstep:last-child { border-bottom: 0; }
  .vstep.on { opacity: 1; }
  .vstep .ic { flex: 0 0 auto; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: .72rem; font-weight: 700; border: 1px solid var(--border-strong); color: var(--muted); margin-top: 1px; }
  .vstep.done .ic { background: var(--pos-soft); border-color: transparent; color: var(--pos); }
  .vstep.run .ic { border-color: var(--accent); color: var(--accent); }
  .vstep.skip .ic { color: var(--warn); border-color: var(--warn); }
  .vstep.fail .ic { color: var(--danger); border-color: var(--danger); }
  .vstep .spin { width: 12px; height: 12px; border: 2px solid var(--accent); border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .vstep .lab { font-weight: 550; font-size: .92rem; }
  .vstep .sub { color: var(--muted); font-size: .82rem; margin-top: 2px; }
  .vstep .tags { margin-top: 6px; display: flex; flex-wrap: wrap; gap: 6px; }

  /* verdict */
  .verdict-head { display: flex; align-items: center; gap: var(--s5); }
  .verdict-ring { flex: 0 0 auto; position: relative; width: 96px; height: 96px; }
  .verdict-ring svg { transform: rotate(-90deg); }
  .verdict-ring .num { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--mono); font-weight: 650; font-size: 1.6rem; }
  .verdict-ring .den { font-size: .8rem; color: var(--faint); }
  .verdict-label { font-size: 1.35rem; font-weight: 650; letter-spacing: -0.02em; }
  .verdict-label.clear { color: var(--pos); } .verdict-label.caution { color: var(--warn); }
  .verdict-label.avoid { color: var(--danger); } .verdict-label.unknown { color: var(--muted); }
  .verdict-sub { color: var(--muted); font-size: .86rem; margin-top: 4px; }
  .badge { display: inline-flex; align-items: center; font-family: var(--mono); font-size: .72rem; color: var(--muted); background: var(--surface-2); border: 1px solid var(--border); border-radius: 6px; padding: 2px 7px; }
  .badge.miner { color: var(--accent); border-color: var(--accent-line); }
  .badge.cost { color: var(--pos); border-color: var(--pos-soft); }
  .finding { border-left: 2px solid var(--border-strong); padding: var(--s2) 0 var(--s2) var(--s4); margin: var(--s3) 0; }
  .finding.red { border-color: var(--danger); } .finding.yellow { border-color: var(--warn); }
  .finding.green { border-color: var(--pos); } .finding.info { border-color: var(--faint); }
  .finding b { font-size: .92rem; }
  .finding p { color: var(--text-2); font-size: .88rem; margin-top: 3px; }
  .finding .src { color: var(--faint); font-size: .76rem; margin-top: 5px; }
  .subhead { font-family: var(--mono); font-size: .74rem; letter-spacing: .1em; text-transform: uppercase; color: var(--muted); margin: var(--s5) 0 var(--s3); }
  .qs { margin: 0; padding-left: 1.1rem; color: var(--text-2); }
  .qs li { margin: var(--s2) 0; font-size: .9rem; }
  .receipt { list-style: none; padding: 0; margin: 0; }
  .receipt li { display: flex; gap: var(--s3); padding: var(--s3) 0; border-bottom: 1px solid var(--border); }
  .receipt li:last-child { border-bottom: 0; }
  .receipt .tick { flex: 0 0 auto; width: 20px; text-align: center; font-weight: 700; }
  .receipt .ok .tick, .receipt li.ok .tick { color: var(--pos); }
  .receipt li.skip .tick { color: var(--warn); } .receipt li.fail .tick { color: var(--danger); }
  .receipt .rl { font-weight: 550; font-size: .9rem; }
  .receipt .tags { margin-top: 5px; display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .receipt p { color: var(--text-2); font-size: .85rem; margin-top: 5px; }
  .receipt .sig { font-family: var(--mono); color: var(--faint); font-size: .74rem; border: 0; background: none; padding: 0; }
  .share-line { margin-top: var(--s5); padding: var(--s4); background: var(--bg-soft); border: 1px solid var(--border); border-radius: var(--radius); font-size: .88rem; color: var(--text-2); }
  .share-line a { word-break: break-all; }

  /* ── activity / telemetry ───────────────────────────────────────────── */
  .telemetry { display: grid; grid-template-columns: repeat(5, 1fr); gap: 0; border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .tcell { padding: var(--s5); border-right: 1px solid var(--border); }
  .tcell:last-child { border-right: 0; }
  .tcell .n { font-family: var(--mono); font-size: 1.5rem; font-weight: 600; }
  .tcell .l { color: var(--muted); font-size: .78rem; margin-top: 4px; }
  .activity-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--s5); margin-top: var(--s5); }
  .subpanel { border: 1px solid var(--border); border-radius: var(--radius); padding: var(--s5); }
  .subpanel h3 { font-size: .95rem; font-weight: 600; margin-bottom: var(--s4); }
  .miners { list-style: none; padding: 0; margin: 0; }
  .miners li { display: flex; justify-content: space-between; gap: var(--s3); padding: var(--s2) 0; border-bottom: 1px dashed var(--border); font-size: .86rem; }
  .miners li:last-child { border-bottom: 0; }
  .miners .mn { font-family: var(--mono); color: var(--accent); font-size: .82rem; }
  .miners .mc { color: var(--muted); font-size: .82rem; }
  .feed { list-style: none; padding: 0; margin: 0; }
  .feed li { display: flex; justify-content: space-between; align-items: center; gap: var(--s3); padding: var(--s2) 0; border-bottom: 1px dashed var(--border); }
  .feed li:last-child { border-bottom: 0; }
  .feed a { color: var(--text-2); font-size: .9rem; }
  .feed a:hover { color: var(--text); }
  .feed .r { display: flex; align-items: center; gap: var(--s3); }
  .feed .when { color: var(--faint); font-size: .78rem; }
  .vpill { font-family: var(--mono); font-size: .7rem; padding: 2px 8px; border-radius: 999px; text-transform: uppercase; letter-spacing: .04em; }
  .vpill.clear { background: var(--pos-soft); color: var(--pos); } .vpill.caution { background: var(--warn-soft); color: var(--warn); }
  .vpill.avoid { background: var(--danger-soft); color: var(--danger); } .vpill.unknown { background: var(--surface-2); color: var(--muted); }
  .empty { color: var(--faint); font-size: .88rem; }

  /* ── footer ─────────────────────────────────────────────────────────── */
  footer { border-top: 1px solid var(--border); padding: var(--s7) 0; color: var(--faint); font-size: .85rem; }
  footer .row { display: flex; justify-content: space-between; gap: var(--s5); flex-wrap: wrap; align-items: center; }
  footer a { color: var(--muted); }

  .reveal { opacity: 0; transform: translateY(12px); transition: opacity .5s ease, transform .5s ease; }
  .reveal.in { opacity: 1; transform: none; }

  /* ── responsive ─────────────────────────────────────────────────────── */
  @media (max-width: 900px) {
    .nav { display: none; }
    .nav.open { display: flex; position: absolute; top: 60px; left: 0; right: 0; flex-direction: column; align-items: stretch; gap: 2px; background: var(--bg-soft); border-bottom: 1px solid var(--border); padding: var(--s3) var(--s5); margin: 0; }
    .nav.open a { padding: 12px; }
    .menu-btn { display: block; }
    .live { display: none; }
    .vet-grid { grid-template-columns: 1fr; }
    .telemetry { grid-template-columns: repeat(2, 1fr); }
    .tcell:nth-child(2n) { border-right: 0; }
    .tcell { border-bottom: 1px solid var(--border); }
    .activity-grid { grid-template-columns: 1fr; }
    .pipeline { grid-template-columns: 1fr; }
    .pnode { border-right: 1px solid var(--border) !important; border-bottom: 0; }
    .pnode:not(:last-child) { border-bottom: 0; }
    .pnode:first-child { border-radius: var(--radius) var(--radius) 0 0; }
    .pnode:last-child { border-radius: 0 0 var(--radius) var(--radius); }
    .pnode .arrow { right: 50%; top: auto; bottom: -9px; transform: translateX(50%); }
  }
  @media (max-width: 620px) {
    .wrap { padding: 0 var(--s4); }
    .hero { padding: var(--s7) 0 var(--s6); }
    .searchfield { flex-wrap: wrap; padding: var(--s3); }
    .searchfield input { flex-basis: 100%; padding: 8px 4px; }
    .searchfield .btn { flex: 1; }
    .job { grid-template-columns: 56px 1fr; }
    .job .side { grid-column: 1 / -1; flex-direction: row; justify-content: flex-start; text-align: left; align-items: center; min-width: 0; margin-top: var(--s2); }
    .telemetry { grid-template-columns: 1fr; }
    .tcell { border-right: 0; }
  }
  @media (prefers-reduced-motion: reduce) {
    * { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
    .reveal { opacity: 1; transform: none; }
  }
</style>
</head>
<body>
<header class="appbar">
  <div class="wrap row">
    <a class="brand" href="/"><span class="dot"></span>Legwork</a>
    <button class="menu-btn" id="menu-btn" aria-label="Menu" aria-expanded="false">≡</button>
    <nav class="nav" id="nav" aria-label="Primary">
      <a href="#jobs">Jobs</a>
      <a href="#vet">Vet an offer</a>
      <a href="#trust">Trust network</a>
      <a href="#activity">Activity</a>
      <span class="live"><span class="pulse"></span>Network live</span>
    </nav>
  </div>
</header>

<main>
  <!-- HERO + SEARCH -->
  <section class="flush hero" id="jobs" aria-labelledby="hero-h1">
    <div class="wrap">
      <span class="eyebrow"><span class="tick">✦</span> Job search, independently verified</span>
      <h1 id="hero-h1">Find jobs worth applying to.</h1>
      <p class="lede">Legwork searches live job boards and verifies every opportunity through an independent trust network — so the score you see is checked, not guessed.</p>

      <form class="searchbar" id="hunt-form" role="search">
        <label class="visually-hidden" for="huntq" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Search live job boards</label>
        <div class="searchfield">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.2-3.2"/></svg>
          <input id="huntq" type="text" autocomplete="off" maxlength="500" placeholder="Senior backend engineer, TypeScript, remote, $150k+">
          <button class="btn btn-primary" id="run-hunt" type="submit">Search live jobs</button>
        </div>
        <div class="examples">
          <span class="label">Try</span>
          <button type="button" class="chip hq">registered nurse jobs in Austin</button>
          <button type="button" class="chip hq">what does a data analyst earn in New York</button>
          <button type="button" class="chip hq">remote product manager, $180k+</button>
        </div>
        <p class="secondary-cta">Have an offer already? <a href="#vet">Vet it for scams and red flags →</a></p>
        <p class="inline-status" id="hunt-status" aria-live="polite"></p>
      </form>

      <div id="hunt-result" aria-live="polite"></div>
    </div>
  </section>

  <!-- TRUST NETWORK -->
  <section id="trust" class="reveal" aria-labelledby="trust-h">
    <div class="wrap">
      <div class="section-head">
        <span class="kicker">The trust network</span>
        <h2 id="trust-h">Every answer is independently checked.</h2>
        <p>The verdict isn't one model's opinion. Each offer flows through independent checks — most run by separate miners on the Telegraph network — and every finding names the miner that produced it, its confidence, and what it cost.</p>
      </div>
      <div class="pipeline" role="list">
        <div class="pnode" role="listitem"><div class="idx">01</div><div class="pname">Recruiter scam scan</div><div class="pdesc">Fake-recruiter bait, fee harvesting, identity-theft signals.</div><span class="intent">FRAUD_DETECTION</span><span class="arrow">→</span></div>
        <div class="pnode" role="listitem"><div class="idx">02</div><div class="pname">Company news</div><div class="pdesc">Layoffs, funding trouble, scandals, exec departures — live.</div><span class="intent">NEWS_SEARCH</span><span class="arrow">→</span></div>
        <div class="pnode" role="listitem"><div class="idx">03</div><div class="pname">URL safety</div><div class="pdesc">Phishing or malware on the link they want you to click.</div><span class="intent">URL_SCAN</span><span class="arrow">→</span></div>
        <div class="pnode" role="listitem"><div class="idx">04</div><div class="pname">Claims fact-check</div><div class="pdesc">Are the salary, funding and awards actually true?</div><span class="intent">FACT_CHECK</span><span class="arrow">→</span></div>
        <div class="pnode final" role="listitem"><div class="idx">05</div><div class="pname">Independent verdict</div><div class="pdesc">Signals synthesized into an explained 0–100 verdict.</div><span class="intent">VERDICT</span></div>
      </div>
    </div>
  </section>

  <!-- VET AN OFFER -->
  <section id="vet" class="reveal" aria-labelledby="vet-h">
    <div class="wrap vet">
      <div class="section-head">
        <span class="kicker">Verification</span>
        <h2 id="vet-h">Is this job offer legitimate?</h2>
        <p>Paste an offer, recruiter email, or job posting. A free local scan runs instantly; the full verification buys four live checks from independent miners — on us.</p>
      </div>
      <div class="vet-grid">
        <div class="panel">
          <label class="visually-hidden" for="posting" style="position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)">Offer or job posting to verify</label>
          <textarea id="posting" placeholder="Paste the offer, recruiter email, or job posting here…

e.g. Senior Backend Engineer at Acme Corp — remote-first, $170k–$210k. Apply at https://acme.example/careers"></textarea>
          <p class="hint">No offer handy? Load <a id="load-clean">a clean posting</a> or <a id="load-scam">a classic scam</a>.</p>
          <div class="btnrow">
            <button class="btn btn-primary" id="run-full" type="button">Run verification</button>
            <button class="btn btn-ghost" id="run-free" type="button">Free scan</button>
            <span class="inline-status" id="status" aria-live="polite"></span>
          </div>
        </div>
        <div class="panel vet-out" id="vet-out" aria-live="polite">
          <div class="placeholder">Your verification report will appear here — verdict, findings, and the receipt for every miner check bought.</div>
        </div>
      </div>
    </div>
  </section>

  <!-- ACTIVITY / TELEMETRY -->
  <section id="activity" class="reveal" aria-labelledby="act-h">
    <div class="wrap">
      <div class="section-head">
        <span class="kicker">Network activity</span>
        <h2 id="act-h">The trust network, working.</h2>
        <p>Live telemetry from the checks this app has bought — real spend on real independent miners.</p>
      </div>
      <div class="telemetry" id="telemetry" role="list"></div>
      <div class="activity-grid">
        <div class="subpanel"><h3>Miners we've bought from</h3><ul class="miners" id="miners"><li class="empty">Loading…</li></ul></div>
        <div class="subpanel"><h3>Recent verdicts</h3><ul class="feed" id="recent"><li class="empty">Loading…</li></ul></div>
      </div>
    </div>
  </section>
</main>

<footer>
  <div class="wrap row">
    <span>Legwork earns as a <a href="/miner.yaml">Telegraph miner</a> and spends as a consumer of the network — the flywheel, in one app.</span>
    <span>Also in Telegram: hunts · <b>/redflag</b> vettings · <b>/watch</b> alerts</span>
  </div>
</footer>

<script>
(function () {
  "use strict";
  var el = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]; }); };
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ── nav (mobile) ──────────────────────────────────────────────────────
  var menuBtn = el('menu-btn'), nav = el('nav');
  menuBtn.addEventListener('click', function () {
    var open = nav.classList.toggle('open');
    menuBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  nav.addEventListener('click', function (e) { if (e.target.tagName === 'A') nav.classList.remove('open'); });

  // ── reveal on scroll ──────────────────────────────────────────────────
  if ('IntersectionObserver' in window && !reduce) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (en) { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
    }, { threshold: 0.12 });
    document.querySelectorAll('.reveal').forEach(function (n) { io.observe(n); });
  } else {
    document.querySelectorAll('.reveal').forEach(function (n) { n.classList.add('in'); });
  }

  // ── count-up ──────────────────────────────────────────────────────────
  function countTo(node, target, dur) {
    target = Math.round(target) || 0;
    // rAF is paused while the tab is hidden, so animating there would leave the
    // number stuck at 0. Show the true value immediately when we can't animate.
    if (reduce || document.hidden) { node.textContent = target; return; }
    var start = performance.now();
    function frame(now) {
      var t = Math.min(1, (now - start) / (dur || 700));
      var eased = 1 - Math.pow(1 - t, 3);
      node.textContent = Math.round(target * eased);
      if (t < 1) requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
  }

  // ── score ring (SVG) ──────────────────────────────────────────────────
  function bandFor(score) {
    if (score >= 80) return { cls: 'hi', color: 'var(--pos)', word: 'Excellent match' };
    if (score >= 60) return { cls: 'mid', color: 'var(--accent)', word: 'Strong match' };
    if (score >= 40) return { cls: 'lo', color: 'var(--warn)', word: 'Partial match' };
    return { cls: 'min', color: 'var(--muted)', word: 'Weak match' };
  }
  // Returns markup for a ring; caller animates it via animateRing(container, score).
  function ringHtml(size, stroke) {
    var r = (size - stroke) / 2, c = 2 * Math.PI * r, cx = size / 2;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" aria-hidden="true">' +
      '<circle cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke="var(--border-strong)" stroke-width="' + stroke + '"/>' +
      '<circle class="prog" cx="' + cx + '" cy="' + cx + '" r="' + r + '" fill="none" stroke-width="' + stroke + '" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + c.toFixed(1) + '"/></svg>';
  }
  function animateRing(container, score, size, stroke) {
    var r = (size - stroke) / 2, c = 2 * Math.PI * r;
    var band = bandFor(score);
    var prog = container.querySelector('.prog');
    var val = container.querySelector('.val, .num');
    if (prog) prog.setAttribute('stroke', band.color);
    var target = c * (1 - Math.max(0, Math.min(100, score)) / 100);
    var canAnimate = !reduce && !document.hidden;
    if (!canAnimate) {
      // Correct-but-static: the fill and number are right immediately, even in
      // a background tab where rAF never runs.
      if (prog) prog.style.strokeDashoffset = target;
      if (val) countTo(val, score, 1);
      return band;
    }
    requestAnimationFrame(function () {
      if (prog) { prog.style.transition = 'stroke-dashoffset .9s cubic-bezier(.2,.8,.2,1)'; prog.style.strokeDashoffset = target; }
    });
    if (val && val.getAttribute('data-count') === '1') countTo(val, score, 900);
    return band;
  }

  // ── examples + sample loaders ─────────────────────────────────────────
  Array.prototype.forEach.call(document.querySelectorAll('.hq'), function (b) {
    b.addEventListener('click', function () { el('huntq').value = b.textContent; el('huntq').focus(); });
  });
  el('load-clean').addEventListener('click', function () {
    el('posting').value = 'Senior Backend Engineer at Shopify\\nRemote-first, $170k–$210k. TypeScript payments team. Apply at https://jobs.shopify.com/careers';
  });
  el('load-scam').addEventListener('click', function () {
    el('posting').value = 'Data Entry Specialist at Global Logistics Ltd\\nEarn $600/day working from home! No interview required — immediate start. A $49 application fee covers your training kit. Send your bank account details now. Contact us only via Telegram @quickhire_jobs.';
  });

  // ── activity: stats + miners + recent verdicts ────────────────────────
  var ago = function (iso) {
    var mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60) return mins + 'm ago';
    if (mins < 1440) return Math.round(mins / 60) + 'h ago';
    return Math.round(mins / 1440) + 'd ago';
  };
  function tcell(n, l) { return '<div class="tcell" role="listitem"><div class="n">' + esc(n) + '</div><div class="l">' + esc(l) + '</div></div>'; }
  (function loadActivity() {
    fetch('/api/stats').then(function (r) { return r.json(); }).then(function (s) {
      el('telemetry').innerHTML =
        tcell(s.checksBought || 0, 'checks bought') +
        tcell('$' + Number(s.minerSpendUsd || 0).toFixed(2), 'paid to miners') +
        tcell(s.distinctMinersUsed || 0, 'independent miners') +
        tcell(s.totalReports || 0, 'offers vetted') +
        tcell((s.visits && s.visits.last24h) != null ? s.visits.last24h : '–', 'visitors (24h)');
      var miners = (s.perMiner || []).slice(0, 8).map(function (m) {
        return '<li><span class="mn">' + esc(m.miner) + '</span><span class="mc">' + m.checks + ' check' + (m.checks === 1 ? '' : 's') + ' · $' + Number(m.costUsd || 0).toFixed(2) + '</span></li>';
      }).join('');
      el('miners').innerHTML = miners || '<li class="empty">No miner checks bought yet — run the first verification above.</li>';
      var feed = (s.recent || []).map(function (r) {
        return '<li><a href="/report/' + esc(r.id) + '">' + esc(r.company || '(unnamed company)') + '</a>' +
          '<span class="r"><span class="vpill ' + esc(r.verdict) + '">' + esc(r.verdict) + '</span><span class="when">' + ago(r.at) + '</span></span></li>';
      }).join('');
      el('recent').innerHTML = feed || '<li class="empty">No vettings yet — run the first one above.</li>';
    }).catch(function () {
      el('telemetry').innerHTML = ''; el('miners').innerHTML = '<li class="empty">Activity unavailable.</li>';
      el('recent').innerHTML = '<li class="empty">Activity unavailable.</li>';
    });
  })();

  // ── job hunt ──────────────────────────────────────────────────────────
  var payStr = function (m) {
    if (!m.compMin && !m.compMax) return null;
    return '$' + Math.round((m.compMin || m.compMax) / 1000) + 'k' + (m.compMin && m.compMax && m.compMax !== m.compMin ? '–$' + Math.round(m.compMax / 1000) + 'k' : '');
  };
  function signalChips(m) {
    var b = m.breakdown, out = [];
    if (payStr(m)) out.push('<span class="sig"><span class="g">✓</span>Salary listed</span>');
    else out.push('<span class="sig"><span class="a">◦</span>No salary posted</span>');
    if (m.remote) out.push('<span class="sig"><span class="g">✓</span>Remote</span>');
    if (m.source) out.push('<span class="sig"><span class="b">↗</span>via ' + esc(m.source) + '</span>');
    if (b && b.skills) out.push('<span class="sig">Skills <span class="sc">' + b.skills.score + '/40</span></span>');
    if (b && b.comp) out.push('<span class="sig">Pay <span class="sc">' + b.comp.score + '/20</span></span>');
    if (b && b.seniority) out.push('<span class="sig">Seniority <span class="sc">' + b.seniority.score + '/15</span></span>');
    return out.join('');
  }
  function renderHunt(signal, remaining) {
    var host = el('hunt-result');
    if (signal.matches && signal.matches.length) {
      var head = '<div class="results-meta"><b style="color:var(--text);font-weight:600">' + signal.matches.length + ' roles</b> scored live · ' + esc((remaining == null ? '–' : remaining)) + ' free searches left this hour</div>';
      var cards = signal.matches.slice(0, 8).map(function (m, i) {
        var pay = payStr(m), band = bandFor(m.score);
        var why = (m.breakdown && m.breakdown.skills ? esc(m.breakdown.skills.reason) : '');
        return '<article class="job">' +
          '<div class="ring" data-score="' + m.score + '">' + ringHtml(64, 5) + '<span class="val mono" data-count="1">0</span></div>' +
          '<div class="main">' +
            '<div class="title">' + esc(m.title) + '</div>' +
            '<div class="company">' + esc(m.company) + (m.location ? ' · ' + esc(m.location) : '') + '</div>' +
            '<div class="facts">' + (pay ? '<span class="pay">' + esc(pay) + '</span>' : '<span>Pay not listed</span>') + '</div>' +
            '<div class="signals">' + signalChips(m) + '</div>' +
            (why ? '<p class="why">' + why + '</p>' : '') +
          '</div>' +
          '<div class="side">' +
            '<span class="band ' + band.cls + '">' + band.word + '</span>' +
            (m.url ? '<a class="btn btn-quiet" href="' + esc(m.url) + '" target="_blank" rel="noopener" style="font-size:.82rem">View posting →</a>' : '') +
            '<button class="btn btn-ghost vet-this" data-title="' + esc(m.title) + '" data-company="' + esc(m.company) + '" data-url="' + esc(m.url || '') + '" style="font-size:.82rem;padding:8px 12px">Vet this offer</button>' +
          '</div>' +
        '</article>';
      }).join('');
      host.innerHTML = '<div style="margin-top:var(--s6)">' + head + '<div class="results-grid">' + cards + '</div></div>';
      Array.prototype.forEach.call(host.querySelectorAll('.ring'), function (ring) {
        animateRing(ring, Number(ring.getAttribute('data-score')) || 0, 64, 5);
      });
      Array.prototype.forEach.call(host.querySelectorAll('.vet-this'), function (btn) {
        btn.addEventListener('click', function () {
          var t = 'Job offer: ' + btn.getAttribute('data-title') + ' at ' + btn.getAttribute('data-company') + '.' + (btn.getAttribute('data-url') ? ' Posting: ' + btn.getAttribute('data-url') : '');
          el('posting').value = t;
          document.getElementById('vet').scrollIntoView({ behavior: reduce ? 'auto' : 'smooth' });
          el('run-full').focus();
        });
      });
    } else {
      // ANSWER shape — pay synthesis or a direct answer to a general question.
      host.innerHTML = '<div style="margin-top:var(--s6)"><div class="answer-card">' +
        '<div class="a-label">' + esc(signal.label) + '</div>' +
        '<div class="a-body">' + esc((signal.reason || '').slice(0, 700)) + '</div></div></div>';
    }
  }

  var huntForm = el('hunt-form');
  huntForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var q = el('huntq').value.trim();
    if (!q) { setStatus('hunt-status', 'Type a search first.', true); return; }
    var btn = el('run-hunt');
    btn.disabled = true; setStatus('hunt-status', 'Scanning live boards…', false);
    fetch('/api/hunt/web', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: q }) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) throw new Error(res.d.error || 'Something went wrong.');
        setStatus('hunt-status', '', false);
        renderHunt(res.d.signal, res.d.huntsRemainingThisHour);
      })
      .catch(function (err) { setStatus('hunt-status', err.message, true); })
      .then(function () { btn.disabled = false; });
  });
  function setStatus(id, msg, isErr) {
    var n = el(id); n.textContent = msg; n.classList.toggle('err', !!isErr);
  }

  // ── verification (vet an offer) ───────────────────────────────────────
  var VERDICT = { clear: 'Likely legitimate', caution: 'Proceed with caution', avoid: 'High scam risk', unknown: 'Not enough signal' };
  var SEV = { red: '!', yellow: '△', green: '✓', info: 'i' };
  var STEP_DEFS = [
    { key: 'heuristics', lab: 'Recruiter & scam signals', sub: 'Local pattern scan' },
    { key: 'comp', lab: 'Compensation reality check', sub: 'Live job-board benchmark' },
    { key: 'fraud', lab: 'Independent fraud check', sub: 'FRAUD_DETECTION miner' },
    { key: 'news', lab: 'Company research', sub: 'NEWS_SEARCH miner' },
    { key: 'urlscan', lab: 'URL safety', sub: 'URL_SCAN miner' },
    { key: 'facts', lab: 'Claims fact-check', sub: 'FACT_CHECK miner' }
  ];
  function renderSteps(runningIdx) {
    return '<div class="subhead">Verifying</div><ul class="vsteps">' + STEP_DEFS.map(function (s, i) {
      var state = i < runningIdx ? 'done' : (i === runningIdx ? 'run' : '');
      var ic = i < runningIdx ? '✓' : (i === runningIdx ? '<span class="spin"></span>' : (i + 1));
      return '<li class="vstep ' + (state ? 'on ' + state : '') + '"><span class="ic">' + ic + '</span><div><div class="lab">' + s.lab + '</div><div class="sub">' + s.sub + '</div></div></li>';
    }).join('') + '</ul>';
  }
  var stepTimer = null;
  function animateSteps(full) {
    var host = el('vet-out'); var idx = 0;
    host.innerHTML = renderSteps(0);
    if (!full || reduce) return;
    stepTimer = setInterval(function () {
      idx++;
      if (idx >= STEP_DEFS.length) { clearInterval(stepTimer); return; }
      host.innerHTML = renderSteps(idx);
    }, 850);
  }
  function tagsFor(c) {
    var t = [];
    if (c.source === 'telegraph') t.push('<span class="badge miner">' + esc(c.miner || 'telegraph miner') + '</span>');
    else t.push('<span class="badge">' + (c.source === 'legwork' ? 'legwork live data' : 'local') + '</span>');
    if (c.intent) t.push('<span class="badge">' + esc(c.intent) + '</span>');
    if (c.costUsd) t.push('<span class="badge cost">$' + Number(c.costUsd).toFixed(2) + '</span>');
    return t.join(' ');
  }
  function renderVet(r, shareUrl, full) {
    if (stepTimer) clearInterval(stepTimer);
    var score = Math.round((r.confidence || 0) * 100);
    var vcls = r.verdict || 'unknown';
    var out = [];
    out.push('<div class="verdict-head">' +
      '<div class="verdict-ring">' + ringHtml(96, 7) + '<span class="num mono" data-count="1">0</span></div>' +
      '<div><div class="verdict-label ' + esc(vcls) + '">' + esc(VERDICT[vcls] || vcls) + '</div>' +
      '<div class="verdict-sub">' + esc(r.company || 'this offer') + (r.role ? ' · ' + esc(r.role) : '') + ' · confidence ' + score + '%</div>' +
      '<div class="verdict-sub">' + (full ? 'Full verification' : 'Free local scan') + ' · miner spend $' + Number(r.spendUsd || 0).toFixed(2) + ' of $' + Number(r.budgetUsd || 0).toFixed(2) + '</div>' +
      '</div></div>');

    if (r.flags && r.flags.length) {
      out.push('<div class="subhead">Findings</div>');
      r.flags.slice(0, 8).forEach(function (f) {
        out.push('<div class="finding ' + esc(f.severity) + '"><b>' + esc(f.title) + '</b><p>' + esc(f.detail) + '</p>' +
          '<div class="src">' + esc(f.source) + (f.costUsd ? ' · paid $' + Number(f.costUsd).toFixed(2) : '') + '</div></div>');
      });
    }
    if (r.questions && r.questions.length) {
      out.push('<div class="subhead">Questions to ask them</div><ul class="qs">' +
        r.questions.slice(0, 4).map(function (q) { return '<li>' + esc(q) + '</li>'; }).join('') + '</ul>');
    }
    out.push('<div class="subhead">The receipt — every check, its source and cost</div><ul class="receipt">');
    (r.checks || []).forEach(function (c) {
      var cls = (c.status === 'ok' || c.status === 'cached') ? 'ok' : (c.status === 'skipped' ? 'skip' : 'fail');
      var tick = c.status === 'ok' ? '✓' : c.status === 'cached' ? '↻' : c.status === 'skipped' ? '–' : '✗';
      out.push('<li class="' + cls + '"><span class="tick">' + tick + '</span><div><span class="rl">' + esc(c.label) + '</span>' +
        '<div class="tags">' + tagsFor(c) + '</div>' +
        '<p>' + esc(c.summary || c.status) + '</p>' +
        (c.signalHash ? '<div class="sig">signal ' + esc(c.signalHash) + '</div>' : '') + '</div></li>');
    });
    out.push('</ul>');
    if (shareUrl) out.push('<div class="share-line">🔗 Share this report: <a href="' + esc(shareUrl) + '">' + esc(shareUrl) + '</a> — a standing watch is included on the report page.</div>');
    else out.push('<div class="share-line">This was the free local scan. Run the <b>full verification</b> to buy the four live miner checks and get a shareable report.</div>');

    var host = el('vet-out');
    host.innerHTML = out.join('');
    var ring = host.querySelector('.verdict-ring');
    if (ring) animateRing(ring, score, 96, 7);
  }

  function runVet(url, body, full, working) {
    el('run-free').disabled = el('run-full').disabled = true;
    setStatus('status', working, false);
    animateSteps(full);
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok || !res.d.ok) throw new Error(res.d.error || 'Verification failed.');
        setStatus('status', '', false);
        renderVet(res.d.result || res.d.report, res.d.shareUrl, full);
      })
      .catch(function (err) {
        if (stepTimer) clearInterval(stepTimer);
        setStatus('status', err.message, true);
        el('vet-out').innerHTML = '<div class="placeholder">' + esc(err.message) + '</div>';
      })
      .then(function () { el('run-free').disabled = el('run-full').disabled = false; });
  }
  el('run-full').addEventListener('click', function () {
    var text = el('posting').value.trim();
    if (!text) { setStatus('status', 'Paste an offer first.', true); return; }
    runVet('/api/redflag/web', { text: text }, true, 'Buying live checks…');
  });
  el('run-free').addEventListener('click', function () {
    var text = el('posting').value.trim();
    if (!text) { setStatus('status', 'Paste an offer first.', true); return; }
    runVet('/api/redflag/preview', { text: text }, false, 'Scanning…');
  });
})();
</script>
</body>
</html>`;
