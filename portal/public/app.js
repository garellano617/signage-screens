"use strict";
/* Signage Portal: single-page app, hash routing, no build step. */

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v; // only used with static strings
    else if (k in el && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}
const $ = s => document.querySelector(s);
const app = () => $("#app");

async function api(method, url, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch("/api" + url, opt);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && url !== "/auth/login") { state.user = null; renderLogin(); throw new Error("Please log in."); }
  if (!res.ok) throw new Error((data && data.error) || "Request failed (" + res.status + ")");
  return data;
}

let toastTimer;
function toast(msg, err) {
  const t = $("#toast");
  t.textContent = msg;
  t.className = "show" + (err ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = ""), err ? 5000 : 2500);
}
const fail = e => toast(e.message || String(e), true);

function bytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB", "TB"]; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(n < 10 ? 1 : 0) : n) + " " + u[i];
}
function ago(ts) {
  if (!ts) return "never";
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  return Math.round(s / 86400) + " d ago";
}
function dur(sec) {
  if (!sec) return "0s";
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? (m + "m" + (s ? " " + s + "s" : "")) : s + "s";
}
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
function daysText(mask) {
  if (mask === 127) return "Every day";
  if (mask === 31) return "Mon–Fri";
  if (mask === 96) return "Sat–Sun";
  return DAYS.filter((_, i) => mask & (1 << i)).join(", ");
}
const statusPill = s => s.online
  ? h("span", { class: "pill ok" }, h("span", { class: "dot" }), "Online")
  : h("span", { class: "pill danger" }, h("span", { class: "dot" }), "Offline");

function dialog(title, body, { submit = "Save", danger = false, onSubmit } = {}) {
  return new Promise(resolve => {
    const err = h("div", { class: "form-error" });
    const btn = h("button", { type: "submit", class: danger ? "danger" : "primary" }, submit);
    const form = h("form", { method: "dialog" }, h("h2", {}, title), body, err,
      h("div", { class: "dlg-actions" }, h("button", { type: "button", onclick: () => { d.close(); resolve(null); } }, "Cancel"), btn));
    const d = h("dialog", {}, form);
    form.addEventListener("submit", async e => {
      e.preventDefault();
      err.textContent = ""; btn.disabled = true;
      try { const r = onSubmit ? await onSubmit(new FormData(form)) : true; d.close(); resolve(r === undefined ? true : r); }
      catch (ex) { err.textContent = ex.message; }
      finally { btn.disabled = false; }
    });
    d.addEventListener("close", () => { d.remove(); resolve(null); });
    document.body.append(d);
    d.showModal();
    const first = form.querySelector("input, select, textarea");
    if (first) first.focus();
  });
}
const confirmDlg = (title, text, submit = "Delete") => dialog(title, h("p", {}, text), { submit, danger: true });
const field = (label, input) => h("div", { class: "field" }, h("label", {}, label), input);

function thumb(m, cls) {
  const box = h("div", { class: cls || "thumb" });
  if (m.kind === "image") box.append(h("img", { src: m.src, alt: "", loading: "lazy" }));
  else if (m.kind === "video") box.append(h("video", { src: m.src + "#t=1", muted: true, preload: "metadata" }));
  else box.append(h("span", {}, "🌐 Web page"));
  return box;
}

// ---------- state & routing ----------
const state = { user: null, timer: null };

const ICONS = {
  dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  screens: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  playlists: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h13M3 12h13M3 18h9"/><path d="M17 15l5 3-5 3z" fill="currentColor"/></svg>',
  media: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};
const LOGO = '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2" fill="#2563eb"/><path d="M10 8l5 2.5-5 2.5z" fill="#fff"/><rect x="8" y="19" width="8" height="2" rx="1" fill="#2563eb"/></svg>';

const routes = [
  [/^\/?$/, "dashboard", renderDashboard],
  [/^\/screens$/, "screens", renderScreens],
  [/^\/screens\/(\d+)$/, "screens", renderScreen],
  [/^\/playlists$/, "playlists", renderPlaylists],
  [/^\/playlists\/(\d+)$/, "playlists", renderPlaylist],
  [/^\/media$/, "media", renderMedia],
  [/^\/settings$/, "settings", renderSettings]
];

function shell(section) {
  const link = (key, label) => h("a", { href: "#/" + (key === "dashboard" ? "" : key), class: section === key ? "active" : "", html: ICONS[key] + "<span>" + label + "</span>" });
  const nav = h("nav", { class: "nav" },
    h("div", { class: "brand", html: LOGO + "<span>Signage</span>" }),
    link("dashboard", "Dashboard"), link("screens", "Screens"), link("playlists", "Playlists"), link("media", "Media"), link("settings", "Settings"),
    h("div", { class: "spacer" }),
    h("div", { class: "who" }, state.user.email));
  const main = h("main", {});
  app().replaceChildren(h("div", { class: "layout" }, nav, main));
  return main;
}

async function route() {
  clearInterval(state.timer); state.timer = null;
  window.onbeforeunload = null;
  if (!state.user) return renderLogin();
  const path = location.hash.replace(/^#/, "") || "/";
  for (const [re, section, fn] of routes) {
    const m = path.match(re);
    if (m) {
      const main = shell(section);
      main.append(h("div", { class: "muted" }, "Loading…"));
      try { await fn(main, ...m.slice(1)); } catch (e) { if (state.user) main.replaceChildren(h("div", { class: "card" }, "Couldn't load this page: " + e.message)); }
      return;
    }
  }
  location.hash = "#/";
}
window.addEventListener("hashchange", route);

// ---------- login ----------
function renderLogin() {
  clearInterval(state.timer);
  const err = h("div", { class: "form-error" });
  const btn = h("button", { type: "submit", class: "primary", style: "width:100%;justify-content:center" }, "Log in");
  const form = h("form", { class: "card login" },
    h("div", { class: "brand", html: LOGO + "<span>Signage Portal</span>" }),
    field("Email", h("input", { name: "email", type: "email", autocomplete: "username", required: true })),
    field("Password", h("input", { name: "password", type: "password", autocomplete: "current-password", required: true })),
    err, btn);
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true;
    const f = new FormData(form);
    try {
      const r = await api("POST", "/auth/login", { email: f.get("email"), password: f.get("password") });
      state.user = r.user; route();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  app().replaceChildren(h("div", { class: "login-wrap" }, form));
  form.querySelector("input").focus();
}

// ---------- dashboard ----------
async function renderDashboard(main) {
  const d = await api("GET", "/dashboard");
  const stat = (num, lbl, cls) => h("div", { class: "card stat" }, h("div", { class: "num " + (cls || "") }, num), h("div", { class: "lbl" }, lbl));
  const list = (title, items, empty, extra) => h("div", { class: "card" }, h("h2", {}, title),
    items.length ? h("table", {}, h("tbody", {}, items.map(s => h("tr", { class: "click", onclick: () => (location.hash = "#/screens/" + s.id) },
      h("td", {}, h("strong", {}, s.name), h("div", { class: "small muted" }, s.location || "")), h("td", { class: "small muted" }, extra(s))))))
      : h("p", { class: "muted" }, empty));
  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "Dashboard"),
      h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen"))),
    h("div", { class: "grid stats" },
      stat(d.screens, "Screens"), stat(d.online, "Online now"), stat(d.offline.length, "Offline"),
      stat(d.playlists, "Playlists"), stat(d.media, "Media files · " + bytes(d.mediaBytes))),
    h("div", { class: "grid two", style: "margin-top:1rem" },
      list("Offline screens", d.offline, d.screens ? "All screens are online. 👍" : "No screens yet. Click “Add screen” to pair a TV.", s => "Last seen " + ago(s.lastSeen)),
      list("Screens with nothing to play", d.noContent, "Every screen has a playlist.", () => "No playlist")));
  state.timer = setInterval(() => { if (location.hash.replace(/^#\/?/, "") === "") renderDashboard(main).catch(() => {}); }, 15000);
}

// ---------- screens ----------
async function pairDialog() {
  const playlists = await api("GET", "/playlists");
  const r = await dialog("Add a screen", h("div", {},
    h("p", { class: "muted small" }, "Install the Signage Player app on the TV and open it. It shows a 6-character code. Type it here."),
    field("Pairing code", h("input", { name: "code", required: true, maxlength: 7, autocomplete: "off", style: "text-transform:uppercase;letter-spacing:.2em;font-size:1.3rem", placeholder: "ABC123" })),
    field("Screen name", h("input", { name: "name", placeholder: "e.g. Lobby TV", maxlength: 100 })),
    field("Location", h("input", { name: "location", placeholder: "e.g. Main St store", maxlength: 200 })),
    field("Playlist", h("select", { name: "playlistId" }, h("option", { value: "" }, "— none yet —"), playlists.map(p => h("option", { value: p.id }, p.name))))),
  { submit: "Pair screen", onSubmit: f => api("POST", "/screens/pair", Object.fromEntries(f)) });
  if (r) { toast("Screen paired. It will start playing within a few seconds."); location.hash = "#/screens/" + r.id; }
}

async function renderScreens(main) {
  const [screens, playlists] = await Promise.all([api("GET", "/screens"), api("GET", "/playlists")]);
  const selected = new Set();
  const countEl = h("strong", {}, "0");
  const plSel = h("select", {}, h("option", { value: "" }, "— no playlist —"), playlists.map(p => h("option", { value: p.id }, p.name)));
  const bar = h("div", { class: "bulkbar hidden" }, countEl, " selected · assign", plSel,
    h("button", { class: "primary small", onclick: async () => {
      try { await api("POST", "/screens/bulk-assign", { screenIds: [...selected], playlistId: plSel.value || null }); toast("Playlist assigned."); route(); } catch (e) { fail(e); }
    } }, "Apply"));
  const sync = () => { countEl.textContent = selected.size; bar.classList.toggle("hidden", !selected.size); };
  const all = h("input", { type: "checkbox", "aria-label": "Select all", onchange: e => {
    main.querySelectorAll("tbody input[type=checkbox]").forEach(cb => { cb.checked = e.target.checked; cb.dispatchEvent(new Event("change")); });
  } });
  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "Screens"),
      h("div", { class: "actions" }, h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen"))),
    screens.length ? h("div", { class: "card" }, bar, h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, all), h("th", {}, "Screen"), h("th", {}, "Status"), h("th", {}, "Playing"), h("th", {}, "Playlist"))),
      h("tbody", {}, screens.map(s => h("tr", { class: "click", onclick: e => { if (e.target.type !== "checkbox") location.hash = "#/screens/" + s.id; } },
        h("td", {}, h("input", { type: "checkbox", onchange: e => { e.target.checked ? selected.add(s.id) : selected.delete(s.id); sync(); } })),
        h("td", {}, h("strong", {}, s.name), h("div", { class: "small muted" }, s.location)),
        h("td", {}, statusPill(s), h("div", { class: "small muted" }, s.online ? "" : ago(s.lastSeen))),
        h("td", { class: "small" }, s.online && s.status.playing ? s.status.playing : h("span", { class: "muted" }, "—")),
        h("td", { class: "small" }, s.playlistName || h("span", { class: "pill warn" }, "None"), s.scheduleCount ? h("div", { class: "muted" }, "+ " + s.scheduleCount + " scheduled") : null))))))
      : h("div", { class: "card empty" }, h("p", {}, "No screens yet."), h("p", { class: "small" }, "Install the player app on a TV, open it, and pair it with the code it shows."),
        h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen")));
  state.timer = setInterval(async () => {
    if (location.hash !== "#/screens" || selected.size) return;
    try { const fresh = await api("GET", "/screens"); if (JSON.stringify(fresh.map(s => [s.online, s.status.playing])) !== JSON.stringify(screens.map(s => [s.online, s.status.playing]))) route(); } catch (_) {}
  }, 15000);
}

function deviceRows(s) {
  const st = s.status || {};
  return [
    ["Status", statusPill(s)], ["Last seen", ago(s.lastSeen)], ["Now playing", st.playing || "—"], ["From playlist", st.playlist || "—"],
    ["Device", s.model || "—"], ["Android", st.androidVersion || "—"], ["App version", s.appVersion || "—"], ["Resolution", st.resolution || "—"],
    ["IP address", s.ip || "—"], ["Offline cache", st.cacheBytes ? bytes(st.cacheBytes) : "—"], ["Free storage", st.freeBytes ? bytes(st.freeBytes) : "—"],
    ["Uptime", st.uptimeSec ? dur(Math.round(st.uptimeSec)) : "—"], ["Last error", st.error || "—"]
  ].flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]);
}

async function renderScreen(main, id) {
  const [s, playlists] = await Promise.all([api("GET", "/screens/" + id), api("GET", "/playlists")]);
  const plOptions = sel => [h("option", { value: "" }, "— none —"), playlists.map(p => h("option", { value: p.id, selected: p.id === sel }, p.name))];

  // settings
  const f = {
    name: h("input", { value: s.name, maxlength: 100 }),
    location: h("input", { value: s.location, maxlength: 200 }),
    playlistId: h("select", {}, plOptions(s.playlistId)),
    orientation: h("select", {}, [[0, "Landscape"], [90, "Portrait (rotated right)"], [180, "Landscape, upside down"], [270, "Portrait (rotated left)"]]
      .map(([v, l]) => h("option", { value: v, selected: v === s.orientation }, l))),
    volume: h("input", { type: "range", min: 0, max: 100, value: s.volume }),
    notes: h("textarea", { rows: 2, maxlength: 2000 }, s.notes)
  };
  const volLbl = h("span", { class: "muted" }, s.volume + "%");
  f.volume.addEventListener("input", () => (volLbl.textContent = f.volume.value + "%"));
  const saveBtn = h("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      await api("PATCH", "/screens/" + id, { name: f.name.value, location: f.location.value, playlistId: f.playlistId.value || null,
        orientation: Number(f.orientation.value), volume: Number(f.volume.value), notes: f.notes.value });
      toast("Saved. The screen updates within 30 seconds.");
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save settings");

  // schedule
  let slots = s.schedules.map(x => ({ ...x }));
  const slotsBox = h("div", {});
  function drawSlots() {
    slotsBox.replaceChildren(...slots.map((sl, i) => h("div", { class: "slot" },
      h("select", { "aria-label": "Playlist", onchange: e => (sl.playlistId = Number(e.target.value) || null) }, h("option", { value: "" }, "Pick a playlist…"),
        playlists.map(p => h("option", { value: p.id, selected: p.id === sl.playlistId }, p.name))),
      h("div", { class: "days" }, DAYS.map((d, b) => h("button", { type: "button", class: sl.days & (1 << b) ? "on" : "",
        onclick: e => { sl.days ^= 1 << b; e.target.classList.toggle("on"); } }, d))),
      h("div", { class: "times" },
        h("input", { type: "time", value: sl.start, "aria-label": "Start", onchange: e => (sl.start = e.target.value) }), "to",
        h("input", { type: "time", value: sl.end, "aria-label": "End", onchange: e => (sl.end = e.target.value) })),
      h("button", { type: "button", class: "icon danger", title: "Remove", onclick: () => { slots.splice(i, 1); drawSlots(); } }, "✕"))));
    if (!slots.length) slotsBox.append(h("p", { class: "muted small" }, "No schedule. The screen always plays its main playlist."));
  }
  drawSlots();
  const schedSave = h("button", { class: "primary", onclick: async () => {
    schedSave.disabled = true;
    try { await api("PUT", "/screens/" + id + "/schedules", slots); toast("Schedule saved."); }
    catch (e) { fail(e); } finally { schedSave.disabled = false; }
  } }, "Save schedule");

  // live view & commands
  const dl = h("dl", { class: "kv" }, deviceRows(s));
  const shotBox = h("div", {});
  const drawShot = x => shotBox.replaceChildren(x.screenshot
    ? h("div", {}, h("img", { class: "screenshot", src: x.screenshot, alt: "Screenshot of the screen" }), h("div", { class: "small muted", style: "margin-top:.35rem" }, "Taken " + ago(x.screenshotAt)))
    : h("p", { class: "muted small" }, "No screenshot yet."));
  drawShot(s);
  let lastShot = s.screenshotAt;
  const cmd = (type, label, msg) => h("button", { onclick: async () => {
    try {
      const r = await api("POST", "/screens/" + id + "/commands", { type });
      toast(r.online ? msg : "Queued. The screen is offline, so it will run when it reconnects.");
    } catch (e) { fail(e); }
  } }, label);

  main.replaceChildren(
    h("a", { href: "#/screens", class: "back" }, "← All screens"),
    h("div", { class: "page-head" }, h("div", {}, h("h1", {}, s.name), h("div", { class: "muted" }, s.location)),
      h("div", { class: "actions" }, h("button", { class: "danger", onclick: async () => {
        if (!await confirmDlg("Remove this screen?", "The TV will go back to showing a pairing code. You can pair it again later.", "Remove")) return;
        try { await api("DELETE", "/screens/" + id); toast("Screen removed."); location.hash = "#/screens"; } catch (e) { fail(e); }
      } }, "Remove screen"))),
    h("div", { class: "grid two" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", {}, "Settings"),
          field("Name", f.name), field("Location", f.location), field("Main playlist", f.playlistId),
          h("div", { class: "row" }, field("Orientation", f.orientation), h("div", { class: "field" }, h("label", {}, "Volume ", volLbl), f.volume)),
          field("Notes", f.notes), saveBtn),
        h("div", { class: "card" }, h("h2", {}, "Schedule"),
          h("p", { class: "muted small" }, "During these times the screen plays the chosen playlist instead of its main one. The first matching slot wins. A slot that ends before it starts (e.g. 22:00 to 06:00) runs overnight."),
          slotsBox,
          h("div", { class: "row" }, h("button", { onclick: () => { slots.push({ playlistId: null, days: 127, start: "09:00", end: "17:00" }); drawSlots(); } }, "+ Add time slot"), schedSave))),
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", {}, "Live view"), shotBox,
          h("div", { class: "cmds", style: "margin-top:.75rem" }, cmd("screenshot", "📷 Take screenshot", "Screenshot requested. It appears here within about 30 seconds."))),
        h("div", { class: "card" }, h("h2", {}, "Remote control"),
          h("div", { class: "cmds" },
            cmd("identify", "Show name on TV", "The screen name will flash on the TV."),
            cmd("reload", "Reload content", "The screen will reload its content."),
            cmd("clear_cache", "Clear cache & re-download", "The screen will clear its cache and download everything again."),
            cmd("restart_app", "Restart app", "The player app will restart.")),
          h("p", { class: "muted small", style: "margin-top:.75rem" }, "Commands reach the screen at its next check-in (within 30 seconds).")),
        h("div", { class: "card" }, h("h2", {}, "Device"), dl))));

  state.timer = setInterval(async () => {
    if (location.hash !== "#/screens/" + id) return;
    try {
      const x = await api("GET", "/screens/" + id);
      dl.replaceChildren(...deviceRows(x));
      if (x.screenshotAt !== lastShot) { lastShot = x.screenshotAt; drawShot(x); }
    } catch (_) {}
  }, 5000);
}

// ---------- playlists ----------
async function renderPlaylists(main) {
  const pls = await api("GET", "/playlists");
  const create = async () => {
    const r = await dialog("New playlist", field("Name", h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. Lunch menu" })),
      { submit: "Create", onSubmit: f => api("POST", "/playlists", { name: f.get("name") }) });
    if (r) location.hash = "#/playlists/" + r.id;
  };
  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "Playlists"), h("div", { class: "actions" }, h("button", { class: "primary", onclick: create }, "+ New playlist"))),
    pls.length ? h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Items"), h("th", {}, "Loop length"), h("th", {}, "Used on"), h("th", {}))),
      h("tbody", {}, pls.map(p => h("tr", { class: "click", onclick: e => { if (!e.target.closest("button")) location.hash = "#/playlists/" + p.id; } },
        h("td", {}, h("strong", {}, p.name)),
        h("td", {}, p.itemCount),
        h("td", { class: "small" }, dur(p.loopSeconds), p.videoCount ? h("span", { class: "muted" }, " + " + p.videoCount + " video" + (p.videoCount > 1 ? "s" : "")) : null),
        h("td", { class: "small" }, p.screens.length ? p.screens.map(x => x.name).join(", ") : h("span", { class: "muted" }, "—"),
          p.scheduledOn ? h("div", { class: "muted" }, "scheduled on " + p.scheduledOn) : null),
        h("td", { style: "text-align:right" },
          h("button", { class: "small", onclick: async () => { try { const r = await api("POST", "/playlists/" + p.id + "/duplicate"); toast("Duplicated."); location.hash = "#/playlists/" + r.id; } catch (e) { fail(e); } } }, "Duplicate"), " ",
          h("button", { class: "small danger", onclick: async () => {
            if (!await confirmDlg("Delete “" + p.name + "”?", "Screens using it will have no main playlist, and its schedule slots are removed. Your media files are kept.")) return;
            try { await api("DELETE", "/playlists/" + p.id); toast("Deleted."); route(); } catch (e) { fail(e); }
          } }, "Delete")))))))
      : h("div", { class: "card empty" }, h("p", {}, "No playlists yet. A playlist is a list of images, videos and web pages that loops on a screen."),
        h("button", { class: "primary", onclick: create }, "+ New playlist")));
}

async function renderPlaylist(main, id) {
  const [pl, media] = await Promise.all([api("GET", "/playlists/" + id), api("GET", "/media")]);
  let items = pl.items.map(i => ({ ...i }));
  let dirty = false;
  const nameIn = h("input", { value: pl.name, maxlength: 100, style: "font-size:1.2rem;font-weight:700;max-width:420px", oninput: () => mark() });
  const totalEl = h("span", { class: "muted" });
  const saveBtn = h("button", { class: "primary", onclick: save }, "Save");
  const list = h("ul", { class: "pl-items" });
  function mark() { dirty = true; saveBtn.textContent = "Save changes"; }
  function total() {
    const secs = items.filter(i => i.kind !== "video").reduce((a, i) => a + (Number(i.duration) || 0), 0);
    const v = items.filter(i => i.kind === "video").length;
    totalEl.textContent = items.length + " items · loop " + dur(secs) + (v ? " + " + v + " video" + (v > 1 ? "s" : "") + " (full length)" : "");
  }
  let dragFrom = null;
  function draw() {
    list.replaceChildren(...items.map((it, i) => {
      const li = h("li", { class: "pl-item", draggable: true },
        h("span", { class: "handle", title: "Drag to reorder" }, "⠿"),
        thumb(it, "mini"),
        h("div", { class: "info" }, h("div", { class: "name" }, it.name), h("div", { class: "small muted" }, it.kind === "web" ? "Web page" : it.kind === "video" ? "Video" : "Image")),
        it.kind === "video" ? h("div", { class: "dur" }, "full length")
          : h("div", { class: "dur" }, h("input", { type: "number", min: 1, max: 86400, value: it.duration, "aria-label": "Seconds",
            oninput: e => { it.duration = Number(e.target.value); mark(); total(); } }), "sec"),
        h("button", { class: "icon small", title: "Move up", disabled: i === 0, onclick: () => { [items[i - 1], items[i]] = [items[i], items[i - 1]]; mark(); draw(); } }, "↑"),
        h("button", { class: "icon small", title: "Move down", disabled: i === items.length - 1, onclick: () => { [items[i + 1], items[i]] = [items[i], items[i + 1]]; mark(); draw(); } }, "↓"),
        h("button", { class: "icon small danger", title: "Remove", onclick: () => { items.splice(i, 1); mark(); draw(); } }, "✕"));
      li.addEventListener("dragstart", e => { dragFrom = i; li.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
      li.addEventListener("dragend", () => li.classList.remove("dragging"));
      li.addEventListener("dragover", e => { e.preventDefault(); li.classList.add("drop-before"); });
      li.addEventListener("dragleave", () => li.classList.remove("drop-before"));
      li.addEventListener("drop", e => {
        e.preventDefault(); li.classList.remove("drop-before");
        if (dragFrom == null || dragFrom === i) return;
        const [m] = items.splice(dragFrom, 1);
        items.splice(dragFrom < i ? i - 1 : i, 0, m);
        dragFrom = null; mark(); draw();
      });
      return li;
    }));
    if (!items.length) list.append(h("li", { class: "empty" }, "This playlist is empty. Add media from the right."));
    total();
  }
  async function save() {
    saveBtn.disabled = true;
    try {
      await api("PUT", "/playlists/" + id, { name: nameIn.value, items: items.map(i => ({ mediaId: i.mediaId, duration: i.duration })) });
      dirty = false; saveBtn.textContent = "Saved"; toast("Playlist saved. Screens update within 30 seconds.");
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  }
  const search = h("input", { type: "search", placeholder: "Search media…" });
  const picker = h("div", { class: "picker" });
  const drawPicker = () => {
    const q = search.value.toLowerCase();
    const list2 = media.filter(m => m.name.toLowerCase().includes(q));
    picker.replaceChildren(...list2.map(m => h("div", { class: "pick", title: "Add to playlist", onclick: () => {
      items.push({ mediaId: m.id, name: m.name, kind: m.kind, src: m.src, duration: m.kind === "web" ? 30 : 10 }); mark(); draw();
      list.lastElementChild.scrollIntoView({ block: "nearest" });
    } }, thumb(m, "mini"), h("div", { class: "info", style: "flex:1;min-width:0" }, h("div", { class: "small", style: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, m.name),
      h("div", { class: "small muted" }, m.kind)), h("span", { class: "btn small" }, "+ Add"))));
    if (!media.length) picker.append(h("p", { class: "muted small" }, "No media yet. ", h("a", { href: "#/media" }, "Upload some"), "."));
  };
  search.addEventListener("input", drawPicker);
  main.replaceChildren(
    h("a", { href: "#/playlists", class: "back", onclick: e => { if (dirty && !confirm("Leave without saving your changes?")) e.preventDefault(); } }, "← All playlists"),
    h("div", { class: "page-head" }, nameIn, h("div", { class: "actions" }, saveBtn)),
    h("div", { class: "grid", style: "grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items:start" },
      h("div", { class: "card", style: "grid-column: span 2; min-width:0" }, h("div", { style: "margin-bottom:.75rem" }, totalEl), list),
      h("div", { class: "card" }, h("h2", {}, "Add media"), h("div", { class: "field" }, search), picker)));
  // On narrow screens the 2-column span would overflow.
  if (window.innerWidth < 760) main.querySelector(".card").style.gridColumn = "auto";
  draw(); drawPicker();
  window.onbeforeunload = () => (dirty ? true : undefined);
}

// ---------- media ----------
async function renderMedia(main) {
  const media = await api("GET", "/media");
  const input = h("input", { type: "file", multiple: true, accept: "image/*,video/*", class: "hidden", onchange: e => upload([...e.target.files]) });
  const bar = h("div", {});
  const zone = h("div", { class: "dropzone" }, h("div", {}, "Drag images or videos here, or "),
    h("button", { class: "small", onclick: () => input.click(), style: "margin-top:.5rem" }, "Choose files"),
    h("div", { class: "small", style: "margin-top:.5rem" }, "JPG, PNG, GIF, WebP · MP4, WebM, MOV · up to 2 GB each"), bar, input);
  zone.addEventListener("dragover", e => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", e => { e.preventDefault(); zone.classList.remove("over"); upload([...e.dataTransfer.files]); });

  function upload(files) {
    if (!files.length) return;
    const fd = new FormData();
    files.forEach(f => fd.append("files", f));
    const prog = h("div", {}); const label = h("div", { class: "small" }, "Uploading " + files.length + " file(s)…");
    bar.replaceChildren(label, h("div", { class: "progress" }, prog));
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media");
    xhr.upload.onprogress = e => { if (e.lengthComputable) { const p = Math.round(e.loaded / e.total * 100); prog.style.width = p + "%"; label.textContent = "Uploading… " + p + "%"; } };
    xhr.onload = () => {
      let d = null; try { d = JSON.parse(xhr.responseText); } catch (_) {}
      if (xhr.status === 201) { toast("Uploaded " + d.length + " file(s)."); route(); }
      else { bar.replaceChildren(); fail(new Error((d && d.error) || "Upload failed.")); }
    };
    xhr.onerror = () => { bar.replaceChildren(); fail(new Error("Upload failed: network error.")); };
    xhr.send(fd);
  }
  const addWeb = async () => {
    const r = await dialog("Add a web page", h("div", {},
      h("p", { class: "muted small" }, "Shows a live web page on the screen, for example a menu board, dashboard or news feed. The page must allow being shown full-screen."),
      field("Web address", h("input", { name: "url", type: "url", required: true, placeholder: "https://" })),
      field("Name", h("input", { name: "name", maxlength: 200, placeholder: "optional" }))),
    { submit: "Add", onSubmit: f => api("POST", "/media/web", Object.fromEntries(f)) });
    if (r) { toast("Web page added."); route(); }
  };
  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "Media"), h("div", { class: "actions" }, h("button", { onclick: addWeb }, "+ Web page"), h("button", { class: "primary", onclick: () => input.click() }, "Upload"))),
    zone,
    media.length ? h("div", { class: "media-grid" }, media.map(m => h("div", { class: "media-card" },
      h("a", { href: m.src, target: "_blank", rel: "noopener" }, thumb(m)),
      h("div", { class: "meta" }, h("div", { class: "name", title: m.name }, m.name),
        h("div", { class: "small muted" }, m.kind === "web" ? new URL(m.src).hostname : m.kind + " · " + bytes(m.size)),
        h("div", { class: "small muted" }, m.usedIn.length ? "In " + m.usedIn.map(p => p.name).join(", ") : "Not in a playlist")),
      h("div", { class: "acts" },
        h("button", { class: "small", onclick: async () => {
          const r = await dialog("Rename", field("Name", h("input", { name: "name", value: m.name, required: true, maxlength: 200 })),
            { onSubmit: f => api("PATCH", "/media/" + m.id, { name: f.get("name") }) });
          if (r) route();
        } }, "Rename"),
        h("button", { class: "small danger", onclick: async () => {
          const warn = m.usedIn.length ? " It will be removed from: " + m.usedIn.map(p => p.name).join(", ") + "." : "";
          if (!await confirmDlg("Delete “" + m.name + "”?", "This can't be undone." + warn)) return;
          try { await api("DELETE", "/media/" + m.id); toast("Deleted."); route(); } catch (e) { fail(e); }
        } }, "Delete")))))
      : h("div", { class: "card empty" }, "No media yet. Upload images and videos to use in playlists."));
}

// ---------- settings ----------
async function renderSettings(main) {
  const isAdmin = state.user.role === "admin";
  const [apk, users] = await Promise.all([api("GET", "/apk"), isAdmin ? api("GET", "/users") : Promise.resolve([])]);
  const portalUrl = location.origin;

  const pw = { current: h("input", { type: "password", autocomplete: "current-password" }), next: h("input", { type: "password", autocomplete: "new-password", minlength: 8 }) };
  const pwBtn = h("button", { class: "primary", onclick: async () => {
    try { await api("POST", "/auth/password", { current: pw.current.value, next: pw.next.value }); pw.current.value = pw.next.value = ""; toast("Password changed."); } catch (e) { fail(e); }
  } }, "Change password");

  const userDlg = u => dialog(u ? "Edit user" : "Add user", h("div", {},
    u ? h("p", { class: "muted" }, u.email) : field("Email", h("input", { name: "email", type: "email", required: true })),
    field("Name", h("input", { name: "name", value: u ? u.name : "", maxlength: 100 })),
    field("Role", h("select", { name: "role" }, h("option", { value: "editor", selected: u && u.role === "editor" }, "Editor: screens, playlists, media"),
      h("option", { value: "admin", selected: u && u.role === "admin" }, "Admin: everything, including users"))),
    field(u ? "New password (leave empty to keep)" : "Password", h("input", { name: "password", type: "password", minlength: 8, required: !u, autocomplete: "new-password" }))),
  { onSubmit: f => { const b = Object.fromEntries(f); if (u && !b.password) delete b.password; return u ? api("PATCH", "/users/" + u.id, b) : api("POST", "/users", b); } });

  main.replaceChildren(
    h("div", { class: "page-head" }, h("h1", {}, "Settings"), h("div", { class: "actions" },
      h("button", { onclick: async () => { await api("POST", "/auth/logout"); state.user = null; location.hash = "#/"; renderLogin(); } }, "Log out"))),
    h("div", { class: "grid two" },
      h("div", { class: "card" }, h("h2", {}, "Player app (Android)"),
        apk.available
          ? h("div", {}, h("p", {}, h("a", { class: "btn primary", href: apk.url }, "⬇ Download player app"), " ", h("span", { class: "small muted" }, apk.file + " · " + bytes(apk.size))),
            h("p", { class: "small muted" }, "On the TV or Android box, open this address in a browser to download it: ", h("span", { class: "mono" }, portalUrl + apk.url)))
          : h("p", { class: "muted" }, "No player app uploaded yet."),
        isAdmin ? h("div", { style: "margin-top:.5rem" },
          h("input", { type: "file", accept: ".apk", class: "hidden", id: "apkFile", onchange: async e => {
            const file = e.target.files[0]; if (!file) return;
            const fd = new FormData(); fd.append("file", file);
            toast("Uploading " + file.name + "…");
            try {
              const res = await fetch("/api/apk", { method: "POST", body: fd });
              const d = await res.json().catch(() => ({}));
              if (!res.ok) throw new Error(d.error || "Upload failed.");
              toast("Player app uploaded."); route();
            } catch (ex) { fail(ex); }
          } }),
          h("button", { class: "small", onclick: () => $("#apkFile").click() }, apk.available ? "Upload a newer version" : "Upload player app (.apk)")) : null,
        h("h3", { style: "margin-top:1rem" }, "Setting up a TV"),
        h("ol", { class: "small", style: "padding-left:1.2rem;margin:0" },
          h("li", {}, "Install the app (allow installing from unknown sources if asked)."),
          h("li", {}, "Open it and enter this portal's address: ", h("span", { class: "mono" }, portalUrl)),
          h("li", {}, "The TV shows a 6-character code. Go to Screens → Add screen and type it in."))),
      h("div", { class: "card" }, h("h2", {}, "My login"), h("p", { class: "muted small" }, state.user.email + " · " + state.user.role),
        field("Current password", pw.current), field("New password (8+ characters)", pw.next), pwBtn),
      isAdmin ? h("div", { class: "card", style: "grid-column: 1 / -1" },
        h("div", { class: "page-head", style: "margin-bottom:.5rem" }, h("h2", { style: "margin:0" }, "Users"),
          h("button", { class: "small", onclick: async () => { if (await userDlg()) { toast("User added."); route(); } } }, "+ Add user")),
        h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, users.map(u => h("tr", {},
          h("td", {}, h("strong", {}, u.name || u.email), h("div", { class: "small muted" }, u.email)),
          h("td", {}, h("span", { class: "pill" + (u.role === "admin" ? " ok" : "") }, u.role)),
          h("td", { style: "text-align:right" },
            h("button", { class: "small", onclick: async () => { if (await userDlg(u)) { toast("Saved."); route(); } } }, "Edit"), " ",
            u.id === state.user.id ? null : h("button", { class: "small danger", onclick: async () => {
              if (!await confirmDlg("Delete " + u.email + "?", "They will no longer be able to log in.")) return;
              try { await api("DELETE", "/users/" + u.id); toast("Deleted."); route(); } catch (e) { fail(e); }
            } }, "Delete")))))))) : null));
}

// ---------- start ----------
(async () => {
  try { state.user = (await api("GET", "/auth/me")).user; } catch (_) { state.user = null; }
  route();
})();
