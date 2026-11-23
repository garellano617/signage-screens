"use strict";
/* Signage Portal: single-page app, hash routing, no build step.
 *
 * Your team:      #/ (overview of all clients), #/clients, #/settings
 *                 #/c/<clientId>/...   inside one client: overview, screens, playlists, media, logins
 * A client login: #/ , #/screens, #/playlists, #/media, #/logins, #/settings (always their own client)
 */

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

async function api(method, url, body, headers) {
  const opt = { method, headers: Object.assign(scopeHeaders(), headers || {}) };
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

// ---------- state ----------
const state = { user: null, timer: null, customers: [], cid: null };
const isStaff = () => !!(state.user && state.user.isStaff);
const isAdmin = () => !!(state.user && state.user.role === "admin");
/** The client whose pages are open: from the address for your team, always their own for a client login. */
function scopeHeaders() { return isStaff() && state.cid ? { "X-Customer-Id": String(state.cid) } : {}; }
/** Start of links inside the open client. */
const base = () => isStaff() ? "#/c/" + state.cid : "#";
const go = path => { location.hash = base() + path; };
const currentClient = () => state.customers.find(c => c.id === state.cid) || null;
const clientName = () => isStaff() ? (currentClient() || {}).name || "Client" : state.user.customerName;

async function loadCustomers() {
  state.customers = isStaff() ? await api("GET", "/customers", undefined, { "X-Customer-Id": "" }) : [];
}

// ---------- navigation ----------
const ICONS = {
  dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  screens: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  playlists: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h13M3 12h13M3 18h9"/><path d="M17 15l5 3-5 3z" fill="currentColor"/></svg>',
  media: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  clients: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 21h18"/></svg>',
  logins: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M1 21v-1a7 7 0 0 1 14 0v1"/><path d="M17 11h6M20 8v6"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};
const LOGO = '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2" fill="#2563eb"/><path d="M10 8l5 2.5-5 2.5z" fill="#fff"/><rect x="8" y="19" width="8" height="2" rx="1" fill="#2563eb"/></svg>';

// Pages inside one client (same for your team inside a client and for a client's own login).
const clientRoutes = [
  [/^\/?$/, "dashboard", renderDashboard],
  [/^\/screens$/, "screens", renderScreens],
  [/^\/screens\/(\d+)$/, "screens", renderScreen],
  [/^\/playlists$/, "playlists", renderPlaylists],
  [/^\/playlists\/(\d+)$/, "playlists", renderPlaylist],
  [/^\/media$/, "media", renderMedia],
  [/^\/logins$/, "logins", renderLogins]
];
// Your team's main level.
const staffRoutes = [
  [/^\/?$/, "dashboard", renderOverview],
  [/^\/clients$/, "clients", renderClients],
  [/^\/settings$/, "settings", renderSettings]
];

function shell(section, inClient) {
  const link = (href, key, label) => h("a", { href, class: section === key ? "active" : "", html: ICONS[key] + "<span>" + label + "</span>" });
  let links;
  if (inClient) {
    const c = isStaff() ? currentClient() : null;
    links = [
      isStaff() ? link("#/clients", "back", "All clients") : null,
      h("div", { class: "client-head" }, h("div", { class: "client-label" }, isStaff() ? "Client" : "Account"), h("div", { class: "client-title" }, clientName()),
        c && !c.active ? h("span", { class: "pill warn" }, "Paused") : null),
      link(base() + "/", "dashboard", "Overview"), link(base() + "/screens", "screens", "Screens"),
      link(base() + "/playlists", "playlists", "Playlists"), link(base() + "/media", "media", "Media"),
      isAdmin() ? link(base() + "/logins", "logins", "Logins") : null,
      isStaff() ? null : link("#/settings", "settings", "Settings")
    ];
  } else {
    links = [link("#/", "dashboard", "Dashboard"), link("#/clients", "clients", "Clients"), link("#/settings", "settings", "Settings")];
  }
  const nav = h("nav", { class: "nav" + (inClient && isStaff() ? " in-client" : "") },
    h("div", { class: "brand", html: LOGO + "<span>Signage</span>" }), links,
    h("div", { class: "spacer" }), h("div", { class: "who" }, state.user.email));
  const main = h("main", {});
  app().replaceChildren(h("div", { class: "layout" }, nav, main));
  return main;
}

async function route() {
  clearInterval(state.timer); state.timer = null;
  window.onbeforeunload = null;
  if (!state.user) return renderLogin();
  let path = location.hash.replace(/^#/, "") || "/";
  let table, inClient = false;
  if (isStaff()) {
    const m = path.match(/^\/c\/(\d+)(\/.*)?$/);
    if (m) {
      state.cid = Number(m[1]);
      if (!currentClient()) await loadCustomers().catch(() => {});
      if (!currentClient()) { location.hash = "#/clients"; return; }
      path = m[2] || "/"; table = clientRoutes; inClient = true;
    } else { state.cid = null; table = staffRoutes; }
  } else {
    state.cid = state.user.customerId;
    if (path === "/settings") { table = [[/^\/settings$/, "settings", renderSettings]]; }
    else { table = clientRoutes; inClient = true; }
  }
  for (const [re, section, fn] of table) {
    const m = path.match(re);
    if (m) {
      const main = shell(section, inClient);
      main.append(h("div", { class: "muted" }, "Loading…"));
      try { await fn(main, ...m.slice(1)); } catch (e) { if (state.user) main.replaceChildren(h("div", { class: "card" }, "Couldn't load this page: " + e.message)); }
      return;
    }
  }
  location.hash = inClient ? base() + "/" : "#/";
}
window.addEventListener("hashchange", route);

/** Re-runs fn every ms while the same page stays open. */
function poll(fn, ms) {
  clearInterval(state.timer);
  const here = location.hash;
  state.timer = setInterval(() => { if (location.hash === here) fn(); }, ms);
}

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
      state.user = r.user; await loadCustomers(); route();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  app().replaceChildren(h("div", { class: "login-wrap" }, form));
  form.querySelector("input").focus();
}

const stat = (num, lbl, href) => h(href ? "a" : "div", { class: "card stat" + (href ? " link" : ""), href }, h("div", { class: "num" }, num), h("div", { class: "lbl" }, lbl));
const pageHead = (title, sub, ...actions) => h("div", { class: "page-head" },
  h("div", {}, h("h1", {}, title), sub ? h("div", { class: "muted small" }, sub) : null),
  actions.length ? h("div", { class: "actions" }, actions) : null);

// ---------- your team: overview of all clients ----------
async function renderOverview(main) {
  const [d] = await Promise.all([api("GET", "/dashboard"), loadCustomers()]);
  const clients = state.customers;
  main.replaceChildren(
    pageHead("Dashboard", "All clients", isAdmin() ? h("button", { class: "primary", onclick: () => clientDialog() }, "+ New client") : null),
    h("div", { class: "grid stats" },
      stat(clients.length, "Clients", "#/clients"), stat(d.screens, "Screens"), stat(d.online, "Online now"), stat(d.offline.length, "Offline")),
    h("div", { class: "grid two", style: "margin-top:1rem" },
      h("div", { class: "card" }, h("h2", {}, "Clients"),
        clients.length ? h("table", {}, h("tbody", {}, clients.map(c => h("tr", { class: "click", onclick: () => (location.hash = "#/c/" + c.id) },
          h("td", {}, h("strong", {}, c.name), " ", c.active ? null : h("span", { class: "pill warn" }, "Paused")),
          h("td", { class: "small muted", style: "text-align:right" }, c.screens ? `${c.online} of ${c.screens} screens online` : "No screens yet")))))
          : h("p", { class: "muted" }, "No clients yet. Add the businesses you put screens in.")),
      h("div", { class: "card" }, h("h2", {}, "Offline screens"),
        d.offline.length ? h("table", {}, h("tbody", {}, d.offline.map(s => h("tr", { class: "click", onclick: () => (location.hash = `#/c/${s.customerId}/screens/${s.id}`) },
          h("td", {}, h("strong", {}, s.name), h("div", { class: "small muted" }, [s.customerName, s.location].filter(Boolean).join(" · "))),
          h("td", { class: "small muted", style: "text-align:right" }, "Last seen " + ago(s.lastSeen))))))
          : h("p", { class: "muted" }, d.screens ? "All screens are online. 👍" : "No screens yet. Open a client to add one."))));
  poll(() => renderOverview(main).catch(() => {}), 15000);
}

// ---------- your team: clients ----------
async function clientDialog(c) {
  const r = await dialog(c ? "Edit " + c.name : "New client", h("div", {},
    field("Business name", h("input", { name: "name", required: true, maxlength: 120, value: c ? c.name : "", placeholder: "e.g. Wendy's Tacos" })),
    h("div", { class: "row" },
      field("Contact person", h("input", { name: "contactName", maxlength: 120, value: c ? c.contactName : "" })),
      field("Phone", h("input", { name: "phone", type: "tel", maxlength: 40, value: c ? c.phone : "" }))),
    field("Email", h("input", { name: "email", type: "email", maxlength: 200, value: c ? c.email : "" })),
    field("Screen limit (empty = no limit)", h("input", { name: "screenLimit", type: "number", min: 0, max: 10000, value: c && c.screenLimit !== null ? c.screenLimit : "" })),
    c ? h("label", { style: "display:flex;gap:.5rem;align-items:center;font-weight:400;margin-bottom:.9rem" },
      h("input", { type: "checkbox", name: "active", checked: c.active }), "Active (unticked = paused: their logins stop working, TVs keep playing)") : null,
    field("Notes", h("textarea", { name: "notes", rows: 2, maxlength: 2000 }, c ? c.notes : ""))),
  { submit: c ? "Save" : "Add client", onSubmit: f => {
    const b = Object.fromEntries(f);
    if (c) b.active = f.get("active") === "on";
    return c ? api("PATCH", "/customers/" + c.id, b, { "X-Customer-Id": "" }) : api("POST", "/customers", b, { "X-Customer-Id": "" });
  } });
  if (!r) return;
  await loadCustomers();
  if (c) { toast("Saved."); route(); }
  else { toast("Client added. Now add their screens, playlists and media."); location.hash = "#/c/" + r.id; }
}

async function deleteClient(c) {
  if (c.screens) return fail(new Error(`Remove ${c.name}'s ${c.screens} screen(s) first (open the client, then Screens).`));
  if (!await confirmDlg("Delete " + c.name + "?", "This permanently deletes their playlists, media and logins.")) return;
  try {
    await api("DELETE", "/customers/" + c.id, undefined, { "X-Customer-Id": "" });
    await loadCustomers(); toast("Client deleted."); location.hash = "#/clients"; route();
  } catch (e) { fail(e); }
}

async function renderClients(main) {
  await loadCustomers();
  const list = state.customers;
  main.replaceChildren(
    pageHead("Clients", "Each client has their own screens, playlists, media and logins. Open a client to manage them.",
      isAdmin() ? h("button", { class: "primary", onclick: () => clientDialog() }, "+ New client") : null),
    list.length ? h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Client"), h("th", {}, "Screens"), h("th", {}, "Logins"), h("th", {}, "Storage"), h("th", {}))),
      h("tbody", {}, list.map(c => h("tr", { class: "click", onclick: e => { if (!e.target.closest("button")) location.hash = "#/c/" + c.id; } },
        h("td", {}, h("strong", {}, c.name), " ", c.active ? null : h("span", { class: "pill warn" }, "Paused"),
          h("div", { class: "small muted" }, [c.contactName, c.phone, c.email].filter(Boolean).join(" · "))),
        h("td", { class: "small" }, c.screens + (c.screenLimit !== null ? " of " + c.screenLimit : ""),
          c.screens ? h("div", { class: "muted" }, c.online + " online") : null),
        h("td", { class: "small" }, c.users),
        h("td", { class: "small" }, bytes(c.mediaBytes)),
        h("td", { style: "text-align:right;white-space:nowrap" },
          h("button", { class: "small primary", onclick: () => (location.hash = "#/c/" + c.id) }, "Open"), " ",
          isAdmin() ? h("button", { class: "small", onclick: () => clientDialog(c) }, "Edit") : null, " ",
          isAdmin() ? h("button", { class: "small danger", onclick: () => deleteClient(c) }, "Delete") : null))))))
      : h("div", { class: "card empty" }, h("p", {}, "No clients yet. Add the businesses you put screens in."),
        isAdmin() ? h("button", { class: "primary", onclick: () => clientDialog() }, "+ New client") : null));
}

// ---------- inside a client: overview ----------
async function renderDashboard(main) {
  const d = await api("GET", "/dashboard");
  const c = isStaff() ? currentClient() : null;
  const list = (title, items, empty, extra) => h("div", { class: "card" }, h("h2", {}, title),
    items.length ? h("table", {}, h("tbody", {}, items.map(s => h("tr", { class: "click", onclick: () => go("/screens/" + s.id) },
      h("td", {}, h("strong", {}, s.name), h("div", { class: "small muted" }, s.location || "")), h("td", { class: "small muted" }, extra(s))))))
      : h("p", { class: "muted" }, empty));
  main.replaceChildren(
    pageHead(clientName(), c ? [c.contactName, c.phone, c.email].filter(Boolean).join(" · ") || "Overview" : "Overview",
      c && isAdmin() ? h("button", { onclick: () => clientDialog(c) }, "Edit details") : null,
      h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen")),
    h("div", { class: "grid stats" },
      stat(d.screens + (c && c.screenLimit !== null ? " / " + c.screenLimit : ""), "Screens", base() + "/screens"),
      stat(d.online, "Online now"), stat(d.offline.length, "Offline"),
      stat(d.playlists, "Playlists", base() + "/playlists"), stat(d.media, "Media files · " + bytes(d.mediaBytes), base() + "/media")),
    h("div", { class: "grid two", style: "margin-top:1rem" },
      list("Offline screens", d.offline, d.screens ? "All screens are online. 👍" : "No screens yet. Click “Add screen” to pair a TV.", s => "Last seen " + ago(s.lastSeen)),
      list("Screens with nothing to play", d.noContent, "Every screen has a playlist.", () => "No playlist")),
    c && isAdmin() ? h("div", { style: "margin-top:2rem;text-align:right" },
      h("button", { class: "small danger", onclick: () => deleteClient(c) }, "Delete this client")) : null);
  poll(() => renderDashboard(main).catch(() => {}), 15000);
}

// ---------- inside a client: screens ----------
function playlistOptions(playlists, selected, emptyLabel) {
  return [h("option", { value: "" }, emptyLabel), playlists.map(p => h("option", { value: p.id, selected: p.id === selected }, p.name))];
}

async function pairDialog() {
  const playlists = await api("GET", "/playlists");
  const r = await dialog("Add a screen for " + clientName(), h("div", {},
    h("p", { class: "muted small" }, "Install the Signage Player app on the TV and open it. It shows a 6-character code. Type it here."),
    field("Pairing code", h("input", { name: "code", required: true, maxlength: 7, autocomplete: "off", style: "text-transform:uppercase;letter-spacing:.2em;font-size:1.3rem", placeholder: "ABC123" })),
    field("Screen name", h("input", { name: "name", placeholder: "e.g. Lobby TV", maxlength: 100 })),
    field("Location", h("input", { name: "location", placeholder: "e.g. Main St store", maxlength: 200 })),
    field("Playlist", h("select", { name: "playlistId" }, playlistOptions(playlists, null, "— none yet —")))),
  { submit: "Pair screen", onSubmit: f => api("POST", "/screens/pair", Object.fromEntries(f)) });
  if (r) { loadCustomers().catch(() => {}); toast("Screen paired. It will start playing within a few seconds."); go("/screens/" + r.id); }
}

async function renderScreens(main) {
  const [screens, playlists] = await Promise.all([api("GET", "/screens"), api("GET", "/playlists")]);
  const selected = new Set();
  const countEl = h("strong", {}, "0");
  const plSel = h("select", {}, playlistOptions(playlists, null, "— no playlist —"));
  const bar = h("div", { class: "bulkbar hidden" }, countEl, " selected · assign", plSel,
    h("button", { class: "primary small", onclick: async () => {
      try { await api("POST", "/screens/bulk-assign", { screenIds: [...selected], playlistId: plSel.value || null }); toast("Playlist assigned."); route(); } catch (e) { fail(e); }
    } }, "Apply"));
  const sync = () => { countEl.textContent = selected.size; bar.classList.toggle("hidden", !selected.size); };
  const all = h("input", { type: "checkbox", "aria-label": "Select all", onchange: e => {
    main.querySelectorAll("tbody input[type=checkbox]").forEach(cb => { cb.checked = e.target.checked; cb.dispatchEvent(new Event("change")); });
  } });
  main.replaceChildren(
    pageHead("Screens", clientName(), h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen")),
    screens.length ? h("div", { class: "card" }, bar, h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, all), h("th", {}, "Screen"), h("th", {}, "Status"), h("th", {}, "Playing"), h("th", {}, "Playlist"))),
      h("tbody", {}, screens.map(s => h("tr", { class: "click", onclick: e => { if (e.target.type !== "checkbox") go("/screens/" + s.id); } },
        h("td", {}, h("input", { type: "checkbox", onchange: e => { e.target.checked ? selected.add(s.id) : selected.delete(s.id); sync(); } })),
        h("td", {}, h("strong", {}, s.name), h("div", { class: "small muted" }, s.location)),
        h("td", {}, statusPill(s), h("div", { class: "small muted" }, s.online ? "" : ago(s.lastSeen))),
        h("td", { class: "small" }, s.online && s.status.playing ? s.status.playing : h("span", { class: "muted" }, "—")),
        h("td", { class: "small" }, s.playlistName || h("span", { class: "pill warn" }, "None"), s.scheduleCount ? h("div", { class: "muted" }, "+ " + s.scheduleCount + " scheduled") : null)))))))
      : h("div", { class: "card empty" }, h("p", {}, "No screens yet."), h("p", { class: "small" }, "Install the player app on a TV, open it, and pair it with the code it shows."),
        h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen")));
  poll(async () => {
    if (selected.size) return;
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

  // settings
  const f = {
    name: h("input", { value: s.name, maxlength: 100 }),
    location: h("input", { value: s.location, maxlength: 200 }),
    playlistId: h("select", {}, playlistOptions(playlists, s.playlistId, "— none —")),
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
  const slots = s.schedules.map(x => ({ ...x }));
  const slotsBox = h("div", {});
  function drawSlots() {
    slotsBox.replaceChildren(...slots.map((sl, i) => h("div", { class: "slot" },
      h("select", { "aria-label": "Playlist", onchange: e => (sl.playlistId = Number(e.target.value) || null) }, playlistOptions(playlists, sl.playlistId, "Pick a playlist…")),
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
    h("a", { href: base() + "/screens", class: "back" }, "← All screens"),
    pageHead(s.name, [clientName(), s.location].filter(Boolean).join(" · "),
      h("button", { class: "danger", onclick: async () => {
        if (!await confirmDlg("Remove this screen?", "The TV will go back to showing a pairing code. You can pair it again later.", "Remove")) return;
        try { await api("DELETE", "/screens/" + id); toast("Screen removed."); go("/screens"); } catch (e) { fail(e); }
      } }, "Remove screen")),
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

  poll(async () => {
    try {
      const x = await api("GET", "/screens/" + id);
      dl.replaceChildren(...deviceRows(x));
      if (x.screenshotAt !== lastShot) { lastShot = x.screenshotAt; drawShot(x); }
    } catch (_) {}
  }, 5000);
}

// ---------- inside a client: playlists ----------
async function renderPlaylists(main) {
  const pls = await api("GET", "/playlists");
  const create = async () => {
    const r = await dialog("New playlist", field("Name", h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. Lunch menu" })),
      { submit: "Create", onSubmit: f => api("POST", "/playlists", Object.fromEntries(f)) });
    if (r) go("/playlists/" + r.id);
  };
  main.replaceChildren(
    pageHead("Playlists", clientName(), h("button", { class: "primary", onclick: create }, "+ New playlist")),
    pls.length ? h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Name"), h("th", {}, "Items"), h("th", {}, "Loop length"), h("th", {}, "Used on"), h("th", {}))),
      h("tbody", {}, pls.map(p => h("tr", { class: "click", onclick: e => { if (!e.target.closest("button")) go("/playlists/" + p.id); } },
        h("td", {}, h("strong", {}, p.name)),
        h("td", {}, p.itemCount),
        h("td", { class: "small" }, dur(p.loopSeconds), p.videoCount ? h("span", { class: "muted" }, " + " + p.videoCount + " video" + (p.videoCount > 1 ? "s" : "")) : null),
        h("td", { class: "small" }, p.screens.length ? p.screens.map(x => x.name).join(", ") : h("span", { class: "muted" }, "—"),
          p.scheduledOn ? h("div", { class: "muted" }, "scheduled on " + p.scheduledOn) : null),
        h("td", { style: "text-align:right" },
          h("button", { class: "small", onclick: async () => { try { const r = await api("POST", "/playlists/" + p.id + "/duplicate"); toast("Duplicated."); go("/playlists/" + r.id); } catch (e) { fail(e); } } }, "Duplicate"), " ",
          h("button", { class: "small danger", onclick: async () => {
            if (!await confirmDlg("Delete “" + p.name + "”?", "Screens using it will have no main playlist, and its schedule slots are removed. Media files are kept.")) return;
            try { await api("DELETE", "/playlists/" + p.id); toast("Deleted."); route(); } catch (e) { fail(e); }
          } }, "Delete")))))))
      : h("div", { class: "card empty" }, h("p", {}, "No playlists yet. A playlist is a list of images, videos and web pages that loops on a screen."),
        h("button", { class: "primary", onclick: create }, "+ New playlist")));
}

async function renderPlaylist(main, id) {
  const [pl, media] = await Promise.all([api("GET", "/playlists/" + id), api("GET", "/media")]);
  const items = pl.items.map(i => ({ ...i }));
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
    picker.replaceChildren(...media.filter(m => m.name.toLowerCase().includes(q)).map(m => h("div", { class: "pick", title: "Add to playlist", onclick: () => {
      items.push({ mediaId: m.id, name: m.name, kind: m.kind, src: m.src, duration: m.kind === "web" ? 30 : 10 }); mark(); draw();
      list.lastElementChild.scrollIntoView({ block: "nearest" });
    } }, thumb(m, "mini"), h("div", { class: "info", style: "flex:1;min-width:0" }, h("div", { class: "small", style: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, m.name),
      h("div", { class: "small muted" }, m.kind)), h("span", { class: "btn small" }, "+ Add"))));
    if (!media.length) picker.append(h("p", { class: "muted small" }, "No media yet. ", h("a", { href: base() + "/media" }, "Upload some"), "."));
  };
  search.addEventListener("input", drawPicker);
  main.replaceChildren(
    h("a", { href: base() + "/playlists", class: "back", onclick: e => { if (dirty && !confirm("Leave without saving your changes?")) e.preventDefault(); } }, "← All playlists"),
    h("div", { class: "page-head" }, h("div", {}, nameIn, h("div", { class: "muted small", style: "margin-top:.25rem" }, clientName())), h("div", { class: "actions" }, saveBtn)),
    h("div", { class: "grid", style: "grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items:start" },
      h("div", { class: "card", style: "grid-column: span 2; min-width:0" }, h("div", { style: "margin-bottom:.75rem" }, totalEl), list),
      h("div", { class: "card" }, h("h2", {}, "Add media"), h("div", { class: "field" }, search), picker)));
  // On narrow screens the 2-column span would overflow.
  if (window.innerWidth < 760) main.querySelector(".card").style.gridColumn = "auto";
  draw(); drawPicker();
  window.onbeforeunload = () => (dirty ? true : undefined);
}

// ---------- inside a client: media ----------
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
    for (const [k, v] of Object.entries(scopeHeaders())) xhr.setRequestHeader(k, v);
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
    pageHead("Media", clientName(), h("button", { onclick: addWeb }, "+ Web page"), h("button", { class: "primary", onclick: () => input.click() }, "Upload")),
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

// ---------- logins (a client's logins inside the client; your team's in Settings) ----------
function usersCard(users, title, hint) {
  const userDlg = u => dialog(u ? "Edit login" : "Add a login", h("div", {},
    u ? h("p", { class: "muted" }, u.email) : field("Email", h("input", { name: "email", type: "email", required: true })),
    field("Name", h("input", { name: "name", value: u ? u.name : "", maxlength: 100 })),
    field("Role", h("select", { name: "role" },
      h("option", { value: "admin", selected: !u || u.role === "admin" }, "Admin: everything, including logins"),
      h("option", { value: "editor", selected: u && u.role === "editor" }, "Editor: screens, playlists and media"))),
    field(u ? "New password (leave empty to keep)" : "Password (8+ characters)", h("input", { name: "password", type: "password", minlength: 8, required: !u, autocomplete: "new-password" }))),
  { onSubmit: f => { const b = Object.fromEntries(f); if (u && !b.password) delete b.password; return u ? api("PATCH", "/users/" + u.id, b) : api("POST", "/users", b); } });

  return h("div", { class: "card" },
    h("div", { class: "page-head", style: "margin-bottom:.5rem" }, h("div", {}, h("h2", { style: "margin:0" }, title), h("div", { class: "small muted" }, hint)),
      h("button", { class: "small primary", onclick: async () => { const r = await userDlg(); if (r) { toast("Login created for " + r.email + "."); route(); } } }, "+ Add login")),
    users.length ? h("div", { class: "table-wrap" }, h("table", {}, h("tbody", {}, users.map(u => h("tr", {},
      h("td", {}, h("strong", {}, u.name || u.email), h("div", { class: "small muted" }, u.email)),
      h("td", {}, h("span", { class: "pill" + (u.role === "admin" ? " ok" : "") }, u.role)),
      h("td", { style: "text-align:right" },
        h("button", { class: "small", onclick: async () => { if (await userDlg(u)) { toast("Saved."); route(); } } }, "Edit"), " ",
        u.id === state.user.id ? null : h("button", { class: "small danger", onclick: async () => {
          if (!await confirmDlg("Delete " + u.email + "?", "They will no longer be able to log in.")) return;
          try { await api("DELETE", "/users/" + u.id); toast("Deleted."); route(); } catch (e) { fail(e); }
        } }, "Delete")))))))
      : h("p", { class: "muted" }, "No logins yet."));
}

async function renderLogins(main) {
  if (!isAdmin()) { go("/"); return; }
  const users = await api("GET", "/users");
  main.replaceChildren(
    pageHead("Logins", clientName()),
    usersCard(users, "Logins for " + clientName(),
      "These people log in at " + location.origin + " and only see " + clientName() + "'s screens, playlists and media."));
}

// ---------- settings ----------
async function renderSettings(main) {
  const [apk, users] = await Promise.all([api("GET", "/apk"), isStaff() && isAdmin() ? api("GET", "/users") : Promise.resolve(null)]);
  const portalUrl = location.origin;

  const pw = { current: h("input", { type: "password", autocomplete: "current-password" }), next: h("input", { type: "password", autocomplete: "new-password", minlength: 8 }) };
  const pwBtn = h("button", { class: "primary", onclick: async () => {
    try { await api("POST", "/auth/password", { current: pw.current.value, next: pw.next.value }); pw.current.value = pw.next.value = ""; toast("Password changed."); } catch (e) { fail(e); }
  } }, "Change password");

  main.replaceChildren(
    pageHead("Settings", isStaff() ? null : clientName(),
      h("button", { onclick: async () => { await api("POST", "/auth/logout"); state.user = null; location.hash = "#/"; renderLogin(); } }, "Log out")),
    h("div", { class: "grid two" },
      h("div", { class: "card" }, h("h2", {}, "Player app (Android)"),
        apk.available
          ? h("div", {}, h("p", {}, h("a", { class: "btn primary", href: apk.url }, "⬇ Download player app"), " ", h("span", { class: "small muted" }, apk.file + " · " + bytes(apk.size))),
            h("p", { class: "small muted" }, "On the TV or Android box, open this address in a browser to download it: ", h("span", { class: "mono" }, portalUrl + apk.url)))
          : h("p", { class: "muted" }, "No player app uploaded yet."),
        isAdmin() && isStaff() ? h("div", { style: "margin-top:.5rem" },
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
          h("li", {}, isStaff() ? "The TV shows a 6-character code. Open the client, go to Screens → Add screen and type it in."
            : "The TV shows a 6-character code. Go to Screens → Add screen and type it in."))),
      h("div", { class: "card" }, h("h2", {}, "My login"), h("p", { class: "muted small" }, state.user.email + " · " + state.user.role),
        field("Current password", pw.current), field("New password (8+ characters)", pw.next), pwBtn)),
    users ? h("div", { style: "margin-top:1rem" }, usersCard(users, "Your team",
      "Your staff see every client. A client's own logins are under that client → Logins.")) : null);
}

// ---------- start ----------
(async () => {
  try { state.user = (await api("GET", "/auth/me")).user; await loadCustomers(); } catch (_) { state.user = null; }
  route();
})();
