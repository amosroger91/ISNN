import { numbersIn } from "../ledger.mjs";
import { payloadFor } from "./normalize.mjs";

// Scoreboard tiers, highest first. The threes tier only fires when a summary
// has already put the team stat on the game. Fetching a summary for every
// final would break the shortlist cap, so inclusion is decided first.
function tier(game) {
  if (game.status !== "final" || game.score.home === game.score.away) return { rank: 0, name: "none" };
  const margin = Math.abs(game.score.home - game.score.away);
  if (game.overtime) return { rank: 6_000_000 + (1000 - margin), name: "overtime" };
  if (margin <= 3) return { rank: 5_000_000 + (1000 - margin), name: "margin" };
  if (game.upset) return { rank: 4_000_000 + Math.round(game.upsetGap * 1000), name: "upset" };
  const points = game.leaders.find((leader) => Number.isFinite(leader.stats.points))?.stats.points || 0;
  if (points) return { rank: 3_000_000 + points, name: "points" };
  if (game.threes) return { rank: 2_000_000 + game.threes, name: "threes" };
  return { rank: 1_000_000 + (1000 - margin), name: "result" };
}

const pointsLeader = (game) => game.leaders.find((leader) => Number.isFinite(leader.stats.points));

function leaderClaim(game, leader) {
  const parts = [];
  const values = [];
  for (const [key, label] of [["points", "points"], ["rebounds", "rebounds"], ["assists", "assists"]]) {
    if (!Number.isFinite(leader.stats[key])) continue;
    parts.push(`${leader.stats[key]} ${label}`);
    values.push(leader.stats[key]);
  }
  if (!parts.length) return null;
  const listed = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
  return {
    key: `leader:${leader.player}`,
    text: `${leader.player} finished with ${listed}`,
    value: values.length === 1 ? values[0] : values,
    unit: parts.map((part) => part.split(" ").at(-1)).join(", "),
    subject: { player: leader.player, team: leader.team },
    asOf: "final",
    evidence: [{ report: 0, locator: "leaders.points" }],
  };
}

export function composeStory(game) {
  const { home, away, score } = game;
  if (game.status !== "final" || score.home === score.away) return null;
  const homeWon = score.home > score.away;
  const winner = homeWon ? home : away;
  const loser = homeWon ? away : home;
  const winnerScore = homeWon ? score.home : score.away;
  const loserScore = homeWon ? score.away : score.home;
  const unit = game.sport === "baseball" ? "runs" : "points";
  const scoreClaim = {
    key: "final-score",
    text: `On ${game.dateLabel}, the ${winner.name} beat the ${loser.name} ${winnerScore}-${loserScore}`,
    value: [winnerScore, loserScore],
    unit,
    subject: { team: winner.name },
    asOf: "final",
    evidence: [{ report: 0, locator: homeWon ? "score.home" : "score.away" }],
  };
  const leader = game.sport === "basketball" ? pointsLeader(game) : null;
  const leaderLine = leader ? leaderClaim(game, leader) : null;
  const overtime = game.overtime ? " in overtime" : "";
  const narration = [ `${scoreClaim.text}${overtime}.`, leaderLine?.text ].filter(Boolean).join(" ");
  return {
    headline: `${winner.short} ${winnerScore}, ${loser.short} ${loserScore}`,
    narration,
    claims: [scoreClaim, leaderLine].filter(Boolean),
  };
}

// A paraphrase that introduces a number the claims do not license is dropped.
export function keepTemplate(template, paraphrase, licensed) {
  if (!paraphrase?.trim()) return template;
  const extra = numbersIn(paraphrase).filter((number) => !licensed.has(String(number)));
  return extra.length ? template : paraphrase;
}

const SHORTLIST = 4;

export function rankGames(games) {
  for (const game of games) {
    const scored = tier(game);
    game.rank = scored.rank;
    game.tier = scored.name;
    game.story = game.status === "final" ? composeStory(game) : undefined;
    if (game.reports?.[0]) game.reports[0].payload = payloadFor(game);
  }
  const ordered = games.filter((game) => game.story).sort((a, b) => b.rank - a.rank || a.id.localeCompare(b.id));
  const picked = new Set(ordered.slice(0, SHORTLIST).map((game) => game.id));
  for (const game of games) {
    game.included = picked.has(game.id);
    game.shortlist = game.included;
  }
  return games;
}
