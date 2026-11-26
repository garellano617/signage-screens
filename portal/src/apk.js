"use strict";
// The player app (.apk) offered for download and for automatic updates. Only the newest file is kept.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DATA_DIR } = require("./db");

const DIR = path.join(DATA_DIR, "apk");
let hashed = { key: "", sha256: "" };

/** Newest .apk with its SHA-256 (players compare it with their own to know an update is waiting). */
function latestApk() {
  const files = fs.readdirSync(DIR).filter(f => f.toLowerCase().endsWith(".apk"))
    .map(f => ({ f, st: fs.statSync(path.join(DIR, f)) })).sort((a, b) => b.st.mtimeMs - a.st.mtimeMs);
  if (!files[0]) return null;
  const { f, st } = files[0];
  const p = path.join(DIR, f);
  const key = f + ":" + st.size + ":" + st.mtimeMs;
  if (hashed.key !== key) hashed = { key, sha256: crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex") };
  return { file: f, path: p, size: st.size, updatedAt: st.mtimeMs, sha256: hashed.sha256 };
}

/** Checks an uploaded file is an Android app, then makes it the one offered (older ones are removed). */
function installApk(tmpPath, originalName) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(tmpPath, "r"); fs.readSync(fd, head, 0, 4, 0); fs.closeSync(fd);
  if (head.toString("latin1") !== "PK\x03\x04") { fs.rmSync(tmpPath, { force: true }); return null; }
  const name = path.basename(String(originalName || "PremierSignage.apk")).replace(/[^\w.-]/g, "_").replace(/(\.apk)?$/i, ".apk");
  for (const old of fs.readdirSync(DIR)) if (old.toLowerCase().endsWith(".apk")) fs.rmSync(path.join(DIR, old), { force: true });
  fs.renameSync(tmpPath, path.join(DIR, name));
  return latestApk();
}

module.exports = { DIR, latestApk, installApk };
