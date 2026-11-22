import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { dropFailedShorts, renderShorts, SHORT } from "../server/sports/produce.mjs";
import { wav } from "../server/voice.mjs";

const exists = (file) => access(file).then(() => true, () => false);

// 2026-11-22: Short 6 failed the motion check (still for 5.5 s) and the whole
// build failed, so the 8 a.m. episode never uploaded. A failing Short is now
// left out on its own.
test("a Short that fails QC is left out; the episode and the other Shorts are kept", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "isnn-shorts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "shorts"));
  const shorts = [5, 6, 7].map((segment) => ({
    segment, headline: `Story ${segment}`, file: `shorts/segment-0${segment}.mp4`, captions: `shorts/segment-0${segment}.srt`,
  }));
  for (const short of shorts) {
    await writeFile(path.join(directory, short.file), "video");
    await writeFile(path.join(directory, short.captions), "captions");
  }
  const outputs = [
    { file: "episode.mp4", passed: true, checks: { motion: true } },
    { file: "segment-05.mp4", passed: true, checks: { motion: true } },
    { file: "segment-06.mp4", passed: false, checks: { loudness: true, motion: false }, motion: { longestStillSeconds: 5.5 } },
    { file: "segment-07.mp4", passed: false, checks: { loudness: false, motion: true }, motion: { longestStillSeconds: 0 } },
  ];
  const leftOut = [];
  await dropFailedShorts(outputs, shorts, leftOut, directory);

  assert.deepEqual(shorts.map(({ segment }) => segment), [5]);
  assert.deepEqual(outputs.map(({ file }) => file), ["episode.mp4", "segment-05.mp4"]);
  assert.deepEqual(leftOut, [
    "Short 6 (Story 6) was left out: the picture was still for 5.5s.",
    "Short 7 (Story 7) was left out: it failed the loudness check.",
  ]);
  assert.equal(await exists(path.join(directory, "shorts/segment-05.mp4")), true);
  assert.equal(await exists(path.join(directory, "shorts/segment-06.mp4")), false, "a dropped Short is never uploaded");
  assert.equal(await exists(path.join(directory, "shorts/segment-06.srt")), false);
});

test("a Short that cannot render comes back as failed and the others still render", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "isnn-shorts-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const audio = path.join(directory, "silence.wav");
  await writeFile(audio, wav(new Float32Array(24000), 24000));
  const job = (output) => ({
    motion: { width: SHORT.width, height: SHORT.height, fps: 30, duration: 1, output, audio: { file: audio } },
    spec: { mode: "short", width: SHORT.width, height: SHORT.height, duration: 1, date: "2026-11-22", stories: [], photos: [], captions: [], clips: [] },
  });
  const results = await renderShorts([
    job(path.join(directory, "good.mp4")),
    job(path.join(directory, "no-such-folder", "nested", "bad.mp4")),
  ], { onProgress: () => {} });
  assert.equal(results[0].failed, undefined, "the good Short rendered");
  assert.equal(await exists(path.join(directory, "good.mp4")), true);
  assert.equal(typeof results[1].failed, "string", "the bad one is reported, not thrown");
});

test("cancelling the build still stops the Shorts instead of skipping them", async () => {
  const controller = new AbortController();
  controller.abort(new Error("Cancelled."));
  await assert.rejects(renderShorts([{
    motion: { width: SHORT.width, height: SHORT.height, fps: 30, duration: 1, output: path.join(os.tmpdir(), "never.mp4") },
    spec: { mode: "short", width: SHORT.width, height: SHORT.height, duration: 1, date: "2026-11-22", stories: [], photos: [], captions: [], clips: [] },
  }], { signal: controller.signal, onProgress: () => {} }));
});
