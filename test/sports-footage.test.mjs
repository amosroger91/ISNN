import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import test from "node:test";
import { archiveCandidates, classifyFootage, CommonsFootage, commonsVideo, footageCue, footageQueries, footageSubjects, sportClip } from "../server/sports/footage.mjs";

const segment = {
  headline: "Garrett Cooper hits a home run as the Miami Marlins face the New York Mets",
  narration: "The Miami Marlins faced the New York Mets. Garrett Cooper hit a home run.",
  footage: { sport: "baseball", gameDate: "2023-03-31", teams: ["Miami Marlins", "New York Mets"], people: ["Garrett Cooper"] },
};
const item = {
  title: "Garrett Cooper home run",
  description: "Garrett Cooper hits a home run during the Miami Marlins and New York Mets baseball game.",
  categories: "Videos of baseball",
  date: "2023-03-31",
};

function commonsPage({ pageid = 10, title = "Garrett Cooper home run", date = "2023-03-31", license = "CC0", credit = "<span>Own work</span>", artist = "Camera operator" } = {}) {
  return { pageid, title: `File:${title}.webm`, imageinfo: [{
    mime: "video/webm", size: 20_000, url: `https://upload.wikimedia.org/wikipedia/commons/${pageid}.webm`,
    descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(title)}.webm`,
    extmetadata: {
      LicenseShortName: { value: license }, Credit: { value: credit }, Artist: { value: artist },
      ImageDescription: { value: item.description }, DateTimeOriginal: { value: date }, Categories: { value: "Videos of baseball" },
    },
  }] };
}

test("an exact event and action beat archival footage of the same person, and unrelated footage is rejected", () => {
  assert.equal(classifyFootage(segment, item), "exact");
  assert.equal(classifyFootage(segment, { ...item, date: "2020-04-03" }), "broll");
  assert.equal(classifyFootage(segment, { ...item, title: "Alex Green pitching", description: "Alex Green pitching in a baseball game." }), null);
  assert.equal(classifyFootage(segment, { ...item, description: "A training session for baseball players." }), null);
  const title = { ...item, type: "exact" };
  const phrases = [{ start: 5, text: "The teams faced off." }, { start: 8, text: "Garrett Cooper hit a home run." }];
  assert.equal(footageCue(title, phrases, 5), 8);
  assert.equal(footageCue({ ...title, type: "broll" }, phrases, 5), 5);
});

test("rejects incompatible or unverified source files", () => {
  assert.equal(commonsVideo(commonsPage()).license, "CC0");
  assert.equal(commonsVideo(commonsPage({ license: "CC BY-SA 4.0" })), null);
  assert.equal(commonsVideo(commonsPage({ credit: "ESPN TV broadcast" })), null);
  assert.equal(commonsVideo(commonsPage({ pageid: "../../x" })), null);
});

test("Commons lookup requires no credentials and ranks an exact clip above B-roll", async () => {
  const finder = new CommonsFootage("unused", async (url, options) => {
    assert.equal(options.headers.Authorization, undefined);
    assert.match(new URL(url).searchParams.get("gsrsearch"), /filetype:video/u);
    return Response.json({ query: { pages: [commonsPage({ pageid: 20, date: "2019-05-11" }), commonsPage()] } });
  });
  const found = await finder.candidates(segment, true);
  assert.deepEqual(found.map(({ type }) => type), ["exact", "broll"]);
});

test("searches team aliases from the rundown even if the on-air copy omits them", () => {
  const story = {
    headline: "A thin market for power bats", narration: "Toronto is looking for a hitter.",
    footage: { sport: "baseball", teams: ["Blue Jays"], topicTitle: "Where can the Blue Jays turn?" },
  };
  assert.ok(footageQueries(story).includes('filetype:video "toronto blue jays" baseball pitch'));
  assert.ok(footageQueries(story).includes('filetype:video "blue jays" baseball batting'));
  assert.ok(footageQueries(story).includes('filetype:video "toronto blue jays" baseball'));
  const clip = {
    title: "Pitch and Bat", description: "A 2014 Blue Jay baseball game", categories: "2014 Toronto Blue Jays season",
  };
  assert.equal(classifyFootage(story, clip), "broll");
  assert.equal(classifyFootage(story, { ...clip, description: "Toronto Blue Jays warming-up before a game." }), null);
  assert.equal(classifyFootage(story, {
    title: "Sideline report", description: "Commentators dance before the broadcast.",
    categories: "Toronto Blue Jays vs Boston Red Sox baseball game",
  }), null);
  assert.equal(classifyFootage(story, {
    title: "Outside the park", description: "Blue Jays fans outside the stadium before the baseball game.",
    categories: "Toronto Blue Jays",
  }), null);
});

test("football b-roll has to be the team playing, not a crowd at the stadium", () => {
  const lsu = {
    headline: "Lane Kiffin created LSU's championship expectations",
    narration: "The Tigers collapsed against Texas.",
    footage: { sport: "football", teams: ["LSU", "Texas"], topicTitle: "Lane Kiffin and LSU" },
  };
  assert.equal(classifyFootage(lsu, {
    title: "Tiger Stadium on game day",
    description: "People dancing in drag in front of the newsstand at the LSU stadium.",
    categories: "LSU Tigers football",
  }), null);
  assert.equal(classifyFootage(lsu, {
    title: "Outside Tiger Stadium",
    description: "Fans gather at LSU before the football game against Texas.",
    categories: "LSU Tigers football",
  }), null);
  assert.equal(classifyFootage(lsu, {
    title: "LSU stops the run",
    description: "An LSU linebacker tackles the ball carrier during the football game.",
    categories: "LSU Tigers football games",
  }), "broll");
  assert.equal(classifyFootage(lsu, {
    title: "2024-0901 Dari Nowkhah Jordan Rodgers Mad Apple",
    description: "Dari Nowkhah, reading a report on the sideline of Allegiant Stadium before the 2024 Vegas Kickoff Classic for the SEC Network as members of Cirque du Soleil's Mad Apple and commentator Jordan Rodgers dance.",
    categories: "LSU Tigers vs USC|Dancing people in the United States|SEC Network",
  }), null);
  assert.equal(classifyFootage(lsu, {
    title: "Vegas Kickoff Classic",
    description: "Scenes at Allegiant Stadium before LSU plays in the Kickoff Classic.",
    categories: "LSU Tigers football",
  }), null);
  assert.ok(footageQueries(lsu).includes('filetype:video "lsu tigers" football touchdown'));
  assert.ok(footageQueries(lsu).includes('filetype:video "lane kiffin" football'));
});

test("recognizes Commons Ogg video metadata while excluding audio files", () => {
  const page = commonsPage();
  page.title = "File:Game action.ogv";
  page.imageinfo[0].mime = "application/ogg";
  assert.ok(commonsVideo(page));
  page.title = "File:Radio commentary.oga";
  assert.equal(commonsVideo(page), null);
});

test("an explicitly pinned ShareAlike archive clip can appear as relevant B-roll in a local preview", async () => {
  const page = commonsPage({ license: "CC BY-SA 3.0", date: "2014-04-18" });
  const clipUrl = page.imageinfo[0].descriptionurl;
  const finder = new CommonsFootage("unused", async () => Response.json({ query: { pages: [page] } }));
  const pinned = { ...segment, footage: { ...segment.footage, clipUrl } };
  const [clip] = await finder.candidates(pinned, false);
  assert.equal(clip.type, "broll");
  assert.equal(clip.previewOnly, true);
  assert.deepEqual(await finder.candidates(segment, true), []);
  assert.deepEqual(await finder.candidates({ ...pinned, footage: { ...pinned.footage, sport: "football" } }, false), []);
});

test("the reviewed archive matches teams or named players without requiring a clip pin", async () => {
  for (const [sport, teams, headline, expected] of [
    ["football", ["LSU", "Texas"], "Lane Kiffin and Texas", "archive-texas-tennessee-2026"],
    ["basketball", ["Michigan State", "Duke"], "Michigan State climbs", "archive-michigan-state-gonzaga-2022"],
    ["basketball", ["Knicks"], "The Knicks and Josh Hart", "archive-knicks-spurs-finals-2026"],
    ["baseball", ["Blue Jays"], "The market for power bats", "archive-blue-jays-red-sox-2014"],
  ]) {
    const story = { headline, footage: { sport, teams } };
    const [clip] = archiveCandidates(story, true);
    assert.equal(clip.id, expected);
    assert.equal(clip.type, "broll");
    await access(clip.file);
  }
  const hart = { headline: "Josh Hart struggles", footage: { sport: "basketball", people: ["Josh Hart"] } };
  assert.equal(archiveCandidates(hart)[0].id, "archive-knicks-spurs-finals-2026");
  assert.ok(footageQueries(hart).includes('filetype:video "josh hart" basketball'));
  assert.deepEqual(archiveCandidates({ footage: { sport: "basketball", teams: ["Duke"] } }), []);
  assert.deepEqual(archiveCandidates({ footage: { sport: "baseball", teams: ["Blue Jays"] } }), []);
});

test("a story names its teams from the copy, and a game title counts as play", () => {
  const story = {
    headline: "Tennessee tops No. 2 Michigan State",
    narration: "The Volunteers smothered the Spartans.",
    footage: { sport: "basketball" },
  };
  assert.ok(footageSubjects(story).some((subject) => subject.aliases.includes("michigan state")));
  assert.equal(classifyFootage(story, {
    title: "Michigan State vs Gonzaga",
    description: "Michigan State and Gonzaga play a basketball game.",
    categories: "Basketball games",
  }), "broll");
  assert.equal(classifyFootage({
    headline: "Fans outside the stadium",
    footage: { sport: "football", teams: ["LSU", "Texas"] },
  }, {
    title: "Outside Tiger Stadium",
    description: "Fans gather at LSU before the football game against Texas.",
    categories: "LSU Tigers football",
  }), null);
});

test("public-domain game film is usable and a highlight rip is not", () => {
  const film = commonsPage({
    license: "Public domain", credit: "Library of Congress", artist: "Library of Congress",
    title: "Princeton vs Yale football game 1903", pageid: 44,
  });
  film.imageinfo[0].size = 54_000_000;
  const kept = commonsVideo(film);
  assert.equal(kept.license, "Public domain");
  assert.equal(kept.transcode, true);
  assert.equal(commonsVideo(commonsPage({ license: "Public domain", credit: "YouTube : FOX COLLEGE FOOTBALL HIGHLIGHTS" })), null);
  assert.equal(commonsVideo(commonsPage({ license: "CC BY 4.0", credit: "ESPN broadcast" })), null);
  assert.equal(commonsVideo(commonsPage({ license: "CC BY 2.5" })).license, "CC BY 2.5");
});

test("a story with no matching team never gets another team's archive game", async () => {
  const duke = sportClip({ headline: "Duke falls to Illinois at home", league: "NCAAB", footage: { sport: "basketball" } });
  assert.equal(duke, null);
  const nba = sportClip({ headline: "The Sparks sale talks continue", league: "NBA", footage: { sport: "basketball" } });
  assert.equal(nba, null);
  const state = sportClip({ headline: "Tennessee tops No. 2 Michigan State", footage: { sport: "basketball" } });
  assert.equal(state.id, "archive-michigan-state-gonzaga-2022");
  assert.equal(state.sportFallback, undefined);
  assert.equal(sportClip({ headline: "A thin market", footage: { sport: "baseball", teams: ["Blue Jays"] } }), null);
});
