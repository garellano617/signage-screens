"use strict";
const crypto = require("node:crypto");
const { all, get, now } = require("./db");
const { parseLayers, withImages } = require("./layers");

const imageMedia = id => get("SELECT id, file, sha256, size, name FROM media WHERE id = ? AND kind = 'image'", id);

const ONLINE_WINDOW_MS = 90e3;

const isOnline = screen => !!screen.last_seen && now() - screen.last_seen < ONLINE_WINDOW_MS;

function playlistForPlayer(playlistId) {
  if (!playlistId) return null;
  const pl = get("SELECT id, name FROM playlists WHERE id = ?", playlistId);
  if (!pl) return null;
  const items = all(`SELECT pi.id, pi.duration, m.id AS media_id, m.name, m.kind, m.file, m.url, m.sha256, m.size
                     FROM playlist_items pi JOIN media m ON m.id = pi.media_id
                     WHERE pi.playlist_id = ? ORDER BY pi.position, pi.id`, playlistId);
  return {
    id: pl.id,
    name: pl.name,
    items: items.map(i => ({
      id: i.id,
      mediaId: i.media_id,
      name: i.name,
      kind: i.kind,
      src: i.kind === "web" ? i.url : "/media/" + i.file,
      sha256: i.sha256 || null,
      size: i.size || 0,
      // Videos play to their end; duration is used for images and web pages.
      duration: i.duration
    }))
  };
}

/** Everything a player needs, plus a version hash so it only re-downloads when something changed. */
function buildConfig(screen) {
  if (!screen.paired_at) return { paired: false, pairingCode: screen.pairing_code, version: "unpaired-" + screen.pairing_code };
  const schedules = all("SELECT * FROM schedules WHERE screen_id = ? ORDER BY position, id", screen.id)
    .map(s => ({ id: s.id, days: s.days, start: s.start_time, end: s.end_time, playlist: playlistForPlayer(s.playlist_id) }))
    .filter(s => s.playlist);
  const cfg = {
    paired: true,
    screen: { id: screen.id, name: screen.name, orientation: screen.orientation, volume: screen.volume },
    defaultPlaylist: playlistForPlayer(screen.playlist_id),
    schedules,
    layers: withImages(parseLayers(screen.layers_json), imageMedia)
  };
  cfg.version = crypto.createHash("sha1").update(JSON.stringify(cfg)).digest("hex");
  return cfg;
}

module.exports = { buildConfig, isOnline, ONLINE_WINDOW_MS, imageMedia };
