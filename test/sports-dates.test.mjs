import assert from "node:assert/strict";
import test from "node:test";
import { openingIntro, spokenDate, writtenDate } from "../server/sports/dates.mjs";

test("the intro date is written in full and spoken in English", () => {
  assert.equal(writtenDate("2026-11-16"), "November 16, 2026");
  assert.equal(spokenDate("2026-11-16"), "November sixteenth, twenty twenty-six");
  assert.equal(spokenDate("2026-11-01"), "November first, twenty twenty-six");
  assert.equal(spokenDate("2026-03-22"), "March twenty-second, twenty twenty-six");
  const intro = openingIntro("2026-11-16");
  assert.match(intro, /It’s November sixteenth, twenty twenty-six\./);
  assert.doesNotMatch(intro, /\|/);
  assert.doesNotMatch(intro, /2026-11-16/);
  assert.doesNotMatch(writtenDate("2026-11-16"), /\|/);
});

test("the opening names the sports on today's show before handing to Isaac", () => {
  const intro = openingIntro("2026-11-17", ["college football", "the NBA", "Major League Baseball"]);
  assert.match(intro, /On today’s show: college football, the NBA, and Major League Baseball\. Here’s your host, Isaac Doss\.$/u);
  assert.match(openingIntro("2026-11-17", ["the NBA", "the NFL"]), /On today’s show: the NBA and the NFL\./u);
  assert.doesNotMatch(openingIntro("2026-11-17"), /today’s show/u);
});
