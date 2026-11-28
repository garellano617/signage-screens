"use strict";
// Sent (SMS) API client. Sends are template-only, using templates approved in the owner's Sent account.
//
// The request shape below mirrors Sent's documented "messages.send" and "templates.list" operations
// (to[], template {id, parameters}, channel[], idempotency key). The base URL, paths and auth header
// are environment settings so they can be matched to Sent's API reference without code changes:
//   SENT_API_URL (default https://api.sent.dm), SENT_SEND_PATH, SENT_TEMPLATES_PATH, SENT_AUTH_HEADER.
// Checked against docs.sent.dm (Nov 2026): POST /v3/messages, GET /v3/templates (page, page_size),
// x-api-key header, Idempotency-Key header, response data.recipients[].message_id.

class SentError extends Error {
  constructor(message, code, status) { super(message); this.code = code; this.status = status; }
}

function createSent({
  apiKey, baseUrl = "https://api.sent.dm", sendPath = "/v3/messages", templatesPath = "/v3/templates",
  authHeader = "x-api-key", fetchImpl = globalThis.fetch
} = {}) {
  const configured = !!apiKey;
  const headers = extra => Object.assign({ "Content-Type": "application/json", Accept: "application/json" },
    authHeader.toLowerCase() === "authorization" ? { Authorization: "Bearer " + apiKey } : { [authHeader]: apiKey }, extra || {});

  async function req(method, path, body, extraHeaders) {
    if (!configured) throw new SentError("Sent is not set up yet (missing SENT_API_KEY).", "not_configured");
    const res = await fetchImpl(baseUrl.replace(/\/$/, "") + path, { method, headers: headers(extraHeaders), body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    if (!res.ok) {
      const msg = (json && (json.message || json.error && (json.error.message || json.error) || json.detail)) || ("HTTP " + res.status);
      throw new SentError("Sent refused the request: " + msg, res.status === 401 || res.status === 403 ? "auth" : "upstream_error", res.status);
    }
    return json || {};
  }

  let cache = null, cacheAt = 0;
  return {
    configured,
    /** Approved, non-marketing templates. Cached 60s. */
    async listTemplates(force) {
      if (cache && !force && Date.now() - cacheAt < 60e3) return cache;
      const out = [];
      for (let page = 1; page <= 5; page++) {
        // Sent v3: GET /v3/templates?page=1&page_size=100 -> { data: { templates: [...], pagination: { has_more } } }
        const r = await req("GET", templatesPath + "?page=" + page + "&page_size=100");
        const d = r.data || {};
        const items = d.templates || r.items || d.items || (Array.isArray(r.data) ? r.data : []);
        out.push(...items.map(normalizeTemplate));
        if (items.length < 100 || (d.pagination && d.pagination.has_more === false)) break;
      }
      cache = out.filter(t => t.isApprovedForSending !== false && !t.isOpt &&
        !["MARKETING", "AUTHENTICATION"].includes(String(t.category || "").toUpperCase()));
      cacheAt = Date.now();
      return cache;
    },
    /** Sends one templated SMS. idempotencyKey makes retries safe (Sent replays the first result for 24h). */
    async send({ to, templateId, parameters, idempotencyKey }) {
      const r = await req("POST", sendPath, { to: [to], template: { id: templateId, parameters }, channel: ["sms"] }, { "Idempotency-Key": idempotencyKey });
      const first = (r.recipients || r.messages || (r.data && (r.data.recipients || r.data.messages)) || [])[0] || {};
      return { messageId: first.message_id || first.messageId || first.id || r.id || "", raw: r };
    }
  };
}

/**
 * Sent's v3 API returns flat templates ({ id, name, status, variables: ["firstname", ...], auto_reply_action })
 * without the message text. The rest of the app uses the dashboard shape
 * ({ definition.body.multiChannel.variables: [{ id, name }] }), so convert to that.
 */
function normalizeTemplate(t) {
  if (!t || t.definition) return t;
  const status = String(t.status || "").toUpperCase();
  const vars = (t.variables || []).map((v, i) => typeof v === "string" ? { id: i, name: v } : v);
  return {
    id: t.id, name: t.name, category: t.category, language: t.language, status: t.status,
    isApprovedForSending: status ? status === "APPROVED" : t.isApprovedForSending,
    isOpt: !!(t.auto_reply_action || t.isOpt),
    definition: { body: { multiChannel: { template: t.body || "", variables: vars } } }
  };
}

const templateVars = t => (((t.definition || {}).body || {}).multiChannel || {}).variables || t.variables || [];
const templateBody = t => (((t.definition || {}).body || {}).multiChannel || {}).template || t.body || "";

module.exports = { createSent, SentError, templateVars, templateBody, normalizeTemplate };
