import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { root } from "../server/config.mjs";
import { SportsDesk, zonedTime } from "../server/sports/desk.mjs";
import { FixtureEvidenceAdapter } from "../server/sports/evidence.mjs";
import { loadTrendFixture } from "../server/sports/fixtures.mjs";
import { FixtureTrendAdapter } from "../server/sports/trend.mjs";

const report = { title: "Lead story report", publisher: "League report", url: "https://league.example/reports/lead", excerpt: "The lead story as the league reported it, with 2 late goals." };
const topic = { id: "story", title: "Lead story", summary: "Editor notes", take: "", selected: true, sources: [report] };

// The practice desk over the evidence slates and a fixture attention feed.
async function newsroom(t, { now, observations = [], failures = false, live = false, write } = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  const directory = await mkdtemp(path.join(root, "data", "sports-newsroom-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = new Date(now);
  const built = [];
  const desk = new SportsDesk({
    directory, timezone: "America/Chicago", publishEnabled: false, canResearch: () => live, canUpload: () => false, now: () => time, rebuildDelay: 60_000,
    research: async () => [topic], write,
    evidence: new FixtureEvidenceAdapter(),
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

test("a scanned slate becomes pitches with ledger claims, the trend desk clears one angle, and the cut carries both", async (t) => {
  const trendFixture = await loadTrendFixture();
  const { desk, built } = await newsroom(t, { now: "2026-11-16T12:30:00Z", observations: trendFixture.scenarios.sameEvent });
  const { edition } = await desk.scanSlate("2026-11-16");
  assert.equal(edition.slate.length, 3);
  assert.ok(edition.slate.every(({ coverage }) => coverage === "covered"));
  const stories = edition.topics.filter(({ eventId }) => eventId);
  assert.equal(stories.length, 3);
  const core = stories.find(({ eventId }) => eventId === "2026-11-15-nba-hcg-rvs");
  assert.ok(core.claimIds.length === 3 && core.selected && core.script.narration.includes("33 points"));
  const placeholders = edition.topics.filter(({ eventId }) => !eventId);
  assert.equal(placeholders.length, 3);
  assert.ok(placeholders.every(({ selected, practice }) => practice && !selected), "evergreen practice topics are benched once real recaps exist");

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
  assert.equal(episode.segments.length, 4);
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
  const { app } = await createApp({ sports: desk });
  const browser = request(app);
  const scanned = await browser.post("/api/sports/evidence/scan").send({ date: "2026-11-16" }).expect(200);
  const rumor = (await browser.post("/api/sports/topics").send({ date: "2026-11-16", title: "Mara Quill trade rumor", take: "I would not read anything into it yet." }).expect(201)).body.edition.topics.at(-1);
  await browser.patch(`/api/sports/topics/${rumor.id}`).send({ date: "2026-11-16", storyId: "2026-11-15-nba-hcg-rvs", aliases: ["Mara Quill trade"] }).expect(200);
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
