import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { root } from "../server/config.mjs";
import { SportsDesk } from "../server/sports/desk.mjs";
import { researchConfigured } from "../server/sports/research.mjs";

// Run against the configured LOCAL model through the actual chat HTTP route.
// Use a separate desk directory; never edit the operator's edition or publish.
const modelUrl = URL.parse(process.env.SPORTS_LLM_URL || "");
assert.ok(modelUrl && ["localhost", "127.0.0.1", "[::1]"].includes(modelUrl.hostname), "Configure the normal local model before running this smoke test.");
assert.ok(researchConfigured(), "The local model must be configured.");
await mkdir(path.join(root, ".runtime"), { recursive: true });
const directory = await mkdtemp(path.join(root, ".runtime", "editorial-chat-"));
const desk = new SportsDesk({ directory, canUpload: () => false, publishEnabled: false, trend: [] });
// These proofs exercise chat and persistence; they do not start video builds.
desk.scheduleBuild = () => {};
const date = desk.clock().date;
const edition = await desk.load(date);
edition.topics = [{ id: "baseline-story", title: "Duke rankings update", summary: "A sample story for chat isolation.",
  selected: true, league: "NCAAB", sport: "basketball", take: "", sources: [] }];
await desk.save(edition);
const { app } = await createApp({ sports: desk });
const api = request(app);
const proof = { model: process.env.SPORTS_LLM_MODEL, modelUrl: modelUrl.origin, directory, date, requests: [] };

async function send(message, topicId) {
  const start = Date.now();
  let req = api.post("/api/sports/chat");
  if (process.env.SPORTS_DESK_PASSWORD) req = req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD);
  const response = await req.send({ date, message, ...(topicId && { topicId }) });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const edition = response.body.edition;
  const result = { message, topicId, seconds: Number(((Date.now() - start) / 1000).toFixed(2)), reply: edition.messages.at(-1).content };
  proof.requests.push(result);
  await writeFile(path.join(directory, "proof.json"), JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(result));
  return edition;
}

try {
  console.log(`Testing configured local model: ${proof.model}; isolated desk: ${directory}`);
  await send("What's going on?");
  let current = await send('Add a new Other news story titled "Home networking tips". Set its summary exactly to "A segment about making home Wi-Fi easier to understand." Include it in the rundown. Attach source https://example.com/editorial-chat-proof with this exact quoted excerpt: "Router placement affects Wi-Fi coverage." This is not a sports story.');
  let added = current.topics.find(({ title }) => title === "Home networking tips");
  assert.ok(added, "Chat must actually add the requested story.");
  assert.equal(current.topics.length, 2, "Adding a story must not overwrite the original.");
  assert.equal(current.topics.find(({ id }) => id === "baseline-story").title, "Duke rankings update");
  assert.equal(added.take, "", "Reporting must not become an unsolicited editorial opinion.");
  assert.equal(added.script, undefined, "A new story must not acquire unrequested on-air narration.");
  assert.equal(added.league, "Other news"); assert.equal(added.sport, "other"); assert.equal(added.selected, true);
  assert.equal(added.sources[0].excerpt, "Router placement affects Wi-Fi coverage.");
  current = await send('Change this story title exactly to "Home Wi-Fi explained" and its summary exactly to "Explain router placement and basic connection checks." Leave its category and source alone.', added.id);
  added = current.topics.find(({ id }) => id === added.id);
  assert.equal(added.title, "Home Wi-Fi explained");
  assert.equal(added.summary, "Explain router placement and basic connection checks.");
  assert.equal(added.sources[0].url, "https://example.com/editorial-chat-proof");
  current = await send('Save my editorial take notes exactly as "Good technology reporting should be useful to everyday people." Save my on-air take script exactly as "Good technology reporting should help everyday people solve real problems."', added.id);
  added = current.topics.find(({ id }) => id === added.id);
  assert.equal(added.take, "Good technology reporting should be useful to everyday people.");
  assert.equal(added.takeScript, "Good technology reporting should help everyday people solve real problems.");
  const before = structuredClone(current.topics);
  const revision = current.revision;
  current = await send("What reporting supports this story, and what is my editorial take? Answer only from the saved story; do not change anything.", added.id);
  assert.deepEqual(current.topics, before); assert.equal(current.revision, revision);
  assert.match(current.messages.at(-1).content, /router|placement/iu);
  assert.match(current.messages.at(-1).content, /everyday|useful|solve real problems/iu);
  current = await send("Exclude this story from the episode, but keep it in the rundown.", added.id);
  assert.equal(current.topics.find(({ id }) => id === added.id).selected, false);
  current = await send("Include this story in the episode again.", added.id);
  assert.equal(current.topics.find(({ id }) => id === added.id).selected, true);
  assert.deepEqual((await desk.load(date)).topics, current.topics);
  proof.passed = true;
  console.log(`PASS: seven chat requests, persisted additions and edits, sourced answer, include/exclude; model ${proof.model}.`);
} catch (error) {
  proof.passed = false; proof.error = error.stack;
  throw error;
} finally {
  await writeFile(path.join(directory, "proof.json"), JSON.stringify(proof, null, 2));
  clearTimeout(desk.rebuildTimer);
}
