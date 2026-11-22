import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { ImageData, createCanvas } from "@napi-rs/canvas";
import { root } from "../config.mjs";

// CanvasKit's Skottie player. anime.js moves the broadcast; Lottie is the
// stingers, bursts and flashes. One wasm instance per process, animations
// cached per file and color, surfaces freed when the render ends.
const require = createRequire(import.meta.url);
const directory = path.join(root, "assets", "lottie");
const slot = [0, 0.882, 0.914];
const files = new Map();
const animations = new Map();
let kitPromise = null;
let kit = null;



const nearSlot = (color) => Array.isArray(color) && color.length >= 3
  && Math.abs(color[0] - slot[0]) < 0.02 && Math.abs(color[1] - slot[1]) < 0.02 && Math.abs(color[2] - slot[2]) < 0.02;

function hexToUnit(color) {
  const match = /^#?([0-9a-f]{6})$/iu.exec(String(color || ""));
  const hex = match ? match[1] : "00e1e9";
  return [0, 2, 4].map((index) => Number.parseInt(hex.slice(index, index + 2), 16) / 255);
}

function recolor(node, rgb) {
  if (!node || typeof node !== "object") return;
  if ((node.ty === "fl" || node.ty === "st") && nearSlot(node.c?.k)) node.c.k = [...rgb, node.c.k[3] ?? 1];
  if (Array.isArray(node)) {
    for (const item of node) recolor(item, rgb);
    return;
  }
  for (const value of Object.values(node)) recolor(value, rgb);
}

export async function ensureLottie() {
  if (kit) return kit;
  if (!kitPromise) {
    kitPromise = (async () => {
      const CanvasKitInit = require("canvaskit-wasm/bin/full/canvaskit.js");
      kit = await CanvasKitInit({ locateFile: (file) => require.resolve(`canvaskit-wasm/bin/full/${file}`) });
      return kit;
    })();
  }
  return kitPromise;
}

function animationFor(name, color) {
  const key = `${name}|${color || ""}`;
  if (animations.has(key)) return animations.get(key);
  if (!files.has(name)) files.set(name, JSON.parse(readFileSync(path.join(directory, `${name}.json`), "utf8")));
  const json = structuredClone(files.get(name));
  recolor(json, hexToUnit(color));
  const animation = kit.MakeAnimation(JSON.stringify(json));
  animations.set(key, animation);
  return animation;
}

// CanvasKit never hands back the memory of a deleted surface, so a new surface
// per size change (every frame in a Short, where the count flash and the
// full-frame burst alternate) filled the wasm heap within three renders and
// MakeSurface returned null: "Cannot read properties of null (reading
// 'getCanvas')". So one instance lives for the whole process and each size gets
// one surface, made once and never deleted: Shorts and the episode only use a
// handful of sizes, so the heap stays flat however many builds run. (A fresh
// instance per render was tried: each costs about 1 GB of process memory that
// is not collected in time.) Animations are kept the same way, per file and
// color.
const surfaces = new Map();

function surfaceFor(width, height) {
  const key = `${width}x${height}`;
  let entry = surfaces.get(key);
  if (!entry) {
    const made = kit.MakeSurface(width, height);
    if (!made) return null;
    // Pixels are read into one wasm buffer and one ImageData per size. A fresh
    // 8 MB copy per frame grew the process by gigabytes during a Short.
    const bytes = width * height * 4;
    entry = {
      surface: made, scratch: createCanvas(width, height),
      pixels: kit.Malloc(Uint8Array, bytes), image: new ImageData(width, height), bytes,
    };
    surfaces.set(key, entry);
  }
  return entry;
}

// progress is 0 at the first frame and 1 at the last. The Lottie comp is
// stretched into rect; callers pass the on-screen box, not the comp size.
// Stingers are decoration: if Skottie cannot draw, the frame goes out without
// it rather than failing the whole build.
export function drawLottie(ctx, name, colors, progress, rect) {
  if (!kit) return;
  try {
    const width = Math.max(1, Math.round(rect.width));
    const height = Math.max(1, Math.round(rect.height));
    const color = Array.isArray(colors) ? colors[0] : colors;
    const animation = animationFor(name, color);
    if (!animation) return;
    const last = Math.max(0, animation.duration() * animation.fps() - 1);
    const frame = Math.max(0, Math.min(last, progress * last));
    const entry = surfaceFor(width, height);
    if (!entry) {
      lottieFailures += 1;
      return;
    }
    const canvas = entry.surface.getCanvas();
    canvas.clear(kit.TRANSPARENT);
    animation.seekFrame(frame);
    animation.render(canvas, kit.LTRBRect(0, 0, width, height));
    entry.surface.flush();
    const pixels = canvas.readPixels(0, 0, {
      width, height, colorType: kit.ColorType.RGBA_8888, alphaType: kit.AlphaType.Unpremul, colorSpace: kit.ColorSpace.SRGB,
    }, entry.pixels, width * 4);
    if (!pixels || pixels.length < entry.bytes) return;
    entry.image.data.set(entry.pixels.toTypedArray());
    entry.scratch.getContext("2d").putImageData(entry.image, 0, 0);
    ctx.drawImage(entry.scratch, rect.x, rect.y, width, height);
  } catch {
    lottieFailures += 1;
  }
}

let lottieFailures = 0;
export const lottieFailureCount = () => lottieFailures;

// The end of a render. Surfaces and animations stay for the next render (see
// above); only the failure count is reported and reset.
export function closeLottie() {
  if (lottieFailures) console.warn(`[sports lottie] ${lottieFailures} stinger frames could not be drawn and were left out.`);
  lottieFailures = 0;
}

export const lottieMemory = () => ({
  heapMB: kit ? Math.round(kit.HEAPU8.length / 1048576) : 0, surfaces: surfaces.size, animations: animations.size,
});
