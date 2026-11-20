/** Stylesheet for the board and the login page. No external fonts or images; light and dark by system setting. */
export const APP_CSS = `
:root {
  color-scheme: light dark;
  --bg: #f5f4f0; --surface: #ffffff; --surface-2: #faf9f6; --text: #1c1e23; --muted: #646a75;
  --border: #e2dfd8; --accent: #4452c8; --accent-soft: #e9ebfb; --shadow: 0 1px 2px rgba(20, 22, 30, 0.06);
  --live: #3d7a2a; --warn: #b7791f; --bad: #b42318;
  --p1: #b4430d; --p1-bg: #fdeee3; --p2: #8a5a00; --p2-bg: #fbf1d9; --p3: #5b616c; --p3-bg: #ecebe7;
  --ok: #3d7a2a; --ok-bg: #e8f1e3; --fail-bg: #fbe7e4; --cancel: #5b616c;
  --radius: 10px; --font: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #121317; --surface: #1b1d23; --surface-2: #20232a; --text: #e8e9ed; --muted: #9aa0ac;
    --border: #2b2e37; --accent: #939cf2; --accent-soft: #272b46; --shadow: none;
    --live: #7fbf5f; --warn: #e0a64a; --bad: #f0877b;
    --p1: #f2a272; --p1-bg: #3b2418; --p2: #e6bd62; --p2-bg: #36290e; --p3: #a4a9b4; --p3-bg: #2a2d35;
    --ok: #86c46a; --ok-bg: #1f2e19; --fail-bg: #3a1f1c; --cancel: #a4a9b4;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font: 15px/1.5 var(--font); display: flex; flex-direction: column; }
[hidden] { display: none !important; }
button { font: inherit; color: inherit; cursor: pointer; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

.top { display: flex; align-items: center; gap: 16px; padding: 14px 20px; border-bottom: 1px solid var(--border); background: var(--surface); }
.top h1 { margin: 0; font-size: 17px; font-weight: 650; letter-spacing: -0.01em; flex: 1; }
.top .sep { color: var(--muted); font-weight: 400; margin: 0 4px; }
.status { display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: var(--warn); }
.dot[data-state="live"] { background: var(--live); }
.dot[data-state="offline"] { background: var(--bad); }
.ghost { background: transparent; border: 1px solid var(--border); border-radius: 8px; padding: 6px 12px; font-size: 13px; color: var(--muted); }
.ghost:hover { color: var(--text); border-color: var(--muted); }
.banner { padding: 10px 20px; background: var(--p2-bg); color: var(--p2); border-bottom: 1px solid var(--border); font-size: 14px; }

.board { flex: 1; min-height: 0; display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 16px; padding: 16px 20px 20px; }
.col { display: flex; flex-direction: column; min-height: 0; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius); }
.col h2 { margin: 0; padding: 12px 14px; font-size: 13px; font-weight: 650; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); display: flex; justify-content: space-between; }
.count { font-variant-numeric: tabular-nums; background: var(--border); color: var(--text); border-radius: 999px; padding: 0 8px; font-size: 12px; line-height: 20px; }
.cards { list-style: none; margin: 0; padding: 0 10px 10px; display: flex; flex-direction: column; gap: 8px; overflow-y: auto; flex: 1; min-height: 80px; }
.cards:empty::before { content: "Nothing here"; color: var(--muted); font-size: 13px; padding: 14px 4px; }
.card { width: 100%; text-align: left; background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 10px 12px; box-shadow: var(--shadow); display: block; }
.card:hover { border-color: var(--accent); }
.card-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 4px; }
.tid { font-family: var(--mono); font-size: 12px; color: var(--muted); }
.card-title { font-weight: 550; overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.card-meta { display: flex; flex-wrap: wrap; gap: 6px 10px; margin-top: 8px; font-size: 12px; color: var(--muted); align-items: center; }
.chip { border-radius: 6px; padding: 1px 7px; font-size: 11px; font-weight: 650; background: var(--p3-bg); color: var(--p3); }
.chip[data-p="1"] { background: var(--p1-bg); color: var(--p1); }
.chip[data-p="2"] { background: var(--p2-bg); color: var(--p2); }
.badge { border-radius: 6px; padding: 1px 7px; font-size: 11px; font-weight: 650; background: var(--p3-bg); color: var(--p3); }
.badge[data-status="done"] { background: var(--ok-bg); color: var(--ok); }
.badge[data-status="failed"] { background: var(--fail-bg); color: var(--bad); }
.badge[data-status="needs_owner"] { background: var(--p2-bg); color: var(--p2); }
.badge[data-status="in_progress"] { background: var(--accent-soft); color: var(--accent); }
.badge[data-status="cancelled"] { color: var(--cancel); text-decoration: line-through; }

.scrim { position: fixed; inset: 0; background: rgba(10, 12, 18, 0.4); }
.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(560px, 100%); background: var(--surface); border-left: 1px solid var(--border); box-shadow: -8px 0 30px rgba(0, 0, 0, 0.18); display: flex; flex-direction: column; animation: slide-in 0.2s ease-out; }
@keyframes slide-in { from { transform: translateX(24px); opacity: 0; } to { transform: none; opacity: 1; } }
.drawer-head { display: flex; gap: 12px; align-items: flex-start; padding: 16px 20px; border-bottom: 1px solid var(--border); }
.drawer-head h2 { margin: 0; font-size: 18px; line-height: 1.3; flex: 1; overflow-wrap: anywhere; }
.drawer-body { overflow-y: auto; padding: 8px 20px 28px; flex: 1; }
.facts { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 13px; padding: 10px 0 4px; align-items: center; }
.sec h3 { margin: 18px 0 6px; font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
.sec .text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; }
.sec a { color: var(--accent); overflow-wrap: anywhere; }
.links { margin: 6px 0 0; padding-left: 18px; }
.timeline { list-style: none; margin: 0; padding: 0 0 0 14px; border-left: 2px solid var(--border); }
.timeline li { position: relative; padding: 0 0 12px 12px; }
.timeline li::before { content: ""; position: absolute; left: -20px; top: 7px; width: 8px; height: 8px; border-radius: 50%; background: var(--accent); }
.ev-head { font-size: 13px; color: var(--muted); }
.ev-head strong { color: var(--text); font-weight: 600; }
.ev-note { white-space: pre-wrap; overflow-wrap: anywhere; margin: 2px 0 0; font-size: 14px; }

.login { margin: auto; width: min(380px, calc(100% - 32px)); background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 28px; box-shadow: var(--shadow); }
.login h1 { margin: 0 0 4px; font-size: 20px; }
.login p { margin: 0 0 18px; color: var(--muted); font-size: 14px; }
.login label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; }
.login input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: var(--bg); color: var(--text); font: 15px var(--mono); }
.login .go { margin-top: 14px; width: 100%; padding: 10px; border: 0; border-radius: 8px; background: var(--accent); color: #fff; font-weight: 600; }
@media (prefers-color-scheme: dark) { .login .go { color: #12141c; } }
.login .err { margin: 12px 0 0; color: var(--bad); font-size: 14px; }

@media (max-width: 760px) {
  .top { padding: 12px 14px; gap: 10px; }
  .top h1 { font-size: 15px; }
  .board { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; padding: 12px 14px 16px; gap: 12px; -webkit-overflow-scrolling: touch; }
  .col { flex: 0 0 86%; scroll-snap-align: center; }
  .drawer { width: 100%; border-left: 0; }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
}
`;
