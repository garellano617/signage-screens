"use strict";
// A screen's design is four stacked layers (bottom -> top): video, specials, text, effects.
// Everything coming from the browser is cleaned here, so the player only ever gets known values.

const REGIONS = ["full", "left70", "right70", "top85", "left70top85"];
const POSITIONS = ["top-left", "top", "top-right", "left", "center", "right", "bottom-left", "bottom", "bottom-right"];
const SIZES = ["s", "m", "l", "xl"];
const EFFECTS = ["snow", "confetti", "sparkles", "bubbles", "hearts", "leaves", "stars"];
const SPECIAL_POSITIONS = ["right", "left", "bottom-right", "bottom-left", "top-right", "center"];

const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
const color = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v || "") ? String(v).toLowerCase() : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);
const num = (v, min, max, d) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d; };
const time = v => (/^([01]\d|2[0-3]):[0-5]\d$/.test(v || "") ? v : "");

function defaultLayers() {
  return {
    video: { enabled: true, region: "full" },
    specials: { enabled: false, heading: "Today's specials", position: "right", seconds: 8, accent: "#f59e0b", bg: "#111827", color: "#ffffff", items: [] },
    text: { enabled: false, blocks: [], ticker: { enabled: false, text: "", position: "bottom", speed: "normal", size: "m", color: "#ffffff", bg: "#111827" } },
    effects: { enabled: false, type: "snow", intensity: "medium", color: "#ffffff" }
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
  const blocks = (Array.isArray(tx.blocks) ? tx.blocks : []).slice(0, 12).map(b => ({
    text: clip(b && b.text, 300),
    position: pick(b && b.position, POSITIONS, "top"),
    size: pick(b && b.size, SIZES, "m"),
    bold: !!(b && b.bold),
    color: color(b && b.color, "#ffffff"),
    bg: color(b && b.bg, "#000000"),
    bgOpacity: num(b && b.bgOpacity, 0, 100, 50)
  })).filter(b => b.text.trim());
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
      color: color(ef.color, "#ffffff")
    }
  };
}

/** Stored JSON -> layers (old or empty rows get the defaults). */
function parseLayers(json) {
  let raw = null;
  try { raw = JSON.parse(json || "null"); } catch (_) {}
  return raw ? sanitizeLayers(raw, () => true) : defaultLayers();
}

/** Adds each special's image (src, sha256, size) so the portal can preview it and the player can cache it. */
function withImages(layers, getMedia) {
  const out = JSON.parse(JSON.stringify(layers));
  out.specials.items = out.specials.items.map(x => {
    const m = x.mediaId ? getMedia(x.mediaId) : null;
    return { ...x, mediaId: m ? x.mediaId : null, image: m ? { mediaId: m.id, src: "/media/" + m.file, sha256: m.sha256, size: m.size, name: m.name } : null };
  });
  return out;
}

module.exports = { defaultLayers, sanitizeLayers, parseLayers, withImages, REGIONS, POSITIONS, SIZES, EFFECTS, SPECIAL_POSITIONS };
