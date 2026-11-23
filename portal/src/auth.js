"use strict";
const crypto = require("node:crypto");
const { get, run, now } = require("./db");

const SESSION_DAYS = 30;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return "scrypt$" + salt.toString("hex") + "$" + hash.toString("hex");
}

function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored || "").split("$");
  if (alg !== "scrypt" || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, "hex");
  const actual = crypto.scryptSync(String(password), Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(expected, actual);
}

const sha256 = s => crypto.createHash("sha256").update(s).digest("hex");

/** Makes sure at least one admin exists. Uses ADMIN_EMAIL / ADMIN_PASSWORD, or prints a generated password. */
function ensureAdmin() {
  const envEmail = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const envPassword = process.env.ADMIN_PASSWORD || "";
  if (envEmail && envPassword) {
    const u = get("SELECT id, customer_id FROM users WHERE email = ?", envEmail);
    if (u && u.customer_id) {
      console.error(`ADMIN_EMAIL ${envEmail} belongs to a customer's login, so it was not changed. Use a different email.`);
      return;
    }
    if (!u) {
      // Also covers a first start where the variables were still empty and a placeholder admin was made.
      run("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, 'Admin', ?, 'admin', ?)", envEmail, hashPassword(envPassword), now());
      console.log(`Created admin login: ${envEmail}`);
      return;
    }
    if (process.env.ADMIN_RESET_PASSWORD === "true") {
      run("UPDATE users SET password_hash = ?, role = 'admin' WHERE id = ?", hashPassword(envPassword), u.id);
      run("DELETE FROM sessions WHERE user_id = ?", u.id);
      console.log(`Password for ${envEmail} reset from ADMIN_PASSWORD. Remove ADMIN_RESET_PASSWORD now.`);
    }
    return;
  }
  if (get("SELECT id FROM users WHERE role = 'admin' AND customer_id IS NULL LIMIT 1")) return;
  const email = envEmail || "admin@example.com";
  let password = envPassword;
  const generated = !password;
  if (generated) password = crypto.randomBytes(9).toString("base64url");
  run("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, 'admin', ?)",
    email, "Admin", hashPassword(password), now());
  console.log(`Created admin login: ${email}` + (generated ? `  password: ${password}  (change it in Settings)` : ""));
}

function createSession(userId) {
  const id = crypto.randomBytes(32).toString("base64url");
  run("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)", sha256(id), userId, now() + SESSION_DAYS * 864e5);
  run("DELETE FROM sessions WHERE expires_at < ?", now());
  return id;
}

function destroySession(id) {
  if (id) run("DELETE FROM sessions WHERE id = ?", sha256(id));
}

function sessionCookieOptions(req) {
  return { httpOnly: true, sameSite: "lax", secure: req.secure, maxAge: SESSION_DAYS * 864e5, path: "/" };
}

function requireUser(req, res, next) {
  const sid = req.cookies && req.cookies.sid;
  const user = sid && get(`SELECT u.id, u.email, u.name, u.role, u.customer_id, c.name AS customer_name, c.active AS customer_active
                            FROM sessions s JOIN users u ON u.id = s.user_id LEFT JOIN customers c ON c.id = u.customer_id
                            WHERE s.id = ? AND s.expires_at > ?`, sha256(sid), now());
  if (!user) return res.status(401).json({ error: "Please log in." });
  if (user.customer_id && !user.customer_active) return res.status(401).json({ error: "This account is paused. Please contact your provider." });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Only admins can do that." });
  next();
}

/** Your own team (not a customer's user). */
function requireStaff(req, res, next) {
  if (!req.user || req.user.customer_id) return res.status(403).json({ error: "Only your own team can do that." });
  next();
}

const publicUser = u => ({
  id: u.id, email: u.email, name: u.name, role: u.role,
  customerId: u.customer_id || null, customerName: u.customer_name || null, isStaff: !u.customer_id
});

/** Players authenticate with "Authorization: Bearer <token>" from /api/player/register. */
function requirePlayer(req, res, next) {
  const m = /^Bearer\s+(.+)$/i.exec(req.get("authorization") || "");
  const screen = m && get("SELECT * FROM screens WHERE token_hash = ?", sha256(m[1].trim()));
  if (!screen) return res.status(401).json({ error: "unknown_device" });
  req.screen = screen;
  next();
}

module.exports = {
  hashPassword, verifyPassword, sha256, ensureAdmin, createSession, destroySession,
  sessionCookieOptions, requireUser, requireAdmin, requireStaff, requirePlayer, publicUser
};
