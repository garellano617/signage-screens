"use strict";
const crypto = require("node:crypto");
const { all, get, now } = require("./db");
const { parseLayers, withImages, sanitizeLayers, attachImage } = require("./layers");

/** A video wall's effects layer (snow, Santa's sleigh…), cleaned like any layers. */
const wallEffects = w => {
  let raw = null; try { raw = JSON.parse(w.effects_json || "null"); } catch (_) {}
  // The banner logo must be one of the wall's client's pictures.
  return attachImage(sanitizeLayers({ effects: raw || {} }, () => true).effects,
    id => get("SELECT id, file, sha256, size, name FROM media WHERE id = ? AND kind = 'image' AND customer_id = ?", id, w.customer_id));
};

const imageMedia = id => get("SELECT id, file, sha256, size, name FROM media WHERE id = ? AND kind = 'image'", id);
/** Widgets placed on a design (checked to be the client's when the design was saved). */
const widgetMedia = id => get("SELECT id, name, widget_json FROM media WHERE id = ? AND kind = 'widget'", id);

const ONLINE_WINDOW_MS = 90e3;

const isOnline = screen => !!screen.last_seen && now() - screen.last_seen < ONLINE_WINDOW_MS;

/** Design slides: pictures attached (src, sha256, size) so the player downloads them and can show them offline. */
function forPlayer(w) {
  if (!w || w.type !== "design" || !w.config) return w;
  return { ...w, config: { ...w.config, layers: withImages(parseLayers(JSON.stringify(w.config.layers || null)), imageMedia, widgetMedia) } };
}

/** A screen's design with no video layer underneath (there's no playlist to play). */
const designOnly = layers => ({ ...layers, video: { enabled: false, region: "full" } });

function playlistForPlayer(playlistId) {
  if (!playlistId) return null;
  const pl = get("SELECT id, name FROM playlists WHERE id = ?", playlistId);
  if (!pl) return null;
  const items = all(`SELECT pi.id, pi.duration, m.id AS media_id, m.name, m.kind, m.file, m.url, m.sha256, m.size, m.widget_json
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
      src: i.kind === "web" ? i.url : i.kind === "widget" ? "widget:" + i.media_id : "/media/" + i.file,
      widget: i.kind === "widget" ? forPlayer(JSON.parse(i.widget_json || "null")) : undefined,
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
  // Playlists and schedules aren't used for screens any more: each screen shows its design. (The data is kept.)
  const schedules = [];
  // A screen in a video wall plays the wall's playlist, cropped to its tile, in step with the other screens.
  const wall = screen.wall_id ? get("SELECT * FROM walls WHERE id = ?", screen.wall_id) : null;
  if (wall && screen.wall_col < wall.cols && screen.wall_row < wall.rows) {
    const first = screen.wall_col === 0 && screen.wall_row === 0;
    const cfg = {
      paired: true,
      // Sound comes from the top-left screen only, so the screens don't echo.
      screen: { id: screen.id, name: screen.name, orientation: 0, volume: first ? screen.volume : 0 },
      defaultPlaylist: playlistForPlayer(wall.playlist_id),
      schedules: [],
      // Only the effects layer, drawn across the whole wall (view = this screen's part of it).
      layers: Object.assign(parseLayers(null), { effects: wallEffects(wall), view: { cols: wall.cols, rows: wall.rows, col: screen.wall_col, row: screen.wall_row, gap: wall.bezel / 100 } }),
      wall: { id: wall.id, cols: wall.cols, rows: wall.rows, col: screen.wall_col, row: screen.wall_row, bezel: wall.bezel, fit: wall.fit }
    };
    cfg.version = crypto.createHash("sha1").update(JSON.stringify(cfg)).digest("hex");
    return cfg;
  }
  // A screen on a channel takes the channel's main playlist and layers (its own schedule still applies).
  const channel = screen.channel_id ? get("SELECT playlist_id, layers_json FROM channels WHERE id = ?", screen.channel_id) : null;
  const cfg = {
    paired: true,
    screen: { id: screen.id, name: screen.name, orientation: screen.orientation, volume: screen.volume },
    defaultPlaylist: null,
    schedules,
    layers: designOnly(withImages(parseLayers(channel ? channel.layers_json : screen.layers_json), imageMedia, widgetMedia))
  };
  cfg.version = crypto.createHash("sha1").update(JSON.stringify(cfg)).digest("hex");
  return cfg;
}

module.exports = { buildConfig, isOnline, ONLINE_WINDOW_MS, imageMedia, wallEffects };
