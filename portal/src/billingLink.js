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

module.exports = { billingStatus, configured, billingUrl: url, resetCache };
