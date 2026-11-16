import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "../canvas.mjs";
import { ffmpegPath, root } from "../config.mjs";
import { probe } from "../media.mjs";
import { run } from "../process.mjs";
import { narrateParts } from "../voice.mjs";
import { enforceShots } from "./rights.mjs";

// The broadcast package: one horizontal episode and one vertical Short per
// segment, drawn from the same narration, evidence and design version.
export const PACKAGE = { name: "overtime-desk", version: 2 };
export const EPISODE = { width: 1920, height: 1080 };
export const SHORT = { width: 1080, height: 1920 };
export const LOUDNESS = { integrated: -16, tolerance: 1, truePeak: -1 };
const FPS = 30;
const FONT = "Atkinson Hyperlegible";
const INK = "#111511";
const WHITE = "#f5f7ef";
const LIME = "#c1ef61";
const MUTED = "#b6c0ab";
const LINE = "#a7be7a66";
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
  wash.addColorStop(1, "#262f21");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, width, height);
  ctx.strokeStyle = "#a7be7a09";
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
  ctx.strokeStyle = "#a7be7a26";
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

// The show's bug: a lime tile with the overtime clock, the show name and the network.
function bug(ctx, x, y, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = LIME;
  ctx.fillRect(0, 0, 49, 49);
  ctx.lineCap = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(24.5, 24.5, 13, Math.PI / 4, (Math.PI * 7) / 4);
  ctx.moveTo(24.5, 24.5);
  ctx.lineTo(35, 13);
  ctx.stroke();
  textStyle(ctx, 37, WHITE, true);
  ctx.fillText("OVERTIME DESK", 67, 6);
  const nameWidth = ctx.measureText("OVERTIME DESK").width;
  textStyle(ctx, 20, MUTED, true);
  ctx.fillText("ISNN", 67 + nameWidth + 22, 17);
  ctx.restore();
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
  ctx.fillStyle = "#111711ea";
  ctx.fillRect(x, y, width, height);
  ctx.fillStyle = LIME;
  ctx.fillRect(x, y, 5, height);
  textStyle(ctx, 23, MUTED, true);
  ctx.fillText("REPORTING SOURCES", x + 36, y + 32);
  sources.forEach((source, index) => {
    const row = y + 74 + index * rowHeight;
    textStyle(ctx, 29, LIME, true);
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
  ctx.fillStyle = "#1a221a";
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
  ctx.fillStyle = "#1a221a";
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
  ctx.fillStyle = "#c1ef6122";
  ctx.fillRect(x0, y0 + height - 4, width, 4);
  ctx.restore();
  return { height, point: (nx, ny) => [x0 + nx * width, y0 + height - ny * height] };
}

function genericField(ctx, x0, y0, width) {
  const height = width * 0.7;
  ctx.save();
  ctx.fillStyle = "#1a221a";
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
  textStyle(ctx, 22, LIME, true);
  ctx.fillText("PLAY DIAGRAM · ORIGINAL RECREATION", x, y);
  const draw = courts[diagram.sport] || genericField;
  const court = draw(ctx, x, y + 40, courtWidth);
  const marks = new Map(diagram.markers.map((marker) => [marker.n, court.point(marker.x, marker.y)]));
  ctx.save();
  ctx.strokeStyle = "#f5f7efb0";
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
    ctx.fillStyle = defense ? "#374233" : LIME;
    ctx.fill();
    ctx.lineWidth = 3;
    ctx.strokeStyle = defense ? LIME : INK;
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
    textStyle(ctx, legendSize, marker.role === "defense" ? MUTED : LIME, true);
    ctx.fillText(String(marker.n), legendX, line);
    line = wrappedText(ctx, marker.label, { x: legendX + legendSize * 1.4, y: line, width: legendWidth - legendSize * 1.4, size: legendSize, maxLines: rows, color: WHITE }) + 6;
  }
  if (diagram.caption && line + (legendSize - 4) * 2.4 <= maxY) {
    wrappedText(ctx, diagram.caption, { x: legendX, y: line + 4, width: legendWidth, size: legendSize - 4, maxLines: 2, color: MUTED });
  }
  return court.height;
}

export function drawChapter(episode, index) {
  const segment = episode.segments[index];
  const canvas = createCanvas(EPISODE.width, EPISODE.height);
  const ctx = canvas.getContext("2d");
  background(ctx, EPISODE.width, EPISODE.height);
  if (!segment.diagram) fieldGeometry(ctx, 1644, 495);

  bug(ctx, 78, 66);
  textStyle(ctx, 29, MUTED, false);
  ctx.textAlign = "right";
  ctx.fillText(dateFormatter.format(new Date(`${episode.date}T12:00:00Z`)), 1842, 80);
  ctx.textAlign = "left";
  ctx.fillStyle = "#a7be7a3b";
  ctx.fillRect(78, 145, 1764, 1);

  textStyle(ctx, 270, "#c1ef6119", true);
  ctx.fillText(numbered(index), segment.diagram ? 820 : 1400, 169);
  textStyle(ctx, 30, LIME, true);
  ctx.fillText(index === 0 ? "LEAD STORY" : `STORY ${numbered(index)}`, 95, 250);
  const sources = verifiedSources(segment.sources).slice(0, 2);
  if (segment.diagram) {
    const bottom = wrappedText(ctx, segment.headline, { x: 89, y: 318, width: 1000, size: 104, minSize: 66, maxLines: 4, color: WHITE, bold: true });
    sourcePanel(ctx, sources, { x: 89, y: Math.min(Math.max(bottom + 30, 560), 650), width: 1000, compact: true });
    playDiagram(ctx, segment.diagram, { x: 1180, y: 200, courtWidth: 380, legendX: 1180, legendY: 612, legendWidth: 662, legendSize: 24, maxY: 840 });
  } else {
    wrappedText(ctx, segment.headline, { x: 89, y: 318, width: 1095, size: 117, minSize: 73, maxLines: 4, color: WHITE, bold: true });
    if (sources.length) sourcePanel(ctx, sources, { x: 1274, y: 483 - (sources.length - 1) * 72, width: 568 });
  }

  ctx.fillStyle = "#080c08";
  ctx.fillRect(0, 854, EPISODE.width, 226);
  ctx.fillStyle = "#54664b";
  ctx.fillRect(0, 854, EPISODE.width, 1);
  const chapterWidth = 1764 / episode.segments.length;
  episode.segments.forEach((_segment, chapter) => {
    ctx.fillStyle = chapter === index ? LIME : "#374233";
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
  ctx.fillStyle = "#a7be7a3b";
  ctx.fillRect(72, 190, 936, 1);
  textStyle(ctx, 300, "#c1ef6119", true);
  ctx.textAlign = "right";
  ctx.fillText(numbered(index), 1008, 196);
  ctx.textAlign = "left";
  textStyle(ctx, 28, LIME, true);
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
  ctx.fillText("ISNN · OVERTIME DESK", 72, 1560);
  ctx.fillStyle = "#a7be7a3b";
  ctx.fillRect(72, 1546, 936, 1);
  return canvas;
}

function narrationParts(episode) {
  return episode.segments.flatMap(({ narration }, chapter) => {
    const sentences = [...sentenceSplitter.segment(narration)].flatMap(({ segment }) =>
      wrap(segment, (line) => line.length <= 245));
    return sentences.map((text, index) => ({
      kind: chapter,
      text,
      pause: index === sentences.length - 1 ? 0.52 : 0.19,
    }));
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
  glow.addColorStop(0, `${LIME}00`);
  glow.addColorStop(1, LIME);
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, 144, 4);
  return canvas.toBuffer("image/png");
}

// The narration is mono; play it on both channels at unity gain so that
// loudness is measured and normalized the way a stereo player reproduces it.
const STEREO = "pan=stereo|c0=c0|c1=c0";
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

// Second pass of the two-pass loudness normalization, so each cut lands on the
// house target instead of drifting with the single-pass estimate.
function normalizer(measured) {
  const base = `loudnorm=I=${LOUDNESS.integrated}:TP=-1.5:LRA=7`;
  if (!measured || ![measured.integrated, measured.truePeak, measured.range, measured.threshold].every(Number.isFinite)) return `${STEREO},${base}`;
  return `${STEREO},${base}:measured_I=${measured.integrated}:measured_TP=${measured.truePeak}:measured_LRA=${measured.range}:measured_thresh=${measured.threshold}:offset=${measured.offset || 0}:linear=true`;
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

export async function renderEpisode(episode, directory, report = () => {}, signal, narrate = narrateParts) {
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
    const narration = await narrate(parts, voice, path.join(temporary, "narration.wav"), (message) => report(15, message), signal, { speed: 1.02 });
    signal?.throwIfAborted();

    report(50, "Building chapter graphics and captions…");
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

    report(60, "Encoding the 1080p episode…");
    const narrationFile = path.join(temporary, "narration.wav");
    const playheadX = `78+1620*min(t/${narration.duration},1)`;
    const filters = `[0:v]fps=${FPS}[slides];[slides][1:v]overlay=x='${playheadX}':y=1010,ass=captions.ass:fontsdir=fonts[video];` +
      `[2:a]${normalizer(await loudnessOf(narrationFile, { prepare: STEREO, signal }))}[audio]`;
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", "chapters.ffconcat",
      "-i", "playhead.png", "-i", "narration.wav", "-filter_complex_threads", "2", "-filter_complex", filters,
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
      const measured = await loudnessOf(narrationFile, { trim: span, prepare: STEREO, signal });
      await run(ffmpegPath, [
        "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", String(FPS), "-i", `short-${span.index}.png`, "-i", "narration.wav",
        "-filter_complex", `[0:v]format=yuv420p,ass=shorts/${name}.ass:fontsdir=fonts[video];[1:a]atrim=start=${span.start.toFixed(6)}:end=${span.end.toFixed(6)},asetpts=PTS-STARTPTS,${normalizer(measured)}[audio]`,
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
    const qc = { package: PACKAGE, target: { ...LOUDNESS, syncTolerance: SYNC_TOLERANCE }, passed: true, warnings, outputs, checkedAt: new Date().toISOString() };
    const rights = episode.rights ? { channel: episode.rights.channel, territory: episode.rights.territory, airAt: episode.rights.airAt } : null;
    const timeline = {
      package: PACKAGE, title: episode.title, date: episode.date, revisionId: episode.revisionId || null, rights, narrator: { voice: narration.voice || voice, engine: narration.engine || "kokoro" },
      episode: { file: "episode.mp4", captions: "captions.srt", ...EPISODE, duration, fps: FPS },
      segments: spans.map((span) => ({
        id: span.id, index: span.index, headline: span.headline, kind: episode.segments[span.index].kind || "story", start: span.start, end: span.end,
        cues: episodeCues.filter((cue) => cue.start >= span.start - 0.001 && cue.start < span.end).map(({ start, end, lines }) => ({ start, end, text: lines.join(" ") })),
        plate: `chapter-${span.index}.png`, diagram: episode.segments[span.index].diagram || null, eventId: episode.segments[span.index].eventId || null,
        claimIds: (episode.segments[span.index].claims || []).map(({ id }) => id).filter(Boolean), shots: shots[span.index],
        sources: verifiedSources(episode.segments[span.index].sources),
        short: { ...SHORT, file: shorts[span.index].file, captions: shorts[span.index].captions, duration: shorts[span.index].duration, shot: shots[span.index]?.short || null },
      })),
    };
    const credits = {
      package: PACKAGE, title: episode.title, date: episode.date, revisionId: episode.revisionId || null, rights,
      segments: spans.map((span) => ({
        id: span.id, headline: span.headline, kind: episode.segments[span.index].kind || "story", eventId: episode.segments[span.index].eventId || null,
        sources: verifiedSources(episode.segments[span.index].sources), claims: episode.segments[span.index].claims || [],
        citations: episode.segments[span.index].citations || null, shots: shots[span.index], trend: episode.segments[span.index].trend || null,
      })),
      fonts: [{ family: FONT, license: "SIL Open Font License 1.1" }],
      narration: { engine: narration.engine || "kokoro", voice: narration.voice || voice, disclosure: "synthetic narrator" },
      music: [],
      graphics: "Original Overtime Desk plates and play diagrams; no game footage or stills.",
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
      ...EPISODE, duration, chapters, shorts, qc: { passed: true, warnings },
      shots: shots.map((plan, index) => plan && { segment: index + 1, id: spans[index].id, ...Object.fromEntries(Object.entries(plan).map(([surface, shot]) => [surface, shot.kind === "ShotUse"
        ? { use: shot.assetId, grant: `${shot.grantId} v${shot.grantVersion}`, audio: shot.audio }
        : { fallback: shot.fallback, reasons: shot.reasons.map(({ code, reason }) => ({ code, reason })) }])) }),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
