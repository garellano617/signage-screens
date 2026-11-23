/*
 * Signage overlay renderer: draws the specials, text and effects layers on top of the video layer.
 * The same file runs in the portal's live preview and inside the Android player (bundled into the APK),
 * so what you design is what the TV shows. Plain ES2015, no libraries, works offline.
 *
 *   const o = SignageOverlay.render(element, layers, { resolveImage: special => url });
 *   o.destroy();
 */
(function (global) {
  "use strict";

  // Video layer area in % of the screen: [left, top, width, height]. The player uses the same numbers.
  var REGIONS = {
    full: [0, 0, 100, 100], left70: [0, 0, 70, 100], right70: [30, 0, 70, 100],
    top85: [0, 0, 100, 85], left70top85: [0, 0, 70, 85]
  };
  // Font sizes in % of screen width (the root font-size is 1% of the width).
  var SIZE = { s: 2, m: 2.8, l: 4.2, xl: 6.2 };
  var TICKER_SIZE = { s: 1.8, m: 2.4, l: 3.2, xl: 4.2 };
  var SPEED = { slow: 6, normal: 10, fast: 16 }; // % of width per second

  function el(tag, cls, text) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function rgba(hex, opacity) {
    var n = parseInt(String(hex || "#000000").slice(1), 16);
    return "rgba(" + (n >> 16 & 255) + "," + (n >> 8 & 255) + "," + (n & 255) + "," + (opacity / 100) + ")";
  }
  function hm(s) { var p = /^(\d\d):(\d\d)$/.exec(s || ""); return p ? +p[1] * 60 + +p[2] : null; }

  /** Is a special shown right now? days: bit 0 = Monday. Empty times = all day. End before start = overnight. */
  function activeNow(item, date) {
    var d = date || new Date();
    var day = (d.getDay() + 6) % 7, min = d.getHours() * 60 + d.getMinutes();
    var on = function (x) { return (item.days & (1 << ((x + 7) % 7))) !== 0; };
    var s = hm(item.start), e = hm(item.end);
    if (s === null || e === null || s === e) return on(day);
    if (s < e) return on(day) && min >= s && min < e;
    return (on(day) && min >= s) || (on(day - 1) && min < e);
  }

  function render(root, layers, opts) {
    opts = opts || {};
    var resolveImage = opts.resolveImage || function (sp) { return sp.image ? sp.image.src : null; };
    var timers = [], frames = { id: 0 }, cleanups = [];
    root.innerHTML = "";
    root.classList.add("so-root");

    // Room taken by a ticker, so specials and text at that edge move out of its way.
    var tick = layers.text && layers.text.enabled && layers.text.ticker && layers.text.ticker.enabled && (layers.text.ticker.text || "").trim() ? layers.text.ticker : null;
    var tickH = tick ? 1.9 * (TICKER_SIZE[tick.size] || TICKER_SIZE.m) : 0; // in % of screen width
    var avoiders = [];
    var avoid = function (node, edge, gapPct) { if (tick && tick.position === edge) avoiders.push([node, edge, gapPct]); };

    function fit() {
      var unit = root.clientWidth / 100;
      root.style.fontSize = unit + "px";
      avoiders.forEach(function (a) { a[0].style[a[1]] = "calc(" + a[2] + "% + " + (tickH * unit) + "px)"; });
    }
    fit();

    // ---- specials ----
    var sp = layers.specials;
    if (sp && sp.enabled && sp.items && sp.items.length) {
      var panel = el("div", "so-specials so-sp-" + sp.position);
      panel.style.background = sp.bg; panel.style.color = sp.color;
      if (sp.position === "right" || sp.position === "left") { avoid(panel, "bottom", 0); avoid(panel, "top", 0); }
      else if (sp.position === "top-right") avoid(panel, "top", 5);
      else if (sp.position !== "center") avoid(panel, "bottom", 5);
      if (sp.heading) { var hd = el("div", "so-sp-heading", sp.heading); hd.style.color = sp.accent; panel.appendChild(hd); }
      var card = el("div", "so-sp-card");
      panel.appendChild(card);
      var dots = el("div", "so-sp-dots");
      panel.appendChild(dots);
      root.appendChild(panel);
      var idx = -1;
      var show = function () {
        var list = sp.items.filter(function (x) { return activeNow(x); });
        panel.style.display = list.length ? "" : "none";
        if (!list.length) return;
        idx = (idx + 1) % list.length;
        var it = list[idx];
        var next = el("div", "so-sp-item");
        var src = it.image ? resolveImage(it) : null;
        if (src) { var im = el("div", "so-sp-img"); im.style.backgroundImage = "url(\"" + String(src).replace(/"/g, "%22") + "\")"; next.appendChild(im); }
        if (it.title) next.appendChild(el("div", "so-sp-title", it.title));
        if (it.price) { var pr = el("div", "so-sp-price", it.price); pr.style.color = sp.accent; next.appendChild(pr); }
        if (it.description) next.appendChild(el("div", "so-sp-desc", it.description));
        var old = card.firstChild;
        card.appendChild(next);
        // Fade the new card in, then remove the old one.
        requestAnimationFrame(function () { next.classList.add("in"); });
        if (old) { old.classList.remove("in"); setTimeout(function () { if (old.parentNode) old.parentNode.removeChild(old); }, 700); }
        dots.innerHTML = "";
        if (list.length > 1) list.forEach(function (_, i) { var dt = el("span", i === idx ? "on" : ""); if (i === idx) dt.style.background = sp.accent; dots.appendChild(dt); });
      };
      show();
      timers.push(setInterval(show, (sp.seconds || 8) * 1000));
    }

    // ---- text ----
    var tx = layers.text;
    if (tx && tx.enabled) {
      (tx.blocks || []).forEach(function (b) {
        var t = el("div", "so-text so-pos-" + b.position, b.text);
        t.style.fontSize = (SIZE[b.size] || SIZE.m) + "em";
        t.style.fontWeight = b.bold ? "700" : "400";
        t.style.color = b.color;
        t.style.background = rgba(b.bg, b.bgOpacity);
        if (!b.bgOpacity) t.style.textShadow = "0 0.08em 0.3em rgba(0,0,0,.7)";
        if (/^bottom/.test(b.position)) avoid(t, "bottom", 6);
        if (/^top/.test(b.position)) avoid(t, "top", 4);
        root.appendChild(t);
      });
      var tk = tx.ticker;
      if (tk && tk.enabled && tk.text && tk.text.trim()) {
        var bar = el("div", "so-ticker so-ticker-" + tk.position);
        bar.style.background = tk.bg; bar.style.color = tk.color;
        bar.style.fontSize = (TICKER_SIZE[tk.size] || TICKER_SIZE.m) + "em";
        var msgs = tk.text.split(/\n+/).map(function (s) { return s.trim(); }).filter(Boolean);
        var inner = el("div", "so-ticker-inner", msgs.join("     •     "));
        bar.appendChild(inner);
        root.appendChild(bar);
        var x = 0, last = 0, startX = null;
        var step = function (ts) {
          var w = bar.clientWidth, tw = inner.scrollWidth;
          if (startX === null || x < -tw) x = w;
          if (last) x -= (SPEED[tk.speed] || SPEED.normal) / 100 * root.clientWidth * Math.min(0.1, (ts - last) / 1000);
          startX = 0; last = ts;
          inner.style.transform = "translateX(" + x + "px)";
          frames.ticker = requestAnimationFrame(step);
        };
        frames.ticker = requestAnimationFrame(step);
      }
    }

    // ---- effects (top layer) ----
    var ef = layers.effects;
    if (ef && ef.enabled) cleanups.push(effects(root, ef));

    fit();
    var onResize = function () { fit(); };
    var ro = global.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(root); else global.addEventListener("resize", onResize);

    return {
      destroy: function () {
        timers.forEach(clearInterval);
        if (frames.ticker) cancelAnimationFrame(frames.ticker);
        cleanups.forEach(function (f) { f(); });
        if (ro) ro.disconnect(); else global.removeEventListener("resize", onResize);
        root.innerHTML = "";
      }
    };
  }

  // ---- animated effects on a canvas ----
  var COUNTS = { light: 25, medium: 55, heavy: 110 };
  var CONFETTI = ["#f43f5e", "#f59e0b", "#10b981", "#3b82f6", "#a855f7", "#facc15"];
  var LEAVES = ["#c2410c", "#ea580c", "#b45309", "#a16207", "#dc2626"];

  function effects(root, ef) {
    var cv = el("canvas", "so-effects");
    root.appendChild(cv);
    var ctx = cv.getContext("2d");
    var W = 0, H = 0, ps = [], raf = 0, last = 0;
    var type = ef.type, n = COUNTS[ef.intensity] || COUNTS.medium;
    var rising = type === "bubbles" || type === "hearts";
    var twinkle = type === "sparkles" || type === "stars";

    function size() {
      var r = window.devicePixelRatio || 1;
      W = root.clientWidth; H = root.clientHeight;
      cv.width = W * r; cv.height = H * r; ctx.setTransform(r, 0, 0, r, 0, 0);
    }
    function make(initial) {
      var u = W / 100;
      var p = { x: Math.random() * W, y: initial ? Math.random() * H : (rising ? H + 20 : -20),
        s: (0.4 + Math.random()) * u * (type === "snow" ? 0.5 : type === "confetti" ? 0.7 : type === "bubbles" ? 1.4 : 1),
        vy: (0.4 + Math.random() * 0.6) * u * (type === "snow" ? 4 : type === "confetti" ? 9 : type === "leaves" ? 5 : 6),
        sway: Math.random() * Math.PI * 2, rot: Math.random() * Math.PI * 2, vr: (Math.random() - 0.5) * 4,
        life: Math.random(), color: type === "confetti" ? CONFETTI[Math.random() * CONFETTI.length | 0]
          : type === "leaves" ? LEAVES[Math.random() * LEAVES.length | 0] : ef.color };
      return p;
    }
    function heart(s) {
      ctx.beginPath(); ctx.moveTo(0, s * 0.3);
      ctx.bezierCurveTo(0, 0, -s * 0.5, 0, -s * 0.5, s * 0.3); ctx.bezierCurveTo(-s * 0.5, s * 0.6, 0, s * 0.8, 0, s);
      ctx.bezierCurveTo(0, s * 0.8, s * 0.5, s * 0.6, s * 0.5, s * 0.3); ctx.bezierCurveTo(s * 0.5, 0, 0, 0, 0, s * 0.3); ctx.fill();
    }
    function star(s) {
      ctx.beginPath();
      for (var i = 0; i < 10; i++) { var a = i * Math.PI / 5 - Math.PI / 2, r = i % 2 ? s * 0.4 : s; ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r); }
      ctx.closePath(); ctx.fill();
    }
    function frame(ts) {
      var dt = last ? Math.min(0.05, (ts - last) / 1000) : 0; last = ts;
      ctx.clearRect(0, 0, W, H);
      for (var i = 0; i < ps.length; i++) {
        var p = ps[i];
        p.sway += dt * 1.5; p.rot += p.vr * dt;
        ctx.save();
        if (twinkle) {
          p.life += dt * 0.5;
          if (p.life > 1) { ps[i] = make(true); ps[i].life = 0; continue; }
          ctx.globalAlpha = Math.sin(p.life * Math.PI);
          ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.fillStyle = p.color;
          if (type === "stars") star(p.s); else { ctx.fillRect(-p.s * 0.12, -p.s, p.s * 0.24, p.s * 2); ctx.fillRect(-p.s, -p.s * 0.12, p.s * 2, p.s * 0.24); }
        } else {
          p.y += (rising ? -1 : 1) * p.vy * dt;
          p.x += Math.sin(p.sway) * p.s * dt * 2;
          if (p.y > H + 30 || p.y < -30) { ps[i] = make(false); ctx.restore(); continue; }
          ctx.translate(p.x, p.y); ctx.rotate(type === "snow" || type === "bubbles" ? 0 : p.rot);
          ctx.fillStyle = p.color; ctx.strokeStyle = p.color;
          if (type === "snow") { ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(0, 0, p.s, 0, 7); ctx.fill(); }
          else if (type === "bubbles") { ctx.globalAlpha = 0.6; ctx.lineWidth = Math.max(1, p.s / 8); ctx.beginPath(); ctx.arc(0, 0, p.s, 0, 7); ctx.stroke(); }
          else if (type === "confetti") ctx.fillRect(-p.s, -p.s * 0.4, p.s * 2, p.s * 0.8);
          else if (type === "hearts") { ctx.globalAlpha = 0.85; heart(p.s * 1.6); }
          else if (type === "leaves") { ctx.beginPath(); ctx.ellipse(0, 0, p.s * 1.3, p.s * 0.6, 0, 0, 7); ctx.fill(); }
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(frame);
    }
    size();
    for (var i = 0; i < n; i++) ps.push(make(true));
    raf = requestAnimationFrame(frame);
    var onResize = function () { size(); };
    global.addEventListener("resize", onResize);
    return function () { cancelAnimationFrame(raf); global.removeEventListener("resize", onResize); };
  }

  global.SignageOverlay = { render: render, activeNow: activeNow, REGIONS: REGIONS };
})(window);
