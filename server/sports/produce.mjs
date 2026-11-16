import { copyFile, mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "../canvas.mjs";
import { ffmpegPath, root } from "../config.mjs";
import { probe } from "../media.mjs";
import { run } from "../process.mjs";
import { narrateParts } from "../voice.mjs";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 30;
const FONT = "Atkinson Hyperlegible";
const INK = "#111511";
const WHITE = "#f5f7ef";
const LIME = "#c1ef61";
const MUTED = "#b6c0ab";
const dateFormatter = new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeZone: "UTC" });
const sentenceSplitter = new Intl.Segmenter("en-US", { granularity: "sentence" });

function numbered(index) {
  return String(index + 1).padStart(2, "0");
}

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
}

function fieldGeometry(ctx) {
  ctx.save();
  ctx.translate(1644, 495);
  ctx.rotate(-Math.PI / 18);
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

function verifiedSources(sources) {
  return (sources || []).filter((source) => {
    try {
      const url = new URL(source.url);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
    } catch {
      return false;
    }
  });
}

function drawChapter(episode, index) {
  const segment = episode.segments[index];
  const canvas = createCanvas(WIDTH, HEIGHT);
  const ctx = canvas.getContext("2d");
  const wash = ctx.createLinearGradient(580, HEIGHT, WIDTH, 0);
  wash.addColorStop(0, INK);
  wash.addColorStop(1, "#262f21");
  ctx.fillStyle = wash;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  ctx.strokeStyle = "#a7be7a09";
  for (let x = -HEIGHT; x < WIDTH; x += 28) {
    ctx.beginPath();
    ctx.moveTo(x, HEIGHT);
    ctx.lineTo(x + HEIGHT, 0);
    ctx.stroke();
  }
  fieldGeometry(ctx);

  ctx.fillStyle = LIME;
  ctx.fillRect(78, 66, 49, 49);
  ctx.lineCap = "round";
  ctx.lineWidth = 4;
  ctx.strokeStyle = INK;
  ctx.beginPath();
  ctx.arc(102.5, 90.5, 13, Math.PI / 4, (Math.PI * 7) / 4);
  ctx.moveTo(102.5, 90.5);
  ctx.lineTo(113, 79);
  ctx.stroke();
  textStyle(ctx, 37, WHITE, true);
  ctx.fillText("OVERTIME DESK", 145, 72);
  textStyle(ctx, 29, MUTED, false);
  ctx.textAlign = "right";
  ctx.fillText(dateFormatter.format(new Date(`${episode.date}T12:00:00Z`)), 1842, 80);
  ctx.textAlign = "left";
  ctx.fillStyle = "#a7be7a3b";
  ctx.fillRect(78, 145, 1764, 1);

  textStyle(ctx, 270, "#c1ef6119", true);
  ctx.fillText(numbered(index), 1400, 169);
  textStyle(ctx, 30, LIME, true);
  ctx.fillText(index === 0 ? "LEAD STORY" : `STORY ${numbered(index)}`, 95, 250);
  wrappedText(ctx, segment.headline, { x: 89, y: 318, width: 1095, size: 117, minSize: 73, maxLines: 4, color: WHITE, bold: true });

  const sources = verifiedSources(segment.sources).slice(0, 2);
  if (sources.length) {
    const y = 483 - (sources.length - 1) * 72;
    ctx.fillStyle = "#111711ea";
    ctx.fillRect(1274, y, 568, 102 + sources.length * 141);
    ctx.fillStyle = LIME;
    ctx.fillRect(1274, y, 5, 102 + sources.length * 141);
    textStyle(ctx, 23, MUTED, true);
    ctx.fillText("REPORTING SOURCES", 1310, y + 32);
    sources.forEach((source, sourceIndex) => {
      const row = y + 74 + sourceIndex * 141;
      textStyle(ctx, 29, LIME, true);
      ctx.fillText(source.publisher || new URL(source.url).hostname, 1310, row, 492);
      wrappedText(ctx, source.title, { x: 1310, y: row + 39, width: 492, size: 28, maxLines: 2, color: WHITE });
    });
  }

  ctx.fillStyle = "#080c08";
  ctx.fillRect(0, 854, WIDTH, 226);
  ctx.fillStyle = "#54664b";
  ctx.fillRect(0, 854, WIDTH, 1);

  const chapterWidth = 1764 / episode.segments.length;
  episode.segments.forEach((_segment, chapter) => {
    ctx.fillStyle = chapter === index ? LIME : "#374233";
    ctx.fillRect(78 + chapterWidth * chapter, 997, chapterWidth - 8, 3);
  });
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

function captionText(text) {
  return text.replaceAll("\\", "＼").replaceAll("{", "｛").replaceAll("}", "｝");
}

function captions(segments) {
  return segments.flatMap(({ text, start, end }) => {
    const lines = wrap(captionText(text), (line) => line.length <= 45);
    const cues = [];
    for (let index = 0; index < lines.length; index += 2) cues.push(lines.slice(index, index + 2));
    const weights = cues.map((cue) => cue.join(" ").length);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let time = start;
    return cues.map((cue, index) => {
      const next = time + ((end - start) * weights[index]) / total;
      const event = `Dialogue: 0,${assTime(time)},${assTime(next)},Default,,0,0,0,,${cue.join("\\N")}`;
      time = next;
      return event;
    });
  });
}

function subtitleFile(segments) {
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${WIDTH}
PlayResY: ${HEIGHT}
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${FONT},49,&H00EFF7F5,&H00EFF7F5,&H00080C08,&H00080C08,-1,0,0,0,100,100,0,0,1,1,0,2,120,120,103,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${captions(segments).join("\n")}
`;
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

export async function renderEpisode(episode, directory, report = () => {}, signal, narrate = narrateParts) {
  const parts = narrationParts(episode);
  if (episode.segments.length === 0 || new Set(parts.map(({ kind }) => kind)).size !== episode.segments.length) {
    throw new Error("Every chapter needs narration before it can be rendered.");
  }
  directory = path.resolve(directory);
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, ".render-"));
  try {
    report(7, "Preparing sports desk narration…");
    const narration = await narrate(parts, process.env.SPORTS_VOICE || "am_michael", path.join(temporary, "narration.wav"),
      (message) => report(20, message), signal, { speed: 1.02 });
    signal?.throwIfAborted();

    report(62, "Building chapter graphics and captions…");
    const chapters = episode.segments.map(({ headline }, index) => ({
      headline,
      start: index === 0 ? 0 : narration.segments.find((segment) => segment.kind === index).start,
    }));
    const slideList = [];
    for (const [index, chapter] of chapters.entries()) {
      const name = `chapter-${index}.png`;
      const canvas = drawChapter(episode, index);
      const end = chapters[index + 1]?.start ?? narration.duration;
      await writeFile(path.join(temporary, name), canvas.toBuffer("image/png"));
      slideList.push(`file '${name}'`, `duration ${(end - chapter.start).toFixed(6)}`);
    }
    slideList.push(`file 'chapter-${chapters.length - 1}.png'`);
    await mkdir(path.join(temporary, "fonts"));
    await Promise.all([
      writeFile(path.join(temporary, "chapters.ffconcat"), `${slideList.join("\n")}\n`),
      writeFile(path.join(temporary, "captions.ass"), subtitleFile(narration.segments)),
      writeFile(path.join(temporary, "playhead.png"), drawPlayhead()),
      copyFile(path.join(root, "assets/fonts/atkinson-hyperlegible-700-normal.ttf"), path.join(temporary, "fonts/atkinson.ttf")),
    ]);

    report(76, "Encoding the 1080p episode…");
    const playheadX = `78+1620*min(t/${narration.duration},1)`;
    const filters = `[0:v]fps=${FPS}[slides];[slides][1:v]overlay=x='${playheadX}':y=1010,ass=captions.ass:fontsdir=fonts[video]`;
    await run(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "1", "-i", "chapters.ffconcat",
      "-i", "playhead.png", "-i", "narration.wav", "-filter_complex_threads", "2", "-filter_complex", filters,
      "-map", "[video]", "-map", "2:a", "-c:v", "libx264", "-threads", "2", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
      "-af", "loudnorm=I=-16:TP=-1.5:LRA=7:dual_mono=true", "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
      "-movflags", "+faststart", "-t", narration.duration.toFixed(6), "episode.mp4",
    ], { cwd: temporary, signal, timeout: 20 * 60_000 });

    report(94, "Checking picture, sound, and episode length…");
    const output = path.join(temporary, "episode.mp4");
    const info = await probe(output, signal);
    const video = info.streams.find((stream) => stream.codec_type === "video");
    const audio = info.streams.find((stream) => stream.codec_type === "audio");
    const duration = Number(info.format.duration);
    if (video?.width !== WIDTH || video?.height !== HEIGHT || video?.codec_name !== "h264" ||
      audio?.codec_name !== "aac" || !Number.isFinite(duration) || Math.abs(duration - narration.duration) > 0.2) {
      throw new Error("The sports episode did not pass output validation.");
    }
    await rename(output, path.join(directory, "episode.mp4"));
    report(100, "Sports episode ready.");
    return { width: WIDTH, height: HEIGHT, duration, chapters };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
