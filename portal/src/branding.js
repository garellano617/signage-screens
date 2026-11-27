"use strict";
// White label: the portal's name, main color and logo (shown on the login page, menu and browser tab).
const fs = require("node:fs");
const path = require("node:path");
const { get, run, DATA_DIR } = require("./db");

const DIR = path.join(DATA_DIR, "branding");
const LOGO_TYPES = { "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp" }; // no SVG: it could carry scripts

const setting = (key, d) => { const r = get("SELECT value FROM settings WHERE key = ?", key); return r ? r.value : d; };
const setSetting = (key, value) => run("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);

function logoFile() {
  const f = fs.readdirSync(DIR).find(n => /^logo\.(png|jpg|webp)$/.test(n));
  return f ? path.join(DIR, f) : null;
}

function branding() {
  const logo = logoFile();
  const b = {
    name: setting("brand_name", "Signage"),
    color: setting("brand_color", "#2563eb"),
    logo: logo ? "/branding/logo?v=" + Math.round(fs.statSync(logo).mtimeMs) : null,
    // Word under the logo on the home-screen icon (phones, desktop shortcuts).
    iconWord: setting("icon_word", "SIGNAGE")
  };
  // The icon set matches this look; when it changes, an admin's browser draws new icons (see app.js makeIcons).
  b.iconKey = [b.name, b.color, b.logo || "", b.iconWord, ICON_STYLE].join("|");
  b.iconsSaved = setting("icon_key", "");
  b.iconVersion = setting("icon_version", "0");
  return b;
}

// ---- Home-screen icons (PNG): drawn by the browser, stored here. Defaults ship in public/icons. ----
const ICON_STYLE = "1";
const ICON_SIZES = [512, 192, 180, 32];
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function iconFile(size) {
  if (!ICON_SIZES.includes(size)) return null;
  const custom = path.join(DIR, "icon-" + size + ".png");
  if (fs.existsSync(custom)) return custom;
  return path.join(__dirname, "..", "public", "icons", "default-" + size + ".png");
}
/** icons: { "512": Buffer, ... } (all sizes, PNG). */
function saveIcons(icons, key) {
  for (const s of ICON_SIZES) {
    const buf = icons[s];
    if (!Buffer.isBuffer(buf) || buf.length < 50 || buf.length > 1024 * 1024 || !buf.subarray(0, 8).equals(PNG_SIG)) throw new Error("The icon pictures aren't valid PNG files.");
  }
  for (const s of ICON_SIZES) fs.writeFileSync(path.join(DIR, "icon-" + s + ".png"), icons[s]);
  setSetting("icon_key", key);
  setSetting("icon_version", String(Date.now()));
}

function saveLogo(buffer, mime) {
  const ext = LOGO_TYPES[mime];
  if (!ext) throw new Error("Use a PNG, JPG or WebP image for the logo.");
  const old = logoFile();
  if (old) fs.rmSync(old, { force: true });
  fs.writeFileSync(path.join(DIR, "logo" + ext), buffer);
}

function removeLogo() { const f = logoFile(); if (f) fs.rmSync(f, { force: true }); }

module.exports = { branding, setting, setSetting, logoFile, saveLogo, removeLogo, LOGO_TYPES, iconFile, saveIcons, ICON_SIZES };
