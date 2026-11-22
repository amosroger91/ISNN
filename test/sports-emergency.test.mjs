import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { EmergencyDesk, readEvents } from "../server/sports/emergency.mjs";

const stream = (...events) => events.map((event) => JSON.stringify(event)).join("\n");

test("Claude's stream-json becomes chat lines, tool calls and the session to resume", () => {
  const read = readEvents(stream(
    { type: "system", subtype: "init", session_id: "abc-123" },
    { type: "assistant", message: { content: [{ type: "text", text: "Looking at the log." }, { type: "tool_use", name: "Bash", input: { command: "tail -n 50 data/logs/desk.log" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", content: "…" }] } },
    "not json",
    { type: "result", subtype: "success", is_error: false, result: "Fixed.", session_id: "abc-123" },
  ));
  assert.equal(read.sessionId, "abc-123");
  assert.equal(read.done, true);
  assert.deepEqual(read.items, [
    { kind: "text", text: "Looking at the log." },
    { kind: "tool", text: "Bash: tail -n 50 data/logs/desk.log" },
  ]);
  assert.equal(readEvents(stream({ type: "result", is_error: true, result: "Credit balance is too low" })).items[0].kind, "error");
});

test("a chat runs one detached Claude turn at a time and resumes the same session", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "isnn-emergency-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const launched = [];
  const living = new Set();
  const desk = new EmergencyDesk({
    directory, root: "C:/repo", claude: "C:/bin/claude.exe",
    launch: async (commandLine, cwd) => { launched.push({ commandLine, cwd }); living.add(launched.length); return launched.length; },
    isAlive: (pid) => living.has(pid),
    stop: async (pid) => { living.delete(pid); },
  });

  const first = (await desk.send("Today's build failed. Fix it.")).chat;
  assert.equal(first.running, true);
  assert.equal(launched[0].cwd, "C:/repo");
  assert.match(launched[0].commandLine, /"C:\/bin\/claude\.exe" -p --output-format stream-json --verbose --dangerously-skip-permissions </u);
  assert.doesNotMatch(launched[0].commandLine, /--resume/u);
  const prompt = readFileSync(path.join(directory, first.id, "prompt-1.txt"), "utf8");
  assert.match(prompt, /restart-desk\.ps1/u);
  assert.match(prompt, /Never upload to YouTube/u);
  assert.match(prompt, /Today's build failed\. Fix it\.$/u);

  await assert.rejects(desk.send("hello?", first.id), { status: 409 });

  writeFileSync(path.join(directory, first.id, "turn-1.jsonl"), stream(
    { type: "system", subtype: "init", session_id: "sess-1" },
    { type: "assistant", message: { content: [{ type: "text", text: "Fixed and restarted." }] } },
    { type: "result", is_error: false, result: "Fixed and restarted.", session_id: "sess-1" },
  ));
  living.delete(1);
  const done = desk.view(first.id).chat;
  assert.equal(done.running, false);
  assert.equal(done.turns[0].items.at(-1).text, "Fixed and restarted.");
  assert.equal(desk.view().chat.id, first.id, "the page reopens the latest chat");

  await desk.send("Is the build running now?", first.id);
  assert.match(launched[1].commandLine, /--resume sess-1 </u);
  assert.equal(readFileSync(path.join(directory, first.id, "prompt-2.txt"), "utf8"), "Is the build running now?");

  const stopped = (await desk.stop(first.id)).chat;
  assert.equal(stopped.running, false);
  assert.equal(stopped.turns[1].items.at(-1).text, "Stopped.");
});

test("a turn whose process died without a result says so, with its error output", async (t) => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "isnn-emergency-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const desk = new EmergencyDesk({ directory, root: "C:/repo", launch: async () => 99, isAlive: () => false });
  const { id } = (await desk.send("help")).chat;
  writeFileSync(path.join(directory, id, "turn-1.err"), "'claude' is not recognized as an internal or external command");
  const turn = desk.view(id).chat.turns[0];
  assert.equal(turn.running, false);
  assert.match(turn.items.at(-1).text, /ended without finishing\. 'claude' is not recognized/u);
});

test("the agent can be switched off and rejects bad chat ids", async (t) => {
  const desk = new EmergencyDesk({ directory: os.tmpdir(), root: "C:/repo", launch: async () => 1 });
  process.env.SPORTS_EMERGENCY_AGENT = "off";
  t.after(() => { delete process.env.SPORTS_EMERGENCY_AGENT; });
  await assert.rejects(desk.send("help"), { status: 403 });
  delete process.env.SPORTS_EMERGENCY_AGENT;
  assert.throws(() => desk.view("../../etc"), { status: 404 });
});
