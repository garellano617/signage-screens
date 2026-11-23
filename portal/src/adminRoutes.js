"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const multer = require("multer");
const { all, get, run, tx, now, DATA_DIR } = require("./db");
const auth = require("./auth");
const { isOnline } = require("./playerConfig");

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
  const user = get("SELECT * FROM users WHERE email = ?", email);
  if (!user || !auth.verifyPassword(String(req.body.password || ""), user.password_hash)) {
    const c = f && f.until > now() ? f.count + 1 : 1;
    failures.set(key, { count: c, until: now() + 15 * 60e3 });
    throw new HttpError(401, "Wrong email or password.");
  }
  failures.delete(key);
  res.cookie("sid", auth.createSession(user.id), auth.sessionCookieOptions(req));
  res.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role } });
});

router.post("/auth/logout", (req, res) => {
  auth.destroySession(req.cookies && req.cookies.sid);
  res.clearCookie("sid", { path: "/" });
  res.json({ ok: true });
});

router.use(auth.requireUser);

router.get("/auth/me", (req, res) => res.json({ user: req.user }));

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

// ---------- users (admins) ----------
const userCols = "id, email, name, role, created_at";
router.get("/users", auth.requireAdmin, (req, res) => res.json(all(`SELECT ${userCols} FROM users ORDER BY email`)));

router.post("/users", auth.requireAdmin, (req, res) => {
  const email = str(req.body.email, 200, "Email").toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw bad("Enter a valid email.");
  const password = String(req.body.password || "");
  if (password.length < 8) throw bad("Password must be at least 8 characters.");
  const role = req.body.role === "admin" ? "admin" : "editor";
  if (get("SELECT id FROM users WHERE email = ?", email)) throw bad("A user with that email already exists.");
  const r = run("INSERT INTO users (email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
    email, str(req.body.name, 100, "Name"), auth.hashPassword(password), role, now());
  res.status(201).json(get(`SELECT ${userCols} FROM users WHERE id = ?`, r.lastInsertRowid));
});

router.patch("/users/:id", auth.requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  const u = get("SELECT * FROM users WHERE id = ?", id);
  if (!u) throw notFound("User");
  tx(() => {
    if (req.body.name !== undefined) run("UPDATE users SET name = ? WHERE id = ?", str(req.body.name, 100, "Name"), id);
    if (req.body.role !== undefined) {
      const role = req.body.role === "admin" ? "admin" : "editor";
      if (u.role === "admin" && role !== "admin" && get("SELECT COUNT(*) n FROM users WHERE role = 'admin'").n <= 1)
        throw bad("There must be at least one admin.");
      run("UPDATE users SET role = ? WHERE id = ?", role, id);
    }
    if (req.body.password) {
      if (String(req.body.password).length < 8) throw bad("Password must be at least 8 characters.");
      run("UPDATE users SET password_hash = ? WHERE id = ?", auth.hashPassword(String(req.body.password)), id);
      run("DELETE FROM sessions WHERE user_id = ?", id);
    }
  });
  res.json(get(`SELECT ${userCols} FROM users WHERE id = ?`, id));
});

router.delete("/users/:id", auth.requireAdmin, (req, res) => {
  const id = intId(req.params.id);
  if (id === req.user.id) throw bad("You can't delete your own login.");
  run("DELETE FROM users WHERE id = ?", id);
  res.json({ ok: true });
});

// ---------- dashboard ----------
function screenSummary(s) {
  let status = {};
  try { status = JSON.parse(s.status_json || "{}"); } catch (_) {}
  return {
    id: s.id, name: s.name, location: s.location, notes: s.notes,
    playlistId: s.playlist_id, playlistName: s.playlist_name || null,
    orientation: s.orientation, volume: s.volume,
    model: s.model, appVersion: s.app_version, ip: s.ip,
    online: isOnline(s), lastSeen: s.last_seen, pairedAt: s.paired_at,
    status,
    screenshot: s.screenshot_file ? "/screenshots/" + s.screenshot_file : null, screenshotAt: s.screenshot_at,
    scheduleCount: s.schedule_count || 0
  };
}
const screenQuery = `SELECT s.*, p.name AS playlist_name,
  (SELECT COUNT(*) FROM schedules sc WHERE sc.screen_id = s.id) AS schedule_count
  FROM screens s LEFT JOIN playlists p ON p.id = s.playlist_id WHERE s.paired_at IS NOT NULL`;

router.get("/dashboard", (req, res) => {
  const screens = all(screenQuery + " ORDER BY s.name").map(screenSummary);
  const m = get("SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes FROM media");
  res.json({
    screens: screens.length,
    online: screens.filter(s => s.online).length,
    offline: screens.filter(s => !s.online),
    noContent: screens.filter(s => !s.playlistId && !s.scheduleCount),
    media: m.n, mediaBytes: m.bytes,
    playlists: get("SELECT COUNT(*) n FROM playlists").n
  });
});

// ---------- screens ----------
router.get("/screens", (req, res) => res.json(all(screenQuery + " ORDER BY s.name, s.id").map(screenSummary)));

function loadScreen(id) {
  const s = get(screenQuery + " AND s.id = ?", id);
  if (!s) throw notFound("Screen");
  return s;
}

router.get("/screens/:id", (req, res) => {
  const s = loadScreen(intId(req.params.id));
  const schedules = all(`SELECT sc.*, p.name AS playlist_name FROM schedules sc JOIN playlists p ON p.id = sc.playlist_id
                         WHERE sc.screen_id = ? ORDER BY sc.position, sc.id`, s.id)
    .map(x => ({ id: x.id, playlistId: x.playlist_id, playlistName: x.playlist_name, days: x.days, start: x.start_time, end: x.end_time }));
  const pending = all("SELECT type, created_at FROM commands WHERE screen_id = ? AND delivered_at IS NULL ORDER BY id", s.id);
  res.json({ ...screenSummary(s), schedules, pendingCommands: pending });
});

function checkPlaylist(id) {
  if (id === null || id === "" || id === undefined) return null;
  const n = intId(id);
  if (!get("SELECT id FROM playlists WHERE id = ?", n)) throw bad("That playlist doesn't exist.");
  return n;
}

router.post("/screens/pair", (req, res) => {
  const code = String(req.body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (code.length !== 6) throw bad("Enter the 6-character code shown on the TV.");
  const s = get("SELECT * FROM screens WHERE pairing_code = ? AND paired_at IS NULL", code);
  if (!s) throw bad("No screen is showing that code. Check the TV and try again.");
  const name = str(req.body.name, 100, "Name") || "Screen " + code;
  run("UPDATE screens SET paired_at = ?, pairing_code = NULL, name = ?, location = ?, playlist_id = ? WHERE id = ?",
    now(), name, str(req.body.location, 200, "Location"), checkPlaylist(req.body.playlistId), s.id);
  res.status(201).json(screenSummary(loadScreen(s.id)));
});

router.patch("/screens/:id", (req, res) => {
  const s = loadScreen(intId(req.params.id));
  const b = req.body;
  const f = {
    name: b.name !== undefined ? str(b.name, 100, "Name") || s.name : s.name,
    location: b.location !== undefined ? str(b.location, 200, "Location") : s.location,
    notes: b.notes !== undefined ? str(b.notes, 2000, "Notes") : s.notes,
    playlist_id: b.playlistId !== undefined ? checkPlaylist(b.playlistId) : s.playlist_id,
    orientation: b.orientation !== undefined ? Number(b.orientation) : s.orientation,
    volume: b.volume !== undefined ? Math.round(Number(b.volume)) : s.volume
  };
  if (![0, 90, 180, 270].includes(f.orientation)) throw bad("Orientation must be 0, 90, 180 or 270.");
  if (!(f.volume >= 0 && f.volume <= 100)) throw bad("Volume must be 0 to 100.");
  run("UPDATE screens SET name=?, location=?, notes=?, playlist_id=?, orientation=?, volume=? WHERE id=?",
    f.name, f.location, f.notes, f.playlist_id, f.orientation, f.volume, s.id);
  res.json(screenSummary(loadScreen(s.id)));
});

router.post("/screens/bulk-assign", (req, res) => {
  const ids = (Array.isArray(req.body.screenIds) ? req.body.screenIds : []).map(intId);
  if (!ids.length) throw bad("Pick at least one screen.");
  const pl = checkPlaylist(req.body.playlistId);
  tx(() => ids.forEach(id => run("UPDATE screens SET playlist_id = ? WHERE id = ? AND paired_at IS NOT NULL", pl, id)));
  res.json({ ok: true, updated: ids.length });
});

router.delete("/screens/:id", (req, res) => {
  const s = loadScreen(intId(req.params.id));
  run("DELETE FROM screens WHERE id = ?", s.id);
  if (s.screenshot_file) fs.rm(path.join(DATA_DIR, "screenshots", s.screenshot_file), { force: true }, () => {});
  res.json({ ok: true });
});

const COMMANDS = ["reload", "restart_app", "screenshot", "clear_cache", "identify"];
router.post("/screens/:id/commands", (req, res) => {
  const s = loadScreen(intId(req.params.id));
  const type = String(req.body.type || "");
  if (!COMMANDS.includes(type)) throw bad("Unknown command.");
  // One pending command of each type is enough.
  if (!get("SELECT id FROM commands WHERE screen_id = ? AND type = ? AND delivered_at IS NULL", s.id, type))
    run("INSERT INTO commands (screen_id, type, created_at) VALUES (?, ?, ?)", s.id, type, now());
  res.status(202).json({ ok: true, online: isOnline(s) });
});

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
router.put("/screens/:id/schedules", (req, res) => {
  const s = loadScreen(intId(req.params.id));
  const list = Array.isArray(req.body) ? req.body : req.body.schedules;
  if (!Array.isArray(list) || list.length > 50) throw bad("Send a list of schedule slots.");
  const rows = list.map((x, i) => {
    const days = Number(x.days);
    if (!Number.isInteger(days) || days < 1 || days > 127) throw bad(`Slot ${i + 1}: pick at least one day.`);
    if (!TIME_RE.test(x.start) || !TIME_RE.test(x.end)) throw bad(`Slot ${i + 1}: times must be HH:MM.`);
    if (x.start === x.end) throw bad(`Slot ${i + 1}: start and end can't be the same.`);
    const pl = checkPlaylist(x.playlistId);
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

const mediaCols = "id, name, kind, file, url, mime, size, sha256, created_at";
const mediaOut = m => ({ ...m, src: m.kind === "web" ? m.url : "/media/" + m.file,
  usedIn: all("SELECT DISTINCT p.id, p.name FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.media_id = ?", m.id) });

router.get("/media", (req, res) => res.json(all(`SELECT ${mediaCols} FROM media ORDER BY created_at DESC, id DESC`).map(mediaOut)));

router.post("/media", upload.array("files", 20), async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw bad("Choose at least one file.");
  const out = [];
  for (const f of files) {
    const sum = await hashFile(f.path);
    const kind = f.mimetype.startsWith("video/") ? "video" : "image";
    const name = path.basename(f.originalname, path.extname(f.originalname)).slice(0, 200) || f.filename;
    const r = run("INSERT INTO media (name, kind, file, mime, size, sha256, created_at) VALUES (?,?,?,?,?,?,?)",
      name, kind, f.filename, f.mimetype, f.size, sum, now());
    out.push(mediaOut(get(`SELECT ${mediaCols} FROM media WHERE id = ?`, r.lastInsertRowid)));
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
  const url = checkUrl(req.body.url);
  const name = str(req.body.name, 200, "Name") || new URL(url).hostname;
  const r = run("INSERT INTO media (name, kind, url, created_at) VALUES (?, 'web', ?, ?)", name, url, now());
  res.status(201).json(mediaOut(get(`SELECT ${mediaCols} FROM media WHERE id = ?`, r.lastInsertRowid)));
});

router.patch("/media/:id", (req, res) => {
  const id = intId(req.params.id);
  const m = get("SELECT * FROM media WHERE id = ?", id);
  if (!m) throw notFound("Media");
  if (req.body.name !== undefined) run("UPDATE media SET name = ? WHERE id = ?", str(req.body.name, 200, "Name") || m.name, id);
  if (req.body.url !== undefined && m.kind === "web") run("UPDATE media SET url = ? WHERE id = ?", checkUrl(req.body.url), id);
  res.json(mediaOut(get(`SELECT ${mediaCols} FROM media WHERE id = ?`, id)));
});

router.delete("/media/:id", (req, res) => {
  const id = intId(req.params.id);
  const m = get("SELECT * FROM media WHERE id = ?", id);
  if (!m) throw notFound("Media");
  run("DELETE FROM media WHERE id = ?", id);
  if (m.file) fs.rm(path.join(MEDIA_DIR, m.file), { force: true }, () => {});
  res.json({ ok: true });
});

// ---------- playlists ----------
function playlistOut(p, withItems) {
  const items = all(`SELECT pi.id, pi.media_id, pi.duration, m.name, m.kind, m.file, m.url, m.size
                     FROM playlist_items pi JOIN media m ON m.id = pi.media_id
                     WHERE pi.playlist_id = ? ORDER BY pi.position, pi.id`, p.id);
  const out = {
    id: p.id, name: p.name, createdAt: p.created_at, updatedAt: p.updated_at,
    itemCount: items.length,
    videoCount: items.filter(i => i.kind === "video").length,
    // Videos play their full length, so they're not in this number.
    loopSeconds: items.filter(i => i.kind !== "video").reduce((a, i) => a + i.duration, 0),
    screens: all("SELECT id, name FROM screens WHERE playlist_id = ? AND paired_at IS NOT NULL ORDER BY name", p.id),
    scheduledOn: get("SELECT COUNT(DISTINCT screen_id) n FROM schedules WHERE playlist_id = ?", p.id).n
  };
  if (withItems) out.items = items.map(i => ({ id: i.id, mediaId: i.media_id, duration: i.duration, name: i.name, kind: i.kind,
    src: i.kind === "web" ? i.url : "/media/" + i.file, size: i.size }));
  return out;
}

router.get("/playlists", (req, res) => res.json(all("SELECT * FROM playlists ORDER BY name").map(p => playlistOut(p))));

router.post("/playlists", (req, res) => {
  const name = str(req.body.name, 100, "Name");
  if (!name) throw bad("Give the playlist a name.");
  const r = run("INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)", name, now(), now());
  res.status(201).json(playlistOut(get("SELECT * FROM playlists WHERE id = ?", r.lastInsertRowid), true));
});

function loadPlaylist(id) {
  const p = get("SELECT * FROM playlists WHERE id = ?", id);
  if (!p) throw notFound("Playlist");
  return p;
}

router.get("/playlists/:id", (req, res) => res.json(playlistOut(loadPlaylist(intId(req.params.id)), true)));

router.put("/playlists/:id", (req, res) => {
  const p = loadPlaylist(intId(req.params.id));
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
        if (!get("SELECT id FROM media WHERE id = ?", mid)) throw bad("A media item in this playlist was deleted. Reload and try again.");
        const d = Math.round(Number(it.duration) || 10);
        if (d < 1 || d > 86400) throw bad("Durations must be 1 second to 24 hours.");
        run("INSERT INTO playlist_items (playlist_id, media_id, position, duration) VALUES (?,?,?,?)", p.id, mid, i, d);
      });
    }
  });
  res.json(playlistOut(loadPlaylist(p.id), true));
});

router.post("/playlists/:id/duplicate", (req, res) => {
  const p = loadPlaylist(intId(req.params.id));
  const id = tx(() => {
    const r = run("INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)", (p.name + " (copy)").slice(0, 100), now(), now());
    run(`INSERT INTO playlist_items (playlist_id, media_id, position, duration)
         SELECT ?, media_id, position, duration FROM playlist_items WHERE playlist_id = ?`, r.lastInsertRowid, p.id);
    return r.lastInsertRowid;
  });
  res.status(201).json(playlistOut(loadPlaylist(id), true));
});

router.delete("/playlists/:id", (req, res) => {
  const p = loadPlaylist(intId(req.params.id));
  run("DELETE FROM playlists WHERE id = ?", p.id);
  res.json({ ok: true });
});

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

// Admins upload a new player build; older ones are removed so only the latest is offered.
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
router.post("/apk", auth.requireAdmin, apkUpload.single("file"), (req, res) => {
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

// ---------- errors ----------
router.use((req, res) => res.status(404).json({ error: "Not found." }));
// eslint-disable-next-line no-unused-vars
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    const msg = err.code === "LIMIT_FILE_SIZE" ? "That file is too big (max 2 GB)." : "Upload failed: " + err.message;
    return res.status(400).json({ error: msg });
  }
  if (err.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  // Clean up half-finished uploads.
  for (const f of req.files || []) fs.rm(f.path, { force: true }, () => {});
  res.status(status).json({ error: status >= 500 ? "Something went wrong on the server." : err.message });
});

module.exports = { router, latestApk };
