// Coverage scope: the leagues the desk covers. NCAA stands for every college
// competition (NCAAF, NCAAB, NCAA Baseball and so on). Set SPORTS_LEAGUES to a
// comma-separated list to change it; the default is the launch scope.
export const DEFAULT_LEAGUES = ["NCAA", "NBA", "MLB"];

// Known leagues, their sport, and the family the scope is checked against.
export const LEAGUES = {
  NBA: { sport: "basketball", family: "NBA" },
  WNBA: { sport: "basketball", family: "WNBA" },
  NCAAB: { sport: "basketball", family: "NCAA", label: "NCAA basketball" },
  NFL: { sport: "football", family: "NFL" },
  NCAAF: { sport: "football", family: "NCAA", label: "NCAA football" },
  MLB: { sport: "baseball", family: "MLB" },
  "NCAA Baseball": { sport: "baseball", family: "NCAA" },
  NHL: { sport: "hockey", family: "NHL" },
  "NCAA Hockey": { sport: "hockey", family: "NCAA" },
  MLS: { sport: "soccer", family: "MLS" },
  NWSL: { sport: "soccer", family: "NWSL" },
  "NCAA Soccer": { sport: "soccer", family: "NCAA" },
};

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
    options: Object.entries(LEAGUES).filter(([, { family }]) => leagues.includes(family)).map(([name, { sport, label }]) => ({ league: name, sport, label: label || name })),
  };
}

export const inScope = (league, scope = coverageScope()) => scope.leagues.includes(leagueFamily(league));
