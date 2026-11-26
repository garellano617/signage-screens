"use strict";
// A screen's design is four stacked layers (bottom -> top): video, specials, text, effects.
// Everything coming from the browser is cleaned here, so the player only ever gets known values.

const REGIONS = ["full", "left70", "right70", "top85", "left70top85"];
const POSITIONS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
const SIZES = ["s", "m", "l", "xl"];
// The last four are animated scenes (Santa's sleigh, fireworks…). On a video wall every effect spans all its screens.
const EFFECTS = ["snow", "confetti", "sparkles", "bubbles", "hearts", "leaves", "stars", "santa", "fireworks", "shooting", "balloons", "plane"];
const SPECIAL_POSITIONS = ["right", "left", "bottom-right", "bottom-left", "top-right", "center"];

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
const color = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v || "") ? String(v).toLowerCase() : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, min, max, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const numf = (v, min, max, d) => { const n = Math.round(Number(v) * 10) / 10; return v !== null && v !== "" && Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const FONTS = ["sans", "serif", "condensed", "mono", "script"];
const MAX_BLOCKS = 30;
// How a text or picture comes in and goes out. small = small to big on the way in, big to small on the way out; big = the opposite.
// Looks for a text or picture: glow, neon glow (flickers a little), shadow, shine (a light sweeps across), grow (gentle pulse).
const TEXT_FX = ["none", "glow", "neon", "shadow", "shine", "grow"];
const TRANSITIONS = ["none", "fade", "small", "big", "left", "right", "top", "bottom", "spin", "pop"];
const time = v =>(/^([01]\d|2[0-3]):[0-5]\d$/.test(v || "") ? v : "");

function defaultLayers() {
  return {
    video: { enabled: true, region: "full" },
    specials: { enabled: false, heading: "Today's specials", position: "right", seconds: 8, accent: "#f59e0b", bg: "#111827", color: "#ffffff", items: [] },
    text: { enabled: false, cycle: 0, blocks: [], ticker: { enabled: false, text: "", position: "bottom", speed: "normal", size: "m", color: "#ffffff", bg: "#111827" } },
    effects: { enabled: false, type: "snow", intensity: "medium", color: "#ffffff", every: 30, snow: true, banner: "", mediaId: null, bannerBg: "#ffffff", bannerColor: "#b91c1c" }
  };
}

/**
 * Cleans a layers object from the editor.
 * checkImage(mediaId) must return true if that image belongs to the screen's client.
 */
function sanitizeLayers(input, checkImage) {
  const d = defaultLayers();
  const i = input && typeof input === "object" ? input : {};
  const v = i.video || {}, sp = i.specials || {}, tx = i.text || {}, ef = i.effects || {}, tk = tx.ticker || {};
  const items = (Array.isArray(sp.items) ? sp.items : []).slice(0, 30).map(x => {
    const mediaId = x && x.mediaId ? Number(x.mediaId) : null;
    return {
      title: clip(x && x.title, 80),
      price: clip(x && x.price, 20),
      description: clip(x && x.description, 200),
      mediaId: mediaId && Number.isInteger(mediaId) && checkImage(mediaId) ? mediaId : null,
      days: num(x && x.days, 1, 127, 127),
      start: time(x && x.start),
      end: time(x && x.end)
    };
  }).filter(x => x.title || x.price || x.description || x.mediaId);
  const cycle = num(tx.cycle, 0, 3600, 0);
  const blocks = (Array.isArray(tx.blocks) ? tx.blocks : []).slice(0, MAX_BLOCKS).map((raw, index) => {
    const b = raw && typeof raw === "object" ? raw : {};
    const kind = b.kind === "image" ? "image" : "text";
    const mediaId = kind === "image" && b.mediaId ? Number(b.mediaId) : null;
    const free = b.x !== null && b.x !== undefined && b.x !== "" && b.y !== null && b.y !== undefined && b.y !== "";
    const from = cycle ? numf(b.from, 0, cycle, 0) : 0;
    const to = cycle ? numf(b.to, 0, cycle, 0) : 0;
    return {
      kind,
      text: kind === "text" ? clip(b.text, 600) : "",
      mediaId: mediaId && Number.isInteger(mediaId) && checkImage(mediaId) ? mediaId : null,
      position: pick(b.position, POSITIONS, "top"),
      // Free placement: top-left corner in % of the screen (null = use position).
      x: free ? numf(b.x, -50, 100, 0) : null,
      y: free ? numf(b.y, -50, 100, 0) : null,
      // Width in % of the screen (0 = as wide as the text).
      w: numf(b.w, 0, 100, kind === "image" ? 30 : 0),
      size: pick(b.size, SIZES, "m"),
      // Font size in % of the screen width (0 = use size).
      fs: numf(b.fs, 0, 30, 0),
      font: pick(b.font, FONTS, "sans"),
      align: pick(b.align, ["left", "center", "right"], ""),
      bold: !!b.bold,
      italic: !!b.italic,
      color: color(b.color, "#ffffff"),
      bg: color(b.bg, "#000000"),
      bgOpacity: num(b.bgOpacity, 0, 100, kind === "image" ? 0 : 50),
      // Shown from..to seconds into each cycle (to = 0: until the end).
      from: to && to <= from ? 0 : from,
      to: to && to <= from ? 0 : to,
      // Timeline row: blocks on the same row play one after another; where they overlap, that is the transition.
      track: num(b.track, 0, 49, Math.min(49, index)),
      // Locked group (0 = none): the timeline moves and stretches the group's bars together.
      grp: num(b.grp, 0, 999, 0),
      enter: pick(b.enter, TRANSITIONS, "none"),
      exit: pick(b.exit, TRANSITIONS, "none"),
      // Transition length in seconds.
      td: numf(b.td, 0.2, 5, 1),
      fx: pick(b.fx, TEXT_FX, "none"),
      fxColor: color(b.fxColor, "#facc15")
    };
  }).filter(b => (b.kind === "text" ? b.text.trim() : b.mediaId));
  return {
    video: { enabled: v.enabled !== false, region: pick(v.region, REGIONS, d.video.region) },
    specials: {
      enabled: !!sp.enabled,
      heading: clip(sp.heading !== undefined ? sp.heading : d.specials.heading, 60),
      position: pick(sp.position, SPECIAL_POSITIONS, d.specials.position),
      seconds: num(sp.seconds, 3, 120, d.specials.seconds),
      accent: color(sp.accent, d.specials.accent), bg: color(sp.bg, d.specials.bg), color: color(sp.color, d.specials.color),
      items
    },
    text: {
      enabled: !!tx.enabled,
      // Text timing repeats every `cycle` seconds (0 = every block shows all the time).
      cycle,
      blocks,
      ticker: {
        enabled: !!tk.enabled,
        text: clip(tk.text, 1000),
        position: pick(tk.position, ["top", "bottom"], "bottom"),
        speed: pick(tk.speed, ["slow", "normal", "fast"], "normal"),
        size: pick(tk.size, SIZES, "m"),
        color: color(tk.color, "#ffffff"),
        bg: color(tk.bg, "#111827")
      }
    },
    effects: {
      enabled: !!ef.enabled,
      type: pick(ef.type, EFFECTS, d.effects.type),
      intensity: pick(ef.intensity, ["light", "medium", "heavy"], "medium"),
      color: color(ef.color, "#ffffff"),
      // Santa: seconds between fly-bys, and falling snow behind him.
      every: Math.min(300, Math.max(10, Math.round(Number(ef.every)) || 30)),
      snow: ef.snow === undefined ? true : !!ef.snow,
      // Plane: the banner it pulls (text and/or a small logo picture) and its colors.
      banner: clip(ef.banner, 60),
      mediaId: ef.mediaId && Number.isInteger(Number(ef.mediaId)) && checkImage(Number(ef.mediaId)) ? Number(ef.mediaId) : null,
      bannerBg: color(ef.bannerBg, "#ffffff"),
      bannerColor: color(ef.bannerColor, "#b91c1c")
    }
  };
}

/** Stored JSON -> layers (old or empty rows get the defaults). */
function parseLayers(json) {
  let raw = null;
  try { raw = JSON.parse(json || "null"); } catch (_) {}
  return raw ? sanitizeLayers(raw, () => true) : defaultLayers();
}

/** Adds each special's and image block's image (src, sha256, size) so the portal can preview it and the player can cache it. */
/** x with its picture attached as x.image (or no picture if it is gone). */
function attachImage(x, getMedia) {
  const m = x.mediaId ? getMedia(x.mediaId) : null;
  return { ...x, mediaId: m ? x.mediaId : null, image: m ? { mediaId: m.id, src: "/media/" + m.file, sha256: m.sha256, size: m.size, name: m.name } : null };
}
function withImages(layers, getMedia) {
  const out = JSON.parse(JSON.stringify(layers));
  const attach = x => attachImage(x, getMedia);
  // The logo on the plane's banner.
  if (out.effects) out.effects = attach(out.effects);
  out.specials.items = out.specials.items.map(attach);
  // An image block whose picture was deleted is dropped.
  out.text.blocks = out.text.blocks.map(b => (b.kind === "image" ? attach(b) : b)).filter(b => b.kind !== "image" || b.image);
  return out;
}

module.exports = { TEXT_FX, TRANSITIONS, defaultLayers, sanitizeLayers, parseLayers, withImages, attachImage, REGIONS, POSITIONS, SIZES, EFFECTS, SPECIAL_POSITIONS, FONTS };
