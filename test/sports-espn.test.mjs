import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { root } from "../server/config.mjs";
import { EvidenceLedger } from "../server/sports/ledger.mjs";
import { scanSlate } from "../server/sports/evidence.mjs";
import { EspnClient, scrubBody, standingsUrl } from "../server/sports/espn/client.mjs";
import { clipsFrom, mapStatus, normalizeEvent } from "../server/sports/espn/normalize.mjs";
import { keepTemplate, rankGames } from "../server/sports/espn/rank.mjs";
import { editionWindow, zonedInstant } from "../server/sports/espn/time.mjs";
import { zonedTime } from "../server/sports/desk.mjs";
import { espnEvidence, espnResponse, loadEspnBodies, lookupEspn } from "./espn-harness.mjs";

const quiet = () => {};

async function cacheDir(t) {
  await import("node:fs/promises").then(({ mkdir }) => mkdir(path.join(root, "data"), { recursive: true }));
  const directory = await mkdtemp(path.join(root, "data", "espn-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("the client fetches once, retries the transient failures, and records a 404 standings miss", async (t) => {
  const directory = await cacheDir(t);
  const calls = [];
  const client = new EspnClient({
    cacheDir: directory, gapMs: 0, backoffMs: 1, retries: 3, log: quiet,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      if (url.endsWith("/flaky")) return calls.filter((call) => call.url.endsWith("/flaky")).length < 3
        ? new Response("no", { status: 503 })
        : Response.json({ ok: true, odds: [{ price: -110 }], links: { mobile: { progressiveDownload: { href: "https://watch.auth.api.espn.com/video/auth/brightcove/example" } } } });
      if (url === standingsUrl("nba", "site")) return new Response("missing", { status: 404 });
      return new Response("missing", { status: 404 });
    },
  });
  assert.equal(standingsUrl("nba", "site"), "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/standings");
  const flaky = await client.get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/flaky");
  assert.equal(calls.filter((call) => call.url.endsWith("/flaky")).length, 3);
  assert.equal(flaky.body.ok, true);
  assert.equal(flaky.body.odds, undefined);
  assert.equal(JSON.stringify(flaky.body).includes("watch.auth"), false);
  assert.equal(calls.at(-1).init.redirect, "manual");
  assert.equal(calls.at(-1).init.headers["User-Agent"], "ISNN-Overtime-Desk");
  const again = await client.get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/flaky");
  assert.equal(again.cached, true);
  assert.equal(calls.filter((call) => call.url.endsWith("/flaky")).length, 3);
  const cached = JSON.parse(await readFile(client.cacheFile(flaky.url), "utf8"));
  assert.equal(JSON.stringify(cached.body).includes("pickcenter") || JSON.stringify(cached.body).includes("odds"), false);

  const before = calls.length;
  const missed = await client.get(standingsUrl("nba", "site"), { optional: true });
  assert.equal(missed.status, 404);
  assert.equal(missed.body, null);
  await client.get(standingsUrl("nba", "site"), { optional: true });
  assert.equal(calls.length, before + 1, "a known-optional 404 is one recorded miss");
  await assert.rejects(client.get("https://watch.auth.api.espn.com/video/auth/brightcove/example"), /Refusing/);
  assert.equal(scrubBody({ odds: [1], keep: 2 }).keep, 2);
});

test("frozen scoreboards normalize the Nuggets final and the Central window", async (t) => {
  assert.equal(zonedInstant("2026-11-16", 8, 0, "America/Chicago"), zonedTime("2026-11-16", 8, "America/Chicago"));
  assert.equal(zonedInstant("2026-07-04", 8, 0, "America/Chicago"), zonedTime("2026-07-04", 8, "America/Chicago"));
  assert.deepEqual(editionWindow("2026-11-15", "America/Chicago"), {
    start: "2026-11-14T12:00:00.000Z", end: "2026-11-15T14:00:00.000Z",
  });
  const bodies = await loadEspnBodies();
  const event = bodies["basketball/nba"][20261114].events.find((item) => item.id === "401909980");
  const game = normalizeEvent(event, "nba");
  assert.equal(game.status, "final");
  assert.deepEqual(game.score, { home: 108, away: 116 });
  assert.equal(game.away.name, "Denver Nuggets");
  assert.equal(game.home.id, "3");
  assert.equal(game.away.id, "7");
  assert.equal(game.gameDate, "2026-11-14");
  assert.equal(game.season, "2026-27");
  assert.equal(game.leaders[0].player, "Nikola Jokic");
  assert.deepEqual(game.leaders[0].stats, { points: 26, rebounds: 8, assists: 10 });
  assert.equal(JSON.stringify(game.reports[0].payload).includes("odds"), false);
  const clips = clipsFrom(event.competitions[0].highlights, game);
  assert.ok(clips.every((clip) => clip.page.startsWith("https://www.espn.com/video/clip")));
  assert.equal(JSON.stringify(clips).includes("watch.auth"), false);
  const foreign = clipsFrom([{ id: "x", headline: "Boston Celtics vs. Chicago Bulls", links: { web: { href: "https://www.espn.com/video/clip/_/id/x" } } }], game);
  assert.equal(foreign.length, 0);
  const live = structuredClone(event);
  live.competitions[0].status.type = { name: "STATUS_IN_PROGRESS", state: "in", completed: false, detail: "Q3" };
  assert.equal(normalizeEvent(live, "nba").status, "in-progress");
  assert.equal(normalizeEvent(live, "nba").story, undefined);
  assert.equal(mapStatus({ name: "STATUS_POSTPONED", state: "pre", detail: "Postponed" }), "postponed");
  assert.equal(mapStatus({ name: "STATUS_DELAYED", state: "pre", detail: "Delayed" }), "in-progress");
  const ranked = rankGames([game, { ...game, id: "later", status: "scheduled", story: undefined, overtime: false, upset: false, leaders: [], score: { home: 0, away: 0 }, threes: 0, reports: game.reports }]);
  assert.equal(ranked.find((item) => item.id === "401909980").included, true);
  assert.equal(ranked.find((item) => item.id === "later").story, undefined);

  const directory = await cacheDir(t);
  const evidence = await espnEvidence({ cacheDir: directory });
  const ledger = new EvidenceLedger();
  const results = await scanSlate(ledger, evidence, { date: "2026-11-15", asOf: "2026-11-15T12:30:00Z", retrievedAt: "2026-11-15T12:30:00Z", timezone: "America/Chicago" });
  assert.equal(results.some((result) => result.gameId === "401909990"), false, "a tip after 8 a.m. Central is outside the edition window");
  const nuggets = results.find((result) => result.gameId === "401909980");
  assert.equal(nuggets.coverage, "covered");
  assert.equal(nuggets.gameDate || nuggets.snapshots[0].payload.gameDate, "2026-11-14");
  assert.notEqual(nuggets.snapshots[0].payload.gameDate, "2026-11-15");
  assert.equal(JSON.stringify(nuggets.snapshots[0].payload).includes("againstTheSpread"), false);
  assert.equal(results.some((result) => result.league === "MLB" && result.coverage === "source unavailable"), false);
  assert.ok(results.filter((result) => result.included && result.coverage === "covered").length <= 4);
  const licensed = new Set(["14", "116", "108", "26", "8", "10", "2026", "27"]);
  assert.equal(keepTemplate(nuggets.story.narration, "Denver won by 9 in a 116-108 final.", licensed), nuggets.story.narration);
  const revision = ledger.lockRevision({
    date: "2026-11-15", revision: 0, at: "2026-11-15T12:30:00Z",
    stories: [{ segmentId: nuggets.gameId, storyId: nuggets.gameId, eventId: nuggets.event.id, headline: nuggets.story.headline, narration: nuggets.story.narration, claimIds: nuggets.story.claimIds }],
  });
  assert.equal(revision.status, "locked");

  const downDir = await cacheDir(t);
  let collegeCalls = 0;
  const down = await espnEvidence({
    cacheDir: downDir,
    fetchImpl: (url) => {
      if (url.includes("mens-college-basketball")) collegeCalls += 1;
      return espnResponse(bodies, url, (candidate) => candidate.includes("mens-college-basketball"));
    },
  });
  const isolated = await scanSlate(new EvidenceLedger(), down, { date: "2026-11-15", asOf: "2026-11-15T12:30:00Z", retrievedAt: "2026-11-15T12:30:00Z" });
  assert.ok(collegeCalls >= 3);
  assert.equal(isolated.find((result) => result.league === "NCAAB").coverage, "source unavailable");
  assert.equal(isolated.find((result) => result.gameId === "401909980").coverage, "covered");
  assert.equal(lookupEspn(bodies, "https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard?dates=20261114").events.length, 0);

  const summaryDir = await cacheDir(t);
  const summaryDown = await espnEvidence({
    cacheDir: summaryDir,
    fetchImpl: (url) => espnResponse(bodies, url, (candidate) => candidate.includes("/summary")),
  });
  const withheld = await scanSlate(new EvidenceLedger(), summaryDown, { date: "2026-11-15", asOf: "2026-11-15T12:30:00Z", retrievedAt: "2026-11-15T12:30:00Z" });
  const blocked = withheld.filter((result) => result.reason?.startsWith("The summary did not load"));
  assert.ok(blocked.length >= 1 && blocked.every((result) => result.coverage === "awaiting verification"));
  assert.ok(withheld.some((result) => result.coverage === "covered"), "a scoreboard row still pitches when its summary was not requested");
});
