"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "signage-test-"));
process.env.ADMIN_EMAIL = "admin@test.local";
process.env.ADMIN_PASSWORD = "admin-pass-123";

const { createApp } = require("../src/server");
const { ensureAdmin } = require("../src/auth");

let base, server, cookie = "", scopeId = null;

async function call(method, url, body, headers = {}) {
  const opt = { method, headers: { ...headers } };
  if (cookie) opt.headers.cookie = cookie;
  if (scopeId) opt.headers["x-customer-id"] = String(scopeId);
  if (body instanceof FormData || Buffer.isBuffer(body)) opt.body = body;
  else if (body !== undefined) { opt.headers["content-type"] = "application/json"; opt.body = JSON.stringify(body); }
  const res = await fetch(base + url, opt);
  const sc = res.headers.get("set-cookie");
  if (sc && sc.startsWith("sid=")) cookie = sc.split(";")[0];
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch (_) { json = text; }
  return { status: res.status, body: json };
}

test.before(async () => {
  ensureAdmin();
  server = createApp().listen(0);
  await new Promise(r => server.once("listening", r));
  base = "http://127.0.0.1:" + server.address().port;
});
test.after(() => { server.close(); });

test("full flow: login, media, playlist, pairing, player config, commands", async () => {
  assert.equal((await call("GET", "/api/dashboard")).status, 401);
  assert.equal((await call("POST", "/api/auth/login", { email: "admin@test.local", password: "nope" })).status, 401);
  const login = await call("POST", "/api/auth/login", { email: "ADMIN@test.local", password: "admin-pass-123" });
  assert.equal(login.status, 200);
  assert.equal(login.body.user.role, "admin");
  assert.equal(login.body.user.isStaff, true);

  // Work inside one customer.
  const nofile = new FormData(); nofile.append("files", new Blob(["x"], { type: "image/png" }), "a.png");
  assert.equal((await call("POST", "/api/media", nofile)).status, 400, "staff must pick a customer first");
  const cust = await call("POST", "/api/customers", { name: "Taqueria Uno", screenLimit: 1 });
  assert.equal(cust.status, 201);
  scopeId = cust.body.id;

  // Upload an image.
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
  const fd = new FormData();
  fd.append("files", new Blob([png], { type: "image/png" }), "Lunch Menu.png");
  const up = await call("POST", "/api/media", fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body[0].kind, "image");
  assert.equal(up.body[0].name, "Lunch Menu");
  assert.match(up.body[0].sha256, /^[0-9a-f]{64}$/);
  const img = up.body[0];
  assert.equal((await fetch(base + img.src)).status, 200);

  // Reject a non-media file.
  const bad = new FormData();
  bad.append("files", new Blob(["hi"], { type: "text/plain" }), "x.txt");
  assert.equal((await call("POST", "/api/media", bad)).status, 400);

  const web = await call("POST", "/api/media/web", { url: "https://example.com/menu" });
  assert.equal(web.status, 201);
  assert.equal((await call("POST", "/api/media/web", { url: "javascript:alert(1)" })).status, 400);

  // Playlist.
  const pl = (await call("POST", "/api/playlists", { name: "Lunch" })).body;
  const put = await call("PUT", "/api/playlists/" + pl.id, { items: [{ mediaId: img.id, duration: 8 }, { mediaId: web.body.id, duration: 30 }] });
  assert.equal(put.status, 200);
  assert.equal(put.body.loopSeconds, 38);
  const dup = await call("POST", "/api/playlists/" + pl.id + "/duplicate");
  assert.equal(dup.body.itemCount, 2);

  // A player registers and shows a code.
  const reg = await call("POST", "/api/player/register", { deviceId: "android-abc12345", model: "Test TV", appVersion: "1.0.0" });
  assert.equal(reg.status, 200);
  assert.equal(reg.body.paired, false);
  assert.match(reg.body.pairingCode, /^[A-HJ-NP-Z2-9]{6}$/);
  const auth = { authorization: "Bearer " + reg.body.token };
  assert.equal((await call("GET", "/api/player/config", undefined, { authorization: "Bearer wrong" })).status, 401);
  let hb = await call("POST", "/api/player/heartbeat", { playing: "" }, auth);
  assert.equal(hb.body.paired, false);

  // Pair it.
  assert.equal((await call("POST", "/api/screens/pair", { code: "ZZZZZZ" })).status, 400);
  const paired = await call("POST", "/api/screens/pair", { code: reg.body.pairingCode.toLowerCase(), name: "Lobby", playlistId: pl.id });
  assert.equal(paired.status, 201, JSON.stringify(paired.body));
  const sid = paired.body.id;

  let cfg = (await call("GET", "/api/player/config", undefined, auth)).body;
  assert.equal(cfg.paired, true);
  assert.equal(cfg.screen.name, "Lobby");
  assert.equal(cfg.defaultPlaylist.items.length, 2);
  assert.equal(cfg.defaultPlaylist.items[0].src, img.src);
  assert.equal(cfg.defaultPlaylist.items[1].src, "https://example.com/menu");
  const v1 = cfg.version;

  // Schedule changes the config version.
  assert.equal((await call("PUT", "/api/screens/" + sid + "/schedules", [{ playlistId: dup.body.id, days: 0, start: "09:00", end: "17:00" }])).status, 400);
  assert.equal((await call("PUT", "/api/screens/" + sid + "/schedules", [{ playlistId: dup.body.id, days: 31, start: "22:00", end: "06:00" }])).status, 200);
  cfg = (await call("GET", "/api/player/config", undefined, auth)).body;
  assert.notEqual(cfg.version, v1);
  assert.equal(cfg.schedules[0].start, "22:00");

  // Re-registering keeps the device paired.
  const reg2 = await call("POST", "/api/player/register", { deviceId: "android-abc12345" });
  assert.equal(reg2.body.paired, true);
  const auth2 = { authorization: "Bearer " + reg2.body.token };
  assert.equal((await call("GET", "/api/player/config", undefined, auth)).status, 401, "old token is revoked");

  // Commands are delivered once.
  assert.equal((await call("POST", "/api/screens/" + sid + "/commands", { type: "format_disk" })).status, 400);
  await call("POST", "/api/screens/" + sid + "/commands", { type: "screenshot" });
  await call("POST", "/api/screens/" + sid + "/commands", { type: "screenshot" });
  hb = await call("POST", "/api/player/heartbeat", { playing: "Lunch Menu", playlist: "Lunch", configVersion: cfg.version }, auth2);
  assert.deepEqual(hb.body.commands.map(c => c.type), ["screenshot"]);
  assert.equal(hb.body.configVersion, cfg.version);
  hb = await call("POST", "/api/player/heartbeat", { playing: "Lunch Menu", playlist: "Lunch" }, auth2);
  assert.equal(hb.body.commands.length, 0);

  // Screenshot upload, visible only when logged in.
  const shot = await call("POST", "/api/player/screenshot", png, { ...auth2, "content-type": "image/png" });
  assert.equal(shot.status, 200);
  const detail = (await call("GET", "/api/screens/" + sid)).body;
  assert.equal(detail.online, true);
  assert.equal(detail.status.playing, "Lunch Menu");
  assert.ok(detail.screenshot);
  assert.equal((await call("GET", detail.screenshot)).status, 200);
  assert.equal((await fetch(base + detail.screenshot)).status, 401);

  // Settings and bulk assign.
  assert.equal((await call("PATCH", "/api/screens/" + sid, { orientation: 45 })).status, 400);
  assert.equal((await call("PATCH", "/api/screens/" + sid, { orientation: 90, volume: 40 })).body.orientation, 90);
  assert.equal((await call("POST", "/api/screens/bulk-assign", { screenIds: [sid], playlistId: dup.body.id })).status, 200);
  assert.equal((await call("GET", "/api/screens/" + sid)).body.playlistId, dup.body.id);

  // Dashboard.
  const dash = (await call("GET", "/api/dashboard")).body;
  assert.equal(dash.screens, 1);
  assert.equal(dash.online, 1);

  // Deleting media removes it from playlists.
  await call("DELETE", "/api/media/" + img.id);
  assert.equal((await call("GET", "/api/playlists/" + pl.id)).body.itemCount, 1);
  assert.equal((await fetch(base + img.src)).status, 404);

  // Removing the screen makes the device unknown, so it re-registers and gets a new code.
  await call("DELETE", "/api/screens/" + sid);
  assert.equal((await call("GET", "/api/player/config", undefined, auth2)).status, 401);
  const reg3 = await call("POST", "/api/player/register", { deviceId: "android-abc12345" });
  assert.equal(reg3.body.paired, false);
});

test("browser script has no syntax errors", () => {
  const vm = require("node:vm");
  for (const f of ["app.js", "overlay/overlay.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "..", "public", f), "utf8");
    assert.doesNotThrow(() => new vm.Script(src, { filename: f }), f);
  }
});

test("admins upload the player APK and anyone can download it", async () => {
  assert.equal((await call("GET", "/api/apk")).body.available, false);
  const notApk = new FormData();
  notApk.append("file", new Blob(["hello"]), "player.apk");
  assert.equal((await call("POST", "/api/apk", notApk)).status, 400);
  const fd = new FormData();
  fd.append("file", new Blob([Buffer.from("PK\x03\x04fake-apk", "latin1")]), "signage-player-1.0.0.apk");
  const up = await call("POST", "/api/apk", fd);
  assert.equal(up.status, 201, JSON.stringify(up.body));
  assert.equal(up.body.file, "signage-player-1.0.0.apk");
  const dl = await fetch(base + "/download/player.apk");
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("content-type"), "application/vnd.android.package-archive");
});

test("users: editors can't manage users; last admin protected", async () => {
  scopeId = null;
  const add = await call("POST", "/api/users", { email: "ed@test.local", password: "editor-pass-1", role: "editor" });
  assert.equal(add.status, 201);
  const me = (await call("GET", "/api/auth/me")).body.user;
  assert.equal((await call("PATCH", "/api/users/" + me.id, { role: "editor" })).status, 400);
  assert.equal((await call("DELETE", "/api/users/" + me.id)).status, 400);
  cookie = "";
  await call("POST", "/api/auth/login", { email: "ed@test.local", password: "editor-pass-1" });
  assert.equal((await call("GET", "/api/users")).status, 403);
  assert.equal((await call("GET", "/api/playlists")).status, 200);
  assert.equal((await call("POST", "/api/auth/password", { current: "wrong", next: "whatever123" })).status, 400);
  assert.equal((await call("POST", "/api/auth/password", { current: "editor-pass-1", next: "new-pass-456" })).status, 200);
  await call("POST", "/api/auth/logout");
  assert.equal((await call("GET", "/api/auth/me")).status, 401);
});

test("customer sub-accounts are kept apart", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const A = (await call("POST", "/api/customers", { name: "Alpha Grocery", screenLimit: 1 })).body;
  const B = (await call("POST", "/api/customers", { name: "Beta Office" })).body;

  // Staff create a user + content for each customer.
  scopeId = A.id;
  assert.equal((await call("POST", "/api/users", { email: "owner@alpha.test", password: "alpha-pass-1", role: "admin" })).status, 201);
  const aPl = (await call("POST", "/api/playlists", { name: "Alpha menu" })).body;
  const aWeb = (await call("POST", "/api/media/web", { url: "https://alpha.example/" })).body;
  scopeId = B.id;
  const bPl = (await call("POST", "/api/playlists", { name: "Beta lobby" })).body;
  const bWeb = (await call("POST", "/api/media/web", { url: "https://beta.example/" })).body;

  // Pair a TV to B (staff on "All customers" pick the customer in the request).
  scopeId = null;
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-beta-0001" })).body;
  assert.equal((await call("POST", "/api/screens/pair", { code: reg.pairingCode })).status, 400, "needs a customer");
  assert.equal((await call("POST", "/api/screens/pair", { code: reg.pairingCode, customerId: B.id, playlistId: aPl.id })).status, 400, "A's playlist on B's screen");
  const bScreen = (await call("POST", "/api/screens/pair", { code: reg.pairingCode, customerId: B.id, playlistId: bPl.id })).body;
  assert.equal(bScreen.customerName, "Beta Office");
  // Mixing customers in a playlist is refused.
  assert.equal((await call("PUT", "/api/playlists/" + aPl.id, { items: [{ mediaId: bWeb.id }] })).status, 400);
  // Staff on "All customers" see both.
  assert.equal((await call("GET", "/api/playlists")).body.filter(p => [aPl.id, bPl.id].includes(p.id)).length, 2);

  // Screen limit.
  scopeId = A.id;
  const r1 = (await call("POST", "/api/player/register", { deviceId: "android-alpha-0001" })).body;
  const r2 = (await call("POST", "/api/player/register", { deviceId: "android-alpha-0002" })).body;
  assert.equal((await call("POST", "/api/screens/pair", { code: r1.pairingCode })).status, 201);
  const over = await call("POST", "/api/screens/pair", { code: r2.pairingCode });
  assert.equal(over.status, 400);
  assert.match(over.body.error, /1 of 1/);

  // Alpha's own login only sees Alpha.
  cookie = ""; scopeId = B.id; // a customer user can't switch customers with the header
  const me = (await call("POST", "/api/auth/login", { email: "owner@alpha.test", password: "alpha-pass-1" })).body.user;
  assert.equal(me.isStaff, false);
  assert.equal(me.customerName, "Alpha Grocery");
  assert.deepEqual((await call("GET", "/api/playlists")).body.map(p => p.name), ["Alpha menu"]);
  assert.deepEqual((await call("GET", "/api/media")).body.map(m => m.id), [aWeb.id]);
  assert.equal((await call("GET", "/api/screens")).body.length, 1);
  assert.equal((await call("GET", "/api/screens/" + bScreen.id)).status, 404);
  assert.equal((await call("PATCH", "/api/screens/" + bScreen.id, { name: "hacked" })).status, 404);
  assert.equal((await call("POST", "/api/screens/" + bScreen.id + "/commands", { type: "restart_app" })).status, 404);
  assert.equal((await call("DELETE", "/api/playlists/" + bPl.id)).status, 404);
  assert.equal((await call("DELETE", "/api/media/" + bWeb.id)).status, 404);
  assert.equal((await call("GET", "/api/customers")).status, 403);
  assert.equal((await call("POST", "/api/apk", new FormData())).status, 403);
  // Their admin manages only their own users.
  const users = (await call("GET", "/api/users")).body;
  assert.deepEqual(users.map(u => u.email), ["owner@alpha.test"]);
  assert.equal((await call("POST", "/api/users", { email: "staff@alpha.test", password: "alpha-pass-2" })).body.customerName, "Alpha Grocery");
  const dash = (await call("GET", "/api/dashboard")).body;
  assert.equal(dash.screens, 1);
  assert.equal(dash.customers, null);

  // Pausing the customer logs them out and blocks login.
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  assert.equal((await call("PATCH", "/api/customers/" + A.id, { active: false })).status, 200);
  cookie = "";
  assert.equal((await call("POST", "/api/auth/login", { email: "owner@alpha.test", password: "alpha-pass-1" })).status, 403);

  // A customer with screens can't be deleted; without screens it can (and takes its users along).
  cookie = "";
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  assert.equal((await call("DELETE", "/api/customers/" + B.id)).status, 400);
  await call("DELETE", "/api/screens/" + bScreen.id);
  assert.equal((await call("DELETE", "/api/customers/" + B.id)).status, 200);
  assert.equal((await call("GET", "/api/playlists/" + bPl.id)).status, 404);
});

test("screen layers: saved, cleaned, kept per client, sent to the player", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const A = (await call("POST", "/api/customers", { name: "Layer Cafe" })).body;
  const B = (await call("POST", "/api/customers", { name: "Other Client" })).body;
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const up = async cid => { scopeId = cid; const fd = new FormData(); fd.append("files", new Blob([png], { type: "image/png" }), "special.png"); return (await call("POST", "/api/media", fd)).body[0]; };
  const imgA = await up(A.id), imgB = await up(B.id);

  scopeId = A.id;
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-layers-0001" })).body;
  const scr = (await call("POST", "/api/screens/pair", { code: reg.pairingCode })).body;
  const auth = { authorization: "Bearer " + reg.token };

  // New screens start with the video layer only.
  const d = (await call("GET", "/api/screens/" + scr.id)).body.layers;
  assert.equal(d.video.enabled, true);
  assert.equal(d.specials.enabled || d.text.enabled || d.effects.enabled, false);
  const v1 = (await call("GET", "/api/player/config", undefined, auth)).body.version;

  const put = await call("PUT", "/api/screens/" + scr.id + "/layers", {
    video: { enabled: true, region: "left70" },
    specials: { enabled: true, heading: "Lunch", position: "right", seconds: 1, accent: "red", items: [
      { title: "Taco plate", price: "$8.99", mediaId: imgA.id, days: 31, start: "11:00", end: "14:00" },
      { title: "Stolen photo", mediaId: imgB.id },
      { title: "", price: "", description: "" }
    ] },
    text: { enabled: true, blocks: [{ text: "Open late", position: "nowhere", size: "huge", color: "#00ff00", bgOpacity: 500 }, { text: "   " }],
      ticker: { enabled: true, text: "Free Wi-Fi\nCatering available", speed: "warp" } },
    effects: { enabled: true, type: "lava", intensity: "heavy" },
    extra: "<script>"
  });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  const L = put.body;
  assert.equal(L.video.region, "left70");
  assert.equal(L.specials.seconds, 3, "clamped");
  assert.equal(L.specials.accent, "#f59e0b", "bad color -> default");
  assert.equal(L.specials.items.length, 2, "empty special dropped");
  assert.equal(L.specials.items[0].image.src, imgA.src);
  assert.equal(L.specials.items[1].mediaId, null, "another client's photo is refused");
  assert.deepEqual([L.text.blocks.length, L.text.blocks[0].position, L.text.blocks[0].size, L.text.blocks[0].bgOpacity], [1, "top", "m", 100]);
  assert.equal(L.text.ticker.speed, "normal");
  assert.equal(L.effects.type, "snow");
  assert.equal(L.extra, undefined);

  // The player gets the layers, with the photo's checksum so it can download it for offline use.
  const cfg = (await call("GET", "/api/player/config", undefined, auth)).body;
  assert.notEqual(cfg.version, v1);
  assert.equal(cfg.layers.video.region, "left70");
  assert.equal(cfg.layers.specials.items[0].image.sha256, imgA.sha256);

  // Another client's login can't read or change these layers.
  scopeId = B.id;
  assert.equal((await call("GET", "/api/screens/" + scr.id + "/layers")).status, 404);
  assert.equal((await call("PUT", "/api/screens/" + scr.id + "/layers", {})).status, 404);

  // Deleting the photo leaves the special, without the photo.
  scopeId = A.id;
  await call("DELETE", "/api/media/" + imgA.id);
  const after = (await call("GET", "/api/screens/" + scr.id + "/layers")).body;
  assert.equal(after.specials.items[0].title, "Taco plate");
  assert.equal(after.specials.items[0].image, null);
});

test("screen map location, monitoring uptime, screenshot all", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const C = (await call("POST", "/api/customers", { name: "Monitor Mart" })).body;
  scopeId = C.id;
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-monitor-0001" })).body;
  const scr = (await call("POST", "/api/screens/pair", { code: reg.pairingCode, name: "Door" })).body;

  // Location
  assert.equal((await call("PATCH", "/api/screens/" + scr.id, { lat: 95, lng: 10 })).status, 400);
  const loc = (await call("PATCH", "/api/screens/" + scr.id, { lat: 42.3601, lng: -71.0589, address: "Boston, MA" })).body;
  assert.deepEqual([loc.lat, loc.lng, loc.address], [42.3601, -71.0589, "Boston, MA"]);
  assert.equal((await call("PATCH", "/api/screens/" + scr.id, { lat: null })).body.lat, null);
  assert.equal((await call("GET", "/api/geocode?q=ab")).status, 400);

  // Uptime: two heartbeats in the same minute count once.
  const auth = { authorization: "Bearer " + reg.token };
  await call("POST", "/api/player/heartbeat", {}, auth);
  await call("POST", "/api/player/heartbeat", {}, auth);
  const mon = (await call("GET", "/api/monitoring")).body;
  assert.equal(mon.length, 1);
  assert.equal(mon[0].online, true);
  assert.equal(mon[0].last24.length, 24);
  assert.equal(mon[0].last24[23], 1);
  assert.ok(mon[0].uptime24h > 0 && mon[0].uptime24h <= 100, "uptime " + mon[0].uptime24h);

  // Screenshot all: one pending command per screen, only this client's screens.
  const r = (await call("POST", "/api/screens-commands", { type: "screenshot" })).body;
  assert.equal(r.screens, 1);
  await call("POST", "/api/screens-commands", { type: "screenshot" });
  const hb = (await call("POST", "/api/player/heartbeat", {}, auth)).body;
  assert.deepEqual(hb.commands.map(c => c.type), ["screenshot"]);
  assert.equal((await call("POST", "/api/screens-commands", { type: "restart_app" })).status, 400);
});

test("widgets: create each type, cleaned settings, feed parsing, private-network block, player config", async () => {
  const widgets = require("../src/widgets");
  // Feed parsing (RSS + Atom, CDATA, entities)
  const rss = `<rss><channel><title>Site</title><item><title><![CDATA[Big <b>sale</b> today]]></title></item><item><title>Caf&eacute; &amp; more &#8212; open</title></item></channel></rss>`;
  assert.deepEqual(widgets.parseFeed(rss).map(i => i.title), ["Big sale today", "Café & more — open"]);
  assert.deepEqual(widgets.parseFeed(`<feed><entry><title type="html">Atom one</title></entry></feed>`).map(i => i.title), ["Atom one"]);
  // Feeds on private networks are refused (protects the server's own network).
  for (const host of ["127.0.0.1", "10.1.2.3", "192.168.1.5", "169.254.169.254", "::1"]) {
    await assert.rejects(widgets.assertPublicHost(host), /isn't allowed/, host);
  }

  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const C = (await call("POST", "/api/customers", { name: "Widget Diner" })).body;
  const D = (await call("POST", "/api/customers", { name: "Other Diner" })).body;
  scopeId = C.id;
  const mk = (type, config, name) => call("POST", "/api/media/widget", { type, config, name });

  assert.equal((await mk("bogus", {})).status, 400);
  assert.equal((await mk("weather", { place: "Nowhere" })).status, 400, "weather needs a location");
  assert.equal((await mk("rss", { url: "ftp://x" })).status, 400);
  assert.equal((await mk("countdown", { target: "soon" })).status, 400);
  assert.equal((await mk("qr", { text: "" })).status, 400);

  const clock = (await mk("clock", { style: "analog", hours: "99", bg: "red", label: "Front desk" })).body;
  assert.equal(clock.kind, "widget");
  assert.deepEqual([clock.widget.type, clock.widget.config.style, clock.widget.config.hours, clock.widget.config.bg], ["clock", "analog", "12", "#0f172a"]);
  const qr = (await mk("qr", { text: "https://example.com/menu", caption: "Menu" })).body;
  assert.match(qr.widget.config.svg, /^<svg/);
  const weather = (await mk("weather", { lat: 42.36, lng: -71.06, place: "Boston", units: "c" })).body;
  assert.equal(weather.widget.config.units, "c");
  const cd = (await mk("countdown", { target: "2030-01-01T09:00", title: "Opening" })).body;
  const msg = (await mk("message", { title: "Now hiring", body: "Ask inside", align: "left" })).body;
  assert.equal(msg.widget.config.align, "left");

  // Edit keeps the type, re-cleans settings.
  const ed = (await call("PATCH", "/api/media/" + clock.id, { config: { style: "digital", hours: "24" } })).body;
  assert.deepEqual([ed.widget.type, ed.widget.config.style, ed.widget.config.hours], ["clock", "digital", "24"]);
  assert.equal((await call("PATCH", "/api/media/" + cd.id, { config: { target: "bad" } })).status, 400);

  // In a playlist the player gets the widget settings; nothing to download.
  const pl = (await call("POST", "/api/playlists", { name: "Widgets" })).body;
  await call("PUT", "/api/playlists/" + pl.id, { items: [clock, qr, weather, cd, msg].map(m => ({ mediaId: m.id, duration: 15 })) });
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-widget-0001" })).body;
  await call("POST", "/api/screens/pair", { code: reg.pairingCode, playlistId: pl.id });
  const auth = { authorization: "Bearer " + reg.token };
  const cfg = (await call("GET", "/api/player/config", undefined, auth)).body;
  const items = cfg.defaultPlaylist.items;
  assert.deepEqual(items.map(i => i.kind), ["widget", "widget", "widget", "widget", "widget"]);
  assert.equal(items[0].src, "widget:" + clock.id);
  assert.equal(items[0].widget.type, "clock");

  // Widgets without live data return null; other clients' widgets are hidden from this screen.
  assert.deepEqual((await call("GET", "/api/player/widget-data/" + clock.id, undefined, auth)).body, { data: null });
  scopeId = D.id;
  const other = (await mk("clock", {})).body;
  assert.equal((await call("GET", "/api/player/widget-data/" + other.id, undefined, auth)).status, 404);
  assert.equal((await call("GET", "/api/media/" + clock.id + "/widget-data")).status, 404);
});

test("channels: one design on many screens, per client", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const A = (await call("POST", "/api/customers", { name: "Channel Cafe" })).body;
  const B = (await call("POST", "/api/customers", { name: "Channel Other" })).body;
  scopeId = B.id;
  const bPl = (await call("POST", "/api/playlists", { name: "B list" })).body;
  scopeId = A.id;
  const own = (await call("POST", "/api/playlists", { name: "Own" })).body;
  const menu = (await call("POST", "/api/playlists", { name: "Menu" })).body;
  const web = (await call("POST", "/api/media/web", { url: "https://example.com/menu" })).body;
  await call("PUT", "/api/playlists/" + menu.id, { items: [{ mediaId: web.id, duration: 20 }] });

  assert.equal((await call("POST", "/api/channels", { name: "x", playlistId: bPl.id })).status, 400, "other client's playlist");
  const ch = (await call("POST", "/api/channels", { name: "Menu boards", playlistId: menu.id })).body;
  assert.equal(ch.playlistName, "Menu");
  await call("PUT", "/api/channels/" + ch.id + "/layers", { text: { enabled: true, ticker: { enabled: true, text: "Fresh daily" } } });

  const pair = async dev => {
    const reg = (await call("POST", "/api/player/register", { deviceId: dev })).body;
    const s = (await call("POST", "/api/screens/pair", { code: reg.pairingCode, playlistId: own.id })).body;
    return { s, auth: { authorization: "Bearer " + reg.token } };
  };
  const one = await pair("android-channel-0001"), two = await pair("android-channel-0002");

  // Put both screens on the channel.
  const assigned = (await call("PUT", "/api/channels/" + ch.id + "/screens", { screenIds: [one.s.id, two.s.id] })).body;
  assert.equal(assigned.screens.length, 2);
  for (const t of [one, two]) {
    const cfg = (await call("GET", "/api/player/config", undefined, t.auth)).body;
    assert.equal(cfg.defaultPlaylist.name, "Menu");
    assert.equal(cfg.layers.text.ticker.text, "Fresh daily");
  }
  // Changing the channel changes every screen's config.
  const v1 = (await call("GET", "/api/player/config", undefined, one.auth)).body.version;
  await call("PATCH", "/api/channels/" + ch.id, { playlistId: own.id });
  const after = (await call("GET", "/api/player/config", undefined, two.auth)).body;
  assert.equal(after.defaultPlaylist.name, "Own");
  assert.notEqual((await call("GET", "/api/player/config", undefined, one.auth)).body.version, v1);

  // Taking a screen off (via the screen page) restores its own settings.
  assert.equal((await call("PATCH", "/api/screens/" + one.s.id, { channelId: null })).body.channelId, null);
  assert.equal((await call("GET", "/api/player/config", undefined, one.auth)).body.layers.text.enabled, false);
  assert.equal((await call("GET", "/api/screens/" + two.s.id)).body.channelName, "Menu boards");

  // Another client can't see or use it.
  scopeId = B.id;
  assert.equal((await call("GET", "/api/channels/" + ch.id)).status, 404);
  assert.deepEqual((await call("GET", "/api/channels")).body, []);
  scopeId = A.id;
  const bReg = (await call("POST", "/api/player/register", { deviceId: "android-channel-b001" })).body;
  scopeId = B.id;
  const bScr = (await call("POST", "/api/screens/pair", { code: bReg.pairingCode })).body;
  assert.equal((await call("PATCH", "/api/screens/" + bScr.id, { channelId: ch.id })).status, 400);
  scopeId = A.id;
  assert.equal((await call("PUT", "/api/channels/" + ch.id + "/screens", { screenIds: [bScr.id] })).status, 400);

  // Deleting the channel puts its screens back on their own settings.
  await call("DELETE", "/api/channels/" + ch.id);
  assert.equal((await call("GET", "/api/screens/" + two.s.id)).body.channelId, null);
  assert.equal((await call("GET", "/api/player/config", undefined, two.auth)).body.defaultPlaylist.name, "Own");
});

test("reports: proof of play from heartbeats, no double counting, per client, CSV", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const A = (await call("POST", "/api/customers", { name: "Report Bakery" })).body;
  const B = (await call("POST", "/api/customers", { name: "Report Other" })).body;
  const pair = async (cid, dev) => {
    scopeId = cid;
    const reg = (await call("POST", "/api/player/register", { deviceId: dev })).body;
    const s = (await call("POST", "/api/screens/pair", { code: reg.pairingCode, name: dev })).body;
    return { s, auth: { authorization: "Bearer " + reg.token } };
  };
  const a = await pair(A.id, "android-report-a001"), b = await pair(B.id, "android-report-b001");
  const t = Date.now() - 3600e3;
  const plays = [
    { mediaId: 501, name: "Croissant", kind: "image", playlist: "Main", at: t, sec: 10 },
    { mediaId: 502, name: "Promo video", kind: "video", playlist: "Main", at: t + 10e3, sec: 30 },
    { mediaId: 501, name: "Croissant", kind: "image", playlist: "Main", at: t + 40e3, sec: 10 },
    { mediaId: 501, name: "bad", at: Date.now() + 864e5, sec: 10 },          // in the future: ignored
    { mediaId: 501, name: "bad", at: t, sec: -5 }                             // negative: ignored
  ];
  await call("POST", "/api/player/heartbeat", { plays }, a.auth);
  await call("POST", "/api/player/heartbeat", { plays }, a.auth);       // a retry of the same batch
  await call("POST", "/api/player/heartbeat", { plays: [{ mediaId: 900, name: "Other ad", kind: "image", at: t, sec: 8 }] }, b.auth);

  scopeId = A.id;
  const rep = (await call("GET", "/api/reports?tz=0")).body;
  assert.deepEqual([rep.totals.plays, rep.totals.seconds, rep.totals.screens], [3, 50, 1]);
  assert.equal(rep.byDay.length, 7);
  assert.deepEqual(rep.byMedia.map(m => [m.name, m.plays, m.seconds]), [["Croissant", 2, 20], ["Promo video", 1, 30]]);
  assert.equal(rep.byScreen[0].name, "android-report-a001");

  // Staff on "all clients" see both; a screen filter narrows it.
  scopeId = null;
  assert.equal((await call("GET", "/api/reports")).body.totals.plays, 4);
  assert.equal((await call("GET", "/api/reports?screenId=" + b.s.id)).body.totals.plays, 1);
  assert.equal((await call("GET", "/api/reports?from=2026-02-10&to=2026-01-01")).status, 400);

  // CSV (client named in the address, as a download link does).
  const csv = await fetch(base + "/api/reports.csv?tz=0&customerId=" + A.id, { headers: { cookie } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get("content-disposition"), /proof-of-play/);
  const lines = (await csv.text()).trim().split("\r\n");
  assert.equal(lines.length, 4);
  assert.match(lines[1], /Croissant,image,Main,android-report-a001,Report Bakery$/);
});

test("white label: public branding, staff admins only, logo types", async () => {
  cookie = ""; scopeId = null;
  const pub = await call("GET", "/api/branding");
  assert.equal(pub.status, 200);
  assert.equal(pub.body.name, "Signage");
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  assert.equal((await call("PUT", "/api/branding", { name: "", color: "#ff0000" })).status, 400);
  assert.equal((await call("PUT", "/api/branding", { name: "Premier Screens", color: "red" })).status, 400);
  const saved = (await call("PUT", "/api/branding", { name: "Premier Screens", color: "#1A72B4" })).body;
  assert.deepEqual([saved.name, saved.color], ["Premier Screens", "#1a72b4"]);
  // Logo: PNG accepted, SVG refused (could carry scripts).
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  assert.equal((await call("POST", "/api/branding/logo", Buffer.from("<svg onload=alert(1)>"), { "content-type": "image/svg+xml" })).status, 400);
  const up = await call("POST", "/api/branding/logo", png, { "content-type": "image/png" });
  assert.equal(up.status, 201);
  assert.match(up.body.logo, /^\/branding\/logo\?v=/);
  const logo = await fetch(base + "/branding/logo");
  assert.equal(logo.headers.get("content-type"), "image/png");
  // A client's admin can't change the portal's branding.
  const C = (await call("POST", "/api/customers", { name: "Brand Client" })).body;
  scopeId = C.id;
  await call("POST", "/api/users", { email: "boss@brandclient.test", password: "client-pass-1", role: "admin" });
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "boss@brandclient.test", password: "client-pass-1" });
  assert.equal((await call("PUT", "/api/branding", { name: "Hacked", color: "#000000" })).status, 403);
  assert.equal((await call("DELETE", "/api/branding/logo")).status, 403);
  cookie = "";
  assert.equal((await call("GET", "/api/branding")).body.name, "Premier Screens");
});
