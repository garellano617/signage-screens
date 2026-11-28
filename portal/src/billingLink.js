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

module.exports = { billingStatus, configured, billingUrl: url, resetCache, selfSignup, syncScreenLimits };
