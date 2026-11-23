"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const { get, run, all, now, DATA_DIR } = require("./db");
const { requirePlayer, sha256 } = require("./auth");
const { buildConfig } = require("./playerConfig");

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
    error: clip(b.error, 500)
  };
  run("UPDATE screens SET last_seen = ?, ip = ?, status_json = ?, app_version = COALESCE(NULLIF(?, ''), app_version) WHERE id = ?",
    now(), req.ip || "", JSON.stringify(status), clip(b.appVersion, 40), s.id);
  let commands = [];
  if (s.paired_at) {
    commands = all("SELECT id, type FROM commands WHERE screen_id = ? AND delivered_at IS NULL ORDER BY id", s.id);
    if (commands.length) run("UPDATE commands SET delivered_at = ? WHERE screen_id = ? AND delivered_at IS NULL", now(), s.id);
  }
  const cfg = buildConfig(s);
  res.json({ paired: !!s.paired_at, pairingCode: s.paired_at ? null : s.pairing_code, configVersion: cfg.version, commands });
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
