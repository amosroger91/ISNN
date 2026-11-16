import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { crc32 } from "node:zlib";
import { root } from "../server/config.mjs";
import { AssetCache, logoUrl, pngSize } from "../server/sports/assets.mjs";
import { applySummary, normalizeEvent } from "../server/sports/espn/normalize.mjs";
import { FALLBACK, planShots } from "../server/sports/rights.mjs";
import { espnEvidence, loadEspnBodies } from "./espn-harness.mjs";

const quiet = () => {};

function png(width, height) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, sum]);
  };
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const imageResponse = (body, status = 200, type = "image/png") => new Response(body, {
  status,
  headers: type ? { "content-type": type } : {},
});

async function directoryFor(t) {
  const directory = await mkdtemp(path.join(root, "data", "espn-assets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const pngFiles = async (directory) => (await readdir(directory, { recursive: true })).filter((name) => String(name).endsWith(".png") && !String(name).endsWith(".png.tmp"));

test("the same logo is stored once, marked unlicensed, and never offered to the shot planner", async (t) => {
  const directory = await directoryFor(t);
  const bytes = png(32, 32);
  let fetches = 0;
  const cache = new AssetCache({
    root: directory, gapMs: 0, backoffMs: 1, log: quiet,
    fetchImpl: async (url, init) => {
      fetches += 1;
      assert.equal(init.redirect, "manual");
      assert.equal(init.headers["User-Agent"], "ISNN-Overtime-Desk");
      if (url.endsWith("/bad.png")) return imageResponse("not an image, just text that is long enough to reject");
      if (url.endsWith("/same.png")) return imageResponse(bytes);
      assert.equal(url, "https://a.espncdn.com/i/teamlogos/nba/500/den.png");
      if (fetches < 3) return imageResponse("busy", 503, "text/plain");
      return imageResponse(bytes);
    },
  });
  const first = await cache.store({ url: "https://a.espncdn.com/i/teamlogos/nba/500/den.png", leagueKey: "nba", kind: "team", entityId: "7" });
  const second = await cache.store({ url: "https://a.espncdn.com/i/teamlogos/nba/500/den.png", leagueKey: "nba", kind: "team", entityId: "7" });
  assert.equal(fetches, 3);
  assert.equal(first.sha256, second.sha256);
  assert.equal(first.licenseStatus, "unlicensed");
  assert.equal(first.grantId, null);
  assert.equal(first.width, 32);
  assert.equal((await pngFiles(directory)).length, 1);

  const shared = await cache.store({ url: "https://a.espncdn.com/i/teamlogos/nba/500/same.png", leagueKey: "nba", kind: "team", entityId: "8" });
  assert.equal(shared.shared, true);
  assert.equal(shared.sha256, first.sha256);
  assert.equal(shared.file, first.file);
  assert.equal((await pngFiles(directory)).length, 1);

  const refused = await cache.store({ url: "https://watch.auth.api.espn.com/logo.png", leagueKey: "nba", kind: "team", entityId: "9" });
  assert.equal(refused.miss, true);
  assert.equal(fetches, 4);
  const junk = await cache.store({ url: "https://a.espncdn.com/i/teamlogos/nba/500/bad.png", leagueKey: "nba", kind: "team", entityId: "10" });
  assert.equal(junk.reason, "not a usable png");
  const again = await cache.store({ url: "https://a.espncdn.com/i/teamlogos/nba/500/bad.png", leagueKey: "nba", kind: "team", entityId: "10" });
  assert.equal(again.reason, "not a usable png");
  assert.equal(fetches, 5, "a bad image is one recorded miss");

  const plan = planShots({ eventId: "401909980" }, {
    catalog: {
      assets: [{ id: first.sha256, eventId: "401909980", sha256: first.sha256, grantId: null, status: "ready", captureTime: first.retrieved, credit: "ESPN" }],
      grants: [],
    },
    channel: "isnn-youtube",
    airAt: "2026-11-16T12:00:00Z",
  });
  assert.equal(plan.episode.kind, "Fallback");
  assert.equal(plan.episode.fallback, FALLBACK);
  assert.equal(plan.episode.reasons[0].code, "no-grant");
  assert.equal(pngSize(png(1, 1)), null);
});

test("logo paths follow the verified CDN layout and only a pitched leader is cached", async (t) => {
  assert.equal(logoUrl("nba", { id: "7", short: "DEN" }), "https://a.espncdn.com/i/teamlogos/nba/500/den.png");
  assert.equal(logoUrl("mlb", { id: "10", short: "NYY" }), "https://a.espncdn.com/i/teamlogos/mlb/500/nyy.png");
  assert.equal(logoUrl("ncaab", { id: "150", short: "LSU" }), "https://a.espncdn.com/i/teamlogos/ncaa/500/150.png");
  assert.equal(logoUrl("ncaaf", { id: "99", short: "TEX" }), "https://a.espncdn.com/i/teamlogos/ncaa/500/99.png");
  const bodies = await loadEspnBodies();
  const event = bodies["basketball/nba"][20261114].events.find((item) => item.id === "401909980");
  const game = normalizeEvent(event, "nba");
  assert.equal(game.leaders[0].playerId, "3112335");
  assert.equal(game.leaders[0].headshot, undefined);
  applySummary(game, bodies.summary);
  assert.equal(game.leaders[0].headshot, "https://a.espncdn.com/i/headshots/nba/players/full/3112335.png");
  assert.equal(JSON.stringify(game.reports[0].payload).includes("headshot"), false);

  const directory = await directoryFor(t);
  const seen = [];
  const cache = new AssetCache({
    root: directory, gapMs: 0, backoffMs: 1, log: quiet,
    fetchImpl: async (url) => {
      seen.push(url);
      return imageResponse(png(16, 16));
    },
  });
  const saved = await cache.cacheGame(game);
  assert.deepEqual(seen, [
    "https://a.espncdn.com/i/teamlogos/nba/500/no.png",
    "https://a.espncdn.com/i/teamlogos/nba/500/den.png",
    "https://a.espncdn.com/i/headshots/nba/players/full/3112335.png",
  ]);
  assert.equal(saved.length, 3);
  assert.ok(saved.every((item) => item.licenseStatus === "unlicensed" && item.grantId === null));
});

test("the image cap drops an old unreferenced file and keeps one the edition names", async (t) => {
  const directory = await directoryFor(t);
  let clock = new Date("2026-10-01T00:00:00Z");
  const cache = new AssetCache({
    root: directory, now: () => clock, capBytes: 80, gapMs: 0, backoffMs: 1, log: quiet,
    fetchImpl: async (url) => imageResponse(png(url.endsWith("old.png") ? 16 : 20, 16)),
  });
  const old = await cache.store({ url: "https://a.espncdn.com/i/teamlogos/nba/500/old.png", leagueKey: "nba", kind: "team", entityId: "1" });
  clock = new Date("2026-11-16T00:00:00Z");
  const kept = await cache.store({ url: "https://a.espncdn.com/i/teamlogos/nba/500/new.png", leagueKey: "nba", kind: "team", entityId: "2" });
  const cleaned = await cache.cleanup({ referenced: new Set([kept.sha256]) });
  assert.equal(cleaned.deleted, 1);
  assert.equal((await pngFiles(directory)).length, 1);
  assert.equal((await cache.records()).some((record) => record.sha256 === old.sha256), false);
  assert.equal((await cache.records()).some((record) => record.sha256 === kept.sha256), true);
});

test("a pitched slate still returns when the asset cache fails", async (t) => {
  const directory = await directoryFor(t);
  let calls = 0;
  const evidence = await espnEvidence({
    cacheDir: directory,
    assets: {
      cacheGame: async () => {
        calls += 1;
        throw new Error("disk full");
      },
    },
  });
  const games = await evidence.listGames({ date: "2026-11-15" });
  assert.ok(games.some((game) => game.id === "401909980"));
  assert.ok(calls > 0);
});
