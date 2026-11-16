import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { wav } from "../voice.mjs";

const directory = fileURLToPath(new URL("./fixtures/", import.meta.url));
const source = z.object({ publisher: z.string().min(1), title: z.string().min(1), url: z.url({ protocol: /^https?$/ }) });
const marker = z.object({ n: z.number().int().positive(), x: z.number().min(0).max(1), y: z.number().min(0).max(1), role: z.enum(["offense", "defense"]), label: z.string().min(3).max(90) });
const diagram = z.object({
  sport: z.enum(["basketball", "football", "generic"]), caption: z.string().max(120).optional(),
  markers: z.array(marker).min(1).max(8), paths: z.array(z.tuple([z.number().int(), z.number().int()])).max(8).optional(),
}).refine(({ markers, paths = [] }) => {
  const ids = new Set(markers.map(({ n }) => n));
  return ids.size === markers.length && paths.every(([from, to]) => ids.has(from) && ids.has(to));
}, "Diagram paths must join distinct, numbered markers.");
export const fixtureSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/u),
  title: z.string().min(3).max(95),
  description: z.string().min(3).max(700),
  date: z.iso.date(),
  game: z.record(z.string(), z.unknown()).optional(),
  notes: z.string().optional(),
  segments: z.array(z.object({
    id: z.string().regex(/^[a-z0-9-]+$/u),
    headline: z.string().min(3).max(140),
    narration: z.string().min(20).max(750),
    sources: z.array(source).min(1).max(3),
    claims: z.array(z.object({ text: z.string().min(3), evidence: z.url(), locator: z.string().min(1) }).loose()).min(1),
    diagram: diagram.optional(),
  })).min(1).max(12),
});

// Game evidence slates: credential-free, replayable evidence for the desk and
// its tests. A slate is one night across several sports; each game carries the
// reports an adapter would retrieve, the story the desk would pitch, and the
// claims that bind every number in that story to a report and a locator.
const team = z.object({ id: z.string().regex(/^[a-z0-9-]+$/u), name: z.string().min(2).max(60), short: z.string().min(2).max(5) });
const report = z.object({
  provider: z.string().min(1), originGroup: z.string().min(1),
  kind: z.enum(["boxscore", "play-by-play", "wire", "statement", "injury-report", "correction"]),
  url: z.url({ protocol: /^https?$/ }), sourceTime: z.iso.datetime(), version: z.string().optional(),
  title: z.string().optional(), excerpt: z.string().optional(), payload: z.record(z.string(), z.unknown()).optional(),
});
const claimEvidence = z.object({ report: z.number().int().nonnegative(), locator: z.string().min(1), stance: z.enum(["supports", "contradicts"]).optional() });
export const gameClaimSchema = z.object({
  key: z.string().min(1), text: z.string().min(3), value: z.unknown().optional(), unit: z.string().optional(),
  subject: z.object({ team: z.string().optional(), player: z.string().optional() }).optional(),
  period: z.union([z.number(), z.string()]).optional(), clock: z.string().optional(),
  asOf: z.enum(["final", "in-game", "announced"]).default("final"),
  evidence: z.array(claimEvidence).min(1),
});
const scoreState = z.object({ period: z.union([z.number().int(), z.string()]), home: z.number().nonnegative(), away: z.number().nonnegative(), at: z.iso.datetime().optional() });
const play = z.object({
  period: z.union([z.number().int(), z.string()]), clock: z.string(), description: z.string().min(3), player: z.string().optional(),
  team: z.string().optional(), home: z.number(), away: z.number(), at: z.iso.datetime().optional(),
});
export const mediaAssetSchema = z.object({
  id: z.string().min(1), providerId: z.string().min(1), providerVersion: z.string().default("1"), eventId: z.string().min(1), people: z.array(z.string()).default([]),
  captureTime: z.iso.datetime(), duration: z.number().positive().optional(), width: z.number().int().positive().optional(), height: z.number().int().positive().optional(),
  focalArea: z.string().optional(), credit: z.string().min(1), grantId: z.string().min(1), grantVersion: z.number().int().positive().default(1),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u), status: z.enum(["available", "revoked", "quarantined"]).default("available"),
  sourceIn: z.string().optional(), sourceOut: z.string().optional(), eventClock: z.string().optional(), audio: z.boolean().default(false),
  file: z.string().optional(),
});
export const rightsGrantSchema = z.object({
  id: z.string().min(1), version: z.number().int().positive().default(1), licensor: z.string().min(1), status: z.enum(["active", "revoked", "expired"]).default("active"),
  components: z.array(z.enum(["video", "audio", "stills"])).min(1), channels: z.array(z.string().min(1)).min(1),
  surfaces: z.array(z.enum(["episode", "short", "thumbnail", "still"])).min(1), territories: z.array(z.string().min(2)).min(1),
  window: z.object({ embargoUntil: z.iso.datetime().optional(), expiresAt: z.iso.datetime().optional() }).default({}),
  alterations: z.object({ reframe: z.boolean().default(true), overlays: z.boolean().default(true), freezeFrame: z.boolean().default(false), speedChange: z.boolean().default(false) }).default({}),
  retention: z.string().default("archive while the grant is active"), aiProcessing: z.boolean().default(false),
  credit: z.string().min(1), claimContact: z.string().min(1), evidenceRef: z.string().min(1),
});
export const gameSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/u), league: z.string().min(2).max(40), sport: z.enum(["basketball", "football", "baseball", "hockey", "soccer"]),
  competition: z.string().min(2).max(90), season: z.string().min(4).max(12), venue: z.string().optional(),
  home: team, away: team, startTime: z.iso.datetime(), finalAt: z.iso.datetime().optional(), status: z.enum(["scheduled", "in-progress", "final", "postponed"]),
  scoreStates: z.array(scoreState), plays: z.array(play).default([]),
  leaders: z.array(z.object({ player: z.string(), team: z.string(), stats: z.record(z.string(), z.number()) })).default([]),
  reports: z.array(report),
  corrections: z.array(z.object({ at: z.iso.datetime(), report: z.number().int().nonnegative(), key: z.string().min(1), value: z.unknown(), text: z.string().min(3), reason: z.string().min(3) })).default([]),
  story: z.object({ headline: z.string().min(3).max(140), narration: z.string().min(20).max(750), claims: z.array(gameClaimSchema).min(1), diagram: diagram.optional() }).optional(),
  scenario: z.array(z.string()).default([]),
  media: z.object({ assets: z.array(mediaAssetSchema).default([]), grants: z.array(rightsGrantSchema).default([]) }).default({ assets: [], grants: [] }),
});
export const slateSchema = z.object({
  name: z.string().regex(/^[a-z0-9-]+$/u), title: z.string().min(3).max(120), date: z.iso.date(), synthetic: z.boolean().default(true),
  notes: z.string().optional(), games: z.array(gameSchema).min(1).max(12),
});
const slateDirectory = path.join(directory, "slates");

export async function listSlates() {
  return (await readdir(slateDirectory)).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/u, "")).sort();
}

export async function loadSlate(name) {
  const file = /[\\/]/u.test(name) ? path.resolve(name) : path.join(slateDirectory, `${name}.json`);
  const slate = slateSchema.parse(JSON.parse(await readFile(file, "utf8")));
  const ids = new Set();
  for (const game of slate.games) {
    if (ids.has(game.id)) throw new Error(`Slate ${slate.name} repeats game ${game.id}.`);
    ids.add(game.id);
    for (const claim of game.story?.claims || []) {
      if (claim.evidence.some(({ report }) => report >= game.reports.length)) throw new Error(`${game.id}: claim "${claim.text}" cites a report outside its list.`);
    }
    if (game.corrections.some(({ report }) => report >= game.reports.length)) throw new Error(`${game.id}: a correction cites a report outside its list.`);
  }
  return slate;
}

export async function loadAllSlates() {
  return Promise.all((await listSlates()).map((name) => loadSlate(name)));
}

export async function loadTrendFixture(name = "overtime-trend-scenarios") {
  return JSON.parse(await readFile(path.join(directory, "trends", `${name}.json`), "utf8"));
}

export const wordCount = (text) => text.trim().split(/\s+/u).length;

export async function listFixtures() {
  return (await readdir(directory)).filter((file) => file.endsWith(".json")).map((file) => file.replace(/\.json$/u, ""));
}

export async function loadFixture(name) {
  const file = /[\\/]/u.test(name) ? path.resolve(name) : path.join(directory, `${name}.json`);
  const fixture = fixtureSchema.parse(JSON.parse(await readFile(file, "utf8")));
  if (new Set(fixture.segments.map(({ id }) => id)).size !== fixture.segments.length) throw new Error("Fixture segment IDs must be unique.");
  return fixture;
}

// A narrator that needs no model: speech-paced, speech-shaped sound with the
// same timing contract as Kokoro, so renders and QC run anywhere.
export async function placeholderNarrate(parts, voice, file, report = () => {}, signal, { wordsPerSecond = 2.6 } = {}) {
  const rate = 24000;
  const lead = Math.round(rate * 0.15);
  const pieces = [new Float32Array(lead)];
  const segments = [];
  let cursor = lead;
  for (const [index, part] of parts.entries()) {
    signal?.throwIfAborted();
    report(`Timing placeholder narration (${index + 1} of ${parts.length})…`);
    const length = Math.round(rate * Math.max(1.2, wordCount(part.text) / wordsPerSecond));
    const samples = new Float32Array(length);
    for (let i = 0; i < length; i++) {
      const t = i / rate;
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4.5 * t);
      const edge = Math.min(1, i / (rate * 0.03), (length - i) / (rate * 0.03));
      samples[i] = 0.07 * edge * syllable * (Math.sin(2 * Math.PI * 140 * t) + 0.6 * Math.sin(2 * Math.PI * 210 * t) + 0.25 * Math.sin(2 * Math.PI * 650 * t));
    }
    segments.push({ kind: part.kind, text: part.text, start: cursor / rate, end: (cursor + length) / rate });
    const silence = new Float32Array(Math.round(rate * (index === parts.length - 1 ? 0.3 : part.pause ?? 0.38)));
    pieces.push(samples, silence);
    cursor += length + silence.length;
  }
  const total = new Float32Array(cursor);
  let offset = 0;
  for (const piece of pieces) {
    total.set(piece, offset);
    offset += piece.length;
  }
  await writeFile(file, wav(total, rate));
  return { file, voice: "placeholder", engine: "placeholder", rate, duration: total.length / rate, segments };
}
