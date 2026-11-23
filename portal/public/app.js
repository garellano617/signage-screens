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
  else if (m.kind === "widget" && m.widget) { box.classList.add("widget-thumb"); const w = h("div", {}); box.append(w); requestAnimationFrame(() => SignageWidgets.render(w, m.widget, null, { still: true })); }
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
  channels: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>',
  wizard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8l1.4 1.4M17.8 6.2l1.4-1.4M12.2 6.2l-1.4-1.4"/><path d="M15 9l-12 12"/></svg>',
  widgets: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><circle cx="17.5" cy="17.5" r="3.5"/></svg>',
  content: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7l9-4 9 4-9 4z"/><path d="M3 12l9 4 9-4"/><path d="M3 17l9 4 9-4"/></svg>',
  monitoring: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 12h-4l-3 8-6-16-3 8H2"/></svg>',
  download: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12M7 10l5 5 5-5"/><path d="M4 17v3h16v-3"/></svg>',
  profile: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21v-1a8 8 0 0 1 16 0v1"/></svg>',
  back: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>',
  settings: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>'
};
const LOGO = '<svg viewBox="0 0 24 24"><rect x="2" y="4" width="20" height="13" rx="2" fill="#2563eb"/><path d="M10 8l5 2.5-5 2.5z" fill="#fff"/><rect x="8" y="19" width="8" height="2" rx="1" fill="#2563eb"/></svg>';

// Pages inside one client (same for your team inside a client and for a client's own login).
const clientRoutes = [
  [/^\/?$/, "dashboard", renderDashboard],
  [/^\/wizard$/, "wizard", renderWizard],
  [/^\/monitoring$/, "monitoring", renderMonitoring],
  [/^\/screens$/, "screens", renderScreens],
  [/^\/screens\/(\d+)$/, "screens", renderScreen],
  [/^\/screens\/(\d+)\/layers$/, "screens", renderLayers],
  [/^\/channels$/, "channels", renderChannels],
  [/^\/channels\/(\d+)$/, "channels", renderChannel],
  [/^\/channels\/(\d+)\/layers$/, "channels", (main, id) => renderLayers(main, id, "channel")],
  [/^\/playlists$/, "playlists", renderPlaylists],
  [/^\/playlists\/(\d+)$/, "playlists", renderPlaylist],
  [/^\/media$/, "media", renderMedia],
  [/^\/widgets$/, "widgets", renderWidgets],
  [/^\/logins$/, "logins", renderLogins]
];
// Your team's main level.
const staffRoutes = [
  [/^\/?$/, "dashboard", renderOverview],
  [/^\/clients$/, "clients", renderClients],
  [/^\/monitoring$/, "monitoring", renderMonitoring],
  [/^\/download$/, "download", renderDownload],
  [/^\/(profile|settings)$/, "profile", renderProfile]
];
// Extra pages a client's own login has outside the client menu.
const clientLoginRoutes = [
  [/^\/download$/, "download", renderDownload],
  [/^\/(profile|settings)$/, "profile", renderProfile]
];

const CONTENT_SECTIONS = ["media", "widgets"];
let contentOpen = null; // null = open when a content page is shown

function shell(section, inClient) {
  const link = (href, key, label, cls) => h("a", { href, class: (section === key ? "active " : "") + (cls || ""), html: ICONS[key] + "<span>" + label + "</span>" });
  const contentGroup = () => {
    const open = contentOpen === null ? CONTENT_SECTIONS.includes(section) : contentOpen;
    const sub = h("div", { class: "submenu" + (open ? " open" : "") },
      link(base() + "/media", "media", "Media library", "sub"),
      link(base() + "/widgets", "widgets", "Widgets", "sub"));
    return h("div", { class: "navgroup" },
      h("button", { type: "button", class: "navgroup-head" + (CONTENT_SECTIONS.includes(section) ? " active" : ""), "aria-expanded": String(open),
        onclick: e => { contentOpen = !sub.classList.contains("open"); sub.classList.toggle("open", contentOpen); e.currentTarget.setAttribute("aria-expanded", String(contentOpen)); },
        html: ICONS.content + "<span>Content</span><i class='caret'></i>" }),
      sub);
  };
  let links;
  if (inClient) {
    const c = isStaff() ? currentClient() : null;
    links = [
      isStaff() ? link("#/clients", "back", "All clients") : null,
      h("div", { class: "client-head" }, h("div", { class: "client-label" }, isStaff() ? "Client" : "Account"), h("div", { class: "client-title" }, clientName()),
        c && !c.active ? h("span", { class: "pill warn" }, "Paused") : null),
      link(base() + "/", "dashboard", "Dashboard"),
      link(base() + "/wizard", "wizard", "Wizard"),
      contentGroup(),
      link(base() + "/channels", "channels", "Channels"),
      link(base() + "/playlists", "playlists", "Playlists"),
      link(base() + "/screens", "screens", "Screens"),
      link(base() + "/monitoring", "monitoring", "Screen Monitoring"),
      isStaff() ? (isAdmin() ? link(base() + "/logins", "logins", "Logins") : null) : link("#/download", "download", "Download App"),
      isStaff() ? null : link("#/profile", "profile", "Profile & Admins")
    ];
  } else if (isStaff()) {
    links = [link("#/", "dashboard", "Dashboard"), link("#/clients", "clients", "Clients"),
      link("#/monitoring", "monitoring", "Screen Monitoring"), link("#/download", "download", "Download App"),
      link("#/profile", "profile", "Profile & Admins")];
  } else {
    // A client's login on Download App / Profile: same menu as inside their account.
    return shell(section, true);
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
    if (clientLoginRoutes.some(([re]) => re.test(path))) table = clientLoginRoutes;
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
  const [d, allScreens] = await Promise.all([api("GET", "/dashboard"), api("GET", "/screens"), loadCustomers()]);
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
          : h("p", { class: "muted" }, d.screens ? "All screens are online. 👍" : "No screens yet. Open a client to add one."))),
    h("div", { style: "margin-top:1rem" }, mapCard(allScreens, s => `#/c/${s.customerId}/screens/${s.id}`)));
  poll(() => renderOverview(main).catch(() => {}), 60000);
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
  const [d, screens] = await Promise.all([api("GET", "/dashboard"), api("GET", "/screens")]);
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
    screens.length ? h("div", { style: "margin-top:1rem" }, mapCard(screens, s => base() + "/screens/" + s.id)) : null,
    c && isAdmin() ? h("div", { style: "margin-top:2rem;text-align:right" },
      h("button", { class: "small danger", onclick: () => deleteClient(c) }, "Delete this client")) : null);
  poll(() => renderDashboard(main).catch(() => {}), 60000);
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
  const [s, playlists, channels] = await Promise.all([api("GET", "/screens/" + id), api("GET", "/playlists"), api("GET", "/channels")]);

  // settings
  const f = {
    name: h("input", { value: s.name, maxlength: 100 }),
    location: h("input", { value: s.location, maxlength: 200 }),
    playlistId: h("select", {}, playlistOptions(playlists, s.playlistId, "— none —")),
    channelId: h("select", {}, h("option", { value: "" }, "— none (this screen's own playlist and layers) —"),
      channels.map(c => h("option", { value: c.id, selected: c.id === s.channelId }, c.name))),
    orientation: h("select", {}, [[0, "Landscape"], [90, "Portrait (rotated right)"], [180, "Landscape, upside down"], [270, "Portrait (rotated left)"]]
      .map(([v, l]) => h("option", { value: v, selected: v === s.orientation }, l))),
    volume: h("input", { type: "range", min: 0, max: 100, value: s.volume }),
    notes: h("textarea", { rows: 2, maxlength: 2000 }, s.notes)
  };
  // On a channel, the main playlist comes from the channel.
  const plNote = h("div", { class: "small muted", style: "margin-top:.3rem" });
  const plField = h("div", { class: "field" }, h("label", {}, "Main playlist"), f.playlistId, plNote);
  const syncChannel = () => {
    const ch = channels.find(c => c.id === Number(f.channelId.value));
    f.playlistId.disabled = !!ch;
    plNote.textContent = ch ? "From the channel: " + (ch.playlistName || "no playlist yet") + "." : "";
  };
  f.channelId.addEventListener("change", syncChannel);
  syncChannel();
  const volLbl = h("span", { class: "muted" }, s.volume + "%");
  f.volume.addEventListener("input", () => (volLbl.textContent = f.volume.value + "%"));
  const saveBtn = h("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      await api("PATCH", "/screens/" + id, { name: f.name.value, location: f.location.value, playlistId: f.playlistId.value || null, channelId: f.channelId.value || null,
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
          field("Name", f.name), field("Location", f.location), field("Channel", f.channelId), plField,
          h("div", { class: "row" }, field("Orientation", f.orientation), h("div", { class: "field" }, h("label", {}, "Volume ", volLbl), f.volume)),
          field("Notes", f.notes), saveBtn),
        h("div", { class: "card" }, h("h2", {}, "Schedule"),
          h("p", { class: "muted small" }, "During these times the screen plays the chosen playlist instead of its main one. The first matching slot wins. A slot that ends before it starts (e.g. 22:00 to 06:00) runs overnight."),
          slotsBox,
          h("div", { class: "row" }, h("button", { onclick: () => { slots.push({ playlistId: null, days: 127, start: "09:00", end: "17:00" }); drawSlots(); } }, "+ Add time slot"), schedSave)),
        locationCard(s)),
      h("div", { class: "stack" },
        s.channelId ? h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Layers"),
            h("a", { class: "btn small", href: base() + "/channels/" + s.channelId }, "Open channel")),
          h("p", { class: "small muted", style: "margin:0" }, "This screen uses the layers of the channel “" + s.channelName + "”.")) :
        h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Layers"),
            h("a", { class: "btn primary small", href: base() + "/screens/" + id + "/layers" }, "Design layers")),
          h("div", { class: "chips" }, [["video", "Video"], ["specials", "Specials"], ["text", "Text"], ["effects", "Effects"]].map(([k, l]) =>
            h("span", { class: "pill" + (s.layers[k].enabled ? " ok" : "") }, (s.layers[k].enabled ? "● " : "○ ") + l)))),
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

// ---------- inside a client: screen layers ----------
const REGION_LABELS = [["full", "Full screen"], ["left70", "Left 70% (room on the right)"], ["right70", "Right 70% (room on the left)"],
  ["top85", "Top 85% (room for a ticker)"], ["left70top85", "Left 70% + top 85%"]];
const POSITION_LABELS = [["top-left", "Top left"], ["top", "Top"], ["top-right", "Top right"], ["left", "Left"], ["center", "Center"],
  ["right", "Right"], ["bottom-left", "Bottom left"], ["bottom", "Bottom"], ["bottom-right", "Bottom right"]];
const SPECIAL_POSITIONS = [["right", "Right panel"], ["left", "Left panel"], ["bottom-right", "Card, bottom right"], ["bottom-left", "Card, bottom left"],
  ["top-right", "Card, top right"], ["center", "Big card, center"]];
const SIZE_LABELS = [["s", "Small"], ["m", "Medium"], ["l", "Large"], ["xl", "Extra large"]];
const EFFECT_LABELS = [["snow", "❄ Snow"], ["confetti", "🎉 Confetti"], ["sparkles", "✨ Sparkles"], ["bubbles", "○ Bubbles"], ["hearts", "♥ Hearts"],
  ["leaves", "🍂 Falling leaves"], ["stars", "★ Twinkling stars"]];

const opts = (list, val) => list.map(([v, l]) => h("option", { value: v, selected: v === val }, l));
const colorIn = (val, onchange, label) => h("label", { class: "color-in" }, h("input", { type: "color", value: val, oninput: e => onchange(e.target.value) }), label);

/** Layers editor for a screen, or for a channel (kind = "channel"). */
async function renderLayers(main, id, kind) {
  const isCh = kind === "channel";
  const path = (isCh ? "/channels/" : "/screens/") + id;
  const [s, media] = await Promise.all([api("GET", path), api("GET", "/media")]);
  if (!isCh && s.channelId) {
    // This screen's layers come from its channel.
    main.replaceChildren(h("a", { href: base() + "/screens/" + id, class: "back" }, "← " + s.name),
      h("div", { class: "card empty" }, h("p", {}, "“" + s.name + "” uses the channel “" + s.channelName + "”, so its layers are designed there."),
        h("a", { class: "btn primary", href: base() + "/channels/" + s.channelId + "/layers" }, "Design the channel's layers")));
    return;
  }
  const L = JSON.parse(JSON.stringify(s.layers));
  const images = media.filter(m => m.kind === "image");
  let firstItem = null;
  if (s.playlistId) { try { firstItem = (await api("GET", "/playlists/" + s.playlistId)).items.find(i => i.kind !== "web") || null; } catch (_) {} }
  let dirty = false, overlay = null, t = 0;
  const portrait = !isCh && (s.orientation === 90 || s.orientation === 270);

  // ---- live preview ----
  const pvVideo = h("div", { class: "pv-video" });
  const pvOverlay = h("div", { class: "pv-overlay" });
  const preview = h("div", { class: "preview" + (portrait ? " portrait" : "") }, h("div", { class: "pv-bg" }), pvVideo, pvOverlay);
  function drawVideo() {
    const r = SignageOverlay.REGIONS[L.video.region] || SignageOverlay.REGIONS.full;
    Object.assign(pvVideo.style, { left: r[0] + "%", top: r[1] + "%", width: r[2] + "%", height: r[3] + "%", display: L.video.enabled ? "" : "none" });
    pvVideo.replaceChildren(firstItem
      ? (firstItem.kind === "video" ? h("video", { src: firstItem.src, muted: true, autoplay: true, loop: true, playsInline: true }) : h("img", { src: firstItem.src, alt: "" }))
      : h("div", { class: "pv-placeholder" }, "Video layer", h("small", {}, s.playlistName ? "Playlist: " + s.playlistName : "No playlist yet")));
  }
  function refresh() {
    clearTimeout(t);
    t = setTimeout(() => { if (overlay) overlay.destroy(); overlay = SignageOverlay.render(pvOverlay, L); }, 120);
  }
  const change = () => { dirty = true; saveBtn.textContent = "Save changes"; refresh(); };

  // ---- layer cards ----
  const layerCard = (key, title, desc, body) => {
    const bodyBox = h("div", { class: "layer-body" + (L[key].enabled ? "" : " off") }, body);
    return h("div", { class: "card layer" },
      h("div", { class: "layer-head" },
        h("div", {}, h("h2", {}, title), h("div", { class: "small muted" }, desc)),
        h("label", { class: "switch" }, h("input", { type: "checkbox", checked: L[key].enabled, onchange: e => {
          L[key].enabled = e.target.checked; bodyBox.classList.toggle("off", !e.target.checked); if (key === "video") drawVideo(); change();
        } }), h("span", {}))),
      bodyBox);
  };

  // video
  const videoBody = h("div", {},
    field("Area on the screen", h("select", { onchange: e => { L.video.region = e.target.value; drawVideo(); change(); } }, opts(REGION_LABELS, L.video.region))),
    h("p", { class: "small muted" }, isCh ? ["Plays the channel's playlist (", s.playlistName || "none yet", "). Change it on the channel page. Use a smaller area to leave room for a specials panel or a ticker."]
      : ["Plays this screen's playlist and schedule (", s.playlistName || "no playlist yet", "). Change them on the screen page. Use a smaller area to leave room for a specials panel or a ticker."]));

  // specials
  const spList = h("div", {});
  function drawSpecials() {
    spList.replaceChildren(...L.specials.items.map((it, i) => h("div", { class: "sub-item" },
      h("div", { class: "row" },
        field("Title", h("input", { value: it.title, maxlength: 80, placeholder: "e.g. Taco Tuesday", oninput: e => { it.title = e.target.value; change(); } })),
        h("div", { class: "field", style: "flex:0 1 120px" }, h("label", {}, "Price"), h("input", { value: it.price, maxlength: 20, placeholder: "$2.99", oninput: e => { it.price = e.target.value; change(); } }))),
      field("Description", h("input", { value: it.description, maxlength: 200, placeholder: "optional", oninput: e => { it.description = e.target.value; change(); } })),
      field("Photo", h("select", { onchange: e => {
        const m = images.find(x => x.id === Number(e.target.value));
        it.mediaId = m ? m.id : null; it.image = m ? { src: m.src } : null; change();
      } }, h("option", { value: "" }, images.length ? "— no photo —" : "— upload images in Media first —"),
        images.map(m => h("option", { value: m.id, selected: m.id === it.mediaId }, m.name)))),
      h("div", { class: "row", style: "align-items:center" },
        h("div", { class: "days" }, DAYS.map((d, b) => h("button", { type: "button", class: it.days & (1 << b) ? "on" : "",
          onclick: e => { const n = it.days ^ (1 << b); if (!n) return; it.days = n; e.target.classList.toggle("on"); change(); } }, d))),
        h("div", { class: "times" },
          h("input", { type: "time", value: it.start, "aria-label": "From", onchange: e => { it.start = e.target.value; change(); } }), "to",
          h("input", { type: "time", value: it.end, "aria-label": "Until", onchange: e => { it.end = e.target.value; change(); } })),
        h("button", { type: "button", class: "small danger", onclick: () => { L.specials.items.splice(i, 1); drawSpecials(); change(); } }, "Remove")))));
    if (!L.specials.items.length) spList.append(h("p", { class: "small muted" }, "No specials yet."));
  }
  drawSpecials();
  const specialsBody = h("div", {},
    h("div", { class: "row" },
      field("Heading", h("input", { value: L.specials.heading, maxlength: 60, oninput: e => { L.specials.heading = e.target.value; change(); } })),
      field("Where", h("select", { onchange: e => { L.specials.position = e.target.value; change(); } }, opts(SPECIAL_POSITIONS, L.specials.position))),
      h("div", { class: "field", style: "flex:0 1 130px" }, h("label", {}, "Seconds each"),
        h("input", { type: "number", min: 3, max: 120, value: L.specials.seconds, oninput: e => { L.specials.seconds = Number(e.target.value) || 8; change(); } }))),
    h("div", { class: "colors" },
      colorIn(L.specials.bg, v => { L.specials.bg = v; change(); }, "Background"),
      colorIn(L.specials.color, v => { L.specials.color = v; change(); }, "Text"),
      colorIn(L.specials.accent, v => { L.specials.accent = v; change(); }, "Price & heading")),
    h("p", { class: "small muted" }, "Specials take turns. Leave the times empty to show a special all day, or set days and times (e.g. lunch 11:00 to 14:00)."),
    spList,
    h("button", { type: "button", onclick: () => { L.specials.items.push({ title: "", price: "", description: "", mediaId: null, image: null, days: 127, start: "", end: "" }); drawSpecials(); change(); } }, "+ Add special"));

  // text
  const blockList = h("div", {});
  function drawBlocks() {
    blockList.replaceChildren(...L.text.blocks.map((b, i) => h("div", { class: "sub-item" },
      field("Text", h("textarea", { rows: 2, maxlength: 300, placeholder: "e.g. Open 7 days · 8am–10pm", oninput: e => { b.text = e.target.value; change(); } }, b.text)),
      h("div", { class: "row" },
        field("Where", h("select", { onchange: e => { b.position = e.target.value; change(); } }, opts(POSITION_LABELS, b.position))),
        field("Size", h("select", { onchange: e => { b.size = e.target.value; change(); } }, opts(SIZE_LABELS, b.size)))),
      h("div", { class: "colors" },
        h("label", { class: "color-in" }, h("input", { type: "checkbox", checked: b.bold, onchange: e => { b.bold = e.target.checked; change(); } }), "Bold"),
        colorIn(b.color, v => { b.color = v; change(); }, "Text"),
        colorIn(b.bg, v => { b.bg = v; change(); }, "Box"),
        h("label", { class: "color-in" }, "Box opacity", h("input", { type: "range", min: 0, max: 100, value: b.bgOpacity, style: "width:100px", oninput: e => { b.bgOpacity = Number(e.target.value); change(); } })),
        h("button", { type: "button", class: "small danger", onclick: () => { L.text.blocks.splice(i, 1); drawBlocks(); change(); } }, "Remove")))));
    if (!L.text.blocks.length) blockList.append(h("p", { class: "small muted" }, "No text blocks yet."));
  }
  drawBlocks();
  const tk = L.text.ticker;
  const tickerBody = h("div", { class: "layer-body" + (tk.enabled ? "" : " off") },
    field("Messages (one per line)", h("textarea", { rows: 3, maxlength: 1000, placeholder: "Free Wi-Fi\nAsk about catering!", oninput: e => { tk.text = e.target.value; change(); } }, tk.text)),
    h("div", { class: "row" },
      field("Where", h("select", { onchange: e => { tk.position = e.target.value; change(); } }, opts([["bottom", "Bottom"], ["top", "Top"]], tk.position))),
      field("Speed", h("select", { onchange: e => { tk.speed = e.target.value; change(); } }, opts([["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]], tk.speed))),
      field("Size", h("select", { onchange: e => { tk.size = e.target.value; change(); } }, opts(SIZE_LABELS, tk.size)))),
    h("div", { class: "colors" }, colorIn(tk.color, v => { tk.color = v; change(); }, "Text"), colorIn(tk.bg, v => { tk.bg = v; change(); }, "Bar")));
  const textBody = h("div", {},
    blockList,
    h("button", { type: "button", onclick: () => { L.text.blocks.push({ text: "", position: "top", size: "m", bold: true, color: "#ffffff", bg: "#000000", bgOpacity: 50 }); drawBlocks(); change(); } }, "+ Add text"),
    h("div", { class: "layer-head", style: "margin-top:1.25rem" }, h("h3", { style: "margin:0" }, "Scrolling ticker"),
      h("label", { class: "switch" }, h("input", { type: "checkbox", checked: tk.enabled, onchange: e => { tk.enabled = e.target.checked; tickerBody.classList.toggle("off", !tk.enabled); change(); } }), h("span", {}))),
    tickerBody);

  // effects
  const effectsBody = h("div", {},
    h("div", { class: "row" },
      field("Effect", h("select", { onchange: e => { L.effects.type = e.target.value; change(); } }, opts(EFFECT_LABELS, L.effects.type))),
      field("Amount", h("select", { onchange: e => { L.effects.intensity = e.target.value; change(); } }, opts([["light", "Light"], ["medium", "Medium"], ["heavy", "Heavy"]], L.effects.intensity)))),
    h("div", { class: "colors" }, colorIn(L.effects.color, v => { L.effects.color = v; change(); }, "Color (snow, sparkles, bubbles, hearts, stars)")));

  const saveBtn = h("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      const saved = await api("PUT", path + "/layers", L);
      // Keep what the server cleaned (e.g. empty text removed) but don't redraw the editor.
      dirty = false; saveBtn.textContent = "Saved";
      toast(isCh ? "Layers saved. Every screen on this channel updates within 30 seconds." : "Layers saved. The screen updates within 30 seconds.");
      if (saved.text.blocks.length !== L.text.blocks.length || saved.specials.items.length !== L.specials.items.length) route();
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save");

  main.replaceChildren(
    h("a", { href: base() + path, class: "back", onclick: e => { if (dirty && !confirm("Leave without saving your changes?")) e.preventDefault(); } }, "← " + s.name),
    pageHead("Layers", (isCh ? "Channel " : "") + s.name + " · " + clientName(), saveBtn),
    h("div", { class: "layers-grid" },
      h("div", { class: "preview-col" }, h("div", { class: "card preview-card" }, h("h2", {}, "Live preview"), preview,
        h("p", { class: "small muted", style: "margin:.6rem 0 0" }, "Layers stack from bottom to top: Video → Specials → Text → Effects."))),
      h("div", { class: "stack" },
        layerCard("video", "1 · Video", "The playlist (images, videos, web pages)", videoBody),
        layerCard("specials", "2 · Specials", "Rotating offers with price and photo", specialsBody),
        layerCard("text", "3 · Text", "Text blocks anywhere, plus a scrolling ticker", textBody),
        layerCard("effects", "4 · Effects", "Animated overlay on top of everything", effectsBody))));
  drawVideo(); refresh();
  window.onbeforeunload = () => (dirty ? true : undefined);
  // Stop the preview animations when leaving the page.
  const stop = () => { if (overlay) overlay.destroy(); window.removeEventListener("hashchange", stop); };
  window.addEventListener("hashchange", stop);
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
        h("div", { class: "info" }, h("div", { class: "name" }, it.name), h("div", { class: "small muted" }, it.kind === "web" ? "Web page" : it.kind === "video" ? "Video" : it.kind === "widget" ? "Widget" : "Image")),
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
      items.push({ mediaId: m.id, name: m.name, kind: m.kind, src: m.src, widget: m.widget, duration: m.kind === "web" ? 30 : m.kind === "widget" ? 15 : 10 }); mark(); draw();
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
      m.kind === "widget" ? h("a", { href: "#", onclick: e => { e.preventDefault(); widgetDialog(m.widget.type, m); } }, thumb(m)) : h("a", { href: m.src, target: "_blank", rel: "noopener" }, thumb(m)),
      h("div", { class: "meta" }, h("div", { class: "name", title: m.name }, m.name),
        h("div", { class: "small muted" }, m.kind === "web" ? new URL(m.src).hostname : m.kind === "widget" ? "Widget · " + (WIDGET_TYPES[m.widget && m.widget.type] || {}).name : m.kind + " · " + bytes(m.size)),
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

// ---------- inside a client: channels ----------
const layerChips = on => h("div", { class: "chips" }, [["video", "Video"], ["specials", "Specials"], ["text", "Text"], ["effects", "Effects"]].map(([k, l]) =>
  h("span", { class: "pill" + (on.includes(k) ? " ok" : "") }, (on.includes(k) ? "● " : "○ ") + l)));

async function renderChannels(main) {
  const [channels, playlists] = await Promise.all([api("GET", "/channels"), api("GET", "/playlists")]);
  const create = async () => {
    const r = await dialog("New channel", h("div", {},
      h("p", { class: "muted small" }, "A channel is a design you can put on many screens: a main playlist plus specials, text and effects layers. Change the channel once and every screen on it updates."),
      field("Name", h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. Lunch menu boards" })),
      field("Main playlist", h("select", { name: "playlistId" }, playlistOptions(playlists, null, "— choose later —")))),
    { submit: "Create channel", onSubmit: f => api("POST", "/channels", Object.fromEntries(f)) });
    if (r) go("/channels/" + r.id);
  };
  main.replaceChildren(
    pageHead("Channels", clientName() + " · one design for many screens", h("button", { class: "primary", onclick: create }, "+ New channel")),
    channels.length ? h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Channel"), h("th", {}, "Playlist"), h("th", {}, "Layers"), h("th", {}, "Screens"))),
      h("tbody", {}, channels.map(c => h("tr", { class: "click", onclick: () => go("/channels/" + c.id) },
        h("td", {}, h("strong", {}, c.name)),
        h("td", { class: "small" }, c.playlistName || h("span", { class: "pill warn" }, "None")),
        h("td", {}, layerChips(c.layersOn)),
        h("td", { class: "small" }, c.screens.length ? c.screens.length + " (" + c.screens.filter(s => s.online).length + " online)" : h("span", { class: "muted" }, "—")))))))
      : h("div", { class: "card empty" }, h("p", {}, "No channels yet. Use a channel when several screens should show the same thing, like all the menu boards in one store."),
        h("button", { class: "primary", onclick: create }, "+ New channel")));
}

async function renderChannel(main, id) {
  const [c, playlists, screens] = await Promise.all([api("GET", "/channels/" + id), api("GET", "/playlists"), api("GET", "/screens")]);
  const nameIn = h("input", { value: c.name, maxlength: 100 });
  const plSel = h("select", {}, playlistOptions(playlists, c.playlistId, "— none —"));
  const picked = new Set(c.screens.map(s => s.id));
  const saveBtn = h("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      await api("PATCH", "/channels/" + id, { name: nameIn.value, playlistId: plSel.value || null });
      await api("PUT", "/channels/" + id + "/screens", { screenIds: [...picked] });
      toast("Channel saved. Its screens update within 30 seconds."); route();
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save");
  main.replaceChildren(
    h("a", { href: base() + "/channels", class: "back" }, "← All channels"),
    pageHead(c.name, "Channel · " + clientName(), h("button", { class: "danger", onclick: async () => {
      if (!await confirmDlg("Delete channel “" + c.name + "”?", "Its screens go back to their own playlist and layers. Playlists and media are kept.")) return;
      try { await api("DELETE", "/channels/" + id); toast("Channel deleted."); go("/channels"); } catch (e) { fail(e); }
    } }, "Delete"), saveBtn),
    h("div", { class: "grid two" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", {}, "Content"), field("Name", nameIn), field("Main playlist", plSel),
          h("p", { class: "small muted" }, "Each screen's own schedule still applies on top (e.g. a breakfast playlist in the morning).")),
        h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Layers"),
          h("a", { class: "btn primary small", href: base() + "/channels/" + id + "/layers" }, "Design layers")), layerChips(c.layersOn))),
      h("div", { class: "card" }, h("h2", {}, "Screens on this channel"),
        screens.length ? h("div", { class: "check-list" }, screens.map(s => h("label", { class: "check-row" },
          h("input", { type: "checkbox", checked: picked.has(s.id), onchange: e => { e.target.checked ? picked.add(s.id) : picked.delete(s.id); } }),
          h("span", { style: "flex:1" }, h("strong", {}, s.name), h("span", { class: "small muted" }, s.channelId && s.channelId !== c.id ? " · now on “" + s.channelName + "”" : s.location ? " · " + s.location : "")),
          statusPill(s))))
          : h("p", { class: "muted" }, "No screens yet."),
        h("p", { class: "small muted", style: "margin-bottom:0" }, "Ticked screens show this channel's playlist and layers. Click Save to apply."))));
}

// ---------- inside a client: widgets ----------
const WIDGET_TYPES = {
  clock: { name: "Clock", icon: "🕒", desc: "Digital or analog clock with the date.", config: { style: "digital", hours: "12", showDate: true, showSeconds: false, label: "", bg: "#0f172a", fg: "#ffffff", accent: "#f59e0b" } },
  weather: { name: "Weather", icon: "⛅", desc: "Current weather and a 3-day forecast for any place.", config: { place: "", lat: "", lng: "", units: "f", forecast: true, bg: "#0b3b66", fg: "#ffffff", accent: "#fbbf24" } },
  rss: { name: "News feed", icon: "📰", desc: "Rotating headlines from an RSS or Atom feed.", config: { url: "", title: "News", seconds: 8, bg: "#111827", fg: "#ffffff", accent: "#60a5fa" } },
  qr: { name: "QR code", icon: "🔳", desc: "A scannable code for your website, menu, Wi-Fi or reviews.", config: { text: "", title: "Scan me", caption: "", bg: "#ffffff", fg: "#111827", accent: "#2563eb" } },
  countdown: { name: "Countdown", icon: "⏳", desc: "Days, hours, minutes and seconds to an opening, sale or event.", config: { title: "Grand opening", target: "", done: "We're open!", bg: "#7c2d12", fg: "#ffffff", accent: "#fde68a" } },
  message: { name: "Message", icon: "💬", desc: "A full-screen announcement with a title and text.", config: { title: "", body: "", align: "center", bg: "#1e3a8a", fg: "#ffffff", accent: "#fbbf24" } }
};

async function widgetDialog(type, existing) {
  const T = WIDGET_TYPES[type];
  const c = Object.assign({}, T.config, existing ? existing.widget.config : {});
  let data = null, live = null, loadT = 0;
  const pv = h("div", {});
  const pvBox = h("div", { class: "widget-preview" }, pv);
  const status = h("div", { class: "small muted", style: "min-height:1.2em" });
  const draw = () => { if (live) live.destroy(); live = SignageWidgets.render(pv, { type, config: c }, data); };
  const needsData = type === "weather" || type === "rss";
  // QR codes are drawn by the server; weather/news are fetched by it.
  const refreshFromServer = () => {
    clearTimeout(loadT);
    loadT = setTimeout(async () => {
      if (type === "weather" && c.lat === "") { status.textContent = "Pick a place to see the weather."; return; }
      if (type === "rss" && !c.url) { status.textContent = "Enter a feed address to see headlines."; return; }
      if (type === "qr" && !c.text) { c.svg = ""; draw(); return; }
      if (type === "countdown" || type === "clock" || type === "message") return;
      status.textContent = "Loading preview…";
      try { const r = await api("POST", "/widget-preview", { type, config: c }); if (r.config.svg) c.svg = r.config.svg; data = r.data; status.textContent = ""; draw(); }
      catch (e) { status.textContent = e.message; }
    }, 500);
  };
  const set = (k, v, server) => { c[k] = v; draw(); if (server) refreshFromServer(); };
  const inp = (k, label, attrs, server) => field(label, h("input", Object.assign({ value: c[k] == null ? "" : c[k], oninput: e => set(k, e.target.value, server) }, attrs || {})));
  const sel = (k, label, list) => field(label, h("select", { onchange: e => set(k, e.target.value) }, opts(list, c[k])));
  const chk = (k, label) => h("label", { class: "color-in" }, h("input", { type: "checkbox", checked: !!c[k], onchange: e => set(k, e.target.checked) }), label);
  const colors = h("div", { class: "colors" }, colorIn(c.bg, v => set("bg", v), "Background"), colorIn(c.fg, v => set("fg", v), "Text"), colorIn(c.accent, v => set("accent", v), "Accent"));

  let fields;
  if (type === "clock") fields = [h("div", { class: "row" }, sel("style", "Style", [["digital", "Digital"], ["analog", "Analog"]]), sel("hours", "Hours", [["12", "12-hour"], ["24", "24-hour"]])),
    inp("label", "Label (optional)", { maxlength: 60, placeholder: "e.g. Boston" }), h("div", { class: "colors" }, chk("showDate", "Show date"), chk("showSeconds", "Show seconds"))];
  else if (type === "weather") {
    const q = h("input", { type: "search", placeholder: "City or address…", value: c.place });
    const hits = h("div", { class: "geo-results" });
    const find = async () => {
      hits.replaceChildren(h("div", { class: "small muted" }, "Searching…"));
      try {
        const list = await api("GET", "/geocode?q=" + encodeURIComponent(q.value));
        hits.replaceChildren(...(list.length ? list.map(r => h("button", { type: "button", class: "geo-hit", onclick: () => {
          c.lat = r.lat; c.lng = r.lng; c.place = r.label.split(",")[0]; placeIn.value = c.place; hits.replaceChildren(); draw(); refreshFromServer();
        } }, r.label)) : [h("div", { class: "small muted" }, "No match.")]));
      } catch (e) { hits.replaceChildren(h("div", { class: "small form-error" }, e.message)); }
    };
    q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); find(); } });
    const placeIn = h("input", { value: c.place, maxlength: 80, oninput: e => set("place", e.target.value) });
    fields = [field("Location", h("div", { class: "row", style: "align-items:center" }, h("div", { style: "flex:1" }, q), h("button", { type: "button", onclick: find }, "Find"))), hits,
      h("div", { class: "row" }, field("Name shown", placeIn), sel("units", "Units", [["f", "°F, mph"], ["c", "°C, km/h"]])), h("div", { class: "colors" }, chk("forecast", "Show 3-day forecast"))];
    // units change needs new data
    fields[2].querySelector("select").addEventListener("change", refreshFromServer);
  }
  else if (type === "rss") fields = [inp("url", "Feed address (RSS or Atom)", { type: "url", placeholder: "https://…/rss", required: true }, true),
    h("div", { class: "row" }, inp("title", "Heading", { maxlength: 60 }), inp("seconds", "Seconds per headline", { type: "number", min: 4, max: 60 }))];
  else if (type === "qr") fields = [inp("text", "Web address or text", { maxlength: 600, placeholder: "https://example.com/menu", required: true }, true),
    inp("title", "Title", { maxlength: 80 }), inp("caption", "Caption under the code", { maxlength: 160, placeholder: "e.g. See our full menu" })];
  else if (type === "countdown") fields = [inp("title", "Title", { maxlength: 80 }), inp("target", "Count down to", { type: "datetime-local", required: true }), inp("done", "Text when it's done", { maxlength: 80 })];
  else fields = [inp("title", "Title", { maxlength: 120, placeholder: "e.g. Now hiring!" }),
    field("Text", h("textarea", { rows: 3, maxlength: 600, oninput: e => set("body", e.target.value) }, c.body)), sel("align", "Alignment", [["center", "Centered"], ["left", "Left"]])];

  if (existing && needsData) { try { data = (await api("GET", "/media/" + existing.id + "/widget-data")).data; } catch (e) { status.textContent = e.message; } }
  const pending = dialog((existing ? "Edit " : "New ") + T.name.toLowerCase() + " widget", h("div", { class: "widget-dialog" },
    h("div", {}, pvBox, status),
    h("div", {}, field("Name", h("input", { name: "name", value: existing ? existing.name : T.name, maxlength: 200, required: true })), fields, colors)),
  { submit: existing ? "Save" : "Add widget", onSubmit: f => existing
      ? api("PATCH", "/media/" + existing.id, { name: f.get("name"), config: c })
      : api("POST", "/media/widget", { type, name: f.get("name"), config: c }) });
  // The dialog is on the page now: draw the first preview (QR codes need the server).
  requestAnimationFrame(() => { draw(); if (type === "qr" && c.text && !c.svg) refreshFromServer(); else if (needsData && !data) refreshFromServer(); });
  const r = await pending;
  if (live) live.destroy();
  if (r) { toast(existing ? "Widget saved." : "Widget added. Add it to a playlist to show it on screens."); route(); }
  return r;
}

async function renderWidgets(main) {
  const media = (await api("GET", "/media")).filter(m => m.kind === "widget");
  main.replaceChildren(
    pageHead("Widgets", clientName() + " · ready-made slides for your playlists"),
    h("div", { class: "widget-gallery" }, Object.entries(WIDGET_TYPES).map(([type, T]) => h("button", { type: "button", class: "widget-type", onclick: () => widgetDialog(type) },
      h("div", { class: "wt-icon" }, T.icon), h("div", { class: "wt-name" }, T.name), h("div", { class: "small muted" }, T.desc), h("span", { class: "btn small primary" }, "+ Add")))),
    h("h2", { style: "margin:1.5rem 0 .75rem" }, "Your widgets"),
    media.length ? h("div", { class: "media-grid" }, media.map(m => h("div", { class: "media-card" },
      h("a", { href: "#", onclick: e => { e.preventDefault(); widgetDialog(m.widget.type, m); } }, thumb(m)),
      h("div", { class: "meta" }, h("div", { class: "name", title: m.name }, m.name),
        h("div", { class: "small muted" }, (WIDGET_TYPES[m.widget.type] || {}).name),
        h("div", { class: "small muted" }, m.usedIn.length ? "In " + m.usedIn.map(p => p.name).join(", ") : "Not in a playlist")),
      h("div", { class: "acts" },
        h("button", { class: "small", onclick: () => widgetDialog(m.widget.type, m) }, "Edit"),
        h("button", { class: "small danger", onclick: async () => {
          if (!await confirmDlg("Delete “" + m.name + "”?", "It will be removed from any playlists.")) return;
          try { await api("DELETE", "/media/" + m.id); toast("Deleted."); route(); } catch (e) { fail(e); }
        } }, "Delete")))))
      : h("div", { class: "card empty" }, "No widgets yet. Pick one above, then add it to a playlist like any image or video."));
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

// ---------- screen map (OpenStreetMap via Leaflet, loaded only when a map is shown) ----------
let leafletReady = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (leafletReady) return leafletReady;
  leafletReady = new Promise((resolve, reject) => {
    document.head.append(h("link", { rel: "stylesheet", href: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css" }));
    const s = h("script", { src: "https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js" });
    s.onload = resolve; s.onerror = () => { leafletReady = null; reject(new Error("The map couldn't load.")); };
    document.head.append(s);
  });
  return leafletReady;
}

/** A map of screens: green = online, grey = offline. Returns the Leaflet map (or null if it couldn't load). */
async function screenMap(box, screens, { link, onClick, zoom } = {}) {
  try { await loadLeaflet(); } catch (e) { box.replaceChildren(h("p", { class: "muted small" }, e.message)); return null; }
  const map = L.map(box, { scrollWheelZoom: false, worldCopyJump: true });
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
  }).addTo(map);
  const pts = [];
  for (const s of screens) {
    if (s.lat == null || s.lng == null) continue;
    pts.push([s.lat, s.lng]);
    const m = L.circleMarker([s.lat, s.lng], { radius: 8, weight: 2, color: "#fff", fillOpacity: 1, fillColor: s.online ? "#16a34a" : "#94a3b8" }).addTo(map);
    const pop = h("div", {}, h("strong", {}, s.name), h("div", { class: "small" }, [s.customerName, s.address || s.location].filter(Boolean).join(" · ")),
      h("div", { class: "small" }, s.online ? "Online" : "Offline · last seen " + ago(s.lastSeen)));
    if (link) pop.append(h("a", { href: link(s) }, "Open screen →"));
    m.bindPopup(pop);
  }
  if (pts.length === 1) map.setView(pts[0], zoom || 14);
  else if (pts.length) map.fitBounds(pts, { padding: [30, 30], maxZoom: 14 });
  else map.setView([39.5, -98.35], 3);
  if (onClick) map.on("click", e => onClick(e.latlng));
  setTimeout(() => map.invalidateSize(), 50);
  return map;
}

function mapCard(screens, link) {
  const placed = screens.filter(s => s.lat != null).length;
  const box = h("div", { class: "map" });
  const card = h("div", { class: "card" },
    h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Screen map"),
      h("div", { class: "chips" }, h("span", { class: "pill" }, placed + " on map"),
        h("span", { class: "pill ok" }, h("span", { class: "dot" }), "Online"), h("span", { class: "pill" }, h("span", { class: "dot" }), "Offline"))),
    box,
    placed < screens.length ? h("p", { class: "small muted", style: "margin:.5rem 0 0" }, (screens.length - placed) + " screen(s) not on the map yet. Open a screen and set its location.") : null);
  requestAnimationFrame(() => screenMap(box, screens, { link }));
  return card;
}

/** Location card on a screen's page: search an address or click the map. */
function locationCard(s) {
  let pos = s.lat != null ? { lat: s.lat, lng: s.lng } : null, address = s.address || "", map = null, marker = null;
  const box = h("div", { class: "map small-map" });
  const q = h("input", { type: "search", placeholder: "Search an address…", value: address });
  const results = h("div", { class: "geo-results" });
  const label = h("div", { class: "small muted" });
  const setPin = (p, addr) => {
    pos = p; if (addr !== undefined) address = addr;
    label.textContent = pos ? (address || pos.lat.toFixed(5) + ", " + pos.lng.toFixed(5)) : "No location set.";
    if (!map) return;
    if (marker) { marker.remove(); marker = null; }
    if (pos) { marker = L.marker([pos.lat, pos.lng]).addTo(map); map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 15)); }
  };
  const search = async () => {
    results.replaceChildren(h("div", { class: "small muted" }, "Searching…"));
    try {
      const list = await api("GET", "/geocode?q=" + encodeURIComponent(q.value));
      results.replaceChildren(...(list.length ? list.map(r => h("button", { type: "button", class: "geo-hit", onclick: () => { setPin({ lat: r.lat, lng: r.lng }, r.label); results.replaceChildren(); } }, r.label))
        : [h("div", { class: "small muted" }, "No match. Try a shorter address, or click the map.")]));
    } catch (e) { results.replaceChildren(h("div", { class: "small form-error" }, e.message)); }
  };
  q.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); search(); } });
  const save = async () => {
    try {
      await api("PATCH", "/screens/" + s.id, pos ? { lat: pos.lat, lng: pos.lng, address } : { lat: null, address: "" });
      toast(pos ? "Location saved." : "Location removed.");
    } catch (e) { fail(e); }
  };
  requestAnimationFrame(async () => {
    map = await screenMap(box, pos ? [{ ...s, ...pos }] : [], { onClick: ll => setPin({ lat: ll.lat, lng: ll.lng }, ""), zoom: 15 });
    if (map && pos) { map.eachLayer(l => { if (l instanceof L.CircleMarker) l.remove(); }); setPin(pos); }
  });
  setPin(pos);
  return h("div", { class: "card" }, h("h2", {}, "Location"),
    h("div", { class: "row", style: "align-items:center;margin-bottom:.5rem" }, h("div", { style: "flex:1;min-width:180px" }, q), h("button", { type: "button", onclick: search }, "Find")),
    results, box, h("div", { class: "row", style: "align-items:center;margin-top:.6rem;justify-content:space-between" }, label,
      h("div", {}, h("button", { type: "button", class: "small", onclick: () => setPin(null, "") }, "Clear"), " ", h("button", { type: "button", class: "small primary", onclick: save }, "Save location"))),
    h("p", { class: "small muted", style: "margin:.4rem 0 0" }, "Search an address or click the map to place the pin. Shown on the dashboard's screen map."));
}

// ---------- wizard (inside a client) ----------
async function renderWizard(main) {
  const [media, playlists, screens] = await Promise.all([api("GET", "/media"), api("GET", "/playlists"), api("GET", "/screens")]);
  const filled = playlists.filter(p => p.itemCount > 0);
  let layered = false;
  if (screens.length) { try { const d = await api("GET", "/screens/" + screens[0].id); layered = ["specials", "text", "effects"].some(k => d.layers[k].enabled); } catch (_) {} }
  const steps = [
    { title: "Add your content", done: media.length > 0, text: media.length ? `${media.length} file(s) and web page(s) in the media library.` : "Upload the images and videos you want on the screens, or add a web page.",
      action: () => { const inp = h("input", { type: "file", multiple: true, accept: "image/*,video/*", class: "hidden" });
        inp.onchange = () => wizardUpload([...inp.files]); document.body.append(inp); inp.click(); }, label: "Upload files", alt: [base() + "/media", "Open media library"] },
    { title: "Make a playlist", done: filled.length > 0, text: filled.length ? `${filled.length} playlist(s) with content.` : "A playlist is the order your content plays in, looping all day.",
      action: async () => {
        if (!media.length) return fail(new Error("Add some content first (step 1)."));
        const r = await dialog("Make a playlist", h("div", {}, h("p", { class: "muted small" }, "All " + media.length + " items in your media library will be added. You can change the order and timing afterwards."),
          field("Name", h("input", { name: "name", required: true, value: "Main playlist", maxlength: 100 }))),
          { submit: "Create playlist", onSubmit: async f => {
            const p = await api("POST", "/playlists", { name: f.get("name") });
            await api("PUT", "/playlists/" + p.id, { items: media.map(m => ({ mediaId: m.id, duration: m.kind === "web" ? 30 : 10 })) });
            return p;
          } });
        if (r) { toast("Playlist created."); route(); }
      }, label: "Create from all my media", alt: [base() + "/playlists", "Open playlists"] },
    { title: "Connect a TV", done: screens.length > 0, text: screens.length ? `${screens.length} screen(s) connected.` : "Install the player app on the TV, open it, and type the code it shows.",
      action: () => pairDialog(), label: "Add screen", alt: [isStaff() ? "#/download" : "#/download", "Get the app"] },
    { title: "Design the screen", done: layered, text: layered ? "Your first screen has extra layers (specials, text or effects)." : "Add specials with prices, a scrolling ticker, text or effects on top of your playlist.",
      action: () => screens.length ? go("/screens/" + screens[0].id + "/layers") : fail(new Error("Connect a TV first (step 3).")), label: "Design layers", optional: true }
  ];
  const doneCount = steps.filter(s => s.done).length;
  main.replaceChildren(
    pageHead("Setup wizard", clientName() + " · " + doneCount + " of " + steps.length + " done"),
    h("div", { class: "progress", style: "margin:0 0 1.25rem;height:8px" }, h("div", { style: `width:${doneCount / steps.length * 100}%` })),
    h("div", { class: "stack" }, steps.map((st, i) => h("div", { class: "card wizard-step" + (st.done ? " done" : "") },
      h("div", { class: "step-num" }, st.done ? "✓" : String(i + 1)),
      h("div", { style: "flex:1;min-width:0" }, h("h2", { style: "margin:0 0 .25rem" }, st.title, st.optional ? h("span", { class: "pill", style: "margin-left:.5rem" }, "optional") : null),
        h("p", { class: "muted", style: "margin:0" }, st.text)),
      h("div", { class: "actions" }, st.alt ? h("a", { class: "btn small", href: st.alt[0] }, st.alt[1]) : null,
        h("button", { class: st.done ? "small" : "small primary", onclick: st.action }, st.label))))),
    doneCount === steps.length ? h("div", { class: "card", style: "margin-top:1rem;text-align:center" }, h("h2", {}, "🎉 All set!"), h("p", { class: "muted" }, "Your screen is playing. Changes you make reach it within 30 seconds.")) : null);

  function wizardUpload(files) {
    if (!files.length) return;
    const fd = new FormData(); files.forEach(f => fd.append("files", f));
    toast("Uploading " + files.length + " file(s)…");
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/media");
    for (const [k, v] of Object.entries(scopeHeaders())) xhr.setRequestHeader(k, v);
    xhr.onload = () => { let d = null; try { d = JSON.parse(xhr.responseText); } catch (_) {} if (xhr.status === 201) { toast("Uploaded."); route(); } else fail(new Error((d && d.error) || "Upload failed.")); };
    xhr.onerror = () => fail(new Error("Upload failed: network error."));
    xhr.send(fd);
  }
}

// ---------- screen monitoring ----------
async function renderMonitoring(main) {
  const list = await api("GET", "/monitoring");
  const inClient = !isStaff() || state.cid;
  const screenLink = s => (isStaff() ? "#/c/" + s.customerId : "#") + "/screens/" + s.id;
  const pctPill = v => v === null ? h("span", { class: "muted" }, "—") : h("span", { class: "pill " + (v >= 99 ? "ok" : v >= 90 ? "warn" : "danger") }, v + "%");
  const bars = s => h("div", { class: "uptime-bars", title: "Last 24 hours, one bar per hour" }, s.last24.map(m =>
    h("span", { class: m === null ? "na" : m >= 55 ? "up" : m > 0 ? "part" : "down", style: m ? `height:${Math.max(15, m / 60 * 100)}%` : "" })));
  let wall = false;
  const body = h("div", {});
  const draw = () => body.replaceChildren(!list.length ? h("div", { class: "card empty" }, "No screens yet.")
    : wall ? h("div", { class: "shot-wall" }, list.map(s => h("a", { class: "shot-tile", href: screenLink(s) },
        s.screenshot ? h("img", { src: s.screenshot, alt: "", loading: "lazy" }) : h("div", { class: "noshot" }, "No screenshot yet"),
        h("div", { class: "shot-meta" }, statusPill(s), h("strong", {}, s.name), h("span", { class: "small muted" }, [inClient ? null : s.customerName, s.screenshotAt ? ago(s.screenshotAt) : null].filter(Boolean).join(" · "))))))
    : h("div", { class: "card table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "Screen"), h("th", {}, "Status"), h("th", {}, "Last 24 hours"), h("th", {}, "Uptime 24h"), h("th", {}, "7 days"), h("th", {}, "Device"))),
        h("tbody", {}, list.map(s => h("tr", { class: "click", onclick: () => (location.hash = screenLink(s)) },
          h("td", {}, h("strong", {}, s.name), h("div", { class: "small muted" }, [inClient ? null : s.customerName, s.location].filter(Boolean).join(" · "))),
          h("td", {}, statusPill(s), h("div", { class: "small muted" }, s.online ? "" : ago(s.lastSeen)), s.status.error ? h("div", { class: "small", style: "color:var(--danger)" }, "⚠ " + s.status.error) : null),
          h("td", {}, bars(s)),
          h("td", {}, pctPill(s.uptime24h)), h("td", {}, pctPill(s.uptime7d)),
          h("td", { class: "small muted" }, [s.appVersion && "v" + s.appVersion, s.status.freeBytes ? bytes(s.status.freeBytes) + " free" : null].filter(Boolean).join(" · ") || "—")))))));
  draw();
  const online = list.filter(s => s.online).length;
  const toggle = h("button", { onclick: () => { wall = !wall; toggle.textContent = wall ? "Table view" : "Screenshot wall"; draw(); } }, "Screenshot wall");
  main.replaceChildren(
    pageHead("Screen Monitoring", inClient ? clientName() : "All clients",
      toggle,
      h("button", { class: "primary", onclick: async () => {
        try { const r = await api("POST", "/screens-commands", { type: "screenshot" }); toast(`Screenshots requested from ${r.screens} screen(s). They arrive within about 30 seconds.`); } catch (e) { fail(e); }
      } }, "📷 Screenshot all")),
    h("div", { class: "grid stats", style: "margin-bottom:1rem" },
      stat(list.length, "Screens"), stat(online, "Online now"), stat(list.length - online, "Offline"),
      stat(list.length ? (Math.round(list.filter(s => s.uptime24h !== null).reduce((a, s) => a + s.uptime24h, 0) / Math.max(1, list.filter(s => s.uptime24h !== null).length) * 10) / 10) + "%" : "—", "Average uptime (24h)")),
    body);
  poll(async () => { try { const fresh = await api("GET", "/monitoring"); list.splice(0, list.length, ...fresh); draw(); } catch (_) {} }, 20000);
}

// ---------- profile & admins ----------
async function renderProfile(main) {
  const users = isAdmin() ? await api("GET", "/users") : null;
  const pw = { current: h("input", { type: "password", autocomplete: "current-password" }), next: h("input", { type: "password", autocomplete: "new-password", minlength: 8 }) };
  const pwBtn = h("button", { class: "primary", onclick: async () => {
    try { await api("POST", "/auth/password", { current: pw.current.value, next: pw.next.value }); pw.current.value = pw.next.value = ""; toast("Password changed."); } catch (e) { fail(e); }
  } }, "Change password");
  main.replaceChildren(
    pageHead("Profile & Admins", isStaff() ? "Your team" : clientName(),
      h("button", { onclick: async () => { await api("POST", "/auth/logout"); state.user = null; location.hash = "#/"; renderLogin(); } }, "Log out")),
    h("div", { class: "grid two" },
      h("div", { class: "card" }, h("h2", {}, "My profile"),
        h("dl", { class: "kv", style: "margin-bottom:1rem" }, h("dt", {}, "Email"), h("dd", {}, state.user.email), h("dt", {}, "Name"), h("dd", {}, state.user.name || "—"),
          h("dt", {}, "Role"), h("dd", {}, state.user.role), h("dt", {}, "Account"), h("dd", {}, isStaff() ? "Your team (all clients)" : clientName())),
        h("h3", {}, "Change password"), field("Current password", pw.current), field("New password (8+ characters)", pw.next), pwBtn),
      users ? usersCard(users, isStaff() ? "Admins (your team)" : "Admins & logins",
        isStaff() ? "Your staff see every client. A client's own logins are under that client → Logins." : "People who can log in to " + clientName() + ".") : null));
}

// ---------- download app ----------
async function renderDownload(main) {
  const apk = await api("GET", "/apk");
  const portalUrl = location.origin;
  main.replaceChildren(
    pageHead("Download App", "The Signage Player app for Android TVs, TV boxes and tablets"),
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
      h("div", { class: "card" }, h("h2", {}, "Tips for TVs on a wall"),
        h("ul", { class: "small", style: "padding-left:1.2rem;margin:0;line-height:1.7" },
          h("li", {}, "The app starts by itself when the TV or box powers on."),
          h("li", {}, "Press BACK three times on the remote for the player menu (portal address, kiosk mode, exit)."),
          h("li", {}, "Kiosk mode makes the player the home screen, so it can't be closed by accident."),
          h("li", {}, "Content is saved on the device and keeps playing if the internet drops."),
          h("li", {}, "Wired internet is more reliable than Wi-Fi for screens.")))));
}

// ---------- start ----------
(async () => {
  try { state.user = (await api("GET", "/auth/me")).user; await loadCustomers(); } catch (_) { state.user = null; }
  route();
})();
