import path from "node:path";
import { createCanvas, loadImage } from "../canvas.mjs";
import { root } from "../config.mjs";
import { writtenDate } from "./dates.mjs";
import { includes, wording } from "./footage.mjs";

// How dark the layer over game footage and B-roll is (0 = none, 1 = black).
const FOOTAGE_DIM = Math.min(0.8, Math.max(0, Number(process.env.SPORTS_FOOTAGE_DIM ?? 0.4)));
import { closeLottie, drawLottie, ensureLottie } from "./lottie.mjs";
import { renderMotion } from "./motion.mjs";

const FONT = "Atkinson Hyperlegible";

const easeOutBack = (x) => { const c = 1.70158; return 1 + (c + 1) * (x - 1) ** 3 + c * (x - 1) ** 2; };
const pressAt = (elapsed, at) => {
  const p = (elapsed - at) / 0.32;
  return p <= 0 || p >= 1 ? 1 : 1 - 0.09 * Math.sin(Math.PI * p);
};

function pill(ctx, x, y, w, h, filled) {
  const r = h / 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  if (filled) {
    ctx.fillStyle = TEAL;
    ctx.fill();
  } else {
    ctx.fillStyle = "rgba(7, 13, 16, 0.72)";
    ctx.fill();
    ctx.lineWidth = 4;
    ctx.strokeStyle = TEAL;
    ctx.stroke();
  }
}

function checkMark(ctx, x, y, size, color) {
  ctx.beginPath();
  ctx.moveTo(x, y + size * 0.52);
  ctx.lineTo(x + size * 0.38, y + size * 0.88);
  ctx.lineTo(x + size, y + size * 0.12);
  ctx.lineWidth = size * 0.17;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.stroke();
}

// The Short's end card: LIKE and SUBSCRIBE pills rise in, then each is
// "pressed" and fills in the house teal. Driven by time alone, so any frame
// renders the same on its own.
export function drawEndCardButtons(ctx, width, top, elapsed) {
  const buttons = [
    { label: "LIKE", done: "LIKED", width: 300, enter: 0.35, press: 1.6 },
    { label: "SUBSCRIBE", done: "SUBSCRIBED", width: 520, enter: 0.6, press: 2.4 },
  ];
  const height = 108;
  const gap = 30;
  const total = buttons.reduce((sum, button) => sum + button.width, 0) + gap * (buttons.length - 1);
  let x = (width - total) / 2;
  for (const button of buttons) {
    const enter = Math.min(1, Math.max(0, (elapsed - button.enter) / 0.55));
    if (enter > 0) {
      const pressed = elapsed >= button.press + 0.16;
      const scale = (0.6 + 0.4 * easeOutBack(enter)) * pressAt(elapsed, button.press);
      const cx = x + button.width / 2;
      const cy = top + height / 2 + (1 - enter) * 60;
      ctx.save();
      ctx.globalAlpha = enter;
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.shadowColor = "rgba(0, 225, 233, 0.35)";
      ctx.shadowBlur = pressed ? 34 : 0;
      pill(ctx, -button.width / 2, -height / 2, button.width, height, pressed);
      ctx.shadowBlur = 0;
      const text = pressed ? button.done : button.label;
      ctx.font = `700 ${pressed && text.length > 8 ? 38 : 40}px "${FONT}"`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = pressed ? INK : WHITE;
      const mark = pressed ? 30 : 0;
      const textWidth = ctx.measureText(text).width;
      ctx.fillText(text, mark ? mark / 2 + 7 : 0, 2);
      if (mark) checkMark(ctx, -textWidth / 2 - mark / 2 - 7, -mark / 2, mark, INK);
      ctx.restore();
    }
    x += button.width + gap;
  }
}
const INK = "#070d10";
const WHITE = "#f5fbfc";
const TEAL = "#00e1e9";
const TEAM_COLORS = {
  "boston red sox": "#bd3039",
  "cleveland cavaliers": "#860038",
  "golden state warriors": "#1d428a",
  "duke blue devils": "#003087",
  duke: "#003087",
  "georgia bulldogs": "#ba0c2f",
  georgia: "#ba0c2f",
  "philadelphia 76ers": "#006bb6",
  "los angeles lakers": "#552583",
  "new york knicks": "#006bb6",
  "michigan state spartans": "#18453b",
  "michigan state": "#18453b",
  "lsu tigers": "#461d7c",
  lsu: "#461d7c",
  "texas longhorns": "#bf5700",
  texas: "#bf5700",
  "toronto blue jays": "#134a8e",
  "new york yankees": "#132448",
};
const LEAGUE_COLORS = {
  NBA: "#1d428a", MLB: "#002d72", NFL: "#013369", NHL: "#003e7e",
  NCAAF: "#1d4e2f", NCAAB: "#1d4e2f", NCAA: "#1d4e2f", WNBA: "#ff6900", MLS: "#c4122e",
};
const LEAGUE_TAGS = {
  NBA: "NBA", MLB: "MLB", NFL: "NFL", NHL: "NHL", WNBA: "WNBA", MLS: "MLS",
  NCAAF: "COLLEGE FOOTBALL", NCAAB: "COLLEGE BASKETBALL",
};

const brandLogo = await loadImage(path.join(root, "assets", "wellspring-media-logo.png")).catch(() => null);

function clearNearBlack(image) {
  if (!image) return null;
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const pixels = ctx.getImageData(0, 0, image.width, image.height);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    if (Math.max(data[index], data[index + 1], data[index + 2]) < 24) data[index + 3] = 0;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}

const brandMark = clearNearBlack(brandLogo);
const clamp = (value) => Math.max(0, Math.min(1, value || 0));

function hexToRgb(color) {
  const match = /^#?([0-9a-f]{6})$/iu.exec(color || "");
  const hex = match ? match[1] : "00e1e9";
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
}

function rgba(color, alpha) {
  const [r, g, b] = hexToRgb(color);
  return `rgba(${r},${g},${b},${alpha})`;
}

function hash(value) {
  let h = 2166136261;
  const text = String(value);
  for (let index = 0; index < text.length; index += 1) h = Math.imul(h ^ text.charCodeAt(index), 16777619);
  return h >>> 0;
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = state + 0x6D2B79F5 | 0;
    let t = Math.imul(state ^ state >>> 15, 1 | state);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export function storyColor(story) {
  const plate = story.plate?.home?.color || story.plate?.away?.color;
  if (/^#[0-9a-f]{6}$/iu.test(plate || "")) return plate;
  for (const team of story.teams || []) {
    const key = wording(team);
    if (TEAM_COLORS[key]) return TEAM_COLORS[key];
  }
  if (LEAGUE_COLORS[story.league]) return LEAGUE_COLORS[story.league];
  if (/ncaa|college/iu.test(story.league || "") && story.sport === "football") return LEAGUE_COLORS.NCAAF;
  if (/ncaa|college/iu.test(story.league || "") && story.sport === "basketball") return LEAGUE_COLORS.NCAAB;
  return TEAL;
}

export function leagueTag(story) {
  if (LEAGUE_TAGS[story.league]) return LEAGUE_TAGS[story.league];
  if (/ncaa|college/iu.test(story.league || "") && story.sport === "football") return "COLLEGE FOOTBALL";
  if (/ncaa|college/iu.test(story.league || "") && story.sport === "basketball") return "COLLEGE BASKETBALL";
  if (story.league) return String(story.league).toUpperCase();
  if (story.sport) return String(story.sport).toUpperCase();
  return "SPORTS";
}

function addNumber(set, value) {
  if (typeof value === "number" && Number.isFinite(value)) set.add(String(value));
  else if (Array.isArray(value)) for (const item of value) addNumber(set, item);
}

function licensedNumbers(story) {
  const set = new Set();
  for (const claim of story.claims || []) {
    addNumber(set, claim.value);
    addNumber(set, claim.score);
  }
  for (const match of String(story.headline || "").match(/\d+(?:\.\d+)?/gu) || []) set.add(match);
  return set;
}

function statLabel(text, number) {
  const words = String(text).replace(/[“”"']/gu, "").split(/\s+/u).filter(Boolean);
  const numeric = (word) => word.replace(/[^0-9.]/gu, "").replace(/\.+$/u, "");
  const at = words.findIndex((word) => numeric(word) === number);
  const clean = (word) => word.replace(/[^A-Za-z0-9%$]/gu, "");
  const after = [];
  if (at >= 0 && !/[.!?]/u.test(words[at])) {
    for (const word of words.slice(at + 1, at + 5)) {
      const cleaned = clean(word);
      if (cleaned) after.push(cleaned);
      if (/[.!?]/u.test(word)) break;
    }
  }
  const before = at > 0 ? words.slice(Math.max(0, at - 3), at).map(clean).filter(Boolean) : [];
  const chosen = (after.length >= 2 ? after : [...before.slice(-2), ...after]).slice(0, 4);
  return chosen.join(" ").toUpperCase() || "THE NUMBER";
}

function planStats(story) {
  const allowed = licensedNumbers(story);
  const cards = [];
  const used = new Set();
  let busyUntil = story.start;
  for (const phrase of story.phrases || []) {
    if (phrase.bumper) continue;
    const found = [...String(phrase.text).matchAll(/\d+(?:\.\d+)?/gu)].map((match) => match[0])
      .find((number) => allowed.has(number) && !used.has(number));
    if (!found) continue;
    const start = Math.max(phrase.start, busyUntil);
    if (start > phrase.end || start + 1.2 > story.end) continue;
    used.add(found);
    cards.push({
      number: Number(found), prefix: new RegExp(`\\$${found}\\b`).test(phrase.text) ? "$" : "",
      label: statLabel(phrase.text, found), start, end: start + 0.8 + 2.5 + 0.35,
    });
    busyUntil = start + 3.85;
  }
  return cards;
}

function photoForPhrase(photos, phrase) {
  if (!phrase) return null;
  const text = wording(phrase.text);
  return photos.find((photo) => photo.kind === "person" && photo.subject?.aliases?.some((alias) => includes(text, alias)))
    || photos.find((photo) => photo.subject?.aliases?.some((alias) => includes(text, alias)))
    || null;
}

function portraitFirst(photos) {
  const tall = photos.filter((photo) => photo.image && photo.image.height >= photo.image.width);
  if (!tall.length) return photos;
  const wide = photos.filter((photo) => photo.image && photo.image.height < photo.image.width);
  const mixed = [];
  while (tall.length || wide.length) {
    if (tall.length) mixed.push(tall.shift());
    if (wide.length) mixed.push(wide.shift());
  }
  return mixed;
}

function schedulePhotos(story, mode) {
  const photos = (story.photos || []).filter((photo) => photo.image);
  if (!photos.length || story.end - story.start < 0.8) return [];
  const random = mulberry32(hash(story.id || story.index || story.headline));
  const min = mode === "short" ? 2.5 : 3.5;
  const max = mode === "short" ? 3.5 : 5;
  const windows = [];
  let cursor = story.start;
  let previous = null;
  let index = 0;
  while (cursor < story.end - 0.35) {
    const phrase = (story.phrases || []).find((item) => cursor >= item.start && cursor < item.end && !item.bumper);
    let photo = photoForPhrase(photos, phrase) || photos[index % photos.length];
    if (photo === previous && photos.length > 1) photo = photos[(photos.indexOf(photo) + 1) % photos.length];
    const gap = min + random() * (max - min);
    let end = Math.min(story.end, cursor + gap);
    const next = (story.phrases || []).find((item) => item.start > cursor + 0.45 && item.start < end && photoForPhrase(photos, item)
      && photoForPhrase(photos, item) !== photo);
    if (next) end = next.start;
    if (end - cursor < 0.8) end = Math.min(story.end, cursor + 0.8);
    windows.push({
      start: cursor, end, photo,
      panX: (random() - 0.5) * 0.06, panY: (random() - 0.5) * 0.06,
    });
    previous = photo;
    index += 1;
    cursor = end;
    if (index > 24) break;
  }
  if (windows.length) windows.at(-1).end = story.end;
  return windows;
}

function placeWords(measure, text, size, maxWidth) {
  measure.font = `700 ${size}px "${FONT}"`;
  const words = String(text || "").split(/\s+/u).filter(Boolean).slice(0, 24).map((word) => ({ text: word, opacity: 0, y: 40 }));
  let x = 0;
  let line = 0;
  const gap = size * 0.28;
  for (const word of words) {
    const width = measure.measureText(word.text).width;
    if (x && x + width > maxWidth) {
      line += 1;
      x = 0;
    }
    word.x = x;
    word.w = width;
    word.line = line;
    x += width + gap;
  }
  return words;
}

function cueWords(cue) {
  if (cue.words) return cue.words;
  const pieces = cue.lines.map((line) => line.split(/\s+/u).filter(Boolean));
  const flat = pieces.flat();
  const weights = flat.map((word) => Math.max(1, word.length));
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const span = Math.max(0.05, cue.end - cue.start);
  let time = cue.start;
  let index = 0;
  const words = [];
  pieces.forEach((lineWords, lineIndex) => {
    for (const word of lineWords) {
      const end = time + (span * weights[index]) / total;
      words.push({ word, start: time, end, line: lineIndex });
      time = end;
      index += 1;
    }
  });
  cue.words = words;
  return words;
}

function drawField(ctx, state, width, height, t = 0) {
  const wash = ctx.createLinearGradient(width * 0.25, height, width, 0);
  wash.addColorStop(0, INK);
  wash.addColorStop(1, "#0b242b");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "rgba(105,191,199,0.32)";
  ctx.lineWidth = 2;
  const shift = (t * 36) % 40;
  for (let x = -height + shift; x < width + height; x += 40) {
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x + height * 0.72, 0);
    ctx.stroke();
  }
  // A full-frame pulse keeps the open and close above the stillness check
  // when there is no photograph and no game footage.
  const tri = Math.abs(((t % 3) / 1.5) - 1);
  ctx.fillStyle = `rgba(190,236,240,${(0.015 + tri * 0.045).toFixed(4)})`;
  ctx.fillRect(0, 0, width, height);
}

function drawPhoto(ctx, image, anim, width, height) {
  const alpha = clamp(anim.opacity);
  if (alpha < 0.01) return;
  const scale = anim.scale || 1.12;
  const cover = Math.max(width / image.width, height / image.height) * scale;
  const focus = image.height > image.width ? image.height / 3 : image.height / 2;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(image, (width - image.width * cover) / 2 + (anim.x || 0) * width, height / 2 - focus * cover + (anim.y || 0) * height, image.width * cover, image.height * cover);
  ctx.restore();
}

function drawReadability(ctx, width, height, color) {
  ctx.fillStyle = rgba(color, 0.16);
  ctx.fillRect(0, 0, width, height);
  const bottom = ctx.createLinearGradient(0, height * 0.4, 0, height);
  bottom.addColorStop(0, "rgba(7,13,16,0)");
  bottom.addColorStop(1, "rgba(7,13,16,0.9)");
  ctx.fillStyle = bottom;
  ctx.fillRect(0, height * 0.4, width, height * 0.6);
  const side = ctx.createLinearGradient(0, 0, width * 0.5, 0);
  side.addColorStop(0, "rgba(7,13,16,0.78)");
  side.addColorStop(1, "rgba(7,13,16,0)");
  ctx.fillStyle = side;
  ctx.fillRect(0, 0, width * 0.5, height);
}

// Story graphics with no picture behind them: a slow glow in the story color
// drifting across the set and a soft studio light sweeping over it, in place of
// the old spinning ring. No hard shape, so it never competes with the text.
function drawAccents(ctx, state, width, height, color, t = 0) {
  const [r, g, b] = hexToRgb(color);
  const angle = state.angle || 0;
  ctx.save();
  const cx = width * (0.62 + 0.22 * Math.sin(angle * 0.31));
  const cy = height * (0.42 + 0.18 * Math.cos(angle * 0.23));
  const radius = Math.max(width, height) * 0.62;
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
  glow.addColorStop(0, `rgba(${r},${g},${b},0.34)`);
  glow.addColorStop(0.45, `rgba(${r},${g},${b},0.12)`);
  glow.addColorStop(1, `rgba(${r},${g},${b},0)`);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, width, height);
  // One sweep every 6 seconds, left to right on a slant.
  const span = width * 1.8;
  const x = ((t % 6) / 6) * span - width * 0.4;
  const beam = ctx.createLinearGradient(x - width * 0.22, 0, x + width * 0.22, height * 0.35);
  beam.addColorStop(0, "rgba(255,255,255,0)");
  beam.addColorStop(0.5, "rgba(220,246,248,0.11)");
  beam.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = beam;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

export function drawBug(ctx, x, y, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  if (brandMark) ctx.drawImage(brandMark, 0, 0, 64, 64);
  ctx.font = `700 26px "${FONT}"`;
  ctx.fillStyle = WHITE;
  ctx.textBaseline = "top";
  ctx.fillText("WELLSPRING MEDIA", 76, 6);
  ctx.font = `700 16px "${FONT}"`;
  ctx.fillStyle = TEAL;
  ctx.fillText("SPORTS", 76, 36);
  ctx.restore();
}

function drawHeadline(ctx, story, width, height, mode) {
  const layout = story.layout;
  if (!layout || !story.words?.length) return;
  const scale = layout.titleScale || 1;
  const base = mode === "short" ? 58 : 64;
  const size = Math.max(22, Math.round(base * scale));
  const lineHeight = base * 1.12 * scale;
  const top = mode === "short" ? 300 : 250;
  const lower = mode === "short" ? 300 : height * 0.62;
  const y = top + (lower - top) * (layout.titleY || 0);
  const x = mode === "short" ? 64 : 88;
  ctx.font = `700 ${size}px "${FONT}"`;
  ctx.textBaseline = "top";
  for (const word of story.words) {
    const alpha = clamp(word.opacity);
    if (alpha < 0.02) continue;
    ctx.globalAlpha = alpha;
    ctx.fillStyle = WHITE;
    ctx.fillText(word.text, x + word.x * scale, y + word.line * lineHeight + (word.y || 0) * scale);
  }
  ctx.globalAlpha = 1;
}

function drawCaptions(ctx, cue, pop, t, width, height, mode) {
  if (!cue || !pop || clamp(pop.opacity) < 0.02) return;
  const words = cueWords(cue);
  const size = mode === "short" ? 54 : 44;
  ctx.save();
  ctx.font = `700 ${size}px "${FONT}"`;
  ctx.textBaseline = "top";
  const lineHeight = size * 1.18;
  const y0 = (mode === "short" ? height * 0.4 : height - 196) + (pop.y || 0);
  for (let line = 0; line < cue.lines.length; line += 1) {
    const lineWords = words.filter((word) => word.line === line);
    const lineWidth = ctx.measureText(lineWords.map((word) => word.word).join(" ")).width;
    let x = mode === "short" ? (width - lineWidth) / 2 : 88;
    const y = y0 + line * lineHeight;
    for (const word of lineWords) {
      const active = t >= word.start && t < word.end + 0.03;
      ctx.globalAlpha = clamp(pop.opacity);
      ctx.fillStyle = active ? TEAL : WHITE;
      ctx.fillText(word.word, x, y);
      x += ctx.measureText(`${word.word} `).width;
    }
  }
  ctx.restore();
}

function drawDiagram(ctx, story, state, width, height) {
  const diagram = story.diagram;
  if (!diagram || story.photos?.some((photo) => photo.image)) return;
  const boxW = Math.min(width * 0.72, 980);
  const boxH = boxW * 0.62;
  const x = (width - boxW) / 2 + Math.sin(state.angle || 0) * 10;
  const y = height * 0.34 + Math.cos((state.angle || 0) * 0.8) * 8;
  ctx.save();
  ctx.fillStyle = "rgba(16,34,42,0.88)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.strokeStyle = "rgba(105,191,199,0.7)";
  ctx.lineWidth = 2;
  ctx.strokeRect(x, y, boxW, boxH);
  ctx.font = `700 22px "${FONT}"`;
  ctx.fillStyle = TEAL;
  ctx.textBaseline = "top";
  ctx.fillText("PLAY DIAGRAM", x + 20, y + 16);
  for (const marker of story.markers || []) {
    const alpha = clamp(marker.opacity);
    if (alpha < 0.02) continue;
    const px = x + marker.x * boxW;
    const py = y + boxH - marker.y * (boxH - 50) - 20;
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(px, py, 16 * (marker.scale || 1), 0, Math.PI * 2);
    ctx.fillStyle = marker.role === "defense" ? "#253d45" : TEAL;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = marker.role === "defense" ? TEAL : INK;
    ctx.stroke();
  }
  ctx.restore();
}

function drawStat(ctx, card, t, color, width, height, mode) {
  const alpha = clamp(card.anim?.opacity);
  if (alpha < 0.02) return;
  const boxW = mode === "short" ? width * 0.82 : 620;
  const boxH = mode === "short" ? 250 : 210;
  const x = mode === "short" ? (width - boxW) / 2 : width - boxW - 72;
  const y = (mode === "short" ? height * 0.56 : height * 0.36) + (card.anim.y || 0);
  if (t - card.start < 0.5) drawLottie(ctx, "count-flash", [color], (t - card.start) / 0.5, { x, y, width: boxW, height: boxH });
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = "rgba(8,23,28,0.9)";
  ctx.fillRect(x, y, boxW, boxH);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, 8, boxH);
  const digits = String(card.number).includes(".") ? String(card.number).split(".")[1].length : 0;
  const shown = digits ? Number(card.anim.value || 0).toFixed(digits) : String(Math.round(card.anim.value || 0));
  ctx.fillStyle = WHITE;
  ctx.font = `700 ${mode === "short" ? 108 : 88}px "${FONT}"`;
  ctx.textBaseline = "top";
  ctx.fillText(`${card.prefix}${shown}`, x + 32, y + 24);
  ctx.fillStyle = TEAL;
  ctx.font = `700 ${mode === "short" ? 32 : 26}px "${FONT}"`;
  ctx.fillText(card.label, x + 36, y + boxH - 64);
  ctx.restore();
}

function drawScore(ctx, story, mode) {
  const anim = story.scoreAnim;
  const away = story.plate?.away;
  const home = story.plate?.home;
  if (!anim || clamp(anim.opacity) < 0.02 || away?.score == null || home?.score == null) return;
  const x = (mode === "short" ? 64 : 88) + anim.x;
  const y = mode === "short" ? 470 : 430;
  const boxW = mode === "short" ? 420 : 520;
  ctx.save();
  ctx.globalAlpha = clamp(anim.opacity);
  for (const [side, value, offset] of [[away, anim.away, 0], [home, anim.home, boxW / 2 + 8]]) {
    ctx.fillStyle = side.color || TEAL;
    ctx.fillRect(x + offset, y, boxW / 2 - 8, 92);
    ctx.fillStyle = WHITE;
    ctx.font = `700 22px "${FONT}"`;
    ctx.textBaseline = "top";
    ctx.fillText(String(side.short || side.name || "").toUpperCase(), x + offset + 16, y + 12);
    ctx.font = `700 40px "${FONT}"`;
    ctx.fillText(String(Math.round(value || 0)), x + offset + 16, y + 42);
  }
  ctx.restore();
}

function strapFor(story, t) {
  const windows = (story.windows || []).filter((window) => t >= window.start && t < window.end && window.anim && window.anim.opacity > 0.4);
  const photo = windows.at(-1)?.photo;
  if (photo?.kind !== "person") return "";
  const phrase = (story.phrases || []).find((item) => t >= item.start && t < item.end);
  const alias = photo.subject?.aliases?.find((name) => phrase && includes(wording(phrase.text), name));
  if (!alias) return "";
  const team = story.teams?.[0] ? String(story.teams[0]).toUpperCase() : "";
  return team ? `${alias.toUpperCase()} · ${team}` : alias.toUpperCase();
}

function drawStrap(ctx, text, width, height, mode) {
  if (!text) return;
  ctx.save();
  ctx.font = `700 26px "${FONT}"`;
  const boxW = Math.min(width - 140, ctx.measureText(text).width + 48);
  const x = mode === "short" ? 64 : 88;
  const y = mode === "short" ? height * 0.7 : height - 300;
  ctx.fillStyle = "rgba(5,11,14,0.84)";
  ctx.fillRect(x, y, boxW, 58);
  ctx.fillStyle = TEAL;
  ctx.fillRect(x, y, 6, 58);
  ctx.fillStyle = WHITE;
  ctx.textBaseline = "top";
  ctx.fillText(text, x + 22, y + 14);
  ctx.restore();
}

function drawMontage(ctx, photos, progress, width, height) {
  const frames = (photos || []).filter((photo) => photo.image);
  if (!frames.length) return;
  const tileW = Math.min(420, width * 0.28);
  const tileH = tileW * 0.62;
  const gap = 20;
  const span = frames.length * (tileW + gap);
  const travel = progress * (width + span);
  frames.forEach((photo, index) => {
    const x = width - travel + index * (tileW + gap);
    if (x > width || x + tileW < 0) return;
    ctx.drawImage(photo.image, x, height * 0.64, tileW, tileH);
  });
}

function createShow(spec) {
  const width = spec.width;
  const height = spec.height;
  const mode = spec.mode;
  const duration = spec.duration;
  for (const story of spec.stories || []) {
    story.color = storyColor(story);
    story.tagText = leagueTag(story);
    if (mode === "short") story.photos = portraitFirst([...(story.photos || [])]);
  }
  const show = { frame: null, reader: null, current: undefined };
  return {
    async ready() {
      try {
        await ensureLottie();
      } catch {
        // Animated type and bars still move if Skottie cannot start.
      }
    },
    build(timeline, state) {
      const ms = Math.max(1, duration * 1000);
      state.drift = 0;
      state.angle = 0;
      state.logo = { scale: 0.74, opacity: 0, date: 0 };
      state.sign = { y: 36, opacity: 0 };
      state.montage = 0;
      timeline.add(state, { drift: [0, 1], angle: [0, Math.PI * 2 * (duration / 2.2)], duration: ms, ease: "linear" }, 0);
      if (spec.intro) {
        const start = spec.intro.start * 1000;
        timeline.add(state.logo, { scale: [0.74, 1], opacity: [0, 1], duration: 700, ease: "outBack" }, start + 120);
        timeline.add(state.logo, { date: [0, 1], duration: 420, ease: "outExpo" }, start + 680);
        timeline.add(state, { montage: [0, 1], duration: Math.max(1, (spec.intro.end - spec.intro.start) * 1000), ease: "linear" }, start);
      }
      if (spec.outro) {
        const start = spec.outro.start * 1000;
        timeline.add(state.sign, { y: [36, 0], opacity: [0, 1], duration: 520, ease: "outExpo" }, start + 180);
        timeline.add(state, { montage: [1, 0], duration: Math.max(1, (spec.outro.end - spec.outro.start) * 1000), ease: "linear" }, start);
      }
      const measure = createCanvas(16, 16).getContext("2d");
      const base = mode === "short" ? 58 : 64;
      const maxWidth = width - (mode === "short" ? 128 : 180);
      for (const story of spec.stories || []) {
        const spoken = (story.phrases || []).find((phrase) => !phrase.bumper);
        const entrance = spoken?.start ?? story.start;
        story.words = placeWords(measure, story.headline, base, maxWidth);
        story.words.forEach((word, index) => {
          timeline.add(word, { y: [40, 0], opacity: [0, 1], duration: 480, ease: "outExpo" }, entrance * 1000 + index * 60);
        });
        story.layout = { titleScale: 1, titleY: 0 };
        const collapse = entrance + (mode === "short" ? 3 : 4);
        if (collapse < story.end - 0.3) {
          const layoutTween = {
            titleScale: [1, mode === "short" ? 0.42 : 0.48],
            duration: 560, ease: "inOutSine",
          };
          if (mode !== "short") layoutTween.titleY = [0, 1];
          timeline.add(story.layout, layoutTween, collapse * 1000);
        }
        story.tag = { x: -520, opacity: 0 };
        timeline.add(story.tag, { x: [-520, 0], opacity: [0, 1], duration: 480, ease: "outExpo" }, entrance * 1000);
        story.chips = (story.teams || []).slice(0, mode === "short" ? 2 : 3).map((name) => ({ name, scale: 0, opacity: 0 }));
        story.chips.forEach((chip, index) => {
          timeline.add(chip, { scale: [0.55, 1], opacity: [0, 1], duration: 420, ease: "outBack" }, entrance * 1000 + 160 + index * 70);
        });
        const bumper = (story.phrases || []).find((phrase) => phrase.bumper);
        story.bumperAnim = { reveal: 0 };
        if (bumper) timeline.add(story.bumperAnim, { reveal: [0, 1], duration: Math.max(300, (bumper.end - bumper.start) * 1000), ease: "outExpo" }, bumper.start * 1000);
        story.windows = schedulePhotos(story, mode);
        for (const window of story.windows) {
          const length = Math.max(1, (window.end - window.start) * 1000);
          window.anim = { scale: 1.08, x: 0, y: 0, opacity: 0 };
          timeline.add(window.anim, { scale: [1.08, 1.2], x: [0, window.panX], y: [0, window.panY], duration: length, ease: "inOutSine" }, window.start * 1000);
          timeline.add(window.anim, { opacity: [0, 1], duration: Math.min(400, length / 2), ease: "outExpo" }, window.start * 1000);
          if (length > 700) timeline.add(window.anim, { opacity: [1, 0], duration: 400, ease: "inExpo" }, window.end * 1000 - 400);
        }
        story.cards = planStats(story);
        for (const card of story.cards) {
          card.anim = { value: 0, y: 40, opacity: 0 };
          timeline.add(card.anim, { value: [0, card.number], y: [40, 0], opacity: [0, 1], duration: 800, ease: "outExpo" }, card.start * 1000);
          timeline.add(card.anim, { y: [0, -28], opacity: [1, 0], duration: 350, ease: "inExpo" }, (card.start + 3.3) * 1000);
        }
        const away = story.plate?.away;
        const home = story.plate?.home;
        if (away?.score != null && home?.score != null) {
          story.scoreAnim = { x: -560, opacity: 0, away: 0, home: 0 };
          const at = (entrance + 1.4) * 1000;
          timeline.add(story.scoreAnim, { x: [-560, 0], opacity: [0, 1], duration: 480, ease: "outExpo" }, at);
          timeline.add(story.scoreAnim, { away: [0, Number(away.score)], home: [0, Number(home.score)], duration: 800, ease: "outExpo" }, at);
          timeline.add(story.scoreAnim, { x: [0, 480], opacity: [1, 0], duration: 360, ease: "inExpo" }, at + 3000);
        }
        if (story.diagram && !(story.photos || []).some((photo) => photo.image)) {
          story.markers = (story.diagram.markers || []).map((marker) => ({ ...marker, scale: 0, opacity: 0 }));
          story.markers.forEach((marker, index) => {
            timeline.add(marker, { scale: [0, 1], opacity: [0, 1], duration: 420, ease: "outBack" }, story.start * 1000 + 360 + index * 80);
          });
        }
      }
      for (const cue of spec.captions || []) {
        cue.pop = { y: 26, opacity: 0 };
        const pop = Math.min(200, Math.max(40, (cue.end - cue.start) * 400));
        timeline.add(cue.pop, { y: [24, 0], opacity: [0, 1], duration: pop, ease: "outExpo" }, Math.max(0, cue.start) * 1000);
      }
    },
    async prepare(t) {
      const clip = (spec.clips || []).find((item) => t >= item.start && t < item.end) || null;
      if (clip === show.current) return;
      show.current = clip;
      // The pixels live in the ffmpeg underlay. This flag only tells the canvas
      // to leave that picture showing and to name it in the corner.
      show.frame = clip ? true : null;
    },
    draw(ctx, state, t) {
      const story = (spec.stories || []).find((item) => t >= item.start && t < item.end);
      const intro = spec.intro && t >= spec.intro.start && t < spec.intro.end;
      const outro = spec.outro && t >= spec.outro.start && t < spec.outro.end;
      const color = story?.color || TEAL;
      if (show.frame) {
        ctx.globalAlpha = 1;
        ctx.clearRect(0, 0, width, height);
        // A see-through black layer over all footage, so white scenes (snow,
        // jerseys, bright courts) never wash out the text on top.
        ctx.fillStyle = `rgba(0,0,0,${FOOTAGE_DIM})`;
        ctx.fillRect(0, 0, width, height);
      } else if (story && !intro && !outro) {
        drawField(ctx, state, width, height, t);
        for (const window of story.windows || []) {
          if (t < window.start - 0.05 || t > window.end + 0.05) continue;
          drawPhoto(ctx, window.photo.image, window.anim, width, height);
        }
      } else drawField(ctx, state, width, height, t);
      const pictured = Boolean(show.frame) || Boolean(story && !intro && !outro && story.windows?.some((window) => window.photo?.image && window.anim?.opacity > 0.05));
      if (story && !intro && !outro && pictured) drawReadability(ctx, width, height, color);
      if (show.frame && story && !intro && !outro && show.current?.title) {
        const label = `${show.current.label || "FILE FOOTAGE"} · ${show.current.title}`.slice(0, 72);
        ctx.save();
        ctx.font = `700 ${mode === "short" ? 22 : 18}px "${FONT}"`;
        const boxW = Math.min(width * 0.46, ctx.measureText(label).width + 28);
        const x = width - boxW - (mode === "short" ? 48 : 36);
        const y = mode === "short" ? 84 : 40;
        ctx.fillStyle = "rgba(5,11,14,0.72)";
        ctx.fillRect(x, y, boxW, mode === "short" ? 36 : 30);
        ctx.fillStyle = WHITE;
        ctx.textBaseline = "top";
        ctx.fillText(label, x + 12, y + 6);
        ctx.restore();
      }
      // Bare story graphics still have to move for the stillness check. Footage,
      // photographs, and the open and close do not get the ring on top.
      if (!pictured && !intro && !outro) drawAccents(ctx, state, width, height, color, t);
      if (intro) {
        if (t - spec.intro.start < 1.2) drawLottie(ctx, "league-burst", [TEAL], (t - spec.intro.start) / 1.2, { x: 0, y: 0, width, height });
        // No photo strip across the open: the logo and date carry it.
        if (brandMark && state.logo) {
          const size = (mode === "short" ? 460 : 420) * (state.logo.scale || 1);
          ctx.save();
          ctx.globalAlpha = clamp(state.logo.opacity);
          ctx.drawImage(brandMark, (width - size) / 2, height * 0.16, size, size);
          ctx.restore();
        }
        ctx.save();
        ctx.globalAlpha = clamp(state.logo?.opacity);
        ctx.fillStyle = TEAL;
        ctx.font = `700 ${mode === "short" ? 32 : 28}px "${FONT}"`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText("THE DAILY SPORTS RECAP", width / 2, height * (mode === "short" ? 0.48 : 0.56));
        ctx.fillRect(width / 2 - 36, height * (mode === "short" ? 0.53 : 0.6), 72, 4);
        ctx.restore();
        const dated = writtenDate(spec.date);
        if (dated && state.logo?.date > 0.02) {
          ctx.save();
          ctx.globalAlpha = clamp(state.logo.date);
          ctx.fillStyle = WHITE;
          ctx.font = `400 ${mode === "short" ? 42 : 36}px "${FONT}"`;
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.fillText(dated, width / 2, height * (mode === "short" ? 0.52 : 0.62));
          ctx.restore();
        }
      }
      if (outro) {
        drawMontage(ctx, spec.photos, state.montage || 0, width, height);
        const announced = spec.outro.announcement && t >= spec.outro.announcement.start;
        const line = announced ? "Thanks for watching" : "See you next time";
        ctx.save();
        ctx.globalAlpha = clamp(state.sign?.opacity);
        ctx.fillStyle = WHITE;
        ctx.font = `700 ${mode === "short" ? 72 : 68}px "${FONT}"`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(line, width / 2, height * 0.34 + (state.sign?.y || 0));
        ctx.fillStyle = TEAL;
        ctx.font = `700 28px "${FONT}"`;
        ctx.fillText("WELLSPRING MEDIA SPORTS", width / 2, height * 0.34 + 96);
        ctx.restore();
        // Shorts only: the episode closes on its sign alone.
        if (mode === "short" && announced) drawEndCardButtons(ctx, width, height * 0.34 + 190, t - spec.outro.announcement.start);
      }
      if (story && !intro && !outro) {
        const bumper = (story.phrases || []).find((phrase) => phrase.bumper && t >= phrase.start && t < phrase.end);
        if (bumper) {
          drawLottie(ctx, "league-burst", [color], clamp((t - bumper.start) / Math.max(0.2, bumper.end - bumper.start)), { x: 0, y: 0, width, height });
          const words = story.tagText.split(/\s+/u);
          ctx.save();
          ctx.textAlign = "center";
          ctx.textBaseline = "top";
          ctx.font = `700 ${Math.round(width * (mode === "short" ? 0.09 : 0.06))}px "${FONT}"`;
          words.forEach((word, index) => {
            const reveal = clamp((story.bumperAnim?.reveal || 0) - index * 0.08);
            ctx.globalAlpha = reveal;
            ctx.fillStyle = WHITE;
            ctx.fillText(word, width / 2, height * 0.36 + index * (mode === "short" ? 90 : 78) + (1 - reveal) * 36);
          });
          ctx.restore();
        } else if (t - story.start < 0.6) {
          drawLottie(ctx, "stinger-bars", [color], (t - story.start) / 0.6, { x: 0, y: 0, width, height });
        }
        if (story.tag && story.tag.opacity > 0.02 && !bumper) {
          ctx.save();
          ctx.globalAlpha = clamp(story.tag.opacity);
          ctx.fillStyle = TEAL;
          ctx.font = `700 ${mode === "short" ? 28 : 24}px "${FONT}"`;
          ctx.textBaseline = "top";
          ctx.fillText(story.tagText, (mode === "short" ? 64 : 88) + story.tag.x, mode === "short" ? 188 : 128);
          ctx.restore();
        }
        let chipX = mode === "short" ? 64 : 88;
        const chipY = mode === "short" ? 232 : 168;
        for (const chip of story.chips || []) {
          if (chip.opacity < 0.02) continue;
          ctx.save();
          ctx.globalAlpha = clamp(chip.opacity);
          ctx.translate(chipX, chipY);
          ctx.scale(chip.scale || 1, chip.scale || 1);
          ctx.fillStyle = color;
          const label = String(chip.name).toUpperCase();
          ctx.font = `700 22px "${FONT}"`;
          const boxW = Math.min(360, ctx.measureText(label).width + 36);
          ctx.fillRect(0, 0, boxW, 40);
          ctx.fillStyle = WHITE;
          ctx.textBaseline = "top";
          ctx.fillText(label, 16, 8);
          ctx.restore();
          chipX += 24 + Math.min(360, label.length * 14);
        }
        if (!bumper) drawHeadline(ctx, story, width, height, mode);
        drawDiagram(ctx, story, state, width, height);
        drawScore(ctx, story, mode);
        for (const card of story.cards || []) drawStat(ctx, card, t, color, width, height, mode);
        if (!bumper) drawStrap(ctx, strapFor(story, t), width, height, mode);
      }
      if (!intro) drawBug(ctx, mode === "short" ? 56 : 64, mode === "short" ? 72 : 36, mode === "short" ? 0.92 : 0.84);
      const cue = (spec.captions || []).find((item) => t >= item.start && t < item.end);
      drawCaptions(ctx, cue, cue?.pop, t, width, height, mode);
      const margin = mode === "short" ? 72 : 78;
      const barY = mode === "short" ? height - 430 : height - 48;
      const stories = spec.stories || [];
      if (stories.length) {
        const gap = 8;
        const usable = width - margin * 2;
        const barW = (usable - gap * Math.max(0, stories.length - 1)) / stories.length;
        stories.forEach((item, index) => {
          const x = margin + index * (barW + gap);
          const span = Math.max(0.001, item.end - item.start);
          const amount = t >= item.end ? 1 : t <= item.start ? 0 : (t - item.start) / span;
          ctx.fillStyle = "#253d45";
          ctx.fillRect(x, barY, barW, 6);
          ctx.fillStyle = item.color || TEAL;
          ctx.fillRect(x, barY, Math.max(0, barW * amount), 6);
        });
      }
    },
    close() {
      show.reader?.close();
      show.reader = null;
      closeLottie();
    },
  };
}

export async function renderBroadcast({ spec, signal, ...motion }) {
  spec.signal = signal;
  const show = createShow(spec);
  await show.ready();
  try {
    return await renderMotion({
      ...motion, signal,
      build: (timeline, state) => show.build(timeline, state),
      draw: (ctx, state, t) => show.draw(ctx, state, t),
      prepare: (t) => show.prepare(t),
      underlay: spec.clips || [],
    });
  } finally {
    show.close();
  }
}
