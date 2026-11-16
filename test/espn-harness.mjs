import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EspnClient } from "../server/sports/espn/client.mjs";
import { EspnEvidenceAdapter } from "../server/sports/espn/adapter.mjs";

const directory = fileURLToPath(new URL("./fixtures/espn/", import.meta.url));
const quiet = () => {};

const read = (name) => readFile(path.join(directory, name), "utf8").then(JSON.parse);

let bodiesPromise;
export function loadEspnBodies() {
  bodiesPromise ||= (async () => {
    const [nba14, nba15, nba16, ncaab, ncaaw, ncaaf, mlb, summary] = await Promise.all([
      read("nba-scoreboard-20261114.json"), read("nba-scoreboard-20261115.json"), read("nba-scoreboard-20261116.json"),
      read("ncaab-scoreboard-20261114.json"), read("ncaaw-scoreboard-20261114.json"), read("ncaaf-scoreboard-20261114.json"),
      read("mlb-scoreboard-20261114.json"), read("nba-summary-401909980.json"),
    ]);
    return {
      "basketball/nba": { 20261114: nba14, 20261115: nba15, 20261116: nba16 },
      "basketball/mens-college-basketball": { 20261114: ncaab },
      "basketball/womens-college-basketball": { 20261114: ncaaw },
      "football/college-football": { 20261114: ncaaf },
      "baseball/mlb": { 20261114: mlb, 20261115: mlb, 20261116: mlb },
      summary,
    };
  })();
  return bodiesPromise;
}

const emptySummary = { header: { competitions: [{ status: { type: { state: "post" } } }] }, plays: [], videos: [] };

export function lookupEspn(bodies, url) {
  const parsed = new URL(url);
  const summaryId = parsed.searchParams.get("event");
  if (parsed.pathname.endsWith("/summary")) return summaryId === "401909980" ? bodies.summary : emptySummary;
  const date = parsed.searchParams.get("dates");
  const sport = Object.keys(bodies).find((key) => key !== "summary" && parsed.pathname.includes(`/${key}/scoreboard`));
  if (!sport) return undefined;
  if (sport === "baseball/mlb") return bodies[sport][date] || bodies[sport][20261114];
  return bodies[sport][date];
}

export function espnResponse(bodies, url, fail) {
  if (fail?.(url)) return new Response("down", { status: 500 });
  const body = lookupEspn(bodies, url);
  if (body === undefined) return new Response("missing", { status: 404 });
  return Response.json(body);
}

export async function espnEvidence({ cacheDir, leagues, fetchImpl, fail, assets = null } = {}) {
  const bodies = await loadEspnBodies();
  const client = new EspnClient({
    cacheDir, gapMs: 0, backoffMs: 1, retries: fail ? 3 : 1, log: quiet,
    ...(fetchImpl || fail
      ? { fetchImpl: fetchImpl || ((url) => espnResponse(bodies, url, fail)) }
      : { fixtures: (url) => lookupEspn(bodies, url) }),
  });
  return new EspnEvidenceAdapter({ client, leagues, timezone: "America/Chicago", log: quiet, assets });
}
