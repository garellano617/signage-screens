"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { get, run, all, tx, now, DATA_DIR } = require("./db");
const { requirePlayer, sha256 } = require("./auth");
const { buildConfig } = require("./playerConfig");
const widgets = require("./widgets");
const { latestApk } = require("./apk");

const router = express.Router();
router.use(express.json({ limit: "64kb" }));

// No 0/O/1/I so codes are easy to read off a TV.
const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newPairingCode() {
  for (;;) {
    let code = "";
    for (let i = 0; i < 6; i++) code += CODE_CHARS[crypto.randomInt(CODE_CHARS.length)];
    if (!get("SELECT id FROM screens WHERE pairing_code = ?", code)) return code;
  }
}

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);

/**
 * A player calls this on first start (and whenever its token is rejected).
 * It returns a fresh token. An already-paired device stays paired.
 */
router.post("/register", (req, res) => {
  const deviceId = clip(req.body && req.body.deviceId, 128).trim();
  if (!/^[\w.:-]{8,128}$/.test(deviceId)) return res.status(400).json({ error: "deviceId required" });
  const token = crypto.randomBytes(32).toString("base64url");
  const model = clip(req.body.model, 120), appVersion = clip(req.body.appVersion, 40);
  let screen = get("SELECT * FROM screens WHERE device_id = ?", deviceId);
  if (screen) {
    run("UPDATE screens SET token_hash = ?, model = ?, app_version = ?, ip = ?, last_seen = ? WHERE id = ?",
      sha256(token), model, appVersion, req.ip || "", now(), screen.id);
  } else {
    run(`INSERT INTO screens (device_id, token_hash, pairing_code, model, app_version, ip, last_seen, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, deviceId, sha256(token), newPairingCode(), model, appVersion, req.ip || "", now(), now());
  }
  screen = get("SELECT * FROM screens WHERE device_id = ?", deviceId);
  res.json({ token, paired: !!screen.paired_at, pairingCode: screen.paired_at ? null : screen.pairing_code });
});

/** The app crashed: it sends what went wrong (no login, it may not be paired yet). A few per device per hour. */
const crashHits = new Map();
router.post("/crash", (req, res) => {
  const b = req.body || {};
  const deviceId = clip(b.deviceId, 128).trim();
  if (!/^[\w.:-]{8,128}$/.test(deviceId)) return res.status(400).json({ error: "deviceId required" });
  const key = (req.ip || "") + "|" + deviceId, t = now();
  const hits = (crashHits.get(key) || []).filter(x => t - x < 3600_000);
  if (hits.length >= 10) return res.status(429).json({ error: "Too many reports" });
  hits.push(t); crashHits.set(key, hits);
  if (crashHits.size > 5000) crashHits.clear();
  run("INSERT INTO app_crashes (device_id, app_version, android, model, error, trace, stopped, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    deviceId, clip(b.appVersion, 40), clip(b.android, 60), clip(b.model, 120), clip(b.error, 600), clip(b.trace, 4000), b.stopped ? 1 : 0, req.ip || "", t);
  run("DELETE FROM app_crashes WHERE id NOT IN (SELECT id FROM app_crashes ORDER BY id DESC LIMIT 300)");
  console.warn("Player app crash:", deviceId, clip(b.model, 120), clip(b.android, 60), clip(b.error, 300));
  res.json({ ok: true });
});

router.get("/config", requirePlayer, (req, res) => {
  res.json(buildConfig(req.screen));
});

/** Every 30 s (5 s while unpaired). Stores status and hands over pending commands. */
router.post("/heartbeat", requirePlayer, (req, res) => {
  const s = req.screen;
  const b = req.body || {};
  const status = {
    playing: clip(b.playing, 200),
    playlist: clip(b.playlist, 200),
    cacheBytes: Number(b.cacheBytes) || 0,
    freeBytes: Number(b.freeBytes) || 0,
    uptimeSec: Number(b.uptimeSec) || 0,
    resolution: clip(b.resolution, 40),
    androidVersion: clip(b.androidVersion, 40),
    configVersion: clip(b.configVersion, 64),
    error: clip(b.error, 500),
    update: clip(b.update, 300)
  };
  run("UPDATE screens SET last_seen = ?, ip = ?, status_json = ?, app_version = COALESCE(NULLIF(?, ''), app_version) WHERE id = ?",
    now(), req.ip || "", JSON.stringify(status), clip(b.appVersion, 40), s.id);
  let commands = [];
  if (s.paired_at) {
    // Proof of play: items the player finished since its last check-in. A retry can't count twice.
    if (Array.isArray(b.plays) && b.plays.length) {
      const oldest = now() - 31 * 864e5, newest = now() + 5 * 60e3;
      tx(() => {
        for (const p of b.plays.slice(0, 500)) {
          const at = Number(p && p.at), sec = Math.round(Number(p && p.sec));
          if (!(at > oldest && at < newest) || !(sec >= 0 && sec < 86400)) continue;
          const mediaId = Number(p.mediaId) || null;
          run(`INSERT OR IGNORE INTO plays (screen_id, customer_id, media_id, media_name, kind, playlist_name, started_at, seconds)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, s.id, s.customer_id, mediaId, clip(p.name, 200), clip(p.kind, 20), clip(p.playlist, 200), at, sec);
        }
      });
    }
    // Uptime: count each minute the screen checked in, once.
    const minute = Math.floor(now() / 60e3);
    if (s.last_minute !== minute) {
      run("UPDATE screens SET last_minute = ? WHERE id = ?", minute, s.id);
      run(`INSERT INTO screen_uptime (screen_id, hour, minutes) VALUES (?, ?, 1)
           ON CONFLICT (screen_id, hour) DO UPDATE SET minutes = MIN(60, minutes + 1)`, s.id, Math.floor(minute / 60));
    }
    commands = all("SELECT id, type FROM commands WHERE screen_id = ? AND delivered_at IS NULL ORDER BY id", s.id);
    if (commands.length) run("UPDATE commands SET delivered_at = ? WHERE screen_id = ? AND delivered_at IS NULL", now(), s.id);
  }
  const cfg = buildConfig(s);
  // The newest player app: players install it when its fingerprint differs from their own.
  let app = null;
  try { const a = latestApk(); if (a) app = { sha256: a.sha256, size: a.size, url: "/download/player.apk" }; } catch (e) { /* no apk folder yet */ }
  res.json({ paired: !!s.paired_at, pairingCode: s.paired_at ? null : s.pairing_code, configVersion: cfg.version, commands, app, serverTime: now() });
});

// Live data (weather, news) for a widget on this screen's client.
router.get("/widget-data/:mediaId", requirePlayer, async (req, res) => {
  const m = get("SELECT kind, widget_json, customer_id FROM media WHERE id = ?", Number(req.params.mediaId) || 0);
  if (!m || m.kind !== "widget" || m.customer_id !== req.screen.customer_id) return res.status(404).json({ error: "not_found" });
  const w = JSON.parse(m.widget_json);
  try { res.json({ data: await widgets.widgetData(w.type, w.config) }); }
  catch (e) { res.status(502).json({ error: e instanceof widgets.WidgetError ? e.message : "unavailable" }); }
});

router.post("/screenshot", requirePlayer,
  express.raw({ type: ["image/jpeg", "image/png"], limit: "8mb" }),
  (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "image body required" });
    const ext = req.get("content-type").includes("png") ? "png" : "jpg";
    const file = `screen-${req.screen.id}-${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(DATA_DIR, "screenshots", file), req.body);
    const old = req.screen.screenshot_file;
    run("UPDATE screens SET screenshot_file = ?, screenshot_at = ? WHERE id = ?", file, now(), req.screen.id);
    if (old) fs.rm(path.join(DATA_DIR, "screenshots", old), { force: true }, () => {});
    res.json({ ok: true });
  });

module.exports = router;
