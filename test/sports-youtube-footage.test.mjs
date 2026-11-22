import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dataDir, ffmpegPath } from "../server/config.mjs";
import { run } from "../server/process.mjs";
import { verifySeasonTiming, verifySupportedNames } from "../server/sports/copy-checks.mjs";
import { YouTubeFootage, youtubeCandidate, youtubeQueries, youtubeVideoId } from "../server/sports/youtube-footage.mjs";

const segment = {
  headline: "LSU falls to Texas", narration: "LSU lost to Texas.", league: "NCAAF",
  footage: { sport: "football", teams: ["LSU", "Texas"], gameDate: "2026-11-14" },
};
const video = { id: "abc123de_45", title: "LSU vs Texas | College Football Highlights", channel: "College Football", duration: 600 };

test("YouTube links accept only video IDs on YouTube hosts", () => {
  assert.equal(youtubeVideoId("https://youtu.be/abc123de_45?t=30"), video.id);
  assert.equal(youtubeVideoId("https://www.youtube.com/watch?v=abc123de_45&list=PLtest"), video.id);
  assert.equal(youtubeVideoId("https://www.youtube.com/shorts/abc123de_45"), video.id);
  for (const url of ["https://youtube.com.evil.test/watch?v=abc123de_45", "https://www.youtube.com/playlist?list=PLtest", "https://user:pass@youtube.com/watch?v=abc123de_45", "file:///etc/passwd"]) assert.equal(youtubeVideoId(url), null);
});

test("YouTube search uses story subjects and rejects unrelated games, gaming, other sports and off-field clips", () => {
  assert.match(youtubeQueries(segment)[0], /lsu tigers vs texas longhorns football 2026-11-14 highlights/u);
  assert.equal(youtubeCandidate(segment, video).type, "broll", "upload dates cannot verify an exact game");
  for (const title of ["Alabama vs Georgia | College Football Highlights", "LSU Football Press Conference", "LSU vs Texas Madden Football Highlights", "LSU vs Texas Basketball Highlights", "LSU vs Texas NCAA 26 Football Highlights"]) {
    assert.equal(youtubeCandidate(segment, { ...video, title }), null, title);
  }
  assert.equal(youtubeCandidate(segment, { ...video, is_live: true }), null);
  assert.equal(youtubeCandidate(segment, { ...video, title: "Georgia Football Highlights", description: "Watch LSU vs Texas next" }), null);
  const texas = { headline: "Texas prepares", footage: { sport: "football", teams: ["Texas"] } };
  assert.equal(youtubeCandidate(texas, { ...video, title: "Texas Tech Football Highlights" }), null);
});

test("searches once per query, downloads only a bounded HD section, and reuses the cache", async (t) => {
  await mkdir(dataDir, { recursive: true });
  const directory = await mkdtemp(path.join(dataDir, "youtube-footage-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, "fixture.mp4");
  await run(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=1280x720:d=0.5", "-c:v", "libx264", "-preset", "ultrafast", "-an", fixture]);
  const calls = [];
  const finder = new YouTubeFootage(directory, { cacheDir: path.join(directory, "cache"), runImpl: async (_executable, args) => {
    calls.push(args);
    assert.ok(args.includes("--ignore-config"));
    if (args.includes("--dump-single-json")) return JSON.stringify({ entries: [video] });
    assert.equal(args[args.indexOf("--download-sections") + 1], "*0-30");
    assert.match(args[args.indexOf("--format") + 1], /height>=720/u);
    assert.equal(args.at(-1), "https://www.youtube.com/watch?v=abc123de_45");
    await copyFile(fixture, args[args.indexOf("--output") + 1]);
    return "";
  } });
  const items = await finder.candidates(segment, true);
  const count = calls.length;
  await finder.candidates(segment, true);
  assert.equal(calls.length, count);
  const file = await finder.download(items[0]);
  assert.equal(file, path.join(directory, "cache", `${video.id}.mp4`));
  assert.equal(await finder.download(items[0]), file);
  const secondBuild = new YouTubeFootage(directory, { cacheDir: path.join(directory, "cache"), runImpl: async () => { throw new Error("cached videos must not download twice"); } });
  assert.equal(await secondBuild.download(items[0]), file);
  assert.equal(calls.length, count + 1);
});

test("Other news searches its actual subject and rejects unrelated sports and news videos", () => {
  const news = { headline: "NASA completes engine test", footage: { sport: "other", topicTitle: "NASA completes engine test" } };
  assert.deepEqual(youtubeQueries(news), ["NASA completes engine test news footage"]);
  assert.equal(youtubeCandidate(news, { ...video, title: "NASA engine test footage", channel: "NASA" }).type, "broll");
  assert.equal(youtubeCandidate(news, { ...video, title: "NASA holds a briefing on a different mission", channel: "NASA" }), null);
  assert.equal(youtubeCandidate(news, video), null);
});

test("unavailable downloads leave graphics available and an aborted search stops immediately", async (t) => {
  const finder = new YouTubeFootage(dataDir, { runImpl: async () => { throw new Error("YouTube unavailable"); } });
  t.mock.method(console, "warn", () => {});
  assert.deepEqual(await finder.candidates(segment, true), []);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(finder.candidates(segment, true, controller.signal), /abort/iu);
});

test("invented team names are rejected even when their numbers are sourced", () => {
  const sources = [{ title: "Arkansas State fires Butch Jones: Red Wolves part with coach", excerpt: "Arkansas State dropped to 4-6." }];
  assert.throws(() => verifySupportedNames("The Arkansas Lions fired Butch Jones after a 4-6 start.", sources), /Arkansas Lions/u);
  assert.throws(() => verifySupportedNames("The Arkansas Lions fired Butch Jones.", [...sources, { title: "The Lions play in another league", excerpt: "" }]), /Arkansas Lions/u, "separately sourced words cannot be combined into a new team");
  assert.doesNotThrow(() => verifySupportedNames("Arkansas State fired Butch Jones. The Red Wolves dropped to 4-6.", sources));
  assert.doesNotThrow(() => verifySupportedNames("Butch Jones's departure follows a loss.", sources));
  assert.doesNotThrow(() => verifySupportedNames("Texas Tech's Thomas Castellanos surges.", [{ title: "Thomas Castellanos surges", excerpt: "He has reinvigorated Texas Tech." }]));
  const coaches = [{ title: "Big Ten coaching outlook", excerpt: "Lincoln Riley and Matt Rhule face scrutiny." }];
  for (const phrase of ["Coaches Lincoln Riley", "Coach Lincoln Riley", "Head Coach Lincoln Riley", "Former Coach Matt Rhule"]) {
    assert.doesNotThrow(() => verifySupportedNames(`${phrase} faces scrutiny.`, coaches), phrase);
  }
  assert.throws(() => verifySupportedNames("Coaches Lincoln Lions face scrutiny.", coaches), /Lincoln Lions/u);
});

test("an ongoing team's current record cannot be presented as a completed season", () => {
  const sources = [{ title: "Arkansas State fires Butch Jones amid 4-6 record in sixth season", excerpt: "Arkansas State just dropped to 4-6 after a loss." }];
  assert.throws(() => verifySeasonTiming("Jones was fired after a 4-6 season.", sources), /ongoing season/u);
  assert.doesNotThrow(() => verifySeasonTiming("Jones was fired with the team at 4-6.", sources));
  assert.doesNotThrow(() => verifySeasonTiming("Jones led the team to success after an 8-5 season.", sources));
});

test("footage shows the story's own matchup, not a team the copy passes by", async () => {
  const { useTeamDirectory } = await import("../server/sports/footage.mjs");
  useTeamDirectory("football", [
    { displayName: "UCLA Bruins", shortDisplayName: "UCLA", name: "Bruins", nickname: "UCLA" },
    { displayName: "Northwestern Wildcats", shortDisplayName: "Northwestern", name: "Wildcats", nickname: "Northwestern" },
  ]);
  useTeamDirectory("basketball", [
    { displayName: "Kentucky Wildcats", shortDisplayName: "Kentucky", name: "Wildcats", nickname: "Kentucky" },
    { displayName: "North Carolina Tar Heels", shortDisplayName: "North Carolina", name: "Tar Heels", nickname: "North Carolina" },
    { displayName: "Northern Arizona Lumberjacks", shortDisplayName: "N Arizona", name: "Lumberjacks", nickname: "N Arizona" },
    { displayName: "St. John's Red Storm", shortDisplayName: "St John's", name: "Red Storm", nickname: "St John's" },
    { displayName: "UL Monroe Warhawks", shortDisplayName: "UL Monroe", name: "Warhawks", nickname: "UL Monroe" },
  ]);
  useTeamDirectory("basketball", [{ displayName: "Memphis Grizzlies", shortDisplayName: "Grizzlies", name: "Grizzlies", nickname: "Grizzlies" }], { pro: true });
  const clip = (title) => ({ id: "abc123de_45", duration: 600, title, channel: "ESPN College Football Basketball NBA" });

  const ucla = {
    headline: "UCLA vs. Michigan: Five things to watch", league: "NCAAF",
    narration: "UCLA has avoided Indiana and Ohio State. Michigan lost twice.",
    footage: { sport: "football", topicTitle: "UCLA vs. Michigan: Five things to watch as Bruins fight to stay undefeated" },
  };
  assert.match(youtubeQueries(ucla)[0], /ucla bruins/u);
  assert.doesNotMatch(youtubeQueries(ucla).join(" "), /ohio state/u);
  assert.equal(youtubeCandidate(ucla, clip("No. 2 Ohio State Buckeyes vs. No. 3 Michigan Wolverines Highlights")), null);
  assert.equal(youtubeCandidate(ucla, clip("Michigan vs Northwestern Football Highlights")), null, "a matchup story takes only that matchup");
  assert.ok(youtubeCandidate(ucla, clip("UCLA vs Michigan Football Highlights")));
  assert.ok(youtubeCandidate(ucla, clip("UCLA Bruins Football Highlights")));

  const blueBloods = {
    headline: "Kentucky and Duke face early-season struggles", league: "NCAAB",
    narration: "Kentucky lost to Northern Arizona. Illinois and Michigan State both beat Duke.",
    footage: { sport: "basketball", topicTitle: "Blue blood panic meter: concerns facing Duke, North Carolina and Kentucky" },
  };
  assert.equal(youtubeCandidate(blueBloods, clip("Illinois vs Michigan State | Full Game Highlights")), null, "neither team is the story's");
  assert.ok(youtubeCandidate(blueBloods, clip("Kentucky vs Northern Arizona | Basketball Highlights")));

  const lsu = {
    headline: "SEC warns of boycotts if LSU plays RJ Luis", league: "NCAAB", narration: "LSU may roster RJ Luis.",
    footage: { sport: "basketball", topicTitle: "SEC frustrated over LSU's RJ Luis: boycotts considered if Will Wade puts ex-St. John's star on court" },
  };
  assert.equal(youtubeCandidate(lsu, clip("LSU vs Fairleigh Dickinson Highlights | NCAA Women's Basketball 2026")), null, "a men's story never runs a women's game");
  assert.ok(youtubeCandidate(lsu, clip("LSU Tigers vs UL Monroe Highlights | NCAA Men's Basketball")), "a former school is not a matchup");

  const rookies = {
    headline: "Lendeborg and Boozer", league: "NBA", narration: "Two rookies compared.",
    footage: { sport: "basketball", teams: ["Golden State Warriors", "Memphis Grizzles"], topicTitle: "Yaxel Lendeborg and Cam Boozer" },
  };
  assert.ok(youtubeCandidate(rookies, clip("WARRIORS at GRIZZLIES | FULL GAME HIGHLIGHTS")), "a misspelled research team still matches");

  const sparks = {
    headline: "Vanessa Bryant denies ownership bid", league: "WNBA", narration: "The WNBA's Sparks are for sale.",
    footage: { sport: "basketball", topicTitle: "Vanessa Bryant and the Los Angeles Sparks" },
  };
  assert.ok(youtubeCandidate(sparks, clip("Connecticut Sun vs. Los Angeles Sparks | FULL GAME HIGHLIGHTS")));
});

test("footage from seasons ago is out and last season ranks below this one", () => {
  const story = { headline: "LSU falls to Texas", narration: "LSU lost to Texas.", league: "NCAAF", footage: { sport: "football", teams: ["LSU", "Texas"], gameDate: "2026-11-14" } };
  const clip = (title) => youtubeCandidate(story, { id: "abc123de_45", duration: 600, title, channel: "College Football" });
  assert.equal(clip("LSU vs Texas Football Highlights (12/5/2009)"), null);
  assert.equal(clip("LSU vs Texas | 2024 College Football Highlights"), null);
  assert.ok(clip("LSU vs Texas | 2025 College Football Highlights").score < clip("LSU vs Texas | 2026 College Football Highlights").score);
});

test("a season range counts as the year it ended", () => {
  const story = { headline: "LSU falls to Texas", narration: "LSU lost to Texas.", league: "NCAAF", footage: { sport: "football", teams: ["LSU", "Texas"], gameDate: "2026-11-14" } };
  assert.ok(youtubeCandidate(story, { id: "abc123de_45", duration: 600, title: "LSU vs Texas Highlights | 2025-26 College Football", channel: "College Football" }));
  assert.ok(youtubeCandidate(story, { id: "abc123de_45", duration: 600, title: "LSU vs Texas Highlights | 2024-25 College Football", channel: "College Football" }));
});
