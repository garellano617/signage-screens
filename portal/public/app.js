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
const statusPill = s => s.planned ? h("span", { class: "pill warn" }, h("span", { class: "dot" }), "No TV yet")
  : s.online
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
const state = { user: null, timer: null, customers: [], cid: null, brand: { name: "Signage", color: "#2563eb", logo: null } };

// ---------- white label ----------
/** The portal's logo + name (your own branding once set under White Label & Clients). */
function brandMark(suffix) {
  const b = state.brand;
  return h("div", { class: "brand" }, b.logo ? h("img", { src: b.logo, alt: "", class: "brand-logo" }) : h("span", { class: "brand-icon", html: LOGO }),
    h("span", {}, b.name + (suffix || "")));
}
function applyBrand() {
  const b = state.brand;
  document.title = b.name;
  document.documentElement.style.setProperty("--accent", b.color);
}
async function loadBrand() {
  try { state.brand = await (await fetch("/api/branding")).json(); } catch (_) {}
  applyBrand();
}
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
  billing: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20M6 15h4"/></svg>',
  reports: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
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
  [/^\/reports$/, "reports", renderReports],
  [/^\/billing$/, "billing", renderBilling],
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
  [/^\/reports$/, "reports", renderReports],
  [/^\/billing$/, "billing", renderBilling],
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
      link(base() + "/reports", "reports", "Reports"),
      link(base() + "/billing", "billing", "Billing"),
      isStaff() ? (isAdmin() ? link(base() + "/logins", "logins", "Logins") : null) : link("#/download", "download", "Download App"),
      isStaff() ? null : link("#/profile", "profile", "Profile & Admins")
    ];
  } else if (isStaff()) {
    links = [link("#/", "dashboard", "Dashboard"), link("#/clients", "clients", "White Label & Clients"),
      link("#/monitoring", "monitoring", "Screen Monitoring"), link("#/reports", "reports", "Reports"), link("#/billing", "billing", "Billing"), link("#/download", "download", "Download App"),
      link("#/profile", "profile", "Profile & Admins")];
  } else {
    // A client's login on Download App / Profile: same menu as inside their account.
    return shell(section, true);
  }
  const nav = h("nav", { class: "nav" + (inClient && isStaff() ? " in-client" : "") },
    brandMark(), links,
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
    brandMark(state.brand.name === "Signage" ? " Portal" : ""),
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
    pageHead("White Label & Clients", "Your branding, and the businesses you put screens in.",
      isAdmin() ? h("button", { class: "primary", onclick: () => clientDialog() }, "+ New client") : null),
    isAdmin() ? whiteLabelCard() : null,
    h("h2", { style: "margin:1.25rem 0 .75rem" }, "Clients"),
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

function whiteLabelCard() {
  const b = Object.assign({}, state.brand);
  const nameIn = h("input", { value: b.name, maxlength: 40, oninput: e => { b.name = e.target.value; preview(); } });
  const colorIn2 = h("input", { type: "color", value: b.color, oninput: e => { b.color = e.target.value; preview(); } });
  const pv = h("div", { class: "brand-preview" });
  const preview = () => {
    pv.style.setProperty("--accent", b.color);
    pv.replaceChildren(h("div", { class: "bp-nav" }, b.logo ? h("img", { src: b.logo, alt: "", class: "brand-logo" }) : h("span", { class: "brand-icon", html: LOGO }), h("strong", {}, b.name || "…")),
      h("div", { class: "bp-body" }, h("span", { class: "btn primary small", style: `background:${b.color};border-color:${b.color}` }, "Button"), h("span", { class: "pill", style: `color:${b.color}` }, "Link color")));
  };
  preview();
  const file = h("input", { type: "file", accept: "image/png,image/jpeg,image/webp", class: "hidden", onchange: async e => {
    const f = e.target.files[0]; if (!f) return;
    try {
      const res = await fetch("/api/branding/logo", { method: "POST", headers: { "Content-Type": f.type }, body: f });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || "Upload failed.");
      state.brand = d; b.logo = d.logo; preview(); toast("Logo uploaded."); route();
    } catch (ex) { fail(ex); }
  } });
  return h("div", { class: "card" },
    h("div", { class: "layer-head" }, h("div", {}, h("h2", { style: "margin:0" }, "White label"),
      h("div", { class: "small muted" }, "Your name, logo and color on the login page, the menu and the browser tab, for your team and your clients."))),
    h("div", { class: "grid two" },
      h("div", {},
        h("div", { class: "row" }, field("Portal name", nameIn), h("div", { class: "field", style: "flex:0 0 auto" }, h("label", {}, "Main color"), colorIn2)),
        h("div", { class: "field" }, h("label", {}, "Logo (PNG, JPG or WebP, up to 2 MB; square works best)"),
          h("div", { class: "cmds" }, h("button", { type: "button", class: "small", onclick: () => file.click() }, b.logo ? "Replace logo" : "Upload logo"),
            b.logo ? h("button", { type: "button", class: "small danger", onclick: async () => { try { state.brand = await api("DELETE", "/branding/logo"); applyBrand(); toast("Logo removed."); route(); } catch (e) { fail(e); } } }, "Remove logo") : null), file),
        h("button", { class: "primary", onclick: async () => {
          try { state.brand = await api("PUT", "/branding", { name: nameIn.value, color: colorIn2.value }); applyBrand(); toast("Branding saved."); route(); } catch (e) { fail(e); }
        } }, "Save branding")),
      pv));
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
      d.planned.length ? stat(d.planned.length, "Waiting for a TV", base() + "/screens") : null,
      stat(d.playlists, "Playlists", base() + "/playlists"), stat(d.media, "Media files · " + bytes(d.mediaBytes), base() + "/media")),
    h("div", { class: "grid two", style: "margin-top:1rem" },
      list("Offline screens", d.offline, d.screens ? "All screens are online. 👍" : "No screens yet. Click “Add screen” to pair a TV.", s => "Last seen " + ago(s.lastSeen)),
      list("Screens with nothing to play", d.noContent, "Every screen has a playlist.", () => "No playlist"),
      d.planned.length ? list("Set up, waiting for a TV", d.planned, "", () => "No TV yet") : null),
    c && isAdmin() ? h("div", { style: "margin-top:2rem;text-align:right" },
      h("button", { class: "small danger", onclick: () => deleteClient(c) }, "Delete this client")) : null);
  poll(() => renderDashboard(main).catch(() => {}), 60000);
}

// ---------- inside a client: screens ----------
function playlistOptions(playlists, selected, emptyLabel) {
  return [h("option", { value: "" }, emptyLabel), playlists.map(p => h("option", { value: p.id, selected: p.id === selected }, p.name))];
}

const codeInput = () => h("input", { name: "code", required: true, maxlength: 7, autocomplete: "off", style: "text-transform:uppercase;letter-spacing:.2em;font-size:1.3rem", placeholder: "ABC123" });

/** Add a screen: pair a TV now, or set the screen up now and connect its TV later. */
async function pairDialog() {
  const [playlists, screens] = await Promise.all([api("GET", "/playlists"), api("GET", "/screens")]);
  const planned = screens.filter(s => s.planned);
  let mode = "now";
  const code = codeInput();
  const into = h("select", { name: "screenId" }, h("option", { value: "" }, "A new screen"),
    planned.map(s => h("option", { value: s.id }, s.name + " (set up, waiting for its TV)")));
  const name = h("input", { name: "name", placeholder: "e.g. Lobby TV", maxlength: 100 });
  const details = h("div", {}, field("Screen name", name),
    field("Location", h("input", { name: "location", placeholder: "e.g. Main St store", maxlength: 200 })),
    field("Playlist", h("select", { name: "playlistId" }, playlistOptions(playlists, null, "— none yet —"))));
  const codeBox = h("div", {}, h("p", { class: "muted small" }, "Install the Signage Player app on the TV and open it. It shows a 6-character code. Type it here."),
    field("Pairing code", code), planned.length ? field("Connect it to", into) : null);
  const later = h("p", { class: "muted small hidden" }, "The screen is created now without a TV, so you can pick its playlist and schedule and design its layers ahead of time. When the TV is installed, open the screen and click Connect TV, then type the code the TV shows.");
  const sync = () => {
    codeBox.classList.toggle("hidden", mode !== "now"); later.classList.toggle("hidden", mode === "now");
    code.required = mode === "now"; name.required = mode !== "now";
    details.classList.toggle("hidden", mode === "now" && !!into.value);
    const btn = details.closest("form") && details.closest("form").querySelector("button[type=submit]");
    if (btn) btn.textContent = mode === "now" ? "Pair screen" : "Create screen";
  };
  into.addEventListener("change", sync);
  const modeBtns = h("div", { class: "seg" }, [["now", "Connect a TV now"], ["later", "Set up now, connect the TV later"]].map(([v, l]) =>
    h("button", { type: "button", class: v === mode ? "on" : "", onclick: e => {
      mode = v; modeBtns.querySelectorAll("button").forEach(b => b.classList.toggle("on", b === e.target)); sync();
    } }, l)));
  const r = await dialog("Add a screen for " + clientName(), h("div", {}, modeBtns, codeBox, later, details),
    { submit: "Pair screen", onSubmit: f => {
      const b = Object.fromEntries(f);
      if (mode === "later") return api("POST", "/screens/plan", { name: b.name, location: b.location, playlistId: b.playlistId || null });
      return api("POST", "/screens/pair", b.screenId ? { code: b.code, screenId: b.screenId } : b);
    } });
  if (!r) return;
  loadCustomers().catch(() => {});
  toast(r.planned ? "Screen created. Design it now, and connect the TV when it's installed." : "Screen paired. It will start playing within a few seconds.");
  go("/screens/" + r.id);
}

/** Connect the TV showing a code to this screen (the first TV for a planned screen, or a replacement TV). */
async function connectTvDialog(s) {
  const r = await dialog(s.planned ? "Connect the TV for " + s.name : "Replace the TV for " + s.name, h("div", {},
    h("p", { class: "muted small" }, s.planned
      ? "Open the Signage Player app on the TV. It shows a 6-character code. Type it here. The TV starts playing this screen's playlist and layers right away."
      : "Open the Signage Player app on the new TV and type the code it shows. It takes over this screen's playlist, schedule and layers. The old TV goes back to showing a pairing code."),
    field("Pairing code", codeInput())),
  { submit: "Connect TV", onSubmit: f => api("POST", "/screens/pair", { code: f.get("code"), screenId: s.id }) });
  if (r) { loadCustomers().catch(() => {}); toast("TV connected. It will start playing within a few seconds."); route(); }
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
        h("td", {}, statusPill(s), h("div", { class: "small muted" }, s.online || s.planned ? "" : ago(s.lastSeen))),
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

  const deviceCards = s.planned ? [
    h("div", { class: "card" }, h("h2", {}, "TV"),
      h("p", { class: "muted small" }, "No TV is connected yet. Set up the playlist, schedule and layers now. When the TV is installed, open the Signage Player app on it and type the code it shows."),
      h("button", { class: "primary", onclick: () => connectTvDialog(s) }, "Connect TV"))
  ] : [
    h("div", { class: "card" }, h("h2", {}, "Live view"), shotBox,
      h("div", { class: "cmds", style: "margin-top:.75rem" }, cmd("screenshot", "📷 Take screenshot", "Screenshot requested. It appears here within about 30 seconds."))),
    h("div", { class: "card" }, h("h2", {}, "Remote control"),
      h("div", { class: "cmds" },
        cmd("identify", "Show name on TV", "The screen name will flash on the TV."),
        cmd("reload", "Reload content", "The screen will reload its content."),
        cmd("clear_cache", "Clear cache & re-download", "The screen will clear its cache and download everything again."),
        cmd("restart_app", "Restart app", "The player app will restart.")),
      h("p", { class: "muted small", style: "margin-top:.75rem" }, "Commands reach the screen at its next check-in (within 30 seconds).")),
    h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Device"),
      h("button", { class: "small", onclick: () => connectTvDialog(s) }, "Replace TV")), dl)
  ];
  main.replaceChildren(
    h("a", { href: base() + "/screens", class: "back" }, "← All screens"),
    pageHead(s.name, [clientName(), s.location].filter(Boolean).join(" · "),
      s.planned ? h("button", { class: "primary", onclick: () => connectTvDialog(s) }, "Connect TV") : null,
      h("button", { class: "danger", onclick: async () => {
        if (!await confirmDlg("Remove this screen?", s.planned ? "Its playlist, schedule and layers will be deleted." : "The TV will go back to showing a pairing code. You can pair it again later.", "Remove")) return;
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
          h("div", { class: "row" }, h("button", { onclick: () => { slots.push({ playlistId: null, days: 127, start: "09:00", end: "17:00" }); drawSlots(); } }, "+ Add time slot"), schedSave))),
      h("div", { class: "stack" },
        s.channelId ? h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Layers"),
            h("a", { class: "btn small", href: base() + "/channels/" + s.channelId }, "Open channel")),
          h("p", { class: "small muted", style: "margin:0" }, "This screen uses the layers of the channel “" + s.channelName + "”.")) :
        h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Layers"),
            h("a", { class: "btn primary small", href: base() + "/screens/" + id + "/layers" }, "Design layers")),
          h("div", { class: "chips" }, [["video", "Video"], ["specials", "Specials"], ["text", "Text"], ["effects", "Effects"]].map(([k, l]) =>
            h("span", { class: "pill" + (s.layers[k].enabled ? " ok" : "") }, (s.layers[k].enabled ? "● " : "○ ") + l)))),
        ...deviceCards)));

  poll(async () => {
    try {
      const x = await api("GET", "/screens/" + id);
      if (x.planned !== s.planned) return route();
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

const FONT_LABELS = [["sans", "Sans"], ["serif", "Serif"], ["condensed", "Condensed"], ["mono", "Typewriter"], ["script", "Script"]];
const SIZE_EM = { s: 2, m: 2.8, l: 4.2, xl: 6.2 };
const TEXT_PRESETS = [
  ["Heading", "Your heading", { fs: 6, bold: true, bgOpacity: 0 }],
  ["Subheading", "A short subheading", { fs: 3.6, bold: true, bgOpacity: 0 }],
  ["Body text", "Add a little text", { fs: 2.2, bold: false, bgOpacity: 0 }],
  ["Price list", "Picanha      $11.99\nRib Eye      $10.99\nCostela       $9.99", { fs: 2.4, bold: true, font: "mono", bg: "#ffffff", bgOpacity: 85, color: "#111111" }],
  ["Label", "SALE", { fs: 2.6, bold: true, bg: "#b91c1c", bgOpacity: 100 }]
];
const fmtT = sec => Math.floor(sec / 60) + ":" + String(Math.floor(sec % 60)).padStart(2, "0");
const clampN = (v, a, b) => Math.min(b, Math.max(a, v));
const snapH = v => Math.round(v * 2) / 2;

/**
 * Layers editor for a screen, or for a channel (kind = "channel").
 * Toolbar for the selected item, side panel (media, text, specials, effects, video), live preview you can drag text
 * and pictures on, and a timeline with one track per layer. Text and picture bars can be moved to set when they show.
 */
async function renderLayers(main, id, kind) {
  const isCh = kind === "channel";
  const path = (isCh ? "/channels/" : "/screens/") + id;
  const [s, media, templates, aiStatus] = await Promise.all([api("GET", path), api("GET", "/media"),
    api("GET", "/layer-templates").catch(() => []), api("GET", "/ai/status").catch(() => ({ enabled: false }))]);
  if (!isCh && s.channelId) {
    // This screen's layers come from its channel.
    main.replaceChildren(h("a", { href: base() + "/screens/" + id, class: "back" }, "← " + s.name),
      h("div", { class: "card empty" }, h("p", {}, "“" + s.name + "” uses the channel “" + s.channelName + "”, so its layers are designed there."),
        h("a", { class: "btn primary", href: base() + "/channels/" + s.channelId + "/layers" }, "Design the channel's layers")));
    return;
  }
  const L = JSON.parse(JSON.stringify(s.layers));
  const images = media.filter(m => m.kind === "image");
  let items = [];
  if (s.playlistId) { try { items = (await api("GET", "/playlists/" + s.playlistId)).items || []; } catch (_) {} }
  const itemLen = it => Math.max(1, Number(it.duration) || 10);
  const loop = items.reduce((a, it) => a + itemLen(it), 0);
  const portrait = !isCh && (s.orientation === 90 || s.orientation === 270);
  const T = () => L.text.cycle || clampN(loop || 30, 10, 600);
  const blank = !L.specials.enabled && !L.text.enabled && !L.effects.enabled;
  let dirty = false, overlay = null, rt = 0, sel = null, tab = blank ? "templates" : "text", playhead = 0, playing = false, raf = 0, lastTs = 0, shownItem = null;
  let blockNodes = [];
  const isSel = (type, i) => !!sel && sel.type === type && (i === undefined || sel.i === i);
  // Dragging doesn't move the keyboard focus by itself; drop it so Delete works on the selected item.
  const unfocus = () => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); };

  // ---------- preview ----------
  const pvVideo = h("div", { class: "pv-video" });
  const pvOverlay = h("div", { class: "pv-overlay" });
  const preview = h("div", { class: "preview ed-preview" + (portrait ? " portrait" : "") }, h("div", { class: "pv-bg" }), pvVideo, pvOverlay);
  preview.addEventListener("pointerdown", e => { if (!e.target.closest(".so-text")) select(e.target.closest(".pv-video") ? { type: "video" } : null); });

  function itemAt(t) {
    if (!items.length) return -1;
    let x = t % loop;
    for (let i = 0; i < items.length; i++) { if (x < itemLen(items[i])) return i; x -= itemLen(items[i]); }
    return 0;
  }
  function drawVideo(force) {
    const r = SignageOverlay.REGIONS[L.video.region] || SignageOverlay.REGIONS.full;
    Object.assign(pvVideo.style, { left: r[0] + "%", top: r[1] + "%", width: r[2] + "%", height: r[3] + "%", display: L.video.enabled ? "" : "none" });
    pvVideo.classList.toggle("ed-selected", isSel("video"));
    const i = itemAt(playhead);
    if (i === shownItem && !force) return;
    shownItem = i;
    const it = items[i];
    pvVideo.replaceChildren(it && it.kind === "image" ? h("img", { src: it.src, alt: "" })
      : it && it.kind === "video" ? h("video", { src: it.src, muted: true, autoplay: true, loop: true, playsInline: true })
      : h("div", { class: "pv-placeholder" }, it ? it.name : "Video layer",
        h("small", {}, it ? (it.kind === "widget" ? "Widget" : "Web page") : s.playlistName ? "Playlist: " + s.playlistName : "No playlist yet")));
  }

  function hookBlock(node, b, i) {
    blockNodes[i] = node;
    node.style.pointerEvents = "auto";
    node.style.cursor = "move";
    node.classList.toggle("ed-selected", isSel("block", i));
    node.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation(); unfocus();
      if (!isSel("block", i)) select({ type: "block", i });
      const box = pvOverlay.getBoundingClientRect(), r = node.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const x0 = (r.left - box.left) / box.width * 100, y0 = (r.top - box.top) / box.height * 100;
      let moved = false;
      const mv = ev => {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
        moved = true;
        b.x = Math.round((x0 + (ev.clientX - sx) / box.width * 100) * 10) / 10;
        b.y = Math.round((y0 + (ev.clientY - sy) / box.height * 100) * 10) / 10;
        node.className = node.className.replace(/\bso-pos-\S+/, "").trim();
        node.classList.add("so-free");
        Object.assign(node.style, { left: b.x + "%", top: b.y + "%", right: "auto", bottom: "auto", transform: "none" });
      };
      const up = () => {
        window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
        if (moved) { change(); drawToolbar(); }
      };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    });
  }
  function renderOverlay() {
    if (overlay) overlay.destroy();
    blockNodes = [];
    overlay = SignageOverlay.render(pvOverlay, L, { time: () => playhead, onBlock: hookBlock });
  }
  const refresh = () => { clearTimeout(rt); rt = setTimeout(renderOverlay, 80); };
  const change = () => { dirty = true; saveBtn.textContent = "Save changes"; refresh(); drawTimeline(); };

  // ---------- selection ----------
  function select(next, keepTimeline) {
    sel = next;
    blockNodes.forEach((n, i) => n && n.classList.toggle("ed-selected", isSel("block", i)));
    pvVideo.classList.toggle("ed-selected", isSel("video"));
    if (sel) {
      const b = sel.type === "block" ? L.text.blocks[sel.i] : null;
      tab = b ? (b.kind === "image" ? "media" : "text") : sel.type === "ticker" ? "text" : sel.type;
    }
    drawToolbar(); drawSide();
    if (!keepTimeline) drawTimeline();
  }
  function addBlock(b) {
    L.text.enabled = true;
    L.text.blocks.push(Object.assign({ kind: "text", text: "", position: "center", x: 30, y: 40, w: 0, size: "m", fs: 2.8, font: "sans", align: "",
      bold: true, italic: false, color: "#ffffff", bg: "#000000", bgOpacity: 0, from: 0, to: 0, mediaId: null, image: null }, b));
    change();
    select({ type: "block", i: L.text.blocks.length - 1 });
  }
  function removeBlock(i) { L.text.blocks.splice(i, 1); sel = null; change(); select(null); }

  // ---------- toolbar ----------
  const toolbar = h("div", { class: "card ed-toolbar" });
  const tbBtn = (label, on, onclick, title) => h("button", { type: "button", class: "small" + (on ? " on" : ""), title: title || label, onclick }, label);
  const sw = (checked, onchange) => h("label", { class: "switch", title: "On / off" }, h("input", { type: "checkbox", checked, onchange: e => onchange(e.target.checked) }), h("span", {}));
  function drawToolbar() {
    const kids = [];
    if (isSel("block")) {
      const i = sel.i, b = L.text.blocks[i];
      const upd = fn => e => { fn(e); change(); };
      if (b.kind === "text") {
        kids.push(
          h("select", { title: "Font", onchange: upd(e => { b.font = e.target.value; }) }, opts(FONT_LABELS, b.font || "sans")),
          h("label", { class: "tb-num", title: "Text size" }, "Size", h("input", { type: "number", min: 1, max: 30, step: 0.2, value: b.fs || SIZE_EM[b.size] || 2.8,
            oninput: upd(e => { b.fs = clampN(Number(e.target.value) || 2.8, 1, 30); }) })),
          tbBtn("B", b.bold, () => { b.bold = !b.bold; change(); drawToolbar(); }, "Bold"),
          tbBtn("I", b.italic, () => { b.italic = !b.italic; change(); drawToolbar(); }, "Italic"),
          ...[["left", "⇤"], ["center", "↔"], ["right", "⇥"]].map(([a, l]) => tbBtn(l, b.align === a, () => { b.align = b.align === a ? "" : a; change(); drawToolbar(); }, "Align " + a)),
          colorIn(b.color, v => { b.color = v; change(); }, "Text"),
          colorIn(b.bg, v => { b.bg = v; if (!b.bgOpacity) { b.bgOpacity = 100; drawToolbar(); } change(); }, "Box"),
          h("label", { class: "tb-num", title: "Box opacity" }, "Box", h("input", { type: "range", min: 0, max: 100, value: b.bgOpacity, style: "width:80px", oninput: upd(e => { b.bgOpacity = Number(e.target.value); }) })),
          h("label", { class: "tb-num", title: "Width in % of the screen (0 = fit the text)" }, "Width", h("input", { type: "number", min: 0, max: 100, step: 1, value: b.w || 0,
            oninput: upd(e => { b.w = clampN(Number(e.target.value) || 0, 0, 100); }) })));
      } else {
        kids.push(h("strong", { class: "small" }, "Picture"),
          h("label", { class: "tb-num", title: "Width in % of the screen" }, "Width", h("input", { type: "range", min: 3, max: 100, value: b.w || 30, style: "width:120px",
            oninput: upd(e => { b.w = Number(e.target.value); }) })),
          colorIn(b.bg, v => { b.bg = v; if (!b.bgOpacity) { b.bgOpacity = 100; drawToolbar(); } change(); }, "Frame"),
          h("label", { class: "tb-num" }, "", h("input", { type: "range", min: 0, max: 100, value: b.bgOpacity, style: "width:70px", title: "Frame opacity", oninput: upd(e => { b.bgOpacity = Number(e.target.value); }) })));
      }
      const free = typeof b.x === "number";
      kids.push(
        h("select", { title: "Snap to a spot", onchange: e => { b.position = e.target.value; b.x = null; b.y = null; change(); drawToolbar(); } },
          free ? h("option", { value: "", selected: true }, "Placed by hand") : null, opts(POSITION_LABELS, free ? "" : b.position)),
        tbBtn("↑", false, () => { if (i < L.text.blocks.length - 1) { L.text.blocks.splice(i + 1, 0, L.text.blocks.splice(i, 1)[0]); sel.i = i + 1; change(); } }, "Bring forward"),
        tbBtn("↓", false, () => { if (i > 0) { L.text.blocks.splice(i - 1, 0, L.text.blocks.splice(i, 1)[0]); sel.i = i - 1; change(); } }, "Send backward"),
        tbBtn("Duplicate", false, () => {
          const c = JSON.parse(JSON.stringify(b));
          if (typeof c.x === "number") { c.x += 2; c.y += 2; }
          L.text.blocks.splice(i + 1, 0, c); change(); select({ type: "block", i: i + 1 });
        }),
        h("button", { type: "button", class: "small danger", onclick: () => removeBlock(i) }, "Delete"));
    } else if (isSel("video")) {
      kids.push(h("strong", { class: "small" }, "Video layer"), sw(L.video.enabled, v => { L.video.enabled = v; drawVideo(true); change(); }),
        field("", h("select", { onchange: e => { L.video.region = e.target.value; drawVideo(true); change(); } }, opts(REGION_LABELS, L.video.region))));
    } else if (sel) {
      const names = { specials: "Specials", ticker: "Scrolling ticker", effects: "Effects" };
      const obj = sel.type === "ticker" ? L.text.ticker : L[sel.type];
      kids.push(h("strong", { class: "small" }, names[sel.type]), sw(obj.enabled, v => { obj.enabled = v; if (v && sel.type === "ticker") L.text.enabled = true; change(); drawSide(); }),
        h("span", { class: "small muted" }, "Settings are in the panel on the left."));
    } else {
      kids.push(h("span", { class: "small muted" }, "Click something on the screen or a bar in the timeline to edit it. Drag text and pictures to move them."));
    }
    toolbar.replaceChildren(...kids);
  }

  // ---------- side panel ----------
  const TABS = [["templates", "Templates"], ["ai", "✨ AI"], ["media", "Media"], ["text", "Text"], ["specials", "Specials"], ["effects", "Effects"], ["video", "Video"]];
  let thumbs = [], undo = null, aiBusy = false, aiNote = "", aiPrompt = "";
  const LAYER_KEYS = ["video", "specials", "text", "effects"];
  /** Replace the whole design (template or AI). The previous one is kept for Undo until saved or replaced again. */
  function applyDesign(next, label) {
    undo = { layers: JSON.parse(JSON.stringify(L)), label };
    LAYER_KEYS.forEach(k => { L[k] = JSON.parse(JSON.stringify(next[k])); });
    sel = null; drawVideo(true); change(); select(null);
  }
  function undoBar() {
    if (!undo) return null;
    return h("div", { class: "ed-undo" }, h("span", { class: "small" }, undo.label + " applied. Not saved yet."),
      h("button", { type: "button", class: "small", onclick: () => {
        const prev = undo.layers; undo = null;
        LAYER_KEYS.forEach(k => { L[k] = prev[k]; });
        sel = null; drawVideo(true); change(); select(null);
      } }, "Undo"));
  }
  function templatesPanel() {
    const out = [undoBar(), h("p", { class: "small muted" }, "Pick a design to start from, then change the words, colors and positions. Your playlist keeps playing in the video area.")];
    const byCat = {};
    templates.forEach(tp => (byCat[tp.category] = byCat[tp.category] || []).push(tp));
    for (const [cat, list] of Object.entries(byCat)) {
      out.push(h("div", { class: "small muted ed-cat" }, cat));
      out.push(h("div", { class: "ed-templates" }, list.map(tp => {
        const ov = h("div", { class: "pv-overlay" });
        const r = SignageOverlay.REGIONS[tp.layers.video.region] || SignageOverlay.REGIONS.full;
        const box = h("div", { class: "preview ed-thumb" }, h("div", { class: "pv-bg" }),
          h("div", { class: "pv-video ed-thumb-video", style: `left:${r[0]}%;top:${r[1]}%;width:${r[2]}%;height:${r[3]}%` }), ov);
        // Thumbnails skip the animation; the effect is named under the picture instead.
        const still = JSON.parse(JSON.stringify(tp.layers)); still.effects.enabled = false;
        requestAnimationFrame(() => { if (ov.isConnected) thumbs.push(SignageOverlay.render(ov, still, { time: () => 2 })); });
        const fx = tp.layers.effects.enabled ? (EFFECT_LABELS.find(e => e[0] === tp.layers.effects.type) || [, ""])[1] : "";
        return h("button", { type: "button", class: "ed-template", title: tp.description, onclick: async () => {
          const has = L.specials.enabled || L.text.enabled || L.effects.enabled;
          if (has && !await confirmDlg("Use the “" + tp.name + "” template?", "It replaces this design. You can undo it until you save.", "Use template")) return;
          applyDesign(tp.layers, "Template “" + tp.name + "”");
          toast("Template applied. Change the words, then save.");
        } }, box, h("strong", { class: "small" }, tp.name), fx ? h("span", { class: "small muted" }, " · " + fx) : null);
      })));
    }
    return out;
  }
  const AI_EXAMPLES = ["Taco Tuesday: 3 tacos and a drink for $7.99, festive look",
    "Morning coffee menu: latte $4.50, cold brew $4, croissant $3.25",
    "Grand opening this Saturday at 10 AM, free samples all day",
    "Holiday hours: Dec 24 close at 3 PM, closed Dec 25, gift cards available"];
  function aiPanel() {
    const out = [undoBar()];
    if (!aiStatus.enabled) {
      out.push(h("div", { class: "sub-item" }, h("strong", {}, "The AI designer is off"),
        h("p", { class: "small muted" }, isStaff()
          ? "To turn it on, add ANTHROPIC_API_KEY (from console.anthropic.com) in Render → signage-portal → Environment. Each request is billed by Anthropic to that account, usually a few cents. Each client can make " + (aiStatus.limit || 40) + " requests a day (AI_DAILY_LIMIT)."
          : "Ask your provider to turn it on."),
        h("p", { class: "small muted" }, "Meanwhile, the Templates tab has ready-made designs.")));
      return out;
    }
    const ta = h("textarea", { rows: 5, maxlength: 2000, placeholder: "Describe the screen: what to promote, prices, dates, the look you want…",
      oninput: e => { aiPrompt = e.target.value; } }, aiPrompt);
    const note = h("p", { class: "small" }, aiNote);
    const go = mode => async () => {
      if (!ta.value.trim()) return fail(new Error("Describe what the screen should show first."));
      if (mode === "design" && (L.specials.enabled || L.text.enabled || L.effects.enabled)
        && !await confirmDlg("Replace this design?", "The AI makes a whole new design. You can undo it until you save.", "Design it")) return;
      aiBusy = true; aiNote = ""; drawSide();
      try {
        const r = await api("POST", "/ai/design", { prompt: ta.value, mode, current: L });
        aiStatus.left = r.left;
        aiNote = r.summary;
        applyDesign(r.layers, mode === "design" ? "AI design" : "AI words");
      } catch (e) { fail(e); } finally { aiBusy = false; drawSide(); }
    };
    if (aiNote) out.push(h("div", { class: "sub-item ed-ai-note" }, h("strong", { class: "small" }, "✨ "), note));
    out.push(h("p", { class: "small muted" }, "Describe the screen and Claude (AI) designs it with your words, prices and pictures. Check the result before saving: the AI only uses prices you give it."),
      field("What should the screen show?", ta),
      h("div", { class: "ed-examples" }, AI_EXAMPLES.map(x => h("button", { type: "button", class: "small", onclick: () => { aiPrompt = x; ta.value = x; } }, x))),
      aiBusy ? h("p", { class: "small" }, h("span", { class: "spinner" }), " The AI is designing… this takes about 20 to 60 seconds.")
        : h("div", { class: "stack", style: "gap:.5rem" },
          h("button", { type: "button", class: "primary", onclick: go("design") }, "✨ Design the whole screen"),
          h("button", { type: "button", onclick: go("content") }, "Write new words, keep my layout")),
      aiStatus.left !== null && aiStatus.left !== undefined ? h("p", { class: "small muted" }, aiStatus.left + " AI requests left today for this client.") : null);
    return out;
  }
  const tabsBar = h("div", { class: "ed-tabs" });
  const panel = h("div", { class: "ed-panel" });
  const side = h("div", { class: "card ed-side" }, tabsBar, panel);
  function timingFields(b) {
    const len = T();
    return h("div", { class: "row" },
      h("div", { class: "field" }, h("label", {}, "Show from (s)"), h("input", { type: "number", min: 0, max: len, step: 0.5, value: b.from || 0,
        oninput: e => { if (!L.text.cycle) L.text.cycle = len; b.from = clampN(Number(e.target.value) || 0, 0, len); if (b.to && b.to <= b.from) b.to = 0; change(); } })),
      h("div", { class: "field" }, h("label", {}, "Until (s)"), h("input", { type: "number", min: 0, max: len, step: 0.5, value: b.to || len,
        oninput: e => { if (!L.text.cycle) L.text.cycle = len; const v = clampN(Number(e.target.value) || len, 0, len); b.to = v >= len ? 0 : v; change(); } })));
  }
  function drawSide() {
    thumbs.forEach(o => o.destroy()); thumbs = [];
    tabsBar.replaceChildren(...TABS.map(([k, l]) => h("button", { type: "button", class: tab === k ? "on" : "", onclick: () => { tab = k; drawSide(); } }, l)));
    const kids = [];
    if (tab === "media") {
      const b = isSel("block") && L.text.blocks[sel.i].kind === "image" ? L.text.blocks[sel.i] : null;
      if (b) kids.push(h("div", { class: "sub-item" }, h("strong", { class: "small" }, "Selected picture"), timingFields(b)));
      kids.push(h("p", { class: "small muted" }, "Click a picture to place it on the screen (logos, food photos, price boards)."));
      kids.push(images.length ? h("div", { class: "ed-imgs" }, images.map(m => h("button", { type: "button", title: m.name,
        onclick: () => addBlock({ kind: "image", mediaId: m.id, image: { src: m.src, name: m.name }, w: 30, x: 35, y: 30, text: "" }) }, h("img", { src: m.src, alt: m.name, loading: "lazy" }))))
        : h("p", { class: "small" }, "No pictures yet. ", h("a", { href: base() + "/media" }, "Upload some in the Media library"), "."));
      kids.push(h("p", { class: "small muted" }, "Videos and the main slideshow play in the Video layer (the playlist)."));
    } else if (tab === "text") {
      const b = isSel("block") && L.text.blocks[sel.i].kind === "text" ? L.text.blocks[sel.i] : null;
      if (b) {
        kids.push(h("div", { class: "sub-item" },
          field("Selected text", h("textarea", { rows: 4, maxlength: 600, oninput: e => { b.text = e.target.value; change(); } }, b.text)),
          timingFields(b)));
      }
      kids.push(h("div", { class: "ed-presets" }, h("div", { class: "small muted", style: "margin-bottom:.4rem" }, "Add text"),
        TEXT_PRESETS.map(([label, text, st]) => h("button", { type: "button", onclick: () => addBlock(Object.assign({ text }, st)) },
          h("span", { style: "font-weight:" + (st.bold ? 700 : 400) + ";font-size:" + Math.min(1.3, 0.75 + st.fs / 12) + "rem" }, label)))));
      const tk = L.text.ticker;
      kids.push(h("div", { class: "layer-head", style: "margin-top:1rem" }, h("strong", {}, "Scrolling ticker"),
        sw(tk.enabled, v => { tk.enabled = v; if (v) L.text.enabled = true; change(); drawToolbar(); })),
        field("Messages (one per line)", h("textarea", { rows: 3, maxlength: 1000, placeholder: "Free Wi-Fi\nAsk about catering!", oninput: e => { tk.text = e.target.value; change(); } }, tk.text)),
        h("div", { class: "row" },
          field("Where", h("select", { onchange: e => { tk.position = e.target.value; change(); } }, opts([["bottom", "Bottom"], ["top", "Top"]], tk.position))),
          field("Speed", h("select", { onchange: e => { tk.speed = e.target.value; change(); } }, opts([["slow", "Slow"], ["normal", "Normal"], ["fast", "Fast"]], tk.speed))),
          field("Size", h("select", { onchange: e => { tk.size = e.target.value; change(); } }, opts(SIZE_LABELS, tk.size)))),
        h("div", { class: "colors" }, colorIn(tk.color, v => { tk.color = v; change(); }, "Text"), colorIn(tk.bg, v => { tk.bg = v; change(); }, "Bar")));
    } else if (tab === "templates") {
      kids.push(...templatesPanel().filter(Boolean));
    } else if (tab === "ai") {
      kids.push(...aiPanel().filter(Boolean));
    } else if (tab === "specials") {
      kids.push(specialsPanel());
    } else if (tab === "effects") {
      const ef = L.effects;
      kids.push(h("div", { class: "ed-fx" },
        h("button", { type: "button", class: ef.enabled ? "" : "on", onclick: () => { ef.enabled = false; change(); drawSide(); drawToolbar(); } }, "None"),
        EFFECT_LABELS.map(([v, l]) => h("button", { type: "button", class: ef.enabled && ef.type === v ? "on" : "",
          onclick: () => { ef.enabled = true; ef.type = v; change(); drawSide(); drawToolbar(); } }, l))),
        field("Amount", h("select", { onchange: e => { ef.intensity = e.target.value; change(); } }, opts([["light", "Light"], ["medium", "Medium"], ["heavy", "Heavy"]], ef.intensity))),
        h("div", { class: "colors" }, colorIn(ef.color, v => { ef.color = v; change(); }, "Color (snow, sparkles, bubbles, hearts, stars)")));
    } else {
      kids.push(h("div", { class: "layer-head" }, h("strong", {}, "Video layer"), sw(L.video.enabled, v => { L.video.enabled = v; drawVideo(true); change(); drawToolbar(); })),
        field("Area on the screen", h("select", { onchange: e => { L.video.region = e.target.value; drawVideo(true); change(); } }, opts(REGION_LABELS, L.video.region))),
        h("p", { class: "small muted" }, isCh ? "Plays the channel's playlist (" + (s.playlistName || "none yet") + ")." : "Plays this screen's playlist and schedule (" + (s.playlistName || "no playlist yet") + ").",
          " Use a smaller area to leave room for specials or a ticker."),
        h("a", { class: "btn small", href: base() + path }, isCh ? "Change the channel's playlist" : "Change the playlist or schedule"));
    }
    panel.replaceChildren(...kids);
  }

  function specialsPanel() {
    const sp = L.specials;
    const list = h("div", {});
    const draw = () => {
      list.replaceChildren(...sp.items.map((it, i) => h("div", { class: "sub-item" },
        h("div", { class: "row" },
          field("Title", h("input", { value: it.title, maxlength: 80, placeholder: "e.g. Taco Tuesday", oninput: e => { it.title = e.target.value; change(); } })),
          h("div", { class: "field", style: "flex:0 1 100px" }, h("label", {}, "Price"), h("input", { value: it.price, maxlength: 20, placeholder: "$2.99", oninput: e => { it.price = e.target.value; change(); } }))),
        field("Description", h("input", { value: it.description, maxlength: 200, placeholder: "optional", oninput: e => { it.description = e.target.value; change(); } })),
        field("Photo", h("select", { onchange: e => {
          const m = images.find(x => x.id === Number(e.target.value));
          it.mediaId = m ? m.id : null; it.image = m ? { src: m.src } : null; change();
        } }, h("option", { value: "" }, images.length ? "— no photo —" : "— upload images in Media first —"),
          images.map(m => h("option", { value: m.id, selected: m.id === it.mediaId }, m.name)))),
        h("div", { class: "days", style: "margin-bottom:.5rem" }, DAYS.map((d, b) => h("button", { type: "button", class: it.days & (1 << b) ? "on" : "",
          onclick: e => { const n = it.days ^ (1 << b); if (!n) return; it.days = n; e.target.classList.toggle("on"); change(); } }, d))),
        h("div", { class: "row", style: "align-items:center" },
          h("div", { class: "times" },
            h("input", { type: "time", value: it.start, "aria-label": "From", onchange: e => { it.start = e.target.value; change(); } }), "to",
            h("input", { type: "time", value: it.end, "aria-label": "Until", onchange: e => { it.end = e.target.value; change(); } })),
          h("button", { type: "button", class: "small danger", onclick: () => { sp.items.splice(i, 1); draw(); change(); } }, "Remove")))));
      if (!sp.items.length) list.append(h("p", { class: "small muted" }, "No specials yet."));
    };
    draw();
    return h("div", {},
      h("div", { class: "layer-head" }, h("strong", {}, "Specials"), sw(sp.enabled, v => { sp.enabled = v; change(); drawToolbar(); })),
      field("Heading", h("input", { value: sp.heading, maxlength: 60, oninput: e => { sp.heading = e.target.value; change(); } })),
      h("div", { class: "row" },
        field("Where", h("select", { onchange: e => { sp.position = e.target.value; change(); } }, opts(SPECIAL_POSITIONS, sp.position))),
        h("div", { class: "field", style: "flex:0 1 110px" }, h("label", {}, "Seconds each"),
          h("input", { type: "number", min: 3, max: 120, value: sp.seconds, oninput: e => { sp.seconds = clampN(Number(e.target.value) || 8, 3, 120); change(); } }))),
      h("div", { class: "colors" },
        colorIn(sp.bg, v => { sp.bg = v; change(); }, "Background"),
        colorIn(sp.color, v => { sp.color = v; change(); }, "Text"),
        colorIn(sp.accent, v => { sp.accent = v; change(); }, "Price & heading")),
      h("p", { class: "small muted" }, "Specials take turns. Leave the times empty to show a special all day."),
      list,
      h("button", { type: "button", onclick: () => { sp.enabled = true; sp.items.push({ title: "", price: "", description: "", mediaId: null, image: null, days: 127, start: "", end: "" }); draw(); change(); drawToolbar(); } }, "+ Add special"));
  }

  // ---------- timeline ----------
  const timeLabel = h("span", { class: "ed-time" });
  const playBtn = h("button", { type: "button", class: "ed-play", title: "Play / pause", onclick: () => setPlaying(!playing) }, "▶");
  const tlBody = h("div", { class: "tl-body" });
  const cycleIn = h("input", { type: "number", min: 5, max: 3600, step: 1, style: "width:80px",
    onchange: e => { const v = Math.round(Number(e.target.value)); L.text.cycle = v >= 5 ? Math.min(3600, v) : 0;
      L.text.blocks.forEach(b => { if (b.from >= T()) b.from = 0; if (b.to > T()) b.to = 0; }); playhead = playhead % T(); change(); } });
  const timeline = h("div", { class: "card ed-timeline" },
    h("div", { class: "tl-head" }, playBtn, timeLabel,
      h("label", { class: "tb-num" }, "Timeline length (s)", cycleIn),
      h("span", { class: "small muted" }, "On the TV, timed text and pictures repeat every " + "this many seconds.")),
    tlBody);

  function updatePlayhead() {
    const len = T();
    tlBody.style.setProperty("--p", String(playhead / len));
    timeLabel.textContent = fmtT(playhead) + " / " + fmtT(len);
    drawVideo();
  }
  function setPlaying(on) {
    playing = on; playBtn.textContent = on ? "❚❚" : "▶"; lastTs = 0;
    cancelAnimationFrame(raf);
    if (on) raf = requestAnimationFrame(function step(ts) {
      if (!playing) return;
      if (lastTs) playhead = (playhead + (ts - lastTs) / 1000) % T();
      lastTs = ts; updatePlayhead();
      raf = requestAnimationFrame(step);
    });
  }
  function seekFrom(e, lane) {
    const r = lane.getBoundingClientRect();
    playhead = clampN((e.clientX - r.left) / r.width, 0, 0.999) * T();
    updatePlayhead();
  }
  function tlClip(cls, from, to, label, len, extra) {
    const c = h("div", Object.assign({ class: "tl-clip " + cls, title: label }, extra || {}), label);
    c.style.left = (from / len * 100) + "%";
    c.style.width = Math.max(0.5, (Math.min(to, len) - from) / len * 100) + "%";
    return c;
  }
  function row(name, type, on, toggle, clips, group) {
    const lane = h("div", { class: "tl-lane", onpointerdown: e => { if (e.target === lane) { seekFrom(e, lane); if (type) select({ type }); } } }, clips);
    return h("div", { class: "tl-row" + (group ? " tl-group" : "") },
      h("div", { class: "tl-name", onclick: () => type && select({ type }) },
        toggle ? h("input", { type: "checkbox", checked: on, title: "On / off", onclick: e => e.stopPropagation(), onchange: e => { toggle(e.target.checked); change(); drawToolbar(); drawSide(); } }) : null,
        h("span", {}, name)),
      lane);
  }
  function barDrag(e, b, i, mode) {
    e.preventDefault(); e.stopPropagation(); unfocus();
    const bar = e.currentTarget.closest(".tl-clip"), lane = bar.parentNode;
    if (!isSel("block", i)) { select({ type: "block", i }, true); tlBody.querySelectorAll(".tl-clip.sel").forEach(x => x.classList.remove("sel")); bar.classList.add("sel"); }
    const len = T();
    const w = lane.getBoundingClientRect().width, sx = e.clientX;
    const f0 = b.from || 0, t0 = b.to || len;
    let moved = false;
    const mv = ev => {
      const d = (ev.clientX - sx) / w * len;
      if (!moved && Math.abs(ev.clientX - sx) < 3) return;
      moved = true;
      let f = f0, t = t0;
      if (mode === "move") { f = snapH(clampN(f0 + d, 0, len - (t0 - f0))); t = f + (t0 - f0); }
      else if (mode === "l") f = snapH(clampN(f0 + d, 0, t0 - 0.5));
      else t = snapH(clampN(t0 + d, f0 + 0.5, len));
      b.from = f; b.to = t;
      bar.style.left = (f / len * 100) + "%"; bar.style.width = ((t - f) / len * 100) + "%";
      bar.title = fmtT(f) + " – " + fmtT(t);
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      if (!moved) return;
      if (!L.text.cycle) L.text.cycle = len;
      if (b.from <= 0 && b.to >= len) { b.from = 0; b.to = 0; }
      change(); drawSide();
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }
  function drawTimeline() {
    const len = T();
    cycleIn.value = len;
    const step = len <= 20 ? 2 : len <= 60 ? 5 : len <= 180 ? 15 : len <= 600 ? 60 : 300;
    const ticks = [];
    for (let t = 0; t < len; t += step) ticks.push(h("span", { class: "tl-tick", style: "left:" + (t / len * 100) + "%" }, fmtT(t)));
    const rows = [row("", null, false, null, ticks)];
    rows[0].classList.add("tl-ruler");
    // video: the playlist, repeated to fill the timeline
    const vClips = [];
    if (items.length) {
      for (let t = 0, k = 0; t < len && k < 400; k++) {
        const it = items[k % items.length], d = itemLen(it);
        vClips.push(tlClip("tl-video" + (L.video.enabled ? "" : " off") + (isSel("video") ? " sel" : ""), t, t + d, it.name, len, { onpointerdown: e => { e.stopPropagation(); seekFrom(e, e.currentTarget.parentNode); select({ type: "video" }); } }));
        t += d;
      }
    }
    rows.push(row("Video", "video", L.video.enabled, v => { L.video.enabled = v; drawVideo(true); }, vClips));
    // specials: each one for `seconds`, taking turns
    const sp = L.specials, spClips = [];
    if (sp.items.length) {
      for (let t = 0, k = 0; t < len && k < 400; k++, t += sp.seconds) {
        const it = sp.items[k % sp.items.length];
        spClips.push(tlClip("tl-specials" + (sp.enabled ? "" : " off") + (isSel("specials") ? " sel" : ""), t, t + sp.seconds, it.title || it.price || "Special", len,
          { onpointerdown: e => { e.stopPropagation(); select({ type: "specials" }); } }));
      }
    }
    rows.push(row("Specials", "specials", sp.enabled, v => { sp.enabled = v; }, spClips));
    // text and pictures: one row each, top of the stack first
    rows.push(row("Text & pictures", null, L.text.enabled, v => { L.text.enabled = v; }, [], true));
    for (let i = L.text.blocks.length - 1; i >= 0; i--) {
      const b = L.text.blocks[i];
      const label = b.kind === "image" ? "🖼 " + ((b.image && b.image.name) || "Picture") : (b.text.split("\n")[0] || "Text");
      const bar = tlClip((b.kind === "image" ? "tl-image" : "tl-text") + (L.text.enabled ? "" : " off") + (isSel("block", i) ? " sel" : ""),
        b.from || 0, b.to || len, label, len, { onpointerdown: e => barDrag(e, b, i, "move") });
      bar.append(h("span", { class: "tl-h l", onpointerdown: e => barDrag(e, b, i, "l") }), h("span", { class: "tl-h r", onpointerdown: e => barDrag(e, b, i, "r") }));
      const r = row(label, null, false, null, [bar]);
      r.querySelector(".tl-name").addEventListener("click", () => select({ type: "block", i }));
      rows.push(r);
    }
    if (!L.text.blocks.length) rows.push(row("", null, false, null, [h("span", { class: "tl-empty" }, "Add text or pictures from the panel on the left.")]));
    const tk = L.text.ticker;
    rows.push(row("Ticker", "ticker", tk.enabled, v => { tk.enabled = v; if (v) L.text.enabled = true; },
      tk.enabled || tk.text ? [tlClip("tl-ticker" + (tk.enabled && L.text.enabled ? "" : " off") + (isSel("ticker") ? " sel" : ""), 0, len, (tk.text || "").split("\n").join("  •  ") || "Ticker", len,
        { onpointerdown: e => { e.stopPropagation(); select({ type: "ticker" }); } })] : []));
    const ef = L.effects;
    rows.push(row("Effects", "effects", ef.enabled, v => { ef.enabled = v; },
      [tlClip("tl-effects" + (ef.enabled ? "" : " off") + (isSel("effects") ? " sel" : ""), 0, len, (EFFECT_LABELS.find(x => x[0] === ef.type) || ["", ""])[1], len,
        { onpointerdown: e => { e.stopPropagation(); select({ type: "effects" }); } })]));
    tlBody.replaceChildren(...rows, h("div", { class: "tl-playhead" }));
    rows[0].querySelector(".tl-lane").addEventListener("pointerdown", e => seekFrom(e, e.currentTarget));
    if (playhead >= len) playhead = 0;
    updatePlayhead();
  }

  // ---------- save ----------
  const saveBtn = h("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      const saved = await api("PUT", path + "/layers", L);
      dirty = false; saveBtn.textContent = "Saved";
      if (undo) { undo = null; if (tab === "templates" || tab === "ai") drawSide(); }
      toast(isCh ? "Layers saved. Every screen on this channel updates within 30 seconds." : "Layers saved. The screen updates within 30 seconds.");
      // The server drops empty text and unknown pictures: reload if it changed anything we show.
      if (saved.text.blocks.length !== L.text.blocks.length || saved.specials.items.length !== L.specials.items.length) route();
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save");

  const onKey = e => {
    if (!isSel("block") || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ""))) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeBlock(sel.i); }
  };
  document.addEventListener("keydown", onKey);

  main.replaceChildren(
    h("a", { href: base() + path, class: "back", onclick: e => { if (dirty && !confirm("Leave without saving your changes?")) e.preventDefault(); } }, "← " + s.name),
    pageHead("Design", (isCh ? "Channel " : "") + s.name + " · " + clientName(), saveBtn),
    h("div", { class: "ed" },
      toolbar, side,
      h("div", { class: "card ed-stage" }, preview,
        h("p", { class: "small muted", style: "margin:.5rem 0 0" }, "Bottom to top: Video → Specials → Text & pictures → Effects.")),
      timeline));
  drawToolbar(); drawSide(); drawTimeline(); drawVideo(true); renderOverlay();
  window.onbeforeunload = () => (dirty ? true : undefined);
  // Stop the preview animations when leaving the page.
  const stop = () => { setPlaying(false); if (overlay) overlay.destroy(); document.removeEventListener("keydown", onKey); window.removeEventListener("hashchange", stop); };
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
    { title: "Connect a TV", done: screens.some(s => !s.planned), text: screens.some(s => !s.planned) ? `${screens.filter(s => !s.planned).length} screen(s) connected.`
        : screens.length ? "Your screen is set up. Install the player app on the TV, open it, then click Connect TV on the screen's page and type the code it shows."
        : "Install the player app on the TV, open it, and type the code it shows. No TV yet? Choose “Set up now, connect the TV later” to design the screen first.",
      action: () => pairDialog(), label: "Add screen", alt: [isStaff() ? "#/download" : "#/download", "Get the app"] },
    { title: "Design the screen", done: layered, text: layered ? "Your first screen has extra layers (specials, text or effects)." : "Add specials with prices, a scrolling ticker, text or effects on top of your playlist.",
      action: () => screens.length ? go("/screens/" + screens[0].id + "/layers") : fail(new Error("Add a screen first (step 3). It can be set up before the TV is connected.")), label: "Design layers", optional: true }
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

// ---------- reports (proof of play) ----------
const hours = sec => sec >= 3600 ? (sec / 3600).toFixed(sec >= 36000 ? 0 : 1) + " h" : Math.round(sec / 60) + " min";
const isoDay = d => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 10);
const reportState = { from: null, to: null, screenId: "" };

async function renderReports(main) {
  const inClient = !isStaff() || state.cid;
  if (!reportState.to) { const d = new Date(); reportState.to = isoDay(d); d.setDate(d.getDate() - 6); reportState.from = isoDay(d); }
  const q = () => new URLSearchParams({ from: reportState.from, to: reportState.to, tz: new Date().getTimezoneOffset(), ...(reportState.screenId ? { screenId: reportState.screenId } : {}) });
  const [r, screens] = await Promise.all([api("GET", "/reports?" + q()), api("GET", "/screens")]);
  const preset = days => () => { const d = new Date(); reportState.to = isoDay(d); d.setDate(d.getDate() - days + 1); reportState.from = isoDay(d); route(); };
  const fromIn = h("input", { type: "date", value: reportState.from, onchange: e => { reportState.from = e.target.value; route(); } });
  const toIn = h("input", { type: "date", value: reportState.to, onchange: e => { reportState.to = e.target.value; route(); } });
  const scrSel = h("select", { onchange: e => { reportState.screenId = e.target.value; route(); } }, h("option", { value: "" }, "All screens"),
    screens.map(s => h("option", { value: s.id, selected: String(s.id) === String(reportState.screenId) }, (inClient ? "" : s.customerName + ": ") + s.name)));
  const csvHref = "/api/reports.csv?" + q() + (isStaff() && state.cid ? "&customerId=" + state.cid : "");
  const max = Math.max(1, ...r.byDay.map(d => d.plays));
  const screenLink = s => (isStaff() ? "#/c/" + s.customerId : "#") + "/screens/" + s.screenId;
  const kindLabel = k => ({ image: "Image", video: "Video", web: "Web page", widget: "Widget" }[k] || k || "—");

  main.replaceChildren(
    pageHead("Reports", (inClient ? clientName() : "All clients") + " · proof of play", h("a", { class: "btn", href: csvHref }, "⬇ Export CSV")),
    h("div", { class: "card" },
      h("div", { class: "row", style: "align-items:end" },
        h("div", { class: "field", style: "flex:0 1 170px" }, h("label", {}, "From"), fromIn),
        h("div", { class: "field", style: "flex:0 1 170px" }, h("label", {}, "To"), toIn),
        h("div", { class: "field", style: "flex:1 1 200px" }, h("label", {}, "Screen"), scrSel),
        h("div", { class: "field", style: "flex:0 0 auto" }, h("label", {}, "Quick pick"),
          h("div", { class: "cmds" }, h("button", { class: "small", onclick: preset(1) }, "Today"), h("button", { class: "small", onclick: preset(7) }, "7 days"), h("button", { class: "small", onclick: preset(30) }, "30 days"))))),
    h("div", { class: "grid stats", style: "margin:1rem 0" },
      stat(r.totals.plays.toLocaleString(), "Plays"), stat(hours(r.totals.seconds), "Time on screen"),
      stat(r.totals.screens, "Screens reporting"), stat(r.totals.items, "Different items")),
    h("div", { class: "card" }, h("h2", {}, "Plays per day"),
      r.totals.plays ? h("div", { class: "day-chart" }, r.byDay.map(d => h("div", { class: "day-col", title: `${d.day}: ${d.plays} plays, ${hours(d.seconds || 0)}` },
        h("div", { class: "day-val" }, d.plays ? d.plays : ""), h("div", { class: "day-bar", style: `height:${d.plays / max * 100}%` }),
        h("div", { class: "day-lbl" }, new Date(d.day + "T12:00").toLocaleDateString(undefined, r.byDay.length > 14 ? { day: "numeric" } : { weekday: "short", day: "numeric" })))))
        : h("p", { class: "muted" }, "Nothing played in this period. Screens send what they played with every check-in (this needs the latest player app).")),
    h("div", { class: "grid two", style: "margin-top:1rem" },
      h("div", { class: "card table-wrap" }, h("h2", {}, "By content"),
        r.byMedia.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Content"), h("th", {}, "Plays"), h("th", {}, "Time"), h("th", {}, "Screens"))),
          h("tbody", {}, r.byMedia.map(m => h("tr", {}, h("td", {}, h("strong", {}, m.name || "(deleted)"), h("div", { class: "small muted" }, [kindLabel(m.kind), inClient ? null : m.customerName].filter(Boolean).join(" · "))),
            h("td", {}, m.plays.toLocaleString()), h("td", {}, hours(m.seconds)), h("td", {}, m.screens))))) : h("p", { class: "muted" }, "—")),
      h("div", { class: "card table-wrap" }, h("h2", {}, "By screen"),
        r.byScreen.length ? h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Screen"), h("th", {}, "Plays"), h("th", {}, "Time"), h("th", {}, "Last play"))),
          h("tbody", {}, r.byScreen.map(s => h("tr", { class: "click", onclick: () => (location.hash = screenLink(s)) },
            h("td", {}, h("strong", {}, s.name), inClient ? null : h("div", { class: "small muted" }, s.customerName)),
            h("td", {}, s.plays.toLocaleString()), h("td", {}, hours(s.seconds)), h("td", { class: "small muted" }, ago(s.lastPlay)))))) : h("p", { class: "muted" }, "—"))));
}

// ---------- billing (from the Premier Signage Billing app) ----------
const money = n => "$" + (Number(n) || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const INVOICE = { paid: ["ok", "Paid"], upcoming: ["", "Upcoming"], due: ["warn", "Due"], partial: ["warn", "Partly paid"], overdue: ["danger", "Overdue"] };
const invoicePill = b => {
  if (!b) return h("span", { class: "muted" }, "—");
  if (b.overdue && b.overdue.balance > 0) return h("span", { class: "pill danger" }, "Overdue " + money(b.overdue.balance));
  if (!b.thisMonth) return h("span", { class: "pill" }, ({ pending: "Awaiting setup", paused: "Paused", cancelled: "Cancelled" })[b.status] || "Not billed");
  const [cls, label] = INVOICE[b.thisMonth.status] || ["", b.thisMonth.status];
  return h("span", { class: "pill " + cls }, label);
};
const dateText = d => d ? new Date(d + "T12:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : "—";

async function renderBilling(main) {
  const inClient = !isStaff() || state.cid;
  const d = await api("GET", "/billing");
  const head = pageHead("Billing", inClient ? clientName() : "All clients",
    isStaff() && d.billingUrl ? h("a", { class: "btn", href: d.billingUrl, target: "_blank", rel: "noopener" }, "Open billing app ↗") : null);

  if (!d.configured) {
    main.replaceChildren(head, h("div", { class: "card" },
      isStaff() ? [h("h2", {}, "Connect your billing app"),
        h("p", {}, "This page shows each client's plan, monthly amount and whether they're paid up, read from your Premier Signage Billing app. It only reads; payments stay in the billing app."),
        h("ol", { style: "padding-left:1.2rem;line-height:1.8" },
          h("li", {}, "Make up a long random key (40+ characters)."),
          h("li", {}, "In the billing app's host, set ", h("span", { class: "mono" }, "SIGNAGE_INTEGRATION_KEY"), " to that key."),
          h("li", {}, "In this portal's host (Render → Environment), set ", h("span", { class: "mono" }, "BILLING_URL"), " to the billing app's address and ", h("span", { class: "mono" }, "BILLING_KEY"), " to the same key."),
          h("li", {}, "Come back here and link each client."))]
        : h("p", { class: "muted" }, "Billing details aren't available yet.")));
    return;
  }
  const warn = !d.ok ? h("div", { class: "card", style: "border-color:var(--danger);margin-bottom:1rem" }, h("strong", { style: "color:var(--danger)" }, "⚠ "), d.error,
    d.stale ? h("span", { class: "muted" }, " Showing the last details received " + ago(d.at) + ".") : null) : null;

  if (inClient) {
    const row = d.rows[0] || {};
    const b = row.billing;
    main.replaceChildren(head, warn || "",
      !b ? h("div", { class: "card empty" }, isStaff()
          ? [h("p", {}, row.linked ? "This client's record wasn't found in the billing app." : "This client isn't linked to the billing app yet."), linkControl(row, d.choices)]
          : "Billing details aren't available yet.")
        : h("div", { class: "stack" },
          h("div", { class: "grid stats" },
            stat(money(b.monthly), "Monthly" + (b.plan ? " · " + b.plan + " plan" : "")),
            stat(b.screens, "Screens on plan"),
            h("div", { class: "card stat" }, h("div", { class: "num", style: "font-size:1.3rem;padding:.35rem 0" }, invoicePill(b)), h("div", { class: "lbl" }, b.thisMonth ? "This month · due " + dateText(b.thisMonth.due) : "This month")),
            stat(b.lastPayment ? money(b.lastPayment.amount) : "—", b.lastPayment ? "Last payment · " + dateText(b.lastPayment.date) : "Last payment")),
          h("div", { class: "card" }, h("h2", {}, "Details"), h("dl", { class: "kv" },
            h("dt", {}, "Pays by"), h("dd", {}, b.payMethod === "ach" ? "Bank account (ACH)" : b.payMethod === "card" ? "Card" : "Not set up yet"),
            h("dt", {}, "Automatic payments"), h("dd", {}, b.autopay ? "On" : "Off"),
            h("dt", {}, "Billing day"), h("dd", {}, b.billingDay ? "The " + b.billingDay + ordinal(b.billingDay) + " of each month" : "—"),
            b.thisMonth ? [h("dt", {}, "This month"), h("dd", {}, money(b.thisMonth.amount) + (b.thisMonth.paid ? " · paid " + money(b.thisMonth.paid) : "") + (b.thisMonth.balance ? " · balance " + money(b.thisMonth.balance) : ""))] : null,
            b.overdue && b.overdue.invoices ? [h("dt", {}, "Overdue"), h("dd", { style: "color:var(--danger)" }, money(b.overdue.balance) + " (" + b.overdue.invoices + " invoice" + (b.overdue.invoices > 1 ? "s" : "") + ", oldest due " + dateText(b.overdue.oldestDue) + ")")] : null),
            isStaff() ? h("div", { style: "margin-top:1rem" }, linkControl(row, d.choices)) : null)));
    return;
  }

  // Your team, all clients
  const linked = d.rows.filter(r => r.billing);
  const mrr = linked.filter(r => r.billing.status === "active").reduce((a, r) => a + (Number(r.billing.monthly) || 0), 0);
  const overdue = linked.filter(r => r.billing.overdue && r.billing.overdue.balance > 0);
  main.replaceChildren(head, warn || "",
    h("div", { class: "grid stats", style: "margin-bottom:1rem" },
      stat(money(mrr), "Monthly recurring"), stat(money(overdue.reduce((a, r) => a + r.billing.overdue.balance, 0)), "Overdue"),
      stat(overdue.length, "Clients overdue"), stat(d.rows.filter(r => !r.linked).length, "Not linked yet")),
    h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Client"), h("th", {}, "Plan"), h("th", {}, "Status"), h("th", {}, "Last payment"), h("th", {}, "Billing app record"))),
      h("tbody", {}, d.rows.map(r => h("tr", {},
        h("td", {}, h("a", { href: "#/c/" + r.customerId + "/billing" }, h("strong", {}, r.name))),
        h("td", { class: "small" }, r.billing ? [money(r.billing.monthly) + "/mo", h("div", { class: "muted" }, [r.billing.plan, r.billing.screens + " screens"].filter(Boolean).join(" · "))] : "—"),
        h("td", {}, invoicePill(r.billing)),
        h("td", { class: "small muted" }, r.billing && r.billing.lastPayment ? money(r.billing.lastPayment.amount) + " · " + dateText(r.billing.lastPayment.date) : "—"),
        h("td", {}, linkControl(r, d.choices))))))),
    d.unlinked && d.unlinked.length ? h("p", { class: "small muted", style: "margin-top:.75rem" },
      "In the billing app but not linked to a client here: " + d.unlinked.map(u => u.name).join(", ") + ".") : null);
}

function ordinal(n) { const s = ["th", "st", "nd", "rd"], v = n % 100; return s[(v - 20) % 10] || s[v] || s[0]; }

/** Pick which billing-app client this signage client is (your team's admins). */
function linkControl(row, choices) {
  if (!isAdmin() || !choices) return row.linked ? h("span", { class: "small muted" }, row.missing ? "⚠ Linked record not found" : "Linked") : null;
  const save = async id => {
    try { await api("PUT", "/customers/" + row.customerId + "/billing-link", { billingClientId: id || null }, { "X-Customer-Id": "" }); toast(id ? "Linked." : "Unlinked."); route(); }
    catch (e) { fail(e); }
  };
  const sel = h("select", { class: "link-select", onchange: e => save(e.target.value) },
    h("option", { value: "" }, row.linked ? "— unlink —" : "— not linked —"),
    choices.map(c => h("option", { value: c.id, selected: row.billing && row.billing.id === c.id }, c.name)));
  if (row.linked && !row.billing) sel.prepend(h("option", { value: "", selected: true, disabled: true }, "⚠ record not found"));
  return h("div", { class: "link-cell" }, sel,
    row.suggest ? h("button", { class: "small primary", onclick: () => save(row.suggest.id) }, "Link to “" + row.suggest.name + "”") : null);
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
  await loadBrand();
  try { state.user = (await api("GET", "/auth/me")).user; await loadCustomers(); } catch (_) { state.user = null; }
  route();
})();
