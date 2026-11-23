/*
 * Widget renderer (clock, weather, news feed, QR code, countdown, message).
 * Runs in the portal (previews) and inside the Android player (bundled into the APK), so they look the same.
 *
 *   const w = SignageWidgets.render(element, { type, config }, data);   // data: weather/news from the server, or null
 *   w.update(newData);  w.destroy();
 */
(function (global) {
  "use strict";

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function pad(n) { return (n < 10 ? "0" : "") + n; }
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

  // WMO weather codes -> [emoji, words]
  function wmo(code, isDay) {
    if (code === 0) return [isDay === false ? "🌙" : "☀️", "Clear"];
    if (code <= 2) return [isDay === false ? "☁️" : "🌤️", "Partly cloudy"];
    if (code === 3) return ["☁️", "Cloudy"];
    if (code === 45 || code === 48) return ["🌫️", "Fog"];
    if (code >= 51 && code <= 57) return ["🌦️", "Drizzle"];
    if (code >= 61 && code <= 67) return ["🌧️", "Rain"];
    if (code >= 71 && code <= 77) return ["🌨️", "Snow"];
    if (code >= 80 && code <= 82) return ["🌧️", "Showers"];
    if (code === 85 || code === 86) return ["🌨️", "Snow showers"];
    if (code >= 95) return ["⛈️", "Thunderstorm"];
    return ["🌡️", ""];
  }

  function render(root, widget, data, opts) {
    opts = opts || {};
    var type = widget.type, c = widget.config || {};
    var timers = [];
    // Thumbnails (opts.still) draw once and don't keep ticking.
    var every = function (fn, ms) { if (!opts.still) timers.push(setInterval(fn, ms)); };
    root.innerHTML = "";
    root.className = (root.className.replace(/\bsw-\S+/g, "") + " sw-root sw-t-" + type).trim();
    root.style.background = c.bg; root.style.color = c.fg;
    var fit = function () { root.style.fontSize = (Math.min(root.clientWidth, root.clientHeight * 16 / 9) / 100) + "px"; };
    fit();
    var onResize = function () { fit(); };
    var ro = opts.still ? null : global.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(root); else if (!opts.still) global.addEventListener("resize", onResize);
    var api = { update: function () {}, destroy: function () {
      timers.forEach(clearInterval);
      if (ro) ro.disconnect(); else global.removeEventListener("resize", onResize);
      root.innerHTML = "";
    } };

    if (type === "clock") {
      var label = c.label ? el("div", "sw-label", c.label) : null;
      if (label) { label.style.color = c.accent; root.appendChild(label); }
      var face, time, date = el("div", "sw-date");
      if (c.style === "analog") {
        face = el("div", "sw-analog");
        var hands = {};
        for (var i = 0; i < 12; i++) { var t = el("i", "sw-tick"); t.style.transform = "rotate(" + i * 30 + "deg)"; face.appendChild(t); }
        ["h", "m", "s"].forEach(function (k) { hands[k] = el("b", "sw-hand sw-" + k); face.appendChild(hands[k]); });
        hands.s.style.background = c.accent;
        if (!c.showSeconds) hands.s.style.display = "none";
        root.appendChild(face);
      } else { time = el("div", "sw-time"); root.appendChild(time); }
      if (c.showDate) root.appendChild(date);
      var tick = function () {
        var d = new Date(), H = d.getHours(), M = d.getMinutes(), S = d.getSeconds();
        if (face) {
          hands.h.style.transform = "rotate(" + ((H % 12) * 30 + M / 2) + "deg)";
          hands.m.style.transform = "rotate(" + (M * 6 + S / 10) + "deg)";
          hands.s.style.transform = "rotate(" + S * 6 + "deg)";
        } else {
          var h = c.hours === "24" ? pad(H) : String(H % 12 || 12);
          time.innerHTML = "";
          time.appendChild(document.createTextNode(h + ":" + pad(M)));
          if (c.showSeconds) { var s = el("span", "sw-sec", ":" + pad(S)); time.appendChild(s); }
          if (c.hours !== "24") { var ap = el("span", "sw-ampm", H < 12 ? "AM" : "PM"); ap.style.color = c.accent; time.appendChild(ap); }
        }
        date.textContent = DAYS[d.getDay()] + ", " + MONTHS[d.getMonth()] + " " + d.getDate();
      };
      tick(); every(tick, 1000);
    }

    else if (type === "weather") {
      var drawWeather = function (dt) {
        root.innerHTML = "";
        var place = el("div", "sw-label", c.place); place.style.color = c.accent; root.appendChild(place);
        if (!dt || !dt.current) { root.appendChild(el("div", "sw-wait", opts.still ? "Live weather" : "Weather will appear when the screen is online.")); return; }
        var u = dt.units === "c" ? "°C" : "°F";
        var w = wmo(dt.current.code, dt.current.isDay);
        var now = el("div", "sw-now");
        now.appendChild(el("div", "sw-icon", w[0]));
        var nt = el("div", "");
        nt.appendChild(el("div", "sw-temp", dt.current.temp + u));
        nt.appendChild(el("div", "sw-cond", w[1]));
        nt.appendChild(el("div", "sw-extra", "Humidity " + dt.current.humidity + "% · Wind " + dt.current.wind + (dt.units === "c" ? " km/h" : " mph")));
        now.appendChild(nt); root.appendChild(now);
        if (c.forecast && dt.daily) {
          var row = el("div", "sw-forecast");
          dt.daily.slice(1, 4).forEach(function (d) {
            var cell = el("div", "sw-day");
            var day = new Date(d.date + "T12:00:00");
            cell.appendChild(el("div", "sw-dname", DAYS[day.getDay()].slice(0, 3)));
            cell.appendChild(el("div", "sw-dicon", wmo(d.code)[0]));
            cell.appendChild(el("div", "sw-drange", d.max + "° / " + d.min + "°"));
            row.appendChild(cell);
          });
          root.appendChild(row);
        }
      };
      drawWeather(data);
      api.update = drawWeather;
    }

    else if (type === "rss") {
      var title = el("div", "sw-label", c.title); title.style.color = c.accent;
      var box = el("div", "sw-headline");
      var dots = el("div", "sw-count");
      root.appendChild(title); root.appendChild(box); root.appendChild(dots);
      var items = [], idx = -1;
      var next = function () {
        if (!items.length) { box.textContent = opts.still ? "Live headlines" : "Headlines will appear when the screen is online."; box.className = "sw-headline sw-wait"; return; }
        idx = (idx + 1) % items.length;
        var line = el("div", "sw-line", items[idx].title);
        box.className = "sw-headline"; box.innerHTML = ""; box.appendChild(line);
        requestAnimationFrame(function () { line.classList.add("in"); });
        dots.textContent = (idx + 1) + " / " + items.length;
      };
      api.update = function (dt) { items = (dt && dt.items) || []; idx = -1; next(); };
      api.update(data);
      every(next, (c.seconds || 8) * 1000);
    }

    else if (type === "qr") {
      var wrap = el("div", "sw-qrwrap");
      if (c.title) { var qt = el("div", "sw-label", c.title); qt.style.color = c.accent; root.appendChild(qt); }
      var code = el("div", "sw-qr");
      code.innerHTML = c.svg || ""; // generated by the portal server from the text, not user HTML
      wrap.appendChild(code);
      if (c.caption) wrap.appendChild(el("div", "sw-caption", c.caption));
      root.appendChild(wrap);
    }

    else if (type === "countdown") {
      var ct = el("div", "sw-label", c.title); ct.style.color = c.accent;
      var nums = el("div", "sw-count-row");
      root.appendChild(ct); root.appendChild(nums);
      var target = new Date(c.target).getTime();
      var tickC = function () {
        var ms = target - Date.now();
        nums.innerHTML = "";
        if (ms <= 0) { nums.appendChild(el("div", "sw-done", c.done)); return; }
        var parts = [[Math.floor(ms / 864e5), "days"], [Math.floor(ms / 36e5) % 24, "hours"], [Math.floor(ms / 6e4) % 60, "min"], [Math.floor(ms / 1e3) % 60, "sec"]];
        parts.forEach(function (p) { var b = el("div", "sw-unit"); b.appendChild(el("div", "sw-n", String(p[0]))); b.appendChild(el("div", "sw-u", p[1])); nums.appendChild(b); });
      };
      tickC(); every(tickC, 1000);
    }

    else if (type === "message") {
      root.style.textAlign = c.align;
      root.style.alignItems = c.align === "left" ? "flex-start" : "center";
      if (c.title) { var mt = el("div", "sw-mtitle", c.title); mt.style.color = c.accent; root.appendChild(mt); }
      if (c.body) root.appendChild(el("div", "sw-body", c.body));
    }
    return api;
  }

  global.SignageWidgets = { render: render, weatherIcon: wmo };
})(window);
