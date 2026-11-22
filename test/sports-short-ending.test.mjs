import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ffmpegPath, ffprobePath } from "../server/config.mjs";
import { run } from "../server/process.mjs";
import { COVER_FRAMES, coverShortOpening, SHORT } from "../server/sports/produce.mjs";
import { createCanvas } from "../server/canvas.mjs";
import { drawEndCardButtons } from "../server/sports/broadcast.mjs";

const pixel = async (file, frame) => {
  const raw = await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-i", file, "-vf", `select='eq(n,${frame})',crop=2:2:${SHORT.width / 2}:${SHORT.height / 2},format=rgb24`,
    "-frames:v", "1", "-f", "rawvideo", "-"], { binary: true });
  return [...raw.subarray(0, 3)];
};

// YouTube's Shorts feed shows a frame of the video, not the uploaded
// thumbnail, so each Short opens on its thumbnail card.
test("a Short opens on its thumbnail for a few frames and keeps its length and sound", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "isnn-cover-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const short = path.join(directory, "segment-01.mp4");
  const cover = path.join(directory, "segment-01.jpg");
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=blue:s=${SHORT.width}x${SHORT.height}:r=30:d=1`,
    "-f", "lavfi", "-i", "sine=f=440:d=1", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", short]);
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `color=c=red:s=${SHORT.width}x${SHORT.height}`, "-frames:v", "1", cover]);
  await coverShortOpening(short, cover);
  const [r0, , b0] = await pixel(short, 0);
  assert.ok(r0 > 200 && b0 < 60, "frame 0 is the thumbnail");
  const [rN, , bN] = await pixel(short, COVER_FRAMES);
  assert.ok(bN > 200 && rN < 60, "the Short itself resumes right after");
  const probe = JSON.parse(await run(ffprobePath, ["-v", "error", "-show_entries", "format=duration:stream=codec_type", "-of", "json", short]));
  assert.ok(Math.abs(Number(probe.format.duration) - 1) < 0.05, "same length");
  assert.ok(probe.streams.some(({ codec_type }) => codec_type === "audio"), "sound kept");
});

test("the end card's buttons draw at every moment without error", () => {
  const canvas = createCanvas(SHORT.width, SHORT.height);
  const ctx = canvas.getContext("2d");
  for (const elapsed of [0, 0.4, 0.9, 1.7, 2.5, 4]) drawEndCardButtons(ctx, SHORT.width, 800, elapsed);
  const { data } = ctx.getImageData(SHORT.width / 2 + 140, 854, 1, 1);
  assert.ok(data[1] > 180 && data[2] > 180, "SUBSCRIBE ends filled in the house teal");
});
