import { COLUMNS } from "../../store/web";

const FAVICON =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='4' fill='%234452c8'/%3E%3Cpath d='M4 8h8M8 4v8' stroke='white' stroke-width='1.6' stroke-linecap='round'/%3E%3C/svg%3E";

const head = (title: string): string =>
  '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  '<meta name="color-scheme" content="light dark">\n<meta name="robots" content="noindex">\n' +
  `<title>${title}</title>\n<link rel="icon" href="${FAVICON}">\n<link rel="stylesheet" href="/board/assets/app.css">\n</head>\n`;

export type LoginNotice = "none" | "rejected" | "limited" | "unavailable" | "proxy";

const NOTICES: Record<LoginNotice, string> = {
  none: "",
  rejected: "That key was not accepted.",
  limited: "Too many failed attempts. Wait a minute and try again.",
  unavailable: "The board is not fully configured: SESSION_SECRET is missing on the server.",
  proxy:
    "This board sits behind a proxy that terminates TLS, but the server was not told to trust it, so it sees http where your browser sees https. " +
    "Set TRUST_PROXY=1 on the server (only when exactly one proxy you control sits in front), restart it, and sign in again.",
};

export function loginPage(notice: LoginNotice): string {
  const err = notice === "none" ? "" : `<p class="err" role="alert">${NOTICES[notice]}</p>`;
  return (
    head("Claude Bot Bridge · Board") +
    '<body>\n<main class="login">\n<h1>Claude Bot Bridge · Board</h1>\n<p>Read-only view. Enter the viewer key.</p>\n' +
    '<form method="post" action="/board/login">\n<label for="key">Key</label>\n' +
    '<input id="key" name="key" type="password" autocomplete="current-password" required autofocus>\n' +
    `<button class="go" type="submit">Open board</button>\n${err}\n</form>\n</main>\n</body>\n</html>\n`
  );
}

const column = (c: (typeof COLUMNS)[number]): string =>
  `<section class="col" data-col="${c.key}" aria-label="${c.title}">` +
  `<h2>${c.title}<span class="count" id="count-${c.key}">0</span></h2><ol class="cards"></ol></section>`;

export function boardPage(): string {
  return (
    head("Claude Bot Bridge · Board") +
    '<body>\n<header class="top">\n<h1>Claude Bot Bridge<span class="sep">·</span>Board</h1>\n' +
    '<div class="status" role="status"><span class="dot" id="dot" data-state="connecting"></span><span id="status-text">Connecting</span></div>\n' +
    '<form method="post" action="/board/logout"><button class="ghost" type="submit">Sign out</button></form>\n</header>\n' +
    '<div class="banner" id="paused" role="status" hidden>The board is paused. Workers are told to stop until the owner resumes it.</div>\n' +
    `<main class="board" id="board">\n${COLUMNS.map(column).join("\n")}\n</main>\n` +
    '<div class="scrim" id="scrim" hidden></div>\n' +
    '<aside class="drawer" id="drawer" role="dialog" aria-labelledby="drawer-title" hidden>\n' +
    '<div class="drawer-head"><h2 id="drawer-title"></h2><button class="ghost" id="drawer-close" type="button" aria-label="Close">Close</button></div>\n' +
    '<div class="drawer-body" id="drawer-body"></div>\n</aside>\n' +
    '<script src="/board/assets/app.js" defer></script>\n</body>\n</html>\n'
  );
}
