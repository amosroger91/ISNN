import assert from "node:assert/strict";
import test from "node:test";
import { fallbackListing, finishListing, hashtag, hashtagsFor, keywordTags, titleWithTags } from "../server/sports/metadata.mjs";

const episode = {
  date: "2026-11-18",
  segments: [
    { league: "NCAAF", headline: "Trev Alberts takes over Michigan amid department turmoil", narration: "Trev Alberts has accepted the athletic director job at Michigan. The Wolverines want stability.", footage: { teams: ["Michigan Wolverines"] } },
    { league: "NBA", headline: "LeBron James denies asking 76ers for patience", narration: "LeBron James denied the report. He is scoring a career-low 18 points a game.", footage: { teams: ["Philadelphia 76ers"] } },
    { league: "MLB", headline: "Jake Bauers signs four-year, $58 million deal with Red Sox", narration: "Jake Bauers signed a four-year, $58 million deal with Boston after hitting 26 home runs.", footage: { teams: ["Boston Red Sox"] } },
  ],
};

test("every video gets its own title, a description from its story and relevant hashtags", () => {
  const listing = finishListing(episode, {
    episode: { title: "Michigan's new AD, LeBron's denial and a Red Sox deal", description: "Michigan hires Trev Alberts. LeBron James denies a report. The Red Sox sign Jake Bauers.", topics: ["Free Agency"] },
    shorts: [
      { number: 1, title: "Michigan hires Trev Alberts as athletic director", description: "Trev Alberts takes over at Michigan.", thumbnail: "MICHIGAN WOLVERINES", topics: ["Trev Alberts"] },
      // A number that is not in the story copy: the headline is used instead.
      { number: 2, title: "LeBron James scoring 25 a night, denies report", description: "LeBron denies it.", thumbnail: "LEBRON SCORES 25", topics: [] },
      // The same title as Short 1: repeated titles fall back to the story's own headline.
      { number: 3, title: "Michigan hires Trev Alberts as athletic director", description: "Jake Bauers signs a four-year, $58 million deal.", thumbnail: "BOSTON RED SOX 58", topics: ["Free Agency"] },
    ],
  });
  assert.equal(listing.episode.title, "Michigan's new AD, LeBron's denial and a Red Sox deal | The Rundown, Nov 18");
  assert.match(listing.episode.description, /^Michigan hires Trev Alberts\./u);
  assert.doesNotMatch(listing.episode.description, /•/u, "the chapters list the headlines; the hook stands alone");
  const long = finishListing(episode, { episode: { description: `Michigan hires Trev Alberts. ${"LeBron James denies a report and the Red Sox sign Jake Bauers ".repeat(8)}.` }, shorts: [] });
  assert.ok(Array.from(long.episode.description).length <= 280);
  assert.deepEqual(listing.episode.hashtags, ["#CollegeFootball", "#NBA", "#MLB", "#WellspringMediaSports", "#SportsNews", "#FreeAgency"]);
  assert.deepEqual(listing.shorts.map(({ title }) => title), [
    "Michigan hires Trev Alberts as athletic director",
    "LeBron James denies asking 76ers for patience",
    "Jake Bauers signs four-year, $58 million deal with Red Sox",
  ]);
  const titles = [listing.episode.title, ...listing.shorts.map(({ title }) => title)];
  assert.equal(new Set(titles).size, titles.length);
  assert.equal(listing.shorts[1].description, "LeBron denies it.");
  assert.deepEqual(listing.shorts[0].hashtags, ["#Shorts", "#CollegeFootball", "#CFB", "#MichiganWolverines", "#TrevAlberts", "#WellspringMediaSports"]);
  assert.ok(listing.shorts[2].hashtags.includes("#BostonRedSox"));
  assert.equal(titleWithTags(listing.shorts[2].title, listing.shorts[2].hashtags, { short: true }), "Jake Bauers signs four-year, $58 million deal with Red Sox #Shorts #MLB");
  assert.equal(listing.shorts[1].thumbnail, "PHILADELPHIA 76ERS", "25 is not in the copy");
  assert.equal(listing.shorts[2].thumbnail, "BOSTON RED SOX 58");
  const lines = [listing.episode.thumbnail, ...listing.shorts.map(({ thumbnail }) => thumbnail)];
  assert.equal(new Set(lines.map((line) => line.toLowerCase())).size, lines.length);
});

test("without the model, titles and descriptions come from the headlines and the aired copy", () => {
  const listing = fallbackListing(episode);
  assert.equal(listing.episode.title, "Trev Alberts takes over Michigan | The Rundown, Nov 18", "a second headline would pass 100 characters");
  assert.match(listing.episode.description, /^Isaac Doss runs through the morning's sports news: college football, the NBA, and Major League Baseball\./u);
  assert.equal(listing.shorts[1].description, "LeBron James denied the report. He is scoring a career-low 18 points a game.");
  assert.equal(finishListing(episode, null).shorts[0].title, episode.segments[0].headline);
  assert.equal(listing.shorts[2].thumbnail, "BOSTON RED SOX 58");
});

test("thumbnail lines keep only numbers from the copy and do not repeat", () => {
  const listing = finishListing(episode, {
    episode: { title: "Morning rundown", description: "Three stories.", thumbnail: "SAME LINE HERE" },
    shorts: [
      { number: 1, thumbnail: "SAME LINE HERE", title: "Michigan hires Trev Alberts as athletic director", description: "At Michigan." },
      { number: 2, thumbnail: "LEBRON SCORES 25", title: "LeBron denies the report", description: "He denied it." },
      { number: 3, thumbnail: "BOSTON RED SOX 58", title: "Jake Bauers signs with Boston", description: "Four years." },
    ],
  });
  assert.equal(listing.episode.title, "Morning rundown | The Rundown, Nov 18");
  assert.equal(listing.episode.thumbnail, "SAME LINE HERE");
  assert.notEqual(listing.shorts[0].thumbnail, "SAME LINE HERE");
  assert.equal(listing.shorts[1].thumbnail, "PHILADELPHIA 76ERS");
  assert.equal(listing.shorts[2].thumbnail, "BOSTON RED SOX 58");
  const lines = [listing.episode.thumbnail, ...listing.shorts.map(({ thumbnail }) => thumbnail)];
  assert.equal(new Set(lines.map((line) => line.toLowerCase())).size, lines.length);
});

test("hashtags are letters and digits only, and keyword tags stay under YouTube's limit", () => {
  assert.equal(hashtag("Philadelphia 76ers"), "#Philadelphia76ers");
  assert.equal(hashtag("Texas A&M"), "#TexasAM");
  assert.equal(hashtag("Ja'Marr Chase"), "#JaMarrChase");
  assert.equal(hashtag("76ers"), null);
  assert.deepEqual(hashtagsFor([{ league: "NBA" }, { league: "NBA" }]), ["#NBA", "#WellspringMediaSports", "#SportsNews"]);
  const tags = keywordTags(Array.from({ length: 60 }, (_, index) => `#Tag${index}LongerWordsHere`), []);
  assert.ok(tags.join(",").length <= 500);
});
