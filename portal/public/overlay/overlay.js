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
  // System fonts only (the TV works offline). Android names: sans-serif-condensed, serif, monospace, cursive.
  var FONTS = {
    // Bundled variable fonts first (overlay.css), so thickness can be any value and the portal matches the TV.
    sans: "\"SO Roboto\", \"Segoe UI\", Roboto, \"Helvetica Neue\", Arial, sans-serif",
    serif: "\"SO Noto Serif\", Georgia, \"Times New Roman\", \"Noto Serif\", serif",
    condensed: "\"SO Roboto Condensed\", \"Roboto Condensed\", \"Arial Narrow\", \"sans-serif-condensed\", sans-serif",
    mono: "\"SO Roboto Mono\", Consolas, \"Roboto Mono\", \"Courier New\", monospace",
    script: "\"SO Dancing Script\", \"Segoe Script\", \"Brush Script MT\", \"Dancing Script\", cursive"
  };

  // Vector shapes for the text & pictures layer: [label, SVG drawn in a 100 x 100 box that stretches to the shape's
  // width and height, starting width / height in % of the screen width, no fill by default].
  function starPts(n, outer, inner) {
    var p = [];
    for (var i = 0; i < n * 2; i++) { var a = Math.PI * i / n - Math.PI / 2, r = i % 2 ? inner : outer; p.push((50 + r * Math.cos(a)).toFixed(1) + "," + (50 + r * Math.sin(a)).toFixed(1)); }
    return '<polygon points="' + p.join(" ") + '"/>';
  }
  var SHAPES = {
    square: ["Square", '<rect x="0" y="0" width="100" height="100"/>', 18, 18],
    rect: ["Rectangle", '<rect x="0" y="0" width="100" height="100"/>', 30, 15],
    rounded: ["Rounded box", '<rect x="0" y="0" width="100" height="100" rx="14" ry="14"/>', 30, 15],
    circle: ["Circle", '<ellipse cx="50" cy="50" rx="50" ry="50"/>', 18, 18],
    oval: ["Oval", '<ellipse cx="50" cy="50" rx="50" ry="50"/>', 30, 17],
    triangle: ["Triangle", '<polygon points="50,0 100,100 0,100"/>', 18, 16],
    rtriangle: ["Right triangle", '<polygon points="0,0 100,100 0,100"/>', 18, 16],
    diamond: ["Diamond", '<polygon points="50,0 100,50 50,100 0,50"/>', 16, 16],
    wave: ["Wave", '<path d="M0 35 C17 5 33 5 50 35 S83 65 100 35 V100 H0 Z"/>', 100, 18],
    waves: ["Waves", '<path d="M0 40 Q12.5 15 25 40 T50 40 T75 40 T100 40 V100 H0 Z"/>', 100, 14],
    waveline: ["Wavy line", '<path d="M0 50 Q12.5 10 25 50 T50 50 T75 50 T100 50"/>', 40, 6, true],
    star: ["Star", starPts(5, 50, 21), 16, 16],
    burst: ["Price burst", starPts(16, 50, 40), 18, 18],
    arrow: ["Arrow", '<polygon points="0,32 64,32 64,0 100,50 64,100 64,68 0,68"/>', 24, 12],
    banner: ["Banner", '<polygon points="0,0 100,0 92,50 100,100 0,100 8,50"/>', 40, 10],
    bubble: ["Speech bubble", '<path d="M10 0 H90 Q100 0 100 10 V68 Q100 78 90 78 H40 L20 100 L24 78 H10 Q0 78 0 68 V10 Q0 0 10 0 Z"/>', 26, 18],
    heart: ["Heart", '<path d="M50 96 C18 72 0 54 0 30 C0 12 13 0 29 0 C39 0 46 6 50 13 C54 6 61 0 71 0 C87 0 100 12 100 30 C100 54 82 72 50 96 Z"/>', 16, 15],
    line: ["Line", '<rect x="0" y="0" width="100" height="100"/>', 40, 0.8]
  };
  function shapeSvg(b) {
    var sh = SHAPES[b.shape] || SHAPES.square;
    var fill = sh[4] ? "none" : rgba(b.fill || "#dc2626", b.fillOpacity === undefined ? 100 : b.fillOpacity);
    var sw = b.sw || (sh[4] ? 0.6 : 0);
    // The border keeps its thickness (in % of the screen width) however the shape is stretched.
    var rot = b.rot ? "transform:rotate(" + b.rot + "deg);" : "";
    return '<svg viewBox="0 0 100 100" preserveAspectRatio="none" style="display:block;width:100%;height:100%;overflow:visible;' + rot + '">' +
      '<g fill="' + fill + '" stroke="' + (sw ? b.stroke || "#ffffff" : "none") + '" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke" style="stroke-width:' + sw + 'em">' +
      sh[1].replace(/\/>/g, ' vector-effect="non-scaling-stroke"/>') + '</g></svg>';
  }

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

  // The CSS transform each snap-to position already uses (kept under the transition's own movement).
  var POS_TRANSFORM = { top: "translateX(-50%) ", bottom: "translateX(-50%) ", left: "translateY(-50%) ", right: "translateY(-50%) ", center: "translate(-50%, -50%) " };
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  function easeBack(p) { var c = 1.7; return 1 + (c + 1) * Math.pow(p - 1, 3) + c * Math.pow(p - 1, 2); }
  /** A transition at progress q (0 = gone, 1 = fully in). out = on the way out. Returns opacity and the extra transform. */
  function motion(kind, q, out, W, H) {
    if (q >= 1 || kind === "none") return { o: 1, t: "" };
    q = Math.max(0, q);
    var e = easeOut(q), fade = Math.min(1, q * 3);
    switch (kind) {
      case "fade": return { o: e, t: "" };
      case "small": return { o: fade, t: "scale(" + (0.15 + 0.85 * e) + ")" };
      case "big": return { o: fade, t: "scale(" + (2.6 - 1.6 * e) + ")" };
      case "left": return { o: 1, t: "translateX(" + (-(1 - e) * W) + "px)" };
      case "right": return { o: 1, t: "translateX(" + ((1 - e) * W) + "px)" };
      case "top": return { o: 1, t: "translateY(" + (-(1 - e) * H) + "px)" };
      case "bottom": return { o: 1, t: "translateY(" + ((1 - e) * H) + "px)" };
      case "spin": return { o: fade, t: "rotate(" + ((1 - e) * (out ? 360 : -360)) + "deg) scale(" + e + ")" };
      case "pop": return { o: fade, t: "scale(" + Math.max(0, easeBack(q)) + ")" };
      case "flip": return { o: fade, t: "perspective(60em) rotateY(" + ((1 - e) * (out ? -90 : 90)) + "deg)" };
    }
    return { o: 1, t: "" };
  }

  // Shadow and glow sizes for big text stop growing past what they'd be on 6%-of-the-width text.
  // Huge blurs get drawn at low resolution by TV graphics chips and look blocky around the letters.
  function shadowScale(b) { var fs = b.fs || SIZE[b.size] || SIZE.m; return Math.min(1, 6 / fs); }
  function em(v, k) { return Math.round(v * k * 1000) / 1000 + "em"; }

  /** Glow, neon, shadow, shine or grow on a text or picture block (b.fx, colored b.fxColor). */
  /**
   * A text block's words with its spacing: b.ls letter spacing (em) and b.lh line spacing for the whole text;
   * b.runs [{ s, e, ls }] letter spacing for parts (character positions); b.llh [line spacing or null per line].
   */
  function fillText(t, b) {
    var text = b.text || "";
    if (b.ls) t.style.letterSpacing = b.ls + "em";
    if (b.lh) t.style.lineHeight = String(b.lh);
    var ok = function (r) { return r && r.e > r.s; };
    // Parts: letter spacing (b.runs: ls) and thickness (b.wruns: wt).
    var runs = (b.runs || []).filter(ok), wruns = (b.wruns || []).filter(ok);
    var llh = b.llh || [];
    var anyLine = false;
    for (var k = 0; k < llh.length; k++) if (llh[k]) anyLine = true;
    if (!runs.length && !wruns.length && !anyLine) { t.textContent = text; return; }
    var all = runs.concat(wruns);
    var covering = function (list, a, z) { var hit = null; list.forEach(function (r) { if (r.s <= a && r.e >= z) hit = r; }); return hit; };
    var pos = 0;
    text.split("\n").forEach(function (line, li) {
      var ln = el("span", "so-line");
      if (llh[li]) ln.style.lineHeight = String(llh[li]);
      var start = pos, end = pos + line.length, cuts = [start, end];
      all.forEach(function (r) {
        if (r.s > start && r.s < end) cuts.push(r.s);
        if (r.e > start && r.e < end) cuts.push(r.e);
      });
      cuts.sort(function (a, c) { return a - c; });
      for (var i = 0; i < cuts.length - 1; i++) {
        var a = cuts[i], z = cuts[i + 1];
        if (z <= a) continue;
        var run = covering(runs, a, z), wr = covering(wruns, a, z);
        var seg = text.slice(a, z);
        if (run || wr) {
          var sp = el("span", "", seg);
          if (run) sp.style.letterSpacing = run.ls + "em";
          if (wr) sp.style.fontWeight = String(wr.wt);
          ln.appendChild(sp);
        } else ln.appendChild(document.createTextNode(seg));
      }
      // An empty line still takes its height.
      if (!line.length) ln.appendChild(document.createTextNode("​"));
      t.appendChild(ln);
      pos = end + 1;
    });
  }

  function renderWallDesign(root, layers, opts) {
    var v = layers.view;
    root.innerHTML = "";
    root.classList.add("so-root");
    root.style.background = "";
    var big = el("div", "so-wallbig"), fxBox = el("div", "so-wallfx");
    root.appendChild(big); root.appendChild(fxBox);
    var place = function () {
      var W = root.clientWidth, H = root.clientHeight, g = (v.gap || 0) * W;
      big.style.left = -(v.col * (W + g)) + "px"; big.style.top = -(v.row * (H + g)) + "px";
      big.style.right = "auto"; big.style.bottom = "auto";
      big.style.width = (v.cols * W + (v.cols - 1) * g) + "px"; big.style.height = (v.rows * H + (v.rows - 1) * g) + "px";
    };
    place();
    var inner = render(big, Object.assign({}, layers, { view: null, effects: { enabled: false } }), Object.assign({}, opts, { wallInner: true, syncVideos: true }));
    var fx = render(fxBox, { video: layers.video, specials: { enabled: false }, text: { enabled: false }, effects: layers.effects,
      view: { cols: v.cols, rows: v.rows, col: v.col, row: v.row, gap: v.gap } }, opts);
    var ro = global.ResizeObserver ? new ResizeObserver(place) : null;
    if (ro) ro.observe(root); else global.addEventListener("resize", place);
    return { destroy: function () { inner.destroy(); fx.destroy(); if (ro) ro.disconnect(); else global.removeEventListener("resize", place); } };
  }

  function textFx(t, b) {
    var c = b.fxColor || "#facc15", img = t.querySelector("img") || t.querySelector("svg"), k = shadowScale(b);
    t.className += " so-fx-" + b.fx;
    if (b.fx === "glow" || b.fx === "neon" || b.fx === "shadow") {
      if (img) {
        img.style.filter = b.fx === "shadow" ? "drop-shadow(.4em .4em .35em " + c + ")"
          : b.fx === "glow" ? "drop-shadow(0 0 .3em " + c + ") drop-shadow(0 0 .8em " + c + ")"
          : "drop-shadow(0 0 .15em #fff) drop-shadow(0 0 .4em " + c + ") drop-shadow(0 0 1em " + c + ")";
      } else {
        t.style.textShadow = b.fx === "shadow" ? em(.06, k) + " " + em(.06, k) + " 0 " + c + ", " + em(.1, k) + " " + em(.12, k) + " " + em(.3, k) + " rgba(0,0,0,.6)"
          : b.fx === "glow" ? "0 0 " + em(.1, k) + " " + c + ", 0 0 " + em(.3, k) + " " + c + ", 0 0 " + em(.6, k) + " " + c
          : "0 0 " + em(.04, k) + " #fff, 0 0 " + em(.1, k) + " " + c + ", 0 0 " + em(.25, k) + " " + c + ", 0 0 " + em(.5, k) + " " + c + ", 0 0 " + em(1, k) + " " + c;
      }
      return;
    }
    // Shine and grow animate an inner wrapper, so they don't fight the block's position or its transitions.
    var inner = el(img ? "div" : "span", "so-fx-in");
    while (t.firstChild) inner.appendChild(t.firstChild);
    t.appendChild(inner);
    if (b.fx === "shine" && !img) {
      var col = b.color || "#ffffff";
      inner.style.backgroundImage = "linear-gradient(110deg, " + col + " 42%, " + c + " 50%, " + col + " 58%)";
      inner.style.filter = "drop-shadow(0 " + em(.06, k) + " " + em(.15, k) + " rgba(0,0,0,.55))";
    }
    if (b.fx === "shine" && img && img.src) {
      // The light band stays inside the picture (not over its see-through parts).
      var m = "url(\"" + String(img.src).replace(/"/g, "%22") + "\")";
      inner.style.webkitMaskImage = m; inner.style.maskImage = m;
      inner.style.webkitMaskSize = "100% 100%"; inner.style.maskSize = "100% 100%";
      inner.appendChild(el("span", "so-fx-band"));
    }
  }

  function render(root, layers, opts) {
    opts = opts || {};
    // Video wall with a design: draw the whole wall's design in a box the size of the wall, shifted so this screen
    // shows only its part (the screen clips the rest). Wall effects are drawn separately, as before (view).
    if (layers.view && layers.view.design && !opts.wallInner) return renderWallDesign(root, layers, opts);
    var resolveImage = opts.resolveImage || function (sp) { return sp.image ? sp.image.src : null; };
    var timers = [], frames = { id: 0 }, cleanups = [];
    root.innerHTML = "";
    root.classList.add("so-root");
    // The design's background colour (screens show only their design); none = whatever is behind (black on the TV).
    root.style.background = layers.background || "";

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

    // ---- text and images ----
    var tx = layers.text;
    if (tx && tx.enabled) {
      var timed = [];
      var widgetBoxes = [];
      var videos = [];
      var cycle = tx.cycle || 0;
      (tx.blocks || []).forEach(function (b, i) {
        var free = typeof b.x === "number" && typeof b.y === "number";
        var t = el("div", "so-text " + (free ? "so-free" : "so-pos-" + b.position));
        if (b.kind === "video") {
          // A video in a box. Muted unless it has sound on (the TV allows sound; browsers only play muted by themselves).
          var vsrc = b.image ? resolveImage(b) : null;
          if (!vsrc) return;
          t.className += " so-videobox";
          t.style.width = (b.w || 40) + "em";
          t.style.height = (b.h || 22.5) + "em";
          var vid = document.createElement("video");
          vid.src = vsrc; vid.loop = true; vid.autoplay = true; vid.playsInline = true; vid.setAttribute("playsinline", "");
          vid.muted = !(b.sound && opts.allowSound);
          vid.style.objectFit = b.fit === "contain" ? "contain" : "cover";
          t.appendChild(vid);
          videos.push(vid);
        } else if (b.kind === "widget") {
          // A widget (clock, weather, news…) in a box; drawn once the box is on the page (it sizes itself to the box).
          if (!b.widget || !global.SignageWidgets) return;
          t.className += " so-widgetbox";
          t.style.width = (b.w || 30) + "em";
          t.style.height = (b.h || 17) + "em";
          widgetBoxes.push([t, b]);
        } else if (b.kind === "shape") {
          t.className += " so-shape";
          t.innerHTML = shapeSvg(b);
          var shd = SHAPES[b.shape] || SHAPES.square;
          t.style.width = (b.w || shd[2]) + "em";
          t.style.height = (b.h || shd[3]) + "em";
        } else if (b.kind === "image") {
          var src = b.image ? resolveImage(b) : null;
          if (!src) return;
          t.className += " so-image";
          var im = el("img");
          im.src = src; im.alt = "";
          t.appendChild(im);
          t.style.width = (b.w || 30) + "em";
        } else {
          fillText(t, b);
          t.style.fontSize = (b.fs || SIZE[b.size] || SIZE.m) + "em";
          // Thickness: any value 100-900 (b.wt), else bold or normal.
          t.style.fontWeight = String(b.wt || (b.bold ? 700 : 400));
          if (b.italic) t.style.fontStyle = "italic";
          t.style.fontFamily = FONTS[b.font] || FONTS.sans;
          t.style.color = b.color;
          if (!b.bgOpacity && (!b.fx || b.fx === "none" || b.fx === "shine" || b.fx === "grow")) { var k0 = shadowScale(b); t.style.textShadow = "0 " + em(.08, k0) + " " + em(.3, k0) + " rgba(0,0,0,.7)"; }
          // Width is in % of the screen; this element's em is its own font size, so divide by it.
          if (b.w) { t.style.width = (b.w / (b.fs || SIZE[b.size] || SIZE.m)) + "em"; t.style.maxWidth = "none"; }
        }
        if (b.align) t.style.textAlign = b.align;
        // Over the Specials panel (z-index 1); still under the ticker and effects (appended later at z-index 2 / 3).
        if (b.above) t.style.zIndex = "2";
        if (b.fx && b.fx !== "none") textFx(t, b);
        t.style.background = rgba(b.bg, b.bgOpacity || 0);
        if (free) { t.style.left = b.x + "%"; t.style.top = b.y + "%"; }
        else {
          if (/^bottom/.test(b.position)) avoid(t, "bottom", 6);
          if (/^top/.test(b.position)) avoid(t, "top", 4);
        }
        var from = cycle ? b.from || 0 : 0, to = cycle ? b.to || cycle : 0;
        timed.push({ node: t, track: b.track || 0, from: from, to: to, base: free ? "" : (POS_TRANSFORM[b.position] || ""),
          timed: !!(cycle && (b.from || b.to)), inT: b.enter || "none", outT: cycle ? b.exit || "none" : "none",
          dIn: b.enter && b.enter !== "none" ? b.td || 1 : 0, dOut: cycle && b.exit && b.exit !== "none" ? b.td || 1 : 0, last: "" });
        root.appendChild(t);
        if (opts.onBlock) opts.onBlock(t, b, i);
      });
      // Videos: start playing; on a video wall (opts.now = the portal's clock) every TV keeps the same moment of the video.
      videos.forEach(function (vid) {
        var p = vid.play && vid.play(); if (p && p.catch) p.catch(function () { vid.muted = true; vid.play(); });
        if (!layers.view && !opts.syncVideos) return;
        var clock = opts.now || Date.now;
        var sync = function () {
          if (!vid.duration || !isFinite(vid.duration)) return;
          var want = (clock() / 1000) % vid.duration, off = vid.currentTime - want;
          if (Math.abs(off) > vid.duration / 2) off -= vid.duration * (off > 0 ? 1 : -1);
          if (Math.abs(off) > 0.25) vid.currentTime = want;
        };
        vid.addEventListener("loadedmetadata", sync);
        timers.push(setInterval(sync, 3000));
      });
      // Widgets: live data from opts.widgetData (portal preview) or b.widgetData (the TV puts it in the layers).
      widgetBoxes.forEach(function (x) {
        var box = el("div", "so-wbox");
        x[0].appendChild(box);
        var data = opts.widgetData ? opts.widgetData(x[1]) : (x[1].widgetData || null);
        try {
          var w = global.SignageWidgets.render(box, x[1].widget, data, {});
          cleanups.push(function () { w.destroy(); });
        } catch (e) { /* a broken widget shouldn't stop the rest of the design */ }
      });
      // Blocks show from..to seconds into each cycle (with no timing: all the time). The editor passes its playhead as opts.time.
      // Blocks on the same timeline row that overlap: the overlap is the transition (a crossfade unless another one is picked).
      if (cycle) {
        var rows = {};
        timed.forEach(function (x) { if (x.timed) (rows[x.track] = rows[x.track] || []).push(x); });
        Object.keys(rows).forEach(function (k) {
          var list = rows[k].sort(function (a, b) { return a.from - b.from; });
          for (var i = 1; i < list.length; i++) {
            var a = list[i - 1], b = list[i], o = a.to - b.from;
            if (o <= 0 || b.to <= a.to) continue;
            a.dOut = o; if (a.outT === "none") a.outT = "fade";
            b.dIn = o; if (b.inT === "none") b.inT = "fade";
          }
        });
      }
      timed.forEach(function (x) { var len = x.timed ? x.to - x.from : Infinity; x.dIn = Math.min(x.dIn, len / 2); x.dOut = Math.min(x.dOut, len / 2); });
      var moving = timed.some(function (x) { return x.dIn || x.dOut; });
      if (timed.length && (cycle || moving)) {
        var clock = opts.time || function () { return Date.now() / 1000; };
        var started = clock();
        var tickTimed = function () {
          var now = clock(), s = cycle ? ((now % cycle) + cycle) % cycle : now - started;
          var W = root.clientWidth, H = root.clientHeight;
          timed.forEach(function (x) {
            var vis = true, q = 1, kind = "none", out = false;
            var from = x.timed ? x.from : 0, to = x.timed ? x.to : (cycle || Infinity);
            if (s < from || s >= to) vis = false;
            else {
              var a = x.dIn ? (s - from) / x.dIn : 1, z = x.dOut ? (to - s) / x.dOut : 1;
              if (a < 1 && a <= z) { q = a; kind = x.inT; } else if (z < 1) { q = z; kind = x.outT; out = true; }
            }
            var key = vis ? kind + ":" + Math.round(q * 200) : "hidden";
            if (key === x.last) return;
            x.last = key;
            var st = x.node.style;
            if (!vis) { st.visibility = "hidden"; return; }
            st.visibility = "";
            var base = x.node.classList.contains("so-free") ? "" : x.base;
            var m = motion(kind, q, out, W, H);
            st.opacity = m.o === 1 ? "" : String(m.o);
            st.transform = m.t ? base + m.t : base;
          });
        };
        tickTimed();
        if (moving) {
          var loop = function () { tickTimed(); frames.timed = requestAnimationFrame(loop); };
          frames.timed = requestAnimationFrame(loop);
        } else timers.push(setInterval(tickTimed, 200));
      }
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
    // On a video wall (layers.view) and for the scene effects, effects are drawn from the clock so every
    // screen of the wall draws its own part of the same picture. opts.now: shared clock in ms (the player
    // passes the portal's clock).
    var ef = layers.effects;
    if (ef && ef.enabled) cleanups.push(layers.view || SCENES[ef.type] ? scene(root, ef, layers.view, opts.now || Date.now) : effects(root, ef));

    fit();
    var onResize = function () { fit(); };
    var ro = global.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(root); else global.addEventListener("resize", onResize);

    return {
      destroy: function () {
        timers.forEach(clearInterval);
        if (frames.ticker) cancelAnimationFrame(frames.ticker);
        if (frames.timed) cancelAnimationFrame(frames.timed);
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

  // ---- clock-driven effects: the same on every screen of a video wall ----
  // Every position is worked out from the time alone (no randomness that differs between screens), in the
  // coordinates of the whole wall. Each screen then draws only its own part. One screen = a 1 × 1 wall.
  var SCENES = { santa: 1, fireworks: 1, shooting: 1, balloons: 1, plane: 1 };
  var BALLOONS = ["#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#a855f7", "#ec4899", "#facc15"];
  var FIREWORKS = ["#f87171", "#fbbf24", "#34d399", "#60a5fa", "#c084fc", "#f472b6", "#ffffff"];
  function rnd(a, b) { var x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); }
  function mod(a, n) { return ((a % n) + n) % n; }

  function scene(root, ef, view, now) {
    var cv = el("canvas", "so-effects");
    root.appendChild(cv);
    var ctx = cv.getContext("2d");
    var v = view || { cols: 1, rows: 1, col: 0, row: 0, gap: 0 };
    var W = 0, H = 0, VW = 0, VH = 0, OX = 0, OY = 0, raf = 0;
    var type = ef.type, base = COUNTS[ef.intensity] || COUNTS.medium;

    function size() {
      var r = window.devicePixelRatio || 1;
      W = root.clientWidth; H = root.clientHeight;
      cv.width = W * r; cv.height = H * r; ctx.setTransform(r, 0, 0, r, 0, 0);
      var g = (v.gap || 0) * W;
      VW = v.cols * W + (v.cols - 1) * g; VH = v.rows * H + (v.rows - 1) * g;
      OX = v.col * (W + g); OY = v.row * (H + g);
    }

    // Falling / rising / twinkling particles, the same kinds as the single-screen effects.
    function particles(kind, t, count, color) {
      var u = W / 100, n = Math.min(900, Math.round(count * v.cols * v.rows));
      var rising = kind === "bubbles" || kind === "hearts" || kind === "balloons";
      var twinkle = kind === "sparkles" || kind === "stars";
      for (var k = 0; k < n; k++) {
        var s = (0.4 + rnd(k, 1)) * u * (kind === "snow" ? 0.5 : kind === "confetti" ? 0.7 : kind === "bubbles" ? 1.4 : kind === "balloons" ? 2.2 : 1);
        ctx.save();
        if (twinkle) {
          var life = t * 0.5 + rnd(k, 7), round = Math.floor(life);
          ctx.globalAlpha = Math.sin((life - round) * Math.PI);
          ctx.translate(rnd(k * 31 + round, 1) * VW, rnd(k * 31 + round, 2) * VH);
          ctx.rotate(rnd(k, 5) * 6.28);
          ctx.fillStyle = color;
          if (kind === "stars") star(s); else { ctx.fillRect(-s * 0.12, -s, s * 0.24, s * 2); ctx.fillRect(-s, -s * 0.12, s * 2, s * 0.24); }
          ctx.restore();
          continue;
        }
        var vy = (0.4 + rnd(k, 2) * 0.6) * u * (kind === "snow" ? 4 : kind === "confetti" ? 9 : kind === "leaves" ? 5 : kind === "balloons" ? 4 : 6);
        var travel = VH + 8 * s + 60;
        var y = mod(t * vy + rnd(k, 3) * travel, travel) - 4 * s - 30;
        if (rising) y = VH - y;
        var x = rnd(k, 4) * VW + Math.sin(t * 1.5 + rnd(k, 6) * 6.28) * s * 1.5;
        ctx.translate(x, y);
        ctx.rotate(kind === "snow" || kind === "bubbles" || kind === "balloons" ? Math.sin(t + k) * 0.08 : rnd(k, 8) * 6.28 + t * (rnd(k, 9) - 0.5) * 4);
        ctx.fillStyle = kind === "confetti" ? CONFETTI[k % CONFETTI.length] : kind === "leaves" ? LEAVES[k % LEAVES.length] : color;
        ctx.strokeStyle = ctx.fillStyle;
        if (kind === "snow") { ctx.globalAlpha = 0.85; ctx.beginPath(); ctx.arc(0, 0, s, 0, 7); ctx.fill(); }
        else if (kind === "bubbles") { ctx.globalAlpha = 0.6; ctx.lineWidth = Math.max(1, s / 8); ctx.beginPath(); ctx.arc(0, 0, s, 0, 7); ctx.stroke(); }
        else if (kind === "confetti") ctx.fillRect(-s, -s * 0.4, s * 2, s * 0.8);
        else if (kind === "hearts") { ctx.globalAlpha = 0.85; heart(s * 1.6); }
        else if (kind === "leaves") { ctx.beginPath(); ctx.ellipse(0, 0, s * 1.3, s * 0.6, 0, 0, 7); ctx.fill(); }
        else if (kind === "balloons") balloon(s, BALLOONS[k % BALLOONS.length]);
        ctx.restore();
      }
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
    function balloon(s, c) {
      ctx.globalAlpha = 0.95;
      ctx.strokeStyle = "rgba(255,255,255,.7)"; ctx.lineWidth = Math.max(1, s / 14);
      ctx.beginPath(); ctx.moveTo(0, s * 1.2); ctx.quadraticCurveTo(s * 0.3, s * 2.2, 0, s * 3.2); ctx.stroke();
      ctx.fillStyle = c; ctx.beginPath(); ctx.ellipse(0, 0, s, s * 1.2, 0, 0, 7); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 0.15, s * 1.15); ctx.lineTo(s * 0.15, s * 1.15); ctx.lineTo(0, s * 1.35); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,.35)"; ctx.beginPath(); ctx.ellipse(-s * 0.35, -s * 0.45, s * 0.2, s * 0.35, -0.5, 0, 7); ctx.fill();
    }

    // One reindeer, facing right, at its hooves' level. a = gallop phase.
    function reindeer(x, y, u, a, rudolph) {
      ctx.save(); ctx.translate(x, y);
      ctx.strokeStyle = "#5b3a1e"; ctx.lineCap = "round"; ctx.lineWidth = u * 0.32;
      var legs = [[-1.1, 0], [-0.7, 1.6], [0.8, 0.8], [1.2, 2.4]];
      legs.forEach(function (l) { var sw = Math.sin(a + l[1]) * 0.6; ctx.beginPath(); ctx.moveTo(l[0] * u, -1.6 * u); ctx.lineTo((l[0] + sw) * u, 0); ctx.stroke(); });
      ctx.fillStyle = "#8b5a2b";
      ctx.beginPath(); ctx.ellipse(0, -2.1 * u, 1.9 * u, 0.85 * u, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#f5e6d3"; ctx.beginPath(); ctx.ellipse(-1.9 * u, -2.3 * u, 0.35 * u, 0.3 * u, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#8b5a2b";
      ctx.beginPath(); ctx.moveTo(1.3 * u, -2.6 * u); ctx.lineTo(2.1 * u, -3.9 * u); ctx.lineTo(2.6 * u, -3.6 * u); ctx.lineTo(1.9 * u, -2.2 * u); ctx.fill();
      ctx.beginPath(); ctx.ellipse(2.6 * u, -3.9 * u, 0.75 * u, 0.45 * u, 0.25, 0, 7); ctx.fill();
      ctx.strokeStyle = "#e8d5b5"; ctx.lineWidth = u * 0.18;
      ctx.beginPath(); ctx.moveTo(2.3 * u, -4.2 * u); ctx.lineTo(1.9 * u, -5.3 * u); ctx.moveTo(2.05 * u, -4.8 * u); ctx.lineTo(1.5 * u, -5.1 * u);
      ctx.moveTo(2.6 * u, -4.25 * u); ctx.lineTo(2.9 * u, -5.4 * u); ctx.moveTo(2.8 * u, -4.9 * u); ctx.lineTo(3.3 * u, -5.2 * u); ctx.stroke();
      ctx.fillStyle = "#111"; ctx.beginPath(); ctx.arc(2.75 * u, -4.05 * u, 0.12 * u, 0, 7); ctx.fill();
      if (rudolph) {
        ctx.shadowColor = "#ff2a2a"; ctx.shadowBlur = u * 2;
        ctx.fillStyle = "#ff2a2a"; ctx.beginPath(); ctx.arc(3.35 * u, -3.75 * u, 0.32 * u, 0, 7); ctx.fill();
        ctx.shadowBlur = 0;
      } else { ctx.fillStyle = "#3b2414"; ctx.beginPath(); ctx.arc(3.3 * u, -3.75 * u, 0.2 * u, 0, 7); ctx.fill(); }
      ctx.restore();
    }
    // Santa in his sleigh, facing right; (x, y) = bottom of the runners.
    function sleigh(x, y, u) {
      ctx.save(); ctx.translate(x, y);
      ctx.strokeStyle = "#d4af37"; ctx.lineWidth = u * 0.3; ctx.lineCap = "round";
      ctx.beginPath(); ctx.moveTo(-3.6 * u, 0); ctx.lineTo(3.2 * u, 0); ctx.quadraticCurveTo(4.6 * u, 0, 4.4 * u, -1.4 * u); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(-2.4 * u, 0); ctx.lineTo(-2.4 * u, -0.9 * u); ctx.moveTo(2 * u, 0); ctx.lineTo(2 * u, -0.9 * u); ctx.stroke();
      ctx.fillStyle = "#b91c1c";
      ctx.beginPath(); ctx.moveTo(-3.8 * u, -4 * u); ctx.quadraticCurveTo(-3.4 * u, -0.9 * u, -1.6 * u, -0.9 * u); ctx.lineTo(2.4 * u, -0.9 * u);
      ctx.quadraticCurveTo(3.6 * u, -1.2 * u, 3.4 * u, -2.6 * u); ctx.lineTo(-2.6 * u, -2.6 * u); ctx.quadraticCurveTo(-2.9 * u, -3.6 * u, -3.8 * u, -4 * u); ctx.fill();
      ctx.strokeStyle = "#d4af37"; ctx.lineWidth = u * 0.15;
      ctx.beginPath(); ctx.moveTo(-2.6 * u, -1.7 * u); ctx.lineTo(3.2 * u, -1.7 * u); ctx.stroke();
      ctx.fillStyle = "#7c4a1f"; ctx.beginPath(); ctx.ellipse(-2.2 * u, -3.3 * u, 1.1 * u, 1.2 * u, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#16a34a"; ctx.fillRect(-2.6 * u, -4.2 * u, 0.8 * u, 0.6 * u);
      ctx.fillStyle = "#facc15"; ctx.fillRect(-2.3 * u, -4.2 * u, 0.2 * u, 0.6 * u);
      ctx.fillStyle = "#dc2626"; ctx.beginPath(); ctx.ellipse(0.4 * u, -3.4 * u, 1.3 * u, 1.2 * u, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = "#dc2626"; ctx.lineWidth = u * 0.45;
      ctx.beginPath(); ctx.moveTo(1.2 * u, -3.6 * u); ctx.lineTo(2.6 * u, -3.1 * u); ctx.stroke();
      ctx.fillStyle = "#f8d7b8"; ctx.beginPath(); ctx.arc(0.7 * u, -5 * u, 0.7 * u, 0, 7); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.ellipse(0.85 * u, -4.5 * u, 0.75 * u, 0.6 * u, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#dc2626"; ctx.beginPath(); ctx.moveTo(-0.1 * u, -5.4 * u); ctx.lineTo(1.4 * u, -5.4 * u); ctx.lineTo(-0.6 * u, -6.6 * u); ctx.fill();
      ctx.fillStyle = "#ffffff"; ctx.fillRect(-0.15 * u, -5.6 * u, 1.6 * u, 0.35 * u);
      ctx.beginPath(); ctx.arc(-0.65 * u, -6.6 * u, 0.3 * u, 0, 7); ctx.fill();
      ctx.restore();
    }
    // Santa's sleigh and reindeer fly across the whole wall every `every` seconds, with a sparkle trail.
    function santa(t) {
      var u = H / 40, speed = W * 0.2, team = 4, gap = 7.2 * u;
      var len = 9 * u + team * gap;
      var flight = (VW + len * 2) / speed;
      var every = Math.max(ef.every || 30, flight + 2);
      var c = Math.floor(t / every), ph = t - c * every;
      if (ph > flight) return;
      var y0 = VH * (0.18 + 0.32 * rnd(c, 1));
      var x = -len + ph * speed;
      var yAt = function (xx) { return y0 + Math.sin(xx / W * 2.2 + c) * H * 0.05 - (xx / VW) * H * 0.08; };
      for (var i = 1; i <= 26; i++) {
        var tx = x - 4.5 * u - i * u * 1.1, a = 1 - i / 27;
        ctx.globalAlpha = a * (0.5 + 0.5 * Math.sin(t * 12 + i));
        ctx.fillStyle = i % 3 ? "#fff7c2" : "#ffffff";
        ctx.beginPath(); ctx.arc(tx + Math.sin(i * 3.1 + t * 4) * u * 0.6, yAt(tx) - 1.5 * u + Math.cos(i * 2.3) * u, u * 0.28 * a + u * 0.08, 0, 7); ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = "#d4af37"; ctx.lineWidth = Math.max(1, u * 0.12);
      ctx.beginPath(); ctx.moveTo(x + 2.6 * u, yAt(x) - 3.1 * u);
      for (var j = 0; j < team; j++) { var rx = x + 6.5 * u + j * gap; ctx.lineTo(rx, yAt(rx) - 2.2 * u); }
      ctx.stroke();
      for (var k = team - 1; k >= 0; k--) { var px = x + 6.5 * u + k * gap; reindeer(px, yAt(px), u, t * 9 + k * 0.9, k === team - 1); }
      sleigh(x, yAt(x), u);
    }
    // Fireworks bursting all over the wall.
    function fireworks(t) {
      var slot = ef.intensity === "heavy" ? 0.45 : ef.intensity === "light" ? 1.4 : 0.8;
      var cur = Math.floor(t / slot), u = W / 100;
      for (var b = cur - 5; b <= cur; b++) {
        var age = t - b * slot;
        if (age < 0 || age > 2.8) continue;
        var cx = VW * (0.05 + 0.9 * rnd(b, 1)), cy = VH * (0.12 + 0.45 * rnd(b, 2));
        var col = FIREWORKS[Math.floor(rnd(b, 3) * FIREWORKS.length)];
        if (age < 0.6) {
          var p = age / 0.6, ry = VH + (cy - VH) * (1 - (1 - p) * (1 - p));
          ctx.globalAlpha = 1; ctx.fillStyle = "#fff3c4";
          ctx.beginPath(); ctx.arc(cx, ry, u * 0.35, 0, 7); ctx.fill();
          continue;
        }
        var a = age - 0.6, fade = Math.max(0, 1 - a / 2.2), n = 40;
        for (var i = 0; i < n; i++) {
          var ang = i / n * 6.283 + rnd(b, 4), sp = u * (14 + 6 * rnd(b * 7 + i, 5));
          var r = sp * a * (1 - a * 0.18);
          var px = cx + Math.cos(ang) * r, py = cy + Math.sin(ang) * r + 0.5 * u * 9 * a * a;
          ctx.globalAlpha = fade * (0.6 + 0.4 * Math.sin(t * 30 + i));
          ctx.fillStyle = i % 5 ? col : "#ffffff";
          ctx.beginPath(); ctx.arc(px, py, u * 0.5 * (0.4 + fade), 0, 7); ctx.fill();
        }
      }
      ctx.globalAlpha = 1;
    }
    // Shooting stars streaking across the wall over a field of twinkling stars.
    function shooting(t) {
      particles("sparkles", t, base * 0.4, ef.color);
      var slot = ef.intensity === "heavy" ? 0.9 : ef.intensity === "light" ? 3 : 1.7;
      var cur = Math.floor(t / slot), u = W / 100;
      for (var b = cur - 3; b <= cur; b++) {
        var age = t - b * slot, dur = 1.6;
        if (age < 0 || age > dur) continue;
        var sx = VW * (rnd(b, 1) * 0.8 - 0.1), sy = VH * rnd(b, 2) * 0.45;
        var dx = W * 1.6, dy = W * 0.55;
        var x = sx + dx * age, y = sy + dy * age, f = Math.sin(age / dur * Math.PI);
        var g = ctx.createLinearGradient(x, y, x - dx * 0.18, y - dy * 0.18);
        g.addColorStop(0, "rgba(255,255,255," + f + ")"); g.addColorStop(1, "rgba(255,255,255,0)");
        ctx.strokeStyle = g; ctx.lineWidth = u * 0.35; ctx.lineCap = "round";
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x - dx * 0.18, y - dy * 0.18); ctx.stroke();
        ctx.globalAlpha = f; ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(x, y, u * 0.4, 0, 7); ctx.fill(); ctx.globalAlpha = 1;
      }
    }

    // A small plane pulling a banner (text and/or a logo picture) across the whole wall every `every` seconds.
    var logo = null, logoOk = false, bannerCv = null, bannerKey = "";
    var logoSrc = ef.image ? (ef.image.localSrc || ef.image.src) : null;
    if (logoSrc && type === "plane") {
      logo = new Image();
      logo.onload = function () { logoOk = true; bannerKey = ""; };
      logo.src = logoSrc;
    }
    function bannerImage(bh) {
      var key = bh + "|" + logoOk;
      if (bannerCv && bannerKey === key) return bannerCv;
      var r = window.devicePixelRatio || 1, pad = bh * 0.22;
      var text = ef.banner || (logoOk ? "" : "Your message here");
      var font = "bold " + Math.round(bh * 0.56) + "px sans-serif";
      ctx.save(); ctx.font = font; var tw = text ? ctx.measureText(text).width : 0; ctx.restore();
      var lh = bh - pad * 1.2, lw = 0;
      if (logoOk) { lw = Math.min(bh * 3, lh * (logo.naturalWidth || 1) / (logo.naturalHeight || 1)); }
      var bw = Math.max(bh * 2, pad * 2 + lw + (lw && tw ? pad : 0) + tw);
      var c = document.createElement("canvas");
      c.width = Math.ceil(bw * r); c.height = Math.ceil(bh * r);
      var g = c.getContext("2d"); g.scale(r, r);
      g.fillStyle = ef.bannerBg || "#ffffff"; g.fillRect(0, 0, bw, bh);
      g.strokeStyle = "rgba(0,0,0,.25)"; g.lineWidth = Math.max(1, bh * 0.04); g.strokeRect(0, 0, bw, bh);
      var x = pad;
      if (logoOk) { var lhh = lw * (logo.naturalHeight || 1) / (logo.naturalWidth || 1); g.drawImage(logo, x, (bh - lhh) / 2, lw, lhh); x += lw + pad; }
      if (text) { g.font = font; g.fillStyle = ef.bannerColor || "#b91c1c"; g.textBaseline = "middle"; g.fillText(text, x, bh / 2 + bh * 0.03); }
      c.bw = bw; bannerCv = c; bannerKey = key;
      return c;
    }
    // The plane, facing right; (0, 0) = middle of its body. t spins the propeller.
    function airplane(x, y, u, t) {
      ctx.save(); ctx.translate(x, y); ctx.rotate(-0.03);
      ctx.fillStyle = "#b91c1c";
      ctx.beginPath(); ctx.moveTo(-3.2 * u, -0.4 * u); ctx.lineTo(-4.4 * u, -2.7 * u); ctx.lineTo(-3.6 * u, -2.7 * u); ctx.lineTo(-2.2 * u, -0.5 * u); ctx.fill();
      ctx.fillStyle = "#f8fafc";
      ctx.beginPath(); ctx.moveTo(-4.4 * u, -0.5 * u); ctx.quadraticCurveTo(-1 * u, -1.3 * u, 3.6 * u, -0.9 * u);
      ctx.quadraticCurveTo(4.4 * u, -0.6 * u, 4.4 * u, 0); ctx.quadraticCurveTo(4.4 * u, 0.7 * u, 3.4 * u, 0.9 * u);
      ctx.quadraticCurveTo(-1 * u, 1 * u, -4.4 * u, 0.1 * u); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "#b91c1c"; ctx.fillRect(-3.6 * u, -0.15 * u, 7.4 * u, 0.35 * u);
      ctx.fillStyle = "#93c5fd"; ctx.beginPath(); ctx.ellipse(1.7 * u, -0.85 * u, 1 * u, 0.55 * u, 0, Math.PI, 0); ctx.fill();
      ctx.fillStyle = "#7f1d1d"; ctx.beginPath(); ctx.ellipse(-3.6 * u, -0.2 * u, 1 * u, 0.22 * u, 0, 0, 7); ctx.fill();
      ctx.fillStyle = "#dc2626"; ctx.beginPath(); ctx.ellipse(0.4 * u, 0.25 * u, 1.6 * u, 0.4 * u, 0, 0, 7); ctx.fill();
      ctx.strokeStyle = "#334155"; ctx.lineWidth = u * 0.18;
      ctx.beginPath(); ctx.moveTo(1 * u, 0.8 * u); ctx.lineTo(1.3 * u, 1.6 * u); ctx.stroke();
      ctx.fillStyle = "#111827"; ctx.beginPath(); ctx.arc(1.3 * u, 1.7 * u, 0.38 * u, 0, 7); ctx.fill();
      ctx.fillStyle = "#475569"; ctx.beginPath(); ctx.arc(4.45 * u, 0, 0.3 * u, 0, 7); ctx.fill();
      ctx.globalAlpha = 0.45; ctx.fillStyle = "#cbd5e1";
      ctx.beginPath(); ctx.ellipse(4.6 * u, 0, 0.18 * u, 1.7 * u * (0.55 + 0.45 * Math.abs(Math.sin(t * 25))), 0, 0, 7); ctx.fill();
      ctx.restore();
    }
    function plane(t) {
      var u = H / 34, speed = W * 0.2, bh = 4.6 * u, rope = 4 * u;
      var bc = bannerImage(bh), bw = bc.bw, r = window.devicePixelRatio || 1;
      var len = 9 * u + rope + bw;
      var flight = (VW + len + 5 * u) / speed;
      var every = Math.max(ef.every || 30, flight + 2);
      var c = Math.floor(t / every), ph = t - c * every;
      if (ph > flight) return;
      var y0 = VH * (0.12 + 0.3 * rnd(c, 1)) + bh;
      var x = -5 * u + ph * speed;
      var y = y0 + Math.sin(t * 1.3) * u * 0.6;
      var tail = x - 4.4 * u, front = tail - rope, top = y - bh / 2 + u * 0.3;
      // Ropes from the tail to the banner's front corners.
      ctx.strokeStyle = "#334155"; ctx.lineWidth = Math.max(1, u * 0.1);
      ctx.beginPath(); ctx.moveTo(tail, y - 0.2 * u); ctx.lineTo(front, top); ctx.moveTo(tail, y - 0.2 * u); ctx.lineTo(front, top + bh); ctx.stroke();
      // The banner, drawn in strips that wave more towards its far end.
      var sw = Math.max(4, bh * 0.2);
      for (var sx = 0; sx < bw; sx += sw) {
        var w = Math.min(sw, bw - sx), d = (bw - sx) / bw;
        var dy = Math.sin(t * 7 - sx / bh * 1.6) * bh * 0.1 * d;
        ctx.drawImage(bc, sx * r, 0, w * r, bh * r, front - bw + sx, top + dy, w + 0.6, bh);
      }
      airplane(x, y, u, t);
    }

    function frame() {
      var t = now() / 1000;
      ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.translate(-OX, -OY);
      if (type === "santa") { if (ef.snow) particles("snow", t, base, "#ffffff"); santa(t); }
      else if (type === "fireworks") fireworks(t);
      else if (type === "shooting") shooting(t);
      else if (type === "balloons") particles("balloons", t, base * 0.35, ef.color);
      else if (type === "plane") plane(t);
      else particles(type, t, base, ef.color);
      raf = requestAnimationFrame(frame);
    }
    size();
    raf = requestAnimationFrame(frame);
    var onResize = function () { size(); };
    global.addEventListener("resize", onResize);
    var ro = global.ResizeObserver ? new ResizeObserver(onResize) : null;
    if (ro) ro.observe(root);
    return function () { cancelAnimationFrame(raf); global.removeEventListener("resize", onResize); if (ro) ro.disconnect(); };
  }

  global.SignageOverlay = { render: render, activeNow: activeNow, REGIONS: REGIONS, FONTS: FONTS, SCENES: SCENES, SHAPES: SHAPES, shapeSvg: shapeSvg };
})(window);
