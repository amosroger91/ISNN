import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../config.mjs";
import { AssetCache } from "./assets.mjs";
import { ESPN_BASE, LEAGUES as ESPN_LEAGUES, safeImageUrl } from "./espn/client.mjs";
import { teamsInText, wording } from "./footage.mjs";

// Team marks for a cover. These are the same cached ESPN marks the plates
// already composite. They are not the photograph, and a miss still draws the cover.
const DIRECTORY_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const SPORT_LEAGUES = {
  baseball: ["mlb"],
  basketball: ["nba", "wnba", "ncaab", "ncaaw"],
  football: ["nfl", "ncaaf"],
  hockey: ["nhl"],
  soccer: ["epl"],
};
const LEAGUE_KEYS = {
  nba: "nba",
  wnba: "wnba",
  ncaab: "ncaab",
  ncaaw: "ncaaw",
  ncaaf: "ncaaf",
  nfl: "nfl",
  mlb: "mlb",
  nhl: "nhl",
};

let manifestPromise;
let assetCache;

function sharedAssets() {
  assetCache ||= new AssetCache();
  return assetCache;
}

function readManifest() {
  manifestPromise ||= readFile(path.join(dataDir, "sports", "assets", "manifest.json"), "utf8")
    .then((text) => JSON.parse(text))
    .catch(() => ({ teams: {} }));
  return manifestPromise;
}

async function fileExists(file) {
  if (!file || typeof file !== "string") return false;
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

// Exact wording, or a multi-word alias as a whole-word prefix of the field.
// A bare "michigan" does not match "michigan state".
// Exact wording, or a multi-word alias opening the field ("ohio state" matches
// "ohio state buckeyes"). A bare "michigan" does not match "michigan state".
function matchScore(team, fields) {
  let best = 0;
  const aliases = [...new Set((team.aliases || [team.canonical]).map(wording))].filter(Boolean);
  for (const alias of aliases) {
    for (const field of fields.map(wording).filter(Boolean)) {
      if (field === alias) best = Math.max(best, alias.includes(" ") ? 4 : 3);
      else if (alias.includes(" ") && field.startsWith(`${alias} `)) best = Math.max(best, 2);
    }
  }
  return best;
}

function bestByScore(entries) {
  let winner = null;
  let best = 1;
  for (const entry of entries) {
    if (entry.score > best) {
      best = entry.score;
      winner = entry;
    }
  }
  return winner;
}

function plateFile(team, stories) {
  const entries = [];
  for (const story of stories || []) {
    for (const side of [story?.plate?.away, story?.plate?.home]) {
      if (!side?.logo || typeof side.logo !== "string" || /[\\/]players[\\/]/iu.test(side.logo)) continue;
      entries.push({ score: matchScore(team, [side.name, side.short].map(wording)), file: side.logo });
    }
  }
  return bestByScore(entries)?.file || null;
}

function manifestFile(team, manifest) {
  const entries = [];
  for (const [key, entry] of Object.entries(manifest?.teams || {})) {
    if (!entry?.file || typeof entry.file !== "string" || /[\\/]players[\\/]/iu.test(entry.file)) continue;
    const fields = [key, entry.name, entry.short, ...(entry.aliases || [])].map(wording);
    entries.push({ score: matchScore(team, fields), file: entry.file });
  }
  return bestByScore(entries)?.file || null;
}

const safeColor = (value) => /^#?[0-9a-f]{6}$/iu.test(value || "") ? `#${value.replace(/^#/u, "")}` : null;

export function slimDirectoryTeam(team) {
  if (!team?.id) return null;
  const logos = [];
  for (const logo of team.logos || []) {
    const href = safeImageUrl(logo?.href);
    const rel = Array.isArray(logo?.rel) ? logo.rel.filter((item) => typeof item === "string") : [];
    if (!href || !rel.includes("default") || rel.includes("dark")) continue;
    logos.push({ href, rel });
  }
  return {
    id: String(team.id),
    displayName: team.displayName || "",
    shortDisplayName: team.shortDisplayName || "",
    name: team.name || "",
    nickname: team.nickname || "",
    abbreviation: team.abbreviation || "",
    ...(safeColor(team.color) ? { color: safeColor(team.color) } : {}),
    logos,
  };
}

export function teamsFromDirectoryBody(body) {
  const rows = body?.sports?.[0]?.leagues?.[0]?.teams || [];
  return rows.map((row) => slimDirectoryTeam(row?.team || row)).filter(Boolean);
}

export function defaultLogoHref(record) {
  const usable = [];
  for (const logo of record?.logos || []) {
    const href = safeImageUrl(logo?.href);
    const rel = logo?.rel || [];
    if (!href || rel.includes("dark") || rel.includes("headshot")) continue;
    usable.push(href);
  }
  return usable.find((href) => /\/500\//.test(href)) || usable[0] || null;
}

function recordFields(record) {
  return [record.displayName, record.shortDisplayName, record.name, record.nickname, record.abbreviation].map(wording);
}

function bestRecord(team, records) {
  const entries = (records || []).map((record) => ({ score: matchScore(team, recordFields(record)), record }));
  return bestByScore(entries)?.record || null;
}

// The league directory also covers clubs outside the footage alias list (for
// example an NFL team or a new college opponent). Prefer the longest complete
// name so Michigan State cannot accidentally produce Michigan's mark.
export function directoryTeamsInText(text, records) {
  const blob = ` ${wording(text)} `;
  const hits = [];
  for (const record of records || []) {
    for (const name of [record.displayName, record.shortDisplayName, record.name]) {
      const alias = wording(name);
      if (alias.length < 4) continue;
      const start = blob.indexOf(` ${alias} `);
      if (start >= 0) hits.push({ record, start, end: start + alias.length + 1 });
    }
  }
  hits.sort((a, b) => (b.end - b.start) - (a.end - a.start) || a.start - b.start);
  const chosen = [];
  for (const hit of hits) {
    if (chosen.some((other) => other.record.id === hit.record.id || hit.start < other.end && hit.end > other.start)) continue;
    chosen.push(hit);
  }
  return chosen.sort((a, b) => a.start - b.start).map(({ record }) => record);
}

function espnKey(story) {
  const compact = wording(story?.league || "").replace(/[^a-z0-9]/gu, "");
  if (LEAGUE_KEYS[compact]) return LEAGUE_KEYS[compact];
  const college = /ncaa|college/u.test(wording(story?.league || ""));
  if (!college) return null;
  if (story?.sport === "football") return "ncaaf";
  if (story?.sport === "basketball") return /women|ncaaw/iu.test(story?.league || "") ? "ncaaw" : "ncaab";
  return null;
}

function storyNamesTeam(story, team) {
  const blob = [
    story?.headline,
    story?.title,
    ...(story?.teams || []),
    story?.plate?.away?.name,
    story?.plate?.home?.name,
    story?.plate?.away?.short,
    story?.plate?.home?.short,
  ].filter(Boolean).join(" ");
  return teamsInText(blob, { sport: story?.sport }).some((hit) => hit.canonical === team.canonical);
}

function leagueKeysFor(team, stories) {
  const keys = [];
  const add = (key) => {
    if (key && ESPN_LEAGUES[key] && !keys.includes(key)) keys.push(key);
  };
  for (const story of stories || []) {
    if (storyNamesTeam(story, team)) add(espnKey(story));
  }
  const sportOrder = [...(team.sports || [])];
  for (const story of stories || []) {
    if (!team.sports?.includes(story?.sport)) continue;
    add(espnKey(story));
    const index = sportOrder.indexOf(story.sport);
    if (index > 0) {
      sportOrder.splice(index, 1);
      sportOrder.unshift(story.sport);
    }
  }
  for (const sport of sportOrder) {
    for (const key of SPORT_LEAGUES[sport] || []) add(key);
  }
  return keys;
}

export async function loadEspnDirectory(leagueKey, {
  root = path.join(dataDir, "sports", "assets", "espn-directory"),
  fetchImpl = fetch,
  now = () => Date.now(),
  userAgent = process.env.SPORTS_ESPN_USER_AGENT || "ISNN-Overtime-Desk",
} = {}) {
  const league = ESPN_LEAGUES[leagueKey];
  if (!league) return [];
  const file = path.join(root, `${leagueKey}.json`);
  try {
    const cached = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(cached.teams) && now() - Date.parse(cached.storedAt) < DIRECTORY_TTL_MS) return cached.teams;
  } catch {
    // A missing directory cache is a fetch.
  }
  const url = `${ESPN_BASE}/${league.path}/teams?limit=1000`;
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { "User-Agent": userAgent, Accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return [];
  }
  if (!response?.ok) return [];
  let teams = [];
  try {
    teams = teamsFromDirectoryBody(await response.json());
  } catch {
    return [];
  }
  if (!teams.length) return [];
  await mkdir(root, { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify({ storedAt: new Date(now()).toISOString(), teams }));
  await rename(temporary, file);
  return teams;
}

async function directoryForLeague(leagueKey, options) {
  if (options.directoryFor) return options.directoryFor(leagueKey);
  const memo = options.cache?.directories;
  if (memo?.has(leagueKey)) return memo.get(leagueKey);
  const pending = loadEspnDirectory(leagueKey);
  if (memo) memo.set(leagueKey, pending);
  return pending;
}

async function defaultDownload({ url, leagueKey, entityId }) {
  const assets = sharedAssets();
  const saved = await assets.store({ url, leagueKey, kind: "team", entityId });
  if (!saved || saved.miss || !saved.file) return null;
  return path.isAbsolute(saved.file) ? saved.file : path.join(assets.root, saved.file);
}

async function present(file, exists) {
  try {
    return Boolean(file) && await exists(file);
  } catch {
    return false;
  }
}

async function resolveLogo(team, stories, options) {
  const plate = plateFile(team, stories);
  if (await present(plate, options.exists)) {
    const side = stories.flatMap((story) => [story?.plate?.away, story?.plate?.home]).find((side) => side?.logo === plate);
    return { file: plate, color: safeColor(side?.color) };
  }
  const local = manifestFile(team, options.manifest);
  if (await present(local, options.exists)) {
    const entry = Object.values(options.manifest?.teams || {}).find((entry) => entry.file === local);
    return { file: local, color: safeColor(entry?.color) };
  }
  if (!options.fetchMissing) return null;
  for (const leagueKey of leagueKeysFor(team, stories)) {
    let records = [];
    try {
      records = await directoryForLeague(leagueKey, options) || [];
    } catch {
      continue;
    }
    const record = bestRecord(team, records);
    const href = defaultLogoHref(record);
    if (!record?.id || !href) continue;
    try {
      const file = await options.download({ url: href, leagueKey, entityId: String(record.id), name: team.canonical });
      if (await present(file, options.exists)) return { file, color: safeColor(record.color) };
    } catch {
      // Try the next league, then skip the mark.
    }
  }
  return null;
}

// Up to `limit` marks named in `text`, in reading order. Plate file, then the
// local manifest, then the default ESPN png. A failed lookup is skipped.
export async function logosForTitle(text, options = {}) {
  const stories = options.stories || [];
  const sport = stories.length === 1 ? stories[0]?.sport : options.sport;
  const teams = teamsInText(text, { sport }).slice(0, options.scanLimit || 8);
  const resolved = {
    manifest: options.manifest || await readManifest(),
    stories,
    fetchMissing: options.fetchMissing !== false,
    directoryFor: options.directoryFor,
    download: options.download || defaultDownload,
    exists: options.exists || fileExists,
    cache: options.cache || { directories: new Map() },
  };
  const logos = [];
  const limit = options.limit ?? 2;
  for (const team of teams) {
    if (logos.length >= limit) break;
    try {
      const asset = await resolveLogo(team, stories, resolved);
      if (asset) logos.push({ name: team.canonical, file: asset.file, color: asset.color, sports: team.sports });
    } catch {
      // One mark failing leaves the rest of the cover.
    }
  }
  if (logos.length < limit && resolved.fetchMissing) {
    const leagues = [...new Set(stories.map(espnKey).filter(Boolean))];
    for (const leagueKey of leagues) {
      let records = [];
      try { records = await directoryForLeague(leagueKey, resolved) || []; } catch { continue; }
      for (const record of directoryTeamsInText(text, records)) {
        if (logos.length >= limit) break;
        if (logos.some((logo) => matchScore({ canonical: logo.name, aliases: [logo.name] }, recordFields(record)) > 1)) continue;
        const url = defaultLogoHref(record);
        if (!url) continue;
        try {
          const file = await resolved.download({ url, leagueKey, entityId: String(record.id), name: record.displayName });
          if (await present(file, resolved.exists)) logos.push({ name: record.displayName, file, color: safeColor(record.color), sports: [stories.find((story) => espnKey(story) === leagueKey)?.sport].filter(Boolean) });
        } catch {
          // Unavailable art does not prevent the rest of the cover rendering.
        }
      }
      if (logos.length >= limit) break;
    }
  }
  return logos;
}
