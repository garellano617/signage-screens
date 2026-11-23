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
  return {
    name: setting("brand_name", "Signage"),
    color: setting("brand_color", "#2563eb"),
    logo: logo ? "/branding/logo?v=" + Math.round(fs.statSync(logo).mtimeMs) : null
  };
}

function saveLogo(buffer, mime) {
  const ext = LOGO_TYPES[mime];
  if (!ext) throw new Error("Use a PNG, JPG or WebP image for the logo.");
  const old = logoFile();
  if (old) fs.rmSync(old, { force: true });
  fs.writeFileSync(path.join(DIR, "logo" + ext), buffer);
}

function removeLogo() { const f = logoFile(); if (f) fs.rmSync(f, { force: true }); }

module.exports = { branding, setting, setSetting, logoFile, saveLogo, removeLogo, LOGO_TYPES };
