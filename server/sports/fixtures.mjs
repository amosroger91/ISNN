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
