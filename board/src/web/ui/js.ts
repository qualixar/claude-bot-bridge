/**
 * Client script for the board. Plain browser JavaScript served as an external file so the CSP can stay
 * `script-src 'self'`. Rules for editing: no template literals, no `${`, and never innerHTML. All task
 * text is untrusted worker output and is only ever written with textContent.
 */
export const APP_JS = String.raw`(function () {
  "use strict";
  var STATUS = { open: "Open", claimed: "Claimed", in_progress: "In progress", needs_owner: "Needs owner", done: "Done", failed: "Failed", cancelled: "Cancelled" };
  var reduceMotion = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  var cards = {};
  var marker = "";
  var pollTimer = null;
  var source = null;
  var drawerId = null;

  function byId(id) { return document.getElementById(id); }
  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function relTime(iso) {
    var s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " d ago";
  }
  function absTime(iso) { return new Date(iso).toLocaleString(); }
  function stampTime(node, iso) { node.dataset.iso = iso; node.textContent = relTime(iso); node.title = absTime(iso); }

  function setStatus(state, text) {
    byId("dot").dataset.state = state;
    byId("status-text").textContent = text;
  }

  function api(path) {
    return fetch(path, { credentials: "same-origin", headers: { accept: "application/json" } }).then(function (res) {
      if (res.status === 401) { window.location.assign("/board"); throw new Error("signed out"); }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return res.json();
    });
  }

  function makeCard(id) {
    var li = el("li", "card-wrap");
    li.dataset.id = id;
    var btn = el("button", "card");
    btn.type = "button";
    var head = el("div", "card-head");
    head.appendChild(el("span", "tid"));
    head.appendChild(el("span", "chip"));
    btn.appendChild(head);
    btn.appendChild(el("div", "card-title"));
    var meta = el("div", "card-meta");
    meta.appendChild(el("span", "badge"));
    meta.appendChild(el("span", "who"));
    meta.appendChild(el("span", "time"));
    btn.appendChild(meta);
    btn.addEventListener("click", function () { openDrawer(id, btn); });
    li.appendChild(btn);
    return li;
  }

  function fillCard(li, t, colKey) {
    var q = function (sel) { return li.querySelector(sel); };
    q(".tid").textContent = t.id;
    var chip = q(".chip");
    chip.textContent = "P" + t.priority;
    chip.dataset.p = String(t.priority);
    q(".card-title").textContent = t.title;
    var badge = q(".badge");
    badge.dataset.status = t.status;
    badge.textContent = STATUS[t.status] || t.status;
    badge.hidden = colKey === "open" || (colKey === "blocked");
    var who = q(".who");
    who.textContent = t.claimed_by ? t.claimed_by : "";
    who.hidden = !t.claimed_by;
    stampTime(q(".time"), t.last_activity_at || t.updated_at);
  }

  function applySnapshot(snap) {
    if (snap.marker === marker) return;
    marker = snap.marker;
    byId("paused").hidden = !snap.paused;
    var first = {};
    var id;
    for (id in cards) first[id] = cards[id].getBoundingClientRect();
    var seen = {};
    var fresh = [];
    snap.columns.forEach(function (col) {
      var list = document.querySelector('[data-col="' + col.key + '"] .cards');
      byId("count-" + col.key).textContent = String(col.count);
      col.tasks.forEach(function (t, i) {
        var li = cards[t.id];
        if (!li) { li = makeCard(t.id); cards[t.id] = li; fresh.push(li); }
        fillCard(li, t, col.key);
        seen[t.id] = true;
        if (list.children[i] !== li) list.insertBefore(li, list.children[i] || null);
      });
    });
    for (id in cards) {
      if (!seen[id]) { cards[id].remove(); delete cards[id]; }
    }
    if (!reduceMotion) animate(first, fresh);
    if (drawerId && seen[drawerId]) loadDrawer(drawerId, true);
  }

  function animate(first, fresh) {
    var id;
    for (id in first) {
      var li = cards[id];
      if (!li || !li.animate) continue;
      var last = li.getBoundingClientRect();
      var dx = first[id].left - last.left;
      var dy = first[id].top - last.top;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
      li.animate(
        [{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }],
        { duration: 320, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" }
      );
    }
    fresh.forEach(function (li) {
      if (li.animate) li.animate([{ opacity: 0, transform: "scale(0.97)" }, { opacity: 1, transform: "none" }], { duration: 240, easing: "ease-out" });
    });
  }

  function refreshTimes() {
    var nodes = document.querySelectorAll(".time[data-iso]");
    for (var i = 0; i < nodes.length; i++) nodes[i].textContent = relTime(nodes[i].dataset.iso);
  }

  function fetchSnapshot() {
    return api("/board/api/tasks").then(function (snap) { applySnapshot(snap); return snap; });
  }

  function startPolling() {
    if (pollTimer) return;
    pollTimer = window.setInterval(function () {
      fetchSnapshot().then(function () { setStatus("offline", "Polling every 3 s"); }, function () { setStatus("offline", "Offline"); });
    }, 3000);
  }
  function stopPolling() {
    if (pollTimer) { window.clearInterval(pollTimer); pollTimer = null; }
  }

  function connect() {
    if (!window.EventSource) { startPolling(); return; }
    source = new EventSource("/board/api/stream");
    source.onopen = function () { setStatus("live", "Live"); stopPolling(); };
    source.addEventListener("changed", function (ev) {
      try { applySnapshot(JSON.parse(ev.data)); } catch (e) { return; }
      setStatus("live", "Live");
      stopPolling();
    });
    source.onerror = function () {
      setStatus("offline", "Reconnecting");
      startPolling();
      if (source && source.readyState === 2) { source.close(); window.setTimeout(connect, 10000); }
    };
  }

  function section(title, text) {
    var sec = el("section", "sec");
    sec.appendChild(el("h3", null, title));
    sec.appendChild(el("p", "text", text));
    return sec;
  }

  function safeHttps(value) {
    try { var u = new URL(value); return u.protocol === "https:" ? u.href : null; } catch (e) { return null; }
  }

  function renderResult(r) {
    var sec = el("section", "sec");
    sec.appendChild(el("h3", null, "Result: " + r.outcome + " (by " + r.submitted_by + ")"));
    sec.appendChild(el("p", "text", r.summary));
    if (r.links && r.links.length) {
      var ul = el("ul", "links");
      r.links.forEach(function (l) {
        var li = el("li");
        var href = safeHttps(l);
        if (href) {
          var a = el("a", null, l);
          a.href = href;
          a.target = "_blank";
          a.rel = "noopener noreferrer nofollow";
          li.appendChild(a);
        } else {
          li.textContent = l;
        }
        ul.appendChild(li);
      });
      sec.appendChild(ul);
    }
    if (r.notes) { sec.appendChild(el("h3", null, "Notes")); sec.appendChild(el("p", "text", r.notes)); }
    return sec;
  }

  function renderTimeline(events) {
    var sec = el("section", "sec");
    sec.appendChild(el("h3", null, "Timeline"));
    var ol = el("ol", "timeline");
    events.forEach(function (e) {
      var li = el("li");
      var head = el("div", "ev-head");
      var who = el("strong", null, e.actor);
      head.appendChild(who);
      head.appendChild(document.createTextNode(" " + e.kind.replace(/_/g, " ") + (e.to_status ? " → " + e.to_status : "") + " · " + absTime(e.at)));
      li.appendChild(head);
      if (e.note) li.appendChild(el("p", "ev-note", e.note));
      ol.appendChild(li);
    });
    sec.appendChild(ol);
    return sec;
  }

  function renderDrawer(d) {
    var t = d.task;
    byId("drawer-title").textContent = t.title;
    var body = byId("drawer-body");
    var keep = body.scrollTop;
    body.textContent = "";
    var facts = el("div", "facts");
    facts.appendChild(el("span", "tid", t.id));
    var badge = el("span", "badge", STATUS[t.status] || t.status);
    badge.dataset.status = t.status;
    facts.appendChild(badge);
    var chip = el("span", "chip", "P" + t.priority);
    chip.dataset.p = String(t.priority);
    facts.appendChild(chip);
    if (t.claimed_by) facts.appendChild(el("span", null, "Claimed by " + t.claimed_by));
    facts.appendChild(el("span", null, "Created " + absTime(t.created_at)));
    if (t.deadline) facts.appendChild(el("span", null, "Deadline " + absTime(t.deadline)));
    body.appendChild(facts);
    body.appendChild(section("Brief", t.brief));
    body.appendChild(section("Deliverable", t.deliverable));
    if (t.acceptance) body.appendChild(section("Acceptance check", t.acceptance));
    if (t.question) body.appendChild(section("Question from the worker", t.question));
    if (t.owner_reply) body.appendChild(section("Owner reply", t.owner_reply));
    if (d.result) body.appendChild(renderResult(d.result));
    body.appendChild(renderTimeline(d.events));
    body.scrollTop = keep;
  }

  var lastFocus = null;
  function loadDrawer(id, silent) {
    return api("/board/api/tasks/" + encodeURIComponent(id)).then(function (d) {
      if (drawerId === id) renderDrawer(d);
    }, function () {
      if (!silent && drawerId === id) { byId("drawer-body").textContent = "Could not load this task."; }
    });
  }
  function openDrawer(id, opener) {
    drawerId = id;
    lastFocus = opener || null;
    byId("drawer-title").textContent = id;
    byId("drawer-body").textContent = "Loading...";
    byId("drawer").hidden = false;
    byId("scrim").hidden = false;
    byId("drawer-close").focus();
    loadDrawer(id, false);
  }
  function closeDrawer() {
    drawerId = null;
    byId("drawer").hidden = true;
    byId("scrim").hidden = true;
    if (lastFocus) lastFocus.focus();
  }

  byId("drawer-close").addEventListener("click", closeDrawer);
  byId("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && drawerId) closeDrawer(); });
  window.setInterval(refreshTimes, 30000);

  fetchSnapshot().catch(function () { setStatus("offline", "Offline"); });
  connect();
})();
`;
