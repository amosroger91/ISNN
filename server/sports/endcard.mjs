import path from "node:path";
import { createCanvas, loadImage } from "../canvas.mjs";
import { root } from "../config.mjs";

// The closing scene: a dark studio inspired by the Wellspring Media banner
// (acoustic panels, teal neon strips, a monitor, a mic and a camera at the
// edges, a glossy table with a light horizon), drawn in code so it can move.
// Two beats share the room: the brand reveal, then the like-and-subscribe card.
// Everything is a pure function of time, so any frame can be drawn alone.

const TEAL = "#00e1e9";
const WHITE = "#f5fbfc";
const FONT = "Atkinson Hyperlegible";

const logo = await loadImage(path.join(root, "assets", "wellspring-media-logo.png")).catch(() => null);

// The mark and the wordmark, cut from the square logo with its black cleared.
function cutOut(image, [fx, fy, fw, fh]) {
  if (!image) return null;
  const sx = Math.round(image.width * fx);
  const sy = Math.round(image.height * fy);
  const sw = Math.round(image.width * fw);
  const sh = Math.round(image.height * fh);
  const canvas = createCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
  const pixels = ctx.getImageData(0, 0, sw, sh);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    const bright = Math.max(data[index], data[index + 1], data[index + 2]);
    data[index + 3] = bright < 22 ? 0 : bright < 60 ? Math.round(((bright - 22) / 38) * 255) : 255;
  }
  ctx.putImageData(pixels, 0, 0);
  return canvas;
}
const mark = cutOut(logo, [0.18, 0.085, 0.64, 0.55]);
const wordmark = cutOut(logo, [0.045, 0.645, 0.91, 0.2]);

// Studio props are product cut-outs (transparent PNG/WebP). Each is trimmed
// to its visible pixels, shrunk to a working size and graded into the dark
// room: pulled down in brightness, cooled toward teal, with a teal rim on the
// edge facing the centre of the frame.
const STUDIO = path.join(root, "assets", "sports", "studio");
async function prop(file, { rimFrom = "right", darken = 0.5, size = 1100 } = {}) {
  const image = await loadImage(path.join(STUDIO, file)).catch(() => null);
  if (!image) return null;
  const probe = createCanvas(image.width, image.height);
  const pctx = probe.getContext("2d");
  pctx.drawImage(image, 0, 0);
  const alpha = pctx.getImageData(0, 0, image.width, image.height).data;
  let [x0, y0, x1, y1] = [image.width, image.height, 0, 0];
  for (let y = 0; y < image.height; y += 1)
    for (let x = 0; x < image.width; x += 1)
      if (alpha[(y * image.width + x) * 4 + 3] > 8) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const scale = Math.min(1, size / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);
  const canvas = createCanvas(cw, ch);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(image, x0, y0, w, h, 0, 0, cw, ch);
  // Grade: darken and cool, keeping alpha.
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = `rgba(2,10,13,${darken})`;
  ctx.fillRect(0, 0, cw, ch);
  ctx.fillStyle = "rgba(0,225,233,0.07)";
  ctx.fillRect(0, 0, cw, ch);
  // Rim: a teal wash that fades in toward one edge.
  const rim = rimFrom === "right" ? ctx.createLinearGradient(cw * 0.55, 0, cw, 0) : ctx.createLinearGradient(cw * 0.45, 0, 0, 0);
  rim.addColorStop(0, "rgba(0,225,233,0)");
  rim.addColorStop(1, "rgba(0,225,233,0.28)");
  ctx.fillStyle = rim;
  ctx.fillRect(0, 0, cw, ch);
  ctx.globalCompositeOperation = "source-over";
  return canvas;
}
const props = {
  mic: await prop("mic.webp", { rimFrom: "left", darken: 0.55 }),
  camera: await prop("camera.png", { rimFrom: "right", darken: 0.3 }),
  desk: await prop("desk.webp", { rimFrom: "right", darken: 0.5 }),
};

// Draws a prop by its bottom-centre point at a given height, with a soft
// teal halo behind it so it separates from the dark wall.
function drawProp(ctx, image, x, bottom, height, glow, s, flip = false) {
  if (!image) return;
  const width = height * (image.width / image.height);
  ctx.save();
  ctx.translate(x, bottom - height);
  if (flip) ctx.scale(-1, 1);
  ctx.shadowColor = `rgba(0,225,233,${0.35 * glow})`;
  ctx.shadowBlur = 40 * s;
  ctx.drawImage(image, -width / 2, 0, width, height);
  ctx.restore();
}

const clamp = (value) => Math.max(0, Math.min(1, value));
const span = (t, start, end) => clamp((t - start) / (end - start));
const outCubic = (x) => 1 - (1 - x) ** 3;
const inOutCubic = (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const outBack = (x) => 1 + 2.2 * (x - 1) ** 3 + 1.2 * (x - 1) ** 2;
const mix = (a, b, x) => a + (b - a) * x;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}
const dust = (() => {
  const next = random(7);
  return Array.from({ length: 70 }, () => ({ x: next(), y: next(), size: 0.6 + next() * 1.8, speed: 0.004 + next() * 0.012, phase: next() * Math.PI * 2 }));
})();

// Neon strips flicker on during the first second, then breathe.
function neon(t, offset = 0) {
  const local = t - offset;
  if (local < 0.15) return 0;
  if (local < 0.75) {
    const flicker = [0.2, 0, 0.7, 0.1, 1, 0.4, 1, 0.85, 1][Math.floor(((local - 0.15) / 0.6) * 9)] ?? 1;
    return flicker;
  }
  return 0.92 + Math.sin(local * 2.1 + offset * 5) * 0.08;
}

function tube(ctx, points, width, glow, s) {
  if (glow <= 0) return;
  ctx.save();
  ctx.lineCap = "round";
  ctx.strokeStyle = `rgba(0,225,233,${0.55 * glow})`;
  ctx.shadowColor = TEAL;
  ctx.shadowBlur = 46 * s * glow;
  ctx.lineWidth = width * 1.8;
  ctx.beginPath();
  points.forEach(([x, y], index) => (index ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.stroke();
  ctx.shadowBlur = 12 * s * glow;
  ctx.strokeStyle = `rgba(200,255,255,${0.95 * glow})`;
  ctx.lineWidth = width * 0.6;
  ctx.stroke();
  ctx.restore();
}

function beam(ctx, x, y, radius, alpha) {
  if (alpha <= 0) return;
  const glow = ctx.createRadialGradient(x, y, 0, x, y, radius);
  glow.addColorStop(0, `rgba(0,225,233,${alpha})`);
  glow.addColorStop(1, "rgba(0,225,233,0)");
  ctx.fillStyle = glow;
  ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

// The room behind everything: wall, foam, slats, strips and the monitor.
function drawRoom(ctx, W, H, t, s, layout) {
  const wall = ctx.createLinearGradient(0, 0, 0, H * layout.horizon);
  wall.addColorStop(0, "#030607");
  wall.addColorStop(1, "#0a1215");
  ctx.fillStyle = wall;
  ctx.fillRect(0, 0, W, H);

  // Acoustic foam: soft diagonal ridges on the left wall.
  ctx.save();
  ctx.beginPath();
  ctx.rect(W * layout.foam[0], 0, W * (layout.foam[1] - layout.foam[0]), H * layout.horizon);
  ctx.clip();
  for (let index = -10; index < 30; index += 1) {
    const x = W * layout.foam[0] + index * 26 * s;
    const ridge = ctx.createLinearGradient(x, 0, x + 18 * s, 0);
    ridge.addColorStop(0, "rgba(255,255,255,0)");
    ridge.addColorStop(0.5, "rgba(120,200,210,0.05)");
    ridge.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = ridge;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x + 18 * s, 0);
    ctx.lineTo(x + 18 * s + H * 0.35, H);
    ctx.lineTo(x + H * 0.35, H);
    ctx.fill();
  }
  ctx.restore();

  // Vertical slats on the right wall.
  for (let x = W * layout.slats[0]; x < W * layout.slats[1]; x += 34 * s) {
    ctx.fillStyle = "rgba(20,34,38,0.55)";
    ctx.fillRect(x, 0, 16 * s, H * layout.horizon);
  }

  const glow = neon(t);
  for (const [x, y, r] of layout.beams) beam(ctx, W * x, H * y, r * s, 0.16 * glow);
  // LED strip: a column of lit dots.
  for (const strip of layout.strips) {
    const [x, y1, y2] = strip;
    const dots = Math.round(((y2 - y1) * H) / (18 * s));
    ctx.save();
    ctx.shadowColor = TEAL;
    ctx.shadowBlur = 18 * s * glow;
    for (let index = 0; index < dots; index += 1) {
      const lit = glow * (0.75 + 0.25 * Math.sin(index * 0.9 - t * 3));
      ctx.fillStyle = `rgba(150,250,255,${lit})`;
      ctx.beginPath();
      ctx.arc(W * x, H * y1 + index * 18 * s, 4.5 * s, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }
  for (const [x1, y1, x2, y2, delay] of layout.tubes) tube(ctx, [[W * x1, H * y1], [W * x2, H * y2]], 9 * s, neon(t, delay), s);

  if (!props.desk) drawMonitor(ctx, W, H, t, s, layout.monitor);
}

function drawMonitor(ctx, W, H, t, s, [fx, fy, fw]) {
  const x = W * fx;
  const y = H * fy;
  const w = W * fw;
  const h = w * 0.58;
  ctx.save();
  ctx.globalAlpha = 0.7;
  ctx.fillStyle = "#070a0c";
  roundRect(ctx, x - 6 * s, y - 6 * s, w + 12 * s, h + 12 * s, 6 * s);
  ctx.fill();
  // An editing timeline: a sunrise preview, scopes, tracks and a playhead.
  const screen = ctx.createLinearGradient(x, y, x, y + h);
  screen.addColorStop(0, "#0e2b3f");
  screen.addColorStop(1, "#071521");
  ctx.fillStyle = screen;
  ctx.fillRect(x, y, w, h);
  const preview = { x: x + w * 0.3, y: y + h * 0.08, w: w * 0.4, h: h * 0.38 };
  const sky = ctx.createLinearGradient(0, preview.y, 0, preview.y + preview.h);
  sky.addColorStop(0, "#2b4f7a");
  sky.addColorStop(0.55, "#f39a5b");
  sky.addColorStop(1, "#2a2036");
  ctx.fillStyle = sky;
  ctx.fillRect(preview.x, preview.y, preview.w, preview.h);
  beam(ctx, preview.x + preview.w / 2, preview.y + preview.h * 0.6, preview.w * 0.25, 0.0);
  ctx.fillStyle = "rgba(255,220,170,0.9)";
  ctx.beginPath();
  ctx.arc(preview.x + preview.w / 2, preview.y + preview.h * 0.62, preview.h * 0.08, 0, Math.PI * 2);
  ctx.fill();
  // Scopes on each side, bouncing.
  for (const side of [x + w * 0.05, x + w * 0.76]) {
    for (let bar = 0; bar < 7; bar += 1) {
      const level = 0.3 + 0.7 * Math.abs(Math.sin(t * (2 + bar * 0.37) + bar));
      ctx.fillStyle = bar % 3 === 0 ? "#3fd47a" : bar % 3 === 1 ? "#e6c64a" : "#e0575b";
      ctx.fillRect(side + bar * w * 0.026, preview.y + preview.h * (1 - level), w * 0.016, preview.h * level);
    }
  }
  // Tracks and a moving playhead.
  for (let track = 0; track < 4; track += 1) {
    const ty = y + h * (0.58 + track * 0.09);
    ctx.fillStyle = track < 2 ? "rgba(70,140,200,0.65)" : "rgba(60,200,170,0.55)";
    for (let clip = 0; clip < 5; clip += 1) ctx.fillRect(x + w * (0.04 + clip * 0.19), ty, w * (0.12 + ((track + clip) % 3) * 0.02), h * 0.055);
  }
  const head = x + w * (0.05 + ((t * 0.07) % 0.9));
  ctx.fillStyle = "#ff5a5a";
  ctx.fillRect(head, y + h * 0.54, 2 * s, h * 0.42);
  ctx.restore();
}

// The glossy table, its light horizon and a slow specular sweep.
function drawTable(ctx, W, H, t, s, layout, flare) {
  const top = H * layout.horizon;
  const floor = ctx.createLinearGradient(0, top, 0, H);
  floor.addColorStop(0, "#0d1416");
  floor.addColorStop(1, "#040607");
  ctx.fillStyle = floor;
  ctx.fillRect(0, top, W, H - top);
  const reach = W * mix(0.05, 0.55, outCubic(flare));
  const line = ctx.createLinearGradient(W / 2 - reach, 0, W / 2 + reach, 0);
  line.addColorStop(0, "rgba(0,225,233,0)");
  line.addColorStop(0.5, `rgba(170,255,255,${0.95 * flare})`);
  line.addColorStop(1, "rgba(0,225,233,0)");
  ctx.fillStyle = line;
  ctx.fillRect(W / 2 - reach, top - 1.5 * s, reach * 2, 3 * s);
  // The flare where the horizon meets the logo, and its pool of light on the table.
  ctx.save();
  ctx.translate(W / 2, top);
  ctx.scale(1, 0.18);
  beam(ctx, 0, 0, W * 0.32 * flare, 0.5 * flare);
  ctx.restore();
  beam(ctx, W / 2, top, 70 * s * flare, 0.9 * flare);
  const sweep = ((t * 0.18) % 1.4) - 0.2;
  const sx = W * sweep;
  const shine = ctx.createLinearGradient(sx - W * 0.12, 0, sx + W * 0.12, 0);
  shine.addColorStop(0, "rgba(255,255,255,0)");
  shine.addColorStop(0.5, "rgba(200,255,255,0.05)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.fillRect(0, top, W, H - top);
}

function drawMic(ctx, x, y, size, rim) {
  ctx.save();
  // Boom arm into the frame edge.
  ctx.strokeStyle = "#0b0f11";
  ctx.lineWidth = size * 0.08;
  ctx.beginPath();
  ctx.moveTo(x - size * 1.1, y + size * 0.9);
  ctx.lineTo(x, y + size * 1.25);
  ctx.lineTo(x, y + size * 2.6);
  ctx.stroke();
  // Shock mount.
  ctx.strokeStyle = `rgba(0,225,233,${0.25 * rim})`;
  ctx.lineWidth = size * 0.035;
  for (const dy of [0.35, 0.95]) {
    ctx.beginPath();
    ctx.ellipse(x, y + size * dy, size * 0.62, size * 0.16, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Capsule body with a mesh grille and a teal rim light.
  const body = ctx.createLinearGradient(x - size * 0.4, 0, x + size * 0.4, 0);
  body.addColorStop(0, "#050708");
  body.addColorStop(0.7, "#151c1f");
  body.addColorStop(1, `rgba(0,225,233,${0.45 * rim})`);
  ctx.fillStyle = body;
  roundRect(ctx, x - size * 0.4, y - size * 0.9, size * 0.8, size * 2.1, size * 0.4);
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.05)";
  ctx.lineWidth = 1;
  for (let line = -0.32; line <= 0.32; line += 0.06) {
    ctx.beginPath();
    ctx.moveTo(x + size * line, y - size * 0.8);
    ctx.lineTo(x + size * line, y + size * 0.15);
    ctx.stroke();
  }
  ctx.fillStyle = "#0a0d0f";
  ctx.fillRect(x - size * 0.42, y + size * 0.2, size * 0.84, size * 0.08);
  ctx.restore();
}

function drawCamera(ctx, x, y, size, rim) {
  ctx.save();
  // Tripod head and legs.
  ctx.fillStyle = "#07090a";
  ctx.fillRect(x - size * 0.1, y + size * 0.55, size * 0.5, size * 0.25);
  ctx.strokeStyle = "#07090a";
  ctx.lineWidth = size * 0.08;
  for (const dx of [-0.5, 0.15, 0.8]) {
    ctx.beginPath();
    ctx.moveTo(x + size * 0.15, y + size * 0.8);
    ctx.lineTo(x + size * dx, y + size * 2.2);
    ctx.stroke();
  }
  // Body.
  const body = ctx.createLinearGradient(0, y - size * 0.5, 0, y + size * 0.6);
  body.addColorStop(0, "#1a2125");
  body.addColorStop(1, "#06080a");
  ctx.fillStyle = body;
  roundRect(ctx, x - size * 0.2, y - size * 0.5, size * 1.4, size * 1.05, size * 0.08);
  ctx.fill();
  ctx.fillStyle = "#0c1013";
  ctx.fillRect(x + size * 0.1, y - size * 0.72, size * 0.7, size * 0.24);
  // Lens barrel toward the centre of the room, with a red ring and a teal reflection.
  ctx.fillStyle = "#0b0e10";
  roundRect(ctx, x - size * 0.95, y - size * 0.42, size * 0.8, size * 0.84, size * 0.12);
  ctx.fill();
  ctx.fillStyle = "#b3262d";
  ctx.fillRect(x - size * 0.28, y - size * 0.44, size * 0.05, size * 0.88);
  const glass = ctx.createRadialGradient(x - size * 1.0, y - size * 0.1, 0, x - size * 0.95, y, size * 0.42);
  glass.addColorStop(0, `rgba(120,250,255,${0.55 * rim})`);
  glass.addColorStop(0.35, "rgba(10,40,48,0.9)");
  glass.addColorStop(1, "#020304");
  ctx.fillStyle = glass;
  ctx.beginPath();
  ctx.ellipse(x - size * 0.95, y, size * 0.16, size * 0.4, 0, 0, Math.PI * 2);
  ctx.fill();
  // Rim light down the camera's back edge.
  ctx.fillStyle = `rgba(0,225,233,${0.35 * rim})`;
  ctx.fillRect(x + size * 1.17, y - size * 0.48, size * 0.03, size * 1.0);
  ctx.restore();
}

function drawHeadphones(ctx, x, y, size, rim) {
  ctx.save();
  ctx.strokeStyle = "#0a0d0f";
  ctx.lineWidth = size * 0.1;
  ctx.beginPath();
  ctx.ellipse(x, y, size * 0.95, size * 0.55, 0, Math.PI * 1.05, Math.PI * 1.95);
  ctx.stroke();
  for (const dx of [-0.85, 0.85]) {
    const cup = ctx.createRadialGradient(x + size * dx, y + size * 0.05, 0, x + size * dx, y + size * 0.05, size * 0.45);
    cup.addColorStop(0, "#1a2124");
    cup.addColorStop(1, "#050607");
    ctx.fillStyle = cup;
    ctx.beginPath();
    ctx.ellipse(x + size * dx, y + size * 0.05, size * 0.38, size * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = `rgba(0,225,233,${0.22 * rim})`;
    ctx.lineWidth = size * 0.025;
    ctx.stroke();
  }
  ctx.restore();
}

function drawDust(ctx, W, H, t, s, glow) {
  ctx.save();
  for (const mote of dust) {
    const y = ((mote.y - t * mote.speed) % 1 + 1) % 1;
    const x = mote.x + Math.sin(t * 0.4 + mote.phase) * 0.006;
    const twinkle = 0.25 + 0.75 * (0.5 + 0.5 * Math.sin(t * 1.7 + mote.phase));
    ctx.fillStyle = `rgba(170,250,255,${0.35 * twinkle * glow})`;
    ctx.beginPath();
    ctx.arc(W * x, H * y * 0.8, mote.size * s, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function vignette(ctx, W, H) {
  const shade = ctx.createRadialGradient(W / 2, H * 0.48, Math.min(W, H) * 0.3, W / 2, H * 0.5, Math.max(W, H) * 0.75);
  shade.addColorStop(0, "rgba(0,0,0,0)");
  shade.addColorStop(1, "rgba(0,0,0,0.72)");
  ctx.fillStyle = shade;
  ctx.fillRect(0, 0, W, H);
}

// Where things sit in each frame shape.
function layoutFor(W, H) {
  if (H > W) {
    return {
      portrait: true, horizon: 0.8, foam: [0, 0.55], slats: [0.62, 1],
      strips: [[0.06, 0, 0.42]], tubes: [[0.2, 0, 0.2, 0.16, 0.25], [0.9, 0, 0.9, 0.12, 0.4]],
      beams: [[0.06, 0.2, 420], [0.2, 0.08, 380], [0.9, 0.05, 300]],
      monitor: [0.6, 0.47, 0.36],
      mic: [0.13, 0.62, 130], camera: [0.83, 0.86, 120], headphones: [0.2, 0.92, 120],
      photo: { mic: [0.8, 1.02, 0.3], camera: [0.2, 1.03, 0.18], desk: [0.5, 0.95, 0.13] },
      logo: { x: 0.5, y: 0.38, stacked: true },
      card: { y: 0.52 },
    };
  }
  return {
    portrait: false, horizon: 0.79, foam: [0.1, 0.36], slats: [0.64, 1],
    strips: [[0.03, 0, 0.62]], tubes: [[0.19, 0, 0.19, 0.3, 0.25], [0.8, 0, 0.8, 0.12, 0.4]],
    beams: [[0.03, 0.3, 420], [0.19, 0.15, 330], [0.8, 0.06, 300]],
    monitor: [0.77, 0.2, 0.18],
    mic: [0.075, 0.27, 120], camera: [0.92, 0.6, 130], headphones: [0.07, 0.86, 120],
    photo: { mic: [0.9, 1.03, 0.7], camera: [0.1, 1.06, 0.42], desk: [0.19, 0.83, 0.23] },
    logo: { x: 0.5, y: 0.47, stacked: false },
    card: { y: 0.6 },
  };
}

// The brand lockup: mark | divider | wordmark side by side (or stacked on a
// Short), rising out of the horizon light.
function drawLockup(ctx, W, H, t, s, layout, reveal, place = { dy: 0, scale: 1 }) {
  if (!mark || !wordmark) return;
  const { stacked } = layout.logo;
  const markH = (stacked ? W * 0.5 : H * 0.27) * place.scale;
  const markW = markH * (mark.width / mark.height);
  const wordW = (stacked ? W * 0.8 : W * 0.24) * place.scale;
  const wordH = wordW * (wordmark.height / wordmark.width);
  const gap = 34 * s * place.scale;
  const cx = W * layout.logo.x;
  const cy = H * layout.logo.y + place.dy;
  const markIn = outBack(span(reveal, 0.7, 1.6));
  const divider = outCubic(span(reveal, 1.2, 1.7));
  const words = outCubic(span(reveal, 1.5, 2.4));
  const shimmer = span(reveal, 2.8, 3.8);

  let markX;
  let markY;
  let wordX;
  let wordY;
  if (stacked) {
    markX = cx - markW / 2;
    markY = cy - markH - gap / 2;
    wordX = cx - wordW / 2;
    wordY = cy + gap / 2;
  } else {
    const total = markW + gap * 2 + wordW;
    markX = cx - total / 2;
    markY = cy - markH / 2;
    wordX = markX + markW + gap * 2;
    wordY = cy - wordH / 2;
  }

  // The mark rises from the table with its glow.
  ctx.save();
  ctx.globalAlpha = clamp(span(reveal, 0.7, 1.2));
  ctx.shadowColor = TEAL;
  ctx.shadowBlur = (30 + 12 * Math.sin(t * 2)) * s;
  const rise = (1 - markIn) * 60 * s;
  const grow = mix(0.88, 1, markIn);
  ctx.drawImage(mark, markX + (markW * (1 - grow)) / 2, markY + rise + (markH * (1 - grow)) / 2, markW * grow, markH * grow);
  ctx.restore();

  // The divider draws from its centre (the stacked lockup uses a rule under the mark).
  if (divider > 0) {
    ctx.save();
    ctx.fillStyle = TEAL;
    ctx.shadowColor = TEAL;
    ctx.shadowBlur = 16 * s;
    if (stacked) ctx.fillRect(cx - (wordW * 0.3 * divider), cy - 2 * s, wordW * 0.6 * divider, 4 * s);
    else {
      const lineH = markH * 1.05 * divider;
      ctx.fillRect(markX + markW + gap - 2 * s, cy - lineH / 2, 4 * s, lineH);
    }
    ctx.restore();
  }

  // The wordmark slides out from behind the divider, then a light sweeps over it.
  if (words > 0) {
    const layer = createCanvas(Math.ceil(wordW), Math.ceil(wordH));
    const lctx = layer.getContext("2d");
    lctx.drawImage(wordmark, 0, 0, wordW, wordH);
    if (shimmer > 0 && shimmer < 1) {
      lctx.globalCompositeOperation = "source-atop";
      const at = mix(-0.3, 1.3, shimmer) * wordW;
      const light = lctx.createLinearGradient(at - wordW * 0.15, 0, at + wordW * 0.15, wordH);
      light.addColorStop(0, "rgba(255,255,255,0)");
      light.addColorStop(0.5, "rgba(255,255,255,0.85)");
      light.addColorStop(1, "rgba(255,255,255,0)");
      lctx.fillStyle = light;
      lctx.fillRect(0, 0, wordW, wordH);
    }
    ctx.save();
    ctx.beginPath();
    if (stacked) ctx.rect(cx - (wordW / 2) * words - 2, wordY - 10 * s, wordW * words + 4, wordH + 20 * s);
    else ctx.rect(wordX - 4 * s, wordY - 10 * s, wordW * words + 8 * s, wordH + 20 * s);
    ctx.clip();
    ctx.globalAlpha = words;
    ctx.shadowColor = "rgba(0,225,233,0.35)";
    ctx.shadowBlur = 18 * s;
    ctx.drawImage(layer, wordX + (stacked ? 0 : (1 - words) * -40 * s), wordY);
    ctx.restore();
  }
  return { markX, markY, markW, markH, wordX, wordY, wordW, wordH };
}

function thumbIcon(ctx, x, y, size, color) {
  ctx.save();
  ctx.fillStyle = color;
  ctx.translate(x, y);
  ctx.scale(size / 24, size / 24);
  ctx.fill(new Path2DFromSvg("M2 21h4V9H2v12zm20-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L13.17 1 6.59 7.59C6.22 7.95 6 8.45 6 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"));
  ctx.restore();
}

function bellIcon(ctx, x, y, size, color, swing) {
  ctx.save();
  ctx.translate(x + size / 2, y + size * 0.1);
  ctx.rotate(swing);
  ctx.translate(-size / 2, -size * 0.1);
  ctx.fillStyle = color;
  ctx.scale(size / 24, size / 24);
  ctx.fill(new Path2DFromSvg("M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"));
  ctx.restore();
}

function cursorIcon(ctx, x, y, size, press) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale((size / 24) * (1 - press * 0.12), (size / 24) * (1 - press * 0.12));
  const shape = new Path2DFromSvg("M4 2l15 11.5-6.6.9 3.9 7.4-2.9 1.5-3.9-7.5L4 20.6z");
  ctx.shadowColor = "rgba(0,0,0,0.6)";
  ctx.shadowBlur = 8;
  ctx.fillStyle = WHITE;
  ctx.fill(shape);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = "#0a0d0f";
  ctx.stroke(shape);
  ctx.restore();
}

// The like-and-subscribe card: a cursor likes, then subscribes and rings the bell.
function drawCard(ctx, W, H, t, s, layout, local) {
  const portrait = layout.portrait;
  const appear = outBack(span(local, 0.25, 0.85));
  if (appear <= 0) return;
  const bh = (portrait ? 118 : 92) * s;
  const font = `700 ${Math.round((portrait ? 50 : 38) * s)}px "${FONT}"`;
  const likeW = (portrait ? 330 : 250) * s;
  const subW = (portrait ? 520 : 400) * s;
  const bellW = bh;
  const gap = 26 * s;
  const cy = H * layout.card.y;
  let like;
  let sub;
  let bell;
  if (portrait) {
    like = { x: W / 2 - likeW / 2, y: cy };
    sub = { x: W / 2 - (subW + gap + bellW) / 2, y: cy + bh + gap * 1.4 };
    bell = { x: sub.x + subW + gap, y: sub.y };
  } else {
    const total = likeW + subW + bellW + gap * 2;
    like = { x: W / 2 - total / 2, y: cy };
    sub = { x: like.x + likeW + gap, y: cy };
    bell = { x: sub.x + subW + gap, y: cy };
  }
  const likeAt = 1.6;
  const subAt = 2.6;
  const liked = local >= likeAt;
  const subscribed = local >= subAt;
  const pop = (at) => (local >= at ? Math.sin(span(local, at, at + 0.35) * Math.PI) : 0);

  ctx.save();
  ctx.globalAlpha = clamp(appear);
  const lift = (1 - appear) * 40 * s;
  ctx.font = font;
  ctx.textBaseline = "middle";

  // Like.
  ctx.save();
  const likeScale = 1 + 0.08 * pop(likeAt);
  ctx.translate(like.x + likeW / 2, like.y + bh / 2 + lift);
  ctx.scale(likeScale, likeScale);
  ctx.translate(-(like.x + likeW / 2), -(like.y + bh / 2));
  ctx.fillStyle = liked ? "rgba(0,225,233,0.18)" : "rgba(10,18,20,0.82)";
  ctx.strokeStyle = TEAL;
  ctx.lineWidth = 2.5 * s;
  ctx.shadowColor = TEAL;
  ctx.shadowBlur = (liked ? 26 : 10) * s;
  roundRect(ctx, like.x, like.y, likeW, bh, bh / 2);
  ctx.fill();
  ctx.stroke();
  ctx.shadowBlur = 0;
  thumbIcon(ctx, like.x + bh * 0.32, like.y + bh * 0.24, bh * 0.52, liked ? TEAL : WHITE);
  ctx.fillStyle = WHITE;
  ctx.fillText(liked ? "Liked" : "Like", like.x + bh * 0.98, like.y + bh / 2 + 2 * s);
  ctx.restore();

  // Subscribe.
  ctx.save();
  const subScale = 1 + 0.06 * pop(subAt);
  ctx.translate(sub.x + subW / 2, sub.y + bh / 2 + lift);
  ctx.scale(subScale, subScale);
  ctx.translate(-(sub.x + subW / 2), -(sub.y + bh / 2));
  ctx.fillStyle = subscribed ? "#2a2f31" : "#e8222e";
  ctx.shadowColor = subscribed ? "rgba(0,0,0,0)" : "rgba(232,34,46,0.55)";
  ctx.shadowBlur = 26 * s;
  roundRect(ctx, sub.x, sub.y, subW, bh, bh / 2);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.fillStyle = subscribed ? "#c9d4d6" : WHITE;
  ctx.textAlign = "center";
  ctx.fillText(subscribed ? "Subscribed" : "SUBSCRIBE", sub.x + subW / 2, sub.y + bh / 2 + 2 * s);
  ctx.textAlign = "left";
  ctx.restore();

  // Bell: rings after the subscribe click.
  ctx.save();
  ctx.translate(0, lift);
  const ring = local >= subAt + 0.25 ? Math.sin((local - subAt - 0.25) * 22) * 0.35 * Math.exp(-(local - subAt - 0.25) * 2.8) : 0;
  ctx.fillStyle = subscribed ? "rgba(0,225,233,0.18)" : "rgba(10,18,20,0.82)";
  ctx.strokeStyle = subscribed ? TEAL : "rgba(245,251,252,0.35)";
  ctx.lineWidth = 2.5 * s;
  roundRect(ctx, bell.x, bell.y, bellW, bh, bh / 2);
  ctx.fill();
  ctx.stroke();
  bellIcon(ctx, bell.x + bh * 0.22, bell.y + bh * 0.2, bh * 0.56, subscribed ? TEAL : WHITE, ring);
  ctx.restore();

  // The line under the buttons.
  ctx.fillStyle = "rgba(245,251,252,0.78)";
  ctx.font = `400 ${Math.round((portrait ? 34 : 26) * s)}px "${FONT}"`;
  ctx.textAlign = "center";
  const under = portrait ? sub.y + bh + gap * 2.2 : cy + bh + gap * 1.8;
  ctx.fillText("New rundowns every morning", W / 2, under + lift);
  ctx.restore();

  // Cursor: glides in, clicks Like, then Subscribe, then drifts away.
  const path = [
    { at: 0.8, x: W * 0.92, y: H * 0.96 },
    { at: likeAt - 0.05, x: like.x + likeW * 0.55, y: like.y + bh * 0.6 },
    { at: subAt - 0.05, x: sub.x + subW * 0.55, y: sub.y + bh * 0.6 },
    { at: subAt + 1.2, x: sub.x + subW * 0.75, y: sub.y + bh * 1.6 },
  ];
  if (local < path[0].at) return;
  let point = path.at(-1);
  for (let index = 0; index < path.length - 1; index += 1) {
    const a = path[index];
    const b = path[index + 1];
    if (local < b.at) {
      const x = inOutCubic(span(local, a.at, b.at));
      point = { x: mix(a.x, b.x, x), y: mix(a.y, b.y, x) };
      break;
    }
  }
  const press = Math.max(pop(likeAt), pop(subAt));
  for (const at of [likeAt, subAt]) {
    const ripple = span(local, at, at + 0.5);
    if (ripple > 0 && ripple < 1) {
      ctx.save();
      ctx.strokeStyle = `rgba(245,251,252,${0.7 * (1 - ripple)})`;
      ctx.lineWidth = 3 * s;
      ctx.beginPath();
      ctx.arc(point.x, point.y, (14 + 46 * ripple) * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
  ctx.save();
  ctx.globalAlpha = clamp(1 - span(local, subAt + 1.2, subAt + 1.6));
  cursorIcon(ctx, point.x - 4 * s, point.y - 2 * s, (portrait ? 64 : 48) * s, press);
  ctx.restore();
}

// napi-rs canvas builds a Path2D from SVG path data.
import { Path2D as Path2DFromSvg } from "../canvas.mjs";

/**
 * Draws one frame of the closing scene.
 * t is seconds since the scene began; cardAt is when the like-and-subscribe
 * card takes over (null for a brand-only scene, 0 for a card-only Short ending).
 */
export function drawEndScene(ctx, { width: W, height: H, t, cardAt = null, duration = 8 }) {
  const layout = layoutFor(W, H);
  const s = layout.portrait ? W / 1080 : H / 1080;
  const cardOnly = cardAt === 0;
  // A card-only ending skips the slow reveal: the room and logo are already lit.
  const reveal = cardOnly ? 4 + t : t;
  const push = 1 + 0.045 * inOutCubic(clamp(t / Math.max(1, duration)));
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(push, push);
  ctx.translate(-W / 2, -H / 2);
  drawRoom(ctx, W, H, reveal, s, layout);
  const flare = cardOnly ? 1 : outCubic(span(t, 0.3, 1.1));
  drawTable(ctx, W, H, reveal, s, layout, flare);
  if (props.desk) {
    const [dx, bottom, height] = layout.photo.desk;
    drawProp(ctx, props.desk, W * dx, H * bottom, H * height, neon(reveal), s);
  }

  const card = cardAt !== null && t >= cardAt;
  const move = cardAt === null ? 0 : cardOnly ? 1 : inOutCubic(span(t, cardAt, cardAt + 0.7));
  const place = layout.portrait
    ? { dy: -H * 0.1 * move, scale: mix(1, 0.62, move) }
    : { dy: -H * 0.2 * move, scale: mix(1, 0.7, move) };
  // The lockup's reflection on the table.
  ctx.save();
  const top = H * layout.horizon;
  ctx.translate(0, top * 2);
  ctx.scale(1, -1);
  ctx.globalAlpha = 0.12;
  drawLockup(ctx, W, H, reveal, s, layout, reveal, place);
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, top);
  ctx.clip();
  drawLockup(ctx, W, H, reveal, s, layout, reveal, place);
  ctx.restore();
  // Foreground props, a little parallax against the push.
  const rim = neon(reveal);
  const drift = (push - 1) * 0.6;
  const photo = layout.photo;
  if (props.mic) drawProp(ctx, props.mic, W * (photo.mic[0] - drift), H * photo.mic[1], H * photo.mic[2], rim, s);
  else {
    drawMic(ctx, W * (layout.mic[0] - drift), H * layout.mic[1], layout.mic[2] * s, rim);
    drawHeadphones(ctx, W * (layout.headphones[0] - drift), H * layout.headphones[1], layout.headphones[2] * s, rim);
  }
  if (props.camera) drawProp(ctx, props.camera, W * (photo.camera[0] + drift), H * photo.camera[1], H * photo.camera[2], rim, s);
  else drawCamera(ctx, W * (layout.camera[0] + drift), H * layout.camera[1], layout.camera[2] * s, rim);
  drawDust(ctx, W, H, reveal, s, rim);
  ctx.restore();
  vignette(ctx, W, H);
  if (card) drawCard(ctx, W, H, t, s, layout, t - cardAt + (cardOnly ? 0 : 0));
  // Fade up from black at the very start of a full scene.
  if (!cardOnly && t < 0.35) {
    ctx.fillStyle = `rgba(0,0,0,${1 - t / 0.35})`;
    ctx.fillRect(0, 0, W, H);
  }
}
