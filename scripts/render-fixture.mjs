// Offline proof of the show. Renders a frozen historical game from
// server/sports/fixtures with local assets only: no model calls, no uploads.
//
//   npm run render:fixture                           Kokoro narration (downloads the voice once)
//   npm run render:fixture -- --voice none           placeholder narrator, runs in CI
//   npm run render:fixture -- --fixture <name|path> --out <dir>
import { parseArgs } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { dataDir, ffmpegPath } from "../server/config.mjs";
import { readJson } from "../server/storage.mjs";
import { run } from "../server/process.mjs";
import { ingestEpisodeFixture } from "../server/sports/evidence.mjs";
import { listFixtures, loadFixture, placeholderNarrate } from "../server/sports/fixtures.mjs";
import { EvidenceLedger } from "../server/sports/ledger.mjs";
import { renderEpisode } from "../server/sports/produce.mjs";

const { values } = parseArgs({ options: {
  fixture: { type: "string", default: "finals-2016-game7" },
  voice: { type: "string", default: process.env.SPORTS_VOICE || "am_michael" },
  out: { type: "string" },
  list: { type: "boolean", default: false },
} });
if (values.list) {
  console.log((await listFixtures()).join("\n"));
  process.exit(0);
}

const fixture = await loadFixture(values.fixture);
const stamp = new Date().toISOString().replace(/[:.]/gu, "-").slice(0, 19);
const output = path.resolve(values.out || path.join(dataDir, "fixtures", `${fixture.name}-${stamp}`));
await mkdir(output, { recursive: true });
const placeholder = values.voice === "none";
if (!placeholder) process.env.SPORTS_VOICE = values.voice;
console.log(`Rendering ${fixture.name} (${fixture.segments.length} segments, ${placeholder ? "placeholder narrator" : `voice ${values.voice}`}) into ${output}`);

// The fixture's claims pass through the evidence ledger first, so credits.json
// carries claim and snapshot IDs and the render is refused if a number lacks evidence.
const ledger = new EvidenceLedger(undefined, path.join(output, "ledger.json"));
const { episode, revision } = ingestEpisodeFixture(ledger, fixture);
await ledger.save();
console.log(`Evidence ledger: ${ledger.claims.length} claims over ${ledger.snapshots.length} snapshots, revision ${revision.id} locked.`);

const started = performance.now();
let lastLine = "";
const metadata = await renderEpisode(episode, output, (percent, message) => {
  const line = `${String(percent).padStart(3)}% ${message}`;
  if (line !== lastLine) console.log(line);
  lastLine = line;
}, undefined, placeholder ? placeholderNarrate : undefined);
const renderSeconds = (performance.now() - started) / 1000;

// Review material: a contact sheet of the episode and a phone-size frame per Short.
const columns = 5;
const frames = Math.max(1, Math.ceil(metadata.duration / 5));
await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-i", "episode.mp4",
  "-vf", `fps=1/5,scale=384:-2,tile=${columns}x${Math.ceil(frames / columns)}`, "-frames:v", "1", "-q:v", "3", "contact-sheet.jpg"], { cwd: output });
for (const short of metadata.shorts) {
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-y", "-ss", (short.duration / 2).toFixed(3), "-i", short.file,
    "-frames:v", "1", "-vf", "scale=360:-2", "-q:v", "3", short.file.replace(/\.mp4$/u, "-phone.jpg")], { cwd: output });
}

const usage = process.resourceUsage();
const benchmark = {
  fixture: fixture.name, narrator: placeholder ? "placeholder" : values.voice, renderSeconds: Number(renderSeconds.toFixed(1)),
  episodeSeconds: Number(metadata.duration.toFixed(2)), shorts: metadata.shorts.map(({ id, duration }) => ({ id, seconds: Number(duration.toFixed(2)) })),
  // Peak resident memory of this Node process; FFmpeg and the voice run as children and add to the host total.
  nodePeakRssMB: Math.round(usage.maxRSS / 1024), platform: `${os.platform()} ${os.arch()}`, cpus: os.cpus().length, node: process.version, at: new Date().toISOString(),
};
await writeFile(path.join(output, "benchmark.json"), JSON.stringify(benchmark, null, 2));

const qc = await readJson(path.join(output, "qc.json"));
console.log(`\nEpisode ${benchmark.episodeSeconds}s, ${metadata.shorts.length} Shorts, rendered in ${benchmark.renderSeconds}s (Node peak RSS ${benchmark.nodePeakRssMB} MB).`);
for (const out of qc.outputs) {
  const loud = out.loudness ? `${out.loudness.integrated.toFixed(1)} LUFS, ${out.loudness.truePeak.toFixed(1)} dBTP` : "loudness unmeasured";
  console.log(`  ${out.file.padEnd(16)} ${out.width}x${out.height} ${out.duration.toFixed(2)}s  ${loud}  ${out.passed ? "ok" : "FAILED"}${out.checks.loudness ? "" : " (loudness warning)"}`);
}
if (qc.warnings.length) console.log(`Warnings:\n  ${qc.warnings.join("\n  ")}`);
console.log("Files: episode.mp4, captions.srt, shorts/, timeline.json, credits.json, ledger.json, qc.json, benchmark.json, contact-sheet.jpg");
