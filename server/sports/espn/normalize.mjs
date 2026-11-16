import { LEAGUES, safeImageUrl } from "./client.mjs";
import { calendarDate, calendarLabel } from "./time.mjs";

const REGULATION = { basketball: 4, football: 4, baseball: 9, hockey: 3, soccer: 2 };
const PAGE = {
  nba: "nba",
  ncaab: "mens-college-basketball",
  ncaaw: "womens-college-basketball",
  ncaaf: "college-football",
  mlb: "mlb",
  nfl: "nfl",
  nhl: "nhl",
  wnba: "wnba",
};

// STATUS_FINAL is the verified name. POSTPONED and CANCELED were not on the
// captured boards; a name containing either maps to postponed. Anything else
// that is not pre or post stays in progress so the scan withholds the result.
export function mapStatus(type = {}) {
  const name = String(type.name || "");
  const detail = `${type.detail || ""} ${type.description || ""} ${name}`;
  if (/POSTPONED|CANCELED|CANCELLED/i.test(detail)) return "postponed";
  if (type.state === "post" || type.completed === true || name === "STATUS_FINAL") return "final";
  if (type.state === "in" || name === "STATUS_IN_PROGRESS") return "in-progress";
  if (name === "STATUS_SCHEDULED") return "scheduled";
  return "in-progress";
}

const hexColor = (value) => /^[0-9a-f]{6}$/i.test(value || "") ? `#${value}` : null;

const winPct = (summary) => {
  const match = /^(\d+)-(\d+)$/u.exec(summary || "");
  if (!match) return null;
  const total = Number(match[1]) + Number(match[2]);
  return total ? Number(match[1]) / total : null;
};

function side(competitor, sport) {
  const team = competitor.team || {};
  const lines = Array.isArray(competitor.linescores) ? competitor.linescores : [];
  let running = 0;
  const periods = lines.map((line) => {
    running += Number(line.value) || 0;
    return running;
  });
  return {
    id: String(team.id || team.abbreviation || "team"),
    name: team.displayName || team.name || team.abbreviation || "Team",
    short: team.abbreviation || team.shortDisplayName || "TBD",
    score: Number(competitor.score) || periods.at(-1) || 0,
    periods,
    color: hexColor(team.color),
    record: (competitor.records || []).find((record) => record.type === "total")?.summary || null,
    leaders: competitor.leaders || [],
    homeAway: competitor.homeAway,
    sport,
  };
}

function leadersFrom(competitors) {
  const byPlayer = new Map();
  for (const competitor of competitors) {
    for (const category of competitor.leaders || []) {
      const top = category.leaders?.[0];
      const name = top?.athlete?.displayName;
      if (!name || !category.name || !Number.isFinite(top.value)) continue;
      const key = top.athlete.id || name;
      const current = byPlayer.get(key) || {
        player: name,
        ...(top.athlete.id && { playerId: String(top.athlete.id) }),
        team: competitor.name,
        stats: {},
      };
      const shot = safeImageUrl(top.athlete.headshot?.href);
      if (shot) current.headshot = shot;
      current.stats[category.name] = top.value;
      byPlayer.set(key, current);
    }
  }
  return [...byPlayer.values()].sort((a, b) => (b.stats.points || 0) - (a.stats.points || 0));
}

const seasonName = (season) => {
  const year = Number(season?.year);
  if (!year) return "";
  return `${year - 1}-${String(year).slice(-2)}`;
};

export function boxScoreUrl(leagueKey, eventId) {
  const page = PAGE[leagueKey] || leagueKey;
  return `https://www.espn.com/${page}/boxscore/_/gameId/${eventId}`;
}

const publicPage = (clip) => {
  const href = clip?.links?.web?.href || (Array.isArray(clip?.links) ? clip.links.find((link) => link.rel === "web" || link.rel?.includes?.("web"))?.href : null);
  if (typeof href === "string") {
    try {
      const url = new URL(href);
      if (url.hostname === "www.espn.com" || url.hostname === "espn.com") return href;
    } catch {
      // Fall through to the public clip page built from the id.
    }
  }
  return clip?.id ? `https://www.espn.com/video/clip/_/id/${clip.id}` : null;
};

const thumbnailOf = (clip) => {
  if (typeof clip?.thumbnail === "string") return clip.thumbnail;
  return clip?.thumbnail?.href || null;
};

const mentions = (headline, game) => {
  const text = headline.toLowerCase();
  return [game.home.name, game.away.name, game.home.short, game.away.short]
    .filter((name) => name && name.length >= 3)
    .some((name) => text.includes(name.toLowerCase()));
};

// A highlight that reads as a different game is dropped. A player highlight
// that names neither club stays, because it arrived on this event.
const clipBelongs = (headline, game) => {
  if (mentions(headline, game)) return true;
  return !/\bvs\.?\b|\bat\b|@/u.test(headline);
};

export function clipsFrom(list, game) {
  const clips = [];
  const seen = new Set();
  for (const clip of list || []) {
    const headline = clip?.headline || clip?.description;
    if (!headline || !clipBelongs(headline, game)) continue;
    const page = publicPage(clip);
    if (!page) continue;
    const id = String(clip.id || page);
    if (seen.has(id)) continue;
    seen.add(id);
    const geo = clip.geoRestrictions?.countries || clip.geoRestrictions || [];
    clips.push({
      id, eventId: game.id, headline, duration: Number.isFinite(clip.duration) ? clip.duration : null,
      thumbnail: thumbnailOf(clip), page, geo: Array.isArray(geo) ? geo : [],
      embargo: clip.timeRestrictions?.embargoDate || null, expiration: clip.timeRestrictions?.expirationDate || null,
      source: "espn",
    });
  }
  return clips;
}

export function scoringPlays(summary) {
  return (summary?.plays || []).filter((play) => play?.scoringPlay && play.text).slice(0, 24).map((play) => ({
    period: play.period?.number ?? play.period ?? "",
    clock: play.clock?.displayValue || String(play.clock?.displayValue || play.clock || ""),
    description: play.text,
    team: play.team?.abbreviation || play.team?.id || null,
    player: play.participants?.find((person) => person.athlete?.displayName)?.athlete?.displayName || null,
    home: Number(play.homeScore) || 0,
    away: Number(play.awayScore) || 0,
    at: play.wallclock || null,
  }));
}

export function teamThrees(summary) {
  let best = 0;
  for (const team of summary?.boxscore?.teams || []) {
    const stat = (team.statistics || []).find((item) => String(item.name || "").startsWith("threePointFieldGoalsMade"));
    const made = Number(String(stat?.displayValue || "").split("-")[0]);
    if (Number.isFinite(made)) best = Math.max(best, made);
  }
  return best;
}

export function normalizeEvent(event, leagueKey, timezone = "America/Chicago") {
  const league = LEAGUES[leagueKey];
  if (!league || !event?.id) return null;
  const competition = event.competitions?.[0];
  const competitors = (competition?.competitors || []).map((item) => side(item));
  const home = competitors.find((item) => item.homeAway === "home");
  const away = competitors.find((item) => item.homeAway === "away");
  if (!home || !away) return null;
  const statusType = competition?.status?.type || event.status?.type || {};
  const status = mapStatus(statusType);
  const period = Number(competition?.status?.period) || home.periods.length || away.periods.length || 0;
  const detail = `${statusType.detail || ""} ${statusType.shortDetail || ""}`;
  const regulation = REGULATION[league.sport] || 4;
  const overtime = /\/OT|overtime/i.test(detail) || (status === "final" && period > regulation);
  const startTime = competition?.date || event.date;
  const gameDate = calendarDate(startTime, timezone);
  const lengths = Math.max(home.periods.length, away.periods.length);
  const scoreStates = lengths
    ? Array.from({ length: lengths }, (_, index) => ({ period: index + 1, home: home.periods[index] ?? home.periods.at(-1) ?? home.score, away: away.periods[index] ?? away.periods.at(-1) ?? away.score }))
    : [{ period: status === "final" ? "final" : 0, home: home.score, away: away.score }];
  const homePct = winPct(home.record);
  const awayPct = winPct(away.record);
  const winnerSide = home.score === away.score ? null : home.score > away.score ? "home" : "away";
  const upset = status === "final" && winnerSide && homePct != null && awayPct != null
    ? (winnerSide === "home" ? homePct < awayPct : awayPct < homePct)
    : false;
  const upsetGap = upset ? Math.abs(homePct - awayPct) : 0;
  const leaders = leadersFrom([home, away]);
  const season = seasonName(event.season);
  const slug = String(event.season?.slug || "season").replaceAll("-", " ");
  const game = {
    id: String(event.id),
    leagueKey,
    league: league.league,
    sport: league.sport,
    competition: `${league.competition} ${slug}`.trim(),
    season,
    home: { id: home.id, name: home.name, short: home.short, ...(home.color && { color: home.color }) },
    away: { id: away.id, name: away.name, short: away.short, ...(away.color && { color: away.color }) },
    startTime,
    gameDate,
    dateLabel: calendarLabel(startTime, timezone),
    status,
    overtime,
    score: { home: home.score, away: away.score },
    scoreStates,
    plays: [],
    leaders,
    upset,
    upsetGap,
    threes: 0,
    discovery: [],
  };
  game.discovery = clipsFrom(competition?.highlights, game);
  game.reports = [reportFor(game)];
  return game;
}

function reportFor(game) {
  const { home, away, score } = game;
  return {
    provider: "espn",
    originGroup: `espn-${game.league}`,
    kind: "boxscore",
    url: boxScoreUrl(game.leagueKey, game.id),
    sourceTime: game.startTime,
    title: `${away.name} at ${home.name} box score`,
    excerpt: `${away.name} ${score.away}, ${home.name} ${score.home}.`,
    payload: payloadFor(game),
  };
}

export function payloadFor(game) {
  return {
    id: game.id,
    league: game.league,
    sport: game.sport,
    competition: game.competition,
    season: game.season,
    gameDate: game.gameDate,
    startTime: game.startTime,
    status: game.status,
    overtime: game.overtime,
    home: game.home,
    away: game.away,
    score: game.score,
    leaders: game.leaders.map(({ player, team, stats }) => ({ player, team, stats })),
    scoreStates: game.scoreStates,
  };
}

function attachHeadshots(game, summary) {
  const shots = new Map();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const athlete = node.headshot ? node : node.athlete;
    const href = safeImageUrl(athlete?.headshot?.href);
    if (athlete?.id && href) shots.set(String(athlete.id), href);
    for (const value of Object.values(node)) {
      if (value && typeof value === "object") visit(value);
    }
  };
  visit(summary);
  for (const leader of game.leaders || []) {
    const href = leader.playerId && shots.get(leader.playerId);
    if (href) leader.headshot = href;
  }
}

export function applySummary(game, summary) {
  if (!summary || typeof summary !== "object") return game;
  attachHeadshots(game, summary);
  const plays = scoringPlays(summary);
  if (plays.length) game.plays = plays;
  const threes = teamThrees(summary);
  if (threes) game.threes = threes;
  const clips = clipsFrom(summary.videos, game);
  if (clips.length) {
    const seen = new Set(game.discovery.map((clip) => clip.id));
    game.discovery = [...game.discovery, ...clips.filter((clip) => !seen.has(clip.id))];
  }
  game.reports = [reportFor(game)];
  return game;
}
