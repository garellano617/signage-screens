"use strict";
const path = require("node:path");
const fs = require("node:fs");
const express = require("express");
const cookieParser = require("cookie-parser");
const { DATA_DIR } = require("./db");
const auth = require("./auth");
const playerRoutes = require("./playerRoutes");
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

  // Player API (bearer token).
  app.use("/api/player", playerRoutes);

  // Media files are named by random id, so they never change: cache forever. Players fetch these without login.
  app.use("/media", express.static(path.join(DATA_DIR, "media"), { immutable: true, maxAge: "365d", index: false }));

  app.get("/download/player.apk", (req, res) => {
    const a = latestApk();
    if (!a) return res.status(404).type("text").send("No player app has been uploaded yet.");
    res.set("Content-Type", "application/vnd.android.package-archive");
    res.download(a.path, a.file);
  });

  // Screenshots are only for logged-in users.
  app.use("/screenshots", auth.requireUser, express.static(path.join(DATA_DIR, "screenshots"), { index: false, maxAge: 0 }));

  app.use("/api", adminRoutes);

  const pub = path.join(__dirname, "..", "public");
  app.use(express.static(pub, { index: false, maxAge: 0 }));
  const indexHtml = path.join(pub, "index.html");
  app.get(/^\/(?!api\/|media\/|screenshots\/).*/, (req, res) => res.sendFile(indexHtml));

  return app;
}

if (require.main === module) {
  auth.ensureAdmin();
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
