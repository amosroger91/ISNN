import path from "node:path";
import { createCanvas, loadImage } from "../canvas.mjs";
import { root } from "../config.mjs";
import { leagueTag } from "./broadcast.mjs";

// This package shares the show's teal and its actual Wellspring mark. Team
// marks are supplied by team-logos.mjs, never approximated with generated art.
const TEAL = "#00e1e9";
const PAPER = "#f5f7ef";
const INK = "#08131b";
const DISPLAY = "Anton";
const BODY = "Atkinson Hyperlegible";
const brand = await loadImage(path.join(root, "assets/wellspring-media-logo.png"));

function polygon(ctx, points, fill) {
  ctx.beginPath();
  points.forEach(([x, y], i) => i ? ctx.lineTo(x, y) : ctx.moveTo(x, y));
  ctx.closePath();
  ctx.fillStyle = fill;
  ctx.fill();
}

function label(ctx, text, x, y, size, color = PAPER) {
  ctx.font = `700 ${size}px "${BODY}"`;
  ctx.textBaseline = "top";
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
}

function cover(ctx, image, x, y, w, h, focal) {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale, sh = h / scale;
  const fx = Math.max(0, Math.min(1, focal?.x ?? 0.5));
  const fy = Math.max(0, Math.min(1, focal?.y ?? 0.38));
  const sx = Math.max(0, Math.min(image.width - sw, image.width * fx - sw / 2));
  const sy = Math.max(0, Math.min(image.height - sh, image.height * fy - sh / 2));
  ctx.drawImage(image, sx, sy, sw, sh, x, y, w, h);
}

export function heroLogoWells(kind, count, width) {
  if (!count) return [];
  const short = kind === "short";
  const total = Math.min(count, 2);
  if (short) {
    const size = total === 1 ? 430 : 350;
    return total === 1 ? [{ x: (width - size) / 2, y: 350, size }]
      : [{ x: 122, y: 330, size }, { x: width - size - 122, y: 540, size }];
  }
  return total === 1 ? [{ x: width - 440, y: 166, size: 352 }]
    : [{ x: width - 532, y: 151, size: 258 }, { x: width - 304, y: 334, size: 258 }];
}

function logo(ctx, mark, box, cropBounds) {
  const { x, y, size } = box;
  const cx = x + size / 2, cy = y + size / 2;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.5)";
  ctx.shadowBlur = 32;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.shadowColor = "transparent";
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(cx, cy, size / 2 + 8, 0, Math.PI * 2);
  ctx.stroke();
  const crop = cropBounds(mark);
  const inner = size * 0.72;
  const scale = Math.min(inner / crop.width, inner / crop.height);
  const w = crop.width * scale, h = crop.height * scale;
  ctx.drawImage(mark, crop.x, crop.y, crop.width, crop.height, cx - w / 2, cy - h / 2, w, h);
  ctx.restore();
}

function backdrop(ctx, w, h, color, short, secondaryColor) {
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, "#162c38");
  bg.addColorStop(0.6, INK);
  bg.addColorStop(1, color);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);
  // Broad diagonal color panels give the marks their own stage, even offline.
  polygon(ctx, short ? [[0, 210], [w, 140], [w, 1000], [0, 1190]]
    : [[w * 0.63, 0], [w, 0], [w, h], [w * 0.48, h]], color);
  if (secondaryColor && secondaryColor !== color) polygon(ctx, short
    ? [[0, 610], [w, 440], [w, 1000], [0, 1190]]
    : [[w * 0.83, 0], [w, 0], [w, h], [w * 0.67, h]], secondaryColor);
  const glow = ctx.createRadialGradient(w * 0.8, h * 0.4, 4, w * 0.8, h * 0.4, w * 0.65);
  glow.addColorStop(0, "rgba(255,255,255,0.18)");
  glow.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, w, h);
  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.strokeStyle = PAPER;
  ctx.lineWidth = 2;
  for (let x = w * 0.48; x < w * 1.5; x += 42) {
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x - h * 0.3, h); ctx.stroke();
  }
  ctx.restore();
}

function masthead(ctx, short, w) {
  const x = short ? 64 : 46;
  const y = short ? 85 : 30;
  const scale = short ? 1.3 : 1;
  // Crop the well icon out of the existing brand asset; keep its real artwork.
  ctx.drawImage(brand, 215, 100, 820, 700, x, y, 66 * scale, 57 * scale);
  label(ctx, "WELLSPRING MEDIA", x + 80 * scale, y + 2, 18 * scale, TEAL);
  ctx.font = `32px "${DISPLAY}"`;
  ctx.fillStyle = PAPER;
  ctx.fillText("OVERTIME", x + 80 * scale, y + 23 * scale);
  if (!short) {
    ctx.fillStyle = TEAL;
    ctx.fillRect(w - 118, 34, 68, 7);
    ctx.fillRect(w - 102, 48, 52, 7);
    ctx.fillRect(w - 86, 62, 36, 7);
  }
}

function balanceExposure(ctx, w, h) {
  // Adjust the background before drawing authentic marks and type. A dark
  // photograph must not turn an otherwise valid video into a failed build.
  const sample = createCanvas(64, 64);
  const sc = sample.getContext("2d");
  sc.drawImage(ctx.canvas, 0, 0, 64, 64);
  const pixels = sc.getImageData(0, 0, 64, 64).data;
  let mean = 0;
  for (let i = 0; i < pixels.length; i += 4) mean += pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722;
  mean /= 4096;
  if (mean < 44) {
    ctx.fillStyle = `rgba(183,202,212,${(44 - mean) / (198.7 - mean)})`;
    ctx.fillRect(0, 0, w, h);
  } else if (mean > 185) {
    ctx.fillStyle = `rgba(8,19,27,${(mean - 185) / (mean - 17.4)})`;
    ctx.fillRect(0, 0, w, h);
  }
}

// Enumerate the tiny (2–4 word) partition space, choosing balanced, large lines
// using actual glyph widths. Never chop a word to make a template fit.
function headlineLayout(ctx, text, maxWidth, maxHeight, short) {
  const words = text.split(" ");
  let best;
  for (let mask = 0; mask < 2 ** (words.length - 1); mask += 1) {
    const lines = [words[0]];
    for (let i = 1; i < words.length; i += 1) {
      if (mask & (1 << (i - 1))) lines.push(words[i]);
      else lines[lines.length - 1] += ` ${words[i]}`;
    }
    if (lines.length > 3 || (words.length > 2 && lines.length < 2)) continue;
    ctx.font = `100px "${DISPLAY}"`;
    const widths = lines.map((line) => ctx.measureText(line).width / 100);
    const font = Math.min(short ? 190 : 158, maxWidth / Math.max(...widths), maxHeight / (lines.length * 1.13));
    const balance = Math.min(...widths) / Math.max(...widths);
    const score = font * (0.85 + balance * 0.15) - (lines.length === 3 ? 8 : 0);
    if (!best || score > best.score) best = { lines, font, score };
  }
  return best;
}

function headline(ctx, text, short, hasHero) {
  const x = short ? 70 : 46;
  const maxWidth = short ? 932 : hasHero ? 650 : 1120;
  const maxHeight = short ? 590 : 370;
  const { lines, font } = headlineLayout(ctx, text, maxWidth, maxHeight, short);
  const lineHeight = font * 1.13;
  const y = short ? 1010 : 218 + (maxHeight - lines.length * lineHeight) / 2;
  ctx.font = `${font}px "${DISPLAY}"`;
  ctx.textBaseline = "top";
  const bounds = { x: x - 10, y: y - 8, width: 0, height: lines.length * lineHeight + 24 };
  for (const [i, line] of lines.entries()) {
    const ly = y + i * lineHeight;
    const lw = ctx.measureText(line).width;
    const last = i === lines.length - 1;
    if (last) {
      polygon(ctx, [[x - 10, ly - 3], [x + lw + 22, ly - 3], [x + lw + 12, ly + font * 1.1], [x - 20, ly + font * 1.1]], TEAL);
    }
    ctx.save();
    ctx.fillStyle = last ? INK : PAPER;
    if (!last) {
      ctx.shadowColor = "rgba(0,0,0,0.7)";
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 6;
    }
    ctx.fillText(line, x, ly);
    ctx.restore();
    bounds.width = Math.max(bounds.width, lw + 44);
  }
  return Object.fromEntries(Object.entries(bounds).map(([key, value]) => [key, Math.ceil(value)]));
}

export function paintThumbnail({ canvas, text, photos, marks, story, color, secondaryColor, date, cropBounds, kind }) {
  const ctx = canvas.getContext("2d");
  const w = canvas.width, h = canvas.height;
  const short = kind === "short";
  backdrop(ctx, w, h, color, short, secondaryColor);
  if (photos.length) {
    ctx.save();
    if (short) cover(ctx, photos[0].image, 0, 200, w, 1050, photos[0].focalPoint);
    else {
      ctx.beginPath();
      ctx.moveTo(660, 0); ctx.lineTo(w, 0); ctx.lineTo(w, h); ctx.lineTo(550, h); ctx.closePath(); ctx.clip();
      cover(ctx, photos[0].image, 550, 0, w - 550, h, photos[0].focalPoint);
    }
    ctx.restore();
    const shade = ctx.createLinearGradient(short ? 0 : 490, short ? 600 : 0, short ? 0 : w, short ? 1330 : 0);
    shade.addColorStop(0, short ? "rgba(8,19,27,0)" : INK);
    shade.addColorStop(0.55, short ? "rgba(8,19,27,0.35)" : "rgba(8,19,27,0.15)");
    shade.addColorStop(1, short ? INK : "rgba(8,19,27,0)");
    ctx.fillStyle = shade;
    ctx.fillRect(0, 0, w, h);
  }
  balanceExposure(ctx, w, h);
  const wells = heroLogoWells(kind, marks.length, w);
  // With a photo, smaller stamps leave the player's face and body visible.
  if (photos.length) wells.forEach((box, i) => Object.assign(box, short
    ? { x: 70 + i * 230, y: 720, size: 190 }
    : { x: w - 254 - i * 200, y: 440, size: 170 }));
  marks.forEach((mark, i) => logo(ctx, mark, wells[i], cropBounds));

  if (!marks.length && !photos.length) {
    // A genuine editorial/no-media fallback, rather than unrelated stock art.
    ctx.save();
    ctx.globalAlpha = 0.12;
    ctx.font = `${short ? 550 : 400}px "${DISPLAY}"`;
    ctx.fillStyle = PAPER;
    ctx.fillText("OVERTIME", short ? -65 : 510, short ? 720 : 150);
    ctx.restore();
  }
  const kickerY = short ? 938 : 161;
  const kickerX = short ? 70 : 46;
  const league = leagueTag(story);
  const tag = !league || /^(?:OTHER|NEWS|OTHER NEWS|GENERAL)$/iu.test(league) ? "BEYOND THE GAME" : league;
  ctx.font = `700 ${short ? 30 : 23}px "${BODY}"`;
  const tagWidth = ctx.measureText(tag).width + 36;
  ctx.fillStyle = "rgba(8,19,27,0.9)";
  ctx.fillRect(kickerX, kickerY, tagWidth, short ? 57 : 46);
  label(ctx, tag, kickerX + 18, kickerY + 10, short ? 30 : 23, TEAL);
  ctx.strokeStyle = "rgba(0,225,233,0.6)";
  ctx.lineWidth = 1;
  ctx.strokeRect(kickerX, kickerY, tagWidth, short ? 57 : 46);
  const textBox = headline(ctx, text, short, Boolean(marks.length || photos.length));
  masthead(ctx, short, w);

  const fy = short ? 1720 : 652;
  ctx.fillStyle = TEAL;
  ctx.fillRect(short ? 70 : 46, fy, short ? 68 : 44, 4);
  label(ctx, "THE OVERTIME DESK", short ? 70 : 46, fy + 17, short ? 28 : 19);
  if (date) {
    ctx.font = `700 ${short ? 28 : 19}px "${BODY}"`;
    ctx.textAlign = "right";
    ctx.fillStyle = "#a4b8c5";
    ctx.fillText(date, w - (short ? 70 : 46), fy + 17);
    ctx.textAlign = "left";
  }
  ctx.fillStyle = TEAL;
  ctx.fillRect(0, h - 9, w, 9);
  canvas.textBox = textBox;
  canvas.logoWells = wells;
  canvas.thumbnailDesign = "wellspring-overtime-v2";
}
