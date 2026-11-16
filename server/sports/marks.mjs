import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../config.mjs";

// Local stills for the plate. Paths come from data/sports/assets/manifest.json,
// which is gitignored with the image files. A missing manifest leaves the plate
// as the original graphic.
const words = (text) => String(text || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const mentions = (text, name) => Boolean(name && ` ${text} `.includes(` ${name} `));
const leagueOf = (key) => words(key).replace(/[^a-z0-9]/gu, "");

export async function platesFor(topics, { gameFor = () => null, assetDirectory = path.join(dataDir, "sports", "assets") } = {}) {
  let manifest;
  try {
    assetDirectory = await realpath(assetDirectory);
    manifest = JSON.parse(await readFile(path.join(assetDirectory, "manifest.json"), "utf8"));
  } catch {
    return new Map();
  }
  const plates = new Map();
  for (const topic of topics) {
    const plate = await plateFor(topic, manifest, topic.eventId ? gameFor(topic.eventId) : null, assetDirectory);
    if (plate) plates.set(topic.id, plate);
  }
  return plates;
}

async function assetFile(entry, directory, league, id) {
  if (!entry?.file || !/\.(?:png|jpe?g|webp)$/iu.test(entry.file)) return null;
  const file = await realpath(path.resolve(directory, entry.file)).catch(() => null);
  if (!file) return null;
  const relative = path.relative(directory, file);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  const match = /^(nba|mlb|ncaab|ncaaw|ncaaf|nfl|nhl|wnba)[\\/](?:teams|players)[\\/]([\w-]+)\./iu.exec(relative);
  if ((league && leagueOf(entry.league || match?.[1]) && league !== leagueOf(entry.league || match[1])) ||
      (id && match && match[2] !== String(id))) return null;
  return file;
}

async function plateFor(topic, manifest, game, directory) {
  const league = leagueOf(game?.league || topic.league);
  const names = (topic.teams || []).map((name) => ({ name }));
  const sides = game?.participants?.length ? game.participants : names.slice(0, 2);
  const score = game?.status === "final" ? game.scoreStates?.at(-1) : null;
  const matched = [];
  for (const team of sides) {
    const candidates = Object.entries(manifest.teams || {}).filter(([key, entry]) =>
      team.id && entry.id ? String(team.id) === String(entry.id)
        : [key, entry.name, ...(entry.aliases || [])].some((name) => words(name) === words(team.name)));
    let teamPlate = null;
    for (const [, entry] of candidates) {
      const logo = await assetFile(entry, directory, league, team.id || entry.id);
      if (!logo) continue;
      teamPlate = { name: team.name, short: team.short || entry.short || team.name, color: /^#[0-9a-f]{6}$/iu.test(entry.color) ? entry.color : null,
        score: Number.isFinite(score?.[team.role]) ? score[team.role] : null, logo };
      break;
    }
    matched.push({ role: team.role, plate: teamPlate });
  }
  const away = game ? matched.find(({ role }) => role === "away")?.plate : matched.length > 1 ? matched[0].plate : null;
  const home = game ? matched.find(({ role }) => role === "home")?.plate : matched.at(-1)?.plate;
  const fields = [topic.title, topic.script?.narration, topic.summary].map(words);
  let leader = null;
  for (const field of fields) {
    const found = [];
    for (const [name, entry] of Object.entries(manifest.players || {})) {
      if (!mentions(field, words(name))) continue;
      const headshot = await assetFile(entry, directory, league, entry.id);
      if (headshot) found.push({ name, line: "", headshot });
    }
    if (found.length > 1) break;
    if (found.length === 1) {
      [leader] = found;
      break;
    }
  }
  const still = (manifest.stills || {})[topic.id] || null;
  const stillFile = await assetFile(still, directory, league);
  if (!away && !home && !leader && !stillFile) return null;
  return {
    away,
    home,
    leader,
    still: stillFile ? { file: stillFile, label: still.label || "Highlight still" } : null,
  };
}
