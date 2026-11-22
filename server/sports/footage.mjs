import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../config.mjs";
import { probe } from "../media.mjs";
import { footageArchive, footageLibrary } from "./footage-archive.mjs";

const commonsOrigin = "https://commons.wikimedia.org";
const maxBytes = 35 * 1024 * 1024;
const licenses = new Map([
  ["CC0", "https://creativecommons.org/publicdomain/zero/1.0/"],
  ["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"],
  ["CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/"],
  ["CC BY 2.5", "https://creativecommons.org/licenses/by/2.5/"],
  ["CC BY 2.0", "https://creativecommons.org/licenses/by/2.0/"],
  ["Public domain", "https://creativecommons.org/publicdomain/mark/1.0/"],
]);
const previewLicenses = new Map([
  ["CC BY-SA 4.0", "https://creativecommons.org/licenses/by-sa/4.0/"],
  ["CC BY-SA 3.0", "https://creativecommons.org/licenses/by-sa/3.0/"],
  ["CC BY-SA 2.0", "https://creativecommons.org/licenses/by-sa/2.0/"],
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
export const gameplay = {
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
    ["chicago cubs", "cubs"], ["los angeles dodgers", "dodgers"],
    ["atlanta braves", "braves"], ["houston astros", "astros"],
  ],
  basketball: [
    ["new york knicks", "knicks", "ny knicks"],
    ["michigan state spartans", "michigan state", "michigan st", "spartans"],
    ["duke blue devils", "duke", "blue devils"], ["texas tech red raiders", "texas tech"],
    ["illinois fighting illini", "illinois", "fighting illini"],
    ["ohio state buckeyes", "ohio state", "buckeyes"],
    ["houston cougars", "houston", "cougars"],
    ["florida gators", "florida", "gators"],
    ["kansas jayhawks", "kansas", "jayhawks"],
    ["west virginia mountaineers", "west virginia", "mountaineers"],
    ["tennessee volunteers", "tennessee", "volunteers"],
    ["lsu tigers", "lsu", "louisiana state"],
    ["gonzaga bulldogs", "gonzaga"],
    ["los angeles sparks", "sparks"],
    ["boston celtics", "celtics"],
    ["philadelphia 76ers", "76ers", "sixers"],
    ["los angeles lakers", "lakers"],
    ["golden state warriors", "warriors"],
    ["san antonio spurs", "spurs"],
  ],
  football: [
    ["lsu tigers", "lsu", "louisiana state", "louisiana state tigers"],
    ["texas longhorns", "texas", "longhorns"],
    ["ohio state buckeyes", "ohio state", "buckeyes"],
    ["michigan wolverines", "michigan", "wolverines"],
    ["florida state seminoles", "florida state", "seminoles", "fsu"],
    ["tennessee volunteers", "tennessee", "volunteers"],
    ["penn state nittany lions", "penn state", "nittany lions"],
    ["georgia bulldogs", "georgia", "bulldogs"],
    ["clemson tigers", "clemson"],
    ["alabama crimson tide", "alabama", "crimson tide"],
    ["notre dame fighting irish", "notre dame"],
    ["oregon ducks", "oregon", "ducks"],
    // Wording turns "A&M" into "a m".
    ["texas am aggies", "texas a m aggies", "texas am", "texas a m", "aggies"],
  ],
};
const genericAlias = new Set(["state", "tech", "game", "city", "new", "san", "los", "red", "blue", "west", "east", "north", "south", "college", "university"]);
// A network upload tagged with a free license is still a broadcast. Public-domain
// game film stays; a YouTube or highlight rip does not.
const broadcastRip = /\b(?:espn|fox sports|cbs sports|nbc sports|tnt|nba tv|nfl network|mlb network|sec network|acc network|big ten network|youtube|telecast|highlights?)\b/iu;
export const wording = (value) => String(value || "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
  .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
export const includes = (text, phrase) => Boolean(phrase && ` ${text} `.includes(` ${phrase} `));
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

// Whole-word removal. A split on the surrounding spaces drops a following
// "Michigan State Spartans" when two "Michigan State" phrases share a boundary.
function withoutPhrases(text, phrases) {
  let tokens = String(text || "").split(" ").filter(Boolean);
  const ordered = [...phrases].filter(Boolean).sort((left, right) => right.length - left.length);
  for (const phrase of ordered) {
    const words = phrase.split(" ").filter(Boolean);
    if (!words.length) continue;
    const next = [];
    for (let index = 0; index < tokens.length; ) {
      const slice = tokens.slice(index, index + words.length);
      if (slice.length === words.length && slice.every((word, offset) => word === words[offset])) {
        index += words.length;
        continue;
      }
      next.push(tokens[index]);
      index += 1;
    }
    tokens = next;
  }
  return tokens.join(" ");
}

function phraseIndex(text, phrase) {
  const index = ` ${text} `.indexOf(` ${phrase} `);
  return index < 0 ? text.length : index;
}

function earliestIndex(text, aliases) {
  let best = text.length;
  for (const alias of aliases) {
    if (includes(text, alias)) best = Math.min(best, phraseIndex(text, alias));
  }
  return best;
}

// "Michigan" is not Michigan State, and "Texas" is not Texas Tech or Texas A&M.
// Strip those longer names, then keep a bare word only when it still stands alone.
function bareWordStands(text, matched) {
  return includes(withoutPhrases(text, ["state", "tech", "am", "a m"].map((tail) => `${matched} ${tail}`)), matched);
}

// League directories (ESPN's cached team lists) extend the hand-kept aliases so
// a club like UCLA or Kentucky counts as a team. Without them a passing mention
// of a listed team outranked the story's own matchup when picking footage.
const directoryAliases = {};
// Short names that are also ordinary words stay out of the directory aliases.
const commonWords = new Set(["rice", "army", "navy", "liberty", "buffalo", "charlotte", "mercer", "kent", "wagner", "radford", "drake", "brown", "howard", "chicago", "providence", "pacific", "dayton", "towson", "monmouth", "presbyterian", "bryant", "lafayette", "lehigh", "hampton", "campbell", "point", "union", "chowan", "lincoln", "quincy", "concord", "emory", "carroll", "jackson", "jordan"]);
export function useTeamDirectory(sport, records, { pro = false } = {}) {
  if (!sport || !Array.isArray(records)) return;
  const known = new Set((teamAliases[sport] || []).flat());
  const groups = directoryAliases[sport] ||= [];
  for (const groupAliases of groups) for (const alias of groupAliases) known.add(alias);
  for (const record of records) {
    const full = wording(record?.displayName);
    if (full.length < 4 || known.has(full)) continue;
    // "Kentucky Wildcats" less its mascot is "kentucky", the name copy uses.
    const mascot = wording(record.name);
    const place = mascot && full.endsWith(` ${mascot}`) ? full.slice(0, -mascot.length - 1) : "";
    const short = [place, record.shortDisplayName, record.nickname, pro ? record.name : ""].map(wording)
      .filter((alias) => alias.length >= 4 && !commonWords.has(alias) && !genericAlias.has(alias) && !known.has(alias) && !/\b(?:st|u|a m)$/u.test(alias));
    const aliases = [...new Set([full, ...short])];
    for (const alias of aliases) known.add(alias);
    groups.push(aliases);
  }
}
const aliasGroups = (sport, extended) => [...teamAliases[sport] || [], ...(extended ? directoryAliases[sport] || [] : [])];

function mentionedTeams(text, sport, extended = false) {
  const hits = [];
  for (const aliases of aliasGroups(sport, extended)) {
    const matched = aliases.filter((alias) => alias.length >= 3 && !genericAlias.has(alias) && includes(text, alias))
      .sort((a, b) => b.length - a.length)[0];
    if (matched && !matched.includes(" ") && !bareWordStands(text, matched)) continue;
    if (matched) hits.push({ aliases, matched, index: earliestIndex(text, aliases) });
  }
  hits.sort((a, b) => b.matched.length - a.matched.length);
  const picked = [];
  for (const hit of hits) {
    // A shorter name that only occurs inside a longer one stays dropped.
    // "Texas beats Texas A&M" still names both clubs.
    if (!includes(withoutPhrases(text, picked.map((chosen) => chosen.matched)), hit.matched)) continue;
    picked.push(hit);
  }
  return picked;
}

// Teams named in a title, in reading order. The same club in two sports stays one
// entry, with the requested sport first when both matched.
export function teamsInText(text, { sport } = {}) {
  const cleaned = wording(text);
  if (!cleaned) return [];
  const names = Object.keys(teamAliases);
  const order = sport && teamAliases[sport] ? [sport, ...names.filter((name) => name !== sport)] : names;
  const grouped = new Map();
  for (const name of order) {
    for (const hit of mentionedTeams(cleaned, name)) {
      const canonical = hit.aliases[0];
      const index = Number.isFinite(hit.index) ? hit.index : phraseIndex(cleaned, hit.matched);
      const existing = grouped.get(canonical);
      if (!existing) {
        grouped.set(canonical, {
          canonical,
          matched: hit.matched,
          aliases: hit.aliases,
          sports: [name],
          index,
        });
        continue;
      }
      if (!existing.sports.includes(name)) existing.sports.push(name);
      if (index < existing.index) existing.index = index;
      if (hit.matched.length > existing.matched.length) existing.matched = hit.matched;
    }
  }
  const hits = [...grouped.values()].sort((left, right) => right.matched.length - left.matched.length || left.index - right.index);
  const picked = [];
  for (const hit of hits) {
    if (picked.some((chosen) => chosen.canonical === hit.canonical)) continue;
    if (!includes(withoutPhrases(cleaned, picked.map((chosen) => chosen.matched)), hit.matched)) continue;
    picked.push(hit);
  }
  picked.sort((left, right) => left.index - right.index);
  return picked;
}

// The teams a story is about: the ones research tagged and the ones its title
// names. A club the narration only mentions in passing is not one of them.
export function leadTeams(segment) {
  const { teams = [], sport, topicTitle } = segment.footage || {};
  const lead = new Map();
  for (const name of teams.map(wording).filter((name) => name.length >= 2)) {
    const aliases = teamGroup(sport, name) || [name];
    lead.set(aliases[0], { aliases, team: true, lead: true });
  }
  // "ex-St. John's star" names where a player came from, not who the story is about.
  const title = wording(`${topicTitle || ""} ${segment.headline || ""}`);
  for (const { aliases, matched } of mentionedTeams(title, sport, true)) {
    if (new RegExp(`\\b(?:ex|former|formerly)\\s+${matched}\\b`, "u").test(title)) continue;
    if (!lead.has(aliases[0])) lead.set(aliases[0], { aliases, team: true, lead: true });
  }
  return [...lead.values()];
}

// Research sometimes misspells a club ("Memphis Grizzles"). A near miss on the
// full name still finds its group.
function teamGroup(sport, name) {
  const groups = aliasGroups(sport, true);
  const exact = groups.find((group) => group.includes(name));
  if (exact || name.length < 8) return exact;
  const near = groups.filter((group) => editDistance(group[0], name) <= 2);
  return near.length === 1 ? near[0] : null;
}

function editDistance(left, right) {
  if (Math.abs(left.length - right.length) > 2) return 3;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[right.length];
}

// Every team a piece of text names, for the given sport, directories included.
export function namedTeams(text, sport) {
  return mentionedTeams(wording(text), sport, true).map(({ aliases }) => aliases);
}

export function footageSubjects(segment) {
  const { people = [], sport, topicTitle } = segment.footage || {};
  const headline = `${topicTitle || ""} ${segment.headline || ""} ${segment.narration || ""} ${segment.summary || ""}`;
  const names = headline.match(/\b[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,2}\b/gu) || [];
  const subjects = new Map();
  // The story's own teams come first, then teams the copy mentions on the way.
  for (const subject of leadTeams(segment)) subjects.set(subject.aliases[0], subject);
  const text = wording(headline);
  for (const { aliases } of mentionedTeams(text, sport, true)) {
    if (!subjects.has(aliases[0])) subjects.set(aliases[0], { aliases, team: true });
  }
  // "Kentucky Kentucky" is a team name twice over, not a person.
  const teamWords = new Set([...subjects.values()].flatMap(({ aliases }) => aliases.flatMap((alias) => alias.split(" "))));
  for (const name of [...people, ...names].map(wording)) {
    if (!name.includes(" ") || name.length < 7 || [...subjects.values()].some(({ aliases }) => aliases.includes(name))) continue;
    if (name.split(" ").every((word) => teamWords.has(word)) || /^(?:the|in|but|while|is|a|an|and|at) /u.test(name)) continue;
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
  for (const { aliases: [name] } of teams) queries.add(`"${name}"${sport ? ` ${sport}` : ""}`);
  for (const { aliases: [name] } of people) queries.add(`"${name}"${sport ? ` ${sport}` : ""}`);
  for (const term of terms) {
    for (const name of names) queries.add(`"${name}"${sport ? ` ${sport}` : ""} ${term}`);
  }
  return [...queries].slice(0, 18).map((query) => `filetype:video ${query}`);
}

// The owner's own clips for a story. Team clips match a team the story is about
// (or, with none, a team it names). Stock clips cover the sport, then any news.
// The surface's own shape comes first: a vertical clip for a Short.
export function libraryCandidates(segment, surface = "episode") {
  const sport = segment.footage?.sport;
  const lead = leadTeams(segment);
  const teams = lead.length ? lead : footageSubjects(segment).filter(({ team }) => team);
  const own = footageLibrary.filter((item) => !item.stock && item.sport === sport && teams.some(({ aliases }) => aliases.some((alias) => item.teams.includes(alias))))
    .map((item) => ({ ...item, type: "broll", matched: teams.filter(({ aliases }) => aliases.some((alias) => item.teams.includes(alias))) }));
  const shape = surface === "short" ? "portrait" : "landscape";
  const stock = footageLibrary.filter((item) => item.stock && (item.sport === sport || item.sport === "*"))
    .sort((a, b) => (a.sport === "*") - (b.sport === "*") || (b.orientation === shape) - (a.orientation === shape))
    .map((item) => ({ ...item, type: "broll", matched: null }));
  return { own, stock };
}

export function archiveCandidates(segment, allowPreview = false) {
  const subjects = footageSubjects(segment);
  const lead = leadTeams(segment);
  return footageArchive
    .filter((item) => item.sport === segment.footage?.sport && (allowPreview || !item.previewOnly))
    .map((item) => ({
      ...item, type: "broll",
      matched: subjects.filter(({ team, aliases }) => aliases.some((alias) => (team ? item.teams : item.people || []).includes(alias))),
    }))
    // With teams of its own, a story never borrows a clip of a club it only mentions.
    .filter(({ matched }) => matched.length > 0 && (!lead.length || matched.some(({ team, aliases }) => !team || lead.some((club) => club.aliases[0] === aliases[0]))))
    .sort((a, b) => b.matched.some(({ team }) => !team) - a.matched.some(({ team }) => !team) || b.matched.length - a.matched.length);
}

// Never substitute another team's game just to keep a video in the background.
export function sportClip(segment, allowPreview = false) {
  return archiveCandidates(segment, allowPreview)[0] || null;
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
  const contest = /\b(?:vs\.?|versus|v\.)\b/u.test(description);
  const showsPlay = played ? played.test(description) || contest : Object.values(gameplay).some((pattern) => pattern.test(description)) || contest;
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
  if (item.matched?.length) {
    const groups = item.matched.filter(({ team }) => !team);
    const subjects = groups.length ? groups : item.matched;
    return phrases.find(({ text }) => subjects.some(({ aliases }) => aliases.some((alias) => includes(wording(text), alias))))?.start ?? opening;
  }
  if (item.type !== "exact" || !item.title) return opening;
  const title = wording(item.title);
  return phrases.find(({ text }) => actionNames.some((action) => includes(title, action) && includes(wording(text), action)))?.start ?? opening;
}

function allowedLicense(license) {
  const name = String(license || "").trim();
  if (!name || /sa|nc|nd/iu.test(name)) return null;
  if (licenses.has(name)) return licenses.get(name);
  if (/^cc0\b/iu.test(name)) return licenses.get("CC0");
  if (/^cc by 2\.5\b/iu.test(name)) return licenses.get("CC BY 2.5");
  if (/^public domain\b/iu.test(name) || /^pd(?:-|$)/iu.test(name)) return licenses.get("Public domain");
  return null;
}

export function commonsVideo(page, allowPreview = false) {
  const info = page.imageinfo?.[0];
  const video = info && (/^video\/(?:webm|mp4|ogg)$/u.test(info.mime) ||
    (info.mime === "application/ogg" && /\.ogv$/iu.test(page.title)));
  if (!Number.isSafeInteger(page.pageid) || page.pageid <= 0 || !video || !(info.size > 0)) return null;
  const metadata = info.extmetadata || {};
  const field = (name) => plain(metadata[name]?.value);
  const license = field("LicenseShortName");
  const previewOnly = allowPreview && previewLicenses.has(license);
  const licenseUrl = previewOnly ? previewLicenses.get(license) : allowedLicense(license);
  const credit = field("Credit");
  const publicDomain = /^public domain\b/iu.test(license) || /^pd(?:-|$)/iu.test(license);
  // CC BY stays limited to creator-published originals. Public-domain game film
  // is already cleared and often is not marked "own work".
  if (!licenseUrl || field("Restrictions") || broadcastRip.test(`${page.title} ${credit} ${field("ImageDescription")}`)) return null;
  if (!previewOnly && !publicDomain && !/^own work\b/iu.test(credit)) return null;
  const creator = field("Artist");
  if (!creator || !commonsFileTitle(info.descriptionurl)) return null;
  const url = URL.parse(info.url);
  if (!url || url.origin !== "https://upload.wikimedia.org" || !url.pathname.startsWith("/wikipedia/commons/") || url.username || url.password) return null;
  return {
    id: `commons-${page.pageid}`, title: page.title.replace(/^File:/u, "").replace(/\.(?:webm|ogv|mp4|ogg)$/iu, ""),
    description: field("ImageDescription"), categories: field("Categories"), date: field("DateTimeOriginal"),
    creator, sourceUrl: info.descriptionurl, license, licenseUrl, url: url.href,
    ...(info.size > maxBytes && { transcode: true }), ...(previewOnly && { previewOnly }),
  };
}

export class CommonsFootage {
  constructor(directory, fetchImpl = fetch) {
    this.directory = directory;
    this.fetch = fetchImpl;
    this.requests = new Map();
    this.downloads = new Map();
  }

  search(fields, signal, allowPreview = false) {
    const params = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", prop: "imageinfo", iiprop: "url|size|mime|extmetadata",
      iiextmetadatafilter: "Artist|Credit|LicenseShortName|Restrictions|ImageDescription|Categories|DateTimeOriginal", maxlag: "5", ...fields,
    });
    const url = `${commonsOrigin}/w/api.php?${params}`;
    const key = `${url}|${allowPreview}`;
    if (!this.requests.has(key)) this.requests.set(key, (async () => {
      const response = await this.fetch(url, this.options(4500, signal));
      if (!response.ok) return [];
      const result = await response.json();
      return (result.query?.pages || []).map((page) => commonsVideo(page, allowPreview)).filter(Boolean);
    })().catch(() => []));
    return this.requests.get(key);
  }

  options(timeout, signal) {
    const deadline = AbortSignal.timeout(timeout);
    return { headers: { "User-Agent": "WellspringMediaSports/1.0 (Wikimedia Commons attribution shown on air)" },
      redirect: "error", signal: signal ? AbortSignal.any([signal, deadline]) : deadline };
  }

  async candidates(segment, auto, signal, allowPreview = true) {
    const explicit = commonsFileTitle(segment.footage?.clipUrl);
    const results = new Map();
    if (explicit) {
      for (const item of await this.search({ titles: explicit }, signal, allowPreview)) {
        const type = item.previewOnly ? classifyFootage(segment, item) : "exact";
        if (type) results.set(item.id, { ...item, type });
      }
    }
    if (!results.size) {
      const cited = (segment.sources || []).map((source) => commonsFileTitle(source.url)).find(Boolean);
      if (cited) for (const item of await this.search({ titles: cited }, signal)) {
        const type = classifyFootage(segment, item);
        if (type) results.set(item.id, { ...item, type });
      }
    }
    if ([...results.values()].some(({ type }) => type === "exact") || !auto) return [...results.values()];
    const queries = footageQueries(segment).slice(0, 6);
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

  async playbackUrl(item, signal) {
    if (!item.transcode) return item.url;
    const title = commonsFileTitle(item.sourceUrl);
    if (!title) return null;
    const params = new URLSearchParams({
      action: "query", format: "json", formatversion: "2", titles: title, prop: "videoinfo", viprop: "derivatives", maxlag: "5",
    });
    const response = await this.fetch(`${commonsOrigin}/w/api.php?${params}`, this.options(4500, signal));
    if (!response.ok) return null;
    const info = (await response.json()).query?.pages?.[0]?.videoinfo?.[0];
    const duration = Number(info?.duration) || 0;
    const derivatives = (info?.derivatives || []).filter((derivative) => {
      const src = URL.parse(derivative.src || "");
      return src && src.origin === "https://upload.wikimedia.org" && !src.username && !src.password &&
        /webm|mp4/iu.test(`${derivative.transcodekey || ""} ${derivative.type || ""}`);
    }).sort((a, b) => Math.abs((a.width || 0) - 854) - Math.abs((b.width || 0) - 854));
    for (const derivative of derivatives) {
      if ((derivative.width || 0) > 1280) continue;
      const estimate = duration && derivative.bandwidth ? (derivative.bandwidth * duration) / 8 : 0;
      if (estimate > maxBytes) continue;
      return derivative.src;
    }
    return null;
  }

  download(item, signal) {
    if (!this.downloads.has(item.id)) this.downloads.set(item.id, (async () => {
      const url = await this.playbackUrl(item, signal);
      if (!url) return null;
      const response = await this.fetch(url, this.options(12000, signal));
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
