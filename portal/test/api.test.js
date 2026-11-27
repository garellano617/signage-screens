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

test("automatic builds upload the player app; players are told its fingerprint", async () => {
  const crypto = require("node:crypto");
  const body = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), crypto.randomBytes(4000)]);
  const post = headers => fetch(base + "/api/player-app", { method: "POST", headers: { "content-type": "application/octet-stream", ...headers }, body });
  // Off until PLAYER_UPLOAD_KEY is set; then the key must match.
  assert.equal((await post({ "x-upload-key": "x".repeat(40) })).status, 404);
  process.env.PLAYER_UPLOAD_KEY = "k".repeat(40);
  try {
    assert.equal((await post({ "x-upload-key": "x".repeat(40) })).status, 401);
    assert.equal((await post({})).status, 401);
    const ok = await post({ "x-upload-key": "k".repeat(40), "x-file-name": "signage-player-1.2.0-release.apk" });
    assert.equal(ok.status, 201);
    const sha = crypto.createHash("sha256").update(body).digest("hex");
    assert.equal((await ok.json()).sha256, sha);
    assert.equal((await call("GET", "/api/apk")).body.file, "signage-player-1.2.0-release.apk");
    // A player's heartbeat says which app to have.
    const reg = (await call("POST", "/api/player/register", { deviceId: "android-update-0001" })).body;
    const hb = (await call("POST", "/api/player/heartbeat", { update: "Up to date" }, { authorization: "Bearer " + reg.token })).body;
    assert.deepEqual(hb.app, { sha256: sha, size: body.length, url: "/download/player.apk" });
  } finally {
    delete process.env.PLAYER_UPLOAD_KEY;
  }
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

  // Text & pictures: placed by hand, fonts, timing within a cycle, pictures from this client only.
  const put2 = await call("PUT", "/api/screens/" + scr.id + "/layers", Object.assign({}, L, { text: Object.assign({}, L.text, { cycle: 20, blocks: [
    { kind: "text", text: "Picanha  $11.99", x: 12.34, y: 150, fs: 99, font: "comic", align: "right", italic: true, from: 5, to: 12 },
    { kind: "image", mediaId: imgA.id, x: 60, y: 10, w: 25, from: 15, to: 3 },
    { kind: "image", mediaId: imgB.id, x: 1, y: 1 },
    { kind: "image" }
  ] }) }));
  assert.equal(put2.status, 200, JSON.stringify(put2.body));
  const [tb, ib] = put2.body.text.blocks;
  assert.equal(put2.body.text.blocks.length, 2, "another client's picture and an empty picture are dropped");
  assert.equal(put2.body.text.cycle, 20);
  assert.deepEqual([tb.x, tb.y, tb.fs, tb.font, tb.align, tb.italic, tb.from, tb.to], [12.3, 150, 30, "sans", "right", true, 5, 12]); // may hang off the screen (up to 200)
  assert.deepEqual([ib.kind, ib.w, ib.from, ib.to, ib.image.src], ["image", 25, 0, 0, imgA.src], "end before start -> whole cycle");
  const cfg2 = (await call("GET", "/api/player/config", undefined, auth)).body;
  assert.equal(cfg2.layers.text.blocks[1].image.sha256, imgA.sha256, "the player can cache the picture");

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
  assert.deepEqual(after.text.blocks.map(b => b.kind), ["text"], "a picture block whose picture was deleted is dropped");
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

test("billing: reads the billing app, links clients, client logins see only their own summary", async () => {
  const http = require("node:http");
  const billingLink = require("../src/billingLink");
  const KEY = "b".repeat(40);
  const fake = http.createServer((req, res) => {
    if (req.headers.authorization !== "Bearer " + KEY) { res.writeHead(401); return res.end("{}"); }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ clients: [
      { id: "wendy", name: "Billing Taco", status: "active", screens: 2, plan: "Plus", monthly: 110, billingDay: 1, payMethod: "ach", autopay: true, subscription: "active",
        thisMonth: { month: "2026-11", amount: 110, paid: 0, balance: 110, status: "overdue", due: "2026-11-01" }, overdue: { invoices: 1, balance: 110, oldestDue: "2026-11-01" }, lastPayment: { date: "2026-10-01", amount: 110 } },
      { id: "other", name: "Somebody Else", status: "active", screens: 1, plan: "Basic", monthly: 35 }
    ] }));
  });
  await new Promise(r => fake.listen(0, r));
  t_after: {
    cookie = ""; scopeId = null;
    await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });

    // Not set up yet.
    delete process.env.BILLING_URL; delete process.env.BILLING_KEY; billingLink.resetCache();
    assert.equal((await call("GET", "/api/billing")).body.configured, false);

    // Wrong key -> clear message.
    process.env.BILLING_URL = "http://127.0.0.1:" + fake.address().port; process.env.BILLING_KEY = "wrong"; billingLink.resetCache();
    const bad = (await call("GET", "/api/billing")).body;
    assert.equal(bad.ok, false);
    assert.match(bad.error, /refused the key/);

    process.env.BILLING_KEY = KEY; billingLink.resetCache();
    const C = (await call("POST", "/api/customers", { name: "Billing Taco" })).body;
    let all = (await call("GET", "/api/billing")).body;
    let row = all.rows.find(r => r.customerId === C.id);
    assert.equal(row.linked, false);
    assert.deepEqual(row.suggest, { id: "wendy", name: "Billing Taco" }, "same name is suggested");

    assert.equal((await call("PUT", "/api/customers/" + C.id + "/billing-link", { billingClientId: "wendy" })).body.billingClientId, "wendy");
    all = (await call("GET", "/api/billing")).body;
    row = all.rows.find(r => r.customerId === C.id);
    assert.equal(row.billing.thisMonth.status, "overdue");
    assert.ok(all.unlinked.some(u => u.id === "other"));
    assert.ok(!all.unlinked.some(u => u.id === "wendy"));

    // The client's own login: just their summary, no link to the billing app, no other clients.
    scopeId = C.id;
    await call("POST", "/api/users", { email: "owner@billingtaco.test", password: "taco-pass-12", role: "admin" });
    cookie = ""; scopeId = null;
    await call("POST", "/api/auth/login", { email: "owner@billingtaco.test", password: "taco-pass-12" });
    const mine = (await call("GET", "/api/billing")).body;
    assert.equal(mine.rows.length, 1);
    assert.equal(mine.rows[0].billing.monthly, 110);
    assert.equal(mine.billingUrl, null);
    assert.equal(mine.unlinked, undefined);
    assert.equal(mine.rows[0].billing.subscription, undefined);
    assert.equal((await call("PUT", "/api/customers/" + C.id + "/billing-link", { billingClientId: "other" })).status, 403);
  }
  fake.close();
  delete process.env.BILLING_URL; delete process.env.BILLING_KEY; billingLink.resetCache();
});

test("screens set up before the TV is connected, then paired into", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const P = (await call("POST", "/api/customers", { name: "Planned Diner", screenLimit: 2 })).body;
  const O = (await call("POST", "/api/customers", { name: "Elsewhere Inc" })).body;
  scopeId = O.id;
  const otherPlanned = (await call("POST", "/api/screens/plan", { name: "Not yours" })).body;
  scopeId = P.id;
  const pl = (await call("POST", "/api/playlists", { name: "Diner menu" })).body;

  assert.equal((await call("POST", "/api/screens/plan", { name: "" })).status, 400, "needs a name");
  const plan = await call("POST", "/api/screens/plan", { name: "Front counter", location: "Main St", playlistId: pl.id });
  assert.equal(plan.status, 201, JSON.stringify(plan.body));
  assert.equal(plan.body.planned, true);
  assert.equal(plan.body.online, false);
  const sid = plan.body.id;

  // Design it and give it a schedule before any TV exists.
  const L = (await call("GET", "/api/screens/" + sid + "/layers")).body;
  L.text.enabled = true; L.text.blocks = [{ text: "Grand opening", position: "top" }];
  assert.equal((await call("PUT", "/api/screens/" + sid + "/layers", L)).status, 200);
  assert.equal((await call("PUT", "/api/screens/" + sid + "/schedules", [{ playlistId: pl.id, days: 127, start: "06:00", end: "11:00" }])).status, 200);
  assert.equal((await call("POST", "/api/screens/" + sid + "/commands", { type: "reload" })).status, 400, "no TV to command");
  const dash = (await call("GET", "/api/dashboard")).body;
  assert.equal(dash.offline.length, 0, "a planned screen isn't 'offline'");
  assert.deepEqual(dash.planned.map(s => s.id), [sid]);
  assert.ok(!(await call("GET", "/api/monitoring")).body.some(s => s.id === sid), "not in monitoring");

  // The TV arrives and shows a code. Pairing into another client's planned screen is refused.
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-planned-0001", model: "Counter TV" })).body;
  const auth = { authorization: "Bearer " + reg.token };
  assert.equal((await call("POST", "/api/screens/pair", { code: reg.pairingCode, screenId: otherPlanned.id })).status, 404);
  const pr = await call("POST", "/api/screens/pair", { code: reg.pairingCode, screenId: sid });
  assert.equal(pr.status, 201, JSON.stringify(pr.body));
  assert.equal(pr.body.id, sid);
  assert.equal(pr.body.planned, false);
  assert.equal(pr.body.name, "Front counter");
  assert.equal(pr.body.model, "Counter TV");

  // The TV now plays what was prepared, with the token it already had.
  const cfg = (await call("GET", "/api/player/config", undefined, auth)).body;
  assert.equal(cfg.paired, true);
  assert.equal(cfg.screen.name, "Front counter");
  assert.equal(cfg.layers.text.blocks[0].text, "Grand opening");
  assert.equal(cfg.schedules.length, 1);
  const hb = (await call("POST", "/api/player/heartbeat", { playing: "" }, auth)).body;
  assert.equal(hb.paired, true);
  // Restarting the app (re-register) keeps it on the same screen.
  assert.equal((await call("POST", "/api/player/register", { deviceId: "android-planned-0001" })).body.paired, true);
  assert.equal((await call("GET", "/api/screens")).body.filter(s => s.id === sid).length, 1);

  // Replacing the TV: the new one takes over, the old one goes back to a pairing code.
  const reg2 = (await call("POST", "/api/player/register", { deviceId: "android-planned-0002", model: "New TV" })).body;
  assert.equal((await call("POST", "/api/screens/pair", { code: reg2.pairingCode, screenId: sid })).body.model, "New TV");
  const old = (await call("POST", "/api/player/register", { deviceId: "android-planned-0001" })).body;
  assert.equal(old.paired, false);
  assert.match(old.pairingCode, /^[A-HJ-NP-Z2-9]{6}$/);

  // Planned screens count toward the screen limit (2): one used, one more planned is fine, a third is not.
  assert.equal((await call("POST", "/api/screens/plan", { name: "Patio" })).status, 201);
  assert.match((await call("POST", "/api/screens/plan", { name: "Bar" })).body.error, /2 of 2/);
  assert.match((await call("POST", "/api/screens/pair", { code: old.pairingCode })).body.error, /2 of 2/);
});

test("layout templates and the AI designer (fake AI client, no paid calls)", async () => {
  const ai = require("../src/ai");
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const C = (await call("POST", "/api/customers", { name: "AI Taqueria" })).body;
  const O = (await call("POST", "/api/customers", { name: "AI Other" })).body;
  const png = Buffer.from("89504e470d0a1a0a", "hex");
  const up = async cid => { scopeId = cid; const fd = new FormData(); fd.append("files", new Blob([png], { type: "image/png" }), "logo.png"); return (await call("POST", "/api/media", fd)).body[0]; };
  const otherImg = await up(O.id), logo = await up(C.id);
  scopeId = C.id;

  // Templates: a good set, each already a clean design.
  const tpl = (await call("GET", "/api/layer-templates")).body;
  assert.ok(tpl.length >= 10);
  for (const t of tpl) {
    assert.ok(t.id && t.name && t.category && t.description);
    assert.ok(t.layers.specials.enabled || t.layers.text.enabled, t.id + " has content");
    assert.deepEqual(Object.keys(t.layers), ["video", "specials", "text", "effects"]);
  }
  assert.equal(new Set(tpl.map(t => t.id)).size, tpl.length);

  // Off without a key.
  ai.setClient(null); delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await call("GET", "/api/ai/status")).body.enabled, false);
  assert.equal((await call("POST", "/api/ai/design", { prompt: "Taco Tuesday" })).status, 503);

  // A fake Claude that answers with a design using one good and one foreign picture.
  let sent = null, answer = null;
  ai.setClient({ beta: { messages: { parse: async p => { sent = p; return answer; } } } });
  const block = (o = {}) => Object.assign({ kind: "text", text: "TACO TUESDAY", mediaId: null, position: "top", fs: 7, w: 0, font: "condensed", align: "center",
    bold: true, italic: false, color: "#ffffff", bg: "#dc2626", bgOpacity: 90, from: 0, to: 0 }, o);
  const design = {
    summary: "A bold Taco Tuesday screen.",
    video: { enabled: true, region: "left70" },
    specials: { enabled: true, heading: "Specials", position: "right", seconds: 8, accent: "#f59e0b", bg: "#111827", color: "#ffffff",
      items: [{ title: "3 tacos + drink", price: "$7.99", description: "", mediaId: null }] },
    text: { enabled: true, cycle: 0, blocks: [block(), block({ kind: "image", text: "", mediaId: logo.id, position: "top-left", w: 15 }),
      block({ kind: "image", text: "", mediaId: otherImg.id, position: "bottom-left", w: 15 })],
      ticker: { enabled: true, text: "Every Tuesday", position: "bottom", speed: "normal", size: "m", color: "#ffffff", bg: "#111827" } },
    effects: { enabled: true, type: "confetti", intensity: "light", color: "#ffffff" }
  };
  answer = { stop_reason: "end_turn", parsed_output: design };
  process.env.AI_DAILY_LIMIT = "3";
  assert.equal((await call("POST", "/api/ai/design", { prompt: "" })).status, 400);
  let r = await call("POST", "/api/ai/design", { prompt: "Taco Tuesday: 3 tacos + drink $7.99" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(sent.model, "claude-opus-5-5");
  assert.equal(sent.fallbacks, "default");
  assert.ok(sent.output_config.format, "structured output");
  assert.match(sent.messages[0].content, /AI Taqueria/);
  assert.match(sent.messages[0].content, new RegExp("mediaId " + logo.id + ": logo"));
  assert.doesNotMatch(sent.messages[0].content, new RegExp("mediaId " + otherImg.id + ":"), "only this client's pictures are offered");
  assert.equal(r.body.summary, "A bold Taco Tuesday screen.");
  assert.equal(r.body.layers.video.region, "left70");
  assert.deepEqual(r.body.layers.text.blocks.map(b => b.kind), ["text", "image"], "another client's picture is dropped");
  assert.equal(r.body.layers.text.blocks[1].image.mediaId, logo.id);
  assert.equal(r.body.left, 2);

  // Content mode keeps the layout and takes only the words.
  const current = r.body.layers;
  current.text.blocks[0].position = "bottom-right"; current.text.blocks[0].x = 10; current.text.blocks[0].y = 20;
  answer = { stop_reason: "end_turn", parsed_output: { ...design, video: { enabled: true, region: "full" },
    specials: { ...design.specials, heading: "Hoy", items: [{ title: "Tres tacos", price: "$7.99", description: "con bebida", mediaId: null }] },
    text: { ...design.text, blocks: [block({ text: "MARTES DE TACOS", position: "center", fs: 3 })], ticker: { ...design.text.ticker, text: "Cada martes" } } } };
  r = await call("POST", "/api/ai/design", { prompt: "in Spanish", mode: "content", current });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(sent.messages[0].content, /Rewrite only the words/);
  const b0 = r.body.layers.text.blocks[0];
  assert.equal(b0.text, "MARTES DE TACOS");
  assert.deepEqual([b0.position, b0.x, b0.y, b0.fs], ["bottom-right", 10, 20, 7], "layout kept");
  assert.equal(r.body.layers.video.region, "left70", "video area kept");
  assert.equal(r.body.layers.text.blocks.length, 2, "picture kept");
  assert.equal(r.body.layers.specials.items[0].title, "Tres tacos");
  assert.equal(r.body.layers.text.ticker.text, "Cada martes");

  // A refusal is reported, and the daily limit holds.
  answer = { stop_reason: "refusal", parsed_output: null };
  assert.equal((await call("POST", "/api/ai/design", { prompt: "x" })).status, 422);
  const over = await call("POST", "/api/ai/design", { prompt: "x" });
  assert.equal(over.status, 429);
  assert.match(over.body.error, /all 3 AI requests/);
  scopeId = O.id;
  assert.equal((await call("GET", "/api/ai/status")).body.left, 3, "limits are per client");
  ai.setClient(null); delete process.env.AI_DAILY_LIMIT;
});

test("AI help: answers from the guide, keeps the chat, daily limit per login", async () => {
  const ai = require("../src/ai");
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  ai.setClient(null); delete process.env.ANTHROPIC_API_KEY;
  assert.equal((await call("GET", "/api/ai/help")).body.enabled, false);
  assert.equal((await call("POST", "/api/ai/help", { question: "How do I pair a TV?" })).status, 503);
  let sent = null;
  ai.setClient({ beta: { messages: { create: async p => { sent = p; return { stop_reason: "end_turn", content: [{ type: "text", text: "1. Go to **Screens → Add screen**." }] }; } } } });
  process.env.AI_HELP_DAILY_LIMIT = "4";
  assert.equal((await call("POST", "/api/ai/help", { question: "  " })).status, 400);
  const r = await call("POST", "/api/ai/help", { question: "How do I pair a TV?", page: "Screens · /screens",
    history: [{ role: "assistant", content: "skipped: must start with the user" }, { role: "user", content: "Hi" }, { role: "assistant", content: "Hello!" }, { role: "user", content: "unanswered, dropped" }] });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.match(r.body.answer, /Add screen/);
  assert.equal(r.body.left, 3);
  assert.match(sent.system[0].text, /Video walls/, "the guide is in the system prompt");
  assert.deepEqual(sent.system[0].cache_control, { type: "ephemeral" });
  assert.deepEqual(sent.messages.map(m => m.role), ["user", "assistant", "user"]);
  assert.match(sent.messages[2].content[0].text, /Screens · \/screens/);
  assert.match(sent.messages[2].content[0].text, /staff/);
  // A picture the person attached goes to the AI with the question.
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
  assert.equal((await call("POST", "/api/ai/help", { question: "What's this?", image: "data:text/html;base64,PGI+" })).status, 400);
  assert.equal((await call("POST", "/api/ai/help", { question: "What's this?", image: "data:image/png;base64," + png.toString("base64") })).status, 200);
  let last = sent.messages[sent.messages.length - 1].content;
  assert.equal(last[0].type, "image"); assert.equal(last[0].source.media_type, "image/png");
  assert.match(last[1].text, /Attached: a screenshot or photo/);
  // The TV's latest screenshot, for a screen the login can see.
  const C = (await call("POST", "/api/customers", { name: "Help Shop" })).body;
  scopeId = C.id;
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-help-0001" })).body;
  const scr = (await call("POST", "/api/screens/pair", { code: reg.pairingCode, name: "Front TV" })).body;
  await call("POST", "/api/ai/help", { question: "What's on it?", screenId: scr.id });
  last = sent.messages[sent.messages.length - 1].content;
  assert.equal(last.length, 1); assert.match(last[0].text, /no screenshot yet/);
  assert.equal((await call("POST", "/api/player/screenshot", png, { authorization: "Bearer " + reg.token, "content-type": "image/png" })).status, 200);
  await call("POST", "/api/ai/help", { question: "What's on it?", screenId: scr.id });
  last = sent.messages[sent.messages.length - 1].content;
  assert.equal(last[0].source.data, png.toString("base64"));
  assert.match(last[1].text, /latest screenshot from the TV "Front TV"/);
  assert.equal((await call("POST", "/api/ai/help", { question: "Over the limit" })).status, 429);
  scopeId = null;
  ai.setClient(null); delete process.env.AI_HELP_DAILY_LIMIT;
});

test("video walls: tiles, cropped config per screen, sound from the first screen, per client", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const A = (await call("POST", "/api/customers", { name: "Wall Shop" })).body;
  const B = (await call("POST", "/api/customers", { name: "Wall Other" })).body;
  scopeId = A.id;
  const own = (await call("POST", "/api/playlists", { name: "Own" })).body;
  const big = (await call("POST", "/api/playlists", { name: "Big picture" })).body;
  const pair = async dev => {
    const reg = (await call("POST", "/api/player/register", { deviceId: dev })).body;
    const s = (await call("POST", "/api/screens/pair", { code: reg.pairingCode, playlistId: own.id })).body;
    return { s, auth: { authorization: "Bearer " + reg.token } };
  };
  const left = await pair("android-wall-0001"), right = await pair("android-wall-0002"), extra = await pair("android-wall-0003");

  assert.equal((await call("POST", "/api/walls", { name: "" })).status, 400);
  const w = (await call("POST", "/api/walls", { name: "Window", cols: 2, rows: 1, playlistId: big.id, bezel: 0.8 })).body;
  assert.deepEqual([w.cols, w.rows, w.bezel, w.fit, w.playlistName], [2, 1, 0.8, "fill", "Big picture"]);

  // Bad placements are refused.
  const put = tiles => call("PUT", "/api/walls/" + w.id + "/screens", { tiles });
  assert.equal((await put([{ screenId: left.s.id, col: 2, row: 0 }])).status, 400, "outside the grid");
  assert.equal((await put([{ screenId: left.s.id, col: 0, row: 0 }, { screenId: right.s.id, col: 0, row: 0 }])).status, 400, "same spot");
  assert.equal((await put([{ screenId: left.s.id, col: 0, row: 0 }, { screenId: left.s.id, col: 1, row: 0 }])).status, 400, "screen twice");
  const placed = (await put([{ screenId: left.s.id, col: 0, row: 0 }, { screenId: right.s.id, col: 1, row: 0 }])).body;
  assert.equal(placed.tiles.length, 2);

  // Each screen gets the wall's playlist and its own tile; only the first one has sound; no schedule or layers.
  await call("PATCH", "/api/screens/" + right.s.id, { volume: 80 });
  const lc = (await call("GET", "/api/player/config", undefined, left.auth)).body;
  const rc = (await call("GET", "/api/player/config", undefined, right.auth)).body;
  assert.equal(lc.defaultPlaylist.name, "Big picture");
  assert.deepEqual(lc.wall, { id: w.id, cols: 2, rows: 1, col: 0, row: 0, bezel: 0.8, fit: "fill" });
  assert.deepEqual([rc.wall.col, rc.wall.row, rc.screen.volume], [1, 0, 0]);
  assert.equal(lc.screen.volume, 100);
  assert.deepEqual(rc.schedules, []);
  assert.equal(rc.layers.text.enabled, false);
  // The heartbeat carries the portal's clock, so the screens can play in step.
  const hb = (await call("POST", "/api/player/heartbeat", {}, left.auth)).body;
  assert.ok(Math.abs(hb.serverTime - Date.now()) < 5000);
  // The screen page says which wall it's in.
  const sp = (await call("GET", "/api/screens/" + left.s.id)).body;
  assert.deepEqual([sp.wallName, sp.wallCol, sp.wallRow], ["Window", 0, 0]);

  // Making the grid smaller lets go of screens that no longer fit; they go back to their own playlist.
  const small = (await call("PATCH", "/api/walls/" + w.id, { cols: 1 })).body;
  assert.deepEqual(small.tiles.map(t => t.screenId), [left.s.id]);
  const rc2 = (await call("GET", "/api/player/config", undefined, right.auth)).body;
  assert.equal(rc2.wall, undefined);
  assert.equal(rc2.defaultPlaylist.name, "Own");
  // Moving a screen to another wall takes it out of the first.
  const w2 = (await call("POST", "/api/walls", { name: "Counter", cols: 2, rows: 2 })).body;
  await call("PUT", "/api/walls/" + w2.id + "/screens", { tiles: [{ screenId: left.s.id, col: 1, row: 1 }, { screenId: extra.s.id, col: 0, row: 0 }] });
  assert.equal((await call("GET", "/api/walls/" + w.id)).body.tiles.length, 0);

  // Another client can't see or use it.
  scopeId = B.id;
  assert.equal((await call("GET", "/api/walls/" + w2.id)).status, 404);
  assert.equal((await call("GET", "/api/walls")).body.length, 0);
  scopeId = A.id;
  // Deleting a wall frees its screens.
  await call("DELETE", "/api/walls/" + w2.id);
  assert.equal((await call("GET", "/api/player/config", undefined, extra.auth)).body.wall, undefined);
  scopeId = null;
});

test("text and pictures: timeline rows and entrance/exit transitions are kept and cleaned", () => {
  const { sanitizeLayers } = require("../src/layers");
  const img = { kind: "image", mediaId: 5, w: 30 };
  const out = sanitizeLayers({ text: { enabled: true, cycle: 20, blocks: [
    { ...img, track: 2, from: 0, to: 6, enter: "small", exit: "left", td: 0.8 },
    { ...img, track: 2, from: 5, to: 11, enter: "warp", exit: "big", td: 99 },
    { kind: "text", text: "Old block" }
  ] } }, () => true).text.blocks;
  assert.deepEqual(out.map(b => [b.track, b.from, b.to, b.enter, b.exit, b.td]),
    [[2, 0, 6, "small", "left", 0.8], [2, 5, 11, "none", "big", 5], [2, 0, 0, "none", "none", 1]]);
  const fx = sanitizeLayers({ text: { enabled: true, blocks: [{ kind: "text", text: "OPEN", fx: "neon", fxColor: "#ec4899" }, { kind: "text", text: "x", fx: "lasers", fxColor: "red" }] } }, () => true).text.blocks;
  assert.deepEqual(fx.map(b => [b.fx, b.fxColor]), [["neon", "#ec4899"], ["none", "#facc15"]]);
  // Locked groups on the timeline.
  const g = sanitizeLayers({ text: { enabled: true, blocks: [{ kind: "text", text: "a", grp: 3 }, { kind: "text", text: "b", grp: "x" }, { kind: "text", text: "c", grp: 5000 }] } }, () => true).text.blocks;
  assert.deepEqual(g.map(b => b.grp), [3, 0, 999]);
  // Over / under the Specials panel.
  const st = sanitizeLayers({ text: { enabled: true, blocks: [{ kind: "text", text: "a", above: true }, { kind: "text", text: "b" }, { kind: "text", text: "c", above: "yes" }] } }, () => true).text.blocks;
  assert.deepEqual(st.map(b => b.above), [true, false, true]);
  // Spacing: whole text, parts (letter spacing) and lines (line spacing), cleaned.
  const sp = sanitizeLayers({ text: { enabled: true, blocks: [{ kind: "text", text: "Feliz Navidad\na todos", ls: 9, lh: 0.1,
    runs: [{ s: 6, e: 13, ls: 0.4 }, { s: 5, e: 2, ls: 1 }, "x"], llh: [null, 1.6, "abc", 99] }] } }, () => true).text.blocks[0];
  assert.equal(sp.ls, 2);
  assert.equal(sp.lh, 0.5);
  assert.deepEqual(sp.runs, [{ s: 6, e: 13, ls: 0.4 }]);
  assert.deepEqual(sp.llh, [null, 1.6, null, 4]);
  // Thickness: whole text 100-900 (0 = bold / normal) and parts.
  const wt = sanitizeLayers({ text: { enabled: true, blocks: [{ kind: "text", text: "CARNE BEEF", wt: 2000, wruns: [{ s: 6, e: 10, wt: 850 }, { s: 1, e: 1, wt: 300 }] }, { kind: "text", text: "x", wt: "abc" }] } }, () => true).text.blocks;
  assert.equal(wt[0].wt, 900);
  assert.deepEqual(wt[0].wruns, [{ s: 6, e: 10, wt: 850 }]);
  assert.equal(wt[1].wt, 0);
  // Vector shapes: kept without text; shape name, colours, see-through and border cleaned.
  const sh = sanitizeLayers({ text: { enabled: true, blocks: [{ kind: "shape", shape: "wave", w: 100, h: 18, fill: "#2563eb", fillOpacity: 40, stroke: "#facc15", sw: 1.5 },
    { kind: "shape", shape: "blob", fill: "red", sw: 99, fillOpacity: 300 }] } }, () => true).text.blocks;
  assert.equal(sh.length, 2);
  assert.deepEqual([sh[0].shape, sh[0].w, sh[0].h, sh[0].fill, sh[0].fillOpacity, sh[0].stroke, sh[0].sw, sh[0].bgOpacity], ["wave", 100, 18, "#2563eb", 40, "#facc15", 1.5, 0]);
  assert.deepEqual([sh[1].shape, sh[1].fill, sh[1].sw, sh[1].fillOpacity], ["square", "#dc2626", 10, 100]);
  // Turned any angle (kept between -180 and 180), bigger than the screen, partly off it.
  const big = sanitizeLayers({ text: { enabled: true, blocks: [{ kind: "shape", shape: "wave", rot: 270, w: 350, h: 500, x: -120, y: 150 },
    { kind: "shape", shape: "circle", rot: -45.25 }, { kind: "image", mediaId: 1, w: 350, x: -999, y: 0 }] } }, () => true).text.blocks;
  assert.deepEqual([big[0].rot, big[0].w, big[0].h, big[0].x, big[0].y], [-90, 350, 400, -120, 150]);
  assert.equal(big[1].rot, -45.2);
  assert.deepEqual([big[2].w, big[2].x], [100, -300], "pictures stay at most the screen's width");
});

test("player app crashes are reported, even before pairing, and listed for admins", async () => {
  cookie = ""; scopeId = null;
  const bad = await call("POST", "/api/player/crash", { deviceId: "x" });
  assert.equal(bad.status, 400);
  const ok = await call("POST", "/api/player/crash", { deviceId: "android-crash-0001", appVersion: "1.2.9", android: "9 (SDK 28)", model: "Amazon AFTMM",
    error: "java.lang.NoSuchMethodError: boom", trace: "at com.signage.player.MainActivity.onCreate", stopped: true });
  assert.equal(ok.status, 200);
  assert.equal((await call("GET", "/api/app-crashes")).status, 401);
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const list = (await call("GET", "/api/app-crashes")).body;
  assert.equal(list[0].model, "Amazon AFTMM");
  assert.equal(list[0].stopped, true);
  assert.equal(list[0].screenName, null);
  // Too many from one device are refused.
  let last;
  for (let i = 0; i < 12; i++) last = await call("POST", "/api/player/crash", { deviceId: "android-crash-0002", error: "x" });
  assert.equal(last.status, 429);
});

test("designs saved as templates: per client with pictures, or shared without", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
  const A = (await call("POST", "/api/customers", { name: "Tpl Shop A" })).body, B = (await call("POST", "/api/customers", { name: "Tpl Shop B" })).body;
  scopeId = A.id;
  const fd = new FormData(); fd.append("files", new Blob([png], { type: "image/png" }), "A logo.png");
  const logo = (await call("POST", "/api/media", fd)).body[0];
  const layers = { text: { enabled: true, cycle: 0, blocks: [{ kind: "text", text: "Lunch", fx: "neon" }, { kind: "image", mediaId: logo.id, w: 20 }] }, effects: { enabled: true, type: "plane", mediaId: logo.id } };
  assert.equal((await call("POST", "/api/layer-templates", { name: "", layers })).status, 400);
  const mine = await call("POST", "/api/layer-templates", { name: "Lunch board", description: "Weekdays", layers });
  assert.equal(mine.status, 201);
  assert.equal(mine.body.category, "My templates");
  assert.equal(mine.body.layers.text.blocks[1].image.name, "A logo");
  const shared = (await call("POST", "/api/layer-templates", { name: "Shared lunch", shared: true, layers })).body;
  assert.equal(shared.category, "Shared templates");
  assert.equal(shared.layers.text.blocks.length, 1, "pictures left out");
  assert.equal(shared.layers.effects.mediaId, null);
  let list = (await call("GET", "/api/layer-templates")).body;
  assert.deepEqual(list.slice(0, 2).map(t => t.name).sort(), ["Lunch board", "Shared lunch"]);
  assert.ok(list.length > 10, "ready-made templates still there");
  // Client B sees the shared one but not A's.
  scopeId = B.id;
  list = (await call("GET", "/api/layer-templates")).body;
  assert.ok(list.some(t => t.name === "Shared lunch"));
  assert.ok(!list.some(t => t.name === "Lunch board"));
  // A client login can't remove another client's template, only its own.
  const pw = "client-pass-123";
  const u = await call("POST", "/api/users", { email: "tplb@test.local", password: pw, role: "admin", customerId: B.id });
  assert.ok(u.status < 300, JSON.stringify(u.body));
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "tplb@test.local", password: pw });
  assert.equal((await call("DELETE", "/api/layer-templates/" + mine.body.savedId)).status, 404);
  const own = (await call("POST", "/api/layer-templates", { name: "B board", layers: { text: { enabled: true, blocks: [{ kind: "text", text: "Hi" }] } } })).body;
  assert.equal(own.canDelete, true);
  assert.equal((await call("GET", "/api/layer-templates")).body.find(t => t.name === "Shared lunch").canDelete, false);
  assert.equal((await call("DELETE", "/api/layer-templates/" + own.savedId)).status, 200);
  cookie = ""; scopeId = null;
});

test("wall effects: saved, cleaned, sent to each screen with its part of the wall", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const A = (await call("POST", "/api/customers", { name: "Santa Shop" })).body;
  scopeId = A.id;
  const pair = async dev => {
    const reg = (await call("POST", "/api/player/register", { deviceId: dev })).body;
    const s = (await call("POST", "/api/screens/pair", { code: reg.pairingCode })).body;
    return { s, auth: { authorization: "Bearer " + reg.token } };
  };
  const a = await pair("android-wallfx-0001"), b = await pair("android-wallfx-0002");
  const w = (await call("POST", "/api/walls", { name: "Xmas", cols: 2, rows: 1, bezel: 1.5 })).body;
  assert.equal(w.effects.enabled, false);
  await call("PUT", "/api/walls/" + w.id + "/screens", { tiles: [{ screenId: a.s.id, col: 0, row: 0 }, { screenId: b.s.id, col: 1, row: 0 }] });
  // Unknown values are cleaned: bad type -> default, "every" kept within 10..300 seconds.
  const saved = (await call("PATCH", "/api/walls/" + w.id, { effects: { enabled: true, type: "santa", every: 5, snow: false, intensity: "loud" } })).body;
  assert.deepEqual(saved.effects, { enabled: true, type: "santa", intensity: "medium", color: "#ffffff", every: 10, snow: false, banner: "", mediaId: null, bannerBg: "#ffffff", bannerColor: "#b91c1c", image: null });
  const cb = (await call("GET", "/api/player/config", undefined, b.auth)).body;
  assert.equal(cb.layers.effects.type, "santa");
  assert.deepEqual(cb.layers.view, { cols: 2, rows: 1, col: 1, row: 0, gap: 0.015 });
  assert.equal(cb.layers.text.enabled, false);
  // Changing other settings keeps the effects.
  await call("PATCH", "/api/walls/" + w.id, { name: "Christmas" });
  assert.equal((await call("GET", "/api/walls/" + w.id)).body.effects.type, "santa");
  assert.equal((await call("PATCH", "/api/walls/" + w.id, { effects: { enabled: true, type: "nonsense" } })).body.effects.type, "snow");
  // Single screens can use the new scene effects too.
  await call("PUT", "/api/walls/" + w.id + "/screens", { tiles: [] });
  await call("PUT", "/api/screens/" + a.s.id + "/layers", { effects: { enabled: true, type: "fireworks" } });
  const ca = (await call("GET", "/api/player/config", undefined, a.auth)).body;
  assert.equal(ca.layers.effects.type, "fireworks");
  assert.equal(ca.layers.view, undefined);
  scopeId = null;
});

test("plane effect: banner text and the client's own logo reach the screens", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
  const upload = async name => { const fd = new FormData(); fd.append("files", new Blob([png], { type: "image/png" }), name + ".png"); return (await call("POST", "/api/media", fd)).body[0]; };
  const other = (await call("POST", "/api/customers", { name: "Other Shop" })).body;
  scopeId = other.id;
  const foreign = await upload("Not yours");
  const A = (await call("POST", "/api/customers", { name: "Plane Shop" })).body;
  scopeId = A.id;
  const logo = await upload("Logo");
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-plane-0001" })).body;
  const s = (await call("POST", "/api/screens/pair", { code: reg.pairingCode })).body;
  const auth = { authorization: "Bearer " + reg.token };
  // Single screen: banner text is trimmed to 60 characters, the logo is attached for preview and caching.
  await call("PUT", "/api/screens/" + s.id + "/layers", { effects: { enabled: true, type: "plane", banner: "x".repeat(80), mediaId: logo.id, bannerBg: "#000000", bannerColor: "#ffff00" } });
  let ef = (await call("GET", "/api/player/config", undefined, auth)).body.layers.effects;
  assert.equal(ef.type, "plane");
  assert.equal(ef.banner.length, 60);
  assert.equal(ef.bannerBg, "#000000");
  assert.equal(ef.image.sha256, logo.sha256);
  // Another client's picture is refused.
  await call("PUT", "/api/screens/" + s.id + "/layers", { effects: { enabled: true, type: "plane", banner: "Hi", mediaId: foreign.id } });
  ef = (await call("GET", "/api/player/config", undefined, auth)).body.layers.effects;
  assert.equal(ef.mediaId, null);
  assert.equal(ef.image, null);
  // Video wall: same banner, across the screens.
  const w = (await call("POST", "/api/walls", { name: "Front", cols: 1, rows: 1 })).body;
  await call("PUT", "/api/walls/" + w.id + "/screens", { tiles: [{ screenId: s.id, col: 0, row: 0 }] });
  assert.equal((await call("PATCH", "/api/walls/" + w.id, { effects: { enabled: true, type: "plane", banner: "Sale", mediaId: foreign.id } })).body.effects.mediaId, null);
  const saved = (await call("PATCH", "/api/walls/" + w.id, { effects: { enabled: true, type: "plane", banner: "Sale", mediaId: logo.id } })).body;
  assert.equal(saved.effects.image.name, "Logo");
  ef = (await call("GET", "/api/player/config", undefined, auth)).body.layers.effects;
  assert.equal(ef.banner, "Sale");
  assert.equal(ef.image.sha256, logo.sha256);
  // Deleting the picture drops it from the banner.
  await call("DELETE", "/api/media/" + logo.id);
  ef = (await call("GET", "/api/player/config", undefined, auth)).body.layers.effects;
  assert.equal(ef.image, null);
  scopeId = null;
});

test("design slides: a template as a playlist slide, with its pictures, editable in the designer", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
  const upload = async name => { const fd = new FormData(); fd.append("files", new Blob([png], { type: "image/png" }), name + ".png"); return (await call("POST", "/api/media", fd)).body[0]; };
  const other = (await call("POST", "/api/customers", { name: "Slide Other" })).body;
  scopeId = other.id;
  const foreign = await upload("Not yours");
  const A = (await call("POST", "/api/customers", { name: "Slide Shop" })).body;
  scopeId = A.id;
  const pic = await upload("Taco photo");
  // A template becomes a slide: video layer off, own pictures kept, other clients' pictures dropped.
  const r = await call("POST", "/api/media/widget", { type: "design", name: "Menu board", config: { bg: "#112233", layers: {
    video: { enabled: true, region: "right70" },
    text: { enabled: true, blocks: [{ kind: "text", text: "Tacos $3" }, { kind: "image", mediaId: pic.id }, { kind: "image", mediaId: foreign.id }] } } } });
  assert.equal(r.status, 201);
  const m = r.body;
  assert.equal(m.kind, "widget");
  assert.equal(m.widget.type, "design");
  assert.equal(m.widget.config.bg, "#112233");
  assert.equal(m.widget.config.layers.video.enabled, false);
  assert.deepEqual(m.widget.config.layers.text.blocks.map(b => b.kind), ["text", "image"]);
  assert.equal(m.widget.config.layers.text.blocks[1].image.name, "Taco photo");
  // In a playlist, the player gets the slide with its picture attached (to download it).
  const pl = (await call("POST", "/api/playlists", { name: "Slides" })).body;
  await call("PUT", "/api/playlists/" + pl.id, { name: "Slides", items: [{ mediaId: m.id, duration: 12 }] });
  const reg = (await call("POST", "/api/player/register", { deviceId: "android-slide-0001" })).body;
  await call("POST", "/api/screens/pair", { code: reg.pairingCode, playlistId: pl.id });
  const auth = { authorization: "Bearer " + reg.token };
  let item = (await call("GET", "/api/player/config", undefined, auth)).body.defaultPlaylist.items[0];
  assert.equal(item.kind, "widget");
  assert.equal(item.duration, 12);
  assert.equal(item.widget.type, "design");
  assert.equal(item.widget.config.layers.text.blocks[1].image.sha256, pic.sha256);
  // Edit in the designer: new words, new background.
  const s = (await call("GET", "/api/slides/" + m.id)).body;
  assert.equal(s.name, "Menu board");
  assert.equal(s.usedIn[0].name, "Slides");
  s.layers.text.blocks[0].text = "Tacos $4";
  s.layers.video.enabled = true;
  const saved = await call("PUT", "/api/slides/" + m.id + "/layers", { layers: s.layers, bg: "#000000" });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.video.enabled, false, "slides never have a video layer");
  item = (await call("GET", "/api/player/config", undefined, auth)).body.defaultPlaylist.items[0];
  assert.equal(item.widget.config.layers.text.blocks[0].text, "Tacos $4");
  assert.equal(item.widget.config.bg, "#000000");
  // Not a design slide → 404; another client's slide → 404.
  const clock = (await call("POST", "/api/media/widget", { type: "clock", config: {} })).body;
  assert.equal((await call("GET", "/api/slides/" + clock.id)).status, 404);
  scopeId = other.id;
  assert.equal((await call("GET", "/api/slides/" + m.id)).status, 404);
  scopeId = null;
});

test("media library categories: automatic from the file type, upload into a category, move between them", async () => {
  cookie = ""; scopeId = null;
  await call("POST", "/api/auth/login", { email: "admin@test.local", password: "admin-pass-123" });
  const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000" + "1f15c4890000000a49444154789c6300010000050001" + "0d0a2db40000000049454e44ae426082", "hex");
  const C = (await call("POST", "/api/customers", { name: "Category Shop" })).body;
  scopeId = C.id;
  const up = async (name, type, category) => {
    const fd = new FormData(); if (category) fd.append("category", category);
    fd.append("files", new Blob([png], { type }), name); return (await call("POST", "/api/media", fd)).body[0];
  };
  const p = await up("logo.png", "image/png");
  assert.equal(p.category, "png", "PNG files on their own");
  const j = await up("photo.jpg", "image/jpeg");
  assert.equal(j.category, "picture");
  const bg = await up("wall.jpg", "image/jpeg", "background");
  assert.equal(bg.category, "background", "uploaded from the Backgrounds tab");
  assert.equal((await up("x.png", "image/png", "nonsense")).category, "png", "unknown category → automatic");
  const web = (await call("POST", "/api/media/web", { url: "https://example.com/" })).body;
  assert.equal(web.category, "web");
  // Move: picture → shape, back to automatic, unknown refused.
  assert.equal((await call("PATCH", "/api/media/" + j.id, { category: "shape" })).body.category, "shape");
  assert.equal((await call("PATCH", "/api/media/" + j.id, { category: "auto" })).body.category, "picture");
  assert.equal((await call("PATCH", "/api/media/" + j.id, { category: "video" })).status, 400);
  const list = (await call("GET", "/api/media")).body;
  assert.deepEqual(list.map(m => m.category).sort(), ["background", "picture", "png", "png", "web"]);
  scopeId = null;
});
