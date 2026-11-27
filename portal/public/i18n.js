"use strict";
/* Portal language: English (default) or Spanish (Mexico).
 * The portal is written in English; in Spanish, every piece of portal text that appears on the page is swapped for
 * its translation (window.I18N_ES, from i18n-es.js) as it is drawn. What people type (screen names, designs,
 * descriptions) is never translated. Choice is kept in this browser. */
(function () {
  var KEY = "portalLang";
  var lang = "en";
  try { lang = localStorage.getItem(KEY) === "es" ? "es" : "en"; } catch (e) { /* private window: English */ }
  var dict = window.I18N_ES || { exact: {}, patterns: [] };
  var exact = dict.exact;
  // "Uploading {0} file(s)…" → /^Uploading (.+?) file\(s\)…$/ ; the parts are translated too ("4 h ago").
  var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); };
  var patterns = dict.patterns.map(function (p) {
    var parts = p[0].split(/\{(\d+)\}/), re = "^", order = [];
    for (var i = 0; i < parts.length; i++) {
      if (i % 2) { re += "([\\s\\S]*?)"; order.push(Number(parts[i])); } else re += esc(parts[i]);
    }
    return { re: new RegExp(re + "$"), order: order, to: p[1], lit: p[0].replace(/\{\d+\}/g, "").length };
  }).sort(function (a, b) { return b.lit - a.lit; });

  function t(s) {
    if (lang !== "es" || !s) return s;
    var m = /^(\s*)([\s\S]*?)(\s*)$/.exec(s), core = m[2];
    if (!core) return s;
    var out = tr(core, 0);
    return out === core ? s : m[1] + out + m[3];
  }
  function tr(core, depth) {
    if (Object.prototype.hasOwnProperty.call(exact, core)) return exact[core];
    if (depth > 2 || core.length > 1500) return core;
    for (var i = 0; i < patterns.length; i++) {
      var p = patterns[i], m = p.re.exec(core);
      if (!m) continue;
      var vals = {};
      p.order.forEach(function (n, k) { vals[n] = tr(m[k + 1], depth + 1); });
      return p.to.replace(/\{(\d+)\}/g, function (_, n) { return vals[n] != null ? vals[n] : ""; });
    }
    return core;
  }

  // Never touched: people's own words and the live design previews.
  var SKIP = "script,style,textarea,code,[contenteditable],[data-noi18n],.so-root,.ed-preview,.widget-thumb,.widget-preview,.help-msg";
  var ATTRS = ["placeholder", "title", "aria-label"];
  function skip(el) { return !el || (el.closest && el.closest(SKIP)); }
  function doText(n) {
    if (skip(n.parentElement)) return;
    var v = n.nodeValue, o = t(v);
    if (o !== v) n.nodeValue = o;
  }
  function doEl(el) {
    if (skip(el)) return;
    for (var i = 0; i < ATTRS.length; i++) {
      var a = el.getAttribute(ATTRS[i]);
      if (a) { var o = t(a); if (o !== a) el.setAttribute(ATTRS[i], o); }
    }
    if ((el.tagName === "INPUT" && (el.type === "submit" || el.type === "button")) && el.value) el.value = t(el.value);
  }
  function walk(root) {
    if (root.nodeType === 3) { doText(root); return; }
    if (root.nodeType !== 1 || skip(root)) return;
    doEl(root);
    var w = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.nodeType === 1 && n.matches(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var n;
    while ((n = w.nextNode())) { if (n.nodeType === 3) doText(n); else doEl(n); }
  }

  function start() {
    document.documentElement.lang = lang === "es" ? "es-MX" : "en";
    if (lang !== "es") return;
    walk(document.body);
    new MutationObserver(function (list) {
      list.forEach(function (m) {
        if (m.type === "characterData") doText(m.target);
        else if (m.type === "attributes") doEl(m.target);
        else m.addedNodes.forEach(walk);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
    // Browser pop-ups (confirm / alert / prompt) with portal text.
    ["confirm", "alert", "prompt"].forEach(function (f) {
      var orig = window[f];
      window[f] = function (msg) { var a = [].slice.call(arguments); a[0] = t(String(msg == null ? "" : msg)); return orig.apply(window, a); };
    });
  }
  if (document.body) start(); else document.addEventListener("DOMContentLoaded", start);

  /** The language switch: "EN | ES". Reloads the page in the other language. */
  function switcher() {
    var box = document.createElement("div");
    box.className = "lang-switch";
    box.setAttribute("data-noi18n", "");
    box.setAttribute("role", "group");
    box.setAttribute("aria-label", lang === "es" ? "Idioma" : "Language");
    [["en", "EN", "English"], ["es", "ES", "Español (México)"]].forEach(function (o) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = o[1];
      b.title = o[2];
      if (o[0] === lang) { b.className = "on"; b.setAttribute("aria-pressed", "true"); }
      b.addEventListener("click", function () {
        if (o[0] === lang) return;
        try { localStorage.setItem(KEY, o[0]); } catch (e) { /* can't remember it */ }
        location.reload();
      });
      box.appendChild(b);
    });
    return box;
  }

  window.I18N = { lang: function () { return lang; }, t: t, switcher: switcher };
})();
