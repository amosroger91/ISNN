import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { crc32, deflateSync } from "node:zlib";
import { root } from "../server/config.mjs";
import { drawChapter, loadPlate } from "../server/sports/produce.mjs";

function png(width, height, red) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      raw[row + 1 + x * 3] = red;
      raw[row + 2 + x * 3] = 20;
      raw[row + 3 + x * 3] = 20;
    }
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

test("a plate paints the team mark and the player headshot onto the chapter", async (t) => {
  const directory = await mkdtemp(path.join(root, "data", "plate-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const logo = path.join(directory, "logo.png");
  const face = path.join(directory, "face.png");
  await writeFile(logo, png(32, 32, 220));
  await writeFile(face, png(32, 32, 240));
  const plate = await loadPlate({
    away: { name: "LSU", short: "LSU", color: "#461D7C", score: null, logo },
    home: { name: "Texas", short: "TEX", color: "#BF5700", score: null, logo },
    leader: { name: "Josh Hart", line: "Knicks", headshot: face },
  });
  assert.ok(plate.away.image);
  assert.ok(plate.leader.image);
  const canvas = drawChapter({
    date: "2026-11-16",
    segments: [{ headline: "LSU and Texas", narration: "A recap.", plate, sources: [] }],
  }, 0);
  const pixels = canvas.getContext("2d").getImageData(80, 140, 1600, 160).data;
  let sawLogo = false;
  let sawFace = false;
  for (let index = 0; index < pixels.length; index += 4) {
    if (pixels[index + 1] > 40 || pixels[index + 2] > 40) continue;
    if (pixels[index] >= 235) sawFace = true;
    else if (pixels[index] > 200) sawLogo = true;
  }
  assert.ok(sawLogo, "the team mark is on the plate");
  assert.ok(sawFace, "the player headshot is on the plate");
});
