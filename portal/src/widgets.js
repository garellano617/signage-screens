"use strict";
// Widgets: ready-made slides (clock, weather, news feed, QR code, countdown, message).
// Settings are cleaned here; live data (weather, news) is fetched by the server so TVs and
// browsers never call outside services directly.
const dns = require("node:dns/promises");
const net = require("node:net");
const QRCode = require("qrcode");

const TYPES = ["clock", "weather", "rss", "qr", "countdown", "message"];
const clip = (v, n) => String(v == null ? "" : v).slice(0, n);
const color = (v, d) => (/^#[0-9a-fA-F]{6}$/.test(v || "") ? String(v).toLowerCase() : d);
const pick = (v, list, d) => (list.includes(v) ? v : d);

class WidgetError extends Error {}

/** Clean settings for one widget type. Returns a promise (QR codes are generated here). */
async function sanitizeWidget(type, c) {
  if (!TYPES.includes(type)) throw new WidgetError("Unknown widget type.");
  c = c && typeof c === "object" ? c : {};
  // bgOpacity: how solid the background is, 0 (see-through: only the clock / text shows) to 100 (solid).
  const op = Number(c.bgOpacity);
  const base = { bg: color(c.bg, "#0f172a"), fg: color(c.fg, "#ffffff"), accent: color(c.accent, "#f59e0b"),
    bgOpacity: Number.isFinite(op) ? Math.max(0, Math.min(100, Math.round(op))) : 100 };
  switch (type) {
    case "clock":
      return { ...base, style: pick(c.style, ["digital", "analog"], "digital"), hours: pick(c.hours, ["12", "24"], "12"),
        showDate: c.showDate !== false, showSeconds: !!c.showSeconds, label: clip(c.label, 60) };
    case "weather": {
      const lat = Number(c.lat), lng = Number(c.lng);
      if (!(lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) || c.lat === "" || c.lat == null) throw new WidgetError("Pick a location for the weather.");
      return { ...base, lat: Math.round(lat * 1e4) / 1e4, lng: Math.round(lng * 1e4) / 1e4, place: clip(c.place, 80) || "Weather",
        units: pick(c.units, ["f", "c"], "f"), forecast: c.forecast !== false };
    }
    case "rss": {
      let url;
      try { url = new URL(String(c.url || "").trim()); } catch (_) { throw new WidgetError("Enter the feed's full address (https://…)."); }
      if (!/^https?:$/.test(url.protocol)) throw new WidgetError("Feeds must start with http:// or https://");
      return { ...base, url: url.toString(), title: clip(c.title, 60) || "News", seconds: Math.min(60, Math.max(4, Math.round(Number(c.seconds) || 8))) };
    }
    case "qr": {
      const text = clip(c.text, 600).trim();
      if (!text) throw new WidgetError("Enter the web address or text for the QR code.");
      const svg = await QRCode.toString(text, { type: "svg", margin: 1, errorCorrectionLevel: "M", color: { dark: "#000000", light: "#ffffff" } });
      return { ...base, text, title: clip(c.title, 80), caption: clip(c.caption, 160), svg };
    }
    case "countdown": {
      const target = String(c.target || "");
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(target)) throw new WidgetError("Pick the date and time to count down to.");
      return { ...base, target, title: clip(c.title, 80) || "Coming soon", done: clip(c.done, 80) || "It's here!" };
    }
    case "message":
      return { ...base, title: clip(c.title, 120), body: clip(c.body, 600), align: pick(c.align, ["left", "center"], "center") };
  }
}

// ---------- live data ----------
const cache = new Map(); // key -> { at, data }
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.data;
  try {
    const data = await fn();
    if (cache.size > 300) cache.clear();
    cache.set(key, { at: Date.now(), data });
    return data;
  } catch (e) {
    if (hit) return hit.data; // keep showing the last good data
    throw e;
  }
}

/** Refuse addresses on private networks, so a feed URL can't be used to probe the server's network. */
async function assertPublicHost(hostname) {
  const ips = net.isIP(hostname) ? [{ address: hostname }] : await dns.lookup(hostname, { all: true });
  for (const { address } of ips) {
    const a = address.toLowerCase();
    if (a === "::1" || a.startsWith("127.") || a.startsWith("10.") || a.startsWith("192.168.") || a.startsWith("169.254.") || a === "0.0.0.0" ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(a) || a.startsWith("fc") || a.startsWith("fd") || a.startsWith("fe80") || a.startsWith("::ffff:127.") ||
        /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a)) {
      throw new WidgetError("That feed address isn't allowed.");
    }
  }
}

async function fetchText(url, maxBytes) {
  let current = new URL(url);
  for (let hop = 0; hop < 4; hop++) {
    await assertPublicHost(current.hostname);
    const r = await fetch(current, { redirect: "manual", signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "SignagePortal/1.0 (feed reader)", Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*" } });
    if (r.status >= 300 && r.status < 400 && r.headers.get("location")) { current = new URL(r.headers.get("location"), current); continue; }
    if (!r.ok) throw new WidgetError("The feed replied " + r.status + ".");
    const reader = r.body.getReader();
    const chunks = []; let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) { reader.cancel(); break; }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  throw new WidgetError("The feed redirects too many times.");
}

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…",
  copy: "©", reg: "®", trade: "™", euro: "€", pound: "£",
  eacute: "é", egrave: "è", aacute: "á", agrave: "à", iacute: "í", oacute: "ó", uacute: "ú",
  ntilde: "ñ", ccedil: "ç", atilde: "ã", otilde: "õ", uuml: "ü", ouml: "ö", auml: "ä" };
function cleanText(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(parseInt(e.slice(1).replace(/^x/i, ""), /^#x/i.test(e) ? 16 : 10) || 32) : (ENTITIES[e.toLowerCase()] ?? m))
    .replace(/\s+/g, " ").trim();
}

function parseFeed(xml) {
  const items = [];
  const re = /<(item|entry)\b[\s\S]*?<\/\1>/gi;
  let m;
  while ((m = re.exec(xml)) && items.length < 20) {
    const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(m[0]);
    const title = t && cleanText(t[1]);
    if (title) items.push({ title: title.slice(0, 200) });
  }
  return items;
}

// Open-Meteo: free weather API, no key needed.
async function weather(c) {
  return cached(`w:${c.lat},${c.lng},${c.units}`, 15 * 60e3, async () => {
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.search = new URLSearchParams({
      latitude: c.lat, longitude: c.lng, timezone: "auto", forecast_days: "4",
      current: "temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m,is_day",
      daily: "weather_code,temperature_2m_max,temperature_2m_min",
      temperature_unit: c.units === "c" ? "celsius" : "fahrenheit", wind_speed_unit: c.units === "c" ? "kmh" : "mph"
    });
    const r = await fetch(u, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new WidgetError("Weather service replied " + r.status + ".");
    const j = await r.json();
    return {
      current: { temp: Math.round(j.current.temperature_2m), code: j.current.weather_code, wind: Math.round(j.current.wind_speed_10m),
        humidity: j.current.relative_humidity_2m, isDay: j.current.is_day === 1 },
      daily: j.daily.time.map((d, i) => ({ date: d, code: j.daily.weather_code[i], max: Math.round(j.daily.temperature_2m_max[i]), min: Math.round(j.daily.temperature_2m_min[i]) })),
      units: c.units, at: Date.now()
    };
  });
}

async function rss(c) {
  return cached("r:" + c.url, 10 * 60e3, async () => {
    const items = parseFeed(await fetchText(c.url, 1024 * 1024));
    if (!items.length) throw new WidgetError("No headlines found at that address. Is it an RSS or Atom feed?");
    return { items, at: Date.now() };
  });
}

/** Live data for a widget, or null for widgets that don't need any. */
async function widgetData(type, config) {
  if (type === "weather") return weather(config);
  if (type === "rss") return rss(config);
  return null;
}

module.exports = { TYPES, sanitizeWidget, widgetData, WidgetError, parseFeed, cleanText, assertPublicHost };
