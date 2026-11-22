import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "../server/canvas.mjs";
import { root } from "../server/config.mjs";
import { drawThumbnail, encodeThumbnail, inspectThumbnail, renderCutThumbnails } from "../server/sports/thumbnail.mjs";
import { logosForTitle } from "../server/sports/team-logos.mjs";

// Exercises the production renderer without invoking an LLM, building a video,
// editing an edition, or publishing. Fetching missing authentic marks is optional.
const directory = path.resolve(process.argv.find((arg) => arg.startsWith("--out="))?.slice(6)
  || path.join(root, ".runtime/thumbnail-preview"));
const fetchMissing = process.argv.includes("--fetch-logos");
await mkdir(directory, { recursive: true });
const duke = { headline: "Duke Falls to Illinois in Rankings Shock", league: "NCAAB", sport: "basketball",
  teams: ["Duke Blue Devils", "Illinois Fighting Illini"] };
const cases = [
  { name: "duke-episode", text: "DUKE FALLS HARD", stories: [duke] },
  { name: "texas-episode", text: "TEXAS AND LSU", stories: [{ headline: "Texas and LSU", league: "NCAAF", sport: "football", teams: ["Texas Longhorns", "LSU Tigers"] }] },
  { name: "isaac-editorial", text: "ISAAC'S TAKE", stories: [{ headline: "Isaac's editorial", league: "Other news", sport: "other" }],
    photos: [{ file: path.join(root, "assets/isaac-anchor-portrait.png"), subject: "Isaac", kind: "person" }] },
  { name: "duke-short", kind: "short", text: "DUKE FALLS HARD", stories: [duke] },
  { name: "other-news", text: "BEYOND THE GAME", stories: [{ headline: "Beyond the game", league: "Other news", sport: "other" }] },
  { name: "ravens-episode", text: "RAVENS NEXT CHAPTER", stories: [{ headline: "Baltimore Ravens: next chapter", league: "NFL", sport: "football", teams: ["Baltimore Ravens"] }] },
  { name: "isaac-short", kind: "short", text: "ISAAC'S TAKE", stories: [{ headline: "Isaac's editorial", league: "Other news", sport: "other" }],
    photos: [{ file: path.join(root, "assets/isaac-anchor-portrait.png"), subject: "Isaac", kind: "person" }] },
];
const rendered = [];
const cache = { directories: new Map() };
for (const sample of cases) {
  const logos = await logosForTitle([sample.text, sample.stories[0].headline, ...sample.stories[0].teams || []].join(" "),
    { stories: sample.stories, fetchMissing, cache });
  const canvas = await drawThumbnail({ ...sample, logos, date: "2026-11-20" });
  const jpeg = await encodeThumbnail(canvas);
  const file = path.join(directory, `${sample.name}.jpg`);
  const check = inspectThumbnail(canvas, jpeg, { width: canvas.width, height: canvas.height });
  if (!check.passed) throw new Error(`${sample.name}: ${check.failures.join(", ")}`);
  await writeFile(file, jpeg);
  rendered.push({ ...sample, canvas, file, check, logos: logos.map(({ name, file }) => ({ name, file })) });
  console.log(JSON.stringify({ file, logos: logos.map((logo) => logo.name), ...check }));
}
// Review full artwork alongside actual mobile-size previews.
const sheet = createCanvas(1500, 2148);
const ctx = sheet.getContext("2d");
ctx.fillStyle = "#dce4e7"; ctx.fillRect(0, 0, sheet.width, sheet.height);
for (const [index, item] of rendered.filter((item) => item.kind !== "short").entries()) {
  const y = 24 + index * 420;
  ctx.drawImage(item.canvas, 24, y, 704, 396);
  ctx.drawImage(item.canvas, 756, y + 75, 320, 180);
  ctx.fillStyle = "#18303d"; ctx.font = '18px "Atkinson Hyperlegible"';
  ctx.fillText("320 × 180", 756, y + 56);
}
const short = rendered.find((item) => item.kind === "short");
ctx.drawImage(short.canvas, 1110, 24, 360, 640);
ctx.drawImage(short.canvas, 1195, 750, 180, 320);
await writeFile(path.join(directory, "contact-sheet.jpg"), await sheet.encode("jpeg", 90));
await writeFile(path.join(directory, "checks.json"), JSON.stringify(rendered.map(({ name, file, check, logos }) => ({ name, file, check, logos })), null, 2));
console.log(`Contact sheet: ${path.join(directory, "contact-sheet.jpg")}`);

// Also run the same cut exporter used by generation and Redraw thumbnails.
// Put Duke later in the rundown to exercise cover-story selection end to end.
const cutDirectory = path.join(directory, "cut");
await mkdir(cutDirectory, { recursive: true });
await writeFile(path.join(cutDirectory, "timeline.json"), "{}");
await writeFile(path.join(cutDirectory, "qc.json"), "{}");
const cutStories = [cases[1], cases[2], cases[0], cases[4]];
const output = await renderCutThumbnails({ directory: cutDirectory,
  episode: { date: "2026-11-20", segments: cutStories.map((sample) => ({ ...sample.stories[0],
    footage: { sport: sample.stories[0].sport, teams: sample.stories[0].teams || [] } })) },
  listing: { episode: { title: cases[0].stories[0].headline, thumbnail: cases[0].text },
    shorts: cutStories.map((sample, i) => ({ segment: i + 1, title: sample.stories[0].headline, thumbnail: sample.text })) },
  photos: cutStories.map((sample, i) => ({ segment: i + 1, photos: sample.photos || [] })),
  shorts: cutStories.map((_, i) => ({ segment: i + 1 })),
});
console.log(JSON.stringify({ cut: cutDirectory, checks: output.checks }));
