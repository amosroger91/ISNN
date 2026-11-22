// Coverage scope: the leagues the desk covers. NCAA stands for every college
// competition (NCAAF, NCAAB, NCAA Baseball and so on). Set SPORTS_LEAGUES to a
// comma-separated list to change it; the default is the launch scope.
export const DEFAULT_LEAGUES = ["NCAA", "NBA", "MLB", "UFC"];
export const OTHER_NEWS = "Other news";

// Known leagues, their sport, and the family the scope is checked against.
export const LEAGUES = {
  [OTHER_NEWS]: { sport: "other", family: "OTHER", label: OTHER_NEWS },
  NBA: { sport: "basketball", family: "NBA" },
  WNBA: { sport: "basketball", family: "WNBA" },
  NCAAB: { sport: "basketball", family: "NCAA", label: "NCAA basketball" },
  NCAAW: { sport: "basketball", family: "NCAA", label: "NCAA women's basketball" },
  NFL: { sport: "football", family: "NFL" },
  NCAAF: { sport: "football", family: "NCAA", label: "NCAA football" },
  MLB: { sport: "baseball", family: "MLB" },
  "NCAA Baseball": { sport: "baseball", family: "NCAA" },
  NHL: { sport: "hockey", family: "NHL" },
  "NCAA Hockey": { sport: "hockey", family: "NCAA" },
  MLS: { sport: "soccer", family: "MLS" },
  NWSL: { sport: "soccer", family: "NWSL" },
  "NCAA Soccer": { sport: "soccer", family: "NCAA" },
  UFC: { sport: "mma", family: "UFC" },
};

// These leagues contribute one candidate within the daily twenty-story shortlist.
export const SINGLE_STORY_FAMILIES = new Set(["UFC"]);
export const optInFamily = (league) => SINGLE_STORY_FAMILIES.has(leagueFamily(league));

export const leagueFamily = (league) => {
  if (!league) return null;
  const name = String(league).trim();
  if (/^ncaa\b/iu.test(name) || /\bcollege\b/iu.test(name)) return "NCAA";
  return LEAGUES[name]?.family || name.toUpperCase();
};

export function coverageScope(env = process.env) {
  const configured = (env.SPORTS_LEAGUES || "").split(",").map((item) => item.trim()).filter(Boolean);
  const leagues = [...new Set((configured.length ? configured : DEFAULT_LEAGUES).map(leagueFamily))];
  return {
    leagues,
    label: leagues.join(", "),
    options: Object.entries(LEAGUES).filter(([, { family }]) => family === "OTHER" || leagues.includes(family)).map(([name, { sport, label }]) => ({ league: name, sport, label: label || name })),
  };
}

export const inScope = (league, scope = coverageScope()) => leagueFamily(league) === "OTHER" || scope.leagues.includes(leagueFamily(league));

// Puts stories from the same league family next to each other, in the order
// each family first appears, so the lead story still leads.
export function groupByLeague(items, leagueOf = (item) => item.league) {
  const order = [...new Set(items.map((item) => leagueFamily(leagueOf(item))))];
  return order.flatMap((family) => items.filter((item) => leagueFamily(leagueOf(item)) === family));
}

// How the announcer names a block of stories: the roll call in the opening
// ("the NBA") and the bumper before the block ("the NBA news").
const SPOKEN = {
  NBA: ["the NBA", "NBA"], WNBA: ["the WNBA", "WNBA"], MLB: ["Major League Baseball", "MLB"], NFL: ["the NFL", "NFL"],
  NHL: ["the NHL", "NHL"], MLS: ["MLS", "MLS"], NWSL: ["the NWSL", "NWSL"], UFC: ["the UFC", "UFC"],
};
export function sportName(leagues) {
  const family = leagueFamily(leagues[0]);
  if (family === "OTHER") return { spoken: "other news", news: "other" };
  if (family === "NCAA") {
    const sports = [...new Set(leagues.map((league) => LEAGUES[league]?.sport || (/football/iu.test(league) ? "football" : /basketball/iu.test(league) ? "basketball" : null)))];
    const name = sports.length === 1 && sports[0] ? `college ${sports[0]}` : "college sports";
    return { spoken: name, news: name };
  }
  const [spoken, news] = SPOKEN[family] || [family, family];
  return { spoken, news };
}
