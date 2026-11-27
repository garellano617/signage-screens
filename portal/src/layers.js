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
const TRANSITIONS = ["none", "fade", "small", "big", "left", "right", "top", "bottom", "spin", "pop", "flip"];
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
/** Vector shapes (drawn by overlay.js). */
const SHAPE_NAMES = ["square", "rect", "rounded", "circle", "oval", "triangle", "rtriangle", "diamond", "wave", "waves", "waveline", "star", "burst", "arrow", "banner", "bubble", "heart", "line"];

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
    const kind = b.kind === "image" ? "image" : b.kind === "shape" ? "shape" : b.kind === "widget" ? "widget" : "text";
    // Pictures and widgets point to a media item (checked: it must be the client's own).
    const mediaId = (kind === "image" || kind === "widget") && b.mediaId ? Number(b.mediaId) : null;
    const free = b.x !== null && b.x !== undefined && b.x !== "" && b.y !== null && b.y !== undefined && b.y !== "";
    const from = cycle ? numf(b.from, 0, cycle, 0) : 0;
    const to = cycle ? numf(b.to, 0, cycle, 0) : 0;
    return {
      kind,
      text: kind === "text" ? clip(b.text, 600) : "",
      mediaId: mediaId && Number.isInteger(mediaId) && checkImage(mediaId, kind) ? mediaId : null,
      position: pick(b.position, POSITIONS, "top"),
      // Free placement: top-left corner in % of the screen (null = use position).
      // (can be partly or mostly off the screen: the screen cuts it off)
      x: free ? numf(b.x, -300, 200, 0) : null,
      y: free ? numf(b.y, -300, 200, 0) : null,
      // Width in % of the screen (0 = as wide as the text).
      w: numf(b.w, 0, kind === "shape" ? 400 : 100, kind === "image" ? 30 : kind === "shape" ? 18 : kind === "widget" ? 30 : 0),
      // Widgets: their box's height (in % of the screen width, like w).
      ...(kind === "widget" ? { h: numf(b.h, 2, 100, 17) } : {}),
      // Shapes: which one, height (in % of the screen width, like w), inside colour + see-through, border colour + thickness.
      ...(kind === "shape" ? {
        shape: pick(b.shape, SHAPE_NAMES, "square"),
        h: numf(b.h, 0.2, 400, 18),
        // Turned this many degrees (clockwise) around its middle.
        rot: (v => Math.round((((v % 360) + 540) % 360 - 180) * 10) / 10)(Number(b.rot) || 0),
        fill: color(b.fill, "#dc2626"),
        fillOpacity: num(b.fillOpacity, 0, 100, 100),
        stroke: color(b.stroke, "#ffffff"),
        sw: numf(b.sw, 0, 10, 0)
      } : {}),
      size: pick(b.size, SIZES, "m"),
      // Font size in % of the screen width (0 = use size).
      fs: numf(b.fs, 0, 30, 0),
      font: pick(b.font, FONTS, "sans"),
      align: pick(b.align, ["left", "center", "right"], ""),
      bold: !!b.bold,
      italic: !!b.italic,
      color: color(b.color, "#ffffff"),
      bg: color(b.bg, "#000000"),
      bgOpacity: num(b.bgOpacity, 0, 100, kind === "text" ? 50 : 0),
      // Shown from..to seconds into each cycle (to = 0: until the end).
      from: to && to <= from ? 0 : from,
      to: to && to <= from ? 0 : to,
      // Timeline row: blocks on the same row play one after another; where they overlap, that is the transition.
      track: num(b.track, 0, 49, Math.min(49, index)),
      // Locked group (0 = none): the timeline moves and stretches the group's bars together.
      grp: num(b.grp, 0, 999, 0),
      // Spacing (text): letter spacing in em and line spacing (0 = normal) for the whole text; letter spacing for
      // parts (character positions s..e) and line spacing per line (null = the text's own).
      ls: kind === "text" ? numf(b.ls, -0.2, 2, 0) : 0,
      lh: kind === "text" ? (v => (v && v < 0.5 ? 0.5 : v))(numf(b.lh, 0, 4, 0)) : 0,
      runs: kind === "text" && Array.isArray(b.runs) ? b.runs.slice(0, 60).map(r => ({ s: num(r && r.s, 0, 600, 0), e: num(r && r.e, 0, 600, 0), ls: numf(r && r.ls, -0.2, 2, 0) })).filter(r => r.e > r.s) : [],
      llh: kind === "text" && Array.isArray(b.llh) ? b.llh.slice(0, 100).map(v => (v === null || v === undefined || v === "" || !Number(v) ? null : numf(v, 0.5, 4, 1.2))) : [],
      // Thickness 100 (thin) to 900 (heavy) for the whole text (0 = bold or normal) and for parts.
      wt: kind === "text" ? (v => (v ? Math.round(Math.min(900, Math.max(100, v))) : 0))(Number(b.wt) || 0) : 0,
      wruns: kind === "text" && Array.isArray(b.wruns) ? b.wruns.slice(0, 60).map(r => ({ s: num(r && r.s, 0, 600, 0), e: num(r && r.e, 0, 600, 0), wt: num(r && r.wt, 100, 900, 400) })).filter(r => r.e > r.s) : [],
      // Locked at the bottom (backgrounds): always under everything, can't be clicked or dragged in the designer.
      locked: kind !== "text" && !!b.locked,
      // Stacking: true = over the Specials panel (and over the pictures/text under it). Order among blocks = list order.
      above: !!b.above,
      enter: pick(b.enter, TRANSITIONS, "none"),
      exit: pick(b.exit, TRANSITIONS, "none"),
      // Transition length in seconds.
      td: numf(b.td, 0.2, 5, 1),
      fx: pick(b.fx, TEXT_FX, "none"),
      fxColor: color(b.fxColor, "#facc15")
    };
  }).filter(b => (b.kind === "text" ? b.text.trim() : b.kind === "shape" ? true : b.mediaId))
    .map(b => (b.locked ? Object.assign(b, { above: false }) : b))
    .sort((a, c) => (c.locked ? 1 : 0) - (a.locked ? 1 : 0));
  return {
    video: { enabled: v.enabled !== false, region: pick(v.region, REGIONS, d.video.region) },
    // Background colour of the design (screens show only their design now). "" = none (black on the TV).
    background: /^#[0-9a-f]{6}$/i.test(String(i.background || "")) ? String(i.background) : "",
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
/** A widget block with its widget ({ type, config }) attached, or null when the widget is gone. */
function attachWidget(b, getWidget) {
  const m = b.mediaId ? getWidget(b.mediaId) : null;
  let w = null; try { w = m && JSON.parse(m.widget_json || "null"); } catch (_) {}
  return w && w.type !== "design" ? { ...b, widget: w, widgetName: m.name } : null;
}
function withImages(layers, getMedia, getWidget) {
  const out = JSON.parse(JSON.stringify(layers));
  const attach = x => attachImage(x, getMedia);
  // The logo on the plane's banner.
  if (out.effects) out.effects = attach(out.effects);
  out.specials.items = out.specials.items.map(attach);
  // An image block whose picture was deleted is dropped.
  out.text.blocks = out.text.blocks.map(b => (b.kind === "image" ? attach(b) : b)).filter(b => b.kind !== "image" || b.image);
  // Widgets (clock, weather…) placed on the design: their settings, for the preview and the TV. Gone → dropped.
  if (getWidget) out.text.blocks = out.text.blocks.map(b => (b.kind === "widget" ? attachWidget(b, getWidget) : b)).filter(Boolean);
  return out;
}

module.exports = { TEXT_FX, TRANSITIONS, defaultLayers, sanitizeLayers, parseLayers, withImages, attachImage, REGIONS, POSITIONS, SIZES, EFFECTS, SPECIAL_POSITIONS, FONTS };
