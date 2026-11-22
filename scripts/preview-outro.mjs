// Renders sample closing clips so the look can be reviewed on its own:
//   node scripts/preview-outro.mjs [outDir]
// main-outro.mp4  16:9, brand reveal into the like-and-subscribe card
// short-endcard.mp4  9:16, the card appended to the end of a Short
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas } from "../server/canvas.mjs";
import { ffmpegPath, root } from "../server/config.mjs";
import { drawEndScene } from "../server/sports/endcard.mjs";

const outDir = path.resolve(process.argv[2] || path.join(root, "reports", "outro-preview"));
const FPS = 30;
const music = path.join(root, "assets", "outro.mp3");

async function render({ file, width, height, duration, cardAt }) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const fade = Math.max(0, duration - 0.8);
  const ffmpeg = spawn(ffmpegPath, [
    "-y", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(FPS), "-i", "-",
    "-i", music,
    "-filter_complex", `[1:a]atrim=0:${duration},afade=t=in:d=0.3,afade=t=out:st=${fade}:d=0.8[a]`,
    "-map", "0:v", "-map", "[a]",
    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "160k", "-shortest", "-movflags", "+faststart",
    file,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  const done = new Promise((resolve, reject) => {
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
  const frames = Math.round(duration * FPS);
  const stills = [];
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / FPS;
    ctx.clearRect(0, 0, width, height);
    drawEndScene(ctx, { width, height, t, cardAt, duration });
    const pixels = ctx.getImageData(0, 0, width, height).data;
    if (!ffmpeg.stdin.write(Buffer.from(pixels.buffer, pixels.byteOffset, pixels.byteLength)))
      await new Promise((resolve) => ffmpeg.stdin.once("drain", resolve));
    if ([1.5, 3.5, cardAt === null ? -1 : cardAt + 1.8, duration - 0.9].some((at) => Math.abs(at - t) < 0.5 / FPS))
      stills.push([t, await canvas.encode("png")]);
  }
  ffmpeg.stdin.end();
  await done;
  for (const [t, png] of stills)
    await writeFile(file.replace(/\.mp4$/u, `-${t.toFixed(1)}s.png`), png);
}

await mkdir(outDir, { recursive: true });
const started = Date.now();
await render({ file: path.join(outDir, "main-outro.mp4"), width: 1920, height: 1080, duration: 10, cardAt: 5.2 });
await render({ file: path.join(outDir, "short-endcard.mp4"), width: 1080, height: 1920, duration: 4.5, cardAt: 0 });
console.log(`rendered to ${outDir} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
