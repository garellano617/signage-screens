"use strict";
// Two-step login for client accounts: after the right password, a 6-digit code by email (or by text, if the
// client chose it and texting is set up). A trusted device skips the code for 30 days, until the password changes.
//
// Texting uses Sent (the same service as the billing app), template-only. It's off until these are set:
//   SENT_API_KEY        Sent API key
//   SENT_CODE_TEMPLATE  ID of an approved Sent template for login codes, with a variable named "code"
// Each text costs money in Sent; emails are free.
const crypto = require("node:crypto");
const { get, run, now } = require("./db");
const { sha256 } = require("./auth");
const { createSent } = require("./sent");

const CODE_MINUTES = 10, DEVICE_DAYS = 30, MAX_TRIES = 5, RESEND_WAIT_MS = 30e3;
const PENDING = "s2fa", DEVICE = "sdev";

let sms = null;
const smsClient = () => {
  if (!sms) sms = createSent({ apiKey: process.env.SENT_API_KEY || "", baseUrl: process.env.SENT_API_URL || undefined });
  return sms;
};
const smsReady = () => !!(process.env.SENT_API_KEY && process.env.SENT_CODE_TEMPLATE);

/** A US cell number as +1XXXXXXXXXX (or "" if it isn't one). */
function e164(v) {
  const d = String(v || "").replace(/\D/g, "");
  if (d.length === 10) return "+1" + d;
  if (d.length === 11 && d[0] === "1") return "+" + d;
  return "";
}
const maskEmail = e => { const [n, d] = String(e).split("@"); return (n || "").slice(0, 2) + "•••@" + (d || ""); };
const maskCell = c => "•••-•••-" + String(c).slice(-4);

/** How this user gets codes: "sms", "email", or null when neither can be sent (then there's no second step). */
function methodFor(u, mailer) {
  const cell = e164(u.cell);
  if (u.code_via === "sms" && cell && smsReady()) return "sms";
  if (mailer.configured) return "email";
  if (cell && smsReady()) return "sms";
  return null;
}

const cookieOpts = (req, maxAge) => ({ httpOnly: true, sameSite: "lax", secure: req.secure, maxAge, path: "/" });

/** Is this browser remembered for this user? */
function trusted(req, u) {
  const t = req.cookies && req.cookies[DEVICE];
  if (!t) return false;
  return !!get("SELECT 1 FROM trusted_devices WHERE token_hash = ? AND user_id = ? AND expires_at > ?", sha256(String(t)), u.id, now());
}
function trust(req, res, u) {
  const t = crypto.randomBytes(32).toString("base64url");
  run("DELETE FROM trusted_devices WHERE expires_at < ?", now());
  run("INSERT INTO trusted_devices (token_hash, user_id, expires_at) VALUES (?, ?, ?)", sha256(t), u.id, now() + DEVICE_DAYS * 864e5);
  res.cookie(DEVICE, t, cookieOpts(req, DEVICE_DAYS * 864e5));
}
/** After a password change: every remembered device has to type a code again. */
const forgetDevices = userId => run("DELETE FROM trusted_devices WHERE user_id = ?", userId);

/** Sends a new code (older codes stop working) and sets the "waiting for the code" cookie. Returns { via, sentTo }. */
async function start(req, res, u, mailer, brandName) {
  const via = methodFor(u, mailer);
  const code = String(crypto.randomInt(0, 1e6)).padStart(6, "0");
  const pending = crypto.randomBytes(32).toString("base64url");
  run("DELETE FROM login_codes WHERE expires_at < ?", now() - 864e5);
  run("UPDATE login_codes SET used_at = ? WHERE user_id = ? AND used_at IS NULL", now(), u.id);
  const r = run("INSERT INTO login_codes (user_id, pending_hash, code_hash, via, created_at, expires_at) VALUES (?,?,?,?,?,?)",
    u.id, sha256(pending), sha256(pending + ":" + code), via, now(), now() + CODE_MINUTES * 60e3);
  try {
    if (via === "sms") {
      await smsClient().send({ to: e164(u.cell), templateId: process.env.SENT_CODE_TEMPLATE, parameters: { code }, idempotencyKey: "login-" + r.lastInsertRowid });
    } else {
      await mailer.send({ to: u.email, subject: code + " is your " + brandName + " login code",
        text: "Your login code is " + code + "\n\nType it on the login page within " + CODE_MINUTES + " minutes.\n\n" +
          "If you didn't just try to log in, someone may know your password. Log in and change it (Profile), or contact us.\n\n" + brandName });
    }
  } catch (e) {
    run("DELETE FROM login_codes WHERE id = ?", r.lastInsertRowid);
    console.error("Login code (" + via + ") to user " + u.id + " failed:", e.message);
    const err = new Error(via === "sms" ? "We couldn't text your login code. Try again in a minute." : "We couldn't email your login code. Try again in a minute.");
    err.status = 502; throw err;
  }
  res.cookie(PENDING, pending, cookieOpts(req, CODE_MINUTES * 60e3));
  return { via, sentTo: via === "sms" ? maskCell(e164(u.cell)) : maskEmail(u.email) };
}

/** The pending login (row + user) for this browser, or null. */
function pendingOf(req) {
  const p = req.cookies && req.cookies[PENDING];
  if (!p) return null;
  const row = get("SELECT * FROM login_codes WHERE pending_hash = ?", sha256(String(p)));
  if (!row || row.used_at || row.expires_at < now()) return null;
  return { row, pending: String(p) };
}

/** Checks the typed code. Returns the user id, or throws { status, message, restart }. */
function check(req, code) {
  const p = pendingOf(req);
  const fail = (status, msg, restart) => { const e = new Error(msg); e.status = status; e.restart = !!restart; return e; };
  if (!p) throw fail(401, "Your code expired. Log in again to get a new one.", true);
  const digits = String(code || "").replace(/\D/g, "");
  const want = Buffer.from(p.row.code_hash), got = Buffer.from(sha256(p.pending + ":" + digits));
  if (digits.length !== 6 || !crypto.timingSafeEqual(want, got)) {
    run("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?", p.row.id);
    const tries = p.row.attempts + 1;
    if (tries >= MAX_TRIES) { run("UPDATE login_codes SET used_at = ? WHERE id = ?", now(), p.row.id); throw fail(401, "Too many wrong codes. Log in again to get a new one.", true); }
    const left = MAX_TRIES - tries;
    throw fail(400, "That code isn't right. " + left + (left === 1 ? " try" : " tries") + " left.");
  }
  run("UPDATE login_codes SET used_at = ? WHERE id = ?", now(), p.row.id);
  return p.row.user_id;
}

/** Resend: only within a pending login, at most every 30 seconds. */
function canResend(req) {
  const p = pendingOf(req);
  if (!p) return null;
  return now() - p.row.created_at >= RESEND_WAIT_MS ? p.row.user_id : -1;
}

module.exports = { methodFor, start, check, canResend, trusted, trust, forgetDevices, smsReady, e164, PENDING, DEVICE };
