import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas } from "@napi-rs/canvas";
import { closeLottie, drawLottie, ensureLottie, lottieFailureCount, lottieMemory } from "../server/sports/lottie.mjs";

// The 2026-11-21 build failed every retry with "Cannot read properties of null
// (reading 'getCanvas')": a Short alternates the full-frame burst and the stat
// count flash every frame, each size change made a new CanvasKit surface, and
// deleted surfaces never gave their memory back. Three Shorts in, MakeSurface
// returned null. This draws the same alternation for several Shorts' worth of
// frames and requires every frame to draw with the heap and process flat.
test("Lottie stingers draw through many Shorts without exhausting memory", { timeout: 300_000 }, async () => {
  const ctx = createCanvas(1080, 1920).getContext("2d");
  await ensureLottie();
  const before = lottieMemory().heapMB;
  let rssAfterFirst = 0;
  for (let render = 0; render < 8; render += 1) {
    for (let frame = 0; frame < 60; frame += 1) {
      const color = ["#c8102e", "#0033a0", "#ffb81c", "#00e1e9"][(render + frame) % 4];
      drawLottie(ctx, "league-burst", [color], frame / 60, { x: 0, y: 0, width: 1080, height: 1920 });
      drawLottie(ctx, "count-flash", [color], frame / 60, { x: 97.2, y: 1075.2, width: 885.6, height: 250 });
    }
    assert.equal(lottieFailureCount(), 0, `render ${render} left stinger frames out`);
    closeLottie();
    if (render === 0) rssAfterFirst = process.memoryUsage().rss;
  }
  const after = lottieMemory();
  assert.equal(after.heapMB, before, "the CanvasKit heap grew");
  assert.equal(after.surfaces, 2, "one surface per size, never remade");
  assert.ok(process.memoryUsage().rss - rssAfterFirst < 300 * 1024 * 1024, "process memory kept growing per frame");
  const pixels = ctx.getImageData(0, 0, 1080, 1920).data;
  let drawn = 0;
  for (let index = 3; index < pixels.length; index += 4) if (pixels[index]) drawn += 1;
  assert.ok(drawn > 1000, "the stinger did not reach the frame");
});

test("a stinger that cannot draw leaves the frame out instead of failing the render", async () => {
  await ensureLottie();
  const ctx = createCanvas(64, 64).getContext("2d");
  assert.doesNotThrow(() => drawLottie(ctx, "no-such-stinger", ["#ffffff"], 0.5, { x: 0, y: 0, width: 64, height: 64 }));
  assert.ok(lottieFailureCount() >= 1);
  closeLottie();
  assert.equal(lottieFailureCount(), 0);
});
