import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { root } from "../server/config.mjs";
import { SportsDesk } from "../server/sports/desk.mjs";
import { editorialContext, editorialEdits, normalizeEditorialPlan, questionOnly } from "../server/sports/editorial.mjs";

const date = "2026-11-20";
const story = { id: "story-1", title: "Duke falls to Illinois", selected: true, summary: "Duke fell in the rankings.", take: "", takeScript: "",
  league: "NCAAB", sport: "basketball", teams: ["Duke Blue Devils"],
  sources: [{ title: "Rankings report", publisher: "League", url: "https://league.example/report", excerpt: "Duke fell in the rankings." }],
  script: { headline: "Duke falls to Illinois", narration: "Duke fell in the rankings after Illinois moved ahead." } };

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(root, "data", "editor-chat-test-"));
  const desk = new SportsDesk({ directory, now: () => new Date(`${date}T06:30:00Z`),
    canResearch: () => true, canUpload: () => false, trend: [], rebuildDelay: 60_000,
    chat: async () => { throw new Error("Unexpected model call"); }, ...options });
  t.after(async () => {
    clearTimeout(desk.rebuildTimer);
    assert.ok(path.resolve(directory).startsWith(path.resolve(root, "data") + path.sep));
    await rm(directory, { recursive: true, force: true });
  });
  const edition = await desk.load(date);
  edition.topics = [structuredClone(story)];
  await desk.save(edition);
  const { app } = await createApp({ sports: desk });
  const api = request(app);
  const auth = (req) => process.env.SPORTS_DESK_PASSWORD ? req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD) : req;
  const send = (message, topicId) => auth(api.post("/api/sports/chat")).send({ date, message, ...(topicId && { topicId }) });
  return { desk, send };
}

test("status questions read live generation progress without a model, edit, or rebuild", async (t) => {
  const { desk, send } = await fixture(t);
  const edition = await desk.load(date);
  edition.status = "building";
  edition.error = "A source number needs correction";
  desk.work = { date, progress: { percent: 38, message: "Recording narration" } };
  await desk.save(edition);
  const result = await send("What’s going on?").expect(200);
  const reply = result.body.edition.messages.at(-1).content;
  assert.match(reply, /38%: Recording narration/u);
  assert.match(reply, /source number needs correction/u);
  assert.equal(result.body.edition.revision, edition.revision);
  assert.deepEqual(result.body.edition.topics, edition.topics);
  assert.equal(desk.rebuildTimer, undefined);
});

test("questions remain available on a published edition and receive source evidence", async (t) => {
  let called = false;
  const { desk, send } = await fixture(t, { chat: async (edition, content, id) => {
    called = true;
    assert.equal(edition.editorialState.locked, true);
    assert.equal(id, story.id);
    assert.match(edition.topics[0].sources[0].excerpt, /Duke fell/u);
    return { reply: "The League rankings report says Duke fell in the rankings. Source: https://league.example/report", edits: [] };
  } });
  const edition = await desk.load(date);
  edition.status = "ready";
  edition.publication = { status: "published", id: "published-video" };
  await desk.save(edition);
  const result = await send("What sources support this story?", story.id).expect(200);
  assert.equal(called, true);
  assert.equal(result.body.edition.revision, edition.revision);
  assert.equal(result.body.edition.publication.status, "published");
  assert.equal(desk.rebuildTimer, undefined);
});

test("chat adds non-sports stories with category, supplied source and exact editorial script intact", async (t) => {
  const { desk, send } = await fixture(t, { chat: async () => ({ reply: "Added the technology story.", edits: [{
    title: "A new telescope", summary: "Discuss the announcement", sport: "other", league: "Other news",
    teams: ["Should be cleared"], url: "https://science.example/announcement", excerpt: "The telescope was announced.",
    take: "Science deserves airtime", takeScript: "Science deserves airtime.",
  }] }) });
  const result = await send("Add an Other news story about a telescope. Source https://science.example/announcement says: The telescope was announced.").expect(200);
  const added = result.body.edition.topics[1];
  assert.equal(added.league, "Other news"); assert.equal(added.sport, "other"); assert.deepEqual(added.teams, []);
  assert.equal(added.takeScript, "Science deserves airtime.");
  assert.equal(added.sources[0].excerpt, "The telescope was announced.");
  assert.match(result.body.edition.messages.at(-1).content, /Saved changes:[\s\S]*Added “A new telescope” to Other news/u);
  assert.deepEqual((await desk.load(date)).topics[1], added);
});

test("chat edits persisted reporting, on-air narration, take and footage without losing old sources", async (t) => {
  const { desk, send } = await fixture(t, { chat: async () => ({ reply: "Updated the selected story.", edits: [{
    id: story.id, title: "Duke rankings update", summary: "The latest ranking order", headline: "Duke rankings shift",
    narration: "The rankings report places Illinois ahead of Duke.", take: "Keep the rankings in perspective", takeScript: "Keep these rankings in perspective.",
    url: "https://league.example/followup", excerpt: "Illinois is ahead of Duke.", clipUrl: "https://www.youtube.com/watch?v=abcdefghijk",
  }] }) });
  await send("Update this story and attach https://league.example/followup", story.id).expect(200);
  const edited = (await desk.load(date)).topics[0];
  assert.equal(edited.title, "Duke rankings update");
  assert.equal(edited.script.headline, "Duke rankings shift");
  assert.equal(edited.script.narration, "The rankings report places Illinois ahead of Duke.");
  assert.equal(edited.takeScript, "Keep these rankings in perspective.");
  assert.equal(edited.sources.length, 2); assert.deepEqual(edited.sources[0], story.sources[0]);
  assert.equal(edited.clipUrl, "https://www.youtube.com/watch?v=abcdefghijk");
});

test("take notes save immediately and draft in the background without blocking the chat", { timeout: 10000 }, async (t) => {
  let release;
  let started;
  const drafting = new Promise((resolve) => { started = resolve; });
  const { desk, send } = await fixture(t, { draftTake: () => new Promise((resolve) => { release = resolve; started(); }),
    chat: async () => ({ reply: "Saved your take.", edits: [{ id: story.id, take: "Keep perspective" }] }) });
  const result = await send("Save my take: Keep perspective", story.id).expect(200);
  assert.equal(result.body.edition.topics[0].take, "Keep perspective");
  await drafting;
  assert.equal(typeof release, "function");
  release("We should keep the rankings in perspective.");
  await desk.takeDraft;
  assert.equal((await desk.load(date)).topics[0].takeScript, "We should keep the rankings in perspective.");
});

test("chat changes inclusion and respects twenty slots while still saving a new excluded story", async (t) => {
  let edits = [{ title: "Extra story", league: "Other news", sport: "other" }];
  const { desk, send } = await fixture(t, { chat: async () => ({ reply: "Done.", edits }) });
  const edition = await desk.load(date);
  edition.topics = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(story), id: `story-${i + 1}`, title: `Story ${i + 1}` }));
  await desk.save(edition);
  const result = await send("Add a new Other news story called Extra story").expect(200);
  const added = result.body.edition.topics.at(-1);
  assert.equal(added.selected, false);
  assert.match(result.body.edition.messages.at(-1).content, /excluded; all 20 story slots are occupied/u);
  edits = [{ id: added.id, selected: true }];
  await send("Include Extra story").expect(409);
  assert.equal((await desk.load(date)).topics.at(-1).selected, false);
  edits = [{ id: "story-1", selected: false }, { id: added.id, selected: true }];
  await send("Exclude Story 1 and include Extra story").expect(200);
  assert.equal((await desk.load(date)).topics.at(-1).selected, true);
});

test("an invalid chat batch cannot partially mutate stories or claim completion", async (t) => {
  const { desk, send } = await fixture(t, { chat: async () => ({ reply: "Done.", edits: [
    { id: story.id, title: "Must not save" }, { id: "not-a-story", selected: false },
  ] }) });
  await send("Change both stories").expect(409);
  const edition = await desk.load(date);
  assert.deepEqual(edition.topics, [story]); assert.equal(edition.messages.length, 0);
});

test("a stale edit plan is retried on the current rundown before applying", async (t) => {
  let calls = 0;
  const { desk, send } = await fixture(t, { chat: async (edition) => {
    if (++calls === 1) await desk.changeTopic(story.id, { title: "New title from another edit" }, date);
    else assert.equal(edition.topics[0].title, "New title from another edit");
    return { reply: "Saved.", edits: [{ id: story.id, summary: "Updated notes" }] };
  } });
  await send("Update the notes", story.id).expect(200);
  const edition = await desk.load(date);
  assert.equal(calls, 2); assert.equal(edition.topics[0].title, "New title from another edit");
  assert.equal(edition.topics[0].summary, "Updated notes"); assert.equal(edition.messages.length, 2);
});

test("question context includes reporting and scripts, excludes secrets, and stays bounded", () => {
  const edition = { date, topics: Array.from({ length: 48 }, (_, i) => ({ ...story, id: `story-${i}`, summary: "note ".repeat(240), take: "opinion ".repeat(200) })),
    messages: [], editorialState: { status: "building", progress: { percent: 52, message: "Rendering" } } };
  const context = editorialContext(edition, "What supports this story?", "story-30");
  const focused = context.topics.find(({ id }) => id === "story-30");
  assert.deepEqual(JSON.parse(JSON.stringify(focused.sources)), story.sources); assert.deepEqual(focused.script, story.script);
  assert.equal(context.topics.length, 48); assert.ok(JSON.stringify(context).length <= 24000);
  assert.equal(context.readOnly, true);
  assert.equal(questionOnly("Can you add an Other news story?"), false);
  assert.equal(questionOnly("How do I add a story?"), true);
  assert.equal(questionOnly("What's the status? Also add a new story."), false);
});

test("real local-model add failures cannot overwrite a context story or invent an editorial take", () => {
  const parsed = editorialEdits.parse([{ id: null, title: "A new science story", summary: null, url: "", headline: "", narration: "" }]);
  assert.deepEqual(parsed, [{ title: "A new science story" }]);
  const plan = normalizeEditorialPlan([{ id: story.id, title: "A new science story", take: "An unsolicited opinion", takeScript: "Unasked on-air opinion",
    narration: "Unrequested factual narration.", headline: "Unasked headline", clipUrl: "", excerpt: '"A supplied excerpt."' }],
  'Add a new Other news story titled "A new science story". Source: https://example.com/editorial-chat-proof');
  assert.deepEqual(plan, [{ title: "A new science story", excerpt: "A supplied excerpt." }]);
  const take = { id: story.id, take: "Keep perspective", takeScript: "Keep the rankings in perspective." };
  assert.deepEqual(normalizeEditorialPlan([take], "Save my take notes and on-air take script"), [take]);
  assert.deepEqual(normalizeEditorialPlan([take], "Yes.", [{ role: "user", content: "Save my take notes and on-air take script" }]), [take]);
  assert.deepEqual(normalizeEditorialPlan([{ id: story.id, title: "Stale title", summary: "Previous turn" }],
    'Save my take notes exactly as "Keep perspective" and my on-air take script exactly as "Keep the rankings in perspective."', [], story.id), [take]);
  assert.deepEqual(normalizeEditorialPlan([{ id: story.id, summary: "More reporting context" }], "Add context to this story"), [{ id: story.id, summary: "More reporting context" }]);
  assert.deepEqual(normalizeEditorialPlan([{ id: story.id, narration: "The shorter, supported version of the reporting." }], "Make this story shorter"), [{ id: story.id, narration: "The shorter, supported version of the reporting." }]);
});

test("a focused include or exclude command updates the actual story without relying on a model claim", async (t) => {
  const { desk, send } = await fixture(t);
  await send("Exclude this story from the episode, but keep it in the rundown.", story.id).expect(200);
  assert.equal((await desk.load(date)).topics[0].selected, false);
  const included = await send("Include this story in the episode again.", story.id).expect(200);
  assert.equal(included.body.edition.topics[0].selected, true);
  assert.match(included.body.edition.messages.at(-1).content, /inclusion \(included\)/u);
});
