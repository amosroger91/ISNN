import { access, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir, ffmpegPath, root } from "../config.mjs";
import { run } from "../process.mjs";
import { CommonsFootage, footageSubjects, gameplay, includes, leadTeams, namedTeams, useTeamDirectory, wording } from "./footage.mjs";
import { loadEspnDirectory } from "./team-logos.mjs";

const FAILED_DOWNLOAD_DAYS = 3;
const womens = /\b(?:women s|womens|women|wbb|ncaaw|lady)\b/u;
const matchup = /\b(?:vs|v|versus|at|against|beats?|beat|over|tops?|edges?|downs?|stuns?|upsets?|routs?|faces?|hosts?|visits?|meets?)\b/u;

// Loads the cached league team lists once so footage matching knows every club,
// not only the hand-kept aliases. A missing list leaves those aliases in place.
let footageTeams;
export function loadFootageTeams(load = loadEspnDirectory) {
  footageTeams ||= (async () => {
    const leagues = [["basketball", "ncaab"], ["basketball", "nba", true], ["basketball", "wnba", true], ["football", "ncaaf"], ["football", "nfl", true], ["baseball", "mlb", true]];
    for (const [sport, league, pro] of leagues) {
      try { useTeamDirectory(sport, await load(league), { pro }); } catch { /* keep the hand-kept aliases */ }
    }
  })();
  return footageTeams;
}

export function youtubeVideoId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    const id = host === "youtu.be" ? url.pathname.slice(1) :
      ["www.youtube.com", "youtube.com", "m.youtube.com"].includes(host)
        ? url.pathname === "/watch" ? url.searchParams.get("v") : /^\/(?:shorts|embed)\/([^/]+)$/u.exec(url.pathname)?.[1] : null;
    return /^[\w-]{11}$/u.test(id || "") ? id : null;
  } catch { return null; }
}

const excluded = /\b(?:interview|podcast|reaction|press conference|predictions?|preview|gaming|gameplay simulation|madden|nba 2k\w*|ncaa \d{2}|ea sports|video game|ai generated|fan cam|crowd|stadium tour)\b/u;
const sportTerms = {
  football: /\b(?:football|nfl|ncaaf|touchdown|quarterback|cfb)\b/u,
  basketball: /\b(?:basketball|nba|wnba|ncaab|dunk|hoops)\b/u,
  baseball: /\b(?:baseball|mlb|home run|pitching)\b/u,
  hockey: /\b(?:hockey|nhl|puck)\b/u,
  soccer: /\b(?:soccer|fifa|premier league|mls)\b/u,
};
const genericNewsWords = new Set("the and for from with this that what when where how are was were will has have had into about after before over under more news latest update video footage breaking other announces announced announcement".split(" "));
const newsTerms = (text) => [...new Set(wording(text).split(" ").filter((word) => word.length >= 3 && !genericNewsWords.has(word)))];

export function youtubeQueries(segment) {
  const subjects = footageSubjects(segment);
  // Search the story's own teams. A club the copy passes by is never paired in a "vs" query.
  const lead = leadTeams(segment);
  const teams = (lead.length ? lead : subjects.filter(({ team }) => team)).map(({ aliases }) => aliases[0]);
  const people = subjects.filter(({ team }) => !team).map(({ aliases }) => aliases[0]);
  const sport = segment.footage?.sport;
  if (sport === "other") {
    const title = segment.footage?.topicTitle || segment.headline || "";
    return newsTerms(title).length >= 2 ? [`${title.slice(0, 180)} news footage`] : [];
  }
  if (!sportTerms[sport]) return [];
  const date = /^\d{4}-\d{2}-\d{2}$/u.test(segment.footage?.gameDate || "") ? segment.footage.gameDate : "";
  const queries = [];
  if (teams.length > 1) queries.push(`${teams.slice(0, 2).join(" vs ")} ${sport} ${date} highlights`);
  const order = lead.length ? [...teams.slice(0, 2), ...people.slice(0, 1)] : [...people.slice(0, 1), ...teams.slice(0, 2)];
  for (const name of order) queries.push(`${name} ${sport} ${date} highlights`);
  return [...new Set(queries.map((query) => query.replace(/\s+/gu, " ").trim()))].slice(0, 3);
}

const collegeTitle = /\b(?:ncaa[a-z]?|college|men s basketball|women s basketball|cbb|cfb|march madness|final four|big ten|big 12|big east|pac 12|sec|acc|mountain west|bowl game)\b/u;
const proTitle = /\b(?:nba|wnba|nfl|mlb|nba cup|emirates nba cup)\b/u;
const proLeagues = /^(?:nba|wnba|nfl|mlb|nhl|mls)$/u;
const collegeLeagues = /^(?:ncaa[a-z]?|ncaab|ncaaf|ncaaw|college)/u;

export function storyLevel(segment) {
  const league = wording(segment.league || segment.footage?.league || "").replace(/\s+/gu, "");
  if (proLeagues.test(league)) return "pro";
  if (collegeLeagues.test(league)) return "college";
  return null;
}

export function youtubeCandidate(segment, entry) {
  const id = entry?.id;
  if (!/^[\w-]{11}$/u.test(id || "") || entry.is_live || ["is_live", "is_upcoming", "post_live"].includes(entry.live_status)) return null;
  if (!Number.isFinite(entry.duration) || entry.duration < 15 || entry.duration > 1800) return null;
  const title = wording(entry.title);
  const context = wording(`${entry.title || ""} ${entry.channel || entry.uploader || ""}`);
  const sport = segment.footage?.sport;
  const generalNews = sport === "other";
  if (!generalNews && (excluded.test(title) || !sportTerms[sport]?.test(context))) return null;
  // Match the title itself. Descriptions often contain unrelated recommended videos.
  const matched = footageSubjects(segment).filter(({ aliases }) => aliases.some((alias) => {
    if (!includes(title, alias)) return false;
    // A bare school name must stand alone: Texas is not Texas Tech.
    const distinct = ["state", "tech", "am", "a m"].reduce((text, suffix) => text.replaceAll(`${alias} ${suffix}`, ""), title);
    return includes(distinct, alias);
  }));
  if (generalNews) {
    const terms = newsTerms(segment.footage?.topicTitle || segment.headline);
    const shared = terms.filter((word) => includes(title, word));
    if (shared.length < 2) return null;
    if (!matched.length) matched.push({ aliases: [shared.join(" ")], team: false });
  } else if (!matched.length || !(/\b(?:highlights?|full game|game film|vs|versus)\b/u.test(title) || gameplay[sport]?.test(title))) return null;
  const otherSports = Object.entries(sportTerms).filter(([key]) => key !== sport && !(key === "soccer" && sport === "football"));
  if (!generalNews && otherSports.some(([, pattern]) => pattern.test(title))) return null;
  let leadMatches = 0;
  if (!generalNews) {
    // A women's game is not footage for a men's story, and the other way round.
    const headline = wording(`${segment.footage?.topicTitle || ""} ${segment.headline || ""}`);
    const womensStory = womens.test(`${headline} ${wording(segment.league)}`) || /\b(?:wnba|ncaaw|women s basketball|women s college)\b/u.test(wording(segment.narration));
    if (womens.test(title) && !womensStory) return null;
    // Pro and college share city names: an NBA story about Minnesota or
    // Milwaukee took "UCLA vs Minnesota" and "#21 USC vs Milwaukee" college
    // games on 2026-11-22. A pro story never takes a college clip, nor the reverse.
    const level = storyLevel(segment);
    if (level === "pro" && collegeTitle.test(title)) return null;
    if (level === "college" && proTitle.test(title)) return null;
    // The clip has to show a team the story is about, not one the copy only
    // mentions on the way (UCLA vs. Michigan is not Ohio State vs. Michigan).
    // A player the title names counts too: a trade story can run his highlights.
    const lead = leadTeams(segment);
    const isLead = (aliases) => lead.some((team) => team.aliases[0] === aliases[0]);
    leadMatches = matched.filter(({ aliases }) => isLead(aliases)).length;
    const titledPerson = matched.some(({ team, aliases }) => !team && includes(headline, aliases[0]));
    if (lead.length && !leadMatches && !titledPerson) return null;
    // A matchup story takes only that matchup or a single side of it.
    if (lead.length === 2 && matchup.test(headline) && namedTeams(entry.title, sport).some((aliases) => !isLead(aliases))) return null;
  }
  // Old games are the wrong rosters: a 2009 meeting or a 2024 Finals is not this
  // season's story. Anything three or more years old is out; last year ranks lower.
  const currentYear = Number(/^\d{4}/u.exec(segment.footage?.gameDate || segment.date || "")?.[0]) || new Date().getFullYear();
  // A season written "2024-25" ended in 2025.
  const seasons = String(entry.title).replace(/\b(19|20)\d{2}[-–](\d{2})\b/gu, "$1$2");
  const years = (seasons.match(/\b(?:19|20)\d{2}\b/gu) || []).map(Number).filter((year) => year <= currentYear + 1);
  const newest = years.length ? Math.max(...years) : null;
  if (!generalNews && newest && newest <= currentYear - 2) return null;
  const agePenalty = newest && newest < currentYear ? 15 : 0;
  // Upload time is not game time: even a same-day upload remains labeled file footage.
  return {
    id: `youtube-${id}`, videoId: id, title: String(entry.title).slice(0, 300), type: "broll", provider: "youtube", matched,
    creator: entry.channel || entry.uploader || "YouTube", sourceUrl: `https://www.youtube.com/watch?v=${id}`,
    license: "YouTube source", licenseUrl: null, sourceIn: 0, sourceOut: 30,
    score: leadMatches * 20 + matched.length * 10 + (matched.some(({ team }) => !team) ? 5 : 0) - agePenalty,
  };
}

export class YouTubeFootage {
  constructor(directory, { runImpl = run, cacheDir = path.join(dataDir, "sports", "cache", "youtube") } = {}) {
    this.directory = directory;
    this.cacheDir = cacheDir;
    this.run = runImpl;
    this.requests = new Map();
    this.downloads = new Map();
    this.unavailable = false;
  }

  command(args, signal, timeout = 45_000) {
    const executable = process.env.SPORTS_YTDLP;
    const command = executable || process.env.SPORTS_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const prefix = executable ? [] : [path.join(root, "scripts", "youtube-footage.py")];
    return this.run(command, [...prefix, "--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-warnings", "--socket-timeout", "15", "--retries", "1",
      "--js-runtimes", `node:${process.execPath}`, ...args], { signal, timeout, maxBytes: 4 * 1024 * 1024 });
  }

  async candidates(segment, auto, signal) {
    if (this.unavailable || process.env.SPORTS_YOUTUBE_FOOTAGE === "off") return [];
    const pinned = youtubeVideoId(segment.footage?.clipUrl);
    const queries = pinned ? [`https://www.youtube.com/watch?v=${pinned}`] : auto ? youtubeQueries(segment).map((query) => `ytsearch5:${query}`) : [];
    const results = new Map();
    for (const query of queries) {
      signal?.throwIfAborted();
      try {
        if (!this.requests.has(query)) this.requests.set(query, this.command(["--flat-playlist", "--dump-single-json", "--skip-download", "--", query], signal));
        const data = JSON.parse(await this.requests.get(query));
        for (const entry of data.entries || [data]) {
          const item = youtubeCandidate(segment, entry);
          if (item) results.set(item.id, item);
        }
        if (results.size >= 3) break;
      } catch (error) {
        signal?.throwIfAborted();
        if (/ENOENT|No module named|Install YouTube footage/i.test(error.message)) this.unavailable = true;
        console.warn(`[sports footage] YouTube search failed: ${error.message.slice(0, 300)}`);
        if (this.unavailable) break;
      }
    }
    return [...results.values()].sort((a, b) => b.score - a.score);
  }

  download(item, signal) {
    if (!this.downloads.has(item.id)) this.downloads.set(item.id, this.downloadClip(item, signal));
    return this.downloads.get(item.id);
  }

  async downloadClip(item, signal) {
    if (!/^[\w-]{11}$/u.test(item.videoId || "")) return null;
    await mkdir(this.cacheDir, { recursive: true });
    const file = path.join(this.cacheDir, `${item.videoId}.mp4`);
    if (await access(file).then(() => true, () => false)) return file;
    // A video that failed recently (removed, region-locked, no HD format) is
    // skipped instead of costing every attempt another download.
    const failures = await this.failures();
    if (failures[item.videoId] && Date.now() - Date.parse(failures[item.videoId]) < FAILED_DOWNLOAD_DAYS * 86_400_000) return null;
    // Work in render staging; only a completed, playable download enters the cache.
    const staged = path.join(this.directory, `${item.id}.mp4`);
    try {
      await this.command([
        "--format", "bestvideo[height>=720][height<=1080]/best[height>=720][height<=1080]",
        "--download-sections", "*0-30", "--force-keyframes-at-cuts", "--ffmpeg-location", ffmpegPath,
        "--merge-output-format", "mp4", "--remux-video", "mp4", "--max-filesize", "100M",
        "--no-progress", "--output", staged, "--", `https://www.youtube.com/watch?v=${item.videoId}`,
      ], signal, 120_000);
      const { probe } = await import("../media.mjs");
      const info = await probe(staged, signal);
      if (!info.streams.some((stream) => stream.codec_type === "video" && stream.height >= 720)) throw new Error("YouTube clip has no HD video.");
      const { copyFile } = await import("node:fs/promises");
      await copyFile(staged, file);
      await this.prune(file);
      return file;
    } catch (error) {
      signal?.throwIfAborted();
      console.warn(`[sports footage] YouTube download failed: ${error.message.slice(0, 300)}`);
      await this.rememberFailure(item.videoId).catch(() => {});
      return null;
    }
  }

  async failures() {
    this.failed ||= readFile(path.join(this.cacheDir, "failed.json"), "utf8").then(JSON.parse, () => ({}));
    return this.failed;
  }

  async rememberFailure(videoId) {
    const failures = { ...await this.failures(), [videoId]: new Date().toISOString() };
    this.failed = Promise.resolve(failures);
    const target = path.join(this.cacheDir, "failed.json");
    await writeFile(`${target}.tmp`, JSON.stringify(failures));
    await rename(`${target}.tmp`, target);
  }

  async prune(keep) {
    const budget = (Number(process.env.SPORTS_FOOTAGE_CACHE_MB) || 2048) * 1024 * 1024;
    const files = await Promise.all((await readdir(this.cacheDir)).filter((name) => /^[\w-]{11}\.mp4$/u.test(name)).map(async (name) => {
      const file = path.join(this.cacheDir, name);
      return { file, ...await stat(file) };
    }));
    let size = files.reduce((total, file) => total + file.size, 0);
    for (const item of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (size <= budget) break;
      if (item.file === keep) continue;
      await rm(item.file);
      size -= item.size;
    }
  }
}

export class StoryFootage {
  constructor(directory, fetchImpl = fetch) {
    this.youtube = new YouTubeFootage(directory);
    this.commons = new CommonsFootage(directory, fetchImpl);
  }
  async candidates(segment, auto, signal, allowPreview) {
    // Keep offline previews offline. Live footage prefers a relevant YouTube clip.
    const youtube = allowPreview ? [] : await this.youtube.candidates(segment, auto, signal);
    if (youtube.length) return youtube;
    return this.commons.candidates(segment, auto, signal, allowPreview);
  }
  download(item, signal) {
    return item.provider === "youtube" ? this.youtube.download(item, signal) : this.commons.download(item, signal);
  }
}
