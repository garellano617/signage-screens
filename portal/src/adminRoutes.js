"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { all, get, run, tx, now, DATA_DIR } = require("./db");
const auth = require("./auth");
const { isOnline } = require("./playerConfig");
const { sanitizeLayers, parseLayers, withImages } = require("./layers");
const widgets = require("./widgets");

const router = express.Router();
router.use(express.json({ limit: "1mb" }));
router.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const bad = msg => new HttpError(400, msg);
const notFound = what => new HttpError(404, what + " not found.");
const intId = v => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw bad("Invalid id."); return n; };
const str = (v, max, label) => {
  const s = String(v == null ? "" : v).trim();
  if (s.length > max) throw bad(`${label} is too long (max ${max}).`);
  return s;
};

// ---------- auth ----------
const failures = new Map(); // ip -> { count, until }
router.post("/auth/login", (req, res) => {
  const key = req.ip || "?";
  const f = failures.get(key);
  if (f && f.count >= 10 && f.until > now()) throw new HttpError(429, "Too many attempts. Try again in a few minutes.");
  const email = str(req.body.email, 200, "Email");
  const user = get(`SELECT u.*, c.name AS customer_name, c.active AS customer_active
                    FROM users u LEFT JOIN customers c ON c.id = u.customer_id WHERE u.email = ?`, email);
  if (!user || !auth.verifyPassword(String(req.body.password || ""), user.password_hash)) {
    const c = f && f.until > now() ? f.count + 1 : 1;
    failures.set(key, { count: c, until: now() + 15 * 60e3 });
    throw new HttpError(401, "Wrong email or password.");
  }
  failures.delete(key);
  if (user.customer_id && !user.customer_active) throw new HttpError(403, "This account is paused. Please contact your provider.");
  res.cookie("sid", auth.createSession(user.id), auth.sessionCookieOptions(req));
  res.json({ user: auth.publicUser(user) });
});

router.post("/auth/logout", (req, res) => {
  auth.destroySession(req.cookies && req.cookies.sid);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

router.use(auth.requireUser);

/**
 * Which customer this request works in (req.cid):
 * - a customer's user: always their own customer;
 * - your staff: the customer picked in the switcher (X-Customer-Id header), or null = all customers.
 */
router.use((req, res, next) => {
  req.isStaff = !req.user.customer_id;
  if (!req.isStaff) req.cid = req.user.customer_id;
  else {
    // Download links can't send headers, so a GET may name the client in the address instead.
    const h = req.get("x-customer-id") || (req.method === "GET" ? req.query.customerId : "");
    req.cid = h ? intId(h) : null;
    if (req.cid && !get("SELECT id FROM customers WHERE id = ?", req.cid)) req.cid = null;
  }
  next();
});

/** SQL filter for the current customer, e.g. scope("s") -> [" AND s.customer_id = ?", [5]] */
const scope = (req, alias) => req.cid ? [` AND ${alias ? alias + "." : ""}customer_id = ?`, [req.cid]] : ["", []];

/** The customer new things are created for. Staff viewing "All customers" pass customerId in the request. */
function targetCustomer(req) {
  if (req.cid) return req.cid;
  const id = req.body.customerId || req.query.customerId;
  if (!id) throw bad("Choose a customer first (switcher at the top of the page).");
  const n = intId(id);
  if (!get("SELECT id FROM customers WHERE id = ?", n)) throw bad("That customer doesn't exist.");
  return n;
}

router.get("/auth/me", (req, res) => res.json({ user: auth.publicUser(req.user) }));

router.post("/auth/password", (req, res) => {
  const row = get("SELECT password_hash FROM users WHERE id = ?", req.user.id);
  if (!auth.verifyPassword(String(req.body.current || ""), row.password_hash)) throw bad("Current password is wrong.");
  const next = String(req.body.next || "");
  if (next.length < 8) throw bad("New password must be at least 8 characters.");
  run("UPDATE users SET password_hash = ? WHERE id = ?", auth.hashPassword(next), req.user.id);
  // Log out other devices.
  run("DELETE FROM sessions WHERE user_id = ? AND id != ?", req.user.id, auth.sha256(req.cookies.sid));
  res.json({ ok: true });
});

// ---------- customers (your staff only) ----------
function customerOut(c) {
  const screens = all("SELECT last_seen FROM screens WHERE customer_id = ? AND paired_at IS NOT NULL", c.id);
  return {
    id: c.id, name: c.name, contactName: c.contact_name, email: c.email, phone: c.phone, notes: c.notes,
    screenLimit: c.screen_limit, active: !!c.active, createdAt: c.created_at, billingClientId: c.billing_client_id || null,
    screens: screens.length, online: screens.filter(isOnline).length,
    users: get("SELECT COUNT(*) n FROM users WHERE customer_id = ?", c.id).n,
    playlists: get("SELECT COUNT(*) n FROM playlists WHERE customer_id = ?", c.id).n,
    mediaBytes: get("SELECT COALESCE(SUM(size),0) n FROM media WHERE customer_id = ?", c.id).n
  };
}
function customerFields(b, old) {
  const f = {
    name: b.name !== undefined ? str(b.name, 120, "Name") : old.name,
    contact_name: b.contactName !== undefined ? str(b.contactName, 120, "Contact") : old.contact_name,
    email: b.email !== undefined ? str(b.email, 200, "Email") : old.email,
    phone: b.phone !== undefined ? str(b.phone, 40, "Phone") : old.phone,
    notes: b.notes !== undefined ? str(b.notes, 2000, "Notes") : old.notes,
    screen_limit: b.screenLimit !== undefined ? (b.screenLimit === "" || b.screenLimit === null ? null : Number(b.screenLimit)) : old.screen_limit,
    active: b.active !== undefined ? (b.active ? 1 : 0) : old.active
  };
  if (!f.name) throw bad("Give the customer a name.");
  if (f.screen_limit !== null && !(Number.isInteger(f.screen_limit) && f.screen_limit >= 0 && f.screen_limit <= 10000)) throw bad("Screen limit must be a whole number (or empty for no limit).");
  return f;
}

router.get("/customers", auth.requireStaff, (req, res) =>
  res.json(all("SELECT * FROM customers ORDER BY name COLLATE NOCASE").map(customerOut)));

router.post("/customers", auth.requireStaff, auth.requireAdmin, (req, res) => {
  const f = customerFields(req.body, { contact_name: "", email: "", phone: "", notes: "", screen_limit: null, active: 1 });
  const r = run("INSERT INTO customers (name, contact_name, email, phone, notes, screen_limit, active, created_at) VALUES (?,?,?,?,?,?,?,?)",
    f.name, f.contact_name, f.email, f.phone, f.notes, f.screen_limit, f.active, now());
  res.status(201).json(customerOut(get("SELECT * FROM customers WHERE id = ?", r.lastInsertRowid)));
});

function loadCustomer(id) {
  const c = get("SELECT * FROM customers WHERE id = ?", id);
  if (!c) throw notFound("Customer");
  return c;
}

router.patch("/customers/:id", auth.requireStaff, auth.requireAdmin, (req, res) => {
  const c = loadCustomer(intId(req.params.id));
  const f = customerFields(req.body, c);
  run("UPDATE customers SET name=?, contact_name=?, email=?, phone=?, notes=?, screen_limit=?, active=? WHERE id=?",
    f.name, f.contact_name, f.email, f.phone, f.notes, f.screen_limit, f.active, c.id);
  if (!f.active) run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE customer_id = ?)", c.id);
  res.json(customerOut(loadCustomer(c.id)));
});

router.delete("/customers/:id", auth.requireStaff, auth.requireAdmin, (req, res) => {
  const c = loadCustomer(intId(req.params.id));
  const n = get("SELECT COUNT(*) n FROM screens WHERE customer_id = ? AND paired_at IS NOT NULL", c.id).n;
  if (n) throw bad(`Remove this customer's ${n} screen(s) first.`);
  const files = all("SELECT file FROM media WHERE customer_id = ? AND file IS NOT NULL", c.id);
  tx(() => {
    // Explicit deletes (not only ON DELETE CASCADE): the customer_id columns were added by ALTER TABLE.
    run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE customer_id = ?)", c.id);
    for (const t of ["users", "playlists", "media", "screens"]) run(`DELETE FROM ${t} WHERE customer_id = ?`, c.id);
    run("DELETE FROM customers WHERE id = ?", c.id);
  });
  for (const f of files) fs.rm(path.join(DATA_DIR, "media", f.file), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------- users ----------
// Staff admins manage staff (switcher on "All customers") or a customer's users (customer picked).
// A customer's admin manages only their own customer's users.
const userCols = "u.id, u.email, u.name, u.role, u.customer_id, u.created_at, c.name AS customer_name";
const userOut = u => ({ ...auth.publicUser(u), createdAt: u.created_at });
const userQuery = `SELECT ${userCols} FROM users u LEFT JOIN customers c ON c.id = u.customer_id`;

function loadManagedUser(req, id) {
  const u = get(userQuery + " WHERE u.id = ?", id);
  if (!u || (u.customer_id || null) !== (req.cid || null)) throw notFound("User");
  return u;
}
const staffAdmins = () => get("SELECT COUNT(*) n FROM users WHERE role = 'admin' AND customer_id IS NULL").n;

router.get("/users", auth.requireAdmin, (req, res) => {
  const rows = req.cid ? all(userQuery + " WHERE u.customer_id = ? ORDER BY u.email", req.cid)
    : all(userQuery + " WHERE u.customer_id IS NULL ORDER BY u.email");
  res.json(rows.map(userOut));
});

router.post("/users", auth.requireAdmin, (req, res) => {
  const email = str(req.body.email, 200, "Email").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Enter a valid email.");
  const password = String(req.body.password || "");
  if (password.length < 8) throw bad("Password must be at least 8 characters.");
  const role = req.body.role === "admin" ? "admin" : "editor";
  if (get("SELECT id FROM users WHERE email = ?", email)) throw bad("A user with that email already exists.");
  const r = run("INSERT INTO users (email, name, password_hash, role, customer_id, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    email, str(req.body.name, 100, "Name"), auth.hashPassword(password), role, req.cid || null, now());
  res.status(201).json(userOut(get(userQuery + " WHERE u.id = ?", r.lastInsertRowid)));
});

router.patch("/users/:id", auth.requireAdmin, (req, res) => {
  const u = loadManagedUser(req, intId(req.params.id));
  tx(() => {
    if (req.body.name !== undefined) run("UPDATE users SET name = ? WHERE id = ?", str(req.body.name, 100, "Name"), u.id);
    if (req.body.role !== undefined) {
      const role = req.body.role === "admin" ? "admin" : "editor";
      if (u.role === "admin" && role !== "admin") {
        if (!u.customer_id && staffAdmins() <= 1) throw bad("There must be at least one admin.");
        if (u.id === req.user.id) throw bad("You can't remove your own admin rights.");
      }
      run("UPDATE users SET role = ? WHERE id = ?", role, u.id);
    }
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw bad("Password must be at least 8 characters.");
      run("UPDATE users SET password_hash = ? WHERE id = ?", auth.hashPassword(String(req.body.password)), u.id);
      run("DELETE FROM sessions WHERE user_id = ?", u.id);
    }
  });
  res.json(userOut(get(userQuery + " WHERE u.id = ?", u.id)));
});

router.delete("/users/:id", auth.requireAdmin, (req, res) => {
  const u = loadManagedUser(req, intId(req.params.id));
  if (u.id === req.user.id) throw bad("You can't delete your own login.");
  run("DELETE FROM users WHERE id = ?", u.id);
  res.json({ ok: true });
});

// ---------- dashboard ----------
function screenSummary(s) {
  let status = {};
  try { status = JSON.parse(s.status_json || "{}"); } catch (_) {}
  return {
    id: s.id, name: s.name, location: s.location, notes: s.notes,
    customerId: s.customer_id, customerName: s.customer_name || null,
    playlistId: s.playlist_id, playlistName: s.playlist_name || null,
    orientation: s.orientation, volume: s.volume,
    model: s.model, appVersion: s.app_version, ip: s.ip,
    online: !s.planned && isOnline(s), lastSeen: s.last_seen, pairedAt: s.planned ? null : s.paired_at, planned: !!s.planned,
    status,
    screenshot: s.screenshot_file ? "/screenshots/" + s.screenshot_file : null, screenshotAt: s.screenshot_at,
    scheduleCount: s.schedule_count || 0,
    lat: s.lat, lng: s.lng, address: s.address || "",
    channelId: s.channel_id || null, channelName: s.channel_name || null
  };
}
const screenQuery = `SELECT s.*, p.name AS playlist_name, cu.name AS customer_name, ch.name AS channel_name,
  (SELECT COUNT(*) FROM schedules sc WHERE sc.screen_id = s.id) AS schedule_count
  FROM screens s LEFT JOIN playlists p ON p.id = s.playlist_id LEFT JOIN customers cu ON cu.id = s.customer_id
  LEFT JOIN channels ch ON ch.id = s.channel_id
  WHERE s.paired_at IS NOT NULL`;

router.get("/dashboard", (req, res) => {
  const [w, p] = scope(req, "s");
  const screens = all(screenQuery + w + " ORDER BY s.name", ...p).map(screenSummary);
  const [mw, mp] = scope(req);
  const m = get("SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM media WHERE 1=1" + mw, ...mp);
  res.json({
    screens: screens.length,
    online: screens.filter(s => s.online).length,
    offline: screens.filter(s => !s.online && !s.planned),
    planned: screens.filter(s => s.planned),
    noContent: screens.filter(s => !s.playlistId && !s.scheduleCount),
    media: m.n, mediaBytes: m.bytes,
    playlists: get("SELECT COUNT(*) n FROM playlists WHERE 1=1" + mw, ...mp).n,
    customers: req.isStaff && !req.cid ? get("SELECT COUNT(*) n FROM customers").n : null
  });
});

// ---------- screens ----------
router.get("/screens", (req, res) => {
  const [w, p] = scope(req, "s");
  res.json(all(screenQuery + w + " ORDER BY cu.name, s.name, s.id", ...p).map(screenSummary));
});

function loadScreen(req, id) {
  const [w, p] = scope(req, "s");
  const s = get(screenQuery + " AND s.id = ?" + w, id, ...p);
  if (!s) throw notFound("Screen");
  return s;
}

router.get("/screens/:id", (req, res) => {
  const s = loadScreen(req, intId(req.params.id));
  const schedules = all(`SELECT sc.*, p.name AS playlist_name FROM schedules sc JOIN playlists p ON p.id = sc.playlist_id
                         WHERE sc.screen_id = ? ORDER BY sc.position, sc.id`, s.id)
    .map(x => ({ id: x.id, playlistId: x.playlist_id, playlistName: x.playlist_name, days: x.days, start: x.start_time, end: x.end_time }));
  const pending = all("SELECT type, created_at FROM commands WHERE screen_id = ? AND delivered_at IS NULL ORDER BY id", s.id);
  res.json({ ...screenSummary(s), schedules, pendingCommands: pending, layers: layersOut(s) });
});

// ---------- channels: one playlist + layers design for many screens ----------
function checkChannel(id, customerId) {
  if (id === null || id === "" || id === undefined) return null;
  const n = intId(id);
  if (!get("SELECT id FROM channels WHERE id = ? AND customer_id = ?", n, customerId)) throw bad("That channel doesn't belong to this client.");
  return n;
}
const channelQuery = `SELECT c.*, p.name AS playlist_name, cu.name AS customer_name FROM channels c
  LEFT JOIN playlists p ON p.id = c.playlist_id LEFT JOIN customers cu ON cu.id = c.customer_id WHERE 1=1`;
function loadChannel(req, id) {
  const [w, p] = scope(req, "c");
  const c = get(channelQuery + " AND c.id = ?" + w, id, ...p);
  if (!c) throw notFound("Channel");
  return c;
}
function channelOut(c, full) {
  const layers = parseLayers(c.layers_json);
  const out = {
    id: c.id, name: c.name, customerId: c.customer_id, customerName: c.customer_name,
    playlistId: c.playlist_id, playlistName: c.playlist_name || null, updatedAt: c.updated_at,
    layersOn: ["video", "specials", "text", "effects"].filter(k => layers[k].enabled),
    screens: all("SELECT id, name, last_seen FROM screens WHERE channel_id = ? AND paired_at IS NOT NULL ORDER BY name", c.id)
      .map(s => ({ id: s.id, name: s.name, online: isOnline(s) }))
  };
  if (full) out.layers = withImages(layers, clientImage(c.customer_id));
  return out;
}

router.get("/channels", (req, res) => {
  const [w, p] = scope(req, "c");
  res.json(all(channelQuery + w + " ORDER BY c.name COLLATE NOCASE", ...p).map(c => channelOut(c)));
});

router.post("/channels", (req, res) => {
  const cid = targetCustomer(req);
  const name = str(req.body.name, 100, "Name");
  if (!name) throw bad("Give the channel a name.");
  const r = run("INSERT INTO channels (customer_id, name, playlist_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    cid, name, checkPlaylist(req.body.playlistId, cid), now(), now());
  res.status(201).json(channelOut(loadChannel({ cid: null }, r.lastInsertRowid), true));
});

router.get("/channels/:id", (req, res) => res.json(channelOut(loadChannel(req, intId(req.params.id)), true)));

router.patch("/channels/:id", (req, res) => {
  const c = loadChannel(req, intId(req.params.id));
  const name = req.body.name !== undefined ? str(req.body.name, 100, "Name") : c.name;
  if (!name) throw bad("Give the channel a name.");
  const pl = req.body.playlistId !== undefined ? checkPlaylist(req.body.playlistId, c.customer_id) : c.playlist_id;
  run("UPDATE channels SET name = ?, playlist_id = ?, updated_at = ? WHERE id = ?", name, pl, now(), c.id);
  res.json(channelOut(loadChannel(req, c.id), true));
});

router.put("/channels/:id/layers", (req, res) => {
  const c = loadChannel(req, intId(req.params.id));
  const img = clientImage(c.customer_id);
  run("UPDATE channels SET layers_json = ?, updated_at = ? WHERE id = ?", JSON.stringify(sanitizeLayers(req.body, id => !!img(id))), now(), c.id);
  res.json(channelOut(loadChannel(req, c.id), true).layers);
});

// The screens on this channel: exactly the ones listed (others are taken off it).
router.put("/channels/:id/screens", (req, res) => {
  const c = loadChannel(req, intId(req.params.id));
  const ids = (Array.isArray(req.body.screenIds) ? req.body.screenIds : []).map(intId);
  for (const id of ids) if (!get("SELECT id FROM screens WHERE id = ? AND customer_id = ? AND paired_at IS NOT NULL", id, c.customer_id)) throw bad("A screen in that list doesn't belong to this client.");
  tx(() => {
    run("UPDATE screens SET channel_id = NULL WHERE channel_id = ?", c.id);
    ids.forEach(id => run("UPDATE screens SET channel_id = ? WHERE id = ?", c.id, id));
  });
  res.json(channelOut(loadChannel(req, c.id)));
});

router.delete("/channels/:id", (req, res) => {
  const c = loadChannel(req, intId(req.params.id));
  tx(() => { run("UPDATE screens SET channel_id = NULL WHERE channel_id = ?", c.id); run("DELETE FROM channels WHERE id = ?", c.id); });
  res.json({ ok: true });
});

// ---------- screen layers (video, specials, text, effects) ----------
const clientImage = customerId => id => get("SELECT id, file, sha256, size, name FROM media WHERE id = ? AND kind = 'image' AND customer_id = ?", id, customerId);
const layersOut = s => withImages(parseLayers(s.layers_json), clientImage(s.customer_id));

router.get("/screens/:id/layers", (req, res) => res.json(layersOut(loadScreen(req, intId(req.params.id)))));

router.put("/screens/:id/layers", (req, res) => {
  const s = loadScreen(req, intId(req.params.id));
  const img = clientImage(s.customer_id);
  const clean = sanitizeLayers(req.body, id => !!img(id));
  run("UPDATE screens SET layers_json = ? WHERE id = ?", JSON.stringify(clean), s.id);
  res.json(layersOut(loadScreen(req, s.id)));
});

/** A playlist id (or empty) that must belong to the given customer. */
function checkPlaylist(id, customerId) {
  if (id === null || id === "" || id === undefined) return null;
  const n = intId(id);
  if (!get("SELECT id FROM playlists WHERE id = ? AND customer_id = ?", n, customerId)) throw bad("That playlist doesn't belong to this customer.");
  return n;
}

function checkScreenLimit(cid) {
  const c = loadCustomer(cid);
  if (c.screen_limit === null) return;
  const used = get("SELECT COUNT(*) n FROM screens WHERE customer_id = ? AND paired_at IS NOT NULL", cid).n;
  if (used >= c.screen_limit) throw bad(`${c.name} already has ${used} of ${c.screen_limit} screens. Raise the limit on the Customers page first.`);
}

/** A screen set up ahead of time: name, playlist and layers, with no TV yet. A TV is connected later with its code. */
router.post("/screens/plan", (req, res) => {
  const cid = targetCustomer(req);
  checkScreenLimit(cid);
  const name = str(req.body.name, 100, "Name");
  if (!name) throw bad("Give the screen a name.");
  // Placeholder device id and a token hash no real token can match (real hashes are 64 hex characters).
  const r = run(`INSERT INTO screens (device_id, token_hash, paired_at, planned, customer_id, name, location, playlist_id, channel_id, created_at)
    VALUES (?, 'planned', ?, 1, ?, ?, ?, ?, ?, ?)`, "planned-" + crypto.randomUUID(), now(), cid, name,
    str(req.body.location, 200, "Location"), checkPlaylist(req.body.playlistId, cid), checkChannel(req.body.channelId, cid), now());
  res.status(201).json(screenSummary(loadScreen({ cid: null }, r.lastInsertRowid)));
});

/**
 * Pair the TV showing this code. With screenId, the TV takes over that screen (a planned one, or an existing
 * screen whose TV is being replaced) and keeps its name, playlist, schedule and layers.
 */
router.post("/screens/pair", (req, res) => {
  const cid = targetCustomer(req);
  const code = String(req.body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) throw bad("Enter the 6-character code shown on the TV.");
  const target = req.body.screenId ? loadScreen(req, intId(req.body.screenId)) : null;
  if (target && target.customer_id !== cid) throw bad("That screen belongs to another client.");
  const s = get("SELECT * FROM screens WHERE pairing_code = ? AND paired_at IS NULL", code);
  if (!s) throw bad("No screen is showing that code. Check the TV and try again.");
  if (target) {
    tx(() => {
      // The waiting TV's row goes; its device id and token move onto the prepared screen.
      run("DELETE FROM screens WHERE id = ?", s.id);
      run(`UPDATE screens SET device_id = ?, token_hash = ?, model = ?, app_version = ?, ip = ?, last_seen = ?, status_json = ?,
        screenshot_file = NULL, screenshot_at = NULL, planned = 0, paired_at = ? WHERE id = ?`,
        s.device_id, s.token_hash, s.model, s.app_version, s.ip, s.last_seen, s.status_json, now(), target.id);
      run("DELETE FROM commands WHERE screen_id = ? AND delivered_at IS NULL", target.id);
    });
    if (target.screenshot_file) fs.rm(path.join(DATA_DIR, "screenshots", target.screenshot_file), { force: true }, () => {});
    return res.status(201).json(screenSummary(loadScreen({ cid: null }, target.id)));
  }
  checkScreenLimit(cid);
  const name = str(req.body.name, 100, "Name") || "Screen " + code;
  run("UPDATE screens SET paired_at = ?, pairing_code = NULL, customer_id = ?, name = ?, location = ?, playlist_id = ? WHERE id = ?",
    now(), cid, name, str(req.body.location, 200, "Location"), checkPlaylist(req.body.playlistId, cid), s.id);
  res.status(201).json(screenSummary(loadScreen({ cid: null }, s.id)));
});

router.patch("/screens/:id", (req, res) => {
  const s = loadScreen(req, intId(req.params.id));
  const b = req.body;
  const f = {
    name: b.name !== undefined ? str(b.name, 100, "Name") || s.name : s.name,
    location: b.location !== undefined ? str(b.location, 200, "Location") : s.location,
    notes: b.notes !== undefined ? str(b.notes, 2000, "Notes") : s.notes,
    playlist_id: b.playlistId !== undefined ? checkPlaylist(b.playlistId, s.customer_id) : s.playlist_id,
    orientation: b.orientation !== undefined ? Number(b.orientation) : s.orientation,
    volume: b.volume !== undefined ? Math.round(Number(b.volume)) : s.volume
  };
  if (![0, 90, 180, 270].includes(f.orientation)) throw bad("Orientation must be 0, 90, 180 or 270.");
  if (!(f.volume >= 0 && f.volume <= 100)) throw bad("Volume must be 0 to 100.");
  // Map position: both numbers, or both empty to remove the pin.
  let lat = s.lat, lng = s.lng, address = s.address || "";
  if (b.lat !== undefined || b.lng !== undefined) {
    if (b.lat === null || b.lat === "") { lat = null; lng = null; }
    else {
      lat = Number(b.lat); lng = Number(b.lng);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180)) throw bad("That map position isn't valid.");
    }
  }
  if (b.address !== undefined) address = str(b.address, 300, "Address");
  const channelId = b.channelId !== undefined ? checkChannel(b.channelId, s.customer_id) : s.channel_id;
  run("UPDATE screens SET name=?, location=?, notes=?, playlist_id=?, orientation=?, volume=?, lat=?, lng=?, address=?, channel_id=? WHERE id=?",
    f.name, f.location, f.notes, f.playlist_id, f.orientation, f.volume, lat, lng, address, channelId, s.id);
  res.json(screenSummary(loadScreen(req, s.id)));
});

router.post("/screens/bulk-assign", (req, res) => {
  const ids = (Array.isArray(req.body.screenIds) ? req.body.screenIds : []).map(intId);
  if (!ids.length) throw bad("Pick at least one screen.");
  const screens = ids.map(id => loadScreen(req, id));
  const owners = new Set(screens.map(s => s.customer_id));
  if (owners.size > 1 && req.body.playlistId) throw bad("Those screens belong to different customers. Pick screens of one customer.");
  const pl = checkPlaylist(req.body.playlistId, screens[0].customer_id);
  tx(() => screens.forEach(s => run("UPDATE screens SET playlist_id = ? WHERE id = ?", pl, s.id)));
  res.json({ ok: true, updated: screens.length });
});

router.delete("/screens/:id", (req, res) => {
  const s = loadScreen(req, intId(req.params.id));
  run("DELETE FROM screens WHERE id = ?", s.id);
  if (s.screenshot_file) fs.rm(path.join(DATA_DIR, "screenshots", s.screenshot_file), { force: true }, () => {});
  res.json({ ok: true });
});

const COMMANDS = ["reload", "restart_app", "screenshot", "clear_cache", "identify"];
router.post("/screens/:id/commands", (req, res) => {
  if (loadScreen(req, intId(req.params.id)).planned) throw bad("No TV is connected to this screen yet.");
  const s = loadScreen(req, intId(req.params.id));
  const type = String(req.body.type || "");
  if (!COMMANDS.includes(type)) throw bad("Unknown command.");
  // One pending command of each type is enough.
  if (!get("SELECT id FROM commands WHERE screen_id = ? AND type = ? AND delivered_at IS NULL", s.id, type))
    run("INSERT INTO commands (screen_id, type, created_at) VALUES (?, ?, ?)", s.id, type, now());
  res.status(202).json({ ok: true, online: isOnline(s) });
});

// The same command for every screen in view (e.g. "take screenshots of all").
router.post("/screens-commands", (req, res) => {
  const type = String(req.body.type || "");
  if (!["screenshot", "reload", "identify"].includes(type)) throw bad("Unknown command.");
  const [w, p] = scope(req, "s");
  const ids = all("SELECT s.id FROM screens s WHERE s.paired_at IS NOT NULL AND s.planned = 0" + w, ...p).map(r => r.id);
  tx(() => ids.forEach(id => {
    if (!get("SELECT id FROM commands WHERE screen_id = ? AND type = ? AND delivered_at IS NULL", id, type))
      run("INSERT INTO commands (screen_id, type, created_at) VALUES (?, ?, ?)", id, type, now());
  }));
  res.status(202).json({ ok: true, screens: ids.length });
});

// ---------- screen monitoring ----------
router.get("/monitoring", (req, res) => {
  const [w, p] = scope(req, "s");
  const screens = all(screenQuery + " AND s.planned = 0" + w + " ORDER BY cu.name, s.name", ...p).map(screenSummary);
  const nowHour = Math.floor(now() / 3600e3);
  const out = screens.map(s => {
    const rows = all("SELECT hour, minutes FROM screen_uptime WHERE screen_id = ? AND hour > ?", s.id, nowHour - 24 * 7);
    const byHour = new Map(rows.map(r => [r.hour, r.minutes]));
    // Only count time since the screen was paired, so a new screen isn't "90% down".
    const since = Math.floor((s.pairedAt || now()) / 3600e3);
    const pct = hours => {
      let have = 0, possible = 0;
      for (let hr = nowHour - hours + 1; hr <= nowHour; hr++) {
        if (hr < since) continue;
        possible += hr === nowHour ? Math.max(1, new Date(now()).getUTCMinutes()) : 60;
        have += byHour.get(hr) || 0;
      }
      return possible ? Math.min(100, Math.round(have / possible * 1000) / 10) : null;
    };
    const last24 = [];
    for (let hr = nowHour - 23; hr <= nowHour; hr++) last24.push(hr < since ? null : (byHour.get(hr) || 0));
    return { ...s, uptime24h: pct(24), uptime7d: pct(24 * 7), last24 };
  });
  res.json(out);
});

// ---------- reports (proof of play) ----------
/** from/to are YYYY-MM-DD in the viewer's time zone; tz = minutes behind UTC (JavaScript getTimezoneOffset). */
function reportRange(req) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  const tz = Math.max(-840, Math.min(840, Math.round(Number(req.query.tz) || 0)));
  const today = new Date(now() - tz * 60e3).toISOString().slice(0, 10);
  const to = day.test(req.query.to || "") ? req.query.to : today;
  const from = day.test(req.query.from || "") ? req.query.from : new Date(Date.parse(to) - 6 * 864e5).toISOString().slice(0, 10);
  if (from > to) throw bad("The start date is after the end date.");
  if (Date.parse(to) - Date.parse(from) > 400 * 864e5) throw bad("Pick a range of at most 13 months.");
  const start = Date.parse(from + "T00:00:00Z") + tz * 60e3, end = Date.parse(to + "T00:00:00Z") + 864e5 + tz * 60e3;
  const where = [" WHERE pl.started_at >= ? AND pl.started_at < ?"], params = [start, end];
  if (req.cid) { where.push("pl.customer_id = ?"); params.push(req.cid); }
  if (req.query.screenId) { where.push("pl.screen_id = ?"); params.push(intId(req.query.screenId)); }
  return { from, to, tz, start, end, where: where.join(" AND "), params };
}

router.get("/reports", (req, res) => {
  const r = reportRange(req);
  const base = `FROM plays pl JOIN screens s ON s.id = pl.screen_id LEFT JOIN customers c ON c.id = pl.customer_id` + r.where;
  const totals = get(`SELECT COUNT(*) plays, COALESCE(SUM(pl.seconds),0) seconds, COUNT(DISTINCT pl.screen_id) screens, COUNT(DISTINCT pl.media_id) items ${base}`, ...r.params);
  const byDay = all(`SELECT date((pl.started_at / 1000) - ? * 60, 'unixepoch') day, COUNT(*) plays, SUM(pl.seconds) seconds ${base} GROUP BY day ORDER BY day`, r.tz, ...r.params);
  const byMedia = all(`SELECT pl.media_id mediaId, MAX(pl.media_name) name, MAX(pl.kind) kind, COUNT(*) plays, SUM(pl.seconds) seconds, COUNT(DISTINCT pl.screen_id) screens,
    MAX(c.name) customerName ${base} GROUP BY pl.media_id ORDER BY plays DESC LIMIT 500`, ...r.params);
  const byScreen = all(`SELECT pl.screen_id screenId, s.name, s.customer_id customerId, c.name customerName, COUNT(*) plays, SUM(pl.seconds) seconds,
    MAX(pl.started_at) lastPlay ${base} GROUP BY pl.screen_id ORDER BY plays DESC`, ...r.params);
  // Fill in days with no plays so the chart has no gaps.
  const days = [];
  for (let t = Date.parse(r.from); t <= Date.parse(r.to); t += 864e5) {
    const d = new Date(t).toISOString().slice(0, 10);
    days.push(byDay.find(x => x.day === d) || { day: d, plays: 0, seconds: 0 });
  }
  res.json({ from: r.from, to: r.to, totals, byDay: days, byMedia, byScreen });
});

const csvCell = v => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? '"' + s.replace(/"/g, '""').replace(/^([=+\-@])/, "'$1") + '"' : s; };
router.get("/reports.csv", (req, res) => {
  const r = reportRange(req);
  const rows = all(`SELECT pl.started_at, pl.seconds, pl.media_name, pl.kind, pl.playlist_name, s.name screen, c.name client
    FROM plays pl JOIN screens s ON s.id = pl.screen_id LEFT JOIN customers c ON c.id = pl.customer_id ${r.where} ORDER BY pl.started_at LIMIT 200000`, ...r.params);
  const local = ms => new Date(ms - r.tz * 60e3).toISOString().replace("T", " ").slice(0, 19);
  const lines = [["Played at (local)", "Seconds", "Content", "Type", "Playlist", "Screen", "Client"].join(",")]
    .concat(rows.map(x => [local(x.started_at), x.seconds, x.media_name, x.kind, x.playlist_name, x.screen, x.client].map(csvCell).join(",")));
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.set("Content-Disposition", `attachment; filename="proof-of-play-${r.from}-to-${r.to}.csv"`);
  res.send("﻿" + lines.join("\r\n"));
});

// ---------- address search for the screen map (OpenStreetMap Nominatim) ----------
// Their rules: identify the app, at most 1 request per second, cache results.
const geoCache = new Map();
let geoLast = 0;
router.get("/geocode", async (req, res) => {
  const q = str(req.query.q, 200, "Address");
  if (q.length < 3) throw bad("Type an address first.");
  if (geoCache.has(q)) return res.json(geoCache.get(q));
  const wait = geoLast + 1100 - Date.now();
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  geoLast = Date.now();
  let list;
  try {
    const r = await fetch("https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=" + encodeURIComponent(q), {
      headers: { "User-Agent": "SignagePortal/1.0 (self-hosted digital signage portal)", "Accept-Language": "en" },
      signal: AbortSignal.timeout(8000)
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    list = (await r.json()).map(x => ({ label: x.display_name, lat: Number(x.lat), lng: Number(x.lon) }));
  } catch (e) {
    throw new HttpError(502, "Address search isn't available right now. You can click the map instead.");
  }
  if (geoCache.size > 500) geoCache.clear();
  geoCache.set(q, list);
  res.json(list);
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
router.put("/screens/:id/schedules", (req, res) => {
  const s = loadScreen(req, intId(req.params.id));
  const list = Array.isArray(req.body) ? req.body : req.body.schedules;
  if (!Array.isArray(list) || list.length > 50) throw bad("Send a list of schedule slots.");
  const rows = list.map((x, i) => {
    const days = Number(x.days);
    if (!Number.isInteger(days) || days < 1 || days > 127) throw bad(`Slot ${i + 1}: pick at least one day.`);
    if (!TIME_RE.test(x.start) || !TIME_RE.test(x.end)) throw bad(`Slot ${i + 1}: times must be HH:MM.`);
    if (x.start === x.end) throw bad(`Slot ${i + 1}: start and end can't be the same.`);
    const pl = checkPlaylist(x.playlistId, s.customer_id);
    if (!pl) throw bad(`Slot ${i + 1}: pick a playlist.`);
    return [s.id, pl, days, x.start, x.end, i];
  });
  tx(() => {
    run("DELETE FROM schedules WHERE screen_id = ?", s.id);
    rows.forEach(r => run("INSERT INTO schedules (screen_id, playlist_id, days, start_time, end_time, position) VALUES (?,?,?,?,?,?)", ...r));
  });
  res.json({ ok: true });
});

// ---------- media ----------
const MEDIA_DIR = path.join(DATA_DIR, "media");
const EXT_OK = /^\.(jpe?g|png|gif|webp|bmp|mp4|m4v|webm|mkv|mov|3gp)$/i;
const upload = multer({
  storage: multer.diskStorage({
    destination: MEDIA_DIR,
    filename: (req, file, cb) => cb(null, crypto.randomBytes(12).toString("hex") + path.extname(file.originalname).toLowerCase())
  }),
  limits: { fileSize: 2 * 1024 ** 3, files: 20 },
  fileFilter: (req, file, cb) => {
    const ok = /^(image|video)\//.test(file.mimetype) && EXT_OK.test(path.extname(file.originalname));
    cb(ok ? null : bad(`"${file.originalname}" isn't a supported image or video.`), ok);
  }
});

function hashFile(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", d => h.update(d)).on("end", () => resolve(h.digest("hex"))).on("error", reject);
  });
}

const mediaQuery = `SELECT m.id, m.name, m.kind, m.file, m.url, m.mime, m.size, m.sha256, m.created_at, m.customer_id, m.widget_json, c.name AS customer_name
  FROM media m LEFT JOIN customers c ON c.id = m.customer_id WHERE 1=1`;
const parseWidget = m => { try { return JSON.parse(m.widget_json || "null"); } catch (_) { return null; } };
const mediaOut = m => ({ ...m, widget_json: undefined, widget: m.kind === "widget" ? parseWidget(m) : undefined,
  customerId: m.customer_id, customerName: m.customer_name, src: m.kind === "web" ? m.url : m.kind === "widget" ? "widget:" + m.id : "/media/" + m.file,
  usedIn: all("SELECT DISTINCT p.id, p.name FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.media_id = ?", m.id) });

function loadMedia(req, id) {
  const [w, p] = scope(req, "m");
  const m = get(mediaQuery + " AND m.id = ?" + w, id, ...p);
  if (!m) throw notFound("Media");
  return m;
}

router.get("/media", (req, res) => {
  const [w, p] = scope(req, "m");
  res.json(all(mediaQuery + w + " ORDER BY m.created_at DESC, m.id DESC", ...p).map(mediaOut));
});

// Check the customer before accepting the upload, so files aren't saved for nothing.
router.post("/media", (req, res, next) => { req.targetCid = targetCustomer(req); next(); }, upload.array("files", 20), async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw bad("Choose at least one file.");
  const out = [];
  for (const f of files) {
    const sum = await hashFile(f.path);
    const kind = f.mimetype.startsWith("video/") ? "video" : "image";
    const name = path.basename(f.originalname, path.extname(f.originalname)).slice(0, 200) || f.filename;
    const r = run("INSERT INTO media (name, kind, file, mime, size, sha256, customer_id, created_at) VALUES (?,?,?,?,?,?,?,?)",
      name, kind, f.filename, f.mimetype, f.size, sum, req.targetCid, now());
    out.push(mediaOut(loadMedia({ cid: null }, r.lastInsertRowid)));
  }
  res.status(201).json(out);
});

function checkUrl(u) {
  let url;
  try { url = new URL(String(u || "").trim()); } catch (_) { throw bad("Enter a full web address starting with https://"); }
  if (!/^https?:$/.test(url.protocol)) throw bad("Only http(s) web pages are supported.");
  return url.toString();
}

router.post("/media/web", (req, res) => {
  const cid = targetCustomer(req);
  const url = checkUrl(req.body.url);
  const name = str(req.body.name, 200, "Name") || new URL(url).hostname;
  const r = run("INSERT INTO media (name, kind, url, customer_id, created_at) VALUES (?, 'web', ?, ?, ?)", name, url, cid, now());
  res.status(201).json(mediaOut(loadMedia({ cid: null }, r.lastInsertRowid)));
});

router.post("/media/widget", async (req, res) => {
  const cid = targetCustomer(req);
  const type = String(req.body.type || "");
  const config = await cleanWidget(type, req.body.config);
  const name = str(req.body.name, 200, "Name") || type[0].toUpperCase() + type.slice(1);
  const r = run("INSERT INTO media (name, kind, widget_json, customer_id, created_at) VALUES (?, 'widget', ?, ?, ?)", name, JSON.stringify({ type, config }), cid, now());
  res.status(201).json(mediaOut(loadMedia({ cid: null }, r.lastInsertRowid)));
});

async function cleanWidget(type, config) {
  try { return await widgets.sanitizeWidget(type, config); }
  catch (e) { if (e instanceof widgets.WidgetError) throw bad(e.message); throw e; }
}
async function liveData(type, config) {
  try { return await widgets.widgetData(type, config); }
  catch (e) { throw new HttpError(502, e instanceof widgets.WidgetError ? e.message : "Couldn't get live data right now. Try again in a minute."); }
}

// Live data for a saved widget (preview in the portal).
router.get("/media/:id/widget-data", async (req, res) => {
  const m = loadMedia(req, intId(req.params.id));
  const w = m.kind === "widget" && parseWidget(m);
  if (!w) throw notFound("Widget");
  res.json({ data: await liveData(w.type, w.config) });
});

// Live data while designing a widget that isn't saved yet.
router.post("/widget-preview", async (req, res) => {
  const type = String(req.body.type || "");
  const config = await cleanWidget(type, req.body.config);
  res.json({ config, data: await liveData(type, config) });
});

router.patch("/media/:id", async (req, res) => {
  const m = loadMedia(req, intId(req.params.id));
  if (req.body.config !== undefined && m.kind === "widget") {
    const w = parseWidget(m);
    run("UPDATE media SET widget_json = ? WHERE id = ?", JSON.stringify({ type: w.type, config: await cleanWidget(w.type, req.body.config) }), m.id);
  }
  if (req.body.name !== undefined) run("UPDATE media SET name = ? WHERE id = ?", str(req.body.name, 200, "Name") || m.name, m.id);
  if (req.body.url !== undefined && m.kind === "web") run("UPDATE media SET url = ? WHERE id = ?", checkUrl(req.body.url), m.id);
  res.json(mediaOut(loadMedia(req, m.id)));
});

router.delete("/media/:id", (req, res) => {
  const m = loadMedia(req, intId(req.params.id));
  run("DELETE FROM media WHERE id = ?", m.id);
  if (m.file) fs.rm(path.join(MEDIA_DIR, m.file), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------- playlists ----------
function playlistOut(p, withItems) {
  const items = all(`SELECT pi.id, pi.media_id, pi.duration, m.name, m.kind, m.file, m.url, m.size, m.widget_json
                     FROM playlist_items pi JOIN media m ON m.id = pi.media_id
                     WHERE pi.playlist_id = ? ORDER BY pi.position, pi.id`, p.id);
  const out = {
    id: p.id, name: p.name, createdAt: p.created_at, updatedAt: p.updated_at,
    customerId: p.customer_id, customerName: p.customer_name || null,
    itemCount: items.length,
    videoCount: items.filter(i => i.kind === "video").length,
    // Videos play their full length, so they're not in this number.
    loopSeconds: items.filter(i => i.kind !== "video").reduce((a, i) => a + i.duration, 0),
    screens: all("SELECT id, name FROM screens WHERE playlist_id = ? AND paired_at IS NOT NULL ORDER BY name", p.id),
    scheduledOn: get("SELECT COUNT(DISTINCT screen_id) n FROM schedules WHERE playlist_id = ?", p.id).n
  };
  if (withItems) out.items = items.map(i => ({ id: i.id, mediaId: i.media_id, duration: i.duration, name: i.name, kind: i.kind,
    src: i.kind === "web" ? i.url : i.kind === "widget" ? "widget:" + i.media_id : "/media/" + i.file, size: i.size,
    widget: i.kind === "widget" ? parseWidget(i) : undefined }));
  return out;
}
const playlistQuery = "SELECT p.*, c.name AS customer_name FROM playlists p LEFT JOIN customers c ON c.id = p.customer_id WHERE 1=1";

router.get("/playlists", (req, res) => {
  const [w, p] = scope(req, "p");
  res.json(all(playlistQuery + w + " ORDER BY c.name COLLATE NOCASE, p.name COLLATE NOCASE", ...p).map(x => playlistOut(x)));
});

router.post("/playlists", (req, res) => {
  const cid = targetCustomer(req);
  const name = str(req.body.name, 100, "Name");
  if (!name) throw bad("Give the playlist a name.");
  const r = run("INSERT INTO playlists (name, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)", name, cid, now(), now());
  res.status(201).json(playlistOut(loadPlaylist({ cid: null }, r.lastInsertRowid), true));
});

function loadPlaylist(req, id) {
  const [w, p] = scope(req, "p");
  const pl = get(playlistQuery + " AND p.id = ?" + w, id, ...p);
  if (!pl) throw notFound("Playlist");
  return pl;
}

router.get("/playlists/:id", (req, res) => res.json(playlistOut(loadPlaylist(req, intId(req.params.id)), true)));

router.put("/playlists/:id", (req, res) => {
  const p = loadPlaylist(req, intId(req.params.id));
  const name = req.body.name !== undefined ? str(req.body.name, 100, "Name") : p.name;
  if (!name) throw bad("Give the playlist a name.");
  const items = req.body.items;
  if (items !== undefined && (!Array.isArray(items) || items.length > 500)) throw bad("Items must be a list.");
  tx(() => {
    run("UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?", name, now(), p.id);
    if (items) {
      run("DELETE FROM playlist_items WHERE playlist_id = ?", p.id);
      items.forEach((it, i) => {
        const mid = intId(it.mediaId);
        if (!get("SELECT id FROM media WHERE id = ? AND customer_id = ?", mid, p.customer_id))
          throw bad("A media item in this playlist was deleted or belongs to another customer. Reload and try again.");
        const d = Math.round(Number(it.duration) || 10);
        if (d < 1 || d > 86400) throw bad("Durations must be 1 second to 24 hours.");
        run("INSERT INTO playlist_items (playlist_id, media_id, position, duration) VALUES (?,?,?,?)", p.id, mid, i, d);
      });
    }
  });
  res.json(playlistOut(loadPlaylist(req, p.id), true));
});

router.post("/playlists/:id/duplicate", (req, res) => {
  const p = loadPlaylist(req, intId(req.params.id));
  const id = tx(() => {
    const r = run("INSERT INTO playlists (name, customer_id, created_at, updated_at) VALUES (?, ?, ?, ?)", (p.name + " (copy)").slice(0, 100), p.customer_id, now(), now());
    run(`INSERT INTO playlist_items (playlist_id, media_id, position, duration)
         SELECT ?, media_id, position, duration FROM playlist_items WHERE playlist_id = ?`, r.lastInsertRowid, p.id);
    return r.lastInsertRowid;
  });
  res.status(201).json(playlistOut(loadPlaylist(req, id), true));
});

router.delete("/playlists/:id", (req, res) => {
  const p = loadPlaylist(req, intId(req.params.id));
  run("DELETE FROM playlists WHERE id = ?", p.id);
  res.json({ ok: true });
});

// ---------- billing (read from the Premier Signage Billing app) ----------
const billing = require("./billingLink");
/** What a client's own login may see about their billing. */
const clientView = b => b && ({ plan: b.plan, screens: b.screens, monthly: b.monthly, billingDay: b.billingDay, payMethod: b.payMethod, autopay: b.autopay,
  thisMonth: b.thisMonth, overdue: b.overdue, lastPayment: b.lastPayment, status: b.status });

router.get("/billing", async (req, res) => {
  const st = await billing.billingStatus();
  const byId = new Map(st.clients.map(b => [b.id, b]));
  const customers = req.cid ? [get("SELECT * FROM customers WHERE id = ?", req.cid)] : all("SELECT * FROM customers ORDER BY name COLLATE NOCASE");
  const rows = customers.map(c => {
    const b = c.billing_client_id ? byId.get(c.billing_client_id) || null : null;
    // Suggest a billing client with the same name when not linked yet.
    const suggest = !c.billing_client_id && req.isStaff ? st.clients.find(x => x.name.trim().toLowerCase() === c.name.trim().toLowerCase()) : null;
    return { customerId: c.id, name: c.name, linked: !!c.billing_client_id, missing: !!c.billing_client_id && !b && st.ok,
      billing: req.isStaff ? b : clientView(b), suggest: suggest ? { id: suggest.id, name: suggest.name } : null };
  });
  const linkedIds = new Set(all("SELECT billing_client_id id FROM customers WHERE billing_client_id IS NOT NULL").map(r => r.id));
  res.json({
    configured: st.configured, ok: st.ok, error: req.isStaff ? st.error || null : (st.ok ? null : "Billing details aren't available right now."),
    stale: !!st.stale, at: st.at || null,
    billingUrl: req.isStaff ? billing.billingUrl() || null : null,
    rows,
    unlinked: req.isStaff && !req.cid ? st.clients.filter(b => !linkedIds.has(b.id)).map(b => ({ id: b.id, name: b.name, status: b.status })) : undefined,
    choices: req.isStaff ? st.clients.map(b => ({ id: b.id, name: b.name })) : undefined
  });
});

router.put("/customers/:id/billing-link", auth.requireStaff, auth.requireAdmin, (req, res) => {
  const c = loadCustomer(intId(req.params.id));
  const id = req.body.billingClientId ? String(req.body.billingClientId).replace(/[^\w-]/g, "").slice(0, 60) : null;
  run("UPDATE customers SET billing_client_id = ? WHERE id = ?", id || null, c.id);
  res.json(customerOut(loadCustomer(c.id)));
});

// ---------- white label (your team's admins) ----------
const brand = require("./branding");
router.put("/branding", auth.requireStaff, auth.requireAdmin, (req, res) => {
  const name = str(req.body.name, 40, "Portal name");
  if (!name) throw bad("Give the portal a name.");
  const color = String(req.body.color || "");
  if (!/^#[0-9a-fA-F]{6}$/.test(color)) throw bad("Pick a main color.");
  brand.setSetting("brand_name", name);
  brand.setSetting("brand_color", color.toLowerCase());
  res.json(brand.branding());
});
router.post("/branding/logo", auth.requireStaff, auth.requireAdmin,
  express.raw({ type: Object.keys(brand.LOGO_TYPES), limit: "2mb" }), (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw bad("Use a PNG, JPG or WebP image (up to 2 MB).");
    try { brand.saveLogo(req.body, req.get("content-type").split(";")[0]); } catch (e) { throw bad(e.message); }
    res.status(201).json(brand.branding());
  });
router.delete("/branding/logo", auth.requireStaff, auth.requireAdmin, (req, res) => { brand.removeLogo(); res.json(brand.branding()); });

// ---------- player app download info ----------
function latestApk() {
  const dir = path.join(DATA_DIR, "apk");
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith(".apk"))
    .map(f => ({ f, st: fs.statSync(path.join(dir, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  return files[0] ? { file: files[0].f, path: path.join(dir, files[0].f), size: files[0].st.size, updatedAt: files[0].st.mtimeMs } : null;
}
router.get("/apk", (req, res) => {
  const a = latestApk();
  res.json(a ? { available: true, file: a.file, size: a.size, updatedAt: a.updatedAt, url: "/download/player.apk" } : { available: false });
});

// Your staff admins upload a new player build; older ones are removed so only the latest is offered.
const apkUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, "apk"),
    filename: (req, file, cb) => cb(null, "upload-" + Date.now() + ".apk.part")
  }),
  limits: { fileSize: 200 * 1024 ** 2, files: 1 },
  fileFilter: (req, file, cb) => {
    const ok = /\.apk$/i.test(file.originalname);
    cb(ok ? null : bad("Choose an .apk file."), ok);
  }
});
router.post("/apk", auth.requireStaff, auth.requireAdmin, apkUpload.single("file"), (req, res) => {
  const f = req.file;
  if (!f) throw bad("Choose an .apk file.");
  const head = Buffer.alloc(4);
  const fd = fs.openSync(f.path, "r"); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
  if (head.toString("latin1") !== "PK\x03\x04") { fs.rmSync(f.path, { force: true }); throw bad("That file isn't a valid Android app."); }
  const dir = path.join(DATA_DIR, "apk");
  const name = path.basename(f.originalname).replace(/[^\w.-]/g, "_");
  for (const old of fs.readdirSync(dir)) if (old.toLowerCase().endsWith(".apk")) fs.rmSync(path.join(dir, old), { force: true });
  fs.renameSync(f.path, path.join(dir, name));
  const a = latestApk();
  res.status(201).json({ available: true, file: a.file, size: a.size, updatedAt: a.updatedAt, url: "/download/player.apk" });
});

// ---------- layout templates and the AI designer ----------
const ai = require("./ai");
const { TEMPLATES } = require("./templates");
router.get("/layer-templates", (req, res) => res.json(TEMPLATES));

const today = () => new Date().toISOString().slice(0, 10);
const aiUsed = cid => (get("SELECT count FROM ai_usage WHERE customer_id = ? AND day = ?", cid, today()) || { count: 0 }).count;
router.get("/ai/status", (req, res) => {
  const limit = ai.dailyLimit();
  res.json({ enabled: ai.enabled(), limit, left: req.cid ? Math.max(0, limit - aiUsed(req.cid)) : null });
});

/** Claude designs the screen (mode "design") or rewrites the words of the current design (mode "content"). Nothing is saved. */
router.post("/ai/design", async (req, res) => {
  const cid = targetCustomer(req);
  const prompt = str(req.body.prompt, 2000, "Request").trim();
  if (!prompt) throw bad("Describe what the screen should show.");
  const mode = req.body.mode === "content" ? "content" : "design";
  if (!ai.enabled()) throw new ai.AiError(503, "The AI designer isn't set up yet. Add ANTHROPIC_API_KEY on the server.");
  if (aiUsed(cid) >= ai.dailyLimit()) throw new HttpError(429, `This client has used all ${ai.dailyLimit()} AI requests for today. Try again tomorrow.`);
  // Counted before the call: a request costs money even when its answer isn't used.
  run(`INSERT INTO ai_usage (customer_id, day, count) VALUES (?, ?, 1)
    ON CONFLICT (customer_id, day) DO UPDATE SET count = count + 1`, cid, today());
  const img = clientImage(cid);
  const check = id => !!img(id);
  const current = sanitizeLayers(req.body.current, check);
  const images = all("SELECT id, name FROM media WHERE customer_id = ? AND kind = 'image' ORDER BY id DESC LIMIT 60", cid);
  const out = await ai.design({ prompt, mode, current, businessName: loadCustomer(cid).name, images });
  const clean = sanitizeLayers(mode === "content" ? ai.mergeWords(current, out.layers) : out.layers, check);
  res.json({ layers: withImages(clean, img), summary: String(out.summary || "").slice(0, 500), left: Math.max(0, ai.dailyLimit() - aiUsed(cid)) });
});

// ---------- errors ----------
router.use((req, res) => res.status(404).json({ error: "Not found." }));
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "That file is too big." : "Upload failed: " + err.message;
    return res.status(400).json({ error: msg });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  const status = err.status || 500;
  if (status >= 500 && !(err instanceof ai.AiError)) console.error(err);
  // Clean up half-finished uploads.
  for (const f of [].concat(req.files || [], req.file || [])) fs.rm(f.path, { force: true }, () => {});
  res.status(status).json({ error: status >= 500 && !(err instanceof HttpError) && !(err instanceof ai.AiError) ? "Something went wrong on the server." : err.message });
});

module.exports = { router, latestApk };
