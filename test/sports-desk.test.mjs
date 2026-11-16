import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { root } from "../server/config.mjs";
import { SportsDesk, localClock, zonedTime } from "../server/sports/desk.mjs";
import { FixtureEvidenceAdapter } from "../server/sports/evidence.mjs";
import { loadTrendFixture } from "../server/sports/fixtures.mjs";
import { FixtureTrendAdapter } from "../server/sports/trend.mjs";

const midnight = "2026-11-16T06:00:00Z";
const airTime = "2026-11-16T14:00:00Z";
const date = "2026-11-16";
const report = { title: "Lead story report", publisher: "League report", url: "https://league.example/reports/lead", excerpt: "The lead story as the league reported it, with 2 late goals." };
const topic = { id: "story", title: "Lead story", summary: "Editor notes", take: "", selected: true, sources: [report] };

async function fixture(t, overrides = {}) {
  await mkdir(path.join(root, "data"), { recursive: true });
  const directory = await mkdtemp(path.join(root, "data", "sports-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let time = new Date(midnight);
  const clock = (value) => { time = new Date(value); };
  const options = {
    directory, timezone: "America/Chicago", publishEnabled: true,
    canResearch: () => true, canUpload: () => true, now: () => time, rebuildDelay: 60_000,
    research: async () => [topic],
    draftTake: async () => "Keeping a defender deep gives the unit room to react before committing.",
    write: async ({ topics }) => ({ title: topics[0].title, description: "Episode", segments: [{ headline: topics[0].title, narration: "Example script with 2 late goals.", sources: topics[0].sources }] }),
    trend: [],
    render: async (_episode, output) => {
      await writeFile(path.join(output, "episode.mp4"), "placeholder for video bytes");
      return { duration: 25 };
    },
    ...overrides,
  };
  const desk = new SportsDesk(options);
  t.after(() => clearTimeout(desk.rebuildTimer));
  return { desk, clock, options };
}

test("saving take notes drafts the on-air script and manual edits survive without another model call", async (t) => {
  let calls = 0;
  const { desk } = await fixture(t, {
    draftTake: async (story) => {
      calls++;
      assert.equal(story.take, "more patience at the back");
      return "The defense should keep its shape until the attack shows where the danger is.";
    },
  });
  const { edition } = await desk.changeTopic(null, { title: "The final drive", take: "more patience at the back" }, date);
  const [story] = edition.topics;
  assert.equal(story.take, "more patience at the back");
  assert.match(story.takeScript, /keep its shape/);
  const edited = await desk.changeTopic(story.id, { takeScript: "Stay compact and make the attack commit first." }, date);
  assert.equal(edited.edition.topics[0].takeScript, "Stay compact and make the attack commit first.");
  assert.equal(calls, 1);
  const cleared = await desk.changeTopic(story.id, { take: "" }, date);
  assert.equal(cleared.edition.topics[0].takeScript, "");
});

test("a failed take draft preserves the prior notes and script", async (t) => {
  const { desk } = await fixture(t, { draftTake: async () => { throw new Error("Model offline."); } });
  const { edition } = await desk.changeTopic(null, { title: "The final drive" }, date);
  await assert.rejects(desk.changeTopic(edition.topics[0].id, { take: "play the bench" }, date), /take wasn’t saved/i);
  assert.equal((await desk.view()).edition.topics[0].take, "");
});

test("uses Central dates and hours on both sides of daylight saving changes", () => {
  assert.deepEqual(localClock(new Date("2026-03-08T06:00:00Z"), "America/Chicago"), { date: "2026-03-08", hour: 0 });
  assert.deepEqual(localClock(new Date("2026-03-08T13:00:00Z"), "America/Chicago"), { date: "2026-03-08", hour: 8 });
  assert.deepEqual(localClock(new Date("2026-11-01T14:00:00Z"), "America/Chicago"), { date: "2026-11-01", hour: 8 });
});

test("files one midnight edition and holds an older render after an editorial change", async (t) => {
  let researched = 0;
  let uploaded = 0;
  const { desk, clock } = await fixture(t, {
    research: async () => { researched++; return [topic]; },
    upload: async () => { uploaded++; return { id: "test", url: "https://youtu.be/test" }; },
  });
  await Promise.all([desk.tick(), desk.tick()]);
  await desk.work.done;
  assert.equal(researched, 1);
  assert.equal((await desk.view()).edition.status, "ready");
  await desk.changeTopic("story", { take: "Isaac changed the opening angle." }, date);
  assert.equal((await desk.view()).edition.render.revision, 1);
  clock(airTime);
  await desk.tick();
  assert.equal(uploaded, 0);
  assert.equal((await desk.view()).edition.publication.status, "held");
  await desk.run("build", date);
  await desk.work.done;
  await desk.tick();
  await desk.work.done;
  await desk.tick();
  assert.equal(uploaded, 1);
  assert.equal((await desk.view()).edition.publication.status, "published");
});

test("a fresh cut of the same editorial revision leaves an open preview intact", async (t) => {
  let cut = 0;
  const { desk } = await fixture(t, {
    render: async (_episode, output) => {
      await writeFile(path.join(output, "episode.mp4"), String(++cut));
      return { duration: 25 };
    },
  });
  await desk.tick();
  await desk.work.done;
  const first = (await desk.view()).edition.render;
  const previous = await desk.videoPath(date, first.revision);
  await desk.run("build", date);
  await desk.work.done;
  const latest = (await desk.view()).edition.render;
  assert.equal(latest.revision, first.revision);
  assert.notEqual(latest.url, first.url);
  assert.equal(await readFile(previous, "utf8"), "1");
  assert.equal(await readFile(await desk.videoPath(date, latest.revision), "utf8"), "2");
});

test("an edit during encoding invalidates that output and automatically builds the new revision", { timeout: 3000 }, async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const rebuilt = Promise.withResolvers();
  const finish = Promise.withResolvers();
  let buildCount = 0;
  const { desk } = await fixture(t, {
    rebuildDelay: 10,
    render: async (_episode, output) => {
      if (++buildCount === 1) {
        entered.resolve();
        await release.promise;
      } else {
        rebuilt.resolve();
        await finish.promise;
      }
      await writeFile(path.join(output, "episode.mp4"), "placeholder for video bytes");
      return { duration: 25 };
    },
  });
  await desk.tick();
  const first = desk.work.done;
  await entered.promise;
  await desk.changeTopic("story", { take: "Watch what happens after the timeout." }, date);
  release.resolve();
  await first;
  desk.rebuildTimer.ref();
  assert.equal((await desk.view()).edition.render, null);
  await rebuilt.promise;
  finish.resolve();
  await desk.work.done;
  const { edition } = await desk.view();
  assert.equal(edition.render.revision, edition.revision);
  assert.equal(buildCount, 2);
});

test("a restart resumes the recorded YouTube session and keeps its URL out of the editor API", async (t) => {
  const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=example";
  const { desk, clock, options } = await fixture(t, {
    upload: async ({ sessionUrl, onSession }) => {
      assert.equal(sessionUrl, undefined);
      await onSession(session);
      throw new Error("Connection dropped.");
    },
  });
  await desk.tick();
  await desk.work.done;
  clock(airTime);
  await desk.tick();
  await desk.work.done;
  const failed = (await desk.view()).edition;
  assert.equal(failed.publication.status, "failed");
  assert.equal(failed.publication.sessionUrl, undefined);
  assert.equal(failed.locked, true);

  clock("2026-11-16T14:05:00Z");
  const restarted = new SportsDesk({ ...options, upload: async ({ sessionUrl }) => {
    assert.equal(sessionUrl, session);
    return { id: "test", url: "https://youtu.be/test" };
  } });
  await restarted.tick();
  await restarted.work.done;
  assert.equal((await restarted.view()).edition.publication.status, "published");
});

test("practice chat persists edits and rejects a stale date and a foreign cron request", async (t) => {
  const { desk, clock } = await fixture(t, { canResearch: () => false });
  const { app } = await createApp({ sports: desk });
  const browser = request(app);
  const authenticate = (req) => process.env.SPORTS_DESK_PASSWORD
    ? req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD) : req;
  const current = await authenticate(browser.get("/api/sports/edition")).expect(200);
  assert.equal(current.body.edition.sample, true);
  const added = await authenticate(browser.post("/api/sports/chat")).send({ date, message: "add: The closing lineup question" }).expect(200);
  const { id } = added.body.edition.topics[0];
  const update = await authenticate(browser.post("/api/sports/chat")).send({ date, topicId: id, message: "take: Start with the defense." }).expect(200);
  assert.equal(update.body.edition.topics[0].take, "Start with the defense.");
  assert.equal(update.body.edition.messages.length, 4);
  await browser.post("/api/sports/cron").set("X-Forwarded-For", "203.0.113.4").expect(403);
  await browser.post("/api/sports/cron").set("Sec-Fetch-Site", "same-origin").expect(403);
  await browser.post("/api/sports/cron").expect(204);
  clock("2026-11-17T06:00:00Z");
  await authenticate(browser.patch(`/api/sports/topics/${id}`)).send({ date, take: "Old edit" }).expect(409);
});
