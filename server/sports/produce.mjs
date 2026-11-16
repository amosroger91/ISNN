import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "../canvas.mjs";
import { ffmpegPath, root } from "../config.mjs";
import { probe } from "../media.mjs";
import { run } from "../process.mjs";
import { narrateParts } from "../voice.mjs";
import { enforceShots } from "./rights.mjs";
import { CommonsFootage, commonsFileTitle, footageCue, footageRange, operatorFootage } from "./footage.mjs";

// The broadcast package: one horizontal episode and one vertical Short per
// segment, drawn from the same narration, evidence and design version.
export const PACKAGE = { name: "wellspring-media-sports", version: 10 };
export const EPISODE = { width: 1920, height: 1080 };
export const SHORT = { width: 1080, height: 1920 };
export const LOUDNESS = { integrated: -16, tolerance: 1, truePeak: -1 };
const FPS = 30;
const FONT = "Atkinson Hyperlegible";
const INK = "#070d10";
const WHITE = "#f5fbfc";
const TEAL = "#00e1e9";
const MUTED = "#a9c4c9";
const LINE = "#69bfc766";
const SYNC_TOLERANCE = 0.08;
const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const sentenceSplitter = new Intl.Segmenter("en-US", { granularity: "sentence" });

const numbered = (index) => String(index + 1).padStart(2, "0");
const segmentId = (segment, index) => segment.id || `segment-${numbered(index)}`;

function textStyle(ctx, size, color, bold) {
  ctx.font = `${bold ? "700" : "400"} ${size}px "${FONT}"`;
  ctx.fillStyle = color;
  ctx.textBaseline = "top";
}

function wrap(value, fits) {
  const lines = [];
  let line = "";
  for (const word of value.trim().split(/\s+/u)) {
    const candidate = line ? `${line} ${word}` : word;
    if (!line || fits(candidate)) line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Draws wrapped text, shrinking toward minSize to fit maxLines, and returns the
// y just below the last line so callers can stack content.
function wrappedText(ctx, value, { x, y, width, size, minSize = size, maxLines, color, bold = false }) {
  let lines;
  while (true) {
    textStyle(ctx, size, color, bold);
    lines = wrap(value, (line) => ctx.measureText(line).width <= width);
    if (lines.length <= maxLines || size <= minSize) break;
    size -= 2;
  }
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] += "…";
  }
  lines.forEach((line, index) => ctx.fillText(line, x, y + index * (size * 1.11), width));
  return y + lines.length * size * 1.11;
}

function background(ctx, width, height) {
  const wash = ctx.createLinearGradient(width * 0.3, height, width, 0);
  wash.addColorStop(0, INK);
  wash.addColorStop(1, "#0b242b");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#69bfc709";
  ctx.lineWidth = 1;
  for (let x = -height; x < width; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x, height);
    ctx.lineTo(x + height, 0);
    ctx.stroke();
  }
}

function fieldGeometry(ctx, x, y, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(-Math.PI / 18);
  ctx.scale(scale, scale);
  ctx.strokeStyle = "#69bfc726";
  ctx.lineWidth = 2;
  ctx.strokeRect(-250, -305, 500, 610);
  ctx.beginPath();
  ctx.moveTo(-250, 0);
  ctx.lineTo(250, 0);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(0, 0, 76, 0, 2 * Math.PI);
  ctx.stroke();
  for (const direction of [-1, 1]) {
    ctx.strokeRect(-106, direction === -1 ? -305 : 175, 212, 130);
    ctx.beginPath();
    ctx.arc(0, direction * 175, 64, 0, Math.PI, direction === 1);
    ctx.stroke();
  }
  ctx.restore();
}

const [brandLogo, anchorPortrait] = await Promise.all([
  loadImage(path.join(root, "assets", "wellspring-media-logo.png")),
  loadImage(path.join(root, "assets", "isaac-anchor-portrait.png")),
]);

function anchorPlate() {
  const width = 310;
  const height = 74;
  const imageWidth = 84;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#08171cf0";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#16343e";
  ctx.fillRect(0, 0, imageWidth, height);
  // Frame the face and microphone within the nameplate.
  ctx.drawImage(anchorPortrait, 260, 8, 490, 432, 0, 0, imageWidth, height);
  ctx.fillStyle = TEAL;
  ctx.fillRect(imageWidth, 13, 2, height - 26);
  textStyle(ctx, 34, WHITE, true);
  ctx.fillText("Isaac Doss", imageWidth + 17, 7);
  textStyle(ctx, 20, TEAL, true);
  ctx.fillText("SPORTS ANCHOR", imageWidth + 18, 44);
  return canvas;
}

const anchorMark = anchorPlate();

function bug(ctx, x, y, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  // Trim the surrounding black margin in the layout while preserving the supplied artwork.
  ctx.drawImage(brandLogo, 48, 104, 1168, 960, 0, -7, 82, 67);
  textStyle(ctx, 32, WHITE, true);
  ctx.fillText("WELLSPRING MEDIA", 99, 0);
  const wordmark = ctx.measureText("WELLSPRING MEDIA").width;
  textStyle(ctx, 21, TEAL, true);
  ctx.fillText("SPORTS", 100, 36);
  ctx.restore();
  return { anchorX: x + scale * (99 + wordmark + 24), anchorY: y + scale * -8, scale };
}

// The anchor nameplate is an opening lower third: it sits beside the bug for
// the first seconds of the episode and of each Short, then leaves the frame.
export const ANCHOR_WINDOW = { episode: [0.3, 3.4], short: [0.3, 1.9] };
export function anchorOverlay(frame, bugX, bugY, scale = 1) {
  const canvas = createCanvas(frame.width, frame.height);
  const ctx = canvas.getContext("2d");
  textStyle(ctx, 32, WHITE, true);
  const wordmark = ctx.measureText("WELLSPRING MEDIA").width;
  ctx.drawImage(anchorMark, bugX + scale * (99 + wordmark + 24), bugY + scale * -8, anchorMark.width * scale, anchorMark.height * scale);
  return canvas.toBuffer("image/png");
}

export function verifiedSources(sources) {
  return (sources || []).filter((source) => {
    try {
      const url = new URL(source.url);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

function sourcePanel(ctx, sources, { x, y, width, compact = false }) {
  if (!sources.length) return y;
  const rowHeight = compact ? 96 : 141;
  const height = 102 + sources.length * rowHeight;
  ctx.fillStyle = "#08171cea";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = TEAL;
  ctx.fillRect(x, y, 5, height);
  textStyle(ctx, 23, MUTED, true);
  ctx.fillText("REPORTING SOURCES", x + 36, y + 32);
  sources.forEach((source, index) => {
    const row = y + 74 + index * rowHeight;
    textStyle(ctx, 29, TEAL, true);
    ctx.fillText(source.publisher || new URL(source.url).hostname, x + 36, row, width - 76);
    wrappedText(ctx, source.title || new URL(source.url).hostname, { x: x + 36, y: row + 39, width: width - 76, size: 28, maxLines: compact ? 1 : 2, color: WHITE });
  });
  return y + height;
}

// Basketball half court in feet (50 wide, 47 deep), baseline at the bottom.
function halfCourt(ctx, x0, y0, width) {
  const height = width * 0.94;
  const sx = width / 50;
  const sy = height / 47;
  const px = (ft) => x0 + ft * sx;
  const py = (ft) => y0 + height - ft * sy;
  ctx.save();
  ctx.fillStyle = "#10222a";
  ctx.fillRect(x0, y0, width, height);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, width, height);
  ctx.strokeRect(px(17), py(19), 16 * sx, 19 * sy);
  ctx.beginPath();
  ctx.arc(px(25), py(19), 6 * sx, 0, 2 * Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px(25), py(47), 6 * sx, 0, Math.PI);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px(22), py(4));
  ctx.lineTo(px(28), py(4));
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(px(25), py(5.25), 0.75 * sx, 0, 2 * Math.PI);
  ctx.stroke();
  // Three-point line: straight corners to 14.2 ft, then the 23.75 ft arc.
  const corner = 5.25 + Math.sqrt(23.75 ** 2 - 22 ** 2);
  const cornerAngle = Math.acos(-22 / 23.75);
  ctx.beginPath();
  ctx.moveTo(px(3), py(0));
  ctx.lineTo(px(3), py(corner));
  for (let step = 0; step <= 60; step++) {
    const angle = cornerAngle - (2 * cornerAngle - Math.PI) * (step / 60);
    ctx.lineTo(px(25 + 23.75 * Math.cos(angle)), py(5.25 + 23.75 * Math.sin(angle)));
  }
  ctx.lineTo(px(47), py(0));
  ctx.stroke();
  ctx.restore();
  return { height, point: (nx, ny) => [x0 + nx * width, y0 + height - ny * height] };
}

// Football field section, 160 ft wide, shown 40 yards deep; the goal line at the bottom.
function fieldSection(ctx, x0, y0, width) {
  const height = width * 0.75;
  ctx.save();
  ctx.fillStyle = "#10222a";
  ctx.fillRect(x0, y0, width, height);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, width, height);
  for (let yard = 5; yard < 40; yard += 5) {
    const y = y0 + height - (yard / 40) * height;
    ctx.lineWidth = yard % 10 === 0 ? 2 : 1;
    ctx.beginPath();
    ctx.moveTo(x0, y);
    ctx.lineTo(x0 + width, y);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  for (const hash of [0.37, 0.63]) {
    for (let yard = 1; yard < 40; yard++) {
      const y = y0 + height - (yard / 40) * height;
      ctx.beginPath();
      ctx.moveTo(x0 + hash * width - 5, y);
      ctx.lineTo(x0 + hash * width + 5, y);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "#00e1e922";
  ctx.fillRect(x0, y0 + height - 4, width, 4);
  ctx.restore();
  return { height, point: (nx, ny) => [x0 + nx * width, y0 + height - ny * height] };
}

function genericField(ctx, x0, y0, width) {
  const height = width * 0.7;
  ctx.save();
  ctx.fillStyle = "#10222a";
  ctx.fillRect(x0, y0, width, height);
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.strokeRect(x0, y0, width, height);
  ctx.restore();
  return { height, point: (nx, ny) => [x0 + nx * width, y0 + height - ny * height] };
}

const courts = { basketball: halfCourt, football: fieldSection };

// An original, labeled recreation of the decisive sequence. Never footage.
function playDiagram(ctx, diagram, { x, y, courtWidth, legendX, legendY, legendWidth, legendSize = 26, maxY = Infinity }) {
  textStyle(ctx, 22, TEAL, true);
  ctx.fillText("PLAY DIAGRAM · ORIGINAL RECREATION", x, y);
  const draw = courts[diagram.sport] || genericField;
  const court = draw(ctx, x, y + 40, courtWidth);
  const marks = new Map(diagram.markers.map((marker) => [marker.n, court.point(marker.x, marker.y)]));
  ctx.save();
  ctx.strokeStyle = "#f5fbfcb0";
  ctx.lineWidth = 3;
  for (const [from, to] of diagram.paths || []) {
    const [ax, ay] = marks.get(from) || [];
    const [bx, by] = marks.get(to) || [];
    if (ax === undefined || bx === undefined) continue;
    ctx.setLineDash([10, 8]);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    const angle = Math.atan2(by - ay, bx - ax);
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 16 * Math.cos(angle - 0.5), by - 16 * Math.sin(angle - 0.5));
    ctx.moveTo(bx, by);
    ctx.lineTo(bx - 16 * Math.cos(angle + 0.5), by - 16 * Math.sin(angle + 0.5));
    ctx.stroke();
  }
  ctx.restore();
  for (const marker of diagram.markers) {
    const [mx, my] = marks.get(marker.n);
    const defense = marker.role === "defense";
    ctx.beginPath();
    ctx.arc(mx, my, 21, 0, 2 * Math.PI);
    ctx.fillStyle = defense ? "#253d45" : TEAL;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = defense ? TEAL : INK;
    ctx.stroke();
    textStyle(ctx, 22, defense ? WHITE : INK, true);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(marker.n), mx, my + 1);
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
  }
  // The legend stops before the caption bar rather than running under it.
  let line = legendY;
  for (const marker of diagram.markers) {
    if (line + legendSize * 1.2 > maxY) break;
    const rows = line + legendSize * 2.4 > maxY ? 1 : 2;
    textStyle(ctx, legendSize, marker.role === "defense" ? MUTED : TEAL, true);
    ctx.fillText(String(marker.n), legendX, line);
    line = wrappedText(ctx, marker.label, { x: legendX + legendSize * 1.4, y: line, width: legendWidth - legendSize * 1.4, size: legendSize, maxLines: rows, color: WHITE }) + 6;
  }
  if (diagram.caption && line + (legendSize - 4) * 2.4 <= maxY) {
    wrappedText(ctx, diagram.caption, { x: legendX, y: line + 4, width: legendWidth, size: legendSize - 4, maxLines: 2, color: MUTED });
  }
  return court.height;
}

const loadStill = async (file) => {
  if (!file) return null;
  try { return await loadImage(file); } catch { return null; }
};

export async function loadPlate(plate) {
  if (!plate) return null;
  const [away, home, leader, still] = await Promise.all([
    loadStill(plate.away?.logo),
    loadStill(plate.home?.logo),
    loadStill(plate.leader?.headshot),
    loadStill(plate.still?.file),
  ]);
  return {
    ...plate,
    away: plate.away ? { ...plate.away, image: away } : null,
    home: plate.home ? { ...plate.home, image: home } : null,
    leader: plate.leader ? { ...plate.leader, image: leader } : null,
    still: plate.still ? { ...plate.still, image: still } : null,
  };
}

const contentBounds = new WeakMap();

// ESPN marks ship on a square canvas with a wide empty margin. Fit the painted
// pixels, not the canvas, or a wordmark becomes a cropped sliver.
function boundsFor(image) {
  const cached = contentBounds.get(image);
  if (cached) return cached;
  const scratch = createCanvas(image.width, image.height);
  const ctx = scratch.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height);
  const white = (index) => data[index + 3] > 240 && data[index] > 242 && data[index + 1] > 242 && data[index + 2] > 242;
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (width * height - 1) * 4];
  const whiteMatte = corners.filter(white).length >= 3;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] < 24) continue;
      if (whiteMatte && white(index)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const box = maxX < 0
    ? { x: 0, y: 0, width, height }
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  contentBounds.set(image, box);
  return box;
}

function paintFitted(ctx, image, x, y, width, height, mode) {
  const box = boundsFor(image);
  const scale = mode === "cover"
    ? Math.max(width / box.width, height / box.height)
    : Math.min(width / box.width, height / box.height);
  const w = box.width * scale;
  const h = box.height * scale;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.drawImage(image, box.x, box.y, box.width, box.height, x + (width - w) / 2, y + (height - h) / 2, w, h);
  ctx.restore();
}

function drawChip(ctx, side, x, y, width, height) {
  if (!side) return;
  ctx.fillStyle = side.color || TEAL;
  ctx.fillRect(x, y, width, height);
  const pad = 8;
  const wellH = height - pad * 2;
  const wellW = Math.min(Math.round(width * 0.52), 250);
  const wellX = x + pad;
  const wellY = y + pad;
  ctx.fillStyle = WHITE;
  ctx.fillRect(wellX, wellY, wellW, wellH);
  if (side.image) paintFitted(ctx, side.image, wellX + 6, wellY + 6, wellW - 12, wellH - 12, "contain");
  const textX = wellX + wellW + 16;
  const rgb = side.color?.match(/[0-9a-f]{2}/giu)?.map((byte) => Number.parseInt(byte, 16) / 255);
  const strength = rgb?.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  const luminance = strength?.length === 3 ? strength[0] * 0.2126 + strength[1] * 0.7152 + strength[2] * 0.0722 : 1;
  const ink = luminance > 0.20 ? INK : WHITE;
  wrappedText(ctx, side.short || side.name || "", { x: textX, y: y + (side.score == null ? (height - 32) / 2 : 18),
    width: x + width - textX - 8, size: side.score == null ? 32 : 24, minSize: 15, maxLines: 1, color: ink, bold: true });
  if (side.score != null) {
    textStyle(ctx, 40, ink, true);
    ctx.fillText(String(side.score), textX, y + 56);
  }
}

function drawMarks(ctx, plate, { x, y, width }) {
  if (!plate) return;
  const height = 112;
  const face = plate.leader?.image ? height : 0;
  const reserve = face ? face + 240 : 0;
  const sides = [plate.away, plate.home].filter(Boolean);
  const chip = Math.min(500, Math.floor((width - reserve - Math.max(0, sides.length - 1) * 16) / Math.max(1, sides.length)));
  let cursor = x;
  for (const side of sides) {
    drawChip(ctx, side, cursor, y, chip, height);
    cursor += chip + 16;
  }
  if (plate.leader?.image || plate.leader?.name) {
    if (plate.leader.image) paintFitted(ctx, plate.leader.image, cursor, y, height, height, "contain");
    const textX = cursor + (plate.leader.image ? height + 16 : 0);
    wrappedText(ctx, plate.leader.name, { x: textX, y: y + 24, width: x + width - textX, size: 28, minSize: 18, maxLines: 2, color: WHITE, bold: true });
    if (plate.leader.line) {
      textStyle(ctx, 22, MUTED, false);
      ctx.fillText(plate.leader.line, textX, y + 64);
    }
  }
  if (plate.still?.image && width >= 1400) {
    paintFitted(ctx, plate.still.image, x + width - 420, y + 128, 420, 236, "cover");
    textStyle(ctx, 16, WHITE, true);
    ctx.fillText(plate.still.label, x + width - 408, y + 372);
  }
}

export function drawChapter(episode, index) {
  const segment = episode.segments[index];
  const canvas = createCanvas(EPISODE.width, EPISODE.height);
  const ctx = canvas.getContext("2d");
  background(ctx, EPISODE.width, EPISODE.height);
  if (!segment.diagram) fieldGeometry(ctx, 1644, 495);

  bug(ctx, 78, 66);
  drawMarks(ctx, segment.plate, { x: 89, y: 150, width: 1740 });
  textStyle(ctx, 29, MUTED, false);
  ctx.textAlign = "right";
  ctx.fillText(dateFormatter.format(new Date(`${episode.date}T12:00:00Z`)), 1842, 80);
  ctx.textAlign = "left";
  ctx.fillStyle = "#69bfc73b";
  ctx.fillRect(78, 145, 1764, 1);

  textStyle(ctx, 270, "#00e1e919", true);
  ctx.fillText(numbered(index), segment.diagram ? 820 : 1400, 169);
  textStyle(ctx, 30, TEAL, true);
  ctx.fillText(index === 0 ? "LEAD STORY" : `STORY ${numbered(index)}`, 95, 276);
  const sources = verifiedSources(segment.sources).slice(0, 2);
  if (segment.diagram) {
    const bottom = wrappedText(ctx, segment.headline, { x: 89, y: 318, width: 1000, size: 104, minSize: 66, maxLines: 4, color: WHITE, bold: true });
    sourcePanel(ctx, sources, { x: 89, y: Math.min(Math.max(bottom + 30, 560), 650), width: 1000, compact: true });
    playDiagram(ctx, segment.diagram, { x: 1180, y: 200, courtWidth: 380, legendX: 1180, legendY: 612, legendWidth: 662, legendSize: 24, maxY: 840 });
  } else {
    wrappedText(ctx, segment.headline, { x: 89, y: 318, width: 1095, size: 117, minSize: 73, maxLines: 4, color: WHITE, bold: true });
    if (sources.length) sourcePanel(ctx, sources, { x: 1274, y: 483 - (sources.length - 1) * 72, width: 568 });
  }

  ctx.fillStyle = "#050b0e";
  ctx.fillRect(0, 854, EPISODE.width, 226);
  ctx.fillStyle = "#345660";
  ctx.fillRect(0, 854, EPISODE.width, 1);
  const chapterWidth = 1764 / episode.segments.length;
  episode.segments.forEach((_segment, chapter) => {
    ctx.fillStyle = chapter === index ? TEAL : "#253d45";
    ctx.fillRect(78 + chapterWidth * chapter, 997, chapterWidth - 8, 3);
  });
  return canvas;
}

// The Short keeps every score and name inside the mobile player's overlay-safe
// area: a 5% title-safe inset, nothing under the bottom 400 px, captions above it.
export function drawShort(episode, index) {
  const segment = episode.segments[index];
  const canvas = createCanvas(SHORT.width, SHORT.height);
  const ctx = canvas.getContext("2d");
  background(ctx, SHORT.width, SHORT.height);
  if (!segment.diagram) fieldGeometry(ctx, 760, 1180, 1.1);

  bug(ctx, 72, 110, 1.05);
  drawMarks(ctx, segment.plate, { x: 72, y: 210, width: 936 });
  ctx.fillStyle = "#69bfc73b";
  ctx.fillRect(72, 190, 936, 1);
  textStyle(ctx, 300, "#00e1e919", true);
  ctx.textAlign = "right";
  ctx.fillText(numbered(index), 1008, 196);
  ctx.textAlign = "left";
  textStyle(ctx, 28, TEAL, true);
  const label = index === 0 ? "LEAD STORY" : `STORY ${numbered(index)}`;
  ctx.fillText(`${label} · ${dateFormatter.format(new Date(`${episode.date}T12:00:00Z`)).toUpperCase()}`, 72, 470);
  const sources = verifiedSources(segment.sources).slice(0, 2);
  if (segment.diagram) {
    wrappedText(ctx, segment.headline, { x: 72, y: 520, width: 936, size: 80, minSize: 56, maxLines: 3, color: WHITE, bold: true });
    playDiagram(ctx, segment.diagram, { x: 72, y: 800, courtWidth: 470, legendX: 572, legendY: 846, legendWidth: 436, legendSize: 25 });
  } else {
    const bottom = wrappedText(ctx, segment.headline, { x: 72, y: 520, width: 936, size: 104, minSize: 64, maxLines: 5, color: WHITE, bold: true });
    sourcePanel(ctx, sources, { x: 72, y: Math.max(bottom + 40, 1120), width: 936, compact: true });
  }
  textStyle(ctx, 24, MUTED, true);
  ctx.fillText("WELLSPRING MEDIA · SPORTS", 72, 1560);
  ctx.fillStyle = "#69bfc73b";
  ctx.fillRect(72, 1546, 936, 1);
  return canvas;
}

function spokenPhrases(sentence) {
  const words = sentence.trim().split(/\s+/u);
  if (!words[0]) return [];
  const phrases = [];
  let start = 0;
  while (words.length - start > 24 || words.slice(start).join(" ").length > 165) {
    const limit = Math.min(start + 24, words.length - 1);
    let end = start + 1;
    let boundary = null;
    while (end < limit && words.slice(start, end + 1).join(" ").length <= 165) {
      if (end - start >= 7 && /[,;:–—]$/u.test(words[end - 1])) boundary = end;
      end++;
    }
    if (end === limit && end - start >= 7 && /[,;:–—]$/u.test(words[end - 1])) boundary = end;
    end = boundary || end;
    phrases.push(words.slice(start, end).join(" "));
    start = end;
  }
  if (start < words.length) phrases.push(words.slice(start).join(" "));
  return phrases;
}

export function narrationParts(episode) {
  return episode.segments.flatMap(({ narration }, chapter) => {
    const parts = [];
    for (const paragraph of narration.split(/\n\s*\n/u)) {
      const sentences = [...sentenceSplitter.segment(paragraph)].map(({ segment }) => segment.trim()).filter(Boolean);
      for (let index = 0; index < sentences.length; index++) {
        let sentence = sentences[index];
        const next = sentences[index + 1];
        // Keep brief lead-ins together with their sentence so the voice can carry through.
        if (next && sentence.split(/\s+/u).length <= 5 && sentence.length + next.length < 140) {
          sentence = `${sentence} ${next}`;
          index++;
        }
        const phrases = spokenPhrases(sentence);
        for (const [position, text] of phrases.entries()) {
          const lastPhrase = position === phrases.length - 1;
          const pause = lastPhrase ? (index === sentences.length - 1 ? 0.24 : 0.15) : 0.10;
          parts.push({ kind: chapter, text, pause });
        }
      }
    }
    if (parts.length) parts.at(-1).pause = 0.34;
    return parts;
  });
}

function assTime(seconds) {
  const time = Math.round(seconds * 100);
  return [Math.floor(time / 360000), Math.floor(time / 6000) % 60, Math.floor(time / 100) % 60]
    .map((part, index) => index ? String(part).padStart(2, "0") : part).join(":") + `.${String(time % 100).padStart(2, "0")}`;
}

function srtTime(seconds) {
  const time = Math.round(seconds * 1000);
  const [h, m, s] = [Math.floor(time / 3600000), Math.floor(time / 60000) % 60, Math.floor(time / 1000) % 60];
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(time % 1000).padStart(3, "0")}`;
}

function captionText(text) {
  return text.replaceAll("\\", "＼").replaceAll("{", "｛").replaceAll("}", "｝");
}

// Splits each spoken part into two-line cues, timed by their share of the text.
export function cues(parts, { offset = 0, chars = 45 } = {}) {
  return parts.flatMap(({ text, start, end }) => {
    const lines = wrap(captionText(text), (line) => line.length <= chars);
    const groups = [];
    for (let index = 0; index < lines.length; index += 2) groups.push(lines.slice(index, index + 2));
    const weights = groups.map((group) => group.join(" ").length);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let time = start;
    return groups.map((group, index) => {
      const next = time + ((end - start) * weights[index]) / total;
      const cue = { start: time - offset, end: next - offset, lines: group };
      time = next;
      return cue;
    });
  });
}

function assFile(list, { width, height, size, margins }) {
  const events = list.map(({ start, end, lines }) => `Dialogue: 0,${assTime(start)},${assTime(end)},Default,,0,0,0,,${lines.join("\\N")}`);
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${FONT},${size},&H00EFF7F5,&H00EFF7F5,&H00080C08,&H00080C08,-1,0,0,0,100,100,0,0,1,1,0,2,${margins.join(",")},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events.join("\n")}
`;
}

export function srtFile(list) {
  return list.map(({ start, end, lines }, index) => `${index + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${lines.join("\n")}\n`).join("\n");
}

function drawPlayhead() {
  const canvas = createCanvas(144, 4);
  const ctx = canvas.getContext("2d");
  const glow = ctx.createLinearGradient(0, 0, 144, 0);
  glow.addColorStop(0, `${TEAL}00`);
  glow.addColorStop(1, TEAL);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 144, 4);
  return canvas.toBuffer("image/png");
}

// The narration is mono; play it on both channels at unity gain so that
// loudness is measured and normalized the way a stereo player reproduces it.
const STEREO = "pan=stereo|c0=c0|c1=c0";
const MUSIC_ASSET = path.join(root, "assets", "background-music.mp3");
const MUSIC_BELOW_NARRATION = 27;
const encode = [
  "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
  "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
  "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
  "-movflags", "+faststart",
];

// EBU R128 measurement, optionally of one time range, after an optional
// preparation filter such as the mono-to-stereo pan.
async function loudnessOf(file, { trim, prepare, signal } = {}) {
  const chain = [
    trim && `atrim=start=${trim.start.toFixed(6)}:end=${trim.end.toFixed(6)},asetpts=PTS-STARTPTS`,
    prepare, "loudnorm=print_format=json",
  ].filter(Boolean).join(",");
  const log = await run(ffmpegPath, ["-hide_banner", "-nostats", "-i", file, "-af", chain, "-f", "null", "-"], { signal, stderr: true });
  try {
    const values = JSON.parse(log.slice(log.lastIndexOf("{")));
    return {
      integrated: Number(values.input_i), truePeak: Number(values.input_tp), range: Number(values.input_lra),
      threshold: Number(values.input_thresh), offset: Number(values.target_offset),
    };
  } catch {
    return null;
  }
}

// Measurement of the encoded file, as the audience will hear it.
export const measureLoudness = (file, signal) => loudnessOf(file, { signal });

// Mix a single continuous stereo bed so each Short inherits its own excerpt
// and the speech clock stays identical for both formats.
async function mixBackgroundMusic(narrationFile, output, duration, signal) {
  const [voice, track] = await Promise.all([
    loudnessOf(narrationFile, { prepare: STEREO, signal }),
    loudnessOf(MUSIC_ASSET, { trim: { start: 0, end: duration }, signal }),
  ]);
  const gainDb = Number.isFinite(voice?.integrated) && Number.isFinite(track?.integrated)
    ? Math.min(0, voice.integrated - track.integrated - MUSIC_BELOW_NARRATION)
    : -32;
  const fade = Math.min(0.45, duration / 4);
  const bed = [
    "aformat=channel_layouts=stereo", `atrim=duration=${duration.toFixed(6)}`, "asetpts=PTS-STARTPTS",
    `volume=${gainDb.toFixed(2)}dB`, `afade=t=in:d=${fade.toFixed(6)}`,
    `afade=t=out:st=${(duration - fade).toFixed(6)}:d=${fade.toFixed(6)}`,
  ].join(",");
  await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-i", narrationFile, "-stream_loop", "-1", "-i", MUSIC_ASSET,
    "-filter_complex", `[0:a]${STEREO}[voice];[1:a]${bed}[music];[voice][music]amix=inputs=2:duration=first:normalize=0[mix]`,
    "-map", "[mix]", "-ar", "48000", "-c:a", "pcm_f32le", output,
  ], { signal });
  return { asset: "assets/background-music.mp3", suppliedBy: "user", gainDb, targetBelowNarrationLu: MUSIC_BELOW_NARRATION };
}

// Second pass of the two-pass loudness normalization, so each cut lands on the
// house target instead of drifting with the single-pass estimate.
function normalizer(measured) {
  const base = `loudnorm=I=${LOUDNESS.integrated}:TP=-1.5:LRA=7`;
  if (!measured || ![measured.integrated, measured.truePeak, measured.range, measured.threshold].every(Number.isFinite)) return base;
  return `${base}:measured_I=${measured.integrated}:measured_TP=${measured.truePeak}:measured_LRA=${measured.range}:measured_thresh=${measured.threshold}:offset=${measured.offset || 0}:linear=true`;
}

async function inspect(file, expected, signal) {
  const info = await probe(file, signal);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  const audio = info.streams.find((stream) => stream.codec_type === "audio");
  const duration = Number(info.format.duration);
  const sync = Math.abs(Number(video?.duration ?? duration) - Number(audio?.duration ?? duration));
  const loudness = await measureLoudness(file, signal);
  const checks = {
    picture: video?.width === expected.width && video?.height === expected.height && video?.codec_name === "h264" && video?.pix_fmt === "yuv420p",
    sound: audio?.codec_name === "aac" && audio?.sample_rate === "48000" && audio?.channels === 2,
    length: Number.isFinite(duration) && Math.abs(duration - expected.duration) <= 0.2,
    sync: sync <= SYNC_TOLERANCE,
    loudness: Boolean(loudness) && Math.abs(loudness.integrated - LOUDNESS.integrated) <= LOUDNESS.tolerance && loudness.truePeak <= LOUDNESS.truePeak,
  };
  return {
    file: path.basename(file), width: video?.width, height: video?.height, codec: video?.codec_name, pixelFormat: video?.pix_fmt,
    frameRate: video?.r_frame_rate, audioCodec: audio?.codec_name, sampleRate: Number(audio?.sample_rate), channels: audio?.channels,
    duration, expectedDuration: expected.duration, syncOffset: Number(sync.toFixed(3)), loudness, checks,
    passed: checks.picture && checks.sound && checks.length && checks.sync,
  };
}

const footageFrames = {
  episode: { ...EPISODE, x: 90, y: 316, widthIn: 1740, heightIn: 478 },
  short: { ...SHORT, x: 72, y: 511, widthIn: 936, heightIn: 744 },
};

function drawFootagePlate(segment, surface) {
  const { width, height, x, y, widthIn } = footageFrames[surface];
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  background(ctx, width, height);
  bug(ctx, x, 76);
  if (surface === "episode") drawMarks(ctx, segment.plate, { x: 980, y: 34, width: 850 });
  else drawMarks(ctx, segment.plate, { x, y: 156, width: widthIn });
  wrappedText(ctx, segment.headline, {
    x, y: surface === "episode" ? 160 : 281, width: widthIn, size: surface === "episode" ? 53 : 59, minSize: 38, maxLines: surface === "episode" ? 2 : 3, color: WHITE, bold: true,
  });
  return canvas.toBuffer("image/png");
}

async function prepareFootage({ episode, spans, shots, phrases, temporary, signal, finder }) {
  const cuts = [];
  for (const span of spans) {
    signal?.throwIfAborted();
    const segment = episode.segments[span.index];
    let available;
    let pinned;
    if (segment.footage?.clipUrl) {
      const choices = await finder.candidates(segment, false, signal);
      pinned = choices.find((item) => item.type === "exact" && commonsFileTitle(item.sourceUrl) === commonsFileTitle(segment.footage.clipUrl));
    }
    const discoverySegment = pinned ? { ...segment, footage: { ...segment.footage, clipUrl: null } } : segment;
    const bySurface = {};
    for (const [surface, format] of Object.entries(footageFrames)) {
      const shot = shots[span.index]?.[surface];
      const local = await operatorFootage(shot, episode.rights?.catalog).catch(() => null);
      // An editor's exact clip takes precedence over a general event catalog match.
      const preferred = [pinned, local].filter(Boolean);
      for (let attempt = 0; attempt < 4; attempt++) {
        const clip = preferred[attempt] || (available ||= await finder.candidates(discoverySegment, episode.footageSearch, signal))
          .filter((item) => item.id !== pinned?.id)[attempt - preferred.length];
        if (!clip) break;
        try {
          const file = clip.file || await finder.download(clip, signal);
          if (!file) continue;
          const start = footageCue(clip, phrases.filter(({ kind }) => kind === span.index), span.start);
          const range = await footageRange(file, clip.sourceIn, clip.sourceOut, Math.min(clip.type === "exact" ? 15 : 9, span.end - start), signal);
          if (!range) continue;
          const stem = `footage-${surface}-${span.index}`;
          const plate = path.join(temporary, `${stem}.png`);
          const cut = path.join(temporary, `${stem}.mp4`);
          await writeFile(plate, drawFootagePlate(segment, surface));
          const { widthIn, heightIn, x, y } = format;
          const fit = `fps=${FPS},scale=${widthIn}:${heightIn}:force_original_aspect_ratio=decrease:force_divisible_by=2,pad=${widthIn}:${heightIn}:(ow-iw)/2:(oh-ih)/2:#050b0e,setsar=1`;
          await run(ffmpegPath, [
            "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", String(FPS), "-i", plate,
            "-ss", String(range.start), "-i", file, "-t", range.duration.toFixed(6), "-filter_complex_threads", "2",
            "-filter_complex", `[1:v:0]${fit}[inset];[0:v][inset]overlay=${x}:${y}:shortest=1[v]`,
            "-map", "[v]", "-an", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "17", "-threads", "2", "-pix_fmt", "yuv420p", cut,
          ], { signal, timeout: 60_000 });
          const credit = clip.sourceUrl ? { title: clip.title, creator: clip.creator, url: clip.sourceUrl, license: clip.license, licenseUrl: clip.licenseUrl, type: clip.type } : null;
          bySurface[surface] = { file: cut, start, end: start + range.duration, credit, use: clip.id, kind: clip.type, grant: clip.license || `${shot.grantId} v${shot.grantVersion}` };
          break;
        } catch {
          signal?.throwIfAborted();
          // An unavailable or unplayable asset leaves the graphics in place.
        }
      }
    }
    cuts.push(bySurface);
  }
  return cuts;
}

function footageFilters(input, cuts, firstIndex, offset = 0) {
  let label = input;
  const filters = cuts.map((cut, index) => {
    const start = (cut.start - offset).toFixed(6);
    const end = (cut.end - offset).toFixed(6);
    const output = `footageBase${index}`;
    const filter = `[${firstIndex + index}:v]setpts=PTS-STARTPTS+${start}/TB[footage${index}];` +
      `[${label}][footage${index}]overlay=eof_action=pass:repeatlast=0:enable='between(t,${start},${end})'[${output}];`;
    label = output;
    return filter;
  }).join("");
  return { filters, label, inputs: cuts.flatMap(({ file }) => ["-i", file]) };
}

export async function renderEpisode(episode, directory, report = () => {}, signal, narrate = narrateParts, fetchFootage = fetch) {
  const parts = narrationParts(episode);
  if (episode.segments.length === 0 || new Set(parts.map(({ kind }) => kind)).size !== episode.segments.length) {
    throw new Error("Every chapter needs narration before it can be rendered.");
  }
  directory = path.resolve(directory);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, ".render-"));
  const voice = process.env.SPORTS_VOICE || "am_michael";
  // Rights are rechecked at render time against the planned air time: a shot
  // selected earlier that no longer clears falls back to the Play diagram.
  const shots = episode.rights ? enforceShots(episode.segments, episode.rights) : episode.segments.map(() => null);
  const rightsWarnings = shots.flatMap((plan, index) => Object.values(plan || {}).filter((shot) => shot?.kind === "Fallback" && shot.replaced)
    .map((shot) => `${segmentId(episode.segments[index], index)} ${shot.surface}: clip ${shot.replaced} replaced by the Play diagram (${shot.reasons.map(({ reason }) => reason).join("; ")}).`));
  try {
    report(5, "Preparing sports desk narration…");
    const narration = await narrate(parts, voice, path.join(temporary, "narration.wav"), (message) => {
      const recorded = /Recording Isaac \((\d+) of (\d+)\)/u.exec(message);
      const percent = recorded
        ? 8 + Math.round(((Number(recorded[1]) - 1) / Math.max(Number(recorded[2]), 1)) * 42)
        : 15;
      report(percent, message);
    }, signal, { speed: 1.02 });
    signal?.throwIfAborted();

    report(50, "Building chapter graphics and captions…");
    for (const segment of episode.segments) segment.plate = await loadPlate(segment.plate);
    const chapters = episode.segments.map(({ headline }, index) => ({
      headline,
      start: index === 0 ? 0 : narration.segments.find((segment) => segment.kind === index).start,
    }));
    const spans = chapters.map((chapter, index) => ({
      ...chapter, index, id: segmentId(episode.segments[index], index),
      end: chapters[index + 1]?.start ?? narration.duration,
    }));
    const slideList = [];
    for (const span of spans) {
      const name = `chapter-${span.index}.png`;
      await writeFile(path.join(temporary, name), drawChapter(episode, span.index).toBuffer("image/png"));
      await writeFile(path.join(temporary, `short-${span.index}.png`), drawShort(episode, span.index).toBuffer("image/png"));
      slideList.push(`file '${name}'`, `duration ${(span.end - span.start).toFixed(6)}`);
    }
    slideList.push(`file 'chapter-${spans.length - 1}.png'`);
    const episodeCues = cues(narration.segments);
    await mkdir(path.join(temporary, "fonts"));
    await mkdir(path.join(temporary, "shorts"));
    await Promise.all([
      writeFile(path.join(temporary, "chapters.ffconcat"), `${slideList.join("\n")}\n`),
      writeFile(path.join(temporary, "captions.ass"), assFile(episodeCues, { width: EPISODE.width, height: EPISODE.height, size: 49, margins: [120, 120, 103] })),
      writeFile(path.join(temporary, "captions.srt"), srtFile(episodeCues)),
      writeFile(path.join(temporary, "playhead.png"), drawPlayhead()),
      copyFile(path.join(root, "assets/fonts/atkinson-hyperlegible-700-normal.ttf"), path.join(temporary, "fonts/atkinson.ttf")),
    ]);

    report(53, "Finding matching game footage and B-roll…");
    const footageCuts = await prepareFootage({
      episode, spans, shots, phrases: narration.segments, temporary, signal, finder: new CommonsFootage(temporary, fetchFootage),
    });
    const renderedShots = footageCuts.map((cuts, index) => {
      const plan = { ...shots[index] };
      for (const surface of Object.keys(footageFrames)) {
        const cut = cuts[surface];
        if (cut) {
          plan[surface] = { kind: "ShotUse", assetId: cut.use, grantLabel: cut.grant, audio: "muted", footageKind: cut.kind,
            start: cut.start, end: cut.end, ...(cut.credit && { credit: cut.credit }) };
        } else if (plan[surface]?.kind === "ShotUse") {
          plan[surface] = { kind: "Fallback", fallback: "Story graphics", reasons: [{ code: "unavailable-footage", reason: "The cleared footage file was unavailable or could not be rendered." }] };
        }
      }
      return Object.keys(plan).length ? plan : null;
    });
    const footageCredits = [...new Map(footageCuts.flatMap((cut) => cut.episode?.credit ? [[cut.episode.credit.url, cut.episode.credit]] : [])).values()];
    const narrationFile = path.join(temporary, "narration.wav");
    const audioFile = path.join(temporary, "episode-audio.wav");
    report(55, "Mixing the background music…");
    const music = await mixBackgroundMusic(narrationFile, audioFile, narration.duration, signal);
    report(60, "Encoding the 1080p episode…");
    const playheadX = `78+1620*min(t/${narration.duration},1)`;
    const episodeCuts = footageCuts.map(({ episode }) => episode).filter(Boolean);
    const episodeFootage = footageFilters("slides", episodeCuts, 3);
    await writeFile(path.join(temporary, "anchor-episode.png"), anchorOverlay(EPISODE, 78, 66));
    await writeFile(path.join(temporary, "anchor-short.png"), anchorOverlay(SHORT, 72, 110, 1.05));
    const anchorInput = 3 + episodeCuts.length;
    const [openIn, openOut] = ANCHOR_WINDOW.episode;
    const filters = `[0:v]fps=${FPS}[slides];${episodeFootage.filters}[${episodeFootage.label}][${anchorInput}:v]overlay=0:0:enable='between(t,${openIn},${openOut})'[opened];` +
      `[opened][1:v]overlay=x='${playheadX}':y=1010,ass=captions.ass:fontsdir=fonts[video];` +
      `[2:a]${normalizer(await loudnessOf(audioFile, { signal }))}[audio]`;
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", "chapters.ffconcat",
      "-i", "playhead.png", "-i", audioFile, ...episodeFootage.inputs, "-i", "anchor-episode.png", "-filter_complex_threads", "2", "-filter_complex", filters,
      "-map", "[video]", "-map", "[audio]", ...encode, "-t", narration.duration.toFixed(6), "episode.mp4",
    ], { cwd: temporary, signal, timeout: 20 * 60_000 });

    const shorts = [];
    for (const span of spans) {
      report(78 + Math.round((span.index / spans.length) * 14), `Cutting the Short for story ${numbered(span.index)}…`);
      const name = `segment-${numbered(span.index)}`;
      const duration = span.end - span.start;
      const shortCues = cues(narration.segments.filter((part) => part.kind === span.index), { offset: span.start, chars: 30 });
      await writeFile(path.join(temporary, `shorts/${name}.ass`), assFile(shortCues, { width: SHORT.width, height: SHORT.height, size: 52, margins: [90, 170, 400] }));
      await writeFile(path.join(temporary, `shorts/${name}.srt`), srtFile(shortCues));
      const measured = await loudnessOf(audioFile, { trim: span, signal });
      const shortCuts = [footageCuts[span.index].short].filter(Boolean);
      const shortFootage = footageFilters("shortPlate", shortCuts, 2, span.start);
      const shortAnchor = 2 + shortCuts.length;
      const [shortIn, shortOut] = ANCHOR_WINDOW.short;
      await run(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", String(FPS), "-i", `short-${span.index}.png`, "-i", audioFile,
        ...shortFootage.inputs, "-i", "anchor-short.png", "-filter_complex_threads", "2",
        "-filter_complex", `[0:v]format=yuv420p[shortPlate];${shortFootage.filters}[${shortFootage.label}][${shortAnchor}:v]overlay=0:0:enable='between(t,${shortIn},${shortOut})',ass=shorts/${name}.ass:fontsdir=fonts[video];[1:a]atrim=start=${span.start.toFixed(6)}:end=${span.end.toFixed(6)},asetpts=PTS-STARTPTS,${normalizer(measured)}[audio]`,
        "-map", "[video]", "-map", "[audio]", ...encode, "-t", duration.toFixed(6), `shorts/${name}.mp4`,
      ], { cwd: temporary, signal, timeout: 10 * 60_000 });
      await rm(path.join(temporary, `shorts/${name}.ass`), { force: true });
      shorts.push({ segment: span.index + 1, id: span.id, headline: span.headline, file: `shorts/${name}.mp4`, captions: `shorts/${name}.srt`, start: span.start, end: span.end, duration });
    }

    report(94, "Checking picture, sound, sync and loudness…");
    const outputs = [await inspect(path.join(temporary, "episode.mp4"), { ...EPISODE, duration: narration.duration }, signal)];
    for (const short of shorts) outputs.push(await inspect(path.join(temporary, short.file), { ...SHORT, duration: short.duration }, signal));
    const warnings = [...outputs.filter((output) => !output.checks.loudness).map((output) => `${output.file}: loudness outside the house target.`), ...rightsWarnings];
    if (!outputs.every((output) => output.passed)) throw new Error("The sports episode did not pass output validation.");
    const duration = outputs[0].duration;
    for (const part of narration.pacing || []) {
      if (part.rushed) warnings.push(`Narration phrase ${part.index + 1} remained fast after resynthesis (${part.wordsPerMinute} words/minute).`);
      if (part.suspiciousOnset) warnings.push(`Narration phrase ${part.index + 1} may contain an extra sound before the first word.`);
      if (part.suspiciousTail) warnings.push(`Narration phrase ${part.index + 1} may contain an extra sound after the last word.`);
    }
    const qc = { package: PACKAGE, target: { ...LOUDNESS, syncTolerance: SYNC_TOLERANCE }, passed: true, warnings, outputs, narrationPacing: narration.pacing || [], checkedAt: new Date().toISOString() };
    const rights = episode.rights ? { channel: episode.rights.channel, territory: episode.rights.territory, airAt: episode.rights.airAt } : null;
    const timeline = {
      package: PACKAGE, title: episode.title, date: episode.date, revisionId: episode.revisionId || null, rights, narrator: { voice: narration.voice || voice, engine: narration.engine || "kokoro" },
      episode: { file: "episode.mp4", captions: "captions.srt", ...EPISODE, duration, fps: FPS },
      segments: spans.map((span) => ({
        id: span.id, index: span.index, headline: span.headline, kind: episode.segments[span.index].kind || "story", start: span.start, end: span.end,
        cues: episodeCues.filter((cue) => cue.start >= span.start - 0.001 && cue.start < span.end).map(({ start, end, lines }) => ({ start, end, text: lines.join(" ") })),
        plate: `chapter-${span.index}.png`, diagram: episode.segments[span.index].diagram || null, eventId: episode.segments[span.index].eventId || null,
        claimIds: (episode.segments[span.index].claims || []).map(({ id }) => id).filter(Boolean), shots: renderedShots[span.index],
        sources: verifiedSources(episode.segments[span.index].sources),
        short: { ...SHORT, file: shorts[span.index].file, captions: shorts[span.index].captions, duration: shorts[span.index].duration, shot: renderedShots[span.index]?.short || null },
      })),
    };
    const credits = {
      package: PACKAGE, title: episode.title, date: episode.date, revisionId: episode.revisionId || null, rights,
      segments: spans.map((span) => ({
        id: span.id, headline: span.headline, kind: episode.segments[span.index].kind || "story", eventId: episode.segments[span.index].eventId || null,
        sources: verifiedSources(episode.segments[span.index].sources), claims: episode.segments[span.index].claims || [],
        citations: episode.segments[span.index].citations || null, shots: renderedShots[span.index], trend: episode.segments[span.index].trend || null,
      })),
      fonts: [{ family: FONT, license: "SIL Open Font License 1.1" }],
      narration: {
        engine: narration.engine || "kokoro", voice: narration.voice || voice,
        disclosure: narration.engine?.startsWith("qwen") ? "synthetic narration in a clone of Isaac's voice" : "synthetic narrator",
      },
      music: [music],
      graphics: footageCuts.some((cut) => cut.episode || cut.short) ? "Wellspring Media graphics with credited game and file footage where available."
        : episode.segments.some((segment) => segment.plate?.away?.image || segment.plate?.home?.image || segment.plate?.leader?.image || segment.plate?.still?.image)
        ? "Wellspring Media plates with cached ESPN team marks and player headshots. No licensed game footage was composited."
        : "Original Wellspring Media plates and play diagrams; no game footage or stills.",
    };
    await Promise.all([
      writeFile(path.join(temporary, "timeline.json"), JSON.stringify(timeline, null, 2)),
      writeFile(path.join(temporary, "credits.json"), JSON.stringify(credits, null, 2)),
      writeFile(path.join(temporary, "qc.json"), JSON.stringify(qc, null, 2)),
    ]);
    // Publish the package only after validation, and never leave a stale Shorts folder.
    await rm(path.join(directory, "shorts"), { recursive: true, force: true });
    for (const file of ["episode.mp4", "captions.srt", "timeline.json", "credits.json", "qc.json", "shorts"]) {
      await rename(path.join(temporary, file), path.join(directory, file));
    }
    report(100, "Sports episode and Shorts ready.");
    return {
      ...EPISODE, duration, chapters, shorts, footageCredits, qc: { passed: true, warnings },
      shots: renderedShots.map((plan, index) => plan && { segment: index + 1, id: spans[index].id, ...Object.fromEntries(Object.entries(plan).map(([surface, shot]) => [surface, shot.kind === "ShotUse"
        ? { use: shot.assetId, grant: shot.grantLabel, audio: shot.audio, footageKind: shot.footageKind, credit: shot.credit }
        : { fallback: shot.fallback, reasons: shot.reasons.map(({ code, reason }) => ({ code, reason })) }])) }),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
