import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { root } from "../server/config.mjs";
import { SportsDesk, announceSports, editionClock, localClock, zonedTime } from "../server/sports/desk.mjs";
import { FixtureEvidenceAdapter } from "../server/sports/evidence.mjs";
import { loadTrendFixture } from "../server/sports/fixtures.mjs";
import { FixtureTrendAdapter } from "../server/sports/trend.mjs";
import { renderEpisode } from "../server/sports/produce.mjs";
import { probe } from "../server/media.mjs";
import { wav } from "../server/voice.mjs";

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
    // No model in tests: listings use the headline-based titles.
    listing: async () => null,
    // Desk tests load the real env, so never call Google for a thumbnail.
    thumbnail: async () => ({}),
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
  // The story is filed before the model answers; the script lands afterwards.
  assert.equal(edition.topics[0].take, "more patience at the back");
  assert.ok(edition.topics[0].takeDraftingAt);
  await desk.takeDraft;
  const [story] = (await desk.view()).edition.topics;
  assert.match(story.takeScript, /keep its shape/);
  assert.equal(story.takeDraftingAt, undefined);
  const edited = await desk.changeTopic(story.id, { takeScript: "Stay compact and make the attack commit first." }, date);
  assert.equal(edited.edition.topics[0].takeScript, "Stay compact and make the attack commit first.");
  assert.equal(calls, 1);
  const cleared = await desk.changeTopic(story.id, { take: "" }, date);
  assert.equal(cleared.edition.topics[0].takeScript, "");
});

test("a failed take draft keeps the saved notes and shows why", async (t) => {
  const { desk } = await fixture(t, { draftTake: async () => { throw new Error("Model offline."); } });
  const { edition } = await desk.changeTopic(null, { title: "The final drive" }, date);
  await desk.changeTopic(edition.topics[0].id, { take: "play the bench" }, date);
  await desk.takeDraft;
  const [story] = (await desk.view()).edition.topics;
  assert.equal(story.take, "play the bench");
  assert.equal(story.takeScript, "");
  assert.match(story.takeError, /wasn’t drafted. Model offline/u);
});

test("a new story saves at once while the model is busy", async (t) => {
  let release;
  const { desk } = await fixture(t, { draftTake: () => new Promise((resolve) => { release = resolve; }) });
  const { edition } = await desk.changeTopic(null, { title: "GTA 6 drops", sport: "other", take: "huge for gaming" }, date);
  assert.equal(edition.topics.at(-1).title, "GTA 6 drops");
  await desk.changeTopic(edition.topics.at(-1).id, { summary: "Edited while drafting." }, date);
  release("This launch could reset what a blockbuster release looks like.");
  await desk.takeDraft;
  const story = (await desk.view()).edition.topics.at(-1);
  assert.equal(story.summary, "Edited while drafting.");
  assert.match(story.takeScript, /blockbuster/u);
});

test("a script Isaac types is saved as written and never drafted over", async (t) => {
  let release;
  let drafts = 0;
  const { desk } = await fixture(t, { draftTake: () => { drafts++; return new Promise((resolve) => { release = resolve; }); } });
  const typed = "GTA 6 sold 16 million copies on day one. That's the biggest launch I've seen.";
  const added = (await desk.changeTopic(null, { title: "GTA 6 drops", sport: "other", take: "16 million day one", takeScript: typed }, date)).edition.topics.at(-1);
  assert.equal(added.takeScript, typed);
  assert.equal(drafts, 0);
  // A draft already running when he types a script does not replace it.
  const other = (await desk.changeTopic(null, { title: "Another story", take: "rough notes" }, date)).edition.topics.at(-1);
  await desk.changeTopic(other.id, { takeScript: "My own words." }, date);
  release("A drafted script.");
  await desk.takeDraft;
  assert.equal((await desk.view()).edition.topics.find(({ id }) => id === other.id).takeScript, "My own words.");
});

test("uses Central dates and hours on both sides of daylight saving changes", () => {
  assert.deepEqual(localClock(new Date("2026-03-08T06:00:00Z"), "America/Chicago"), { date: "2026-03-08", hour: 0 });
  assert.deepEqual(localClock(new Date("2026-03-08T13:00:00Z"), "America/Chicago"), { date: "2026-03-08", hour: 8 });
  assert.deepEqual(localClock(new Date("2026-11-01T14:00:00Z"), "America/Chicago"), { date: "2026-11-01", hour: 8 });
});

test("the next day's edition opens at 9 p.m. Central", () => {
  assert.deepEqual(editionClock(new Date("2026-11-20T02:59:00Z"), "America/Chicago"), { date: "2026-11-19", hour: 20 });
  assert.deepEqual(editionClock(new Date("2026-11-20T03:00:00Z"), "America/Chicago"), { date: "2026-11-20", hour: -3 });
  assert.deepEqual(editionClock(new Date("2026-11-20T06:00:00Z"), "America/Chicago"), { date: "2026-11-20", hour: 0 });
  assert.deepEqual(editionClock(new Date("2027-01-01T05:30:00Z"), "America/Chicago"), { date: "2027-01-01", hour: -1 });
});

test("at 9 p.m. the new edition is researched and a build still running for the last show is stopped", async (t) => {
  let researched = 0;
  const { desk, clock } = await fixture(t, { research: async () => { researched++; return [topic]; } });
  clock("2026-11-17T02:00:00Z"); // 8 p.m. on the 16th
  const old = await desk.load(date);
  let aborted = false;
  desk.launch(old, "build", () => new Promise((_, reject) => desk.work.controller.signal.addEventListener("abort", () => { aborted = true; reject(new Error("stopped")); })));
  clock("2026-11-17T03:00:00Z"); // 9 p.m.: the 17th's edition opens
  assert.equal((await desk.view()).edition.date, "2026-11-17");
  await desk.tick();
  await desk.work?.done.catch(() => {});
  assert.equal(aborted, true);
  await desk.tick();
  await desk.work?.done;
  assert.equal(researched, 1);
  assert.ok((await desk.load("2026-11-17")).researchedAt);
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

test("a published episode can open an editable revision, keep its release and rebuild without automatic republishing", async (t) => {
  let uploads = 0;
  const { desk, clock } = await fixture(t, { upload: async () => { uploads++; return { id: "abc123de_45", url: "https://youtu.be/abc123de_45" }; } });
  await desk.tick();
  await desk.work.done;
  clock(airTime);
  await desk.tick();
  await desk.work.done;
  const original = (await desk.view()).edition;
  assert.equal(original.locked, true);
  const originalFile = await desk.videoPath(date, original.revision);
  const reopened = (await desk.reopen(date)).edition;
  assert.equal(reopened.locked, false);
  assert.equal(reopened.revision, original.revision + 1);
  assert.equal(reopened.manualRevision, true);
  assert.equal(reopened.releases[0].publication.url, original.publication.url);
  await desk.run("build", date);
  await desk.work.done;
  const updated = (await desk.view()).edition;
  assert.equal(updated.status, "ready", updated.error);
  assert.equal(updated.render.revision, reopened.revision);
  assert.equal(await desk.videoPath(date, original.revision), originalFile);
  await desk.tick();
  assert.equal(uploads, 1, "updated drafts must never be published by the timer");
  const news = await desk.changeTopic(null, { title: "A local news story", sport: "other", url: report.url, excerpt: report.excerpt }, date);
  assert.equal(news.edition.topics.at(-1).league, "Other news");
});

test("Generate video and Do research can start a new revision directly after publication", async (t) => {
  const { desk } = await fixture(t);
  await desk.tick();
  await desk.work.done;
  const edition = await desk.load(date);
  edition.publication = { status: "published", id: "abc123de_45", url: "https://youtu.be/abc123de_45" };
  await desk.save(edition);
  await desk.run("research", date);
  await desk.work.done;
  const researched = (await desk.view()).edition;
  assert.equal(researched.status, "ready", researched.error);
  assert.equal(researched.manualRevision, true);
  researched.publication = { status: "published", id: "abc123de_46", url: "https://youtu.be/abc123de_46" };
  await desk.save(researched);
  await desk.run("build", date);
  await desk.work.done;
  assert.equal((await desk.view()).edition.status, "ready");
});

test("a topic scheduled on the calendar leads that day's rundown once and is passed to research", async (t) => {
  const asked = [];
  const { desk } = await fixture(t, { research: async (_date, options) => {
    asked.push(options.scheduled);
    return [topic];
  } });
  await desk.reminders.add({ kind: "topic", category: "sports", title: "boozer vs lendeborg who's ROY", date, notes: "lean Boozer" });
  await desk.reminders.add({ kind: "topic", category: "other", title: "GTA 6 trailer", date: "2026-11-17" });
  await desk.reminders.add({ kind: "reminder", title: "Not a story", date });
  await desk.tick();
  await desk.work.done;
  const first = await desk.load(date);
  assert.equal(first.topics[0].title, "boozer vs lendeborg who's ROY");
  assert.equal(first.topics[0].summary, "lean Boozer");
  assert.equal(first.topics[0].selected, true);
  assert.equal(first.topics[0].scheduled.date, date);
  assert.ok(!first.topics.some(({ title }) => title === "GTA 6 trailer" || title === "Not a story"));
  assert.deepEqual(asked[0], [{ title: "boozer vs lendeborg who's ROY", notes: "lean Boozer" }]);

  // Deleting it keeps it out of a later research pass for the same edition.
  first.topics = first.topics.filter(({ scheduled }) => !scheduled);
  first.publication = { status: "published", id: "abc123de_45", url: "https://youtu.be/abc123de_45" };
  await desk.save(first);
  await desk.run("research", date);
  await desk.work.done;
  assert.ok(!(await desk.load(date)).topics.some(({ scheduled }) => scheduled));
  assert.deepEqual((await desk.reminders.view()).due.map(({ title }) => title), ["Not a story"], "story topics never raise notices");
});

test("Other news can be saved when all twenty episode slots are filled", async (t) => {
  const { desk } = await fixture(t);
  for (let index = 0; index < 20; index++) await desk.changeTopic(null, { title: `Story ${index + 1}` }, date);
  const saved = (await desk.changeTopic(null, { title: "A non-sports story", sport: "other" }, date)).edition;
  assert.equal(saved.topics.length, 21);
  assert.equal(saved.topics.at(-1).league, "Other news");
  assert.equal(saved.topics.at(-1).selected, false);
  await assert.rejects(desk.changeTopic(saved.topics.at(-1).id, { selected: true }, date), /Exclude one/u);
});

test("twenty selected story candidates survive saving and deselecting five builds fifteen Shorts, including UFC", async (t) => {
  const counts = [];
  const { desk } = await fixture(t, {
    write: async ({ topics }) => ({ title: topics[0].title, description: "Candidate count proof", segments: [{
      headline: topics[0].title, narration: `${topics[0].title}. A report confirms the details of this candidate story.`, sources: topics[0].sources,
    }] }),
    render: async (episode, output) => {
    const stories = episode.segments.filter((segment) => segment.short !== false);
    counts.push(stories.length);
    await mkdir(path.join(output, "shorts"), { recursive: true });
    await writeFile(path.join(output, "episode.mp4"), "episode test bytes");
    const shorts = [];
    for (const [i, segment] of stories.entries()) {
      const file = `shorts/segment-${String(i + 1).padStart(2, "0")}.mp4`;
      await writeFile(path.join(output, file), `Short ${i + 1}`);
      shorts.push({ segment: i + 1, headline: segment.headline, file, duration: 20 });
    }
    return { duration: 20 * stories.length, shorts };
  } });
  const edition = await desk.load(date);
  const names = "Alpha Bravo Charlie Delta Echo Foxtrot Golf Hotel India Juliet Kilo Lima Mike November Oscar Papa Quebec Romeo Sierra Tango".split(" ");
  edition.topics = names.map((name, i) => ({ ...structuredClone(topic), id: `candidate-${i + 1}`, title: `Candidate ${name}`, league: i === 19 ? "UFC" : "NBA", sport: i === 19 ? "mma" : "basketball",
    sources: [{ ...report, title: `Candidate ${name} report`, excerpt: `Candidate ${name}. A report confirms the details of this candidate story.` }],
  }));
  await desk.save(edition);
  assert.equal((await desk.load(date)).topics.filter(({ selected }) => selected).length, 20);
  await desk.run("build", date); await desk.work.done;
  assert.equal((await desk.load(date)).render.shorts.length, 20);
  assert.equal(desk.normalizeTarget(20), 20);
  assert.throws(() => desk.normalizeTarget(21), /Choose the episode/u);
  const { app } = await createApp({ sports: desk });
  const auth = (req) => process.env.SPORTS_DESK_PASSWORD ? req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD) : req;
  let current = await desk.load(date);
  await auth(request(app).get(`/api/sports/video/${date}/${current.revision}/short/20`)).expect(200);
  for (const candidate of current.topics.slice(0, 5)) await desk.changeTopic(candidate.id, { selected: false }, date);
  await desk.run("build", date); await desk.work.done;
  current = await desk.load(date);
  assert.deepEqual(counts, [20, 15]);
  assert.equal(current.topics.length, 20);
  assert.equal(current.topics.filter(({ selected }) => selected).length, 15);
  assert.equal(current.render.shorts.length, 15);
  assert.ok(current.render.episode.segments.some(({ league }) => league === "UFC"));
  await auth(request(app).get(`/api/sports/video/${date}/${current.revision}/short/15`)).expect(200);
});

test("a new revision of a published edition encodes a playable episode and Short", async (t) => {
  const { desk } = await fixture(t);
  await desk.tick();
  await desk.work.done;
  const publishedEdition = await desk.load(date);
  publishedEdition.publication = { status: "published", id: "abc123de_45", url: "https://youtu.be/abc123de_45" };
  await desk.save(publishedEdition);
  desk.render = (episode, directory, report) => renderEpisode(episode, directory, report, undefined, async (parts, _voice, file) => {
    const rate = 24000;
    const duration = parts.length * 3;
    await writeFile(file, wav(Float32Array.from({ length: Math.ceil(duration * rate) }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / rate) * 0.15), rate));
    return { duration, segments: parts.map((part, index) => ({ ...part, start: index * 3 + 0.1, end: (index + 1) * 3 - 0.1 })) };
  });
  await desk.run("build", date);
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(ready.locked, false);
  const media = await probe(await desk.videoPath(date, ready.revision));
  assert.equal(media.streams.find(({ codec_type }) => codec_type === "video").width, 1920);
  assert.equal(media.streams.find(({ codec_type }) => codec_type === "audio").codec_name, "aac");
  assert.equal(ready.render.shorts.length, 1);
  const short = await probe(await desk.videoPath(date, ready.revision, 1));
  assert.equal(short.streams.find(({ codec_type }) => codec_type === "video").height, 1920);
});

test("a later model timeout retries automatically without rewriting completed stories", async (t) => {
  const calls = [];
  let failSecond = true;
  const { desk } = await fixture(t, { generationRetryDelay: 0, write: async ({ topics }) => {
    assert.equal(topics.length, 1);
    const topic = topics[0];
    calls.push(topic.title);
    if (topic.title === "Second story" && failSecond) { failSecond = false; throw new Error("The local model call timed out."); }
    return { title: topic.title, description: "The reported story.", segments: [{ headline: topic.title, narration: topic.sources[0].excerpt, sources: topic.sources }] };
  } });
  for (const title of ["First story", "Second story"]) await desk.changeTopic(null, { title, url: report.url, excerpt: report.excerpt }, date);
  await desk.run("build", date);
  await desk.work.done;
  assert.equal((await desk.view()).edition.status, "ready");
  assert.equal(Object.keys((await desk.load(date)).scriptCache).length, 2);
  assert.equal((await desk.view()).edition.scriptCache, undefined);
  assert.deepEqual(calls, ["First story", "Second story", "Second story"]);
});

test("a story with no reporting is left out with its reason and the rest of the episode still builds", async (t) => {
  const { desk } = await fixture(t, { write: async ({ topics }) => {
    const topic = topics[0];
    if (topic.title === "GTA 6 drops") throw Object.assign(new Error(`“${topic.title}” has no source, take, or matching feed article, so it was left out of the episode.`), { code: "unsourced" });
    return { title: topic.title, description: "The reported story.", segments: [{ headline: topic.title, narration: report.excerpt, sources: topic.sources }] };
  } });
  await desk.changeTopic(null, { title: "Lead story", url: report.url, excerpt: report.excerpt }, date);
  await desk.changeTopic(null, { title: "GTA 6 drops", summary: "The game is out.", sport: "other" }, date);
  await desk.run("build", date);
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.deepEqual((await desk.load(date)).render.episode.segments.map(({ headline }) => headline), ["Lead story"]);
  const skipped = ready.topics.find(({ title }) => title === "GTA 6 drops");
  assert.match(skipped.skipReason, /left out of the episode/u);
  assert.equal(ready.topics.find(({ title }) => title === "Lead story").skipReason, undefined);
  const edited = (await desk.changeTopic(skipped.id, { summary: "Rockstar confirmed the date." }, date)).edition;
  assert.equal(edited.topics.find(({ id }) => id === skipped.id).skipReason, undefined);
});

test("unsupported numbers keep retrying with correction feedback until the story succeeds", async (t) => {
  let calls = 0;
  const { desk } = await fixture(t, { generationRetryDelay: 0, write: async ({ topics }, options) => {
    if (++calls <= 4) throw new Error("The sports copy contains a number absent from its cited sources. Remove or correct these unsupported numbers: 99.");
    assert.match(options.editorialFeedback, /99/u);
    return { title: "Lead story", description: "The reported story.", segments: [{ headline: "Lead story", narration: report.excerpt, sources: topics[0].sources }] };
  } });
  await desk.changeTopic(null, { title: "Lead story", url: report.url, excerpt: report.excerpt }, date);
  await desk.run("build", date);
  await desk.work.done;
  assert.equal(calls, 5);
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(ready.generationRetry, null);
});

test("a story whose drafts keep failing the fact check is left out and the rest of the show still builds", async (t) => {
  const tries = {};
  const { desk } = await fixture(t, { generationRetryDelay: 0, write: async ({ topics }) => {
    const title = topics[0].title;
    tries[title] = (tries[title] || 0) + 1;
    if (title === "Stubborn story") throw new Error("Sports copy needs editorial review. The name “Silver Slugger Award” is absent from this story's evidence.");
    return { title, description: "The reported story.", segments: [{ headline: title, narration: report.excerpt, sources: topics[0].sources }] };
  } });
  await desk.changeTopic(null, { title: "Lead story", url: report.url, excerpt: report.excerpt }, date);
  await desk.changeTopic(null, { title: "Stubborn story", url: `${report.url}?b`, excerpt: report.excerpt }, date);
  await desk.run("build", date);
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(tries["Stubborn story"], 5);
  assert.equal(tries["Lead story"], 1, "the verified story is reused, not rewritten");
  const stubborn = ready.topics.find(({ title }) => title === "Stubborn story");
  assert.match(stubborn.skipReason, /Left out: its drafts failed the fact check 5 times\. .*Silver Slugger/u);
  assert.equal(ready.topics.find(({ title }) => title === "Lead story").skipReason, undefined);
  assert.equal(ready.generationRetry, null);
  // Saved with the verified scripts: a later build does not redraft it.
  const saved = await desk.load(date);
  assert.ok(Object.values(saved.scriptCache).some((entry) => /Left out/u.test(entry.leftOut || "")));
});

test("a story redraft shows as progress, not as an error", async (t) => {
  const seen = [];
  let calls = 0;
  const gate = Promise.withResolvers();
  const { desk } = await fixture(t, { generationRetryDelay: 0, write: async ({ topics }) => {
    if (++calls === 2) { seen.push((await desk.view()).edition); gate.resolve(); }
    if (calls <= 1) throw new Error("Sports copy needs editorial review. The name “Silver Slugger Award” is absent from this story's evidence.");
    return { title: topics[0].title, description: "The reported story.", segments: [{ headline: topics[0].title, narration: report.excerpt, sources: topics[0].sources }] };
  } });
  await desk.changeTopic(null, { title: "Lead story", url: report.url, excerpt: report.excerpt }, date);
  await desk.run("build", date);
  await gate.promise;
  await desk.work.done;
  const during = seen[0];
  assert.equal(during.generationRetry, null);
  assert.doesNotMatch(during.progress?.message || "", /Retrying|editorial review/u);
  assert.equal((await desk.view()).edition.status, "ready");
});

test("fact-check retries do not use up the retries a render failure gets", async (t) => {
  let writes = 0;
  let renders = 0;
  const { desk } = await fixture(t, {
    generationRetryDelay: 0,
    write: async ({ topics }) => {
      if (++writes <= 4) throw new Error("The sports copy contains a number absent from its cited sources. Remove or correct these unsupported numbers: 99.");
      return { title: "Lead story", description: "The reported story.", segments: [{ headline: "Lead story", narration: report.excerpt, sources: topics[0].sources }] };
    },
    render: async (_episode, output) => {
      if (++renders === 1) throw new Error("The sports render worker stopped unexpectedly.");
      await writeFile(path.join(output, "episode.mp4"), "cut");
      return { duration: 25 };
    },
  });
  await desk.changeTopic(null, { title: "Lead story", url: report.url, excerpt: report.excerpt }, date);
  await desk.run("build", date);
  await desk.work.done;
  const ready = (await desk.view()).edition;
  assert.equal(ready.status, "ready", ready.error);
  assert.equal(renders, 2);
});

test("Stop generation aborts an automatic retry and leaves verified work intact", async (t) => {
  const failed = Promise.withResolvers();
  const { desk } = await fixture(t, { generationRetryDelay: 60000, write: async () => {
    failed.resolve();
    throw new Error("The sports copy contains a number absent from its cited sources.");
  } });
  await desk.changeTopic(null, { title: "Lead story", url: report.url, excerpt: report.excerpt }, date);
  await desk.run("build", date);
  await failed.promise;
  const view = await desk.cancelGeneration(date);
  assert.equal(view.edition.status, "waiting");
  assert.equal(view.edition.buildPaused, true);
  assert.equal(view.edition.error, null);
  assert.equal(desk.work, null);
});

test("the publisher leaves a preview-only archive clip in the local cut", async (t) => {
  let uploads = 0;
  const { desk, clock } = await fixture(t, {
    render: async (_episode, output) => {
      await writeFile(path.join(output, "episode.mp4"), "preview");
      return { duration: 25, footageCredits: [{ previewOnly: true }] };
    },
    upload: async () => { uploads++; },
  });
  await desk.tick();
  await desk.work.done;
  clock(airTime);
  await desk.tick();
  const { edition } = await desk.view();
  assert.equal(edition.status, "ready");
  assert.equal(edition.publication.status, "held");
  assert.match(edition.publication.error, /preview-only ShareAlike/u);
  assert.equal(edition.uploadAvailability.episode, edition.publication.error);
  await assert.rejects(desk.uploadNow("episode", date), /preview-only ShareAlike/u);
  assert.equal(uploads, 0);
  assert.equal(await readFile(await desk.videoPath(date, edition.render.revision), "utf8"), "preview");
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

test("a manual YouTube upload records the episode and a Short without locking the rundown", async (t) => {
  const sent = [];
  const { desk } = await fixture(t, {
    publishEnabled: false,
    upload: async ({ episode: video }) => {
      sent.push({ title: video.title, description: video.description, sources: (video.segments || []).flatMap((segment) => segment.sources || []) });
      return { id: "abc123de_45", url: "https://youtu.be/abc123de_45", privacyStatus: "public" };
    },
    render: async (_episode, output) => {
      await mkdir(path.join(output, "shorts"), { recursive: true });
      await writeFile(path.join(output, "episode.mp4"), "episode");
      await writeFile(path.join(output, "shorts", "segment-01.mp4"), "short");
      await writeFile(path.join(output, "shorts", "segment-01.srt"), "1\n00:00:00,000 --> 00:00:02,000\nLead story\n\n2\n00:00:18,000 --> 00:00:20,000\nThe take\n");
      return {
        duration: 40,
        chapters: [{ start: 0, headline: "Lead story" }, { start: 18, headline: "The take" }],
        shorts: [{ segment: 1, headline: "Lead story", file: "shorts/segment-01.mp4", captions: "shorts/segment-01.srt", duration: 20 }],
      };
    },
  });
  await desk.tick();
  await desk.work.done;
  assert.deepEqual((await desk.view()).edition.uploadAvailability, { episode: null, shorts: { 1: null } });
  const started = await desk.uploadNow("episode", date);
  assert.equal(started.edition.youtube.episode.status, "uploading");
  assert.equal(started.edition.youtube.episode.sessionUrl, undefined);
  assert.equal(started.edition.youtube.episode.title, "Lead story | The Rundown, Nov 16");
  assert.match(started.edition.uploadAvailability.reason, /job is already running/u);
  await desk.work.done;
  const episodeView = await desk.view();
  assert.equal(episodeView.edition.status, "ready");
  assert.equal(episodeView.edition.locked, false);
  assert.equal(episodeView.edition.youtube.episode.status, "published");
  assert.equal(episodeView.edition.youtube.episode.url, "https://youtu.be/abc123de_45");
  assert.match(sent[0].description, /00:00 Lead story\n00:18 The take/);
  const shortStarted = await desk.uploadNow(1, date);
  assert.equal(shortStarted.edition.youtube.shorts["1"].status, "uploading");
  await desk.work.done;
  const done = await desk.view();
  assert.equal(done.edition.status, "ready");
  assert.equal(done.edition.locked, false);
  assert.equal(done.edition.youtube.shorts["1"].status, "published");
  assert.equal(sent[1].title, "Lead story #Shorts");
  assert.doesNotMatch(sent[1].description, /00:00|00:18/, "a Short carries no caption timestamps");
  assert.equal(sent[1].sources[0].url, "https://league.example/reports/lead");
  await assert.rejects(desk.uploadNow("episode", date), /already on YouTube/);
});

test("Upload all sends the episode, then every Short, and the 8 a.m. run does not post the episode again", async (t) => {
  const sent = [];
  const { desk, clock } = await fixture(t, {
    upload: async ({ episode: video }) => {
      sent.push(video.title);
      return { id: `id${sent.length}`, url: `https://youtu.be/id${sent.length}`, privacyStatus: "public" };
    },
    render: async (_episode, output) => {
      await mkdir(path.join(output, "shorts"), { recursive: true });
      await writeFile(path.join(output, "episode.mp4"), "episode");
      for (const segment of [1, 2]) {
        await writeFile(path.join(output, "shorts", `segment-0${segment}.mp4`), "short");
        await writeFile(path.join(output, "shorts", `segment-0${segment}.srt`), "1\n00:00:00,000 --> 00:00:02,000\nLead story\n");
      }
      return {
        duration: 40,
        shorts: [1, 2].map((segment) => ({ segment, headline: "Lead story", file: `shorts/segment-0${segment}.mp4`, captions: `shorts/segment-0${segment}.srt`, duration: 20 })),
      };
    },
  });
  await desk.tick();
  await desk.work.done;
  await desk.uploadAll(date);
  // Each upload hands off to the next when it finishes.
  for (let index = 0; index < 3; index++) {
    while (!desk.work) await new Promise((resolve) => setTimeout(resolve, 5));
    await desk.work.done;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const { edition } = await desk.view();
  assert.equal(edition.youtube.episode.status, "published");
  assert.equal(edition.youtube.shorts["1"].status, "published");
  assert.equal(edition.youtube.shorts["2"].status, "published");
  assert.equal(sent.length, 3);
  await assert.rejects(desk.uploadAll(date), /already on YouTube/u);
  clock(airTime);
  await desk.tick();
  assert.equal(desk.work, null, "the scheduled publish skips an episode already uploaded by hand");
  assert.equal(sent.length, 3);
});

test("a render that fails output validation stops instead of retrying the same cut", async (t) => {
  let renders = 0;
  const { desk } = await fixture(t, {
    generationRetryDelay: 0,
    render: async () => {
      renders++;
      throw new Error("The sports episode did not pass output validation. episode.mp4 was still for 9s.");
    },
  });
  await desk.tick();
  await desk.work.done;
  const { edition } = await desk.view();
  assert.equal(renders, 1);
  assert.equal(edition.status, "failed");
  assert.match(edition.error, /output validation/u);
});

test("the 8 a.m. run uploads the long-form episode, then every Short in order, retrying a failed Short", async (t) => {
  const sent = [];
  let failSecondShort = true;
  const { desk, clock } = await fixture(t, {
    upload: async ({ episode: video }) => {
      if (failSecondShort && /^The take/u.test(video.title)) {
        failSecondShort = false;
        throw new Error("Connection dropped.");
      }
      sent.push(video.title);
      return { id: `id${sent.length}`, url: `https://youtu.be/id${sent.length}`, privacyStatus: "public" };
    },
    render: async (_episode, output) => {
      await mkdir(path.join(output, "shorts"), { recursive: true });
      await writeFile(path.join(output, "episode.mp4"), "episode");
      for (const n of ["01", "02"]) await writeFile(path.join(output, "shorts", `segment-${n}.mp4`), "short");
      return {
        duration: 40,
        chapters: [{ start: 0, headline: "Lead story" }, { start: 18, headline: "The take" }],
        shorts: [
          { segment: 1, headline: "Lead story", file: "shorts/segment-01.mp4", duration: 18 },
          { segment: 2, headline: "The take", file: "shorts/segment-02.mp4", duration: 22 },
        ],
      };
    },
  });
  const settle = async () => { while (desk.work) await desk.work.done; };
  await desk.tick();
  await settle();
  // Before air nothing uploads, and Shorts never go ahead of the episode.
  clock("2026-11-16T13:59:00Z");
  await desk.tick();
  assert.deepEqual(sent, []);
  clock(airTime);
  await desk.tick();
  await settle();
  assert.deepEqual(sent, ["Lead story | The Rundown, Nov 16"]);
  await desk.tick();
  await settle();
  await desk.tick();
  await settle();
  let { edition } = await desk.view();
  assert.deepEqual(sent, ["Lead story | The Rundown, Nov 16", "Lead story #Shorts"]);
  assert.equal(edition.youtube.shorts["1"].status, "published");
  assert.equal(edition.youtube.shorts["2"].status, "failed");
  // A failed Short waits out the retry gap, then goes again.
  clock("2026-11-16T14:02:00Z");
  await desk.tick();
  assert.equal(desk.work, null);
  clock("2026-11-16T14:06:00Z");
  await desk.tick();
  await settle();
  ({ edition } = await desk.view());
  assert.equal(edition.youtube.shorts["2"].status, "published");
  assert.deepEqual(sent.at(-1), "The take #Shorts");
  assert.equal(sent.length, 3);
  // Nothing is uploaded twice.
  clock("2026-11-16T15:30:00Z");
  await desk.tick();
  await settle();
  assert.equal(sent.length, 3);
});

test("once YouTube's daily quota is spent, the remaining Shorts stop for the day", async (t) => {
  const sent = [];
  const { desk, clock } = await fixture(t, {
    upload: async ({ episode: video }) => {
      if (sent.length === 2) throw new Error("YouTube rejected the upload (HTTP 403, quotaExceeded).");
      sent.push(video.title);
      return { id: `id${sent.length}`, url: `https://youtu.be/id${sent.length}`, privacyStatus: "public" };
    },
    render: async (_episode, output) => {
      await mkdir(path.join(output, "shorts"), { recursive: true });
      await writeFile(path.join(output, "episode.mp4"), "episode");
      for (const n of ["01", "02", "03"]) await writeFile(path.join(output, "shorts", `segment-${n}.mp4`), "short");
      return {
        duration: 60,
        shorts: [1, 2, 3].map((segment) => ({ segment, headline: `Story ${segment}`, file: `shorts/segment-0${segment}.mp4`, duration: 20 })),
      };
    },
  });
  const settle = async () => { while (desk.work) await desk.work.done; };
  await desk.tick();
  await settle();
  clock(airTime);
  for (let i = 0; i < 4; i++) { await desk.tick(); await settle(); }
  let { edition } = await desk.view();
  assert.equal(sent.length, 2, "the episode and Short 1 went out");
  assert.equal(edition.youtube.shorts["2"].status, "failed");
  clock("2026-11-16T14:30:00Z");
  for (let i = 0; i < 3; i++) { await desk.tick(); await settle(); }
  ({ edition } = await desk.view());
  assert.equal(edition.youtube.shorts["2"].attempts, 1, "no retries against a spent quota");
  assert.equal(edition.youtube.shorts["3"], undefined);
});

test("Shorts wait while the episode is held and stop after the morning window", async (t) => {
  let uploads = 0;
  const { desk, clock } = await fixture(t, {
    upload: async () => { uploads++; return { id: "x", url: "https://youtu.be/x" }; },
    render: async (_episode, output) => {
      await mkdir(path.join(output, "shorts"), { recursive: true });
      await writeFile(path.join(output, "episode.mp4"), "episode");
      await writeFile(path.join(output, "shorts", "segment-01.mp4"), "short");
      return { duration: 20, shorts: [{ segment: 1, headline: "Lead story", file: "shorts/segment-01.mp4", duration: 20 }] };
    },
  });
  // The episode file disappears after a completed build; publishing must hold
  // its Shorts rather than treating them as an independent release.
  await desk.tick();
  while (desk.work) await desk.work.done;
  await rm(await desk.videoPath(date, (await desk.view()).edition.render.revision));
  clock(airTime);
  await desk.tick();
  await desk.tick();
  assert.equal(uploads, 0);
  clock("2026-11-16T17:00:00Z");
  await desk.tick();
  assert.equal(uploads, 0);
});

test("a failed YouTube upload stays on that video", async (t) => {
  let thumbs = 0;
  const { desk } = await fixture(t, {
    publishEnabled: false,
    upload: async () => { throw new Error("YouTube refused the upload (HTTP 403)."); },
    thumbnail: async () => { thumbs += 1; },
  });
  await desk.tick();
  await desk.work.done;
  await desk.uploadNow("episode", date);
  await desk.work.done;
  const { edition } = await desk.view();
  assert.equal(edition.status, "ready");
  assert.equal(edition.locked, false);
  assert.equal(edition.youtube.episode.status, "failed");
  assert.match(edition.youtube.episode.error, /403/);
  assert.equal(edition.uploadAvailability.episode, null);
  assert.equal(thumbs, 0);
});

test("the practice edition cannot be uploaded", async (t) => {
  const { desk } = await fixture(t, { canResearch: () => false, publishEnabled: false });
  assert.match((await desk.view()).edition.uploadAvailability.reason, /practice edition/u);
  await assert.rejects(desk.uploadNow("episode", date), /practice edition/i);
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

test("the announcer opens each league's block and names the sports in airing order", () => {
  const segments = [
    { headline: "a", league: "NCAAF" }, { headline: "b", league: "NCAAF" },
    { headline: "c", league: "NBA" }, { headline: "d", league: "NBA" },
    { headline: "e", league: "MLB" }, { headline: "f", league: "MLB" },
    { headline: "g", kind: "trend" },
  ];
  assert.deepEqual(announceSports(segments), ["college football", "the NBA", "Major League Baseball"]);
  assert.deepEqual(segments.map(({ bumper }) => bumper || null), [
    "We start with the college football news.", null, "And now for the NBA news.", null, "And now for the MLB news.", null, null,
  ]);
  const mixedCollege = [{ league: "NCAAF" }, { league: "NCAAB" }, { league: null }];
  assert.deepEqual(announceSports(mixedCollege), ["college sports"]);
  assert.equal(mixedCollege[2].bumper, undefined, "a story without a league gets no bumper");
});

function thumbnailsOn(t) {
  const previous = process.env.SPORTS_THUMBNAILS;
  process.env.SPORTS_THUMBNAILS = "on";
  t.after(() => {
    if (previous === undefined) delete process.env.SPORTS_THUMBNAILS;
    else process.env.SPORTS_THUMBNAILS = previous;
  });
}

const published = () => ({ id: "abc123de_45", url: "https://youtu.be/abc123de_45", privacyStatus: "public" });

test("the 8 a.m. episode upload sets the thumbnail on the publication slot", async (t) => {
  thumbnailsOn(t);
  const calls = [];
  const { desk, clock } = await fixture(t, {
    upload: async () => published(),
    thumbnail: async ({ videoId, file }) => { calls.push({ videoId, file }); },
  });
  const settle = async () => { while (desk.work) await desk.work.done; };
  await desk.tick();
  await settle();
  clock(airTime);
  await desk.tick();
  await settle();
  const { edition } = await desk.view();
  assert.equal(edition.publication.status, "published");
  assert.equal(edition.publication.thumbnail.status, "set");
  assert.equal(edition.youtube?.episode?.thumbnail, undefined);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].videoId, "abc123de_45");
  assert.match(calls[0].file, /thumbnails[\\/]episode\.jpg$/u);
});

test("a thumbnail failure leaves the video published", async (t) => {
  thumbnailsOn(t);
  const { desk, clock } = await fixture(t, {
    upload: async () => published(),
    thumbnail: async () => { throw new Error("Thumbnail service down."); },
  });
  const settle = async () => { while (desk.work) await desk.work.done; };
  await desk.tick();
  await settle();
  clock(airTime);
  await desk.tick();
  await settle();
  const { edition } = await desk.view();
  assert.equal(edition.publication.status, "published");
  assert.equal(edition.publication.thumbnail.status, "failed");
  assert.match(edition.publication.thumbnail.error, /Thumbnail service down/);
});

test("an unavailable thumbnail stops later attempts and Shorts still upload", async (t) => {
  thumbnailsOn(t);
  let thumbs = 0;
  const { desk, clock } = await fixture(t, {
    upload: async () => published(),
    thumbnail: async () => {
      thumbs += 1;
      throw new Error("YouTube refused the thumbnail (HTTP 403, forbidden).");
    },
    render: async (_episode, output) => {
      await mkdir(path.join(output, "shorts"), { recursive: true });
      await writeFile(path.join(output, "episode.mp4"), "episode");
      await writeFile(path.join(output, "shorts", "segment-01.mp4"), "short");
      return { duration: 20, shorts: [{ segment: 1, headline: "Lead story", file: "shorts/segment-01.mp4", duration: 20 }] };
    },
  });
  const settle = async () => { while (desk.work) await desk.work.done; };
  await desk.tick();
  await settle();
  clock(airTime);
  await desk.tick();
  await settle();
  assert.equal(thumbs, 1);
  await desk.tick();
  await settle();
  const { edition } = await desk.view();
  assert.equal(edition.publication.status, "published");
  assert.equal(edition.publication.thumbnail.status, "unavailable");
  assert.equal(edition.youtube.thumbnailHalt.reason, "unavailable");
  assert.equal(edition.youtube.shorts["1"].status, "published");
  assert.equal(thumbs, 1);
});

test("a failed thumbnail is retried once after four minutes", async (t) => {
  thumbnailsOn(t);
  let thumbs = 0;
  const { desk, clock } = await fixture(t, {
    upload: async () => published(),
    thumbnail: async () => {
      thumbs += 1;
      if (thumbs === 1) throw new Error("YouTube thumbnail failed (HTTP 503).");
    },
  });
  const settle = async () => { while (desk.work) await desk.work.done; };
  await desk.tick();
  await settle();
  clock(airTime);
  await desk.tick();
  await settle();
  let { edition } = await desk.view();
  assert.equal(edition.publication.thumbnail.status, "failed");
  assert.equal(thumbs, 1);
  clock("2026-11-16T14:03:00Z");
  await desk.tick();
  await settle();
  assert.equal(thumbs, 1);
  clock("2026-11-16T14:05:00Z");
  await desk.tick();
  await settle();
  ({ edition } = await desk.view());
  assert.equal(thumbs, 2);
  assert.equal(edition.publication.thumbnail.status, "set");
  clock("2026-11-16T14:20:00Z");
  await desk.tick();
  await settle();
  assert.equal(thumbs, 2);
});
