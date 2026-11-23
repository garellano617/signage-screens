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
