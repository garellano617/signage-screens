/*
 * Holiday backgrounds: American holidays and custom ones, each with a start and end date.
 * Shared by the portal page (window.Holidays) and the server (require), so both agree on the dates.
 *
 * A holiday entry: { key, name, start: "YYYY-MM-DD", end: "YYYY-MM-DD", yearly, mediaId, color, enabled }
 *   key: one of US_HOLIDAYS (e.g. "christmas") or "" for a custom holiday.
 *   yearly: repeat every year. American holidays keep the same number of days before/after the holiday
 *   (so Thanksgiving follows the 4th Thursday); custom ones repeat on the same calendar dates.
 * Dates are calendar days in the TV's own time zone. The whole end day is included.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.Holidays = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  var DAY = 864e5;
  // Dates are handled as UTC midnights so adding days never trips over daylight saving.
  var mk = function (y, m, d) { return Date.UTC(y, m - 1, d); };
  var parse = function (s) { var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || "")); return m ? mk(+m[1], +m[2], +m[3]) : NaN; };
  var fmt = function (t) { return new Date(t).toISOString().slice(0, 10); };
  var yearOf = function (t) { return new Date(t).getUTCFullYear(); };
  // nth weekday (0 = Sunday) of a month; n = -1 = the last one.
  function nth(y, m, dow, n) {
    if (n > 0) { var first = new Date(mk(y, m, 1)).getUTCDay(); return mk(y, m, 1 + ((dow - first + 7) % 7) + (n - 1) * 7); }
    var lastDay = new Date(mk(y, m + 1, 0)).getUTCDate(), last = new Date(mk(y, m, lastDay)).getUTCDay();
    return mk(y, m, lastDay - ((last - dow + 7) % 7));
  }
  // Easter Sunday (Gregorian calendar, anonymous algorithm).
  function easter(y) {
    var a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25),
      g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4,
      l = (32 + 2 * e + 2 * i - h - k) % 7, m = Math.floor((a + 11 * h + 22 * l) / 451), mo = Math.floor((h + l - 7 * m + 114) / 31);
    return mk(y, mo, ((h + l - 7 * m + 114) % 31) + 1);
  }
  var fixed = function (m, d) { return function (y) { return mk(y, m, d); }; };
  // [key, name, emoji, date in year y, default days before, default days after]
  var US_HOLIDAYS = [
    ["newyear", "New Year's", "🎆", fixed(1, 1), 1, 1],
    ["mlk", "Martin Luther King Jr. Day", "✊", function (y) { return nth(y, 1, 1, 3); }, 0, 0],
    ["valentines", "Valentine's Day", "❤️", fixed(2, 14), 7, 0],
    ["presidents", "Presidents' Day", "🇺🇸", function (y) { return nth(y, 2, 1, 3); }, 2, 0],
    ["stpatricks", "St. Patrick's Day", "☘️", fixed(3, 17), 6, 0],
    ["easter", "Easter", "🐣", easter, 7, 1],
    ["cincodemayo", "Cinco de Mayo", "🇲🇽", fixed(5, 5), 2, 0],
    ["mothers", "Mother's Day", "💐", function (y) { return nth(y, 5, 0, 2); }, 6, 0],
    ["memorial", "Memorial Day", "🇺🇸", function (y) { return nth(y, 5, 1, -1); }, 3, 0],
    ["fathers", "Father's Day", "👔", function (y) { return nth(y, 6, 0, 3); }, 6, 0],
    ["juneteenth", "Juneteenth", "✊🏿", fixed(6, 19), 0, 0],
    ["independence", "Fourth of July", "🎇", fixed(7, 4), 3, 1],
    ["labor", "Labor Day", "🛠️", function (y) { return nth(y, 9, 1, 1); }, 3, 0],
    ["halloween", "Halloween", "🎃", fixed(10, 31), 14, 0],
    ["veterans", "Veterans Day", "🎖️", fixed(11, 11), 0, 0],
    ["thanksgiving", "Thanksgiving", "🦃", function (y) { return nth(y, 11, 4, 4); }, 6, 1],
    ["christmas", "Christmas", "🎄", fixed(12, 25), 24, 1]
  ];
  var BY_KEY = {};
  US_HOLIDAYS.forEach(function (h) { BY_KEY[h[0]] = h; });

  /** The day this holiday falls on in year y (custom: the start's month and day). */
  function anchor(h, y) {
    var k = BY_KEY[h.key];
    if (k) return k[3](y);
    var s = parse(h.start), d = new Date(s);
    return mk(y, d.getUTCMonth() + 1, d.getUTCDate());
  }
  /** Days from the holiday to the start and to the end, measured from the nearest holiday to the saved start. */
  function offsets(h) {
    var s = parse(h.start), e = parse(h.end), y = yearOf(s), best = null;
    [y - 1, y, y + 1].forEach(function (yy) { var a = anchor(h, yy); if (best === null || Math.abs(s - a) < Math.abs(s - best)) best = a; });
    return [Math.round((s - best) / DAY), Math.round((e - best) / DAY)];
  }
  /** Each [start, end] (as times) of this holiday that could touch year y. */
  function windows(h, y) {
    var s = parse(h.start), e = parse(h.end);
    if (isNaN(s) || isNaN(e) || e < s) return [];
    if (!h.yearly) return [[s, e]];
    var o = offsets(h), out = [];
    for (var yy = y - 1; yy <= y + 1; yy++) { var a = anchor(h, yy); out.push([a + o[0] * DAY, a + o[1] * DAY]); }
    return out;
  }
  /** Is this holiday on (and does it have something to show) on date ymd ("YYYY-MM-DD")? */
  function isActive(h, ymd) {
    var t = parse(ymd);
    if (!h || h.enabled === false || isNaN(t) || (!h.mediaId && !h.color)) return false;
    return windows(h, yearOf(t)).some(function (w) { return w[0] <= t && t <= w[1]; });
  }
  /** The holiday showing on ymd: the first one in the list that's on. */
  function active(list, ymd) {
    for (var i = 0; list && i < list.length; i++) if (isActive(list[i], ymd)) return list[i];
    return null;
  }
  /** The current or next dates for this holiday on or after ymd: { start, end } or null (one-time and already over). */
  function next(h, ymd) {
    var t = parse(ymd);
    var ws = windows(h, yearOf(t)).filter(function (w) { return w[1] >= t; }).sort(function (a, b) { return a[0] - b[0]; });
    return ws.length ? { start: fmt(ws[0][0]), end: fmt(ws[0][1]) } : null;
  }
  /** A new entry for an American holiday (or custom: key ""), with its upcoming dates. */
  function create(key, ymd) {
    var k = BY_KEY[key], t = parse(ymd), y = yearOf(t);
    if (!k) return { key: "", name: "", start: fmt(t), end: fmt(t + 6 * DAY), yearly: false, mediaId: null, color: "", enabled: true };
    var a = k[3](y);
    if (a + k[5] * DAY < t) a = k[3](y + 1);
    return { key: key, name: k[1], start: fmt(a - k[4] * DAY), end: fmt(a + k[5] * DAY), yearly: true, mediaId: null, color: "", enabled: true };
  }
  var info = function (key) { var k = BY_KEY[key]; return k ? { key: k[0], name: k[1], emoji: k[2] } : null; };
  var list = function () { return US_HOLIDAYS.map(function (k) { return { key: k[0], name: k[1], emoji: k[2] }; }); };

  /** Today's date ("YYYY-MM-DD") in a time zone (an IANA name like "America/Chicago"); unknown zone → fallback. */
  function today(zone, fallback, nowMs) {
    var d = new Date(nowMs || Date.now());
    var tryZone = function (z) {
      try { return new Intl.DateTimeFormat("en-CA", { timeZone: z, year: "numeric", month: "2-digit", day: "2-digit" }).format(d); } catch (e) { return null; }
    };
    return (zone && tryZone(zone)) || (fallback && tryZone(fallback)) || d.toISOString().slice(0, 10);
  }

  return { list: list, info: info, create: create, isActive: isActive, active: active, next: next, today: today, parse: parse, fmt: fmt };
});
