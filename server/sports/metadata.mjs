import { footageSubjects } from "./footage.mjs";
import { leagueFamily, sportName } from "./scope.mjs";
import { cleanThumbnailLine, thumbnailAllowed } from "./thumbnail.mjs";

// YouTube listings for one edition: a title, a description and hashtags for
// the episode and for every Short, each one different. The model writes the
// titles and descriptions from the aired copy; anything it gets wrong (a
// number not in the copy, a repeated title, an empty field) falls back to
// copy built from the headlines. Hashtags come from the stories' leagues and
// teams, plus a few topic tags the model suggests.

const TITLE_LIMIT = 100;
const SHORT_HOOK = 80;
// The written hook; youtube.mjs caps the whole description.
const DESCRIPTION_LIMIT = 280;
const MAX_HASHTAGS = 8;
const SHOW_TAG = "#WellspringMediaSports";
const LEAGUE_TAGS = {
  "Other news": ["#News"],
  NBA: ["#NBA", "#Basketball"], WNBA: ["#WNBA", "#Basketball"], MLB: ["#MLB", "#Baseball"], NFL: ["#NFL", "#Football"],
  NHL: ["#NHL", "#Hockey"], MLS: ["#MLS", "#Soccer"], NWSL: ["#NWSL", "#Soccer"],
  NCAAF: ["#CollegeFootball", "#CFB"], NCAAB: ["#CollegeBasketball", "#MarchMadness"], NCAAW: ["#WBB", "#CollegeBasketball"],
  UFC: ["#UFC", "#MMA"],
  "NCAA Baseball": ["#CollegeBaseball"], "NCAA Hockey": ["#CollegeHockey"], "NCAA Soccer": ["#CollegeSoccer"],
};

const clean = (value) => String(value ?? "").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();
const clip = (text, limit) => {
  const characters = Array.from(clean(text));
  if (characters.length <= limit) return characters.join("");
  const cut = characters.slice(0, limit - 1).join("");
  return `${cut.replace(/\s+\S*$/u, "") || cut}…`;
};
const sentences = (text) => clean(text).split(/(?<=[.!?])\s+(?=[A-Z"“])/u).filter(Boolean);
const numbers = (text) => String(text).match(/\d+(?:[.,]\d+)?/g) || [];
const shortDate = (date) => /^\d{4}-\d{2}-\d{2}$/.test(date || "")
  ? new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`))
  : "";

// "#MiamiHeat" from "Miami Heat"; letters and digits only.
export function hashtag(text) {
  const words = clean(text).normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[’']/g, "").split(/[^A-Za-z0-9]+/).filter(Boolean);
  const tag = words.map((word) => word[0].toUpperCase() + word.slice(1)).join("");
  return /^[A-Za-z][A-Za-z0-9]{1,29}$/.test(tag) ? `#${tag}` : null;
}

function uniqueTags(tags) {
  const seen = new Set();
  return tags.filter((tag) => tag && !seen.has(tag.toLowerCase()) && seen.add(tag.toLowerCase())).slice(0, MAX_HASHTAGS);
}

const teamsOf = (segment) => segment.footage?.teams || segment.teams || [];

// The first footage subject (teams before people) plus the headline's first
// number, otherwise the headline's opening clause in at most four words.
function fallbackThumbnail(segment) {
  if (!segment) return "SPORTS RUNDOWN";
  const subject = footageSubjects(segment)[0];
  const headline = clean(segment?.headline);
  const clause = headline.split(/\s+(?:while|amid|after|as|despite)\s+|;\s+/iu)[0] || headline;
  const headlineWords = cleanThumbnailLine(clause).split(" ").filter(Boolean);
  const firstNumber = (headline.match(/(?:^|\s)\$?(\d+(?:[.,]\d+)?)(?=\s|$)/u) || [])[1] || "";
  if (subject) {
    const name = subject.aliases[0].toUpperCase().split(" ").filter(Boolean);
    if (firstNumber) return [...name, firstNumber].slice(0, 4).join(" ");
    if (name.length >= 2) return name.slice(0, 4).join(" ");
    const padded = [...name, ...headlineWords.filter((word) => word !== name[0])].slice(0, 4);
    if (padded.length >= 2) return padded.join(" ");
  }
  if (headlineWords.length >= 2) return headlineWords.slice(0, 4).join(" ");
  if (headlineWords.length === 1) return `${headlineWords[0]} RUNDOWN`;
  return "SPORTS RUNDOWN";
}

function claimThumbnail(line, used) {
  const key = String(line || "").toLowerCase();
  if (!key || used.has(key)) return false;
  used.add(key);
  return true;
}

function thumbnailFor(segment, draftLine, source, used) {
  const fallbackLine = fallbackThumbnail(segment);
  const draft = cleanThumbnailLine(draftLine);
  if (thumbnailAllowed(draft, source) && claimThumbnail(draft, used)) return draft;
  if (thumbnailAllowed(fallbackLine, source) && claimThumbnail(fallbackLine, used)) return fallbackLine;
  const base = (thumbnailAllowed(fallbackLine, source) ? fallbackLine : cleanThumbnailLine(segment?.headline))
    .split(" ").filter(Boolean);
  const headlineWords = cleanThumbnailLine(segment?.headline).split(" ").filter(Boolean);
  for (const word of headlineWords) {
    if (base.some((item) => item.toLowerCase() === word.toLowerCase())) continue;
    if (/\d/u.test(word) && !thumbnailAllowed(`TEAM ${word}`, source)) continue;
    const candidate = [...base.slice(0, 3), word].slice(0, 4).join(" ");
    if (thumbnailAllowed(candidate, source) && claimThumbnail(candidate, used)) return candidate;
  }
  for (let size = Math.min(4, headlineWords.length); size >= 2; size -= 1) {
    for (let start = 0; start <= headlineWords.length - size; start += 1) {
      const candidate = headlineWords.slice(start, start + size).join(" ");
      if (thumbnailAllowed(candidate, source) && claimThumbnail(candidate, used)) return candidate;
    }
  }
  if (claimThumbnail("SPORTS RUNDOWN", used)) return "SPORTS RUNDOWN";
  const spare = headlineWords.find((word) => thumbnailAllowed(`SPORTS ${word}`, source) && !used.has(`sports ${word.toLowerCase()}`));
  if (spare && claimThumbnail(`SPORTS ${spare}`, used)) return `SPORTS ${spare}`;
  return fallbackLine;
}

export function hashtagsFor(segments, { short = false, extra = [] } = {}) {
  const leagues = [...new Set(segments.map(({ league }) => league).filter(Boolean))];
  const leagueTags = leagues.flatMap((league) => LEAGUE_TAGS[league] || [hashtag(league)]);
  const teams = segments.flatMap(teamsOf).map(hashtag);
  const topics = extra.map(hashtag);
  if (short) return uniqueTags(["#Shorts", ...leagueTags.slice(0, 2), ...teams.slice(0, 2), ...topics.slice(0, 2), SHOW_TAG]);
  // The episode: one tag per league, so the show's own tags always fit.
  const primary = leagues.map((league) => (LEAGUE_TAGS[league] || [hashtag(league)])[0]);
  return uniqueTags([...primary.slice(0, 4), SHOW_TAG, segments.some(({ league }) => leagueFamily(league) !== "OTHER") ? "#SportsNews" : "#News", ...topics.slice(0, 2)]);
}

// Built from the headlines alone: always factual, always available.
export function fallbackListing(episode) {
  const stories = episode.segments.map((segment, index) => ({ segment, number: index + 1 }));
  const leads = [];
  for (const { segment } of stories) {
    const family = leagueFamily(segment.league);
    if (leads.some((lead) => leagueFamily(lead.league) === family && family)) continue;
    leads.push(segment);
  }
  const when = shortDate(episode.date);
  const suffix = when ? ` | The Rundown, ${when}` : " | The Rundown";
  // Whole clauses of the lead headlines, as many as fit, never cut mid-phrase.
  const room = TITLE_LIMIT - Array.from(suffix).length;
  const clauses = leads.map(({ headline }) => clean(headline).split(/\s+(?:while|amid|after|as|despite)\s+|;\s+/iu)[0]);
  let hook = "";
  for (const clause of clauses.slice(0, 3)) {
    const next = hook ? `${hook}, ${clause}` : clause;
    if (Array.from(next).length > room) break;
    hook = next;
  }
  hook ||= clip(clauses[0] || "The morning sports rundown", room);
  const sports = [];
  for (const { segment } of stories) {
    const name = segment.league && sportName([segment.league]).spoken;
    if (name && !sports.includes(name)) sports.push(name);
  }
  const usedThumbs = new Set();
  const episodeCopy = episode.segments.map(({ headline, narration }) => `${headline} ${narration}`).join(" ");
  const episodeThumbnail = thumbnailFor(episode.segments[0], "", episodeCopy, usedThumbs);
  return {
    episode: {
      title: `${hook}${suffix}`,
      description: [
        `Isaac Doss runs through the morning's ${stories.some(({ segment }) => leagueFamily(segment.league) === "OTHER") ? "news" : "sports news"}${sports.length ? `: ${sports.length < 3 ? sports.join(" and ") : `${sports.slice(0, -1).join(", ")}, and ${sports.at(-1)}`}` : ""}.`,
        stories.map(({ segment }) => `• ${clean(segment.headline)}`).join("\n"),
      ].join("\n\n"),
      hashtags: hashtagsFor(episode.segments),
      thumbnail: episodeThumbnail,
    },
    shorts: stories.map(({ segment, number }) => {
      // The aired copy's opening is already checked against the evidence.
      const opening = sentences(segment.narration).slice(0, 2).join(" ");
      const copy = `${segment.headline} ${segment.narration}`;
      return {
        segment: number,
        title: clip(segment.headline || `Story ${number}`, SHORT_HOOK),
        description: clip(opening, 400) || clean(segment.headline),
        hashtags: hashtagsFor([segment], { short: true }),
        thumbnail: thumbnailFor(segment, "", copy, usedThumbs),
      };
    }),
  };
}

// Merges the model's drafts over the fallback, one field at a time.
export function finishListing(episode, drafts) {
  const fallback = fallbackListing(episode);
  const allCopy = episode.segments.map(({ headline, narration }) => `${headline} ${narration}`).join(" ");
  const licensed = (text, source) => numbers(text).every((number) => numbers(source).includes(number));
  const when = shortDate(episode.date);
  const suffix = when ? ` | The Rundown, ${when}` : " | The Rundown";
  const usedTitles = new Set();
  const pick = (text, limit, source, fallbackText) => {
    const value = clean(text);
    return value && licensed(value, source) ? clip(value, limit) : fallbackText;
  };
  const uniqueTitle = (title, alternative) => {
    for (const candidate of [title, alternative, `${alternative} (${usedTitles.size + 1})`]) {
      if (candidate && !usedTitles.has(candidate.toLowerCase())) {
        usedTitles.add(candidate.toLowerCase());
        return candidate;
      }
    }
    return alternative;
  };

  const draftEpisode = drafts?.episode || {};
  const hook = pick(draftEpisode.title, TITLE_LIMIT - Array.from(suffix).length, allCopy, null);
  const usedThumbs = new Set();
  const episodeListing = {
    title: uniqueTitle(hook ? `${hook}${suffix}` : null, fallback.episode.title),
    description: draftEpisode.description && licensed(draftEpisode.description, allCopy)
      // The chapters already list every headline under the hook.
      ? clip(sentences(draftEpisode.description).slice(0, 3).join(" "), DESCRIPTION_LIMIT)
      : fallback.episode.description,
    hashtags: hashtagsFor(episode.segments, { extra: draftEpisode.topics || [] }),
    thumbnail: thumbnailFor(episode.segments[0], draftEpisode.thumbnail, allCopy, usedThumbs),
  };
  const shorts = episode.segments.map((segment, index) => {
    const draft = drafts?.shorts?.find(({ number }) => number === index + 1) || {};
    const base = fallback.shorts[index];
    const copy = `${segment.headline} ${segment.narration}`;
    const title = pick(draft.title, SHORT_HOOK, copy, null);
    return {
      segment: index + 1,
      title: uniqueTitle(title, base.title),
      description: pick(draft.description, DESCRIPTION_LIMIT, copy, base.description),
      hashtags: hashtagsFor([segment], { short: true, extra: draft.topics || [] }),
      thumbnail: thumbnailFor(segment, draft.thumbnail, copy, usedThumbs),
    };
  });
  return { episode: episodeListing, shorts, written: Boolean(drafts) };
}

// A title with its hashtags appended when they fit (Shorts only), and the
// keyword tags YouTube takes alongside the description.
export function titleWithTags(title, hashtags, { short = false } = {}) {
  if (!short) return clip(title, TITLE_LIMIT);
  const tags = hashtags.filter((tag) => tag === "#Shorts" || Object.values(LEAGUE_TAGS).some((list) => list[0] === tag)).slice(0, 2);
  const withTags = `${clean(title)} ${tags.join(" ")}`.trim();
  return Array.from(withTags).length <= TITLE_LIMIT ? withTags : clip(title, TITLE_LIMIT);
}

export function keywordTags(hashtags, segments) {
  const words = [...hashtags.map((tag) => tag.slice(1).replace(/([a-z])([A-Z])/g, "$1 $2")), ...segments.flatMap(teamsOf), "Wellspring Media Sports", "Isaac Doss"];
  const tags = [];
  let length = 0;
  for (const word of words.map(clean).filter(Boolean)) {
    if (tags.some((tag) => tag.toLowerCase() === word.toLowerCase())) continue;
    if (length + word.length + 1 > 450) break;
    tags.push(word);
    length += word.length + 1;
  }
  return tags;
}
