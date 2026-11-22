import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "../server/canvas.mjs";
import { ffmpegPath, root } from "../server/config.mjs";
import { probe } from "../server/media.mjs";
import { run } from "../server/process.mjs";
import { closeLottie, drawLottie, ensureLottie } from "../server/sports/lottie.mjs";
import { measureMotion, renderMotion, underlaySegments } from "../server/sports/motion.mjs";
import { wav } from "../server/voice.mjs";

async function temporary(t) {
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(path.join(data, "sports-motion-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function tone(seconds) {
  const rate = 24000;
  return wav(Float32Array.from({ length: Math.round(seconds * rate) }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / rate) * 0.15), rate);
}

test("a moving picture passes motion QC and keeps the requested frame size", async (t) => {
  const directory = await temporary(t);
  const audio = path.join(directory, "tone.wav");
  const output = path.join(directory, "move.mp4");
  await writeFile(audio, tone(2));
  const rendered = await renderMotion({
    width: 320, height: 180, fps: 30, duration: 2, audio: { file: audio }, output,
    build(timeline, state) {
      state.x = 0;
      timeline.add(state, { x: [0, 260], duration: 2000, ease: "linear" }, 0);
    },
    draw(ctx, state) {
      ctx.fillStyle = "#070d10";
      ctx.fillRect(0, 0, 320, 180);
      ctx.fillStyle = "#00e1e9";
      ctx.fillRect(state.x, 20, 48, 140);
    },
  });
  assert.equal(rendered.frames, 60);
  const info = await probe(output);
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.width, 320);
  assert.equal(video.height, 180);
  assert.equal(video.r_frame_rate, "30/1");
  assert.ok(Math.abs(Number(video.duration) - 2) < 0.05);
  const measured = await measureMotion(output);
  assert.equal(measured.passed, true);
  assert.ok(measured.longestStillSeconds <= 1.5);
});

test("a hold past 1.5 seconds is a warning; a solid frame past 5 seconds fails motion QC", async (t) => {
  const directory = await temporary(t);
  const audio = path.join(directory, "tone.wav");
  const output = path.join(directory, "still.mp4");
  await writeFile(audio, tone(7));
  await renderMotion({
    width: 320, height: 180, fps: 30, duration: 7, audio: { file: audio }, output,
    build() {},
    draw(ctx) {
      ctx.fillStyle = "#12343c";
      ctx.fillRect(0, 0, 320, 180);
    },
  });
  const measured = await measureMotion(output);
  assert.equal(measured.smooth, false);
  assert.equal(measured.passed, false);
  assert.ok(measured.longestStillSeconds > 5);
});

test("the stinger starts clear, then paints bars without covering the whole frame", async (t) => {
  await ensureLottie();
  t.after(() => closeLottie());
  const canvas = createCanvas(320, 180);
  const ctx = canvas.getContext("2d");
  const snap = (progress) => {
    ctx.clearRect(0, 0, 320, 180);
    drawLottie(ctx, "stinger-bars", "#00e1e9", progress, { x: 0, y: 0, width: 320, height: 180 });
    return Buffer.from(ctx.getImageData(0, 0, 320, 180).data);
  };
  const start = snap(0);
  const mid = snap(0.5);
  const count = (pixels, test) => {
    let total = 0;
    for (let index = 3; index < pixels.length; index += 4) if (test(pixels[index])) total += 1;
    return total;
  };
  assert.ok(count(start, (alpha) => alpha === 0) > 320 * 180 * 0.9, "frame 0 should be mostly clear");
  assert.ok(count(mid, (alpha) => alpha > 0) > 40, "the middle frame should show the bars");
  assert.ok(count(mid, (alpha) => alpha === 0) > 40, "the bars should leave clear pixels");
  assert.ok(start.some((value, index) => value !== mid[index]));
});

test("the first matching clip covers a moment, and the same file plays straight through", () => {
  const segments = underlaySegments([
    { file: "intro.mp4", start: 0, end: 5 },
    { file: "game.mp4", start: 4, end: 10 },
    { file: "game.mp4", start: 10, end: 12 },
  ], 14);
  assert.deepEqual(segments, [
    { file: "intro.mp4", start: 0, end: 5 },
    { file: "game.mp4", start: 5, end: 12 },
    { file: null, start: 12, end: 14 },
  ]);
});

test("a clear graphic overlay leaves the footage visible underneath", async (t) => {
  const directory = await temporary(t);
  const audio = path.join(directory, "tone.wav");
  const plate = path.join(directory, "red.mp4");
  const output = path.join(directory, "overlay.mp4");
  await writeFile(audio, tone(1));
  await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=red:s=320x180:r=30:d=1",
    "-pix_fmt", "yuv420p", plate,
  ], { timeout: 30_000 });
  await renderMotion({
    width: 320, height: 180, fps: 30, duration: 1, audio: { file: audio }, output,
    underlay: [{ file: plate, start: 0, end: 1 }],
    build(timeline, state) {
      state.x = 40;
      timeline.add(state, { x: [40, 200], duration: 1000, ease: "linear" }, 0);
    },
    draw(ctx, state) {
      ctx.clearRect(0, 0, 320, 180);
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      ctx.fillRect(0, 0, 80, 80);
      ctx.fillStyle = "#00e1e9";
      ctx.fillRect(state.x, 100, 36, 36);
    },
  });
  const raw = await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-ss", "0.2", "-i", output,
    "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
  ], { binary: true, timeout: 30_000 });
  assert.equal(raw.length, 320 * 180 * 3);
  const pixel = (x, y) => {
    const index = (y * 320 + x) * 3;
    return [raw[index], raw[index + 1], raw[index + 2]];
  };
  const [red, green, blue] = pixel(200, 20);
  assert.ok(red > 140 && green < 100 && blue < 100, `open footage should stay red, saw ${red},${green},${blue}`);
  const [washR, washG, washB] = pixel(10, 10);
  assert.ok(washR > 140 && washG > 70 && washB > 70, `a half-white scrim should lighten the footage, saw ${washR},${washG},${washB}`);
  const [markR, markG, markB] = pixel(90, 115);
  assert.ok(markG > 100 && markB > 100 && markR < 140, `the graphic should sit on the footage, saw ${markR},${markG},${markB}`);
});
