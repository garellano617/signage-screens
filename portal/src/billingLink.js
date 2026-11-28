"use strict";
// Reads each client's billing status from the Premier Signage Billing app (read-only).
// Set BILLING_URL (the billing app's address) and BILLING_KEY (its SIGNAGE_INTEGRATION_KEY).
const url = () => String(process.env.BILLING_URL || "").replace(/\/$/, "");
const key = () => String(process.env.BILLING_KEY || "");
const configured = () => !!(url() && key());

let cache = null, cacheAt = 0;

/** { configured, ok, error, clients: [...] } — cached for a minute. */
async function billingStatus(fetchImpl = globalThis.fetch) {
  if (!configured()) return { configured: false, ok: false, clients: [] };
  if (cache && Date.now() - cacheAt < 60e3) return cache;
  try {
    const r = await fetchImpl(url() + "/api/integration/billing-status", {
      headers: { Authorization: "Bearer " + key(), Accept: "application/json" }, signal: AbortSignal.timeout(10000)
    });
    if (r.status === 401) throw new Error("The billing app refused the key. Check that BILLING_KEY matches its SIGNAGE_INTEGRATION_KEY.");
    if (r.status === 404) throw new Error("The billing app doesn't have the signage connection turned on yet (set SIGNAGE_INTEGRATION_KEY there).");
    if (!r.ok) throw new Error("The billing app replied " + r.status + ".");
    const j = await r.json();
    cache = { configured: true, ok: true, clients: Array.isArray(j.clients) ? j.clients : [], at: Date.now() };
    cacheAt = Date.now();
    return cache;
  } catch (e) {
    const msg = e.name === "TimeoutError" || /fetch failed/.test(e.message) ? "Couldn't reach the billing app at " + url() + "." : e.message;
    // Keep showing the last good data if there is some.
    return cache ? { ...cache, ok: false, error: msg, stale: true } : { configured: true, ok: false, error: msg, clients: [] };
  }
}

function resetCache() { cache = null; cacheAt = 0; }

/** A client who signed up here gets a billing record and their personal setup link: { id, portalUrl, setupDone }. */
async function selfSignup(info, fetchImpl = globalThis.fetch) {
  if (!configured()) throw new Error("Online payment isn't set up yet. Please contact us.");
  let r;
  try {
    r = await fetchImpl(url() + "/api/integration/self-signup", {
      method: "POST", headers: { Authorization: "Bearer " + key(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(info), signal: AbortSignal.timeout(15000)
    });
  } catch (e) { throw new Error("Couldn't reach the billing page right now. Please try again in a minute."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.portalUrl) throw new Error(j.error || "The billing page isn't available right now. Please try again later.");
  resetCache();
  return j;
}

/**
 * Once a linked client is paying (status active), the number of TVs they can add follows the screens on
 * their plan. Only ever raised here, never lowered (lowering is up to you, on the Clients page).
 */
function syncScreenLimits(st) {
  if (!st || !st.ok) return;
  const { all, run } = require("./db");
  const byId = new Map(st.clients.map(b => [b.id, b]));
  for (const c of all("SELECT id, screen_limit, billing_client_id FROM customers WHERE billing_client_id IS NOT NULL AND screen_limit IS NOT NULL")) {
    const b = byId.get(c.billing_client_id);
    const n = b && b.status === "active" ? Number(b.screens) || 0 : 0;
    if (n > c.screen_limit) run("UPDATE customers SET screen_limit = ? WHERE id = ?", Math.min(10000, n), c.id);
  }
}

/** POST to the billing app's signage connection; returns the JSON reply or throws with its message. */
async function post(path, body, fetchImpl = globalThis.fetch) {
  if (!configured()) throw new Error("The billing app isn't connected yet (BILLING_URL and BILLING_KEY).");
  let r;
  try {
    r = await fetchImpl(url() + "/api/integration" + path, {
      method: "POST", headers: { Authorization: "Bearer " + key(), "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body || {}), signal: AbortSignal.timeout(15000)
    });
  } catch (e) { throw new Error("Couldn't reach the billing app right now. Please try again in a minute."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || "The billing app replied " + r.status + "."); e.status = r.status === 404 ? 404 : 502; throw e; }
  return j;
}
/** A billing record for a client your team added here (keeps the screens and plan you set in billing). */
async function addClient(c) {
  const j = await post("/self-signup", { signageId: c.id, name: c.name, contactName: c.contact_name, email: c.email, phone: c.phone,
    selfServe: false, screens: c.screen_limit || 1 });
  resetCache();
  return j;
}
/** One-tap login link into the billing app for this email (a billing user with the same email must exist). */
const ssoLink = email => post("/sso", { email }).then(j => j.url);
/** A billing client's personal setup page. */
const setupLink = id => post("/setup-link", { id });

// Billing clients that must not be linked or created here again (unlinked or deleted by your team).
const setting = (k, d) => { const r = require("./db").get("SELECT value FROM settings WHERE key = ?", k); return r ? r.value : d; };
const setSetting = (k, v) => require("./db").run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", k, v);
function ignored() { try { return new Set(JSON.parse(setting("billing_ignored", "[]"))); } catch (_) { return new Set(); } }
function ignore(id) { if (!id) return; const s = ignored(); s.add(id); setSetting("billing_ignored", JSON.stringify([...s].slice(-2000))); }
function unignore(id) { const s = ignored(); if (s.delete(id)) setSetting("billing_ignored", JSON.stringify([...s])); }

const norm = s => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, " ").trim();
/**
 * Links the two apps' clients by themselves:
 * - a billing client and a client here with the same business name or email are linked;
 * - a billing client added after this was turned on, with no match here, is added here (no logins yet; its screen
 *   limit is the screens it's billed for).
 * Cancelled billing clients are left alone, and so are those your team unlinked or deleted here.
 */
function syncClients(st) {
  const out = { linked: 0, created: 0 };
  if (!st || !st.ok) return out;
  const { all, run, now } = require("./db");
  let since = Number(setting("billing_sync_since", 0));
  if (!since) { since = now(); setSetting("billing_sync_since", String(since)); }
  const skip = ignored();
  const customers = all("SELECT id, name, email, billing_client_id FROM customers");
  const taken = new Set(customers.map(c => c.billing_client_id).filter(Boolean));
  for (const b of st.clients) {
    if (taken.has(b.id) || skip.has(b.id) || b.status === "cancelled") continue;
    const em = String(b.email || "").trim().toLowerCase();
    const m = customers.find(c => !c.billing_client_id && ((em && String(c.email || "").trim().toLowerCase() === em) || (norm(b.name) && norm(c.name) === norm(b.name))));
    if (m) {
      run("UPDATE customers SET billing_client_id = ? WHERE id = ?", b.id, m.id);
      m.billing_client_id = b.id; taken.add(b.id); out.linked++;
      continue;
    }
    const created = Date.parse(b.createdAt || "");
    if (!(created >= since)) continue;
    run(`INSERT INTO customers (name, contact_name, email, phone, notes, screen_limit, active, created_at, billing_client_id)
         VALUES (?,?,?,?,?,?,1,?,?)`, String(b.name || "New client").slice(0, 120), String(b.contactName || "").slice(0, 120),
      em.slice(0, 200), String(b.phone || "").slice(0, 40), "Added from the billing app " + new Date().toISOString().slice(0, 10) + ".",
      Math.max(0, Math.min(10000, Number(b.screens) || 0)), now(), b.id);
    taken.add(b.id); out.created++;
  }
  return out;
}

module.exports = { billingStatus, configured, billingUrl: url, resetCache, selfSignup, syncScreenLimits, syncClients, addClient, ssoLink, setupLink, ignore, unignore };
