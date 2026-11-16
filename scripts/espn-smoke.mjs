// Manual, read-only check of ESPN's public scoreboard: lists yesterday's games
// (Central) for one league and exits. Writes no edition, renders nothing,
// uploads nothing, and caches into a throwaway folder.
//
//   npm run espn:smoke                 NBA, yesterday in America/Chicago
//   npm run espn:smoke -- --league ncaab --date 2026-11-14
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { EspnClient, LEAGUES } from "../server/sports/espn/client.mjs";
import { calendarDate, shiftDate } from "../server/sports/espn/time.mjs";

const timezone = process.env.SPORTS_TIMEZONE || "America/Chicago";
const { values } = parseArgs({ options: { league: { type: "string", default: "nba" }, date: { type: "string" } } });
if (!LEAGUES[values.league]) {
  console.error(`Unknown league ${values.league}. Known: ${Object.keys(LEAGUES).join(", ")}.`);
  process.exit(1);
}
const date = values.date || shiftDate(calendarDate(new Date().toISOString(), timezone), -1);
const cacheDir = await mkdtemp(path.join(os.tmpdir(), "espn-smoke-"));
const client = new EspnClient({ cacheDir, log: () => {} });
try {
  const board = await client.scoreboard(values.league, date);
  const events = board?.events || [];
  console.log(`${LEAGUES[values.league].league} scoreboard for ${date}: ${events.length} event${events.length === 1 ? "" : "s"}`);
  for (const event of events) {
    const competition = event.competitions?.[0] || {};
    const status = competition.status?.type || {};
    const line = (competition.competitors || []).map((team) => `${team.team?.abbreviation || "?"} ${team.score ?? ""}${team.winner ? "*" : ""}`).join(" · ");
    console.log(`  ${event.id}  ${event.shortName.padEnd(14)} ${String(status.name || "").padEnd(18)} ${status.detail || ""}  ${line}`);
  }
  const finals = events.filter((event) => event.competitions?.[0]?.status?.type?.state === "post").length;
  console.log(`Finals: ${finals}. Not final: ${events.length - finals}.`);
} finally {
  await rm(cacheDir, { recursive: true, force: true });
}
