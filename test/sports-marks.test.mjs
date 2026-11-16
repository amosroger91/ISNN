import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { root } from "../server/config.mjs";
import { platesFor } from "../server/sports/marks.mjs";

test("marks follow the verified game IDs and scores and do not use off-league or partial player matches", async (t) => {
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(path.join(data, "marks-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const files = ["nba/teams/7.png", "nba/teams/18.png", "ncaab/teams/18.png", "nba/players/3062679.png"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await writeFile(path.join(directory, file), "");
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify({
    teams: {
      unrelated: { id: "18", file: files[2] },
      Nuggets: { id: "7", short: "DEN", score: 1, file: files[0] },
      Knicks: { id: "18", short: "NY", score: 2, file: files[1] },
    },
    players: { "Josh Hart": { id: "3062679", file: files[3], line: "Stale score" } },
  }));
  const game = { league: "NBA", status: "final", scoreStates: [{ home: 112, away: 99 }], participants: [
    { id: "18", role: "home", name: "New York Knicks", short: "NY" },
    { id: "7", role: "away", name: "Denver Nuggets", short: "DEN" },
  ] };
  const topics = [
    { id: "game", eventId: "game", title: "Josh Hart helps the Knicks", teams: ["Knicks", "Nuggets"] },
    { id: "near", league: "NBA", title: "Josh Hartman speaks", teams: ["Knicks"] },
  ];
  const plates = await platesFor(topics, { gameFor: () => game, assetDirectory: directory });
  assert.equal(plates.get("game").away.score, 99);
  assert.equal(plates.get("game").home.score, 112);
  assert.equal(plates.get("game").home.logo, path.join(directory, files[1]));
  assert.equal(plates.get("game").leader.name, "Josh Hart");
  assert.equal(plates.get("game").leader.line, "");
  assert.equal(plates.get("near").home.score, null);
  assert.equal(plates.get("near").leader, null);
});
