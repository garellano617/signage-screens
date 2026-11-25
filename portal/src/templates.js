"use strict";
// Ready-made screen designs. Each one is a full layers object (see layers.js) with placeholder words
// the business replaces. They are cleaned by sanitizeLayers before they are sent, like anything else.
const { sanitizeLayers } = require("./layers");

// A text block. Positions snap to a spot unless x/y are given (top-left corner, % of the screen).
const t = (text, o = {}) => Object.assign({ kind: "text", text, position: "center", x: null, y: null, w: 0, size: "m", fs: 3, font: "sans",
  align: "", bold: true, italic: false, color: "#ffffff", bg: "#000000", bgOpacity: 0, from: 0, to: 0 }, o);
const ticker = (text, o = {}) => Object.assign({ enabled: true, text, position: "bottom", speed: "normal", size: "m", color: "#ffffff", bg: "#111827" }, o);
const noTicker = { enabled: false, text: "", position: "bottom", speed: "normal", size: "m", color: "#ffffff", bg: "#111827" };
const specials = (o, items) => Object.assign({ enabled: true, heading: "Today's specials", position: "right", seconds: 8, accent: "#f59e0b", bg: "#111827", color: "#ffffff",
  items: items.map(([title, price, description]) => ({ title, price, description: description || "", mediaId: null, days: 127, start: "", end: "" })) }, o);
const noSpecials = specials({ enabled: false }, []);
const fx = (type, intensity = "medium", color = "#ffffff") => ({ enabled: true, type, intensity, color });
const noFx = { enabled: false, type: "snow", intensity: "medium", color: "#ffffff" };

const RAW = [
  {
    id: "menu-board", name: "Menu board", category: "Restaurant",
    description: "Your slideshow on the left, rotating specials with prices on the right, and a ticker along the bottom.",
    layers: {
      video: { enabled: true, region: "left70top85" },
      specials: specials({ heading: "Today's specials", position: "right", accent: "#f59e0b", bg: "#1c1917" },
        [["Lunch combo", "$9.99", "Main, side and a drink"], ["Family meal", "$29.99", "Feeds four"], ["Dessert of the day", "$3.50", ""]]),
      text: { enabled: true, cycle: 0, blocks: [], ticker: ticker("Open 7 days a week · Ask about catering · Free Wi-Fi", { bg: "#b45309" }) },
      effects: noFx
    }
  },
  {
    id: "daily-deal", name: "Daily deal", category: "Restaurant",
    description: "One big offer with a price tag over your slideshow. Good for Taco Tuesday or a lunch special.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: noTicker, blocks: [
        t("TACO TUESDAY", { x: 5, y: 8, fs: 7.5, font: "condensed", color: "#facc15", bg: "#000000", bgOpacity: 55 }),
        t("3 tacos + drink", { x: 5, y: 30, fs: 3.6, bg: "#000000", bgOpacity: 55 }),
        t("$7.99", { x: 70, y: 62, fs: 7, font: "condensed", color: "#ffffff", bg: "#dc2626", bgOpacity: 100 })
      ] },
      effects: noFx
    }
  },
  {
    id: "price-list", name: "Price list", category: "Restaurant",
    description: "A clean price list beside your photos, in a typewriter font that lines up the prices.",
    layers: {
      video: { enabled: true, region: "right70" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: noTicker, blocks: [
        t("MENU", { x: 3, y: 6, fs: 5, font: "serif", color: "#fde68a" }),
        t("Item one      $0.00\nItem two      $0.00\nItem three    $0.00\nItem four     $0.00\nItem five     $0.00",
          { x: 2, y: 22, w: 27, fs: 1.9, font: "mono", align: "left", bold: true, color: "#111111", bg: "#ffffff", bgOpacity: 90 }),
        t("Prices include tax", { x: 3, y: 86, fs: 1.6, bold: false, italic: true, color: "#d1d5db" })
      ] },
      effects: noFx
    }
  },
  {
    id: "coffee-shop", name: "Coffee shop", category: "Cafe",
    description: "Warm colors and a script heading, drinks rotating on a card, and a gentle ticker.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: specials({ heading: "On the menu", position: "bottom-right", seconds: 7, accent: "#d97706", bg: "#3f2a1d", color: "#fef3c7" },
        [["Latte", "$4.50", "Hot or iced"], ["Cold brew", "$4.00", "Steeped 18 hours"], ["Fresh pastries", "from $2.75", "Baked every morning"]]),
      text: { enabled: true, cycle: 0, ticker: ticker("Free Wi-Fi · Order ahead and skip the line · Ask about our loyalty card", { bg: "#3f2a1d", color: "#fef3c7", speed: "slow" }),
        blocks: [t("Good morning", { position: "top-left", fs: 5.5, font: "script", bold: false, color: "#fef3c7", bg: "#3f2a1d", bgOpacity: 70 })] },
      effects: noFx
    }
  },
  {
    id: "happy-hour", name: "Happy hour", category: "Bar",
    description: "Two messages that take turns, plus rising bubbles. The timing repeats every 20 seconds.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: noSpecials,
      text: { enabled: true, cycle: 20, ticker: noTicker, blocks: [
        t("HAPPY HOUR", { x: 8, y: 12, fs: 8, font: "condensed", color: "#f472b6", bg: "#000000", bgOpacity: 50, from: 0, to: 10 }),
        t("4 PM – 7 PM daily", { x: 8, y: 38, fs: 3.6, bg: "#000000", bgOpacity: 50, from: 0, to: 10 }),
        t("$5 drinks\nHalf-price appetizers", { x: 8, y: 20, fs: 4.5, align: "left", color: "#ffffff", bg: "#be185d", bgOpacity: 90, from: 10, to: 0 })
      ] },
      effects: fx("bubbles", "light", "#fbcfe8")
    }
  },
  {
    id: "grand-opening", name: "Grand opening", category: "Event",
    description: "A big centered announcement with confetti.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: ticker("Grand opening this Saturday · Free samples · Prizes all day", { bg: "#7c3aed" }), blocks: [
        t("GRAND OPENING", { position: "center", fs: 8, font: "condensed", align: "center", color: "#ffffff", bg: "#7c3aed", bgOpacity: 85 }),
        t("Saturday · 10 AM", { position: "top", fs: 3.4, color: "#fde047", bg: "#000000", bgOpacity: 55 })
      ] },
      effects: fx("confetti", "medium")
    }
  },
  {
    id: "big-sale", name: "Big sale", category: "Retail",
    description: "A huge discount number, a label and the end date, in sale red.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: ticker("Sale ends Sunday · While supplies last · In store only", { bg: "#b91c1c" }), blocks: [
        t("SALE", { x: 6, y: 8, fs: 4, font: "condensed", color: "#ffffff", bg: "#b91c1c", bgOpacity: 100 }),
        t("30% OFF", { x: 6, y: 24, fs: 11, font: "condensed", color: "#ffffff", bg: "#000000", bgOpacity: 45 }),
        t("Everything in store", { x: 6, y: 56, fs: 3.4, bg: "#000000", bgOpacity: 45 })
      ] },
      effects: noFx
    }
  },
  {
    id: "new-arrivals", name: "New arrivals", category: "Retail",
    description: "Products rotating on a card with prices, and a clean label at the top.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: specials({ heading: "New this week", position: "bottom-left", seconds: 6, accent: "#0ea5e9", bg: "#0f172a" },
        [["Product one", "$0.00", "Short description"], ["Product two", "$0.00", "Short description"], ["Product three", "$0.00", "Short description"]]),
      text: { enabled: true, cycle: 0, ticker: noTicker, blocks: [
        t("NEW ARRIVALS", { position: "top-right", fs: 3.6, font: "condensed", color: "#0f172a", bg: "#ffffff", bgOpacity: 92 })
      ] },
      effects: noFx
    }
  },
  {
    id: "welcome-lobby", name: "Welcome lobby", category: "Office",
    description: "A welcome message, a short line about your business and announcements on the ticker.",
    layers: {
      video: { enabled: true, region: "top85" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: ticker("Welcome to our visitors today · Wi-Fi: Guest · Please sign in at the front desk", { position: "bottom", bg: "#1e3a8a", speed: "slow" }), blocks: [
        t("Welcome", { position: "top-left", fs: 6, font: "serif", bold: false, color: "#ffffff", bg: "#1e3a8a", bgOpacity: 80 }),
        t("We're glad you're here", { position: "bottom-left", fs: 2.6, bold: false, color: "#ffffff", bg: "#000000", bgOpacity: 50 })
      ] },
      effects: noFx
    }
  },
  {
    id: "holiday", name: "Holiday season", category: "Seasonal",
    description: "Falling snow, a festive greeting and your holiday hours.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: ticker("Holiday hours: Dec 24 close at 3 PM · Closed Dec 25 · Gift cards available", { bg: "#14532d" }), blocks: [
        t("Happy Holidays", { position: "top", fs: 6.5, font: "script", bold: false, color: "#ffffff", bg: "#991b1b", bgOpacity: 80 })
      ] },
      effects: fx("snow", "medium")
    }
  },
  {
    id: "santa-sleigh", name: "Santa's sleigh", category: "Seasonal",
    description: "Santa and his reindeer fly across the screen every 20 seconds over falling snow, with your holiday message.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: ticker("Merry Christmas from all of us · Holiday hours: Dec 24 close at 3 PM · Closed Dec 25", { bg: "#7f1d1d" }), blocks: [
        t("Merry Christmas", { position: "bottom-left", fs: 6, font: "script", bold: false, color: "#ffffff", bg: "#14532d", bgOpacity: 80 })
      ] },
      effects: { enabled: true, type: "santa", intensity: "medium", color: "#ffffff", every: 20, snow: true }
    }
  },
  {
    id: "plane-banner", name: "Plane with banner", category: "Promotions",
    description: "A small plane flies across the screen every 30 seconds pulling a banner with your message or logo.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: noSpecials,
      text: { enabled: true, cycle: 0, ticker: ticker("Grand opening this Saturday · Free coffee for the first 50 guests · Doors open at 9 AM", { bg: "#1e3a8a" }), blocks: [] },
      effects: { enabled: true, type: "plane", intensity: "medium", color: "#ffffff", every: 30, banner: "Grand opening this Saturday!", bannerBg: "#ffffff", bannerColor: "#b91c1c" }
    }
  },
  {
    id: "valentines", name: "Valentine's Day", category: "Seasonal",
    description: "Floating hearts, a pink heading and a special for two.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: specials({ heading: "Valentine's special", position: "right", seconds: 8, accent: "#f43f5e", bg: "#4c0519", color: "#ffe4e6" },
        [["Dinner for two", "$0.00", "Starter, two mains, dessert"], ["Roses", "$0.00", "Pre-order at the counter"]]),
      text: { enabled: true, cycle: 0, ticker: noTicker, blocks: [
        t("Be Mine", { position: "top-left", fs: 6, font: "script", bold: false, color: "#ffe4e6", bg: "#be123c", bgOpacity: 80 })
      ] },
      effects: fx("hearts", "light", "#fb7185")
    }
  },
  {
    id: "fall-harvest", name: "Fall harvest", category: "Seasonal",
    description: "Falling leaves, autumn colors and seasonal favorites on a card.",
    layers: {
      video: { enabled: true, region: "full" },
      specials: specials({ heading: "Fall favorites", position: "bottom-right", seconds: 8, accent: "#ea580c", bg: "#431407", color: "#ffedd5" },
        [["Pumpkin spice latte", "$0.00", ""], ["Apple pie", "$0.00", "By the slice or whole"], ["Hot cider", "$0.00", ""]]),
      text: { enabled: true, cycle: 0, ticker: noTicker, blocks: [
        t("Hello, Fall", { position: "top-left", fs: 5.5, font: "serif", italic: true, color: "#ffedd5", bg: "#9a3412", bgOpacity: 80 })
      ] },
      effects: fx("leaves", "light")
    }
  }
];

const TEMPLATES = RAW.map(x => ({ ...x, layers: sanitizeLayers(x.layers, () => false) }));

module.exports = { TEMPLATES };
