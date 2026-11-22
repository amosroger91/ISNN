import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { teamsInText } from "../server/sports/footage.mjs";
import { defaultLogoHref, directoryTeamsInText, loadEspnDirectory, logosForTitle, teamsFromDirectoryBody } from "../server/sports/team-logos.mjs";

const manifest = {
  teams: {
    Duke: { name: "Duke Blue Devils", short: "DUKE", file: "duke.png" },
    Houston: { name: "Houston Cougars", short: "HOU", file: "houston.png" },
    Kansas: { name: "Kansas Jayhawks", short: "KU", file: "kansas.png" },
    Florida: { name: "Florida Gators", short: "FLA", file: "gators.png" },
    FSU: { name: "Florida State Seminoles", short: "FSU", file: "fsu.png" },
    Michigan: { name: "Michigan Wolverines", short: "MICH", file: "michigan.png" },
    "Michigan State": { name: "Michigan State Spartans", short: "MSU", file: "msu.png" },
    Texas: { name: "Texas Longhorns", short: "TEX", file: "texas.png" },
    "Texas A&M": { name: "Texas A&M Aggies", short: "TAMU", file: "tamu.png" },
    Knicks: { name: "New York Knicks", short: "NY", file: "knicks.png" },
  },
};

function names(logos) {
  return logos.map((logo) => logo.name);
}

test("official league directories cover teams outside the footage alias list", async () => {
  const requests = [];
  const logos = await logosForTitle("Baltimore Ravens enter a new chapter", {
    manifest: { teams: {} }, stories: [{ league: "NFL", sport: "football" }],
    directoryFor: async (league) => {
      assert.equal(league, "nfl");
      return [{ id: "33", displayName: "Baltimore Ravens", shortDisplayName: "Ravens", name: "Ravens", color: "241773",
        logos: [{ href: "https://a.espncdn.com/i/teamlogos/nfl/500/bal.png", rel: ["default"] }] },
      { id: "1", displayName: "Atlanta Falcons", name: "Falcons", logos: [] }];
    },
    download: async (request) => { requests.push(request); return "ravens.png"; },
    exists: async (file) => file === "ravens.png",
  });
  assert.deepEqual(names(logos), ["Baltimore Ravens"]);
  assert.equal(logos[0].color, "#241773");
  assert.equal(requests.length, 1);
  assert.match(requests[0].url, /\/nfl\/500\/bal.png$/u);
});

test("directory name matching keeps longer college names and skips unrelated teams", () => {
  const records = [
    { id: "1", displayName: "Michigan Wolverines", shortDisplayName: "Michigan" },
    { id: "2", displayName: "Michigan State Spartans", shortDisplayName: "Michigan State" },
    { id: "3", displayName: "Florida State Seminoles", shortDisplayName: "Florida State" },
    { id: "4", displayName: "Florida Gators", shortDisplayName: "Florida" },
  ];
  assert.deepEqual(directoryTeamsInText("Michigan State and Florida State", records).map(({ id }) => id), ["2", "3"]);
  assert.deepEqual(directoryTeamsInText("New telescope reveals galaxies", records), []);
});

test("a title names clubs in reading order and does not split a longer name", () => {
  assert.deepEqual(teamsInText("Michigan State rolls").map((team) => team.canonical), ["michigan state spartans"]);
  assert.deepEqual(teamsInText("Houston Astros even the series").map((team) => team.canonical), ["houston astros"]);
  assert.deepEqual(teamsInText("Florida State fires the coach").map((team) => team.canonical), ["florida state seminoles"]);
  assert.deepEqual(
    teamsInText("Texas beats Texas A&M").map((team) => team.canonical),
    ["texas longhorns", "texas am aggies"],
  );
  assert.deepEqual(
    teamsInText("Texas A&M beats Texas").map((team) => team.canonical),
    ["texas am aggies", "texas longhorns"],
  );
  assert.deepEqual(teamsInText("No scoreboard yet").map((team) => team.canonical), []);
  assert.deepEqual(
    teamsInText("Tennessee Smothers Michigan State MICHIGAN STATE SPARTANS").map((team) => team.canonical),
    ["tennessee volunteers", "michigan state spartans"],
  );
  assert.deepEqual(
    teamsInText("Houston upsets No. 1 Florida HOUSTON COUGARS").map((team) => team.canonical),
    ["houston cougars", "florida gators"],
  );
});

test("a plate or manifest mark is used before a directory fetch", async () => {
  const directoryFor = () => {
    throw new Error("directory should not be fetched");
  };
  const fromPlate = await logosForTitle("Duke falls at home", {
    manifest,
    fetchMissing: true,
    directoryFor,
    exists: async (file) => file === "duke.png",
    stories: [{
      league: "NCAAB",
      sport: "basketball",
      plate: {
        away: { name: "Texas Longhorns", logo: "texas.png" },
        home: { name: "Duke Blue Devils", logo: "duke.png" },
      },
    }],
  });
  assert.deepEqual(fromPlate.map((logo) => logo.file), ["duke.png"]);

  const fromManifest = await logosForTitle("Knicks even the series", {
    manifest,
    directoryFor,
    exists: async (file) => file === "knicks.png",
    stories: [{ league: "NBA", sport: "basketball" }],
  });
  assert.deepEqual(fromManifest.map((logo) => logo.file), ["knicks.png"]);
});

test("Michigan State does not take the Michigan mark, and Florida State does not take Florida", async () => {
  const exists = async (file) => ["msu.png", "duke.png", "fsu.png", "michigan.png", "gators.png"].includes(file);
  const state = await logosForTitle("Michigan State rolls past Duke", {
    manifest,
    fetchMissing: false,
    exists,
    stories: [{ league: "NCAAB", sport: "basketball" }],
  });
  assert.deepEqual(names(state), ["michigan state spartans", "duke blue devils"]);
  assert.deepEqual(state.map((logo) => logo.file), ["msu.png", "duke.png"]);

  const seminoles = await logosForTitle("Florida State stays home", {
    manifest,
    fetchMissing: false,
    exists,
    stories: [{ league: "NCAAF", sport: "football" }],
  });
  assert.deepEqual(seminoles.map((logo) => logo.file), ["fsu.png"]);
});

test("two marks is the cap, in reading order, and a dead directory still returns a cover list", async () => {
  const capped = await logosForTitle("Kansas beats Duke and Houston", {
    manifest,
    fetchMissing: false,
    exists: async () => true,
    stories: [{ league: "NCAAB", sport: "basketball" }],
  });
  assert.deepEqual(names(capped), ["kansas jayhawks", "duke blue devils"]);

  const missed = await logosForTitle("Gonzaga wins again", {
    manifest: { teams: {} },
    directoryFor: async () => {
      throw new Error("down");
    },
    download: async () => {
      throw new Error("down");
    },
  });
  assert.deepEqual(missed, []);
});

test("a missing mark downloads the default full png for the story's league", async () => {
  const calls = [];
  const logos = await logosForTitle("Ohio State stays perfect", {
    manifest: { teams: {} },
    stories: [{ league: "NCAAF", sport: "football", teams: ["Ohio State"] }],
    exists: async (file) => file === "ohio.png",
    directoryFor: async (key) => {
      calls.push(key);
      if (key !== "ncaaf") return [];
      return [
        {
          id: "130",
          displayName: "Michigan Wolverines",
          shortDisplayName: "Michigan",
          nickname: "Wolverines",
          abbreviation: "MICH",
          logos: [{ href: "https://a.espncdn.com/i/teamlogos/ncaa/500/130.png", rel: ["full", "default"] }],
        },
        {
          id: "194",
          displayName: "Ohio State Buckeyes",
          shortDisplayName: "Ohio State",
          nickname: "Buckeyes",
          abbreviation: "OSU",
          logos: [
            { href: "https://evil.example/osu.png", rel: ["full", "default"] },
            { href: "https://a.espncdn.com/i/teamlogos/ncaa/500-dark/194.png", rel: ["full", "dark", "default"] },
            { href: "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png", rel: ["full", "default"] },
          ],
        },
      ];
    },
    download: async (request) => {
      calls.push(request);
      return "ohio.png";
    },
  });
  assert.deepEqual(logos.map((logo) => logo.file), ["ohio.png"]);
  assert.equal(calls[0], "ncaaf");
  assert.equal(calls[1].entityId, "194");
  assert.equal(calls[1].url, "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png");
});

test("the directory cache keeps the default png and skips a dark or foreign url", async () => {
  const body = {
    sports: [{
      leagues: [{
        teams: [{
          team: {
            id: 194,
            displayName: "Ohio State Buckeyes",
            shortDisplayName: "Ohio State",
            nickname: "Buckeyes",
            abbreviation: "OSU",
            logos: [
              { href: "https://evil.example/osu.png", rel: ["full", "default"] },
              { href: "https://a.espncdn.com/i/teamlogos/ncaa/500-dark/194.png", rel: ["full", "dark"] },
              { href: "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png", rel: ["full", "default"] },
            ],
          },
        }],
      }],
    }],
  };
  const slim = teamsFromDirectoryBody(body);
  assert.equal(slim.length, 1);
  assert.equal(defaultLogoHref(slim[0]), "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png");
  const root = await mkdtemp(path.join(tmpdir(), "isnn-logos-"));
  let fetches = 0;
  try {
    const fetchImpl = async () => {
      fetches += 1;
      return { ok: true, json: async () => body };
    };
    const first = await loadEspnDirectory("ncaaf", { root, fetchImpl, now: () => Date.parse("2026-11-19T12:00:00Z") });
    const second = await loadEspnDirectory("ncaaf", {
      root,
      fetchImpl: async () => {
        throw new Error("cache miss");
      },
      now: () => Date.parse("2026-11-20T12:00:00Z"),
    });
    assert.equal(fetches, 1);
    assert.equal(second[0].id, first[0].id);
    assert.equal(defaultLogoHref(second[0]), "https://a.espncdn.com/i/teamlogos/ncaa/500/194.png");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
