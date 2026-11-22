import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { root } from "../server/config.mjs";
import { SportsDesk, zonedTime } from "../server/sports/desk.mjs";
import { FixtureEvidenceAdapter } from "../server/sports/evidence.mjs";
import { espnEvidence } from "./espn-harness.mjs";
import { loadTrendFixture } from "../server/sports/fixtures.mjs";
import { FixtureTrendAdapter } from "../server/sports/trend.mjs";

const report = { title: "Lead story report", publisher: "League report", url: "https://league.example/reports/lead", excerpt: "The lead story as the league reported it, with 2 late goals." };
const topic = { id: "story", title: "Lead story", summary: "Editor notes", take: "", selected: true, sources: [report] };

// The practice desk over the evidence slates and a fixture attention feed.
async function newsroom(t, { now, observations = [], failures = false, live = false, write, anchor, evidence } = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  const directory = await mkdtemp(path.join(root, "data", "sports-newsroom-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = new Date(now);
  const built = [];
  const desk = new SportsDesk({
    directory, timezone: "America/Chicago", publishEnabled: false, canResearch: () => live, canUpload: () => false, now: () => time, rebuildDelay: 60_000,
    research: async () => [topic], write, anchor, listing: async () => null,
    evidence: evidence || new FixtureEvidenceAdapter(),
    trend: [new FixtureTrendAdapter(failures ? () => { throw new Error("HTTP 503"); } : observations)],
    render: async (episode, output) => {
      built.push(episode);
      await writeFile(path.join(output, "episode.mp4"), "placeholder for video bytes");
      return { duration: 90, shorts: episode.segments.map((segment, index) => ({ segment: index + 1, id: segment.id, headline: segment.headline, file: `shorts/segment-0${index + 1}.mp4`, duration: 20 })), shots: [] };
    },
  });
  t.after(() => clearTimeout(desk.rebuildTimer));
  return { desk, built, clock: (value) => { time = new Date(value); } };
}

test("the live writer's numbers must appear in a cited source or the build is refused with the reason", async (t) => {
  const { desk } = await newsroom(t, {
    now: "2026-11-16T06:00:00Z", live: true,
    write: async ({ topics }) => ({ title: topics[0].title, description: "Episode", segments: [{ headline: topics[0].title, narration: "The visitors won by 14 points.", sources: topics[0].sources }] }),
  });
  await desk.tick();
  await desk.work.done;
  const { edition } = await desk.view();
  assert.equal(edition.status, "failed");
  assert.match(edition.error, /cites numbers without evidence: 14/u);
  assert.equal(edition.verification.ok, false);
  assert.equal(edition.render, null);
});

test("8 a.m. Central is resolved to the right UTC instant on both sides of daylight saving", () => {
  assert.equal(zonedTime("2026-11-16", 8, "America/Chicago"), "2026-11-16T14:00:00.000Z");
  assert.equal(zonedTime("2026-07-04", 8, "America/Chicago"), "2026-07-04T13:00:00.000Z");
});

test("Other news accepts a non-sports story, builds its segment and survives a sports slate scan", async (t) => {
  const { desk, built } = await newsroom(t, {
    now: "2026-11-16T12:30:00Z", live: true,
    write: async ({ topics }) => ({ title: "NASA completes engine test", description: "An update on the engine test.", segments: topics.map((topic) => ({ headline: topic.title, narration: "NASA completed an engine test for the mission.", sources: topic.sources })) }),
  });
  const added = await desk.changeTopic(null, {
    title: "NASA completes engine test", sport: "other", url: "https://news.example/mission", excerpt: "NASA completed an engine test for the mission.", teams: ["An irrelevant sports tag"],
  }, "2026-11-16");
  const topic = added.edition.topics[0];
  assert.equal(topic.league, "Other news");
  assert.deepEqual(topic.teams, []);
  assert.ok(added.settings.scope.options.some(({ league, sport }) => league === "Other news" && sport === "other"));
  await desk.run("build", "2026-11-16");
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(built.at(-1).segments[0].league, "Other news");
  assert.equal(built.at(-1).segments[0].footage.sport, "other");
  assert.equal(built.at(-1).segments[0].bumper, "We start with the other news.");
  const scanned = (await desk.scanSlate("2026-11-16")).edition.topics.find(({ id }) => id === topic.id);
  assert.equal(scanned.selected, true);
  assert.notEqual(scanned.coverage, "out of scope");
});

test("a scanned slate becomes pitches with ledger claims, the trend desk clears one angle, and the cut carries both", async (t) => {
  const trendFixture = await loadTrendFixture();
  const { desk, built } = await newsroom(t, { now: "2026-11-16T12:30:00Z", observations: trendFixture.scenarios.sameEvent });
  const { edition } = await desk.scanSlate("2026-11-16");
  assert.equal(edition.slate.length, 3);
  assert.deepEqual(edition.slate.map(({ league, coverage }) => [league, coverage]), [["NBA", "covered"], ["MLB", "covered"], ["MLS", "out of scope"]], "the launch scope is NCAA, NBA and MLB");
  assert.match(edition.slate[2].reason, /limited to NCAA, NBA, MLB/u);
  const stories = edition.topics.filter(({ eventId }) => eventId);
  assert.equal(stories.length, 2, "an out-of-scope game is never pitched");
  await assert.rejects(desk.changeTopic(null, { title: "Rovers earn a point on the road", league: "MLS", sport: "soccer" }, "2026-11-16"), /limited to NCAA, NBA, MLB/u);
  const widened = await newsroom(t, { now: "2026-11-16T12:30:00Z" });
  widened.desk.scope = { leagues: ["NCAA", "NBA", "MLB", "MLS"], label: "NCAA, NBA, MLB, MLS" };
  assert.equal((await widened.desk.scanSlate("2026-11-16")).edition.topics.filter(({ selected }) => selected).length, 3);
  widened.desk.scope = { leagues: ["NBA"], label: "NBA" };
  const narrowed = (await widened.desk.scanSlate("2026-11-16")).edition;
  assert.deepEqual(narrowed.topics.map(({ league, selected, coverage }) => [league, selected, coverage]), [["NBA", true, "covered"], ["MLB", false, "out of scope"], ["MLS", false, "out of scope"]], "a narrowed scope benches stories already in the rundown");
  const core = stories.find(({ eventId }) => eventId === "2026-11-15-nba-hcg-rvs");
  assert.ok(core.claimIds.length === 3 && core.selected && core.script.narration.includes("33 points"));
  assert.ok(edition.topics.filter(({ eventId }) => !eventId).every(({ selected, practice }) => practice && !selected), "any evergreen practice topic is benched once real recaps exist");

  const checked = await desk.checkTrend(core.id, { aliases: ["Mara Quill", "Gulls Stags"] }, "2026-11-16");
  const card = checked.edition.topics.find(({ id }) => id === core.id).trend;
  assert.equal(card.recommendation, "daily segment");
  assert.equal(card.airable, true);
  assert.equal(card.matchedStoryId, "2026-11-15-nba-hcg-rvs");
  assert.equal(checked.edition.trendDesk.checks[0].topicId, core.id);
  await desk.lockCoreStory(core.id, "2026-11-16");
  const second = await desk.checkTrend(core.id, {}, "2026-11-16");
  assert.equal(second.edition.topics.find(({ id }) => id === core.id).trend.comparison.observations, 3, "repeated checks keep earlier observations");

  await desk.run("build", "2026-11-16");
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(ready.verification.ok, true);
  assert.equal(ready.render.revisionId, ready.verification.revisionId);
  const episode = built.at(-1);
  assert.equal(episode.segments.length, 3, "two in-scope stories and the trend segment");
  assert.equal(episode.segments.at(-1).kind, "trend");
  assert.ok(episode.segments.every((segment) => segment.claims.length > 0 && segment.claims.every((claim) => claim.evidence[0].id.startsWith("snap_"))));
  assert.equal(episode.segments[0].id, "2026-11-15-nba-hcg-rvs", "stable segment IDs for the Short release items");
  assert.equal(episode.airAt, "2026-11-16T14:00:00.000Z");
  assert.equal(episode.segments[0].shots.episode.fallback, "Play diagram");
  const ledger = await desk.ledgerView();
  assert.ok(ledger.revisions.some(({ id, status }) => id === ready.render.revisionId && status === "locked"));
  assert.equal(ledger.trends.length, 1);

  // A correction from Isaac supersedes the claim, withdraws the cut and shows the reason.
  const leader = ledger.claims.find(({ key, id }) => key === "leader:Mara Quill" && core.claimIds.includes(id));
  const corrected = await desk.correctClaim(leader.id, {
    text: "Mara Quill finished with 31 points, 8 rebounds and 7 assists", value: [31, 8, 7], unit: "points, rebounds, assists", reason: "The league reassigned a basket after review.",
    evidence: { url: "https://scores.example/nba/2026-11-15-nba-hcg-rvs/box?rev=2", locator: "Stat correction", publisher: "league-official", excerpt: "Stat correction: Mara Quill credited with 31 points." },
  }, "2026-11-16");
  assert.equal(corrected.edition.render, null);
  assert.equal(corrected.edition.revision, ready.revision + 1);
  assert.equal(corrected.edition.corrections.length, 1);
  assert.match(corrected.edition.corrections[0].reason, /reassigned a basket/u);
  assert.equal(corrected.edition.corrections[0].invalidatedRevision, ready.revision);
  assert.equal(corrected.edition.corrections[0].topics[0].id, core.id);
  const updated = corrected.edition.topics.find(({ id }) => id === core.id);
  assert.match(updated.script.narration, /31 points, 8 rebounds/u);
  assert.ok(!updated.claimIds.includes(leader.id));
  await desk.run("build", "2026-11-16");
  await desk.work.done;
  const rebuilt = (await desk.view()).edition;
  assert.equal(rebuilt.status, "ready", rebuilt.error);
  assert.match(built.at(-1).segments[0].narration, /31 points/u);
  assert.ok((await desk.ledgerView()).revisions.some(({ status }) => status === "invalidated"));
});

test("in a live edition the anchor pass voices scanned stories, is rechecked against the ledger, cached, and falls back on bad numbers", async (t) => {
  const asked = [];
  const { desk, built } = await newsroom(t, {
    now: "2026-11-16T12:30:00Z", live: true,
    write: async () => { throw new Error("the model writer must not see scripted stories"); },
    anchor: async ({ segments }) => {
      asked.push(segments.map(({ id, position }) => [id, position]));
      return segments.map((segment) => ({
        id: segment.id,
        narration: segment.league === "MLB"
          ? `Next, to baseball, where the Foundry edged the Anchors 2 to 1 for their 9th win in a row.`
          : `Our lead story this morning: Mara Quill's corner three with 0:41 left carried the Gulls past the Stags, 112 to 104, and she finished with 33 points.`,
      }));
    },
  });
  await desk.scanSlate("2026-11-16");
  await desk.run("build", "2026-11-16");
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.deepEqual(asked, [[["2026-11-15-nba-hcg-rvs", "lead story"], ["2026-11-15-mlb-wff-paa", "last story"]]]);
  const episode = built.at(-1);
  assert.match(episode.segments[0].narration, /^Our lead story this morning/u);
  assert.match(episode.segments[0].draft, /^Harbor City Gulls 112/u);
  assert.match(episode.segments[1].narration, /^Westfield Foundry 2, Port Allen Anchors 1/u, "a rewrite with a number outside the evidence falls back to the factual draft");
  assert.deepEqual(ready.render.anchor.segments.map(({ status }) => status), ["written", "fallback"]);
  assert.match(ready.render.anchor.issues[0], /9/u);
  assert.equal(ready.anchorCache, undefined, "the cache stays out of the editor API");

  const mlb = ready.topics.find(({ league }) => league === "MLB");
  await desk.changeTopic(mlb.id, { selected: false }, "2026-11-16");
  clearTimeout(desk.rebuildTimer);
  await desk.run("build", "2026-11-16");
  await desk.work.done;
  assert.equal((await desk.view()).edition.status, "ready");
  assert.equal(asked.length, 1, "unchanged copy comes from the cache without asking the model again");
  assert.equal((await desk.view()).edition.render.anchor.segments[0].status, "cached");
});

test("a correction published by the source between scans withdraws the dependent cut", async (t) => {
  const { desk, built } = await newsroom(t, { now: "2026-11-11T06:00:00Z" });
  await desk.scanSlate("2026-11-11", { asOf: "2026-11-11T04:30:00Z" });
  await desk.run("build", "2026-11-11");
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.match(built.at(-1).segments.find(({ id }) => id === "2026-11-10-nba-spo-blc").narration, /31 points/u);
  const rescanned = (await desk.scanSlate("2026-11-11", { asOf: "2026-11-11T06:30:00Z" })).edition;
  assert.equal(rescanned.render, null);
  assert.equal(rescanned.corrections.length, 1);
  assert.match(rescanned.corrections[0].reason, /official scorer/u);
  assert.equal(rescanned.corrections[0].invalidatedRevision, ready.revision);
  assert.match(rescanned.topics.find(({ eventId }) => eventId === "2026-11-10-nba-spo-blc").script.narration, /29 points/u);
});

test("an unverified pitch never earns a trend segment, a feed outage is shown as signal unavailable, and the API exposes the controls", async (t) => {
  const trendFixture = await loadTrendFixture();
  const { desk, built } = await newsroom(t, { now: "2026-11-16T12:30:00Z", observations: trendFixture.scenarios.rumor });
  // A desk password in the operator's .env would put this local API behind the login.
  const password = process.env.SPORTS_DESK_PASSWORD;
  delete process.env.SPORTS_DESK_PASSWORD;
  t.after(() => { if (password !== undefined) process.env.SPORTS_DESK_PASSWORD = password; });
  const { app } = await createApp({ sports: desk });
  const browser = request(app);
  const scanned = await browser.post("/api/sports/evidence/scan").send({ date: "2026-11-16" }).expect(200);
  const pitched = scanned.body.edition.topics.find(({ eventId }) => eventId === "2026-11-15-nba-hcg-rvs");
  assert.deepEqual([pitched.sport, pitched.league, pitched.teams], ["basketball", "NBA", ["River Valley Stags", "Harbor City Gulls"]], "scanned pitches are tagged with sport, league and teams");
  const rumor = (await browser.post("/api/sports/topics").send({ date: "2026-11-16", title: "Mara Quill trade rumor", take: "I would not read anything into it yet.", sport: "basketball", league: "NBA", teams: ["Harbor City Gulls"] }).expect(201)).body.edition.topics.at(-1);
  assert.deepEqual([rumor.sport, rumor.league, rumor.teams], ["basketball", "NBA", ["Harbor City Gulls"]]);
  const general = (await browser.post("/api/sports/topics").send({ date: "2026-11-16", title: "What to watch this weekend", take: "Three games worth the early alarm.", sport: "other", league: null, teams: [] }).expect(201)).body.edition.topics.at(-1);
  assert.deepEqual([general.sport, general.league, general.teams], ["other", "Other news", []], "a general topic gets its own news category without a team");
  await browser.patch(`/api/sports/topics/${general.id}`).send({ date: "2026-11-16", selected: false }).expect(200);
  await browser.post("/api/sports/topics").send({ date: "2026-11-16", title: "Bad tag", sport: "curling" }).expect(400);
  await browser.post("/api/sports/topics").send({ date: "2026-11-16", title: "Out of scope", sport: "hockey", league: "NHL" }).expect(409);
  const college = (await browser.post("/api/sports/topics").send({ date: "2026-11-16", title: "Pine Ridge opens at home", sport: "basketball", league: "NCAAB", teams: ["Pine Ridge"] }).expect(201)).body;
  assert.equal(college.settings.scope.label, "NCAA, NBA, MLB, UFC");
  assert.ok(college.settings.scope.options.some(({ league }) => league === "NCAAB"));
  await browser.patch(`/api/sports/topics/${college.edition.topics.at(-1).id}`).send({ date: "2026-11-16", selected: false }).expect(200);
  const onAir = "I would wait for confirmation before drawing a conclusion.";
  await browser.patch(`/api/sports/topics/${rumor.id}`).send({ date: "2026-11-16", storyId: "2026-11-15-nba-hcg-rvs", aliases: ["Mara Quill trade"], teams: ["Harbor City Gulls", "River Valley Stags"], takeScript: onAir }).expect(200);
  const checked = await browser.post(`/api/sports/topics/${rumor.id}/trend`).send({ date: "2026-11-16" }).expect(200);
  const card = checked.body.edition.topics.find(({ id }) => id === rumor.id).trend;
  assert.equal(card.recommendation, "insufficient evidence");
  assert.equal(card.airable, false);
  for (const other of scanned.body.edition.topics.filter(({ id }) => id !== rumor.id)) await browser.patch(`/api/sports/topics/${other.id}`).send({ date: "2026-11-16", selected: false }).expect(200);
  await browser.post("/api/sports/build").send({ date: "2026-11-16" }).expect(202);
  await desk.work.done;
  const ready = (await browser.get("/api/sports/edition").expect(200)).body.edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.deepEqual(built.at(-1).segments.map(({ kind }) => kind || "story"), ["story"]);
  assert.equal(built.at(-1).segments[0].narration, `Isaac’s take. ${onAir}`);
  const trend = await browser.get("/api/sports/trend").expect(200);
  assert.equal(trend.body.trendDesk.checks.length, 1);
  const ledger = (await browser.get("/api/sports/ledger").expect(200)).body;
  assert.ok(ledger.claims.length > 0 && ledger.snapshots.every((snapshot) => !("payload" in snapshot)));
  await browser.post(`/api/sports/claims/${ledger.claims[0].id}/correct`).send({ date: "2026-11-16", text: "Changed", reason: "No evidence supplied" }).expect(400);
  await browser.post("/api/sports/claims/clm_00000000000000000000/resolve").send({ date: "2026-11-16", disposition: "supported", reason: "Checked" }).expect(404);

  const outage = await newsroom(t, { now: "2026-11-16T12:30:00Z", failures: true });
  const { edition } = await outage.desk.scanSlate("2026-11-16");
  const core = edition.topics.find(({ eventId }) => eventId === "2026-11-15-nba-hcg-rvs");
  const down = (await outage.desk.checkTrend(core.id, {}, "2026-11-16")).edition.topics.find(({ id }) => id === core.id).trend;
  assert.equal(down.recommendation, "signal unavailable");
  assert.equal(down.airable, false);
});

test("an ESPN scan pitches the Nuggets final from the night before and builds the script without a model", async (t) => {
  const cache = await mkdtemp(path.join(root, "data", "espn-newsroom-"));
  t.after(() => rm(cache, { recursive: true, force: true }));
  const evidence = await espnEvidence({ cacheDir: cache });
  const { desk, built } = await newsroom(t, { now: "2026-11-15T12:30:00Z", evidence });
  const { edition } = await desk.scanSlate("2026-11-15");
  assert.equal(edition.slate.some((row) => row.gameId === "401909990"), false, "the evening tip after 8 a.m. Central stays off this edition");
  const nuggets = edition.topics.find((topic) => topic.eventId === "401909980");
  assert.ok(nuggets, "the Nuggets final is pitched");
  assert.match(nuggets.script.narration, /November 14/);
  assert.match(nuggets.script.narration, /116-108/);
  assert.match(nuggets.script.narration, /26 points, 8 rebounds and 10 assists/);
  assert.equal(nuggets.league, "NBA");
  assert.deepEqual(nuggets.teams, ["Denver Nuggets", "New Orleans Pelicans"]);
  assert.ok(edition.topics.filter((topic) => topic.selected && topic.eventId).length <= 4);
  assert.equal(edition.slate.some((row) => row.league === "MLB" && row.coverage === "source unavailable"), false);

  // Highlight references ride on the story card as public pages only; Isaac's review records a range and fetches nothing.
  assert.ok(nuggets.clips.length >= 1, "the Nuggets highlight is listed as a clip reference");
  const clip = nuggets.clips[0];
  assert.match(clip.page, /^https:\/\/www\.espn\.com\//u);
  assert.equal(clip.decision, null);
  assert.equal(clip.out, 8, "the suggested range is eight seconds");
  assert.ok(!JSON.stringify(nuggets.clips).includes("watch.auth"), "no playback host is stored on the card");
  await assert.rejects(desk.reviewClip(nuggets.id, clip.id, { decision: "approved", in: 0, out: 20 }, "2026-11-15"), /capped at 15 seconds/u);
  const reviewed = (await desk.reviewClip(nuggets.id, clip.id, { decision: "approved", in: 4, out: 12 }, "2026-11-15")).edition.topics.find((topic) => topic.id === nuggets.id).clips[0];
  assert.deepEqual([reviewed.decision, reviewed.in, reviewed.out, reviewed.reviewedBy], ["approved", 4, 12, "isaac"]);
  const rescanned = (await desk.scanSlate("2026-11-15")).edition.topics.find((topic) => topic.id === nuggets.id).clips[0];
  assert.equal(rescanned.decision, "approved", "a rescan keeps Isaac's decision");
  await desk.run("build", "2026-11-15");
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  if (nuggets.selected) assert.match(built.at(-1).segments.find((segment) => segment.id === "401909980").narration, /116-108/);
});

test("a failed ESPN scan does not stop the morning tick", async (t) => {
  const evidence = {
    name: "espn",
    contract: { allowedUses: ["verify"], retention: "excerpt" },
    listGames: async () => { throw new Error("scoreboard down"); },
    gameEvidence: async () => { throw new Error("scoreboard down"); },
  };
  const { desk } = await newsroom(t, { now: "2026-11-15T12:30:00Z", evidence });
  await desk.tick();
  const { edition } = await desk.view();
  assert.equal(edition.scanFailures, 1);
  assert.equal(edition.status, "waiting");
});
