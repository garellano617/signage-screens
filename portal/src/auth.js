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
    const u = get("SELECT id FROM users WHERE email = ?", envEmail);
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
  if (get("SELECT id FROM users WHERE role = 'admin' LIMIT 1")) return;
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
  const user = sid && get(`SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
                            WHERE s.id = ? AND s.expires_at > ?`, sha256(sid), now());
  if (!user) return res.status(401).json({ error: "Please log in." });
  req.user = user;
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || req.user.role !== "admin") return res.status(403).json({ error: "Only admins can do that." });
  next();
}

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
  sessionCookieOptions, requireUser, requireAdmin, requirePlayer
};
