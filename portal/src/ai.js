"use strict";
// AI screen designer: Claude writes a screen design (layers) or the words for an existing one.
// Off unless ANTHROPIC_API_KEY is set. Every request costs money, so each client has a daily limit (AI_DAILY_LIMIT).
const { z } = require("zod");
const { REGIONS, POSITIONS, SIZES, EFFECTS, SPECIAL_POSITIONS, FONTS, TRANSITIONS, TEXT_FX } = require("./layers");

const MODEL = "claude-opus-5-5";
let client = null;

const enabled = () => !!process.env.ANTHROPIC_API_KEY || !!client;
const dailyLimit = () => Math.max(0, Number(process.env.AI_DAILY_LIMIT) || 40);

function getClient() {
  if (!client) {
    const Anthropic = require("@anthropic-ai/sdk").default;
    client = new Anthropic({ timeout: 120 * 1000, maxRetries: 2 });
  }
  return client;
}
/** Tests swap in a fake client. */
function setClient(c) { client = c; }

const hex = z.string().describe("Color as #rrggbb");
const Design = z.object({
  summary: z.string().describe("One or two plain sentences for the business owner: what you made and why."),
  video: z.object({ enabled: z.boolean(), region: z.enum(REGIONS) }),
  specials: z.object({
    enabled: z.boolean(), heading: z.string(), position: z.enum(SPECIAL_POSITIONS), seconds: z.number(),
    accent: hex, bg: hex, color: hex,
    items: z.array(z.object({ title: z.string(), price: z.string(), description: z.string(), mediaId: z.number().nullable() }))
  }),
  text: z.object({
    enabled: z.boolean(),
    cycle: z.number().describe("Seconds before timed text repeats; 0 when every block always shows"),
    blocks: z.array(z.object({
      kind: z.enum(["text", "image"]),
      text: z.string(),
      mediaId: z.number().nullable(),
      position: z.enum(POSITIONS),
      fs: z.number().describe("Font size in % of the screen width, 1.5 to 12"),
      w: z.number().describe("Width in % of the screen; 0 = fit the text. Pictures: 10 to 50"),
      font: z.enum(FONTS), align: z.enum(["left", "center", "right"]),
      bold: z.boolean(), italic: z.boolean(), color: hex, bg: hex,
      bgOpacity: z.number().describe("Box behind the text, 0 to 100"),
      from: z.number(), to: z.number(),
      track: z.number().describe("Timeline row, 0 and up. Blocks on the same row take turns; overlapping them by a second makes a smooth transition"),
      enter: z.enum(TRANSITIONS).describe("Entrance: small = grows from small to full size, big = shrinks from big, left/right/top/bottom = slides in from that side, spin, pop = bounces in"),
      exit: z.enum(TRANSITIONS).describe("Exit: small = shrinks away, big = grows away, left/right/top/bottom = slides out that side"),
      td: z.number().describe("Transition length in seconds, 0.3 to 2"),
      fx: z.enum(TEXT_FX).describe("Look: glow, neon = neon sign glow (white or light text), shadow, shine = light sweeps across, grow = gentle pulse. Mostly none"),
      fxColor: hex.describe("Color of the glow, neon or shadow")
    })),
    ticker: z.object({ enabled: z.boolean(), text: z.string(), position: z.enum(["top", "bottom"]), speed: z.enum(["slow", "normal", "fast"]),
      size: z.enum(SIZES), color: hex, bg: hex })
  }),
  effects: z.object({ enabled: z.boolean(), type: z.enum(EFFECTS), intensity: z.enum(["light", "medium", "heavy"]), color: hex })
});

const SYSTEM = `You design digital signage screens for small businesses (restaurants, shops, cafes, offices). The screen is a TV seen from across a room.

A design has four layers, bottom to top:
1. video: the business's own playlist (photos and videos). "region" is the part of the screen it fills: full, left70, right70, top85 (room for a ticker), left70top85.
2. specials: offers that take turns every "seconds" seconds, each with title, price and short description, shown as a side panel (right/left) or a card (bottom-right, bottom-left, top-right, center).
3. text: text blocks and pictures placed at a position, plus a scrolling ticker at the top or bottom. With "cycle" > 0, a block shows only from "from" to "to" seconds of each cycle (to = 0 means until the end), so messages can take turns.
4. effects: an animated overlay (snow, confetti, sparkles, bubbles, hearts, leaves, stars, santa = Santa's sleigh and reindeer flying across, fireworks, shooting = shooting stars, balloons, plane = a small plane pulling a banner; put the banner words in effects.banner; lights = coloured Christmas lights around the edge of the screen; rain = raindrops running down a window). Use one only when it fits the occasion.

Rules:
- Few words, big text. Headings 5 to 9, prices 4 to 8, body 2 to 3.5 (font size in % of the screen width). At most about 5 text blocks.
- Strong contrast. Text over the video needs a box (bgOpacity 50 or more) in a dark or brand color.
- Leave the video visible: don't cover the middle of the screen with several boxes. When specials use a side panel, shrink the video region (left70 for a right panel, right70 for a left panel).
- Two blocks must not share the same position unless they take turns in time.
- Transitions (enter/exit) make it lively: e.g. a logo that pops in, a price that slides in from the right, pictures on one row that take turns with a 1 second overlap. Keep it tasteful: "none" or "fade" for body text.
- Use only prices, dates, times and facts the user gave. Never invent prices: leave price empty if none was given. Never invent phone numbers, addresses or claims.
- Pictures: use only the mediaId values from the list of the business's pictures, and only when the name fits (a logo, a dish). Never invent a mediaId; use null.
- Write in the language the user writes in. Use the business's name when given.
- Use the "summary" field to say in one or two sentences what you made.`;

const CONTENT_RULES = `Rewrite only the words: the specials heading and items, the text of each text block (keep the same number of blocks, in the same order), and the ticker messages. Keep every position, size, font, color, timing and effect exactly as in the current design.`;

class AiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

/**
 * Asks Claude for a design.
 * mode "design": a whole new design. mode "content": new words for `current`, keeping its layout.
 * Returns { layers, summary } (not yet cleaned; the caller runs sanitizeLayers).
 */
async function design({ prompt, mode, current, businessName, images }) {
  if (!enabled()) throw new AiError(503, "The AI designer isn't set up yet. Add ANTHROPIC_API_KEY on the server.");
  const pics = images.length ? images.map(m => `- mediaId ${m.id}: ${m.name}`).join("\n") : "(none)";
  const parts = [
    `Business: ${businessName}`,
    `The business's pictures:\n${pics}`,
    mode === "content" ? `Current design (JSON):\n${JSON.stringify(current)}\n\n${CONTENT_RULES}` : "Make a new design.",
    `Request from the business owner:\n${prompt}`
  ];
  const { betaZodOutputFormat } = require("@anthropic-ai/sdk/helpers/beta/zod");
  const Anthropic = require("@anthropic-ai/sdk").default;
  let res;
  try {
    res = await getClient().beta.messages.parse({
      model: MODEL,
      max_tokens: 16000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: betaZodOutputFormat(Design) },
      system: SYSTEM,
      messages: [{ role: "user", content: parts.join("\n\n") }]
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AiError(503, "The AI key on the server isn't working. Check ANTHROPIC_API_KEY.");
    if (e instanceof Anthropic.RateLimitError) throw new AiError(429, "The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.BadRequestError) { console.error("AI request rejected:", e.message); throw new AiError(502, "The AI couldn't handle that request. Try wording it differently."); }
    if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIConnectionError) { console.error("AI error:", e.message); throw new AiError(502, "The AI service didn't answer. Try again in a minute."); }
    throw e;
  }
  if (res.stop_reason === "refusal") throw new AiError(422, "The AI declined that request. Try describing it differently.");
  if (res.stop_reason === "max_tokens" || !res.parsed_output) throw new AiError(502, "The AI's answer was incomplete. Try a shorter request.");
  const { summary, ...layers } = res.parsed_output;
  return { layers, summary };
}

/** Content mode: take only the words from the AI's answer; everything else stays as it was. */
function mergeWords(current, ai) {
  const out = JSON.parse(JSON.stringify(current));
  out.specials.heading = ai.specials.heading;
  out.specials.items = ai.specials.items.map((it, i) => ({ ...(current.specials.items[i] || { days: 127, start: "", end: "" }), title: it.title, price: it.price, description: it.description,
    mediaId: current.specials.items[i] ? current.specials.items[i].mediaId : it.mediaId }));
  const aiTexts = ai.text.blocks.filter(b => b.kind === "text").map(b => b.text);
  let k = 0;
  out.text.blocks = out.text.blocks.map(b => (b.kind === "text" && k < aiTexts.length ? { ...b, text: aiTexts[k++] } : b));
  out.text.ticker.text = ai.text.ticker.text;
  return out;
}

// ---------- AI help: answers questions about using the portal, from the guide in helpGuide.md ----------
const helpDailyLimit = () => Math.max(0, Number(process.env.AI_HELP_DAILY_LIMIT) || 50);
let guide = null;
const helpGuide = () => guide || (guide = require("fs").readFileSync(require("path").join(__dirname, "helpGuide.md"), "utf8"));

const HELP_RULES = `You are the help assistant inside a digital signage portal (a website for managing TV screens in businesses). People ask how to do things in the portal or the TV player app, or why something isn't working.

How to answer:
- Answer only from the guide below. If the guide doesn't cover it, say you're not sure and suggest contacting the signage company's support. Never invent buttons, menus, settings or features.
- The person is usually a business owner, not technical, often on a phone. Use plain words, short sentences, and numbered steps for "how do I" questions. Use the exact button and menu names from the guide, in **bold**.
- Keep it short: usually under 150 words. One clear way to do it, not every option.
- Take into account the page they are on and whether they are staff or a client login (clients can't see other clients, Clients, White Label or Download App uploads).
- Questions not about the portal, signage or the TVs: politely say you can only help with the portal.
- Answer in the language the person writes in.
- Never ask for or repeat passwords, card numbers or keys.
- Pictures: the person may attach a screenshot or a photo (for example of the portal on their phone, or of a TV), and on a screen's page the TV's latest screenshot can be attached. Look at it closely and use it: read any error message or code, notice what's on the TV (blank, a pairing code, the wrong content, cut-off text, a "No playlist" note), and say in one short line what you see before giving the steps. If the picture doesn't show a problem, say so. Don't describe people's faces.
- If they describe something visual and no picture is attached, you may suggest they attach a screenshot (📎 button) or, on a screen's page, tick "Show the AI this TV's latest screenshot".

The guide:

`;

/**
 * Answers a help question. history: earlier turns [{ role: "user"|"assistant", content }], oldest first.
 * context: { page, role, clientName }. Returns the answer text.
 */
async function help({ question, history, context, images = [] }) {
  if (!enabled()) throw new AiError(503, "AI help isn't set up yet. Add ANTHROPIC_API_KEY on the server.");
  const Anthropic = require("@anthropic-ai/sdk").default;
  const where = `[The person is on the page: ${context.page || "unknown"}. They are ${context.role}${context.clientName ? " (client: " + context.clientName + ")" : ""}.${context.lang === "es" ? " Their portal is shown in Spanish (Mexico): answer in Mexican Spanish, and name buttons and menus in Spanish (for example Screens = Pantallas, Design = Diseño, Video walls = Muros de video, Media = Medios, Save = Guardar)." : ""}]`;
  let res;
  try {
    res = await getClient().beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "low" },
      // The rules and the guide are the same on every question: cached, so repeat questions cost much less.
      system: [{ type: "text", text: HELP_RULES + helpGuide(), cache_control: { type: "ephemeral" } }],
      messages: [...history, { role: "user", content: [
        ...images.map(im => ({ type: "image", source: { type: "base64", media_type: im.mediaType, data: im.data } })),
        { type: "text", text: where + (images.length ? "\n[Attached: " + images.map(im => im.label).join("; ") + "]" : "") + "\n\n" + question }
      ] }]
    });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) throw new AiError(503, "The AI key on the server isn't working. Check ANTHROPIC_API_KEY.");
    if (e instanceof Anthropic.RateLimitError) throw new AiError(429, "The AI is busy right now. Try again in a minute.");
    if (e instanceof Anthropic.BadRequestError) { console.error("AI help request rejected:", e.message); throw new AiError(502, "The AI couldn't handle that question. Try wording it differently."); }
    if (e instanceof Anthropic.APIError || e instanceof Anthropic.APIConnectionError) { console.error("AI help error:", e.message); throw new AiError(502, "The AI service didn't answer. Try again in a minute."); }
    throw e;
  }
  if (res.stop_reason === "refusal") throw new AiError(422, "The AI couldn't answer that. Try asking differently.");
  const text = (res.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
  if (!text) throw new AiError(502, "The AI didn't give an answer. Try again.");
  return text;
}

module.exports = { enabled, dailyLimit, design, mergeWords, setClient, AiError, MODEL, Design, help, helpDailyLimit };
