"use strict";
/* Signage Portal: single-page app, hash routing, no build step.
 *
 * Your team:      #/ (overview of all clients), #/clients, #/settings
 *                 #/c/<clientId>/...   inside one client: overview, screens, playlists, media, logins
 * A client login: #/ , #/screens, #/playlists, #/media, #/logins, #/settings (always their own client)
 */

// ---------- helpers ----------
// Pages pass null for optional parts (like h() allows); the browser's replaceChildren/append would print "null".
for (const name of ["replaceChildren", "append", "prepend"]) {
  const orig = Element.prototype[name];
  Element.prototype[name] = function (...kids) { return orig.apply(this, kids.flat(Infinity).filter(k => k !== null && k !== undefined && k !== false)); };
}
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
  // Files (FormData) go as they are; everything else as JSON.
  if (body instanceof FormData) opt.body = body;
  else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch("/api" + url, opt);
  let data = null;
  try { data = await res.json(); } catch (_) {}
  if (res.status === 401 && !/^\/auth\/(login|signup|forgot|reset)/.test(url)) { state.user = null; renderLogin(); throw new Error("Please log in."); }
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
  // Home-screen shortcut: its name and icons (new icons after a branding change: ?v=).
  const v = "?v=" + (b.iconVersion || "0");
  const setHead = (sel, attr, val) => { const e = document.querySelector(sel); if (e) e.setAttribute(attr, val); };
  setHead("meta[name=apple-mobile-web-app-title]", "content", b.name.length <= 12 ? b.name : (b.iconWord || "Signage").charAt(0) + (b.iconWord || "Signage").slice(1).toLowerCase());
  setHead("meta[name=theme-color]", "content", b.color);
  setHead("link[rel=apple-touch-icon]", "href", "/icons/180.png" + v);
  setHead("link[rel=icon][sizes]", "href", "/icons/32.png" + v);
  setHead("link[rel=manifest]", "href", "/manifest.webmanifest" + v);
}

/**
 * The home-screen icon: the logo (or the TV mark) on white, with the icon word under it in the main color.
 * Returns PNG data URLs by size. Kept inside the middle 80% so Android's round/squircle masks don't cut it.
 */
async function makeIcons(b) {
  const big = document.createElement("canvas"); big.width = big.height = 512;
  const g = big.getContext("2d");
  g.fillStyle = "#ffffff"; g.fillRect(0, 0, 512, 512);
  const word = (b.iconWord || "").trim();
  const box = { x: 70, y: word ? 84 : 102, w: 372, h: word ? 236 : 308 };
  const load = src => new Promise((res, rej) => { const im = new Image(); im.onload = () => res(im); im.onerror = rej; im.src = src; });
  let im;
  try { im = b.logo ? await load(b.logo) : await load("data:image/svg+xml," + encodeURIComponent(LOGO.replace(/#2563eb/g, b.color).replace("<svg ", '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" '))); } catch (_) { im = null; }
  if (im) {
    const k = Math.min(box.w / im.width, box.h / im.height);
    const w = im.width * k, hh = im.height * k;
    g.drawImage(im, box.x + (box.w - w) / 2, box.y + (box.h - hh) / 2, w, hh);
  }
  if (word) {
    g.fillStyle = b.color; g.textAlign = "center"; g.textBaseline = "alphabetic";
    let fs = 78;
    const font = s => "800 " + s + "px system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
    g.font = font(fs);
    if ("letterSpacing" in g) g.letterSpacing = "3px";
    while (g.measureText(word).width > 340 && fs > 30) g.font = font(--fs);
    g.fillText(word, 256, 404);
  }
  const out = {};
  for (const s of [512, 192, 180, 32]) {
    const c = document.createElement("canvas"); c.width = c.height = s;
    const cg = c.getContext("2d"); cg.imageSmoothingQuality = "high";
    if (s === 32) { cg.drawImage(big, 72, 72, 368, 368, 0, 0, 32, 32); } // tiny tab icon: mostly the logo
    else cg.drawImage(big, 0, 0, s, s);
    out[s] = c.toDataURL("image/png");
  }
  return out;
}
/** After a branding change (or the first time), an admin's browser draws and saves the icons. */
async function refreshIcons() {
  const b = state.brand;
  if (!isAdmin() || !isStaff() || !b.iconKey || b.iconKey === b.iconsSaved) return;
  try {
    const icons = await makeIcons(b);
    state.brand = await api("POST", "/branding/icons", { key: b.iconKey, icons });
    applyBrand();
  } catch (e) { console.warn("Couldn't update the home-screen icons:", e.message); }
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
  design: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.6-.9 1.2-1.8-.5-1-.1-2.2 1.1-2.2H17a4 4 0 0 0 4-4c0-5.5-4-10-9-10z"/><circle cx="7.5" cy="11" r="1.2" fill="currentColor"/><circle cx="10.5" cy="7" r="1.2" fill="currentColor"/><circle cx="15" cy="7.5" r="1.2" fill="currentColor"/></svg>',
  dashboard: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="9"/><rect x="14" y="3" width="7" height="5"/><rect x="14" y="12" width="7" height="9"/><rect x="3" y="16" width="7" height="5"/></svg>',
  screens: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/></svg>',
  playlists: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h13M3 12h13M3 18h9"/><path d="M17 15l5 3-5 3z" fill="currentColor"/></svg>',
  media: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="M21 15l-5-5L5 21"/></svg>',
  clients: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 21V8l9-5 9 5v13"/><path d="M9 21v-6h6v6"/><path d="M3 21h18"/></svg>',
  logins: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="9" cy="8" r="4"/><path d="M1 21v-1a7 7 0 0 1 14 0v1"/><path d="M17 11h6M20 8v6"/></svg>',
  channels: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M17 2l-5 5-5-5"/></svg>',
  walls: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="4" width="9" height="7" rx="1"/><rect x="13" y="4" width="9" height="7" rx="1"/><rect x="2" y="13" width="9" height="7" rx="1"/><rect x="13" y="13" width="9" height="7" rx="1"/></svg>',
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
  [/^\/screens\/(\d+)\/layers$/, "design", renderLayers],
  [/^\/design$/, "design", renderDesign],
  [/^\/channels$/, "channels", renderChannels],
  [/^\/channels\/(\d+)$/, "channels", renderChannel],
  [/^\/channels\/(\d+)\/layers$/, "design", (main, id) => renderLayers(main, id, "channel")],
  [/^\/walls$/, "walls", renderWalls],
  [/^\/walls\/(\d+)$/, "walls", renderWall],
  [/^\/walls\/(\d+)\/layers$/, "design", (main, id) => renderLayers(main, id, "wall")],
  // Playlists were removed: screens show only their design. Old links go to Design.
  [/^\/playlists(\/\d+)?$/, "design", main => { go("/design"); }],
  [/^\/slides\/(\d+)$/, "design", (main, id) => renderLayers(main, id, "slide")],
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
  state.section = section; helpButton();
  const hp = document.getElementById("help-panel"); if (hp && hp.redraw) setTimeout(hp.redraw, 0);
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
      contentGroup(),
      link(base() + "/wizard", "wizard", "Wizard"),
      link(base() + "/channels", "channels", "Channels"),
      link(base() + "/walls", "walls", "Video walls"),
      link(base() + "/design", "design", "Design"),
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
    h("div", { class: "spacer" }), I18N.switcher(), h("div", { class: "who" }, state.user.email));
  const main = h("main", {});
  app().replaceChildren(h("div", { class: "layout" }, nav, main));
  return main;
}

async function route() {
  clearInterval(state.timer); state.timer = null;
  window.onbeforeunload = null;
  const rm = location.hash.match(/^#\/reset\/([\w-]{20,100})$/);
  if (rm) return renderReset(rm[1]);
  if (!state.user) return location.hash === "#/signup" ? renderSignup() : location.hash === "#/forgot" ? renderForgot() : renderLogin();
  let path = location.hash.replace(/^#/, "") || "/";
  // The QR code on a TV's pairing screen opens #/pair/CODE: open Add screen with the code filled in.
  const pm = path.match(/^(\/c\/\d+)?\/pair\/([A-Za-z0-9]{6})$/);
  if (pm) {
    state.pendingPair = pm[2].toUpperCase();
    if (!isStaff() || pm[1]) { location.hash = "#" + (pm[1] || "") + "/screens"; return; }
    return renderPairPick(shell("clients", false), state.pendingPair);
  }
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
      if (state.pendingPair && inClient && path === "/screens") { const c = state.pendingPair; state.pendingPair = null; pairDialog(c); }
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

// ---------- AI help: the ? button on every page ----------
const HELP_SUGGEST = {
  dashboard: ["How do I connect a new TV?", "Why is a screen offline?", "How do I change what a TV shows?"],
  screens: ["How do I connect a new TV?", "How do I design what a screen shows?", "How do I rotate a screen to portrait?"],
  screen: ["How do I set a schedule?", "How do I replace a broken TV?", "The TV doesn't show my changes"],
  layers: ["How do I add a price list?", "How do pictures take turns as a slideshow?", "How do I make text glow like neon?", "How do I move several items together on the timeline?"],
  design: ["How do I start from a template?", "How do I add a clock or the weather?", "How do I make pictures take turns?"],
  media: ["Which video format works best?", "How do I add a web page?"],
  widgets: ["How do I add a clock or weather?", "How do I add a QR code?"],
  walls: ["How do I set up a video wall?", "How do I line up the picture across TV frames?"],
  wall: ["How do I add Santa flying across the wall?", "Why doesn't my widget show on the wall?"],
  channels: ["What is a channel?", "How do I put several screens on one channel?"],
  download: ["How do I install the app on a Fire TV Stick?", "How do TVs get app updates?"],
  monitoring: ["What does offline mean?", "How do I take a screenshot of every TV?"],
  reports: ["How do I see how many times something played?", "How do I export a report?"],
  clients: ["How do I add a client?", "What happens when I pause a client?"]
};
let helpChat = [], helpBusy = false, helpInfo = null;
try { helpChat = JSON.parse(sessionStorage.getItem("helpChat") || "[]"); } catch (_) { helpChat = []; }
const helpKeep = () => { try { sessionStorage.setItem("helpChat", JSON.stringify(helpChat.slice(-30))); } catch (_) {} };
function helpRemove() { const f = document.getElementById("help-fab"), p = document.getElementById("help-panel"); if (f) f.remove(); if (p) p.remove(); }
/** Answer text → safe HTML: **bold**, `code`, numbered and bulleted lists, paragraphs. */
function helpHtml(text) {
  const esc = s => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = s => esc(s).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/`([^`]+)`/g, "<code>$1</code>");
  const out = []; let list = null;
  for (const line of text.split(/\n/)) {
    const m = line.match(/^\s*(?:(\d+)[.)]|[-*•])\s+(.*)$/);
    if (m) { const tag = m[1] ? "ol" : "ul"; if (!list || list.tag !== tag) { list = { tag, items: [] }; out.push(list); } list.items.push(inline(m[2])); continue; }
    list = null;
    if (line.trim()) out.push("<p>" + inline(line.replace(/^#+\s*/, "")) + "</p>");
  }
  return out.map(x => typeof x === "string" ? x : "<" + x.tag + ">" + x.items.map(i => "<li>" + i + "</li>").join("") + "</" + x.tag + ">").join("");
}
function helpButton() {
  if (document.getElementById("help-fab")) return;
  document.body.append(h("button", { type: "button", id: "help-fab", title: "Help", "aria-label": "Help", onclick: helpOpen }, h("span", {}, "?"), h("span", { class: "help-fab-label" }, "Help")));
}
/** Which suggestions fit the page (from the address, since several pages share a menu section). */
function helpKey() {
  const p = location.hash.replace(/^#/, "").replace(/^\/c\/\d+/, "");
  if (/\/layers$/.test(p)) return "layers";
  if (/^\/screens\/\d+$/.test(p)) return "screen";
  if (/^\/walls\/\d+$/.test(p)) return "wall";
  return state.section;
}
/** The screen whose page is open (its page or its designer), for "show the AI this TV's screenshot". */
const helpScreenId = () => { const m = location.hash.match(/\/screens\/(\d+)(?:\/layers)?$/); return m ? Number(m[1]) : null; };
let helpPic = null, helpUseTv = true;
/** A picture file → a JPEG data: URL, at most 1568 px on its longest side (what the AI reads at full detail). */
function helpShrink(file) {
  return new Promise((resolve, reject) => {
    if (!/^image\//.test(file.type)) return reject(new Error("Pick a picture (a screenshot or a photo)."));
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const k = Math.min(1, 1568 / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement("canvas"); c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
      const g = c.getContext("2d"); g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url); resolve(c.toDataURL("image/jpeg", 0.85));
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("That picture can't be opened. Try a JPG or PNG.")); };
    img.src = url;
  });
}
function helpPageName() {
  const t = document.querySelector("main h1");
  return (t ? t.textContent.trim() + " · " : "") + (location.hash.replace(/^#/, "").replace(/^\/c\/\d+/, "") || "/");
}
async function helpOpen() {
  let panel = document.getElementById("help-panel");
  if (panel) { panel.remove(); return; }
  const list = h("div", { class: "help-list" });
  const input = h("textarea", { rows: 2, maxlength: 1500, placeholder: "Ask anything about using the portal or the TVs…",
    onkeydown: e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } } });
  const sendBtn = h("button", { type: "button", class: "primary", onclick: () => send() }, "Ask");
  const note = h("div", { class: "help-note small muted" });
  // Pictures: attach (📎, camera on phones) or paste a screenshot; on a screen's page, the TV's latest screenshot.
  const fileIn = h("input", { type: "file", accept: "image/*", style: "display:none", onchange: () => { if (fileIn.files[0]) addPic(fileIn.files[0]); fileIn.value = ""; } });
  const clip = h("button", { type: "button", class: "help-clip", title: "Add a screenshot or photo", "aria-label": "Add a screenshot or photo", onclick: () => fileIn.click() }, "📎");
  const picRow = h("div", { class: "help-pics" });
  async function addPic(f) { try { helpPic = await helpShrink(f); drawPics(); input.focus(); } catch (e) { toast(e.message, true); } }
  input.addEventListener("paste", e => { const f = [...(e.clipboardData || {}).files || []].find(x => /^image\//.test(x.type)); if (f) { e.preventDefault(); addPic(f); } });
  function drawPics() {
    const sid = helpScreenId();
    picRow.replaceChildren(...[
      sid ? h("label", { class: "check-row small help-tv" }, h("input", { type: "checkbox", checked: helpUseTv, onchange: e => { helpUseTv = e.target.checked; } }), "Show the AI this TV's latest screenshot") : null,
      helpPic ? h("div", { class: "help-thumb" }, h("img", { src: helpPic, alt: "Picture to send" }),
        h("button", { type: "button", title: "Remove picture", "aria-label": "Remove picture", onclick: () => { helpPic = null; drawPics(); } }, "×")) : null].filter(Boolean));
    picRow.style.display = sid || helpPic ? "" : "none";
  }
  panel = h("div", { id: "help-panel", role: "dialog", "aria-label": "Help" },
    h("div", { class: "help-head" }, h("strong", {}, "✨ Help"),
      h("button", { type: "button", class: "small", title: "Start over", onclick: () => { helpChat = []; helpKeep(); draw(); } }, "New chat"),
      h("button", { type: "button", class: "small help-x", title: "Close", "aria-label": "Close", onclick: () => panel.remove() }, "×")),
    list, picRow, h("div", { class: "help-input" }, clip, fileIn, input, sendBtn), note);
  document.body.append(panel);
  function draw() {
    const kids = [];
    if (!helpChat.length) {
      kids.push(h("div", { class: "help-msg bot" }, h("p", {}, "Hi! Ask me how to do anything in the portal: connecting TVs, playlists, designing screens, schedules, video walls, the TV app, and more.")));
      const sug = (HELP_SUGGEST[helpKey()] || HELP_SUGGEST.dashboard).concat(helpScreenId() ? ["What is this TV showing right now?"] : []);
      kids.push(h("div", { class: "help-sug" }, sug.map(q => h("button", { type: "button", class: "small", onclick: () => send(q) }, q))));
    }
    helpChat.forEach(m => kids.push(m.role === "user" ? h("div", { class: "help-msg me" }, m.pics ? h("div", { class: "help-msg-pics small" }, m.pics) : null, m.content)
      : h("div", { class: "help-msg bot" + (m.error ? " err" : ""), html: m.error ? "" : helpHtml(m.content) }, m.error ? m.content : null)));
    if (helpBusy) kids.push(h("div", { class: "help-msg bot help-typing" }, h("span"), h("span"), h("span")));
    list.replaceChildren(...kids);
    list.scrollTop = list.scrollHeight;
    sendBtn.disabled = helpBusy;
    note.textContent = helpInfo && !helpInfo.enabled ? "AI help isn't turned on yet: it needs the AI key on the server (the same one as the ✨ AI designer)."
      : helpInfo ? "Answers come from AI and can be wrong. " + helpInfo.left + " questions left today." : "";
  }
  async function send(q) {
    let question = (q || input.value).trim();
    if (helpPic && !question) question = "What do you see here, and what should I do?";
    if (!question || helpBusy) return;
    input.value = "";
    // Earlier pictures aren't sent again (only a note), so each question costs about the same.
    const history = helpChat.filter(m => !m.error).map(m => ({ role: m.role, content: (m.pics ? "[" + m.pics + "] " : "") + m.content }));
    const sid = helpScreenId() && helpUseTv ? helpScreenId() : null, image = helpPic;
    const pics = [image ? "📎 Picture attached" : null, sid ? "📺 TV screenshot" : null].filter(Boolean).join(" · ");
    helpChat.push({ role: "user", content: question, pics: pics || undefined }); helpBusy = true; helpPic = null; drawPics(); draw();
    try {
      const r = await api("POST", "/ai/help", { question, history, page: helpPageName(), image: image || undefined, screenId: sid || undefined, lang: I18N.lang() });
      helpChat.push({ role: "assistant", content: r.answer });
      if (helpInfo) helpInfo.left = r.left;
    } catch (e) {
      const mine = helpChat.pop();
      helpChat.push(mine, { role: "assistant", content: e.message || "Something went wrong. Try again.", error: true });
      if (image && !helpPic) { helpPic = image; drawPics(); }
    } finally { helpBusy = false; helpKeep(); if (panel.isConnected) draw(); }
  }
  draw(); drawPics();
  panel.redraw = () => { if (panel.isConnected) { draw(); drawPics(); } };
  input.focus();
  if (!helpInfo) { helpInfo = await api("GET", "/ai/help").catch(() => null); if (panel.isConnected) draw(); }
}

// ---------- login ----------
function renderLogin() {
  clearInterval(state.timer);
  helpRemove();
  const err = h("div", { class: "form-error" });
  const btn = h("button", { type: "submit", class: "primary", style: "width:100%;justify-content:center" }, "Log in");
  const form = h("form", { class: "card login" },
    brandMark(state.brand.name === "Signage" ? " Portal" : ""),
    field("Email", h("input", { name: "email", type: "email", autocomplete: "username", required: true })),
    field("Password", h("input", { name: "password", type: "password", autocomplete: "current-password", required: true })),
    h("p", { class: "small", style: "margin:-.4rem 0 .8rem;text-align:right" }, h("a", { href: "#/forgot", onclick: e => { e.preventDefault(); location.hash = "#/forgot"; renderForgot(); } }, "Forgot password?")),
    err, btn,
    h("p", { class: "small muted signup-link", style: "text-align:center", hidden: true }, "New here? ", h("a", { href: "#/signup", onclick: e => { e.preventDefault(); location.hash = "#/signup"; renderSignup(); } }, "Create an account")));
  api("GET", "/auth/signup").then(r => { if (r && r.open) form.querySelector(".signup-link").hidden = false; }).catch(() => {});
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true;
    const f = new FormData(form);
    try {
      const r = await api("POST", "/auth/login", { email: f.get("email"), password: f.get("password") });
      state.user = r.user; await loadCustomers(); route(); refreshIcons();
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  app().replaceChildren(h("div", { class: "login-wrap" }, form, I18N.switcher()));
  form.querySelector("input").focus();
}

// ---------- sign up (a new client makes their own account) ----------
function renderSignup() {
  clearInterval(state.timer);
  helpRemove();
  const err = h("div", { class: "form-error" });
  const btn = h("button", { type: "submit", class: "primary", style: "width:100%;justify-content:center" }, "Create my account");
  const toLogin = e => { e.preventDefault(); location.hash = "#/"; renderLogin(); };
  const form = h("form", { class: "card login" },
    brandMark(state.brand.name === "Signage" ? " Portal" : ""),
    h("h2", { style: "margin:0 0 .25rem;font-size:1.1rem;text-align:center" }, "Create your account"),
    h("p", { class: "small muted", style: "text-align:center;margin:0 0 1rem" }, "Put your own pictures, videos and messages on your TV screens."),
    field("Business name", h("input", { name: "business", autocomplete: "organization", required: true, maxlength: 120 })),
    field("Your name", h("input", { name: "name", autocomplete: "name", required: true, maxlength: 100 })),
    field("Email", h("input", { name: "email", type: "email", autocomplete: "email", required: true, maxlength: 200 })),
    field("Phone (optional)", h("input", { name: "phone", type: "tel", autocomplete: "tel", maxlength: 40 })),
    field("Password (at least 8 characters)", h("input", { name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 8 })),
    err, btn,
    h("p", { class: "small muted", style: "text-align:center" }, "Already have an account? ", h("a", { href: "#/", onclick: toLogin }, "Log in")));
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true;
    const f = new FormData(form);
    try {
      const r = await api("POST", "/auth/signup", Object.fromEntries(["business", "name", "email", "phone", "password"].map(k => [k, f.get(k)])));
      state.user = r.user; location.hash = r.next === "billing" ? "#/billing" : "#/"; await loadCustomers(); route(); refreshIcons();
      toast(r.next === "billing" ? "Welcome! Now choose your screens and set up your monthly payment." : "Welcome! Your account is ready.");
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  app().replaceChildren(h("div", { class: "login-wrap" }, form, I18N.switcher()));
  form.querySelector("input").focus();
}

// ---------- forgot password ----------
function authPage(...children) {
  clearInterval(state.timer);
  helpRemove();
  const card = h("div", { class: "card login" }, brandMark(state.brand.name === "Signage" ? " Portal" : ""), ...children);
  app().replaceChildren(h("div", { class: "login-wrap" }, card, I18N.switcher()));
  return card;
}
const backToLogin = () => h("p", { class: "small muted", style: "text-align:center" },
  h("a", { href: "#/", onclick: e => { e.preventDefault(); location.hash = "#/"; renderLogin(); } }, "Back to log in"));

function renderForgot() {
  const err = h("div", { class: "form-error" });
  const btn = h("button", { type: "submit", class: "primary", style: "width:100%;justify-content:center" }, "Email me a reset link");
  const form = h("form", {},
    h("h2", { style: "margin:0 0 .25rem;font-size:1.1rem;text-align:center" }, "Forgot your password?"),
    h("p", { class: "small muted", style: "text-align:center;margin:0 0 1rem" }, "Enter the email you log in with. We'll send you a link to choose a new password."),
    field("Email", h("input", { name: "email", type: "email", autocomplete: "username", required: true })),
    err, btn);
  const card = authPage(form, backToLogin());
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = ""; btn.disabled = true;
    try {
      await api("POST", "/auth/forgot", { email: new FormData(form).get("email") });
      form.replaceWith(h("div", {},
        h("h2", { style: "margin:0 0 .5rem;font-size:1.1rem;text-align:center" }, "Check your email"),
        h("p", { style: "text-align:center" }, "If an account uses that email, we sent a link to choose a new password. It works for 30 minutes."),
        h("p", { class: "small muted", style: "text-align:center" }, "Don't see it? Check your spam or junk folder.")));
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  card.querySelector("input").focus();
}

async function renderReset(token) {
  const card = authPage(h("p", { class: "muted", style: "text-align:center" }, "Loading…"));
  let info;
  try { info = await api("GET", "/auth/reset?t=" + encodeURIComponent(token)); }
  catch (ex) { card.replaceChildren(brandMark(""), h("p", { class: "form-error" }, ex.message), backToLogin()); return; }
  const err = h("div", { class: "form-error" });
  const btn = h("button", { type: "submit", class: "primary", style: "width:100%;justify-content:center" }, "Save new password");
  const form = h("form", {},
    h("h2", { style: "margin:0 0 .25rem;font-size:1.1rem;text-align:center" }, "Choose a new password"),
    h("p", { class: "small muted", style: "text-align:center;margin:0 0 1rem" }, info.email),
    h("input", { type: "email", name: "username", value: info.email, autocomplete: "username", hidden: true }),
    field("New password (at least 8 characters)", h("input", { name: "password", type: "password", autocomplete: "new-password", required: true, minlength: 8 })),
    field("Type it again", h("input", { name: "again", type: "password", autocomplete: "new-password", required: true, minlength: 8 })),
    err, btn);
  card.replaceChildren(brandMark(state.brand.name === "Signage" ? " Portal" : ""), form, backToLogin());
  form.addEventListener("submit", async e => {
    e.preventDefault(); err.textContent = "";
    const f = new FormData(form);
    if (f.get("password") !== f.get("again")) { err.textContent = "The two passwords don't match."; return; }
    btn.disabled = true;
    try {
      await api("POST", "/auth/reset", { token, password: f.get("password") });
      state.user = null;
      history.replaceState(null, "", location.pathname + "#/");
      renderLogin();
      toast("Password changed. Log in with your new password.");
    } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
  });
  form.querySelector("input[name=password]").focus();
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
  else { toast("Client added. Now add their screens, media and designs."); location.hash = "#/c/" + r.id; }
}

async function deleteClient(c) {
  if (c.screens) return fail(new Error(`Remove ${c.name}'s ${c.screens} screen(s) first (open the client, then Screens).`));
  if (!await confirmDlg("Delete " + c.name + "?", "This permanently deletes their screens' designs, media and logins.")) return;
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
  const wordIn = h("input", { value: b.iconWord == null ? "SIGNAGE" : b.iconWord, maxlength: 14, placeholder: "SIGNAGE", oninput: e => { b.iconWord = e.target.value; preview(); } });
  const iconPv = h("img", { class: "icon-preview", alt: "Home-screen icon" });
  const colorIn2 = h("input", { type: "color", value: b.color, oninput: e => { b.color = e.target.value; preview(); } });
  const pv = h("div", { class: "brand-preview" });
  let iconTimer;
  const preview = () => {
    clearTimeout(iconTimer);
    iconTimer = setTimeout(() => makeIcons(b).then(x => { iconPv.src = x[512]; }).catch(() => {}), 250);
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
      state.brand = d; b.logo = d.logo; preview(); await refreshIcons(); toast("Logo uploaded."); route();
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
            b.logo ? h("button", { type: "button", class: "small danger", onclick: async () => { try { state.brand = await api("DELETE", "/branding/logo"); applyBrand(); await refreshIcons(); toast("Logo removed."); route(); } catch (e) { fail(e); } } }, "Remove logo") : null), file),
        h("button", { class: "primary", onclick: async () => {
          try { state.brand = await api("PUT", "/branding", { name: nameIn.value, color: colorIn2.value, iconWord: wordIn.value }); applyBrand(); await refreshIcons(); toast("Branding saved."); route(); } catch (e) { fail(e); }
        } }, "Save branding")),
      h("div", {}, pv,
        h("div", { class: "icon-row" }, iconPv,
          h("div", {}, field("Word on the home-screen icon", wordIn),
            h("p", { class: "small muted", style: "margin:0" }, "When someone saves the portal to their phone's home screen or as a desktop shortcut, this icon shows: your logo with this word under it. Leave it empty for just the logo."))))));
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
      stat(d.media, "Media files · " + bytes(d.mediaBytes), base() + "/media")),
    h("div", { class: "grid two", style: "margin-top:1rem" },
      list("Offline screens", d.offline, d.screens ? "All screens are online. 👍" : "No screens yet. Click “Add screen” to pair a TV.", s => "Last seen " + ago(s.lastSeen)),
      list("Screens with nothing designed yet", d.noContent, "Every screen has a design. 👍", () => "No design yet"),
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
async function pairDialog(prefill) {
  const screens = await api("GET", "/screens");
  const planned = screens.filter(s => s.planned);
  let mode = "now";
  const code = codeInput();
  if (prefill) code.value = prefill;
  const into = h("select", { name: "screenId" }, h("option", { value: "" }, "A new screen"),
    planned.map(s => h("option", { value: s.id }, s.name + " (set up, waiting for its TV)")));
  const name = h("input", { name: "name", placeholder: "e.g. Lobby TV", maxlength: 100 });
  const details = h("div", {}, field("Screen name", name),
    field("Location", h("input", { name: "location", placeholder: "e.g. Main St store", maxlength: 200 })));
  const codeBox = h("div", {}, h("p", { class: "muted small" }, "Install the Premier Signage app on the TV and open it. It shows a 6-character code. Type it here."),
    field("Pairing code", code), planned.length ? field("Connect it to", into) : null);
  const later = h("p", { class: "muted small hidden" }, "The screen is created now without a TV, so you can design what it shows ahead of time. When the TV is installed, open the screen and click Connect TV, then type the code the TV shows.");
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
      if (mode === "later") return api("POST", "/screens/plan", { name: b.name, location: b.location });
      return api("POST", "/screens/pair", b.screenId ? { code: b.code, screenId: b.screenId } : b);
    } });
  if (!r) return;
  loadCustomers().catch(() => {});
  toast(r.planned ? "Screen created. Design it now, and connect the TV when it's installed." : "Screen paired. It will start playing within a few seconds.");
  go("/screens/" + r.id);
}

/** Staff scanned a TV's QR code: pick which client the TV is for, then Add screen opens with the code. */
async function renderPairPick(main, code) {
  if (!state.customers.length) await loadCustomers().catch(() => {});
  const active = state.customers.filter(c => c.active);
  main.replaceChildren(pageHead("Connect a TV", "Code " + code),
    h("div", { class: "card" },
      h("p", {}, "Which client is this TV for?"),
      active.length ? h("div", { class: "pair-pick" }, active.map(c =>
        h("button", { type: "button", onclick: () => { location.hash = "#/c/" + c.id + "/pair/" + code; } }, c.name)))
        : h("p", { class: "muted" }, "No clients yet. Add the client under White Label & Clients first, then scan the TV's code again."),
      h("p", { class: "small muted" }, h("a", { href: "#/clients", onclick: () => { state.pendingPair = null; } }, "Cancel"))));
}

/** Connect the TV showing a code to this screen (the first TV for a planned screen, or a replacement TV). */
async function connectTvDialog(s) {
  const r = await dialog(s.planned ? "Connect the TV for " + s.name : "Replace the TV for " + s.name, h("div", {},
    h("p", { class: "muted small" }, s.planned
      ? "Open the Premier Signage app on the TV. It shows a 6-character code. Type it here. The TV starts showing this screen's design right away."
      : "Open the Premier Signage app on the new TV and type the code it shows. It takes over this screen's design. The old TV goes back to showing a pairing code."),
    field("Pairing code", codeInput())),
  { submit: "Connect TV", onSubmit: f => api("POST", "/screens/pair", { code: f.get("code"), screenId: s.id }) });
  if (r) { loadCustomers().catch(() => {}); toast("TV connected. It will start playing within a few seconds."); route(); }
}

async function renderScreens(main) {
  const screens = await api("GET", "/screens");
  const selected = new Set();
  const designHref = s => base() + (s.channelId ? "/channels/" + s.channelId + "/layers" : "/screens/" + s.id + "/layers");
  main.replaceChildren(
    pageHead("Screens", clientName(), h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen")),
    screens.length ? h("div", { class: "card" }, h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Screen"), h("th", {}, "Status"), h("th", {}, "Design"), h("th", {}, ""))),
      h("tbody", {}, screens.map(s => h("tr", { class: "click", onclick: e => { if (!e.target.closest("a")) go("/screens/" + s.id); } },
        h("td", {}, h("strong", {}, s.name), h("div", { class: "small muted" }, s.location)),
        h("td", {}, statusPill(s), h("div", { class: "small muted" }, s.online || s.planned ? "" : ago(s.lastSeen))),
        h("td", { class: "small" }, s.wallId ? h("span", { class: "muted" }, "Video wall “" + s.wallName + "”") : s.channelId ? h("span", {}, "Channel “" + s.channelName + "”") : layerChips(s.layersOn || [])),
        h("td", { style: "text-align:right" }, s.wallId ? null : h("a", { class: "btn small", href: designHref(s) }, "🎨 Design"))))))))
      : h("div", { class: "card empty" }, h("p", {}, "No screens yet."), h("p", { class: "small" }, "Install the player app on a TV, open it, and pair it with the code it shows."),
        h("button", { class: "primary", onclick: () => pairDialog() }, "+ Add screen")));
  poll(async () => {
    try { const fresh = await api("GET", "/screens"); if (JSON.stringify(fresh.map(s => [s.online, s.status.playing])) !== JSON.stringify(screens.map(s => [s.online, s.status.playing]))) route(); } catch (_) {}
  }, 15000);
}

function deviceRows(s) {
  const st = s.status || {};
  return [
    ["Status", statusPill(s)], ["Last seen", ago(s.lastSeen)], 
    ["Device", s.model || "—"], ["Android", st.androidVersion || "—"], ["App version", s.appVersion || "—"], ["Picture quality", st.quality || "—"], ["Device owner", !st.deviceOwner ? "—" : st.deviceOwner === "no" ? "No (optional: see Help → Device owner)" : st.deviceOwner.replace(/^yes/, "Yes")], ["Time zone (clock)", st.timeZone ? st.timeZone + (st.deviceTime ? " · it was " + st.deviceTime + " on the TV at its last check-in" : "") : "—"], ["Resolution", st.resolution || "—"],
    ["IP address", s.ip || "—"], ["Offline cache", st.cacheBytes ? bytes(st.cacheBytes) : "—"], ["Free storage", st.freeBytes ? bytes(st.freeBytes) : "—"],
    ["Uptime", st.uptimeSec ? dur(Math.round(st.uptimeSec)) : "—"], ["App updates", st.update || "—"], ["Last error", st.error || "—"]
  ].flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]);
}

async function renderScreen(main, id) {
  const [s, channels] = await Promise.all([api("GET", "/screens/" + id), api("GET", "/channels")]);

  // settings
  const f = {
    name: h("input", { value: s.name, maxlength: 100 }),
    location: h("input", { value: s.location, maxlength: 200 }),
    channelId: h("select", {}, h("option", { value: "" }, "— none (this screen's own design) —"),
      channels.map(c => h("option", { value: c.id, selected: c.id === s.channelId }, c.name))),
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
      await api("PATCH", "/screens/" + id, { name: f.name.value, location: f.location.value, channelId: f.channelId.value || null,
        orientation: Number(f.orientation.value), volume: Number(f.volume.value), notes: f.notes.value });
      toast("Saved. The screen updates within 30 seconds.");
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save settings");


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
      h("p", { class: "muted small" }, "No TV is connected yet. Design what it shows now. When the TV is installed, open the Premier Signage app on it and type the code it shows."),
      h("button", { class: "primary", onclick: () => connectTvDialog(s) }, "Connect TV"))
  ] : [
    h("div", { class: "card" }, h("h2", {}, "Live view"), shotBox,
      h("div", { class: "cmds", style: "margin-top:.75rem" }, cmd("screenshot", "📷 Take screenshot", "Screenshot requested. It appears here within about 30 seconds."))),
    h("div", { class: "card" }, h("h2", {}, "Remote control"),
      h("div", { class: "cmds" },
        cmd("identify", "Show name on TV", "The screen name will flash on the TV."),
        cmd("reload", "Reload content", "The screen will reload its content."),
        cmd("clear_cache", "Clear cache & re-download", "The screen will clear its cache and download everything again."),
        cmd("restart_app", "Restart app", "The player app will restart."),
        /^yes/.test((s.status || {}).deviceOwner || "") ? cmd("reboot", "Restart TV", "The TV will restart. It's back in about a minute.") : null,
        /^yes/.test((s.status || {}).deviceOwner || "") ? h("button", { class: "danger", onclick: async () => {
          if (!confirm("Remove device owner from this TV? It stays paired and keeps playing, but it will no longer be locked to the player or update silently. Do this before uninstalling the app or giving the TV away.")) return;
          try { await api("POST", "/screens/" + id + "/commands", { type: "release_owner" }); toast("Device owner will be removed at the TV's next check-in."); } catch (e) { fail(e); }
        } }, "Remove device owner") : null),
      h("p", { class: "muted small", style: "margin-top:.75rem" }, "Commands reach the screen at its next check-in (within 30 seconds).")),
    h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Device"),
      h("button", { class: "small", onclick: () => connectTvDialog(s) }, "Replace TV")), dl)
  ];
  main.replaceChildren(
    h("a", { href: base() + "/screens", class: "back" }, "← All screens"),
    pageHead(s.name, [clientName(), s.location].filter(Boolean).join(" · "),
      s.wallId ? null : h("a", { class: "btn primary", href: base() + (s.channelId ? "/channels/" + s.channelId + "/layers" : "/screens/" + id + "/layers") }, s.channelId ? "🎨 Design (channel)" : "🎨 Design this screen"),
      s.planned ? h("button", { class: "primary", onclick: () => connectTvDialog(s) }, "Connect TV") : null,
      h("button", { class: "danger", onclick: async () => {
        if (!await confirmDlg("Remove this screen?", s.planned ? "Its design will be deleted." : "The TV will go back to showing a pairing code. You can pair it again later.", "Remove")) return;
        try { await api("DELETE", "/screens/" + id); toast("Screen removed."); go("/screens"); } catch (e) { fail(e); }
      } }, "Remove screen")),
    h("div", { class: "grid two" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", {}, "Settings"),
          field("Name", f.name), field("Location", f.location), field("Channel", f.channelId),
          h("div", { class: "row" }, field("Orientation", f.orientation), h("div", { class: "field" }, h("label", {}, "Volume ", volLbl), f.volume)),
          field("Notes", f.notes), saveBtn)),
      h("div", { class: "stack" },
        s.wallId ? h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Video wall"),
            h("a", { class: "btn small", href: base() + "/walls/" + s.wallId }, "Open wall")),
          h("p", { class: "small muted", style: "margin:0" }, "This screen is part of the video wall “" + s.wallName + "” (column " + (s.wallCol + 1) + ", row " + (s.wallRow + 1) + "). It shows the wall's pictures and videos, so its own design and channel are not used while it's in the wall.")) : null,
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
const SCENE_LABELS = [["santa", "🎅 Santa & reindeer"], ["fireworks", "🎆 Fireworks"], ["shooting", "🌠 Shooting stars"], ["balloons", "🎈 Balloons"], ["plane", "✈ Plane & banner"], ["lights", "🎄 Christmas lights"], ["rain", "💧 Rain on the window"], ["wiper", "🚗 Rain & wiper"]];
const ENTER_LABELS = [["none", "None (just appears)"], ["fade", "Fade in"], ["small", "Small → big (zoom in)"], ["big", "Big → small (zoom down)"],
  ["left", "Slide in from the left"], ["right", "Slide in from the right"], ["top", "Drop down from the top"], ["bottom", "Rise up from the bottom"], ["spin", "Spin in"], ["pop", "Pop in (bounce)"], ["flip", "Flip in"]];
const EXIT_LABELS = [["none", "None (just disappears)"], ["fade", "Fade out"], ["small", "Big → small (shrink away)"], ["big", "Small → big (grow away)"],
  ["left", "Slide out to the left"], ["right", "Slide out to the right"], ["top", "Fly up and out"], ["bottom", "Drop down and out"], ["spin", "Spin out"], ["pop", "Pop out"], ["flip", "Flip out"]];
const TEXT_FX_LABELS = [["none", "None"], ["glow", "✨ Glow"], ["neon", "💡 Neon glow"], ["shadow", "🌑 Shadow"], ["shine", "🌟 Shine"], ["grow", "🔎 Grow (pulse)"]];
// A good starting color for each look.
const TEXT_FX_COLORS = { glow: "#facc15", neon: "#ec4899", shadow: "#000000", shine: "#fde047", grow: "#facc15" };
const TD_OPTIONS = [[0.3, "0.3 s (fast)"], [0.5, "0.5 s"], [0.8, "0.8 s"], [1, "1 s"], [1.5, "1.5 s"], [2, "2 s"], [3, "3 s (slow)"]];
const FIREWORK_SHAPES = [["mixed", "Random mix"], ["peony", "Classic round"], ["chrysanthemum", "Sparkling trails"], ["willow", "Golden willow"], ["palm", "Palm tree"], ["ring", "Ring"], ["heart", "Heart"], ["star", "Star"]];
const LIGHT_PATTERNS = [["twinkle", "Twinkle"], ["steady", "Always on"], ["chase", "Chase"], ["flash", "Flash (every other bulb)"]];
const RAIN_LEVELS = [[1, "Drizzle"], [2, "Light"], [3, "Medium"], [4, "Heavy"], [5, "Downpour"]];
const WIPE_OPTIONS = [[5, "Every 5 seconds"], [8, "Every 8 seconds"], [10, "Every 10 seconds"], [15, "Every 15 seconds"], [20, "Every 20 seconds"], [30, "Every 30 seconds"]];
const EVERY_OPTIONS = [[15, "Every 15 seconds"], [20, "Every 20 seconds"], [30, "Every 30 seconds"], [45, "Every 45 seconds"], [60, "Every minute"], [120, "Every 2 minutes"], [300, "Every 5 minutes"]];
const EFFECT_LABELS = [["snow", "❄ Snow"], ["confetti", "🎉 Confetti"], ["sparkles", "✨ Sparkles"], ["bubbles", "○ Bubbles"], ["hearts", "♥ Hearts"],
  ["leaves", "🍂 Falling leaves"], ["stars", "★ Twinkling stars"]];

const opts = (list, val) => list.map(([v, l]) => h("option", { value: v, selected: v === val }, l));
// Options for the plane's banner: words, a small logo picture, colors, how often it flies by.
function planeFields(ef, images, onchange) {
  return h("div", { class: "sub-item" },
    h("strong", { class: "small" }, "✈ Banner"),
    field("Banner text", h("input", { value: ef.banner || "", maxlength: 60, placeholder: "e.g. Grand opening Saturday!", oninput: e => { ef.banner = e.target.value; onchange(); } })),
    field("Logo or small picture (optional)", h("select", { onchange: e => {
      const m = images.find(x => x.id === Number(e.target.value));
      ef.mediaId = m ? m.id : null; ef.image = m ? { src: m.src, name: m.name } : null; onchange();
    } }, h("option", { value: "" }, images.length ? "— no picture —" : "— upload a picture in Media first —"),
      images.map(m => h("option", { value: m.id, selected: m.id === ef.mediaId }, m.name)))),
    field("Plane flies by", h("select", { onchange: e => { ef.every = Number(e.target.value); onchange(); } }, opts(EVERY_OPTIONS, ef.every))),
    h("div", { class: "colors" },
      colorIn(ef.bannerBg || "#ffffff", v => { ef.bannerBg = v; onchange(); }, "Banner"),
      colorIn(ef.bannerColor || "#b91c1c", v => { ef.bannerColor = v; onchange(); }, "Text")),
    h("p", { class: "small muted", style: "margin:.25rem 0 0" }, "Tip: a logo with a see-through (PNG) background looks best. Keep the text short so it's easy to read as it flies by."));
}
const colorIn = (val, onchange, label) => h("label", { class: "color-in" }, h("input", { type: "color", value: val, oninput: e => onchange(e.target.value) }), label);

const FONT_LABELS = [["sans", "Sans"], ["serif", "Serif"], ["condensed", "Condensed"], ["mono", "Typewriter"], ["script", "Script"]];
const SIZE_EM = { s: 2, m: 2.8, l: 4.2, xl: 6.2 };
const TEXT_PRESETS = [
  ["Heading", "Your heading", { fs: 6, bold: true, bgOpacity: 0 }],
  ["Subheading", "A short subheading", { fs: 3.6, bold: true, bgOpacity: 0 }],
  ["Body text", "Add a little text", { fs: 2.2, bold: false, bgOpacity: 0 }],
  ["Price list", "Picanha      $11.99\nRib Eye      $10.99\nCostela       $9.99", { fs: 2.4, bold: true, font: "mono", bg: "#ffffff", bgOpacity: 85, color: "#111111" }],
  ["Label", "SALE", { fs: 2.6, bold: true, bg: "#b91c1c", bgOpacity: 100 }],
  ["Neon sign", "OPEN", { fs: 8, bold: true, bgOpacity: 0, color: "#ffffff", fx: "neon", fxColor: "#ec4899" }],
  ["Glowing heading", "Happy Hour", { fs: 6, bold: true, bgOpacity: 0, color: "#fff7ed", fx: "glow", fxColor: "#f59e0b" }]
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
  const isCh = kind === "channel", isSlide = kind === "slide", isWall = kind === "wall";
  const path = (isCh ? "/channels/" : isSlide ? "/slides/" : isWall ? "/walls/" : "/screens/") + id;
  let [s, media, templates, aiStatus] = await Promise.all([api("GET", path), api("GET", "/media"),
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
  // Several texts / pictures selected at once (block objects). Empty unless 2 or more.
  let multi = new Set(), multiMode = false;
  const grpOf = b => b.grp ? L.text.blocks.filter(x => x.grp === b.grp) : [b];
  const isSelB = i => isSel("block", i) || multi.has(L.text.blocks[i]);
  const selectedBlocks = () => multi.size ? L.text.blocks.filter(x => multi.has(x)) : isSel("block") ? [L.text.blocks[sel.i]] : [];
  // Dragging doesn't move the keyboard focus by itself; drop it so Delete works on the selected item.
  const unfocus = () => { const a = document.activeElement; if (a && a !== document.body && a.blur) a.blur(); };

  // ---------- preview ----------
  const pvVideo = h("div", { class: "pv-video" });
  const pvOverlay = h("div", { class: "pv-overlay" });
  const preview = h("div", { class: "preview ed-preview" + (portrait ? " portrait" : "") }, h("div", { class: "pv-bg" }), pvVideo, pvOverlay);
  // Video wall: the preview has the wall's shape, with lines where the TVs meet (and their frames, if a gap is set).
  if (isWall) {
    const g = (s.bezel || 0) / 100, Wt = s.cols + (s.cols - 1) * g, Ht = s.rows * 9 / 16 + (s.rows - 1) * g;
    preview.style.paddingTop = (Ht / Wt * 100) + "%";
    const seams = h("div", { class: "wall-seams" });
    for (let c = 1; c < s.cols; c++) seams.append(h("div", { class: "wall-seam v", style: "left:" + ((c + (c - 1) * g) / Wt * 100) + "%;width:" + (g / Wt * 100) + "%" }));
    for (let r = 1; r < s.rows; r++) seams.append(h("div", { class: "wall-seam h", style: "top:" + ((r * 9 / 16 + (r - 1) * g) / Ht * 100) + "%;height:" + (g / Ht * 100) + "%" }));
    preview.append(seams);
  }
  // A design slide has no video: its background colour fills the screen.
  let slideBg = isSlide ? s.bg || "#0f172a" : null;
  // Holiday being previewed (Background tab): its picture / colour shows instead of the design's own background.
  let pvHoliday = null;
  const paintBg = () => {
    const hp = pvHoliday;
    preview.querySelector(".pv-bg").style.background = isSlide ? slideBg : (hp && hp.color) || L.background || "#000";
    preview.classList.toggle("hol-preview", !!hp);
  };
  /** Previewing a holiday: its colour and picture on the design layer itself (under the texts and pictures). */
  const paintHoliday = () => {
    const hp = pvHoliday, m = hp && hp.mediaId ? images.find(p => p.id === hp.mediaId) : null;
    if (!hp) return;
    if (hp.color) pvOverlay.style.backgroundColor = hp.color;
    if (m) Object.assign(pvOverlay.style, { backgroundImage: "url(\"" + String(m.src).replace(/"/g, "%22") + "\")", backgroundSize: "100% auto", backgroundRepeat: "no-repeat", backgroundPosition: "left top" });
  };
  paintBg();
  // (the resize frame is added to the preview below, once it exists)
  preview.addEventListener("pointerdown", e => { if (!e.target.closest(".so-text") && !e.target.closest(".ed-frame")) select(e.target.closest(".pv-video") ? { type: "video" } : null); });

  function itemAt(t) {
    if (!items.length) return -1;
    let x = t % loop;
    for (let i = 0; i < items.length; i++) { if (x < itemLen(items[i])) return i; x -= itemLen(items[i]); }
    return 0;
  }
  function drawVideo(force) {
    const r = SignageOverlay.REGIONS[L.video.region] || SignageOverlay.REGIONS.full;
    Object.assign(pvVideo.style, { left: r[0] + "%", top: r[1] + "%", width: r[2] + "%", height: r[3] + "%", display: "none" }); // no video layer (screens show only their design)
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
    // Locked at the bottom (backgrounds): not clickable on the screen; pick it from its timeline bar to unlock it.
    if (b.locked) {
      node.style.pointerEvents = "none"; node.classList.toggle("ed-selected", isSelB(i));
      // Previewing a holiday with a picture: the design's own background is hidden, as on the TV.
      node.style.visibility = pvHoliday && pvHoliday.mediaId ? "hidden" : "";
      return;
    }
    node.style.pointerEvents = "auto";
    node.style.cursor = "move";
    node.classList.toggle("ed-selected", isSelB(i));
    node.addEventListener("pointerdown", e => {
      e.preventDefault(); e.stopPropagation(); unfocus();
      if (e.ctrlKey || e.metaKey || e.shiftKey || multiMode) { select({ type: "block", i }, false, true); return; }
      const wasSel = isSel("block", i) && !multi.size;
      // Part of the current selection (a group or several picked): keep them all selected and move them together.
      // Otherwise select it (a locked group comes along as a whole).
      if (!multi.has(b) && !isSel("block", i)) select({ type: "block", i });
      const box = pvOverlay.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      const movers = (multi.has(b) ? selectedBlocks() : [b]).map(x => {
        const n = blockNodes[L.text.blocks.indexOf(x)], r = n && n.getBoundingClientRect();
        return n && { b: x, n, x0: (r.left - box.left) / box.width * 100, y0: (r.top - box.top) / box.height * 100 };
      }).filter(Boolean);
      let moved = false;
      const mv = ev => {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) < 4) return;
        moved = true;
        const ddx = (ev.clientX - sx) / box.width * 100, ddy = (ev.clientY - sy) / box.height * 100;
        movers.forEach(m => {
          m.b.x = Math.round((m.x0 + ddx) * 10) / 10;
          m.b.y = Math.round((m.y0 + ddy) * 10) / 10;
          m.n.className = m.n.className.replace(/\bso-pos-\S+/, "").trim();
          m.n.classList.add("so-free");
          Object.assign(m.n.style, { left: m.b.x + "%", top: m.b.y + "%", right: "auto", bottom: "auto", transform: "none" });
        });
      };
      const up = () => {
        window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
        if (moved) { change(); drawToolbar(); return; }
        // Clicked an item that was already selected: select the next one underneath at that spot (if any).
        if (wasSel) {
          const under = document.elementsFromPoint(sx, sy).map(el => el.closest && el.closest(".so-text")).filter(Boolean);
          const order = [...new Set(under)].map(n => blockNodes.indexOf(n)).filter(k => k >= 0);
          if (order.length > 1) select({ type: "block", i: order[(order.indexOf(i) + 1) % order.length] });
        }
      };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    });
  }
  // Weather / news for widgets placed on the design (fetched once per widget, then the preview redraws).
  const wData = {}, wAsked = {};
  function widgetDataFor(b) {
    const t = b.widget && b.widget.type;
    if (t !== "weather" && t !== "rss") return null;
    if (!wAsked[b.mediaId]) {
      wAsked[b.mediaId] = true;
      api("GET", "/media/" + b.mediaId + "/widget-data").then(r => { wData[b.mediaId] = r.data; refresh(); }).catch(() => {});
    }
    return wData[b.mediaId] || null;
  }
  function renderOverlay() {
    if (overlay) overlay.destroy();
    blockNodes = [];
    overlay = SignageOverlay.render(pvOverlay, L, { time: () => playhead, onBlock: hookBlock, widgetData: widgetDataFor });
    paintHoliday();
    placeFrame();
  }
  const refresh = () => { clearTimeout(rt); rt = setTimeout(renderOverlay, 80); };
  const change = () => { dirty = true; saveBtn.textContent = "Save changes"; refresh(); drawTimeline(); };

  // ---------- selection ----------
  // additive: add / remove this item to the multi-selection (a locked group comes along as a whole).
  function select(next, keepTimeline, additive) {
    if (additive && next && next.type === "block") {
      const b = L.text.blocks[next.i], mem = grpOf(b);
      if (!multi.size && isSel("block")) grpOf(L.text.blocks[sel.i]).forEach(x => multi.add(x));
      if (multi.has(b)) {
        mem.forEach(x => multi.delete(x));
        const rest = L.text.blocks.filter(x => multi.has(x));
        next = rest.length ? { type: "block", i: L.text.blocks.indexOf(rest[rest.length - 1]) } : null;
      } else mem.forEach(x => multi.add(x));
    } else multi = new Set(next && next.type === "block" ? grpOf(L.text.blocks[next.i]) : []);
    if (multi.size < 2) multi.clear();
    sel = next;
    blockNodes.forEach((n, i) => n && n.classList.toggle("ed-selected", isSelB(i)));
    pvVideo.classList.toggle("ed-selected", isSel("video"));
    if (typeof placeFrame === "function") placeFrame();
    if (sel) {
      const b = sel.type === "block" ? L.text.blocks[sel.i] : null;
      tab = b ? (b.kind === "image" || b.kind === "video" ? "media" : b.kind === "shape" ? "shapes" : b.kind === "widget" ? "widgets" : "text") : sel.type === "ticker" ? "text" : sel.type;
    }
    drawToolbar(); drawSide();
    if (!keepTimeline) drawTimeline();
  }
  // Timeline rows: a new text or picture gets a row of its own (drag it onto another row to share it).
  const nextTrack = () => L.text.blocks.reduce((m, b) => Math.max(m, (b.track || 0) + 1), 0);
  const shapeLabel = b => ((SignageOverlay.SHAPES[b.shape] || [])[0]) || "Shape";
  const widgetLabel = b => b.widgetName || widgetName(b.widget && b.widget.type) || "Widget";
  /** The client's widgets that can go on a design (not design slides). */
  const designWidgets = () => media.filter(m => m.kind === "widget" && m.widget && m.widget.type !== "design");
  function addWidget(m) {
    const T = { clock: [26, 15], weather: [34, 19], rss: [40, 16], qr: [16, 16], countdown: [32, 15], message: [36, 15] }[m.widget.type] || [30, 17];
    addBlock({ kind: "widget", mediaId: m.id, widget: m.widget, widgetName: m.name, text: "", w: T[0], h: T[1], x: 50 - T[0] / 2, y: 30, bgOpacity: 0, fx: "none" });
  }
  function addBlock(b) {
    L.text.enabled = true;
    L.text.blocks.push(Object.assign({ kind: "text", text: "", position: "center", x: 30, y: 40, w: 0, size: "m", fs: 2.8, font: "sans", align: "",
      bold: true, italic: false, color: "#ffffff", bg: "#000000", bgOpacity: 0, from: 0, to: 0, mediaId: null, image: null,
      track: nextTrack(), enter: "none", exit: "none", td: 1 }, b));
    change();
    select({ type: "block", i: L.text.blocks.length - 1 });
  }
  function addAfter(prev, m) {
    const len = T();
    if (!L.text.cycle) L.text.cycle = len;
    let pt = prev.to || len;
    // A picture that fills the whole timeline becomes a 5-second slide.
    if ((prev.from || 0) <= 0 && pt >= len) { pt = Math.max(2, Math.min(5, snapH(len / 2))); prev.to = pt; }
    const dur = pt - (prev.from || 0), ov = Math.min(prev.td || 1, dur / 2);
    const from = snapH(Math.max(0, pt - ov));
    if (from >= len - 1) return addBlock({ kind: "image", mediaId: m.id, image: { src: m.src, name: m.name }, w: prev.w || 30, x: 35, y: 30, text: "", fx: prev.fx || "none", fxColor: prev.fxColor });
    const to = Math.min(len, from + dur);
    addBlock({ kind: "image", mediaId: m.id, image: { src: m.src, name: m.name }, text: "", w: prev.w, x: prev.x, y: prev.y, position: prev.position,
      bg: prev.bg, bgOpacity: prev.bgOpacity, track: prev.track || 0, from, to: to >= len ? 0 : to,
      enter: prev.enter && prev.enter !== "none" ? prev.enter : "fade", exit: prev.exit || "none", td: prev.td || 1, fx: prev.fx || "none", fxColor: prev.fxColor });
  }
  /** A background: the whole screen, behind everything else. */
  /** Change a widget's settings (it's the same widget in every design that uses it). */
  async function editWidget(b, m) {
    const r = await widgetDialog(m.widget.type, m, { stay: true });
    if (!r) return;
    Object.assign(m, r);
    L.text.blocks.forEach(x => { if (x.kind === "widget" && x.mediaId === m.id) { x.widget = r.widget; x.widgetName = r.name; } });
    delete wAsked[m.id]; delete wData[m.id];
    change(); drawToolbar(); drawSide(); toast("Widget saved.");
  }
  /** A video on the design (loops; muted unless Sound is on). */
  function addVideo(m) {
    addBlock({ kind: "video", mediaId: m.id, image: { src: m.src, name: m.name }, text: "", w: 40, h: 22.5, x: 30, y: 25, fit: "cover", sound: false, bgOpacity: 0, fx: "none" });
  }
  // ---------- holiday backgrounds ----------
  // Between a start and an end date the screens show the holiday's picture (locked at the bottom, like any
  // background) and/or colour; after the end date the design's own background comes back by itself.
  function holidaysPanel() {
    if (!Array.isArray(L.holidays)) L.holidays = [];
    const today = Holidays.today(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // Every-year holidays show their current or next dates.
    L.holidays.forEach(x => { if (x.yearly) { const n = Holidays.next(x, today); if (n) { x.start = n.start; x.end = n.end; } } });
    const pics = images.slice().sort((a, b) => (b.category === "background") - (a.category === "background"));
    const day = d => new Date(d + "T12:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
    const now = Holidays.active(L.holidays, today);
    const redraw = () => { paintBg(); renderOverlay(); drawSide(); };
    const card = (x, i) => {
      const inf = x.key ? Holidays.info(x.key) : null, n = Holidays.next(x, today), on = Holidays.isActive(x, today);
      const m = x.mediaId ? images.find(p => p.id === x.mediaId) : null;
      return h("div", { class: "sub-item hol-item" + (on ? " on" : "") },
        h("div", { class: "layer-head" }, h("strong", { class: "small" }, (inf ? inf.emoji : "🎉") + " " + (x.name || "Holiday")),
          sw(x.enabled !== false, v => { x.enabled = v; change(); drawSide(); })),
        x.key ? null : field("Name", h("input", { value: x.name, maxlength: 40, placeholder: "Store anniversary", oninput: e => { x.name = e.target.value; change(); } })),
        h("div", { class: "row" },
          field("Starts", h("input", { type: "date", value: x.start, required: true, onchange: e => { if (!e.target.value) return; x.start = e.target.value; if (x.end < x.start) x.end = x.start; change(); drawSide(); } })),
          field("Ends (last day)", h("input", { type: "date", value: x.end, min: x.start, required: true, onchange: e => { if (!e.target.value) return; x.end = e.target.value < x.start ? x.start : e.target.value; change(); drawSide(); } }))),
        h("label", { class: "check-row" }, h("input", { type: "checkbox", checked: !!x.yearly, onchange: e => { x.yearly = e.target.checked; change(); drawSide(); } }),
          x.key ? "Every year (follows the holiday's date)" : "Every year on these dates"),
        field("Background picture", h("select", { onchange: e => { x.mediaId = Number(e.target.value) || null; change(); if (pvHoliday === x) redraw(); else drawSide(); } },
          h("option", { value: "" }, pics.length ? "— No picture —" : "— Upload pictures in Media first —"),
          pics.map(p => h("option", { value: p.id, selected: p.id === x.mediaId }, (p.category === "background" ? "🖼 " : "") + p.name)))),
        m ? h("img", { class: "hol-thumb", src: m.src, alt: "" }) : null,
        h("div", { class: "row", style: "gap:.6rem;align-items:center" },
          colorIn(x.color || L.background || "#000000", v => { x.color = v; change(); if (pvHoliday === x) paintBg(); }, "Background colour"),
          x.color ? h("button", { type: "button", class: "small", onclick: () => { x.color = ""; change(); if (pvHoliday === x) paintBg(); drawSide(); } }, "Keep my colour") : h("span", { class: "small muted" }, "(optional)")),
        !x.mediaId && !x.color ? h("p", { class: "small", style: "color:var(--danger);margin:.25rem 0" }, "Choose a picture or a colour, or nothing changes.") : null,
        h("p", { class: "small muted", style: "margin:.35rem 0" },
          x.enabled === false ? "Off." : on ? (now === x ? "✅ Showing now, until " + day(n ? n.end : x.end) + "." : "Another holiday higher in the list is showing now.")
            : n ? "Next: " + day(n.start) + " – " + day(n.end) + "." : "These dates have passed."),
        h("div", { class: "row", style: "gap:.4rem;flex-wrap:wrap" },
          x.mediaId || x.color ? h("button", { type: "button", class: "small" + (pvHoliday === x ? " primary" : ""), onclick: () => { pvHoliday = pvHoliday === x ? null : x; redraw(); } }, pvHoliday === x ? "Stop preview" : "👁 Preview") : null,
          i > 0 ? h("button", { type: "button", class: "small", title: "If two holidays overlap, the higher one shows", onclick: () => { L.holidays.splice(i - 1, 0, L.holidays.splice(i, 1)[0]); change(); drawSide(); } }, "↑ Move up") : null,
          h("button", { type: "button", class: "small danger", onclick: () => { L.holidays.splice(i, 1); if (pvHoliday === x) pvHoliday = null; change(); redraw(); } }, "Remove")));
    };
    const used = new Set(L.holidays.map(x => x.key).filter(Boolean));
    const add = h("select", { "aria-label": "Add a holiday", onchange: e => {
      const k = e.target.value; if (!k) return;
      const x = Holidays.create(k === "custom" ? "" : k, today);
      if (k === "custom") x.name = "";
      L.holidays.push(x); change(); drawSide();
      toast("Added. Now choose its background picture" + (k === "custom" ? ", name" : "") + " and dates.");
    } }, h("option", { value: "" }, "+ Add a holiday…"),
      Holidays.list().filter(o => !used.has(o.key)).map(o => h("option", { value: o.key }, o.emoji + " " + o.name)),
      h("option", { value: "custom" }, "🎉 Custom holiday or event…"));
    return [
      h("div", { class: "layer-head", style: "margin-top:1.25rem" }, h("strong", {}, "🗓️ Scheduled Backgrounds")),
      h("p", { class: "small muted", style: "margin:0 0 .5rem" }, "Pick a holiday, its background and the dates. Your screens switch to it on the start date (locked at the bottom, under everything, like any background) and go back to your normal background after the last day. Save the design to turn it on."),
      h("p", { class: "small", style: "margin:0 0 .6rem" }, now ? "🎉 Showing on your screens today: " + now.name + "." : "Today your normal background is showing."),
      pvHoliday ? h("div", { class: "row", style: "gap:.5rem;align-items:center;margin-bottom:.6rem" }, h("span", { class: "small" }, "👁 Previewing " + pvHoliday.name),
        h("button", { type: "button", class: "small", onclick: () => { pvHoliday = null; redraw(); } }, "Stop preview")) : null,
      ...L.holidays.map(card),
      add];
  }

  function addBackground(m) {
    addBlock({ kind: "image", mediaId: m.id, image: { src: m.src, name: m.name }, w: 100, x: 0, y: 0, text: "", fx: "none" });
    const bg = L.text.blocks.pop();
    bg.above = false;
    bg.locked = true;
    L.text.blocks.unshift(bg);
    change(); select(null);
    toast("Background added and locked at the bottom: clicks go to what's on top. To change it, tap its 📌 bar in the timeline, then Unlock.");
  }
  function removeBlock(i) { L.text.blocks.splice(i, 1); sel = null; change(); select(null); }

  // ---------- stacking (what's over / under what) ----------
  // Bottom to top: pictures/text under Specials (list order), the Specials panel, pictures/text over it (list order), ticker, effects.
  const hasSpecials = () => L.specials.enabled && L.specials.items.length > 0;
  const rectOf = node => node && node.style.visibility !== "hidden" ? node.getBoundingClientRect() : null;
  const hits = (a, b) => !!a && !!b && a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
  const specialsRect = () => { const p = pvOverlay.querySelector(".so-specials"); return p && p.style.display !== "none" ? p.getBoundingClientRect() : null; };
  /** The stack as a list, bottom first: blocks and "S" for the Specials panel. */
  const stack = () => {
    const under = L.text.blocks.filter(x => !x.above && !x.locked), over = L.text.blocks.filter(x => x.above && !x.locked);
    return hasSpecials() ? [...under, "S", ...over] : [...under, ...over];
  };
  /** Rebuilds the blocks list (and each block's "above") from a stack order. */
  function setStack(st) {
    const s = st.indexOf("S");
    L.text.blocks = [...L.text.blocks.filter(x => x.locked), ...st.filter(x => x !== "S")];
    L.text.blocks.forEach(x => { x.above = s >= 0 && st.indexOf(x) > s; });
  }
  /** Moves the selected item: "front" / "back" all the way, "up" / "down" past the next thing it overlaps. */
  function restack(dir) {
    const b = L.text.blocks[sel.i];
    if (b.locked) { toast("It's locked at the bottom. Tap Unlock first."); return; }
    const st = stack(), at = st.indexOf(b);
    const rect = x => x === "S" ? specialsRect() : rectOf(blockNodes[L.text.blocks.indexOf(x)]);
    const me = rect(b);
    const name = x => x === "S" ? "the Specials panel" : x.kind === "video" ? "the video" : x.kind === "widget" ? "the " + widgetLabel(x).toLowerCase() + " widget" : x.kind === "shape" ? "the " + shapeLabel(x).toLowerCase() : x.kind === "image" ? "the picture" + (x.image && x.image.name ? " “" + x.image.name + "”" : "") : "“" + (x.text || "").split("\n")[0].slice(0, 24) + "”";
    st.splice(at, 1);
    let to, past = null;
    if (dir === "front") to = st.length;
    else if (dir === "back") to = 0;
    else if (dir === "up") {
      let j = at; while (j < st.length && !hits(me, rect(st[j]))) j++;
      if (j >= st.length) { toast("It's already on top of everything it touches."); return; }
      past = st[j]; to = j + 1;
    } else {
      let j = at - 1; while (j >= 0 && !hits(me, rect(st[j]))) j--;
      if (j < 0) { toast("It's already under everything it touches."); return; }
      past = st[j]; to = j;
    }
    st.splice(to, 0, b);
    setStack(st);
    sel.i = L.text.blocks.indexOf(b);
    change(); drawToolbar();
    if (past) toast((dir === "up" ? "Now over " : "Now under ") + name(past) + ".");
  }

  // ---------- resize handles on the selected text or picture ----------
  const frame = h("div", { class: "ed-frame", hidden: true });
  const HANDLES = [["nw", -1, -1], ["ne", 1, -1], ["sw", -1, 1], ["se", 1, 1], ["w", -1, 0], ["e", 1, 0], ["n", 0, -1], ["s", 0, 1]];
  HANDLES.forEach(([k, dx, dy]) => frame.append(h("span", { class: "ed-h ed-h-" + k, title: dx && dy ? "Drag to resize" : dx ? "Drag to change the width" : "Drag to change the height",
    onpointerdown: e => resizeDrag(e, dx, dy) })));
  // Shapes: a handle above the frame turns the shape (around its middle). Shift = steps of 15°.
  const rotHandle = h("span", { class: "ed-rot", title: "Drag to turn the shape (hold Shift for steps of 15°)", "aria-label": "Turn", onpointerdown: e => rotateDrag(e) }, "⟳");
  frame.append(rotHandle);
  function rotateDrag(e) {
    e.preventDefault(); e.stopPropagation(); unfocus();
    const b = L.text.blocks[sel.i], node = blockNodes[sel.i];
    if (!b || b.kind !== "shape" || !node) return;
    const r = node.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const svg = node.querySelector("svg");
    const mv = ev => {
      let a = Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180 / Math.PI + 90;
      a = ((a + 540) % 360) - 180;
      if (ev.shiftKey) a = Math.round(a / 15) * 15;
      else { const n = Math.round(a / 45) * 45; if (Math.abs(a - n) < 3) a = n; } // a little pull to straight angles
      b.rot = Math.round(a * 10) / 10;
      if (svg) svg.style.transform = "rotate(" + b.rot + "deg)";
      rotHandle.dataset.deg = Math.round(b.rot) + "°";
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      delete rotHandle.dataset.deg; change(); drawToolbar(); drawSide();
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }
  // On a group's frame: lock them together / take the group apart, right on the screen.
  const groupChip = h("button", { type: "button", class: "ed-chip", onpointerdown: e => e.stopPropagation(),
    onclick: e => { e.stopPropagation(); lockGroup(!groupChip.locked); placeFrame(); } });
  frame.append(groupChip);
  let frameRaf = 0;
  /** One rectangle around all the given nodes that are showing now. */
  const unionRect = nodes => nodes.map(rectOf).filter(r => r && r.width).reduce((u, r) => !u ? { left: r.left, top: r.top, right: r.right, bottom: r.bottom }
    : { left: Math.min(u.left, r.left), top: Math.min(u.top, r.top), right: Math.max(u.right, r.right), bottom: Math.max(u.bottom, r.bottom) }, null);
  function placeFrame() {
    cancelAnimationFrame(frameRaf);
    // The frame sits next to the preview (not inside it, which clips), so handles at the screen's edge stay grabbable.
    const host = preview.parentNode;
    if (host && frame.parentNode !== host) { if (getComputedStyle(host).position === "static") host.style.position = "relative"; host.append(frame); }
    const group = multi.size >= 2;
    const nodes = group ? selectedBlocks().map(x => blockNodes[L.text.blocks.indexOf(x)]) : isSel("block") && !L.text.blocks[sel.i].locked ? [blockNodes[sel.i]] : [];
    const node = nodes.length ? nodes[0] : null;
    const r0 = unionRect(nodes), pv = preview.getBoundingClientRect();
    frame.classList.toggle("group", group);
    if (group) {
      const list = selectedBlocks();
      groupChip.locked = !!list[0].grp && list.every(x => x.grp === list[0].grp);
      groupChip.textContent = groupChip.locked ? "🔓 Ungroup" : "🔒 Group";
      groupChip.title = groupChip.locked ? "Take the group apart: each item moves and sizes on its own again" : "Lock these together: they move and resize as one, on the screen and the timeline";
    }
    // Only the part that's on the screen.
    const r = r0 && { left: Math.max(r0.left, pv.left), top: Math.max(r0.top, pv.top), right: Math.min(r0.right, pv.right), bottom: Math.min(r0.bottom, pv.bottom) };
    if (!host || !r || r.right - r.left < 2 || r.bottom - r.top < 2) { frame.hidden = true; } else {
      const box = host.getBoundingClientRect();
      frame.hidden = false;
      Object.assign(frame.style, { left: (r.left - box.left) + "px", top: (r.top - box.top) + "px", width: (r.right - r.left) + "px", height: (r.bottom - r.top) + "px" });
      frame.classList.toggle("text", !group && L.text.blocks[sel.i].kind === "text");
      frame.classList.toggle("shape", !group && L.text.blocks[sel.i].kind === "shape");
      frame.classList.toggle("box", !group && (L.text.blocks[sel.i].kind === "widget" || L.text.blocks[sel.i].kind === "video"));
    }
    // Keep following it while it's selected (it can animate, the timeline can hide it, the page can resize).
    if (node) frameRaf = requestAnimationFrame(placeFrame);
  }
  /**
   * How much bigger / smaller a corner drag makes something: the pointer's distance from the opposite (fixed) corner,
   * along the diagonal, compared with where the drag started. Smooth whatever the shape's proportions, and never so
   * small that it disappears (at least minPx on its shorter side).
   */
  function cornerFactor(ev, r, dx, dy, sx, sy, minPx) {
    const ax = dx < 0 ? r.right : r.left, ay = dy < 0 ? r.bottom : r.top;
    const vx = sx - ax, vy = sy - ay, len2 = vx * vx + vy * vy || 1;
    const f = ((ev.clientX - ax) * vx + (ev.clientY - ay) * vy) / len2;
    return clampN(f, Math.max(0.02, minPx / Math.max(1, Math.min(r.right - r.left, r.bottom - r.top))), 20);
  }
  /** Corner: bigger / smaller (text size or picture width), the opposite corner stays put. Side (text): wrap width. */
  function resizeDrag(e, dx, dy) {
    if (multi.size >= 2) return resizeGroup(e, dx, dy);
    e.preventDefault(); e.stopPropagation(); unfocus();
    const i = sel.i, b = L.text.blocks[i], node = blockNodes[i];
    if (!node) return;
    const box = pvOverlay.getBoundingClientRect(), r = node.getBoundingClientRect(), unit = box.width / 100;
    // Placed by hand from now on, at its current spot.
    const x0 = (r.left - box.left) / box.width * 100, y0 = (r.top - box.top) / box.height * 100;
    const right = x0 + r.width / box.width * 100, bottom = y0 + r.height / box.height * 100;
    const fs0 = b.fs || SIZE_EM[b.size] || 2.8, sx = e.clientX, sy = e.clientY;
    const boxy = b.kind === "shape" || b.kind === "widget" || b.kind === "video";
    const w0 = boxy ? 0 : b.w || 0;
    // Sizes when the drag started (every move scales from these, not from the last move).
    const sw0 = b.w || r.width / unit, sh0 = b.h || r.height / unit, iw0 = b.w || r.width / unit;
    node.className = node.className.replace(/\bso-pos-\S+/, "").trim();
    node.classList.add("so-free");
    let moved = false;
    const mv = ev => {
      const d = (ev.clientX - sx) * dx, dv = dy ? (ev.clientY - sy) * dy : 0;
      if (!moved && Math.abs(d) < 2 && Math.abs(dv) < 2) return;
      moved = true;
      const f = dx && dy ? cornerFactor(ev, r, dx, dy, sx, sy, boxy ? 10 : 14) : 1;
      if (boxy) {
        // Shapes and widgets: corners keep the shape, sides stretch the width, top / bottom the height (all in % of the screen width).
        // Never thinner than about 8 px on the screen, so it can't disappear.
        const minW = 8 / unit;
        if (dx && dy) { b.w = sw0 * f; b.h = sh0 * f; }
        else if (dx) b.w = Math.max(minW, (r.width + d) / unit);
        else b.h = Math.max(b.shape === "line" ? 2 / unit : minW, (r.height + dv) / unit);
        b.w = Math.round(clampN(b.w, 0.3, 400) * 100) / 100; b.h = Math.round(clampN(b.h, 0.1, 400) * 100) / 100;
        node.style.width = b.w + "em"; node.style.height = b.h + "em";
      } else if (!dy) {
        // Side handle on text: how wide it wraps (in % of the screen).
        b.w = Math.round(clampN((r.width + d) / unit, 3, 100) * 10) / 10;
        node.style.width = (b.w * unit) + "px"; node.style.maxWidth = "none";
      } else if (b.kind === "image") {
        b.w = Math.round(clampN(iw0 * f, 2, 100) * 10) / 10;
        node.style.width = b.w + "em";
      } else {
        b.fs = Math.round(clampN(fs0 * f, 0.5, 30) * 10) / 10;
        node.style.fontSize = b.fs + "em";
        if (w0) { b.w = Math.round(clampN(w0 * f, 3, 100) * 10) / 10; node.style.width = (b.w * unit) + "px"; }
      }
      // Keep the opposite side where it was.
      const nr = node.getBoundingClientRect();
      b.x = Math.round((dx < 0 ? right - nr.width / box.width * 100 : x0) * 10) / 10;
      b.y = Math.round((dy < 0 ? bottom - nr.height / box.height * 100 : y0) * 10) / 10;
      Object.assign(node.style, { left: b.x + "%", top: b.y + "%", right: "auto", bottom: "auto", transform: "none" });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      if (moved) { change(); drawToolbar(); }
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }
  /** A group (or several selected): everything grows / shrinks together and keeps its place in the group; the opposite corner stays put. */
  function resizeGroup(e, dx, dy) {
    e.preventDefault(); e.stopPropagation(); unfocus();
    const box = pvOverlay.getBoundingClientRect(), unit = box.width / 100;
    const items = selectedBlocks().map(b => {
      const n = blockNodes[L.text.blocks.indexOf(b)], r = rectOf(n);
      return r && r.width ? { b, n, r, fs0: b.fs || SIZE_EM[b.size] || 2.8, w0: b.w || (b.kind !== "text" ? r.width / unit : 0), h0: b.h || r.height / unit } : null;
    }).filter(Boolean);
    if (!items.length) return;
    const U = unionRect(items.map(it => it.n));
    const uw = U.right - U.left, uh = U.bottom - U.top;
    const ax = dx < 0 ? U.right : U.left, ay = dy < 0 ? U.bottom : U.top;
    const sx = e.clientX, sy = e.clientY;
    items.forEach(it => { it.n.className = it.n.className.replace(/\bso-pos-\S+/, "").trim(); it.n.classList.add("so-free"); });
    let moved = false;
    const mv = ev => {
      const d = (ev.clientX - sx) * dx, dv = (ev.clientY - sy) * dy;
      if (!moved && Math.abs(d) < 2 && Math.abs(dv) < 2) return;
      moved = true;
      const f = cornerFactor(ev, U, dx, dy, sx, sy, 14);
      items.forEach(({ b, n, r, fs0, w0, h0 }) => {
        if (b.kind === "image") { b.w = Math.round(clampN(w0 * f, 2, 100) * 10) / 10; n.style.width = b.w + "em"; }
        else if (b.kind === "shape" || b.kind === "widget" || b.kind === "video") {
          b.w = Math.round(clampN(w0 * f, 0.5, 400) * 10) / 10; b.h = Math.round(clampN(h0 * f, 0.2, 400) * 10) / 10;
          n.style.width = b.w + "em"; n.style.height = b.h + "em";
        }
        else {
          b.fs = Math.round(clampN(fs0 * f, 0.5, 30) * 10) / 10; n.style.fontSize = b.fs + "em";
          if (w0) { b.w = Math.round(clampN(w0 * f, 3, 100) * 10) / 10; n.style.width = (b.w * unit) + "px"; }
        }
        // Same spot inside the group, scaled from the fixed corner.
        b.x = Math.round(((ax + (r.left - ax) * f) - box.left) / box.width * 1000) / 10;
        b.y = Math.round(((ay + (r.top - ay) * f) - box.top) / box.height * 1000) / 10;
        Object.assign(n.style, { left: b.x + "%", top: b.y + "%", right: "auto", bottom: "auto", transform: "none" });
      });
    };
    const up = () => {
      window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up);
      if (moved) { change(); drawToolbar(); }
    };
    window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
  }
  function removeSelected() {
    const del = new Set(selectedBlocks());
    for (let k = L.text.blocks.length - 1; k >= 0; k--) if (del.has(L.text.blocks[k])) L.text.blocks.splice(k, 1);
    sel = null; change(); select(null);
  }
  function lockGroup(on) {
    const list = selectedBlocks();
    const id = on ? L.text.blocks.reduce((m, x) => Math.max(m, x.grp || 0), 0) + 1 : 0;
    list.forEach(x => { x.grp = id; });
    change(); drawToolbar();
    toast(on ? "Grouped: these " + list.length + " move and resize together on the screen and the timeline." : "Ungrouped. Each one moves and sizes on its own again.");
  }
  function lineUp(edge) {
    const len = T(), list = selectedBlocks();
    if (!L.text.cycle) L.text.cycle = len;
    if (edge === "start") { const f = Math.min(...list.map(x => x.from || 0)); list.forEach(x => { const d = (x.to || len) - (x.from || 0); x.from = f; x.to = Math.min(len, f + d); }); }
    else { const t = Math.max(...list.map(x => x.to || len)); list.forEach(x => { x.to = Math.max((x.from || 0) + 0.5, t); }); }
    list.forEach(x => { if (x.to >= len) x.to = 0; if (x.to && x.to <= x.from) x.to = 0; });
    change(); drawSide();
  }

  // ---------- spacing (letter spacing sideways, line spacing up and down) ----------
  // For the whole text, or only the part highlighted in the "Selected text" box.
  let spacingOpen = false, textBox = null;
  const NORMAL_LH = 1.2;
  /** The highlighted part of the selected text: { s, e } character positions, or null for the whole text. */
  function textRange(b) {
    if (!textBox || !textBox.isConnected || textBox.dataset.i !== String(sel && sel.i)) return null;
    const s = textBox.selectionStart, e = textBox.selectionEnd;
    return e > s && b.text.slice(s, e).trim() ? { s, e } : null;
  }
  const lineOf = (text, pos) => text.slice(0, pos).split("\n").length - 1;
  /** Letter spacing for part of the text: replaces whatever was set for those letters. */
  function setRun(b, s, e, ls) { setPart(b, "runs", "ls", s, e, ls, b.ls || 0); }
  /** A setting for part of the text (list b[listKey] of { s, e, [key] }): replaces whatever was set for those letters. */
  function setPart(b, listKey, key, s, e, val, whole) {
    const out = [];
    (b[listKey] || []).forEach(r => {
      if (r.e <= s || r.s >= e) return out.push(r);
      if (r.s < s) out.push({ s: r.s, e: s, [key]: r[key] });
      if (r.e > e) out.push({ s: e, e: r.e, [key]: r[key] });
    });
    if (val !== whole) out.push({ s, e, [key]: val });
    b[listKey] = out.sort((a, c) => a.s - c.s);
  }
  /** Thickness of the whole text: 100 (thin) to 900 (heavy). */
  const weightOf = b => b.wt || (b.bold ? 700 : 400);
  const WEIGHT_NAMES = [[150, "Thin"], [250, "Extra light"], [350, "Light"], [450, "Normal"], [550, "Medium"], [650, "Semi-bold"], [750, "Bold"], [850, "Extra bold"], [901, "Black"]];
  const weightName = v => WEIGHT_NAMES.find(([m]) => v < m)[1];
  /** After typing in the text: keep each part's spacing on the same letters / lines. */
  function remapSpacing(b, a, z) {
    if (!(b.runs && b.runs.length) && !(b.wruns && b.wruns.length) && !(b.llh && b.llh.some(Boolean))) return;
    let p = 0; while (p < a.length && p < z.length && a[p] === z[p]) p++;
    let q = 0; while (q < a.length - p && q < z.length - p && a[a.length - 1 - q] === z[z.length - 1 - q]) q++;
    const d = z.length - a.length, endOld = a.length - q;
    const mv = x => x <= p ? x : x >= endOld ? x + d : Math.min(x, z.length - q);
    b.runs = (b.runs || []).map(r => ({ s: mv(r.s), e: mv(r.e), ls: r.ls })).filter(r => r.e > r.s);
    b.wruns = (b.wruns || []).map(r => ({ s: mv(r.s), e: mv(r.e), wt: r.wt })).filter(r => r.e > r.s);
    const nl = t => t.split("\n").length - 1, dl = nl(z) - nl(a), at = lineOf(a, p) + 1;
    if (dl > 0) (b.llh = b.llh || []).splice(at, 0, ...Array(dl).fill(null));
    else if (dl < 0 && b.llh) b.llh.splice(at, -dl);
  }
  function spacingPanel(b) {
    const r = textRange(b);
    const lines = r ? [lineOf(b.text, r.s), lineOf(b.text, r.e - 1)] : null;
    const runAt = r && (b.runs || []).find(x => x.s <= r.s && x.e > r.s);
    const lsNow = r ? (runAt ? runAt.ls : b.ls || 0) : b.ls || 0;
    const lhNow = r ? ((b.llh || [])[lines[0]] || b.lh || NORMAL_LH) : b.lh || NORMAL_LH;
    const wAt = r && (b.wruns || []).find(x => x.s <= r.s && x.e > r.s);
    const wtNow = r ? (wAt ? wAt.wt : weightOf(b)) : weightOf(b);
    const wtVal = h("span", { class: "sp-val sp-wname" }, weightName(wtNow));
    const show = (v, unit) => h("span", { class: "sp-val" }, unit === "×" ? Number(v).toFixed(2) : (v > 0 ? "+" : "") + Math.round(v * 100));
    const lsVal = show(lsNow), lhVal = show(lhNow, "×");
    const slider = (min, max, step, value, oninput) => h("input", { type: "range", min, max, step, value, oninput });
    const preview = r ? b.text.slice(r.s, r.e).replace(/\s+/g, " ").trim() : "";
    return h("div", { class: "sp-pop" },
      h("div", { class: "sp-scope small" }, r
        ? [h("strong", {}, "Only the highlighted part: "), "“" + (preview.length > 30 ? preview.slice(0, 30) + "…" : preview) + "”",
          h("button", { type: "button", class: "small", onclick: () => { textBox.setSelectionRange(0, 0); drawToolbar(); } }, "Use the whole text")]
        : [h("strong", {}, "Whole text. "), h("span", { class: "muted" }, "To change only part of it, highlight that part in the “Selected text” box on the left.")]),
      h("label", { class: "sp-row" }, h("span", {}, "↔ Letter spacing"),
        slider(-0.1, 1, 0.01, lsNow, e => {
          const v = Number(e.target.value);
          if (r) setRun(b, r.s, r.e, v); else b.ls = v;
          lsVal.textContent = (v > 0 ? "+" : "") + Math.round(v * 100); change();
        }), lsVal),
      h("label", { class: "sp-row" }, h("span", {}, "↕ Line spacing" + (r && lines[1] > lines[0] ? " (lines " + (lines[0] + 1) + "–" + (lines[1] + 1) + ")" : r ? " (line " + (lines[0] + 1) + ")" : "")),
        slider(0.6, 3, 0.02, lhNow, e => {
          const v = Number(e.target.value);
          if (r) { b.llh = b.llh || []; for (let l = lines[0]; l <= lines[1]; l++) b.llh[l] = Math.abs(v - (b.lh || NORMAL_LH)) < 0.005 ? null : v; }
          else b.lh = Math.abs(v - NORMAL_LH) < 0.005 ? 0 : v;
          lhVal.textContent = v.toFixed(2); change();
        }), lhVal),
      h("label", { class: "sp-row" }, h("span", {}, "𝐁 Thickness"),
        slider(100, 900, 10, wtNow, e => {
          const v = Number(e.target.value);
          if (r) setPart(b, "wruns", "wt", r.s, r.e, v, weightOf(b));
          else { b.wt = v; b.bold = v >= 600; }
          wtVal.textContent = weightName(v); change();
        }), wtVal),
      h("div", { class: "sp-acts" },
        h("button", { type: "button", class: "small", onclick: () => {
          if (r) { setRun(b, r.s, r.e, b.ls || 0); setPart(b, "wruns", "wt", r.s, r.e, weightOf(b), weightOf(b)); if (b.llh) for (let l = lines[0]; l <= lines[1]; l++) b.llh[l] = null; }
          else { b.ls = 0; b.lh = 0; b.runs = []; b.llh = []; b.wruns = []; b.wt = 0; }
          change(); drawToolbar();
        } }, r ? "Reset this part" : "Reset all")));
  }

  // ---------- toolbar ----------
  const toolbar = h("div", { class: "card ed-toolbar" });
  const tbBtn = (label, on, onclick, title) => h("button", { type: "button", class: "small" + (on ? " on" : ""), title: title || label, onclick }, label);
  const sw = (checked, onchange) => h("label", { class: "switch", title: "On / off" }, h("input", { type: "checkbox", checked, onchange: e => onchange(e.target.checked) }), h("span", {}));
  function drawToolbar() {
    const kids = [];
    if (multi.size >= 2) {
      const list = selectedBlocks(), locked = !!list[0].grp && list.every(x => x.grp === list[0].grp);
      kids.push(h("strong", { class: "small" }, list.length + " selected"),
        locked ? tbBtn("🔓 Unlock group", false, () => lockGroup(false), "Let them move on their own again")
          : h("button", { type: "button", class: "small primary", title: "Keep them together: on the screen and the timeline they move and resize as one", onclick: () => lockGroup(true) }, "🔒 Lock as group"),
        tbBtn("⇤ Same start", false, () => lineUp("start"), "Start them all at the same time"),
        tbBtn("⇥ Same end", false, () => lineUp("end"), "End them all at the same time"),
        tbBtn("Clear selection", false, () => select(null)),
        h("button", { type: "button", class: "small danger", onclick: async () => {
          if (await confirmDlg("Delete " + list.length + " items?", "You can still leave without saving to get them back.", "Delete")) removeSelected();
        } }, "Delete all"),
        h("span", { class: "small muted" }, "On the screen: drag any of them to move them together, drag a corner dot to resize them all. On the timeline: drag a bar to move them, an end to stretch them."));
    } else if (isSel("block")) {
      const i = sel.i, b = L.text.blocks[i];
      const upd = fn => e => { fn(e); change(); };
      if (b.kind === "text") {
        kids.push(
          h("select", { title: "Font", onchange: upd(e => { b.font = e.target.value; }) }, opts(FONT_LABELS, b.font || "sans")),
          h("label", { class: "tb-num", title: "Text size" }, "Size", h("input", { type: "number", min: 1, max: 30, step: 0.2, value: b.fs || SIZE_EM[b.size] || 2.8,
            oninput: upd(e => { b.fs = clampN(Number(e.target.value) || 2.8, 1, 30); }) })),
          tbBtn("B", b.bold, () => { b.bold = !b.bold; b.wt = 0; change(); drawToolbar(); }, "Bold (for any thickness, use Spacing & thickness)"),
          tbBtn("I", b.italic, () => { b.italic = !b.italic; change(); drawToolbar(); }, "Italic"),
          ...[["left", "⇤"], ["center", "↔"], ["right", "⇥"]].map(([a, l]) => tbBtn(l, b.align === a, () => { b.align = b.align === a ? "" : a; change(); drawToolbar(); }, "Align " + a)),
          colorIn(b.color, v => { b.color = v; change(); }, "Text"),
          colorIn(b.bg, v => { b.bg = v; if (!b.bgOpacity) { b.bgOpacity = 100; drawToolbar(); } change(); }, "Box"),
          h("label", { class: "tb-num", title: "Box opacity" }, "Box", h("input", { type: "range", min: 0, max: 100, value: b.bgOpacity, style: "width:80px", oninput: upd(e => { b.bgOpacity = Number(e.target.value); }) })),
          h("label", { class: "tb-num", title: "Width in % of the screen (0 = fit the text)" }, "Width", h("input", { type: "number", min: 0, max: 100, step: 1, value: b.w || 0,
            oninput: upd(e => { b.w = clampN(Number(e.target.value) || 0, 0, 100); }) })),
          tbBtn("↔↕ Spacing & thickness", spacingOpen, () => { spacingOpen = !spacingOpen; drawToolbar(); }, "Letter spacing (sideways), line spacing (up and down) and thickness (thin to heavy)"));
        if (spacingOpen) kids.push(spacingPanel(b));
      } else if (b.kind === "video") {
        kids.push(h("strong", { class: "small" }, "🎬 " + ((b.image && b.image.name) || "Video")),
          h("select", { title: "How the video fills its box", onchange: upd(e => { b.fit = e.target.value; }) },
            h("option", { value: "cover", selected: b.fit !== "contain" }, "Fill the box (edges may be cut)"), h("option", { value: "contain", selected: b.fit === "contain" }, "Whole video (bars if needed)")),
          tbBtn(b.sound ? "🔊 Sound on" : "🔇 Muted", !!b.sound, () => {
            b.sound = !b.sound;
            if (b.sound) L.text.blocks.forEach(x => { if (x !== b && x.kind === "video") x.sound = false; }); // one video with sound at a time
            change(); drawToolbar();
          }, "Sound plays on the TV (one video at a time; on a video wall it comes from the top-left TV)"),
          h("span", { class: "small muted" }, "Drag the dots to size it."));
      } else if (b.kind === "widget") {
        const m = media.find(x => x.id === b.mediaId);
        kids.push(h("strong", { class: "small" }, "🧩 " + widgetLabel(b)),
          m ? h("button", { type: "button", class: "small", onclick: () => editWidget(b, m) }, "⚙ Widget settings") : null,
          h("span", { class: "small muted" }, "Drag the dots to size it."));
      } else if (b.kind === "shape") {
        kids.push(h("strong", { class: "small" }, "◆ " + shapeLabel(b)),
          colorIn(b.fill, v => { b.fill = v; if (!b.fillOpacity) { b.fillOpacity = 100; drawToolbar(); } change(); drawSide(); }, "Inside"),
          h("label", { class: "tb-num", title: "How see-through the inside is (0 = no inside, only the border)" }, "", h("input", { type: "range", min: 0, max: 100, value: b.fillOpacity, style: "width:70px", oninput: upd(e => { b.fillOpacity = Number(e.target.value); }) })),
          colorIn(b.stroke, v => { b.stroke = v; if (!b.sw) { b.sw = 0.4; drawToolbar(); } change(); drawSide(); }, "Border"),
          h("label", { class: "tb-num", title: "Border thickness" }, "Thickness", h("input", { type: "range", min: 0, max: 3, step: 0.05, value: b.sw || 0, style: "width:90px", oninput: upd(e => { b.sw = Number(e.target.value); }) })),
          h("label", { class: "tb-num", title: "Turn (degrees, clockwise)" }, "⟳", h("input", { type: "number", min: -180, max: 180, step: 1, value: Math.round(b.rot || 0), style: "width:64px",
            oninput: upd(e => { b.rot = ((Number(e.target.value) || 0) + 540) % 360 - 180; drawSide(); }) }), "°"));
      } else {
        kids.push(h("strong", { class: "small" }, "Picture"),
          h("label", { class: "tb-num", title: "Width in % of the screen" }, "Width", h("input", { type: "range", min: 3, max: 100, value: b.w || 30, style: "width:120px",
            oninput: upd(e => { b.w = Number(e.target.value); }) })),
          colorIn(b.bg, v => { b.bg = v; if (!b.bgOpacity) { b.bgOpacity = 100; drawToolbar(); } change(); }, "Frame"),
          h("label", { class: "tb-num" }, "", h("input", { type: "range", min: 0, max: 100, value: b.bgOpacity, style: "width:70px", title: "Frame opacity", oninput: upd(e => { b.bgOpacity = Number(e.target.value); }) })));
      }
      if (b.locked) {
        kids.length = 0;
        kids.push(h("strong", { class: "small" }, "📌 " + (b.kind === "shape" ? shapeLabel(b) : (b.image && b.image.name) || "Picture") + " is locked at the bottom"),
          h("span", { class: "small muted" }, "It stays under everything and can't be clicked or moved on the screen."),
          h("button", { type: "button", class: "small primary", onclick: () => { b.locked = false; change(); drawToolbar(); placeFrame(); toast("Unlocked: you can move and resize it again."); } }, "🔓 Unlock"),
          h("button", { type: "button", class: "small danger", onclick: () => removeBlock(i) }, "Delete"));
        toolbar.replaceChildren(...kids);
        return;
      }
      const free = typeof b.x === "number";
      if (b.kind !== "text") kids.push(tbBtn("📌 Lock at bottom", false, () => {
        b.locked = true; b.above = false; b.grp = 0;
        L.text.blocks.splice(i, 1); L.text.blocks.unshift(b); sel.i = 0;
        change(); drawToolbar(); placeFrame(); toast("Locked at the bottom: it stays under everything and clicks go to what's on top.");
      }, "Keep it under everything and stop it being clicked or moved on the screen (for backgrounds)"));
      kids.push(
        h("select", { title: "Snap to a spot", onchange: e => { b.position = e.target.value; b.x = null; b.y = null; change(); drawToolbar(); } },
          free ? h("option", { value: "", selected: true }, "Placed by hand") : null, opts(POSITION_LABELS, free ? "" : b.position)),
        h("span", { class: "tb-group", title: "What's over / under what when things overlap" },
          h("span", { class: "small muted" }, "Order"),
          tbBtn("⤒", false, () => restack("front"), "Bring to front (over everything)"),
          tbBtn("↑", false, () => restack("up"), "Bring forward (over the next thing it overlaps)"),
          tbBtn("↓", false, () => restack("down"), "Send backward (under the next thing it overlaps)"),
          tbBtn("⤓", false, () => restack("back"), "Send to back (under everything)")),
        tbBtn("Duplicate", false, () => {
          const c = JSON.parse(JSON.stringify(b));
          if (typeof c.x === "number") { c.x += 2; c.y += 2; }
          c.track = nextTrack(); c.grp = 0; // stays at the same level (just over the original)
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
      kids.push(h("span", { class: "small muted" }, "Click something on the screen or a bar in the timeline to edit it. Drag text and pictures to move them, drag the corner dots to resize. Click again to pick what's underneath."));
    }
    toolbar.replaceChildren(...kids.filter(k => k != null && k !== false));
  }

  // ---------- side panel ----------
  const TABS = [["templates", "Templates"], ["ai", "✨ AI"], ["media", "Media"], ["shapes", "Shapes"], ["widgets", "Widgets"], ["text", "Text"], ["specials", "Specials"], ["effects", "Effects"], ["video", "Background"]];
  let chainNext = true;
  // Effect for pictures when none is selected: applied to every picture in the design and to the ones added next.
  const firstPic = L.text.blocks.find(x => x.kind === "image" && x.fx && x.fx !== "none");
  const picFx = { kind: "image", fx: firstPic ? firstPic.fx : "none", fxColor: firstPic ? firstPic.fxColor : "#facc15" };
  let thumbs = [], undo = null, aiBusy = false, aiNote = "", aiPrompt = "", edCat = "all";
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
  async function saveAsTemplate() {
    const r = await dialog("Save as template",
      h("div", {}, field("Template name", h("input", { name: "name", required: true, maxlength: 60, placeholder: "e.g. Lunch specials" })),
        field("Description (optional)", h("input", { name: "description", maxlength: 200, placeholder: "What it's for" })),
        isStaff() ? h("label", { class: "check-row" }, h("input", { type: "checkbox", name: "shared" }), "Share with all clients (their pictures are left out)") : null,
        h("p", { class: "small muted", style: "margin:.5rem 0 0" }, "Saves the layers as they are now (text, pictures, specials, effects, timing). The screen itself doesn't change.")),
      { submit: "Save template", onSubmit: f => api("POST", "/layer-templates", { name: f.get("name"), description: f.get("description"), shared: f.get("shared") === "on", layers: L }) });
    if (!r) return;
    templates = await api("GET", "/layer-templates").catch(() => templates);
    tab = "templates"; drawSide();
    toast("Saved as template “" + r.name + "”. It's in the Templates tab" + (r.shared ? " for every client." : "."));
  }
  function templatesPanel() {
    const out = [undoBar(),
      h("button", { type: "button", class: "primary", style: "width:100%;margin-bottom:.6rem", onclick: saveAsTemplate }, "💾 Save this design as a template"),
      h("p", { class: "small muted" }, "Pick a design to start from, then change the words, colors and positions.")];
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
        const btn = h("button", { type: "button", class: "ed-template", title: tp.description, onclick: async () => {
          const has = L.specials.enabled || L.text.enabled || L.effects.enabled;
          if (has && !await confirmDlg("Use the “" + tp.name + "” template?", "It replaces this design. You can undo it until you save.", "Use template")) return;
          applyDesign(tp.layers, "Template “" + tp.name + "”");
          toast("Template applied. Change the words, then save.");
        } }, box, h("strong", { class: "small" }, tp.name), fx ? h("span", { class: "small muted" }, " · " + fx) : null);
        if (!tp.canDelete) return btn;
        // Saved templates can be deleted.
        return h("div", { class: "ed-template-wrap" }, btn, h("button", { type: "button", class: "ed-template-del", title: "Delete this template", onclick: async () => {
          if (!await confirmDlg("Delete the template “" + tp.name + "”?", tp.shared ? "It disappears for every client. Screens that used it keep their design." : "Screens that used it keep their design.", "Delete")) return;
          try { await api("DELETE", "/layer-templates/" + tp.savedId); templates = templates.filter(x => x.id !== tp.id); drawSide(); toast("Template deleted."); } catch (e) { fail(e); }
        } }, "×"));
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
  function looksFields(b, title, after) {
    const on = b.fx && b.fx !== "none";
    const done = () => { if (after) after(); change(); };
    return h("div", {},
      h("div", { class: "small muted ed-cat" }, title || (b.kind === "image" ? "Picture effect" : b.kind === "shape" ? "Shape effect" : "Text effect")),
      h("div", { class: "ed-fx" }, TEXT_FX_LABELS.map(([v, l]) => h("button", { type: "button", class: (b.fx || "none") === v ? "on" : "",
        onclick: () => { if (b.fx !== v && TEXT_FX_COLORS[v]) b.fxColor = TEXT_FX_COLORS[v]; b.fx = v; done(); drawSide(); } }, l))),
      on && b.fx !== "grow" ? h("div", { class: "colors" }, colorIn(b.fxColor || "#facc15", v => { b.fxColor = v; done(); },
        b.fx === "shadow" ? "Shadow color" : b.fx === "shine" ? "Shine color" : "Glow color")) : null,
      b.fx === "neon" && b.kind !== "image" ? h("p", { class: "small muted", style: "margin:.25rem 0 0" }, "Tip: neon looks best with white or light text and no box.") : null);
  }
  function timingFields(b) {
    const len = T();
    const tracks = [...new Set(L.text.blocks.map(x => x.track || 0))].sort((a, c) => c - a);
    const timed = () => { if (!L.text.cycle) L.text.cycle = len; };
    return h("div", {},
      h("div", { class: "row" },
        field("Entrance", h("select", { onchange: e => { b.enter = e.target.value; timed(); change(); } }, opts(ENTER_LABELS, b.enter || "none"))),
        field("Exit", h("select", { onchange: e => { b.exit = e.target.value; timed(); change(); } }, opts(EXIT_LABELS, b.exit || "none")))),
      h("div", { class: "row", style: "align-items:flex-end" },
        field("Transition length", h("select", { onchange: e => { b.td = Number(e.target.value); change(); } }, opts(TD_OPTIONS, b.td || 1))),
        field("Timeline row", h("select", { onchange: e => { b.track = e.target.value === "new" ? nextTrack() : Number(e.target.value); change(); } },
          tracks.map((t, k) => h("option", { value: t, selected: t === (b.track || 0) }, "Row " + (k + 1))), h("option", { value: "new" }, "+ New row"))),
        h("button", { type: "button", class: "small", style: "margin-bottom:.75rem", title: "Play this part of the timeline",
          onclick: () => { playhead = Math.max(0, (b.from || 0) - 0.5); updatePlayhead(); setPlaying(true); } }, "▶ Preview")),
      h("p", { class: "small muted", style: "margin:0 0 .5rem" }, "Tip: put pictures on the same timeline row and let their bars overlap. The overlap becomes the transition (a crossfade unless you pick one)."),
      h("div", { class: "row" },
      h("div", { class: "field" }, h("label", {}, "Show from (s)"), h("input", { type: "number", min: 0, max: len, step: 0.5, value: b.from || 0,
        oninput: e => { if (!L.text.cycle) L.text.cycle = len; b.from = clampN(Number(e.target.value) || 0, 0, len); if (b.to && b.to <= b.from) b.to = 0; change(); } })),
      h("div", { class: "field" }, h("label", {}, "Until (s)"), h("input", { type: "number", min: 0, max: len, step: 0.5, value: b.to || len,
        oninput: e => { if (!L.text.cycle) L.text.cycle = len; const v = clampN(Number(e.target.value) || len, 0, len); b.to = v >= len ? 0 : v; change(); } }))));
  }
  function drawSide() {
    thumbs.forEach(o => o.destroy()); thumbs = [];
    tabsBar.replaceChildren(...TABS.map(([k, l]) => h("button", { type: "button", class: tab === k ? "on" : "", onclick: () => { tab = k; drawSide(); } }, l)));
    const kids = [];
    if (tab === "media") {
      const b = isSel("block") && L.text.blocks[sel.i].kind === "image" ? L.text.blocks[sel.i] : null;
      if (b) kids.push(h("div", { class: "sub-item" }, h("div", { class: "layer-head" }, h("strong", { class: "small" }, "Selected picture"),
        h("button", { type: "button", class: "small", onclick: () => { sel = null; select(null); drawSide(); } }, "Unselect")), looksFields(b), timingFields(b)));
      else kids.push(h("div", { class: "sub-item" }, looksFields(picFx, "Picture effect (all pictures)", () =>
        L.text.blocks.forEach(x => { if (x.kind === "image") { x.fx = picFx.fx; x.fxColor = picFx.fxColor; } })),
        h("p", { class: "small muted", style: "margin:.25rem 0 0" }, "Applies to every picture on this design and the ones you add. Tap one picture first to give it its own effect.")));
      if (b) kids.push(h("label", { class: "check-row" }, h("input", { type: "checkbox", checked: chainNext, onchange: e => { chainNext = e.target.checked; drawSide(); } }),
        "Add the next picture after this one (same spot, same row: a slideshow)"));
      kids.push(h("p", { class: "small muted" }, b && chainNext ? "Click a picture to show it after the selected one." : "Click a picture to place it on the screen (logos, food photos, price boards)."));
      // Library categories: pictures, backgrounds (fill the screen, behind everything), PNG files, shapes.
      const vids = media.filter(m => m.kind === "video"), pics = images.concat(vids);
      if (pics.length) kids.push(categoryChips(pics, edCat, k => { edCat = k; drawSide(); }, ["all", "video", "picture", "background", "png", "shape"]));
      const catImgs = edCat === "all" ? pics : pics.filter(m => m.category === edCat);
      if (edCat === "video") kids.push(h("p", { class: "small muted", style: "margin:0 0 .4rem" }, isWall ? "A video can go anywhere on the wall, even across the TVs: they all keep it in step." : "Tap a video to put it on the screen. It loops; size it with the dots."));
      if (edCat === "background") kids.push(h("p", { class: "small muted", style: "margin:0 0 .4rem" }, "A background fills the screen, behind all the other pictures and text."));
      kids.push(catImgs.length ? h("div", { class: "ed-imgs" }, catImgs.map(m => h("button", { type: "button", title: m.name,
        onclick: () => m.kind === "video" ? addVideo(m) : b && chainNext ? addAfter(b, m) : m.category === "background" ? addBackground(m)
          : addBlock({ kind: "image", mediaId: m.id, image: { src: m.src, name: m.name }, w: m.category === "shape" ? 20 : 30, x: 35, y: 30, text: "", fx: picFx.fx, fxColor: picFx.fxColor }) },
        m.kind === "video" ? h("span", { class: "ed-vthumb" }, h("video", { src: m.src + "#t=1", muted: true, preload: "metadata" }), h("span", {}, "🎬")) : h("img", { src: m.src, alt: m.name, loading: "lazy" }))))
        : images.length ? h("p", { class: "small" }, "Nothing here yet. ", h("a", { href: base() + "/media", onclick: () => { state.libTab = edCat; } }, "Add some in the Media library"), ".")
        : h("p", { class: "small" }, "No pictures yet. ", h("a", { href: base() + "/media" }, "Upload some in the Media library"), "."));
      kids.push(h("p", { class: "small muted" }, "For pictures that take turns, add them one after another (keep a picture selected and tap the next one)."));
    } else if (tab === "widgets") {
      const b = isSel("block") && L.text.blocks[sel.i].kind === "widget" ? L.text.blocks[sel.i] : null;
      if (b) {
        const m = media.find(x => x.id === b.mediaId);
        kids.push(h("div", { class: "sub-item" },
          h("div", { class: "layer-head" }, h("strong", { class: "small" }, "Selected widget: " + widgetLabel(b)),
            h("button", { type: "button", class: "small", onclick: () => { sel = null; select(null); drawSide(); } }, "Unselect")),
          m ? h("button", { type: "button", class: "small", onclick: () => editWidget(b, m) }, "⚙ Widget settings (colours, city, feed…)") : null,
          h("p", { class: "small muted", style: "margin:.4rem 0 0" }, "Changing its settings changes this widget everywhere it's used. Drag the dots on the screen to size it."),
          timingFields(b)));
      }
      const mine = designWidgets();
      kids.push(h("p", { class: "small muted" }, mine.length ? "Tap a widget to put it on the screen. Then move it, size it, order it, time it, like a picture." : "No widgets yet: make one below."));
      if (mine.length) kids.push(h("div", { class: "ed-widgets" }, mine.map(m => h("button", { type: "button", title: m.name, onclick: () => addWidget(m) },
        thumb(m, "mini"), h("span", { class: "small" }, m.name)))));
      kids.push(h("div", { class: "small muted ed-cat", style: "margin-top:.6rem" }, "Make a new widget"),
        h("div", { class: "ed-newwidgets" }, Object.entries(WIDGET_TYPES).map(([type, T]) => h("button", { type: "button", class: "small", onclick: async () => {
          const r = await widgetDialog(type, null, { stay: true });
          if (r) { media.unshift(r); addWidget(r); toast("Widget made and placed on the screen."); }
        } }, T.icon + " " + T.name))));
    } else if (tab === "shapes") {
      const b = isSel("block") && L.text.blocks[sel.i].kind === "shape" ? L.text.blocks[sel.i] : null;
      if (b) {
        const num = (label, min, max, step, val, set, fmt) => {
          const out = h("span", { class: "sp-val" }, fmt(val));
          return h("label", { class: "sp-row" }, h("span", {}, label), h("input", { type: "range", min, max, step, value: val, oninput: e => { set(Number(e.target.value)); out.textContent = fmt(Number(e.target.value)); change(); } }), out);
        };
        const pct = v => Math.round(v) + "%";
        kids.push(h("div", { class: "sub-item" },
          h("div", { class: "layer-head" }, h("strong", { class: "small" }, "Selected shape: " + shapeLabel(b)),
            h("button", { type: "button", class: "small", onclick: () => { sel = null; select(null); drawSide(); } }, "Unselect")),
          h("div", { class: "small muted ed-cat" }, "Inside"),
          h("div", { class: "row", style: "gap:.6rem;align-items:center" }, colorIn(b.fill, v => { b.fill = v; if (!b.fillOpacity) b.fillOpacity = 100; change(); drawToolbar(); }, "Colour"),
            h("button", { type: "button", class: "small" + (b.fillOpacity ? "" : " on"), onclick: () => { b.fillOpacity = b.fillOpacity ? 0 : 100; change(); drawSide(); drawToolbar(); } }, b.fillOpacity ? "No inside" : "Fill the inside")),
          num("See-through", 0, 100, 1, 100 - b.fillOpacity, v => { b.fillOpacity = 100 - v; }, pct),
          h("div", { class: "small muted ed-cat" }, "Border"),
          h("div", { class: "row", style: "gap:.6rem;align-items:center" }, colorIn(b.stroke, v => { b.stroke = v; if (!b.sw) b.sw = 0.4; change(); drawSide(); drawToolbar(); }, "Colour")),
          num("Thickness", 0, 3, 0.05, b.sw || 0, v => { b.sw = v; }, v => v ? v.toFixed(2) : "none"),
          h("div", { class: "small muted ed-cat" }, "Size (or drag the dots on the screen)"),
          num("Width", 0.5, 300, 0.5, b.w || 18, v => { b.w = v; }, pct),
          num("Height", 0.2, 200, 0.2, b.h || 18, v => { b.h = v; }, v => v.toFixed(1)),
          h("p", { class: "small muted", style: "margin:.1rem 0 .4rem" }, "It can be bigger than the screen or hang off the edge: the screen cuts it off."),
          h("div", { class: "small muted ed-cat" }, "Turn"),
          num("Angle", -180, 180, 1, b.rot || 0, v => { b.rot = v; drawToolbar(); }, v => Math.round(v) + "°"),
          h("div", { class: "row", style: "gap:.35rem;flex-wrap:wrap" },
            ...[["↺ 90°", -90], ["↻ 90°", 90], ["↻ 45°", 45]].map(([l, d]) => h("button", { type: "button", class: "small", onclick: () => { b.rot = (((b.rot || 0) + d) + 540) % 360 - 180; change(); drawSide(); drawToolbar(); } }, l)),
            h("button", { type: "button", class: "small", onclick: () => { b.rot = 0; change(); drawSide(); drawToolbar(); } }, "Straight"))),
          h("div", { class: "sub-item" }, looksFields(b, "Shape effect"), timingFields(b)));
      }
      kids.push(h("p", { class: "small muted" }, "Tap a shape to put it on the screen. Then change its inside colour, its border and its size."));
      kids.push(h("div", { class: "ed-shapes" }, Object.keys(SignageOverlay.SHAPES).map(k => {
        const S = SignageOverlay.SHAPES[k];
        return h("button", { type: "button", title: S[0], "aria-label": S[0], onclick: () => addBlock({ kind: "shape", shape: k, text: "", w: S[2], h: S[3], x: 50 - S[2] / 2, y: 35,
          fill: "#dc2626", fillOpacity: 100, stroke: "#ffffff", sw: S[4] ? 0.6 : 0, bgOpacity: 0, fx: "none" }) },
          h("span", { class: "ed-shape-ic", html: SignageOverlay.shapeSvg({ shape: k, fill: "#94a3b8", fillOpacity: 100, stroke: "#94a3b8", sw: S[4] ? 0.25 : 0 }) }),
          h("span", { class: "small" }, S[0]));
      })));
    } else if (tab === "text") {
      const b = isSel("block") && L.text.blocks[sel.i].kind === "text" ? L.text.blocks[sel.i] : null;
      if (b) {
        kids.push(h("div", { class: "sub-item" },
          field("Selected text", textBox = h("textarea", { rows: 4, maxlength: 600, "data-i": String(sel.i),
            oninput: e => { const old = b.text; b.text = e.target.value; remapSpacing(b, old, b.text); change(); },
            // Highlighting part of the text: the Spacing sliders then change only that part.
            onselect: () => { if (spacingOpen) drawToolbar(); },
            onkeyup: () => { if (spacingOpen) drawToolbar(); },
            onmouseup: () => { if (spacingOpen) setTimeout(drawToolbar, 0); } }, b.text)),
          looksFields(b), timingFields(b)));
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
        EFFECT_LABELS.concat(SCENE_LABELS).map(([v, l]) => h("button", { type: "button", class: ef.enabled && ef.type === v ? "on" : "",
          onclick: () => { ef.enabled = true; ef.type = v; change(); drawSide(); drawToolbar(); } }, l))),
        ef.enabled && ef.type === "santa" ? h("div", { class: "row" },
          field("Santa flies by", h("select", { onchange: e => { ef.every = Number(e.target.value); change(); } }, opts(EVERY_OPTIONS, ef.every))),
          h("label", { class: "check-row", style: "align-self:flex-end" }, h("input", { type: "checkbox", checked: ef.snow, onchange: e => { ef.snow = e.target.checked; change(); } }), "Falling snow too")) : null,
        ef.enabled && ef.type === "plane" ? planeFields(ef, images, change) : null,
        ef.enabled && ef.type === "lights" ? field("How the lights blink", h("select", { onchange: e => { ef.pattern = e.target.value; change(); } }, opts(LIGHT_PATTERNS, ef.pattern || "twinkle"))) : null,
        ef.enabled && ef.type === "fireworks" ? field("Firework shape", h("select", { onchange: e => { ef.shape = e.target.value; change(); } }, opts(FIREWORK_SHAPES, ef.shape || "mixed"))) : null,
        ef.enabled && (ef.type === "rain" || ef.type === "wiper") ? field("How much rain", h("select", { onchange: e => { ef.rain = Number(e.target.value); change(); } }, opts(RAIN_LEVELS, ef.rain || 3))) : null,
        ef.enabled && ef.type === "wiper" ? field("The wiper cleans the screen", h("select", { onchange: e => { ef.wipe = Number(e.target.value); change(); } }, opts(WIPE_OPTIONS, ef.wipe || 10))) : null,
        ef.enabled && (ef.type === "plane" || ef.type === "rain" || ef.type === "wiper") ? null : field("Amount", h("select", { onchange: e => { ef.intensity = e.target.value; change(); } }, opts([["light", "Light"], ["medium", "Medium"], ["heavy", "Heavy"]], ef.intensity))),
        ef.enabled && (ef.type === "plane" || ef.type === "rain" || ef.type === "wiper" || ef.type === "lights") ? null : h("div", { class: "colors" }, colorIn(ef.color, v => { ef.color = v; change(); }, "Color (snow, sparkles, bubbles, hearts, stars)")),
        h("div", { class: "sub-item" }, h("strong", { class: "small" }, "🧱 Video wall effects"),
          h("p", { class: "small muted", style: "margin:.25rem 0 .5rem" }, "On a video wall, effects fly across all its screens: Santa's sleigh or the plane enters on one TV and leaves on the next. Set them on the wall's page."),
          h("a", { class: "btn small", href: base() + "/walls" }, "Open video walls")));
    } else if (!isSlide) {
      // Screens and channels: the design fills the screen on this background colour (or a background picture from Media).
      kids.push(h("div", { class: "layer-head" }, h("strong", {}, "Background")),
        h("div", { class: "row", style: "gap:.6rem;align-items:center" }, colorIn(L.background || "#000000", v => { L.background = v; paintBg(); change(); }, "Background colour"),
          L.background ? h("button", { type: "button", class: "small", onclick: () => { L.background = ""; paintBg(); change(); drawSide(); } }, "Black (none)") : null),
        h("p", { class: "small muted" }, "The design fills the whole screen on this colour. For a picture behind everything, use Media → Backgrounds."),
        ...holidaysPanel());
    } else if (isSlide) {
      kids.push(h("div", { class: "layer-head" }, h("strong", {}, "Slide background")),
        field("Background colour", colorIn(slideBg, v => { slideBg = v; paintBg(); change(); }, "Background")),
        h("p", { class: "small muted" }, "This is a full-screen slide made from a template. Its pictures, text, specials and effects go on top of this colour."),
        s.usedIn && s.usedIn.length ? h("p", { class: "small muted" }, "In: " + s.usedIn.map(p => p.name).join(", ")) : null);
    } else {
      kids.push(h("div", { class: "layer-head" }, h("strong", {}, "Video layer"), sw(L.video.enabled, v => { L.video.enabled = v; drawVideo(true); change(); drawToolbar(); })),
        field("Area on the screen", h("select", { onchange: e => { L.video.region = e.target.value; drawVideo(true); change(); } }, opts(REGION_LABELS, L.video.region))),
        null);
    }
    panel.replaceChildren(...kids.filter(k => k != null && k !== false));
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
    onchange: e => {
      const v = Math.round(Number(e.target.value)), oldLen = T();
      // A longer timeline doesn't stretch anything: items that ran "until the end" keep ending where they did.
      if (v > oldLen) L.text.blocks.forEach(b => { if (!b.to) b.to = oldLen; });
      L.text.cycle = v >= 5 ? Math.min(3600, v) : 0;
      L.text.blocks.forEach(b => { if (b.from >= T()) b.from = 0; if (b.to >= T()) b.to = 0; });
      playhead = playhead % T(); change();
      if (v > oldLen) toast("Timeline is " + v + " s. Everything keeps its times: drag a bar's end to make it longer.");
    } });
  const multiBtn = h("button", { type: "button", class: "small", title: "Tap bars to pick several (or hold Ctrl / Shift and click)",
    onclick: () => { multiMode = !multiMode; multiBtn.classList.toggle("on", multiMode); multiBtn.textContent = multiMode ? "☑ Selecting several: tap bars" : "☐ Select several"; } }, "☐ Select several");
  const timeline = h("div", { class: "card ed-timeline" },
    h("div", { class: "tl-head" }, playBtn, timeLabel, multiBtn,
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
  // ---------- transitions between two items taking turns on a row ----------
  // [name, how the first one leaves, how the next one arrives]. "cut" = no overlap: the next one just replaces it.
  const TRANS_PAIRS = [["Crossfade", "fade", "fade"], ["Cut (no transition)", "none", "none"], ["Push left", "left", "right"], ["Push right", "right", "left"],
    ["Push up", "top", "bottom"], ["Push down", "bottom", "top"], ["Zoom in", "big", "small"], ["Zoom out", "small", "big"], ["Flip", "flip", "flip"],
    ["Spin", "spin", "spin"], ["Pop", "small", "pop"]];
  const transName = (a, b) => { const p = TRANS_PAIRS.find(x => x[1] === (a.exit || "none") && x[2] === (b.enter || "none")); return p ? (p[0] === "Cut (no transition)" ? "Crossfade" : p[0]) : "Custom"; };
  async function transitionDialog(a, b) {
    const len = T(), aEnd = a.to || len, now = Math.max(0.2, aEnd - (b.from || 0));
    let pick = TRANS_PAIRS.find(x => x[1] === (a.exit || "none") && x[2] === (b.enter || "none")) || TRANS_PAIRS[0];
    if (pick[1] === "none" && pick[2] === "none") pick = TRANS_PAIRS[0];
    const lenVal = h("span", { class: "small muted" }, now.toFixed(1) + " s");
    const lenIn = h("input", { type: "range", min: 0.2, max: 5, step: 0.1, value: Math.min(5, now), oninput: e => { lenVal.textContent = Number(e.target.value).toFixed(1) + " s"; } });
    const grid = h("div", { class: "trans-grid" });
    const draw = () => grid.replaceChildren(...TRANS_PAIRS.map(p => h("button", { type: "button", class: "small" + (p === pick ? " on" : ""), onclick: () => { pick = p; draw(); } }, p[0])));
    draw();
    const label = x => x.kind === "widget" ? widgetLabel(x) : x.kind === "image" ? (x.image && x.image.name) || "Picture" : x.kind === "shape" ? shapeLabel(x) : (x.text || "").split("\n")[0].slice(0, 24);
    const ok = await dialog("Transition: " + label(a) + " → " + label(b), h("div", {}, grid,
      h("label", { class: "row", style: "align-items:center;gap:.6rem;margin-top:.8rem" }, h("span", { class: "small" }, "Length"), lenIn, lenVal),
      h("p", { class: "small muted" }, "How “" + label(a) + "” leaves and “" + label(b) + "” arrives. The length is how long they overlap on the timeline.")),
      { submit: "Use this transition", onSubmit: () => true });
    if (!ok) return;
    if (pick[0] === "Cut (no transition)") { b.from = aEnd; a.exit = "none"; b.enter = "none"; }
    else {
      a.exit = pick[1]; b.enter = pick[2];
      // Overlap = the transition's length (the next one starts that much before the first one ends).
      const d = Number(lenIn.value);
      b.from = Math.max((a.from || 0) + 0.2, Math.round((aEnd - d) * 10) / 10);
      a.td = b.td = d;
    }
    if (!L.text.cycle) L.text.cycle = len;
    change(); drawSide(); toast(pick[0] === "Cut (no transition)" ? "Cut: the next one replaces it right away." : pick[0] + " (" + Number(lenIn.value).toFixed(1) + " s).");
  }

  function row(name, type, on, toggle, clips, group) {
    const lane = h("div", { class: "tl-lane", onpointerdown: e => { if (e.target === lane) { seekFrom(e, lane); if (type) select({ type }); } } }, clips);
    return h("div", { class: "tl-row" + (group ? " tl-group" : "") },
      h("div", { class: "tl-name", onclick: () => type && select({ type }) },
        toggle ? h("input", { type: "checkbox", checked: on, title: "On / off", onclick: e => e.stopPropagation(), onchange: e => { toggle(e.target.checked); change(); drawToolbar(); drawSide(); } }) : null,
        h("span", {}, name)),
      lane);
  }
  const markBars = () => tlBody.querySelectorAll(".tl-clip[data-i]").forEach(x => x.classList.toggle("sel", isSelB(Number(x.dataset.i))));
  function barDrag(e, b, i, mode) {
    e.preventDefault(); e.stopPropagation(); unfocus();
    const bar = e.currentTarget.closest(".tl-clip"), lane = bar.parentNode;
    const add = e.ctrlKey || e.metaKey || e.shiftKey || multiMode;
    let toggleOff = false;
    if (add) { if (isSelB(i)) toggleOff = true; else { select({ type: "block", i }, true, true); markBars(); } }
    else if (!isSelB(i)) { select({ type: "block", i }, true); markBars(); }
    else if (!isSel("block", i)) { sel = { type: "block", i }; drawSide(); }
    const len = T();
    const w = lane.getBoundingClientRect().width, sx = e.clientX;
    const f0 = b.from || 0, t0 = b.to || len, sy = e.clientY;
    // Everything selected (or the locked group) moves / stretches by the same amount.
    const group = (multi.has(b) ? L.text.blocks.filter(x => multi.has(x)) : grpOf(b)).map(x => ({ x, f: x.from || 0, t: x.to || len, bar: tlBody.querySelector('.tl-clip[data-i="' + L.text.blocks.indexOf(x) + '"]') }));
    const lo = mode === "move" ? Math.max(...group.map(g => -g.f)) : mode === "l" ? Math.max(...group.map(g => -g.f)) : Math.max(...group.map(g => g.f + 0.5 - g.t));
    const hi = mode === "move" ? Math.min(...group.map(g => len - g.t)) : mode === "l" ? Math.min(...group.map(g => g.t - 0.5 - g.f)) : Math.min(...group.map(g => len - g.t));
    let moved = false, dropRow = null;
    const mv = ev => {
      const d = (ev.clientX - sx) / w * len;
      if (!moved && Math.abs(ev.clientX - sx) < 3 && Math.abs(ev.clientY - sy) < 6) return;
      moved = true;
      if (group.length > 1) {
        const dd = clampN(snapH(d), lo, hi);
        group.forEach(g => {
          const f = mode === "r" ? g.f : g.f + dd, t = mode === "l" ? g.t : g.t + dd;
          g.x.from = f; g.x.to = t;
          if (g.bar) { g.bar.style.left = (f / len * 100) + "%"; g.bar.style.width = ((t - f) / len * 100) + "%"; g.bar.title = fmtT(f) + " – " + fmtT(t); }
        });
        return;
      }
      if (mode === "move") {
        // Up or down: onto another timeline row.
        const hit = document.elementFromPoint(ev.clientX, ev.clientY);
        const r0 = hit && hit.closest(".tl-row[data-track]");
        const r = r0 && r0.dataset.section === (b.kind === "widget" ? "widgets" : "main") ? r0 : null;
        if (dropRow && dropRow !== r) dropRow.classList.remove("tl-drop");
        dropRow = r && Number(r.dataset.track) !== (b.track || 0) ? r : null;
        if (dropRow) dropRow.classList.add("tl-drop");
      }
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
      if (!moved) { if (toggleOff) { select({ type: "block", i }, true, true); markBars(); } return; }
      if (dropRow) b.track = Number(dropRow.dataset.track);
      if (!L.text.cycle) L.text.cycle = len;
      group.forEach(g => { if (g.x.from <= 0 && g.x.to >= len) { g.x.from = 0; g.x.to = 0; } });
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
    // One timeline row per track; several texts or pictures can share a row and take turns.
    const blockLabel = b => b.kind === "image" ? "🖼 " + ((b.image && b.image.name) || "Picture") : b.kind === "shape" ? "◆ " + shapeLabel(b) : b.kind === "widget" ? "🧩 " + widgetLabel(b) : b.kind === "video" ? "🎬 " + ((b.image && b.image.name) || "Video") : (b.text.split("\n")[0] || "Text");
    // Widgets have their own section (and their own rows) below the text and pictures.
    const isW = b => b.kind === "widget";
    const trackRows = (section, inSection) => {
    const tracks = [...new Set(L.text.blocks.filter(inSection).map(b => b.track || 0))].sort((a, c) => c - a);
    for (const tr of tracks) {
      const idx = L.text.blocks.map((b, i) => i).filter(i => (L.text.blocks[i].track || 0) === tr && inSection(L.text.blocks[i]));
      const clips = [];
      idx.forEach(i => {
        const b = L.text.blocks[i], from = b.from || 0, to = b.to || len, label = blockLabel(b);
        const bar = tlClip((b.kind === "text" ? "tl-text" : b.kind === "widget" ? "tl-image tl-widget" : "tl-image") + (L.text.enabled ? "" : " off") + (isSelB(i) ? " sel" : "") + (b.grp ? " tl-grp" : ""),
          from, to, (b.locked ? "📌 " : "") + (b.grp ? "🔒 " : "") + label, len, { onpointerdown: e => barDrag(e, b, i, "move") });
        bar.dataset.i = i;
        if (b.grp) bar.style.setProperty("--gh", String((b.grp * 67) % 360));
        // Light ends: the entrance and exit transitions.
        const pct = d => Math.min(50, d / Math.max(0.1, to - from) * 100) + "%";
        if (b.enter && b.enter !== "none") bar.append(h("span", { class: "tl-tr in", style: "width:" + pct(b.td || 1), title: "Entrance" }));
        if (b.exit && b.exit !== "none") bar.append(h("span", { class: "tl-tr out", style: "width:" + pct(b.td || 1), title: "Exit" }));
        bar.append(h("span", { class: "tl-h l", onpointerdown: e => barDrag(e, b, i, "l") }), h("span", { class: "tl-h r", onpointerdown: e => barDrag(e, b, i, "r") }));
        clips.push(bar);
      });
      // Where two bars on the row overlap: a transition marker.
      const spans = idx.map(i => [L.text.blocks[i].from || 0, L.text.blocks[i].to || len, i]).sort((a, c) => a[0] - c[0]);
      for (let k = 1; k < spans.length; k++) {
        const o0 = spans[k][0], o1 = Math.min(spans[k - 1][1], spans[k][1]);
        const ia = spans[k - 1][2], ib = spans[k][2];
        if (o1 > o0) clips.push(tlClip("tl-overlap", o0, o1, transName(L.text.blocks[ia], L.text.blocks[ib]), len, {
          title: "Transition (" + Math.round((o1 - o0) * 10) / 10 + " s): tap to change it",
          onpointerdown: e => { e.stopPropagation(); e.preventDefault(); transitionDialog(L.text.blocks[ia], L.text.blocks[ib]); } }));
      }
      const name = idx.length === 1 ? blockLabel(L.text.blocks[idx[0]]) : idx.length + " " + (idx.every(i => L.text.blocks[i].kind === "image") ? "pictures" : idx.every(i => isW(L.text.blocks[i])) ? "widgets" : "items");
      const r = row(name, null, false, null, clips);
      r.dataset.track = tr; r.dataset.section = section;
      r.querySelector(".tl-name").addEventListener("click", () => {
        const cur = isSel("block") ? idx.indexOf(sel.i) : -1;
        select({ type: "block", i: idx[(cur + 1) % idx.length] });
      });
      rows.push(r);
    }
    };
    trackRows("main", b => !isW(b));
    if (!L.text.blocks.some(b => !isW(b))) rows.push(row("", null, false, null, [h("span", { class: "tl-empty" }, "Empty. Add text, pictures or shapes in their tabs.")]));
    else {
      const r = row("+ New row", null, false, null, [h("span", { class: "tl-empty" }, "Drag a bar here to give it a row of its own.")]);
      r.dataset.track = nextTrack(); r.dataset.section = "main"; r.classList.add("tl-newrow");
      rows.push(r);
    }
    // Widgets: drag a bar anywhere on its row to set when it shows; drag its ends to make it longer or shorter.
    const wHead = row("Widgets", null, false, null, [], true);
    wHead.querySelector(".tl-name").append(h("button", { type: "button", class: "tl-add", title: "Put a widget on the screen", onclick: e => { e.stopPropagation(); tab = "widgets"; drawSide(); } }, "+"));
    rows.push(wHead);
    trackRows("widgets", isW);
    if (!L.text.blocks.some(isW)) rows.push(row("", null, false, null, [h("span", { class: "tl-empty" }, "No widgets yet. Tap + (or the Widgets tab) to put a clock, the weather, news… on the screen.")]));
    else {
      const r = row("+ New row", null, false, null, [h("span", { class: "tl-empty" }, "Drag a widget's bar here to give it a row of its own.")]);
      r.dataset.track = nextTrack(); r.dataset.section = "widgets"; r.classList.add("tl-newrow");
      rows.push(r);
    }
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
      const saved = await api("PUT", path + "/layers", isSlide ? { layers: L, bg: slideBg } : L);
      dirty = false; saveBtn.textContent = "Saved";
      if (undo) { undo = null; if (tab === "templates" || tab === "ai") drawSide(); }
      toast(isWall ? "Wall design saved. Its screens update within 30 seconds." : isSlide ? "Slide saved. Screens playing it update within 30 seconds." : isCh ? "Layers saved. Every screen on this channel updates within 30 seconds." : "Layers saved. The screen updates within 30 seconds.");
      // The server drops empty text and unknown pictures: reload if it changed anything we show.
      if (saved.text.blocks.length !== L.text.blocks.length || saved.specials.items.length !== L.specials.items.length) route();
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save");

  const onKey = e => {
    if (!isSel("block") && !multi.size || /^(INPUT|TEXTAREA|SELECT)$/.test((e.target.tagName || ""))) return;
    if (e.key === "Delete" || e.key === "Backspace") { e.preventDefault(); removeSelected(); }
    if (e.key === "Escape") select(null);
  };
  document.addEventListener("keydown", onKey);

  main.replaceChildren(
    h("a", { href: isSlide ? (state.slideBack || base() + "/widgets") : base() + path, class: "back", onclick: e => { if (dirty && !confirm("Leave without saving your changes?")) e.preventDefault(); } }, "← " + (isSlide ? "Back" : s.name)),
    pageHead("Design", (isCh ? "Channel " : isSlide ? "Slide " : isWall ? "Video wall " + wallSize(s) + " · " : "") + s.name + " · " + clientName(), saveBtn),
    h("div", { class: "ed" },
      toolbar, side,
      h("div", { class: "card ed-stage" }, preview,
        h("p", { class: "small muted", style: "margin:.5rem 0 0" }, "Bottom to top: Background → Specials → Text, pictures, shapes & widgets → Effects.")),
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
        h("div", { class: "info" }, h("div", { class: "name" }, it.name), h("div", { class: "small muted" }, it.kind === "web" ? "Web page" : it.kind === "video" ? "Video" : it.kind === "widget" && it.widget && it.widget.type === "design" ? "Design slide" : it.kind === "widget" ? "Widget" : "Image")),
        // Design slides (from a template): change their words, prices and pictures in the designer.
        it.kind === "widget" && it.widget && it.widget.type === "design" ? h("button", { class: "small", title: "Change the words, prices and pictures", onclick: async () => {
          if (dirty) { await save(); if (dirty) return; }
          state.slideBack = location.hash; go("/slides/" + it.mediaId);
        } }, "✏️ Edit") : null,
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
  // The right panel: your media, or the design templates (added as slides).
  let pickTab = "media", templates = null, adding = false;
  const pickTabs = h("div", { class: "seg pick-tabs" });
  const drawTabs = () => pickTabs.replaceChildren(...[["media", "Media"], ["templates", "Templates"]].map(([k, l]) =>
    h("button", { type: "button", class: pickTab === k ? "on" : "", onclick: () => {
      pickTab = k; search.value = ""; search.placeholder = k === "media" ? "Search media…" : "Search templates…"; drawTabs(); drawPicker();
    } }, l)));
  async function addTemplate(tp) {
    if (adding) return;
    adding = true;
    try {
      const m = await api("POST", "/media/widget", { type: "design", name: tp.name, config: { bg: "#0f172a", layers: tp.layers } });
      media.unshift(m);
      items.push({ mediaId: m.id, name: m.name, kind: m.kind, src: m.src, widget: m.widget, duration: 15 }); mark(); draw();
      list.lastElementChild.scrollIntoView({ block: "nearest" });
      drawPicker(); // it now shows under "Your design slides"
      toast("Added “" + tp.name + "” as a slide. Tap ✏️ Edit on it to change the words and prices.");
    } catch (e) { fail(e); } finally { adding = false; }
  }
  const drawTemplates = () => {
    if (!templates) {
      picker.replaceChildren(h("p", { class: "muted small" }, "Loading templates…"));
      api("GET", "/layer-templates").then(t => { templates = t; }, () => { templates = []; }).then(() => { if (pickTab === "templates") drawPicker(); });
      return;
    }
    const q = search.value.toLowerCase();
    const list2 = templates.filter(tp => (tp.name + " " + (tp.description || "")).toLowerCase().includes(q));
    const mine = media.filter(m => m.category === "slide" && m.name.toLowerCase().includes(q));
    const addMine = m => { items.push({ mediaId: m.id, name: m.name, kind: m.kind, src: m.src, widget: m.widget, duration: 15 }); mark(); draw(); list.lastElementChild.scrollIntoView({ block: "nearest" }); toast("Added your slide “" + m.name + "”."); };
    picker.replaceChildren(
      mine.length ? h("div", { class: "small muted ed-cat", style: "margin:.25rem .4rem" }, "Your design slides (already edited)") : null,
      ...mine.map(m => h("div", { class: "pick", title: "Add this slide", onclick: () => addMine(m) }, thumb(m, "mini"),
        h("div", { class: "info", style: "flex:1;min-width:0" }, h("div", { class: "small", style: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, m.name),
          h("div", { class: "small muted" }, m.usedIn.length ? "In " + m.usedIn.map(p => p.name).join(", ") : "Not in a playlist")), h("span", { class: "btn small" }, "+ Add"))),
      h("div", { class: "small muted ed-cat", style: "margin:.6rem .4rem .25rem" }, "Templates"),
      h("p", { class: "small muted", style: "margin:.25rem .4rem .5rem" }, "A template becomes a new full-screen slide in this playlist. Change its words and prices with ✏️ Edit."),
      ...list2.map(tp => h("div", { class: "pick", title: "Add as a slide", onclick: () => addTemplate(tp) },
        thumb({ kind: "widget", widget: { type: "design", config: { bg: "#0f172a", layers: tp.layers } } }, "mini"),
        h("div", { class: "info", style: "flex:1;min-width:0" }, h("div", { class: "small", style: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, tp.name),
          h("div", { class: "small muted", style: "overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, tp.savedId ? (tp.shared ? "Shared template" : "My template") : tp.category || "Template")),
        h("span", { class: "btn small" }, "+ Add"))));
    if (!list2.length) picker.append(h("p", { class: "muted small" }, templates.length ? "No templates match." : "No templates."));
  };
  let pickCat = "all";
  const drawPicker = () => {
    if (pickTab === "templates") return drawTemplates();
    const q = search.value.toLowerCase();
    const inCat = pickCat === "all" ? media : media.filter(m => m.category === pickCat);
    picker.replaceChildren(categoryChips(media, pickCat, k => { pickCat = k; drawPicker(); }), ...inCat.filter(m => m.name.toLowerCase().includes(q)).map(m => h("div", { class: "pick", title: "Add to playlist", onclick: () => {
      items.push({ mediaId: m.id, name: m.name, kind: m.kind, src: m.src, widget: m.widget, duration: m.kind === "web" ? 30 : m.kind === "widget" ? 15 : 10 }); mark(); draw();
      list.lastElementChild.scrollIntoView({ block: "nearest" });
    } }, thumb(m, "mini"), h("div", { class: "info", style: "flex:1;min-width:0" }, h("div", { class: "small", style: "font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" }, m.name),
      h("div", { class: "small muted" }, m.kind === "widget" ? widgetName(m.widget && m.widget.type) || "widget" : m.kind)), h("span", { class: "btn small" }, "+ Add"))));
    if (!media.length) picker.append(h("p", { class: "muted small" }, "No media yet. ", h("a", { href: base() + "/media" }, "Upload some"), "."));
  };
  search.addEventListener("input", drawPicker);
  main.replaceChildren(
    h("a", { href: base() + "/playlists", class: "back", onclick: e => { if (dirty && !confirm("Leave without saving your changes?")) e.preventDefault(); } }, "← All playlists"),
    h("div", { class: "page-head" }, h("div", {}, nameIn, h("div", { class: "muted small", style: "margin-top:.25rem" }, clientName())), h("div", { class: "actions" }, saveBtn)),
    h("div", { class: "grid", style: "grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); align-items:start" },
      h("div", { class: "card", style: "grid-column: span 2; min-width:0" }, h("div", { style: "margin-bottom:.75rem" }, totalEl), list),
      h("div", { class: "card" }, h("h2", {}, "Add to playlist"), pickTabs, h("div", { class: "field" }, search), picker)));
  drawTabs();
  // On narrow screens the 2-column span would overflow.
  if (window.innerWidth < 760) main.querySelector(".card").style.gridColumn = "auto";
  draw(); drawPicker();
  window.onbeforeunload = () => (dirty ? true : undefined);
}

// ---------- inside a client: media ----------
// ---------- media library categories ----------
const MEDIA_TABS = [["all", "All"], ["video", "Videos"], ["picture", "Pictures"], ["background", "Backgrounds"], ["png", "PNG files"], ["shape", "Shapes"], ["web", "Web pages"], ["widget", "Widgets"], ["slide", "Design slides"]];
const PICTURE_CATS = [["picture", "Picture"], ["background", "Background"], ["png", "PNG file"], ["shape", "Shape"]];
const CAT_HINT = {
  background: "Full-screen pictures to put behind a design. In the designer they fill the screen behind everything.",
  png: "PNG files, usually with a see-through background: logos, cut-out food photos, stickers.",
  shape: "Shapes for designs: banners, price bursts, arrows, circles… Make one in any colour with “+ Add shape”, or upload your own.",
  video: "Videos play in the playlist (the Video layer), to their end.",
  slide: "Full-screen slides made from templates for the old playlists. Screens don't play them any more; you can delete them, or start a screen's design from the same template in Design → Templates."
};
/** Category chips with counts; onpick(key). Empty extra tabs (web pages, widgets) are hidden. */
function categoryChips(media, current, onpick, keys) {
  const count = k => k === "all" ? media.length : media.filter(m => m.category === k).length;
  return h("div", { class: "cat-chips", role: "tablist" }, MEDIA_TABS.filter(([k]) => (!keys || keys.includes(k)) && (count(k) || ["all", "video", "picture", "background", "png", "shape"].includes(k)))
    .map(([k, l]) => h("button", { type: "button", role: "tab", class: "chip" + (current === k ? " on" : ""), "aria-selected": String(current === k), onclick: () => onpick(k) }, l, h("span", { class: "chip-n" }, String(count(k))))));
}

// Ready-made shapes, drawn as see-through PNG pictures in the colour you pick: [name, viewBox width, height, SVG inside].
const SHAPES = [
  ["Rectangle", 200, 100, () => '<rect x="4" y="4" width="192" height="92"/>'],
  ["Rounded box", 200, 100, () => '<rect x="4" y="4" width="192" height="92" rx="22"/>'],
  ["Circle", 100, 100, () => '<circle cx="50" cy="50" r="46"/>'],
  ["Price burst", 100, 100, () => { const p = []; for (let i = 0; i < 32; i++) { const a = Math.PI * i / 16 - Math.PI / 2, r = i % 2 ? 38 : 48; p.push((50 + r * Math.cos(a)).toFixed(1) + "," + (50 + r * Math.sin(a)).toFixed(1)); } return '<polygon points="' + p.join(" ") + '"/>'; }],
  ["Star", 100, 100, () => { const p = []; for (let i = 0; i < 10; i++) { const a = Math.PI * i / 5 - Math.PI / 2, r = i % 2 ? 20 : 47; p.push((50 + r * Math.cos(a)).toFixed(1) + "," + (52 + r * Math.sin(a)).toFixed(1)); } return '<polygon points="' + p.join(" ") + '"/>'; }],
  ["Banner", 240, 80, () => '<polygon points="4,8 236,8 216,40 236,72 4,72 24,40"/>'],
  ["Tag", 220, 90, () => '<path d="M4 14 Q4 4 14 4 H176 L216 45 L176 86 H14 Q4 86 4 76 Z"/>'],
  ["Arrow", 200, 100, () => '<polygon points="4,32 130,32 130,6 196,50 130,94 130,68 4,68"/>'],
  ["Speech bubble", 200, 140, () => '<path d="M24 4 H176 Q196 4 196 24 V88 Q196 108 176 108 H80 L44 136 L52 108 H24 Q4 108 4 88 V24 Q4 4 24 4 Z"/>'],
  ["Heart", 100, 92, () => '<path d="M50 88 C20 66 4 50 4 30 C4 14 16 4 30 4 C40 4 46 10 50 16 C54 10 60 4 70 4 C84 4 96 14 96 30 C96 50 80 66 50 88 Z"/>'],
  ["Triangle", 100, 90, () => '<polygon points="50,4 96,86 4,86"/>'],
  ["Bar", 200, 24, () => '<rect x="2" y="2" width="196" height="20" rx="10"/>'],
  ["Ring", 100, 100, () => '<circle cx="50" cy="50" r="42"/>']
];
const shapeSvg = (sh, fill, outline, k) => {
  const ring = sh[0] === "Ring";
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + sh[1] + ' ' + sh[2] + '" width="' + Math.round(sh[1] * k) + '" height="' + Math.round(sh[2] * k) + '">' +
    '<g fill="' + (ring ? "none" : fill) + '" stroke="' + (ring ? fill : outline || "none") + '" stroke-width="' + (ring ? 10 : outline ? 4 : 0) + '" stroke-linejoin="round">' + sh[3]() + '</g></svg>';
};
/** A shape → a see-through PNG file (longest side 1200 px). */
function shapePng(sh, fill, outline) {
  return new Promise((resolve, reject) => {
    const k = 1200 / Math.max(sh[1], sh[2]);
    const img = new Image();
    img.onload = () => {
      const c = document.createElement("canvas"); c.width = Math.round(sh[1] * k); c.height = Math.round(sh[2] * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? resolve(new File([b], sh[0] + ".png", { type: "image/png" })) : reject(new Error("Couldn't draw the shape.")), "image/png");
    };
    img.onerror = () => reject(new Error("Couldn't draw the shape."));
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(shapeSvg(sh, fill, outline, k));
  });
}
async function shapeDialog() {
  let pick = SHAPES[0];
  const fill = h("input", { type: "color", value: "#dc2626" }), outOn = h("input", { type: "checkbox" }), out = h("input", { type: "color", value: "#ffffff" });
  const name = h("input", { name: "name", maxlength: 200, placeholder: "e.g. Red price burst" });
  const grid = h("div", { class: "shape-grid" });
  const draw = () => grid.replaceChildren(...SHAPES.map(sh => h("button", { type: "button", class: "shape-pick" + (sh === pick ? " on" : ""), title: sh[0], "aria-label": sh[0],
    onclick: () => { pick = sh; draw(); }, html: shapeSvg(sh, fill.value, outOn.checked ? out.value : null, 1).replace("<svg ", '<svg style="max-width:100%;max-height:52px" ') })));
  [fill, out].forEach(x => x.addEventListener("input", draw)); outOn.addEventListener("change", draw);
  draw();
  const r = await dialog("Add a shape", h("div", {}, grid,
    h("div", { class: "row", style: "gap:1rem;flex-wrap:wrap;margin:.75rem 0" }, h("label", { class: "color-in" }, fill, "Colour"),
      h("label", { class: "check-row" }, outOn, "Outline"), h("label", { class: "color-in" }, out, "Outline colour")),
    field("Name", name)),
  { submit: "Add shape", onSubmit: async () => {
    const file = await shapePng(pick, fill.value, outOn.checked ? out.value : null);
    const fd = new FormData(); fd.append("category", "shape"); fd.append("files", file, (name.value.trim() || pick[0]) + ".png");
    return api("POST", "/media", fd);
  } });
  if (r) { toast("Shape added. Use it in the designer's Media tab."); route(); }
}

async function renderMedia(main) {
  const media = await api("GET", "/media");
  const tab = state.libTab && MEDIA_TABS.some(([k]) => k === state.libTab) ? state.libTab : "all";
  const pictureTab = PICTURE_CATS.some(([k]) => k === tab);
  const input = h("input", { type: "file", multiple: true, accept: tab === "video" ? "video/*" : pictureTab ? "image/*" : "image/*,video/*", class: "hidden", onchange: e => upload([...e.target.files]) });
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
    // Uploading from a picture tab (Backgrounds, Shapes…) puts the pictures in that category.
    if (pictureTab) fd.append("category", tab);
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
  const shown = tab === "all" ? media : media.filter(m => m.category === tab);
  const tabLabel = (MEDIA_TABS.find(([k]) => k === tab) || [])[1];
  main.replaceChildren(
    pageHead("Media", clientName(), tab === "shape" ? h("button", { onclick: shapeDialog }, "+ Add shape") : null, h("button", { onclick: addWeb }, "+ Web page"),
      h("button", { class: "primary", onclick: () => input.click() }, pictureTab ? "Upload to " + tabLabel : "Upload")),
    categoryChips(media, tab, k => { state.libTab = k; route(); }),
    CAT_HINT[tab] ? h("p", { class: "small muted", style: "margin:-.25rem 0 .75rem" }, CAT_HINT[tab]) : null,
    zone,
    shown.length ? h("div", { class: "media-grid" }, shown.map(m => h("div", { class: "media-card" },
      m.kind === "widget" ? h("a", { href: "#", onclick: e => { e.preventDefault(); widgetDialog(m.widget.type, m); } }, thumb(m)) : h("a", { href: m.src, target: "_blank", rel: "noopener" }, thumb(m)),
      h("div", { class: "meta" }, h("div", { class: "name", title: m.name }, m.name),
        h("div", { class: "small muted" }, m.kind === "web" ? new URL(m.src).hostname : m.category === "slide" ? "Design slide (from a template)" : m.kind === "widget" ? "Widget · " + widgetName(m.widget && m.widget.type) : m.kind + " · " + bytes(m.size)),
        m.usedIn.length ? h("div", { class: "small muted" }, "In " + m.usedIn.map(p => p.name).join(", ")) : null,
        // Pictures: move to another category.
        m.kind === "image" ? h("label", { class: "cat-move small" }, "Category ", h("select", { "aria-label": "Category", onchange: async e => {
          try { await api("PATCH", "/media/" + m.id, { category: e.target.value }); toast("Moved to " + PICTURE_CATS.find(([k]) => k === e.target.value)[1] + "s."); route(); } catch (er) { fail(er); }
        } }, PICTURE_CATS.map(([k, l]) => h("option", { value: k, selected: m.category === k }, l)))) : null),
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
      : h("div", { class: "card empty" }, media.length ? "Nothing in " + tabLabel + " yet." + (tab === "shape" ? " Tap “+ Add shape” to make one." : pictureTab ? " Upload pictures here, or move them here from another category." : "")
        : "No media yet. Upload images and videos to use in playlists."));
}

// ---------- inside a client: channels ----------
const layerChips = on => h("div", { class: "chips" }, [["specials", "Specials"], ["text", "Text & pictures"], ["effects", "Effects"]].map(([k, l]) =>
  h("span", { class: "pill" + (on.includes(k) ? " ok" : "") }, (on.includes(k) ? "● " : "○ ") + l)));

/** Design (menu): every screen, channel and design slide of the client, with its layers and a Design button. */
async function renderDesign(main) {
  const [screens, channels, media, walls] = await Promise.all([api("GET", "/screens"), api("GET", "/channels"), api("GET", "/media"), api("GET", "/walls")]);
  const slides = media.filter(m => m.kind === "widget" && m.widget && m.widget.type === "design");
  const row = (title, sub, chips, href, label, primary) => h("tr", { class: "click", onclick: e => { if (!e.target.closest("a")) location.hash = href; } },
    h("td", {}, h("strong", {}, title), sub ? h("div", { class: "small muted" }, sub) : null),
    h("td", {}, chips),
    h("td", { style: "text-align:right" }, h("a", { class: "btn small" + (primary ? " primary" : ""), href }, label)));
  const table = rows => h("div", { class: "table-wrap" }, h("table", { class: "design-list" }, h("tbody", {}, rows)));
  main.replaceChildren(
    pageHead("Design", clientName() + " · what shows on top of the playlists: specials, text, pictures, effects"),
    h("div", { class: "card" }, h("h2", {}, "Screens"),
      screens.length ? table(screens.map(s => s.wallId
        ? row(s.name, "In the video wall “" + s.wallName + "”: it shows its part of the wall's design.", h("span", { class: "muted small" }, "—"), base() + "/walls/" + s.wallId + "/layers", "Design wall")
        : s.channelId
          ? row(s.name, "Uses the channel “" + s.channelName + "” (its design is shared).", layerChips((channels.find(c => c.id === s.channelId) || {}).layersOn || []), base() + "/channels/" + s.channelId + "/layers", "Design channel")
          : row(s.name, [s.location, s.planned ? "No TV yet" : null].filter(Boolean).join(" · "), layerChips(s.layersOn || []), base() + "/screens/" + s.id + "/layers", "Design", true)))
        : h("p", { class: "muted" }, "No screens yet. ", h("a", { href: "#", onclick: e => { e.preventDefault(); pairDialog(); } }, "Add a screen"), " (it can be set up before the TV is connected).")),
    walls.length ? h("div", { class: "card" }, h("h2", {}, "Video walls"),
      table(walls.map(w => row(w.name, wallSize(w) + " · " + w.tiles.length + " TV(s) placed", layerChips(w.layersOn || []), base() + "/walls/" + w.id + "/layers", "Design", true)))) : null,
    channels.length ? h("div", { class: "card" }, h("h2", {}, "Channels"),
      table(channels.map(c => row(c.name, c.screens.length + " screen(s)", layerChips(c.layersOn), base() + "/channels/" + c.id + "/layers", "Design", true)))) : null,
    // Slides made for the old playlists: only listed if there are any (screens don't play them any more).
    slides.length ? h("div", { class: "card" }, h("h2", {}, "Old design slides"),
      h("p", { class: "small muted" }, "These were made from templates for playlists, which screens no longer use. You can delete them in Media → Design slides."),
      table(slides.map(m => row(m.name, "Full-screen slide", h("span", { class: "small muted" }, ""), base() + "/slides/" + m.id, "Open", false)))) : null);
  state.slideBack = location.hash;
}

async function renderChannels(main) {
  const channels = await api("GET", "/channels");
  const create = async () => {
    const r = await dialog("New channel", h("div", {},
      h("p", { class: "muted small" }, "A channel is one design you can put on many screens. Change the channel once and every screen on it updates."),
      field("Name", h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. Lunch menu boards" })),
      ),
    { submit: "Create channel", onSubmit: f => api("POST", "/channels", Object.fromEntries(f)) });
    if (r) go("/channels/" + r.id);
  };
  main.replaceChildren(
    pageHead("Channels", clientName() + " · one design for many screens", h("button", { class: "primary", onclick: create }, "+ New channel")),
    channels.length ? h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Channel"), h("th", {}, "Design"), h("th", {}, "Screens"))),
      h("tbody", {}, channels.map(c => h("tr", { class: "click", onclick: () => go("/channels/" + c.id) },
        h("td", {}, h("strong", {}, c.name)),
        h("td", {}, layerChips(c.layersOn)),
        h("td", { class: "small" }, c.screens.length ? c.screens.length + " (" + c.screens.filter(s => s.online).length + " online)" : h("span", { class: "muted" }, "—")))))))
      : h("div", { class: "card empty" }, h("p", {}, "No channels yet. Use a channel when several screens should show the same thing, like all the menu boards in one store."),
        h("button", { class: "primary", onclick: create }, "+ New channel")));
}

async function renderChannel(main, id) {
  const [c, screens] = await Promise.all([api("GET", "/channels/" + id), api("GET", "/screens")]);
  const nameIn = h("input", { value: c.name, maxlength: 100 });
  const picked = new Set(c.screens.map(s => s.id));
  const saveBtn = h("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      await api("PATCH", "/channels/" + id, { name: nameIn.value });
      await api("PUT", "/channels/" + id + "/screens", { screenIds: [...picked] });
      toast("Channel saved. Its screens update within 30 seconds."); route();
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save");
  main.replaceChildren(
    h("a", { href: base() + "/channels", class: "back" }, "← All channels"),
    pageHead(c.name, "Channel · " + clientName(), h("button", { class: "danger", onclick: async () => {
      if (!await confirmDlg("Delete channel “" + c.name + "”?", "Its screens go back to their own design. Media is kept.")) return;
      try { await api("DELETE", "/channels/" + id); toast("Channel deleted."); go("/channels"); } catch (e) { fail(e); }
    } }, "Delete"), saveBtn),
    h("div", { class: "grid two" },
      h("div", { class: "stack" },
        h("div", { class: "card" }, h("h2", {}, "Channel"), field("Name", nameIn)),
        h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Layers"),
          h("a", { class: "btn primary small", href: base() + "/channels/" + id + "/layers" }, "Design layers")), layerChips(c.layersOn))),
      h("div", { class: "card" }, h("h2", {}, "Screens on this channel"),
        screens.length ? h("div", { class: "check-list" }, screens.map(s => h("label", { class: "check-row" },
          h("input", { type: "checkbox", checked: picked.has(s.id), onchange: e => { e.target.checked ? picked.add(s.id) : picked.delete(s.id); } }),
          h("span", { style: "flex:1" }, h("strong", {}, s.name), h("span", { class: "small muted" }, s.channelId && s.channelId !== c.id ? " · now on “" + s.channelName + "”" : s.location ? " · " + s.location : "")),
          statusPill(s))))
          : h("p", { class: "muted" }, "No screens yet."),
        h("p", { class: "small muted", style: "margin-bottom:0" }, "Ticked screens show this channel's design. Click Save to apply."))));
}

// ---------- inside a client: video walls ----------
const wallSize = w => w.cols + " × " + w.rows;

async function renderWalls(main) {
  const walls = await api("GET", "/walls");
  const create = async () => {
    const r = await dialog("New video wall", h("div", {},
      h("p", { class: "muted small" }, "A video wall shows one big picture across several screens mounted next to each other. Each screen shows its own part, and they play in step."),
      field("Name", h("input", { name: "name", required: true, maxlength: 100, placeholder: "e.g. Front window wall" })),
      h("div", { class: "row" },
        field("Screens across", h("select", { name: "cols" }, [1, 2, 3, 4, 5, 6].map(n => h("option", { value: n, selected: n === 2 }, n)))),
        field("Screens down", h("select", { name: "rows" }, [1, 2, 3, 4, 5, 6].map(n => h("option", { value: n, selected: n === 1 }, n)))))),
    { submit: "Create wall", onSubmit: f => api("POST", "/walls", Object.fromEntries(f)) });
    if (r) go("/walls/" + r.id);
  };
  main.replaceChildren(
    pageHead("Video walls", clientName() + " · one picture across several screens", h("button", { class: "primary", onclick: create }, "+ New video wall")),
    walls.length ? h("div", { class: "card table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Wall"), h("th", {}, "Size"), h("th", {}, "Content"), h("th", {}, "Screens"))),
      h("tbody", {}, walls.map(w => h("tr", { class: "click", onclick: () => go("/walls/" + w.id) },
        h("td", {}, h("strong", {}, w.name)),
        h("td", { class: "small" }, wallSize(w)),
        h("td", { class: "small" }, w.playlistId ? "Pictures & videos" : h("span", { class: "pill warn" }, "None yet")),
        h("td", { class: "small" }, w.tiles.length + " of " + (w.cols * w.rows) + " placed (" + w.tiles.filter(t => t.online).length + " online)"))))))
      : h("div", { class: "card empty" }, h("p", {}, "No video walls yet. Use one when two or more TVs hang side by side and should show one big picture or video."),
        h("button", { class: "primary", onclick: create }, "+ New video wall")));
}

async function renderWall(main, id) {
  const [w, screens, media] = await Promise.all([api("GET", "/walls/" + id), api("GET", "/screens"), api("GET", "/media")]);
  const images = media.filter(m => m.kind === "image");
  const nameIn = h("input", { value: w.name, maxlength: 100 });
  // The wall's pictures and videos, in order (kept as the wall's own list behind the scenes).
  let wallItems = [];
  if (w.playlistId) { try { wallItems = (await api("GET", "/playlists/" + w.playlistId)).items.filter(i => i.kind === "image" || i.kind === "video").map(i => ({ mediaId: i.mediaId, name: i.name, kind: i.kind, src: i.src, duration: i.duration })); } catch (_) {} }
  const wallList = h("div", { class: "wall-items" });
  const addable = media.filter(m => m.kind === "image" || m.kind === "video");
  const addSel = h("select", { "aria-label": "Picture or video to add" }, h("option", { value: "" }, addable.length ? "Add a picture or video…" : "No pictures or videos yet (upload in the Media library)"),
    addable.map(m => h("option", { value: m.id }, (m.kind === "video" ? "🎬 " : "🖼 ") + m.name)));
  addSel.addEventListener("change", () => {
    const m = addable.find(x => x.id === Number(addSel.value)); addSel.value = "";
    if (m) { wallItems.push({ mediaId: m.id, name: m.name, kind: m.kind, src: m.src, duration: 10 }); drawWallItems(); }
  });
  function drawWallItems() {
    wallList.replaceChildren(...wallItems.map((it, k) => h("div", { class: "wall-item" }, thumb(it, "mini"), h("span", { class: "small wall-item-name" }, it.name),
      it.kind === "video" ? h("span", { class: "small muted" }, "plays to the end")
        : h("label", { class: "small" }, h("input", { type: "number", min: 1, max: 3600, value: it.duration, style: "width:64px", "aria-label": "Seconds", oninput: e => { it.duration = Math.max(1, Number(e.target.value) || 10); } }), " s"),
      h("button", { type: "button", class: "icon small", title: "Move up", disabled: k === 0, onclick: () => { [wallItems[k - 1], wallItems[k]] = [wallItems[k], wallItems[k - 1]]; drawWallItems(); } }, "↑"),
      h("button", { type: "button", class: "icon small danger", title: "Remove", onclick: () => { wallItems.splice(k, 1); drawWallItems(); } }, "✕"))));
    if (!wallItems.length) wallList.append(h("p", { class: "small muted" }, "Nothing yet. Add the pictures and videos to show across the wall."));
  }
  drawWallItems();
  const num = (v, max) => h("select", {}, Array.from({ length: max }, (_, i) => i + 1).map(n => h("option", { value: n, selected: n === v }, n)));
  const colsSel = num(w.cols, 6), rowsSel = num(w.rows, 6);
  const bezelIn = h("input", { type: "number", min: 0, max: 10, step: 0.1, value: w.bezel });
  const fitSel = h("select", {}, h("option", { value: "fill", selected: w.fit === "fill" }, "Fill the whole wall (edges may be cut off)"),
    h("option", { value: "fit", selected: w.fit === "fit" }, "Show the whole picture (black bars if the shape differs)"));
  // Which screen is in each spot: key "col:row" -> screenId.
  const spots = new Map(w.tiles.map(t => [t.col + ":" + t.row, t.screenId]));
  const gridBox = h("div", { class: "wall-grid" });
  const byId = new Map(screens.map(s => [s.id, s]));
  function drawGrid() {
    const cols = Number(colsSel.value), rows = Number(rowsSel.value);
    for (const k of [...spots.keys()]) { const [c, r] = k.split(":").map(Number); if (c >= cols || r >= rows) spots.delete(k); }
    gridBox.style.gridTemplateColumns = "repeat(" + cols + ", minmax(0, 1fr))";
    const cells = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const key = c + ":" + r, cur = spots.get(key);
      const sel = h("select", { "aria-label": "Screen in column " + (c + 1) + ", row " + (r + 1), onchange: e => {
        const v = Number(e.target.value) || null;
        // A screen can only be in one spot: take it out of any other.
        for (const [k, sid] of spots) if (sid === v) spots.delete(k);
        if (v) spots.set(key, v); else spots.delete(key);
        drawGrid();
      } }, h("option", { value: "" }, "— empty —"),
        screens.map(s => h("option", { value: s.id, selected: s.id === cur },
          s.name + (s.wallId && s.wallId !== w.id ? " (in “" + s.wallName + "”)" : ""))));
      const s = cur && byId.get(cur);
      cells.push(h("div", { class: "wall-cell" + (cur ? " filled" : "") },
        h("div", { class: "small muted" }, "Column " + (c + 1) + ", row " + (r + 1) + (c === 0 && r === 0 ? " · sound" : "")),
        sel, s ? statusPill(s) : null));
    }
    gridBox.replaceChildren(...cells);
  }
  colsSel.addEventListener("change", drawGrid);
  rowsSel.addEventListener("change", drawGrid);
  drawGrid();
  // ---- wall effects: one animation across every screen of the wall ----
  const fx = Object.assign({}, w.effects);
  const fxBox = h("div", {}), preview = h("div", { class: "wall-preview" });
  let renders = [];
  function drawPreview() {
    renders.forEach(r => r.destroy()); renders = [];
    const cols = Number(colsSel.value), rows = Number(rowsSel.value), gap = Math.max(0, Number(bezelIn.value) || 0) / 100;
    preview.style.gridTemplateColumns = "repeat(" + cols + ", minmax(0, 1fr))";
    preview.style.gap = "calc(" + (gap * 100 / cols) + "% + 3px)";
    const tiles = [];
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const ov = h("div", { class: "pv-overlay" });
      tiles.push(h("div", { class: "wall-tile" }, ov));
      if (fx.enabled) requestAnimationFrame(() => { if (ov.isConnected) renders.push(SignageOverlay.render(ov, { video: { enabled: true, region: "full" }, specials: { enabled: false }, text: { enabled: false }, effects: fx, view: { cols, rows, col: c, row: r, gap } })); });
    }
    preview.replaceChildren(...tiles);
  }
  function drawFx() {
    const all = EFFECT_LABELS.concat(SCENE_LABELS);
    fxBox.replaceChildren(
      h("div", { class: "small muted ed-cat" }, "Templates"),
      h("div", { class: "ed-fx" }, WALL_FX_TEMPLATES.map(tp => h("button", { type: "button", title: tp.desc,
        class: fx.enabled && fx.type === tp.fx.type && fx.intensity === tp.fx.intensity ? "on" : "",
        onclick: () => { Object.assign(fx, tp.fx, { enabled: true }, tp.fx.type === "plane" && fx.banner ? { banner: fx.banner } : {}); drawFx(); drawPreview(); } }, tp.name))),
      h("div", { class: "small muted ed-cat" }, "Or pick an effect"),
      h("div", { class: "ed-fx" },
        h("button", { type: "button", class: fx.enabled ? "" : "on", onclick: () => { fx.enabled = false; drawFx(); drawPreview(); } }, "None"),
        all.map(([v, l]) => h("button", { type: "button", class: fx.enabled && fx.type === v ? "on" : "", onclick: () => { fx.enabled = true; fx.type = v; drawFx(); drawPreview(); } }, l))),
      fx.enabled && fx.type === "plane" ? planeFields(fx, images, drawPreview) : null,
      fx.enabled && fx.type !== "plane" ? h("div", { class: "row" },
        fx.type === "wiper" ? field("The wiper cleans the screen", h("select", { onchange: e => { fx.wipe = Number(e.target.value); drawPreview(); } }, opts(WIPE_OPTIONS, fx.wipe || 10))) : null,
        fx.type === "rain" || fx.type === "wiper" ? field("How much rain", h("select", { onchange: e => { fx.rain = Number(e.target.value); drawPreview(); } }, opts(RAIN_LEVELS, fx.rain || 3)))
          : field("Amount", h("select", { onchange: e => { fx.intensity = e.target.value; drawPreview(); } }, opts([["light", "Light"], ["medium", "Medium"], ["heavy", "Heavy"]], fx.intensity))),
        fx.type === "santa" ? field("Santa flies by", h("select", { onchange: e => { fx.every = Number(e.target.value); drawPreview(); } }, opts(EVERY_OPTIONS, fx.every))) : null,
        fx.type === "lights" ? field("How the lights blink", h("select", { onchange: e => { fx.pattern = e.target.value; drawPreview(); } }, opts(LIGHT_PATTERNS, fx.pattern || "twinkle"))) : null,
        fx.type === "fireworks" ? field("Firework shape", h("select", { onchange: e => { fx.shape = e.target.value; drawPreview(); } }, opts(FIREWORK_SHAPES, fx.shape || "mixed"))) : null) : null,
      fx.enabled && fx.type === "santa" ? h("label", { class: "check-row" }, h("input", { type: "checkbox", checked: fx.snow, onchange: e => { fx.snow = e.target.checked; drawPreview(); } }), "Falling snow too") : null,
      fx.enabled && ["snow", "sparkles", "bubbles", "hearts", "stars", "shooting", "balloons"].includes(fx.type) ? h("div", { class: "colors" }, colorIn(fx.color, v => { fx.color = v; drawPreview(); }, "Color")) : null);
  }
  [colsSel, rowsSel].forEach(x => x.addEventListener("change", drawPreview));
  bezelIn.addEventListener("input", drawPreview);
  const saveBtn = h("button", { class: "primary", onclick: async () => {
    saveBtn.disabled = true;
    try {
      let plId = w.playlistId;
      if (!plId && wallItems.length) plId = (await api("POST", "/playlists", { name: "Video wall: " + nameIn.value })).id;
      if (plId) await api("PUT", "/playlists/" + plId, { name: "Video wall: " + nameIn.value, items: wallItems.map(i => ({ mediaId: i.mediaId, duration: i.duration })) });
      w.playlistId = plId;
      await api("PATCH", "/walls/" + id, { name: nameIn.value, playlistId: plId || null, cols: colsSel.value, rows: rowsSel.value, bezel: bezelIn.value || 0, fit: fitSel.value, effects: fx });
      await api("PUT", "/walls/" + id + "/screens", { tiles: [...spots].map(([k, screenId]) => { const [col, row] = k.split(":").map(Number); return { screenId, col, row }; }) });
      toast("Video wall saved. Its screens update within 30 seconds."); route();
    } catch (e) { fail(e); } finally { saveBtn.disabled = false; }
  } }, "Save");
  main.replaceChildren(
    h("a", { href: base() + "/walls", class: "back" }, "← All video walls"),
    pageHead(w.name, "Video wall · " + clientName(), h("button", { class: "danger", onclick: async () => {
      if (!await confirmDlg("Delete video wall “" + w.name + "”?", "Its screens go back to their own design. Media is kept.")) return;
      try { await api("DELETE", "/walls/" + id); toast("Video wall deleted."); go("/walls"); } catch (e) { fail(e); }
    } }, "Delete"), saveBtn),
    h("div", { class: "grid two" },
      h("div", { class: "card" }, h("div", { class: "layer-head" }, h("h2", { style: "margin:0" }, "Design across the wall"),
          h("a", { class: "btn primary", href: base() + "/walls/" + id + "/layers" }, "🎨 Design the wall")),
        h("p", { class: "small muted" }, "One design (text, pictures, shapes, widgets, specials) stretched across all the wall's TVs: each TV shows its part, lined up across the frames."),
        layerChips(w.layersOn || [])),
      h("div", { class: "card" }, h("h2", {}, "Content"), field("Name", nameIn),
        h("div", { class: "field" }, h("label", {}, "Pictures and videos under the design (optional; in order, then it repeats)"), wallList, addSel),
        h("div", { class: "row" }, field("Screens across", colsSel), field("Screens down", rowsSel)),
        field("Picture", fitSel),
        field("Gap between screens (% of a screen's width)", bezelIn),
        h("p", { class: "small muted", style: "margin-bottom:0" }, "Pictures and videos are shown across the wall. Only the top-left screen plays sound. Make videos and pictures in the wall's shape for the best result, e.g. 3840 × 1080 for two screens side by side. Gap: measure the frame between two screens' pictures and divide by one screen's picture width (e.g. 1 cm ÷ 120 cm ≈ 0.8). 0 if the frames don't matter.")),
      h("div", { class: "card" }, h("h2", {}, "Where each screen hangs"),
        h("p", { class: "small muted" }, "As seen from the front. Pick the screen in each spot."),
        screens.length ? gridBox : h("p", { class: "muted" }, "No screens yet."),
        h("p", { class: "small muted", style: "margin-bottom:0" }, "Screens play in step using the portal's clock. While in a wall, a screen's own design and channel are not used. Click Save to apply."))),
    h("div", { class: "card" }, h("h2", {}, "Wall effects"),
      h("p", { class: "small muted" }, "An animation on top of the wall's pictures and videos that moves across all its screens, like Santa's sleigh flying from one TV to the next. Preview of the whole wall:"),
      preview, fxBox,
      h("p", { class: "small muted", style: "margin-bottom:0" }, "Click Save to send it to the screens.")));
  drawFx(); drawPreview();
}
const WALL_FX_TEMPLATES = [
  { name: "🎅 Santa & reindeer", desc: "Santa's sleigh and reindeer fly across every screen, with falling snow.", fx: { type: "santa", intensity: "medium", every: 20, snow: true, color: "#ffffff" } },
  { name: "✈ Plane with banner", desc: "A small plane pulls your message or logo across every screen.", fx: { type: "plane", intensity: "medium", every: 30, banner: "Grand opening this Saturday!", bannerBg: "#ffffff", bannerColor: "#b91c1c", color: "#ffffff" } },
  { name: "🎄 Christmas lights", desc: "Coloured Christmas lights strung around the edge of the whole wall.", fx: { type: "lights", intensity: "medium", pattern: "twinkle", color: "#ffffff" } },
  { name: "💧 Rainy window", desc: "Raindrops on the glass running down across the whole wall.", fx: { type: "rain", intensity: "medium", rain: 3, color: "#ffffff" } },
  { name: "🚗 Rainy windshield", desc: "Rain builds up on the glass, then a big car wiper sweeps it clean across the whole wall.", fx: { type: "wiper", intensity: "medium", rain: 3, wipe: 10, color: "#ffffff" } },
  { name: "🎆 New Year fireworks", desc: "Fireworks bursting all over the wall.", fx: { type: "fireworks", intensity: "medium", color: "#ffffff" } },
  { name: "🌠 Starry night", desc: "Shooting stars streak from screen to screen over twinkling stars.", fx: { type: "shooting", intensity: "medium", color: "#ffffff" } },
  { name: "🎈 Party balloons", desc: "Colorful balloons float up across the wall.", fx: { type: "balloons", intensity: "medium", color: "#ffffff" } },
  { name: "❄ Snow storm", desc: "Heavy snow falling across every screen.", fx: { type: "snow", intensity: "heavy", color: "#ffffff" } },
  { name: "🎉 Confetti party", desc: "Confetti raining down across the wall.", fx: { type: "confetti", intensity: "medium", color: "#ffffff" } },
  { name: "💕 Valentine hearts", desc: "Pink hearts floating up.", fx: { type: "hearts", intensity: "medium", color: "#fb7185" } },
  { name: "🍂 Autumn leaves", desc: "Falling autumn leaves.", fx: { type: "leaves", intensity: "medium", color: "#ffffff" } }
];

// ---------- inside a client: widgets ----------
const WIDGET_TYPES = {
  clock: { name: "Clock", icon: "🕒", desc: "Digital or analog clock with the date.", config: { style: "digital", hours: "12", showDate: true, showSeconds: false, label: "", bg: "#0f172a", fg: "#ffffff", accent: "#f59e0b" } },
  weather: { name: "Weather", icon: "⛅", desc: "Current weather and a 3-day forecast for any place.", config: { place: "", lat: "", lng: "", units: "f", forecast: true, bg: "#0b3b66", fg: "#ffffff", accent: "#fbbf24" } },
  rss: { name: "News feed", icon: "📰", desc: "Rotating headlines from an RSS or Atom feed.", config: { url: "", title: "News", seconds: 8, bg: "#111827", fg: "#ffffff", accent: "#60a5fa" } },
  qr: { name: "QR code", icon: "🔳", desc: "A scannable code for your website, menu, Wi-Fi or reviews.", config: { text: "", title: "Scan me", caption: "", bg: "#ffffff", fg: "#111827", accent: "#2563eb" } },
  countdown: { name: "Countdown", icon: "⏳", desc: "Days, hours, minutes and seconds to an opening, sale or event.", config: { title: "Grand opening", target: "", done: "We're open!", bg: "#7c2d12", fg: "#ffffff", accent: "#fde68a" } },
  message: { name: "Message", icon: "💬", desc: "A full-screen announcement with a title and text.", config: { title: "", body: "", align: "center", bg: "#1e3a8a", fg: "#ffffff", accent: "#fbbf24" } }
};

async function widgetDialog(type, existing, dlg = {}) {
  if (type === "design" && existing) { state.slideBack = location.hash; go("/slides/" + existing.id); return null; }
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
  if (c.bgOpacity === undefined) c.bgOpacity = 100;
  const opVal = h("span", { class: "small muted", style: "min-width:3rem;text-align:right" }, (100 - c.bgOpacity) + "%");
  const colors = h("div", {}, h("div", { class: "colors" }, colorIn(c.bg, v => set("bg", v), "Background"), colorIn(c.fg, v => set("fg", v), "Text"), colorIn(c.accent, v => set("accent", v), "Accent")),
    h("label", { class: "row wd-opacity", title: "0% = solid background, 100% = no background (only the clock / text shows)" }, h("span", { class: "small" }, "Background see-through"),
      h("input", { type: "range", min: 0, max: 100, step: 1, value: 100 - c.bgOpacity, oninput: e => { opVal.textContent = e.target.value + "%"; set("bgOpacity", 100 - Number(e.target.value)); } }), opVal));

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
  if (r && !dlg.stay) { toast(existing ? "Widget saved." : "Widget added. Add it to a playlist to show it on screens."); route(); }
  return r;
}

const widgetName = type => type === "design" ? "Design slide" : (WIDGET_TYPES[type] || {}).name;
async function renderWidgets(main) {
  const media = (await api("GET", "/media")).filter(m => m.kind === "widget" && !(m.widget && m.widget.type === "design")); // design slides are listed in the Media library and Design, not here
  main.replaceChildren(
    pageHead("Widgets", clientName() + " · ready-made slides for your playlists"),
    h("div", { class: "widget-gallery" }, Object.entries(WIDGET_TYPES).map(([type, T]) => h("button", { type: "button", class: "widget-type", onclick: () => widgetDialog(type) },
      h("div", { class: "wt-icon" }, T.icon), h("div", { class: "wt-name" }, T.name), h("div", { class: "small muted" }, T.desc), h("span", { class: "btn small primary" }, "+ Add")))),
    h("h2", { style: "margin:1.5rem 0 .75rem" }, "Your widgets"),
    media.length ? h("div", { class: "media-grid" }, media.map(m => h("div", { class: "media-card" },
      h("a", { href: "#", onclick: e => { e.preventDefault(); widgetDialog(m.widget.type, m); } }, thumb(m)),
      h("div", { class: "meta" }, h("div", { class: "name", title: m.name }, m.name),
        h("div", { class: "small muted" }, widgetName(m.widget.type)),
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
    { title: "Design the screen", done: layered, text: layered ? "Your first screen has extra layers (specials, text or effects)."
        : "Pick a ready-made template or add specials with prices, a scrolling ticker, text or effects. No TV yet? That's fine: the screen is set up now and the TV connects later.",
      action: async () => {
        if (screens.length) return go("/screens/" + screens[0].id + "/layers");
        // No screen yet: set one up without a TV (connect it in the "Connect a TV" step), then design it.
        try { const sc = await api("POST", "/screens/plan", { name: "Main screen" }); loadCustomers().catch(() => {}); go("/screens/" + sc.id + "/layers"); }
        catch (e) { fail(e); }
      }, label: "Design layers", optional: true },
    { title: "Connect a TV", done: screens.some(s => !s.planned), text: screens.some(s => !s.planned) ? `${screens.filter(s => !s.planned).length} screen(s) connected.`
        : screens.length ? "Your screen is set up. Install the player app on the TV, open it, then click Connect TV on the screen's page and type the code it shows."
        : "Install the player app on the TV, open it, and type the code it shows. No TV yet? Choose “Set up now, connect the TV later” to design the screen first.",
      action: () => pairDialog(), label: "Add screen", alt: [isStaff() ? "#/download" : "#/download", "Get the app"] },
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
    const setupCard = row.canSetup ? h("div", { class: "card", style: "margin-bottom:1rem;border-color:var(--accent, #2563eb)" },
      h("h2", {}, b ? "Finish setting up your monthly payment" : "Choose your screens and set up monthly payment"),
      h("p", {}, "On our secure billing page you choose how many screens you want and your plan, see the monthly price, and set up automatic payment by bank account or card."),
      h("p", { class: "small muted" }, "Your card or bank number is entered on Authorize.net's secure page. We never see or store it."),
      h("button", { class: "primary", onclick: async e => {
        const btn = e.currentTarget; btn.disabled = true;
        // Open the tab right away (phones block tabs opened later), then send it to the setup page.
        const w = window.open("", "_blank");
        try {
          const r = await api("POST", "/billing/setup", { lang: I18N.lang() === "es" ? "es" : "en" });
          if (w) { w.location = r.url; toast("Your billing page opened in a new tab. Come back here when you're done."); } else location.href = r.url;
        } catch (ex) { if (w) w.close(); toast(ex.message, true); }
        btn.disabled = false;
      } }, b ? "Continue to billing ↗" : "Choose screens & set up payment ↗"),
      row.screenLimit != null ? h("p", { class: "small muted", style: "margin-top:.75rem" }, (row.screenLimit === 0 ? "You can connect your TVs once your monthly payment is set up." : "Right now you can connect " + row.screenLimit + " TV" + (row.screenLimit === 1 ? "" : "s") + ".") + " After you finish, the number of TVs you can connect matches the screens you chose (it can take a few minutes).") : null) : null;
    if (setupCard && !b) { main.replaceChildren(head, warn || "", setupCard); return; }
    main.replaceChildren(head, warn || "", setupCard || "",
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
  const crashes = isAdmin() && isStaff() ? await api("GET", "/app-crashes").catch(() => []) : [];
  const portalUrl = location.origin;
  main.replaceChildren(
    pageHead("Download App", "The Premier Signage app for Android TVs, TV boxes and tablets"),
    h("div", { class: "grid two" },
      h("div", { class: "card" }, h("h2", {}, "Player app (Android)"),
        apk.available
          ? h("div", {}, h("p", {}, h("a", { class: "btn primary", href: apk.url }, "⬇ Download player app"), " ", h("span", { class: "small muted" }, apk.file + " · " + bytes(apk.size))),
            h("p", { class: "small muted" }, "On the TV or Android box, open this address in a browser to download it: ", h("span", { class: "mono" }, portalUrl + apk.url)))
          : h("p", { class: "muted" }, "No player app uploaded yet."),
        isAdmin() && isStaff() ? h("div", { style: "margin-top:.5rem" },
          h("p", { class: "small muted", style: "margin:0 0 .4rem" }, "New versions are built and published here automatically when the app changes, and every TV updates itself. Upload by hand only as a backup (for example a version built on your PC)."),
          h("input", { type: "file", accept: ".apk", class: "hidden", id: "apkFile", onchange: async e => {
            const file = e.target.files[0]; if (!file) return;
            e.target.value = "";
            if (!await confirmDlg("Send " + file.name + " to every TV?", "Each TV with app 1.2 or later downloads and installs it within about a minute. It must be signed with the same key and be newer than the current version, or the TVs won't install it.", "Upload and update TVs")) return;
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
          h("li", {}, "Wired internet is more reliable than Wi-Fi for screens."))),
      h("div", { class: "card" }, h("h2", {}, "Fire TV Stick"),
        h("ol", { class: "small", style: "padding-left:1.2rem;margin:0;line-height:1.7" },
          h("li", {}, "Install the free Downloader app from the Amazon app store."),
          h("li", {}, "Settings → My Fire TV → Developer options → Install unknown apps → turn on Downloader. (No Developer options? Settings → My Fire TV → About → click the device name 7 times.)"),
          h("li", {}, "In Downloader, type ", h("span", { class: "mono" }, portalUrl + "/download/PremierSignage.apk"), " and install."),
          h("li", {}, "Updates need a press on Install with the remote.")))),
    crashes.length ? h("div", { class: "card" }, h("h2", {}, "App problems reported by TVs"),
      h("p", { class: "small muted" }, "When the player app crashes it sends the error here, even before the TV is paired. Show this to whoever maintains the app."),
      h("div", { class: "table-wrap" }, h("table", {},
        h("thead", {}, h("tr", {}, h("th", {}, "When"), h("th", {}, "Device"), h("th", {}, "Error"))),
        h("tbody", {}, crashes.map(c => h("tr", {},
          h("td", { class: "small", style: "white-space:nowrap" }, ago(c.at)),
          h("td", { class: "small" }, h("strong", {}, c.screenName ? c.screenName + (c.customerName ? " · " + c.customerName : "") : "Not paired yet"),
            h("div", { class: "muted" }, c.model), h("div", { class: "muted" }, "Android " + c.android + " · app " + c.appVersion)),
          h("td", { class: "small" }, c.stopped ? h("span", { class: "pill danger" }, "kept crashing, stopped") : null,
            h("div", { class: "mono", style: "word-break:break-word" }, c.error),
            h("details", {}, h("summary", { class: "muted" }, "Details"), h("pre", { class: "mono", style: "white-space:pre-wrap;font-size:.72rem;max-height:240px;overflow:auto" }, c.trace))))))))) : null);
}

// ---------- start ----------
(async () => {
  await loadBrand();
  try { state.user = (await api("GET", "/auth/me")).user; await loadCustomers(); setTimeout(refreshIcons, 1500); } catch (_) { state.user = null; }
  route();
})();
