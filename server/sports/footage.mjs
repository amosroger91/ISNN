import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../config.mjs";
import { probe } from "../media.mjs";

const commonsOrigin = "https://commons.wikimedia.org";
const maxBytes = 35 * 1024 * 1024;
const licenses = new Map([
  ["CC0", "https://creativecommons.org/publicdomain/zero/1.0/"],
  ["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"],
  ["CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/"],
  ["CC BY 2.0", "https://creativecommons.org/licenses/by/2.0/"],
]);
const sports = {
  baseball: /baseball|mlb|pitch|home run|batting|bases/u,
  basketball: /basketball|nba|dunk|jumper|three pointer|layup/u,
  football: /football|nfl|touchdown|quarterback|field goal/u,
  hockey: /hockey|nhl|puck|ice rink/u,
  soccer: /soccer|association football|penalty kick|fifa/u,
};
const actionNames = ["home run", "grand slam", "touchdown", "game winner", "walk off", "hat trick", "buzzer beater", "penalty kick",
  "three pointer", "strikeout", "dunk", "double play", "goal"];
// B-roll has to show the play, or the team playing. A team name plus the word
// "game" is how a stadium crowd clip gets on the air.
const gameplay = {
  baseball: /\b(?:pitch(?:es|ed|ing)?|at bat|batting|swings?|home runs?|grand slams?|strikeouts?|double plays?|stolen bases?|innings?|fastballs?|curveballs?|walk offs?|base hits?|gameplay|game action)\b/u,
  basketball: /\b(?:dunks?|layups?|jumpers?|jump shots?|three pointers?|free throws?|rebounds?|dribbl(?:e|es|ed|ing)|alley oops?|fast breaks?|buzzer beaters?|gameplay|game action)\b/u,
  football: /\b(?:touchdowns?|field goals?|quarterbacks?|interceptions?|sacks?|punts?|kickoff returns?|handoffs?|scrambl(?:e|es|ed|ing)|rush(?:es|ed|ing)|pass(?:es|ed|ing)|tackl(?:e|es|ed|ing)|receptions?|first downs?|end zone|blitz(?:es|ed|ing)?|running backs?|wide receivers?|fumbles?|linebackers?|extra points?|from scrimmage|ball carriers?|gameplay|game action|game film)\b/u,
  hockey: /\b(?:goals?|pucks?|goalies?|faceoffs?|power plays?|wrist shots?|slap shots?|gameplay|game action)\b/u,
  soccer: /\b(?:goals?|penalty kicks?|free kicks?|corner kicks?|dribbl(?:e|es|ed|ing)|headers?|goalkeepers?|gameplay|game action)\b/u,
};
const playSearch = {
  baseball: ["pitch", "batting", '"home run"', "strikeout"],
  basketball: ["dunk", "layup", "rebound", '"jump shot"'],
  football: ["touchdown", "tackle", "quarterback", "interception"],
  hockey: ["goal", "puck", "goalie"],
  soccer: ["goal", "dribble", '"free kick"'],
};
const offField = /\b(?:interviews?|podcasts?|trailers?|tutorials?|simulations?|animations?|warm(?:ing)? ups?|training|practices?|parades?|ceremon(?:y|ies)|commercials?|danc(?:e|ing|ers)|reading a report|in drag|drag queens?|drag shows?|newsstands?|news stands?|tailgates?|cheerleaders?|marching bands?|mascots?|halftime shows?|pregames?|costumes?|press conferences?|locker rooms?|tunnel walks?|stadium tours?|cirque du soleil)\b/u;
const teamAliases = {
  baseball: [
    ["toronto blue jays", "blue jays", "blue jay", "bluejays"],
    ["new york yankees", "yankees"], ["boston red sox", "red sox"],
  ],
  basketball: [
    ["new york knicks", "knicks", "ny knicks"],
    ["michigan state spartans", "michigan state", "michigan st"],
    ["duke blue devils", "duke"], ["texas tech red raiders", "texas tech"],
    ["illinois fighting illini", "illinois", "fighting illini"],
  ],
  football: [
    ["lsu tigers", "lsu", "louisiana state", "louisiana state tigers"],
    ["texas longhorns", "texas", "longhorns"],
  ],
};
const wording = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const includes = (text, phrase) => Boolean(phrase && ` ${text} `.includes(` ${phrase} `));
const plain = (value) => String(value || "").replace(/<[^>]*>/gu, " ").replace(/&nbsp;|&#160;/gu, " ")
  .replace(/&amp;/gu, "&").replace(/\s+/gu, " ").trim().slice(0, 600);

export function commonsFileTitle(value) {
  try {
    const url = new URL(value);
    const pathname = decodeURIComponent(url.pathname);
    if (url.origin !== commonsOrigin || url.username || url.password || !pathname.startsWith("/wiki/File:")) return null;
    return pathname.slice(6).replaceAll("_", " ");
  } catch {
    return null;
  }
}

export function footageSubjects(segment) {
  const { teams = [], people = [], sport, topicTitle } = segment.footage || {};
  const headline = `${topicTitle || ""} ${segment.headline || ""}`;
  const names = headline.match(/\b[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,2}\b/gu) || [];
  const subjects = new Map();
  for (const name of teams.map(wording).filter((name) => name.length >= 2)) {
    const aliases = teamAliases[sport]?.find((group) => group.includes(name)) || [name];
    subjects.set(aliases[0], { aliases, team: true });
  }
  for (const name of [...people, ...names].map(wording)) {
    if (!name.includes(" ") || name.length < 7 || [...subjects.values()].some(({ aliases }) => aliases.includes(name))) continue;
    subjects.set(name, { aliases: [name], team: false });
  }
  return [...subjects.values()];
}

export function footageQueries(segment) {
  const subjects = footageSubjects(segment);
  const sport = sports[segment.footage?.sport] ? segment.footage.sport : "";
  const teams = subjects.filter(({ team }) => team).slice(0, 3);
  const people = subjects.filter(({ team }) => !team).slice(0, 2);
  const action = actionNames.find((name) => includes(wording(`${segment.headline} ${segment.narration}`), name));
  const terms = playSearch[sport] || [];
  const queries = new Set();
  if (action && segment.footage?.gameDate) {
    for (const { aliases: [name] } of [...people.slice(0, 1), ...teams.slice(0, 1)]) queries.add(`"${name}" "${action}"`);
  }
  // One play word per query. A parenthesized OR is parsed as optional and
  // returns videos that never mention the team.
  const names = teams.map(({ aliases }) => aliases[0]);
  for (const { aliases } of teams) if (aliases[1]) names.push(aliases[1]);
  for (const term of terms) {
    for (const name of names) queries.add(`"${name}"${sport ? ` ${sport}` : ""} ${term}`);
  }
  return [...queries].slice(0, 12).map((query) => `filetype:video ${query}`);
}

function footageRank(segment, item) {
  if (item.type === "exact") return 0;
  const description = wording(`${item.title} ${item.description}`);
  const spoken = wording(`${segment.headline} ${segment.narration} ${segment.footage?.topicTitle || ""}`);
  if (actionNames.some((action) => includes(spoken, action) && includes(description, action))) return 1;
  const teams = footageSubjects(segment).filter(({ team }) => team);
  if (teams.length >= 2 && teams.every(({ aliases }) => aliases.some((alias) => includes(description, alias)))) return 2;
  return 3;
}

export function classifyFootage(segment, item) {
  const description = wording(`${item.title} ${item.description}`);
  const context = wording(`${description} ${item.categories}`);
  const subjects = footageSubjects(segment);
  if (offField.test(description)) return null;
  // The file's own title and description have to describe people playing.
  // Categories and the word "game" also cover crowds, bands, and stadium exteriors.
  const sportKey = segment.footage?.sport;
  const played = gameplay[sportKey];
  const showsPlay = played ? played.test(description) : Object.values(gameplay).some((pattern) => pattern.test(description));
  if (!showsPlay) return null;
  const sport = sports[sportKey];
  const contextualMatch = sport ? sport.test(context) : Object.values(sports).some((pattern) => pattern.test(context));
  const matched = subjects.filter(({ aliases }) => aliases.some((alias) => includes(context, alias)));
  if (!matched.length || !contextualMatch) return null;
  const teams = subjects.filter(({ team }) => team);
  const quotedPlay = wording(`${segment.headline} ${segment.narration}`);
  const sameAction = actionNames.some((action) => includes(quotedPlay, action) && includes(description, action));
  const date = segment.footage?.gameDate;
  const samePlayer = matched.some(({ team, aliases }) => !team && aliases.some((alias) => includes(description, alias)));
  if (date && item.date?.startsWith(date) && teams.length >= 2 &&
      teams.every(({ aliases }) => aliases.some((alias) => includes(description, alias))) && sameAction && samePlayer) return "exact";
  return "broll";
}

export function footageCue(item, phrases, opening) {
  if (item.type !== "exact" || !item.title) return opening;
  const title = wording(item.title);
  return phrases.find(({ text }) => actionNames.some((action) => includes(title, action) && includes(wording(text), action)))?.start ?? opening;
}

export function commonsVideo(page) {
  const info = page.imageinfo?.[0];
  const video = info && (/^video\/(?:webm|mp4|ogg)$/u.test(info.mime) ||
    (info.mime === "application/ogg" && /\.ogv$/iu.test(page.title)));
  if (!Number.isSafeInteger(page.pageid) || page.pageid <= 0 || !video || !(info.size > 0 && info.size <= maxBytes)) return null;
  const metadata = info.extmetadata || {};
  const field = (name) => plain(metadata[name]?.value);
  const license = field("LicenseShortName");
  const licenseUrl = licenses.get(license);
  // Limit automatic use to creator-published originals with a simple reuse grant.
  if (!licenseUrl || !/^own work\b/iu.test(field("Credit")) || field("Restrictions")) return null;
  const creator = field("Artist");
  if (!creator || !commonsFileTitle(info.descriptionurl)) return null;
  const url = URL.parse(info.url);
  if (!url || url.origin !== "https://upload.wikimedia.org" || !url.pathname.startsWith("/wikipedia/commons/") || url.username || url.password) return null;
  return {
    id: `commons-${page.pageid}`, title: page.title.replace(/^File:/u, "").replace(/\.(?:webm|ogv|mp4)$/iu, ""),
    description: field("ImageDescription"), categories: field("Categories"), date: field("DateTimeOriginal"),
    creator, sourceUrl: info.descriptionurl, license, licenseUrl, url: url.href,
  };
}

export class CommonsFootage {
  constructor(directory, fetchImpl = fetch) {
    this.directory = directory;
    this.fetch = fetchImpl;
    this.requests = new Map();
    this.downloads = new Map();
  }

  search(fields, signal) {
    const params = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", prop: "imageinfo", iiprop: "url|size|mime|extmetadata",
      iiextmetadatafilter: "Artist|Credit|LicenseShortName|Restrictions|ImageDescription|Categories|DateTimeOriginal", maxlag: "5", ...fields,
    });
    const url = `${commonsOrigin}/w/api.php?${params}`;
    if (!this.requests.has(url)) this.requests.set(url, (async () => {
      const response = await this.fetch(url, this.options(4500, signal));
      if (!response.ok) return [];
      const result = await response.json();
      return (result.query?.pages || []).map(commonsVideo).filter(Boolean);
    })().catch(() => []));
    return this.requests.get(url);
  }

  options(timeout, signal) {
    const deadline = AbortSignal.timeout(timeout);
    return { headers: { "User-Agent": "WellspringMediaSports/1.0 (Wikimedia Commons attribution shown on air)" },
      redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
  }

  async candidates(segment, auto, signal) {
    const explicit = commonsFileTitle(segment.footage?.clipUrl);
    const results = new Map();
    if (explicit) {
      for (const item of await this.search({ titles: explicit }, signal)) results.set(item.id, { ...item, type: "exact" });
    }
    if (!results.size) {
      const cited = (segment.sources || []).map((source) => commonsFileTitle(source.url)).find(Boolean);
      if (cited) for (const item of await this.search({ titles: cited }, signal)) {
        const type = classifyFootage(segment, item);
        if (type) results.set(item.id, { ...item, type });
      }
    }
    if ([...results.values()].some(({ type }) => type === "exact") || !auto) return [...results.values()];
    const queries = footageQueries(segment);
    for (let start = 0; start < queries.length; start += 3) {
      const batch = await Promise.all(queries.slice(start, start + 3).map((query) =>
        this.search({ generator: "search", gsrnamespace: "6", gsrlimit: "20", gsrsearch: query }, signal)));
      for (const item of batch.flat()) {
        const type = classifyFootage(segment, item);
        if (type) results.set(item.id, { ...item, type });
      }
      if ([...results.values()].some(({ type }) => type === "exact")) break;
    }
    return [...results.values()].sort((a, b) => footageRank(segment, a) - footageRank(segment, b));
  }

  download(item, signal) {
    if (!this.downloads.has(item.id)) this.downloads.set(item.id, (async () => {
      const response = await this.fetch(item.url, this.options(12000, signal));
      if (!response.ok || !response.body || !/^(?:video\/|application\/ogg)/iu.test(response.headers.get("content-type") || "")) return null;
      const reader = response.body.getReader();
      let length = 0;
      const chunks = [];
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          length += value.byteLength;
          if (length > maxBytes) return null;
          chunks.push(Buffer.from(value));
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const file = path.join(this.directory, `${item.id}.video`);
      await writeFile(file, Buffer.concat(chunks));
      return file;
    })().catch(() => null));
    return this.downloads.get(item.id);
  }
}

const seconds = (value) => value == null ? null : /^(?:\d+:){0,2}\d+(?:\.\d+)?$/u.test(String(value))
  ? String(value).split(":").reduce((sum, part) => sum * 60 + Number(part), 0) : NaN;

export async function footageRange(file, input, output, limit, signal) {
  const info = await probe(file, signal);
  const video = info.streams.find((stream) => stream.codec_type === "video" && !stream.disposition?.attached_pic);
  const duration = Number(video?.duration || info.format?.duration);
  const start = seconds(input) ?? 0;
  const end = Math.min(seconds(output) ?? duration, duration, start + limit);
  return video && Number.isFinite(end) && end - start >= 0.30 ? { start, duration: end - start } : null;
}

export async function operatorFootage(shot, catalog) {
  if (shot?.kind !== "ShotUse") return null;
  const asset = catalog?.assets?.find(({ id }) => id === shot.assetId);
  const grant = catalog?.grants?.find(({ id }) => id === shot.grantId);
  if (!asset || !grant?.components?.includes("video") || grant.alterations?.overlays === false ||
      !asset.file || path.basename(asset.file) !== asset.file || !/\.(?:mp4|webm|mov|mkv|ogv)$/iu.test(asset.file)) return null;
  const directory = await realpath(path.join(dataDir, "sports", "footage"));
  const file = await realpath(path.join(directory, asset.file));
  if (path.dirname(file) !== directory) return null;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  if (hash.digest("hex") !== shot.assetSha256) return null;
  return { file, sourceIn: shot.source?.in, sourceOut: shot.source?.out, credit: plain(shot.credit), type: "exact", id: asset.id, title: asset.title };
}
