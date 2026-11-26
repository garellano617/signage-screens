"use strict";
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const { DATA_DIR, get, run } = require("./db");
const auth = require("./auth");
const brand = require("./branding");
const playerRoutes = require("./playerRoutes");
const crypto = require("node:crypto");
const apk = require("./apk");
const { router: adminRoutes, latestApk } = require("./adminRoutes");

function createApp() {
  const app = express();
  app.disable("x-powered-by");
  // Behind a hosting proxy (Railway, Render…): TRUST_PROXY=1 (number of proxy hops) so HTTPS cookies and client IPs work.
  const tp = process.env.TRUST_PROXY;
  if (tp) app.set("trust proxy", tp === "true" ? true : /^\d+$/.test(tp) ? Number(tp) : tp);
  app.use(cookieParser());
  app.use((req, res, next) => {
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "same-origin");
    next();
  });

  app.get("/healthz", (req, res) => res.json({ ok: true }));

  // White label: public, so the login page can show it.
  app.get("/api/branding", (req, res) => res.json(brand.branding()));
  app.get("/branding/logo", (req, res) => {
    const f = brand.logoFile();
    if (!f) return res.status(404).end();
    res.set("Cache-Control", "public, max-age=86400");
    res.sendFile(f);
  });

  // Automatic builds (GitHub Actions) upload a new player app here. Off unless PLAYER_UPLOAD_KEY is set.
  app.post("/api/player-app", express.raw({ type: () => true, limit: "200mb" }), (req, res) => {
    const want = String(process.env.PLAYER_UPLOAD_KEY || "");
    const got = String(req.get("x-upload-key") || "");
    const ok = want.length >= 32 && got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
    if (!ok) return res.status(want ? 401 : 404).json({ error: want ? "Wrong upload key." : "Uploads are off." });
    if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return res.status(400).json({ error: "Send the .apk file as the request body." });
    const tmp = path.join(apk.DIR, "ci-" + Date.now() + ".apk.part");
    fs.writeFileSync(tmp, req.body);
    const a = apk.installApk(tmp, req.get("x-file-name") || "PremierSignage.apk");
    if (!a) return res.status(400).json({ error: "That file isn't a valid Android app." });
    console.log("New player app uploaded by the build: " + a.file + " (" + a.sha256.slice(0, 12) + ")");
    res.status(201).json({ file: a.file, size: a.size, sha256: a.sha256 });
  });

  // Player API (bearer token).
  app.use("/api/player", playerRoutes);

  // Media files are named by random id, so they never change: cache forever. Players fetch these without login.
  app.use("/media", express.static(path.join(DATA_DIR, "media"), { immutable: true, maxAge: "365d", index: false }));

  // TVs update from /download/player.apk (keep it); /download/PremierSignage.apk is the same file with a nicer name to type.
  app.get(["/download/player.apk", "/download/PremierSignage.apk"], (req, res) => {
    const a = latestApk();
    if (!a) return res.status(404).type("text").send("No player app has been uploaded yet.");
    res.set("Content-Type", "application/vnd.android.package-archive");
    res.download(a.path, "PremierSignage.apk");
  });

  // Screenshots: logged-in users only, and a customer's users only see their own screens.
  app.get("/screenshots/:file", auth.requireUser, (req, res) => {
    const m = /^screen-(\d+)-\d+\.(jpg|png)$/.exec(req.params.file);
    const screen = m && get("SELECT customer_id FROM screens WHERE id = ?", Number(m[1]));
    if (!screen || (req.user.customer_id && req.user.customer_id !== screen.customer_id)) return res.status(404).end();
    res.set("Cache-Control", "no-store");
    res.sendFile(path.join(DATA_DIR, "screenshots", req.params.file), err => { if (err && !res.headersSent) res.status(404).end(); });
  });

  app.use("/api", adminRoutes);

  const pub = path.join(__dirname, "..", "public");
  app.use(express.static(pub, { index: false, maxAge: 0 }));
  const indexHtml = path.join(pub, "index.html");
  app.get(/^\/(?!api\/|media\/|screenshots\/).*/, (req, res) => res.sendFile(indexHtml));

  return app;
}

if (require.main === module) {
  auth.ensureAdmin();
  // Keep 35 days of uptime history.
  // …and 13 months of play history (reports).
  const prune = () => {
    run("DELETE FROM screen_uptime WHERE hour < ?", Math.floor(Date.now() / 3600e3) - 24 * 35);
    run("DELETE FROM plays WHERE started_at < ?", Date.now() - 396 * 864e5);
  };
  prune();
  setInterval(prune, 24 * 3600e3).unref();
  // 3100 by default so it doesn't collide with other local apps on 3000. Hosts like Render set PORT themselves.
  const port = Number(process.env.PORT) || 3100;
  // No host = listen on IPv4 and IPv6 together, so a port clash is an error instead of two apps silently sharing it.
  const server = process.env.HOST ? createApp().listen(port, process.env.HOST) : createApp().listen(port);
  server.on("error", err => {
    if (err.code === "EADDRINUSE") console.error(`Port ${port} is already used by another program. Close it, or start with a different PORT.`);
    else console.error(err);
    process.exit(1);
  });
  server.on("listening", () => {
    console.log(`Signage portal running at http://localhost:${port}`);
    console.log(`Data folder: ${DATA_DIR}`);
    if (!fs.readdirSync(path.join(DATA_DIR, "apk")).some(f => f.endsWith(".apk")))
      console.log(`Tip: put the player .apk in ${path.join(DATA_DIR, "apk")} to offer it for download.`);
  });
}

module.exports = { createApp };
