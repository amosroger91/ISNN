import assert from "node:assert/strict";
import test from "node:test";
import { numberWords, speakableText } from "../server/sports/speech.mjs";

test("Isaac says big numbers as words instead of reading the digits", () => {
  assert.equal(speakableText("He has 1,580 yards this season."), "He has fifteen hundred eighty yards this season.");
  assert.equal(speakableText("A crowd of 12,400 watched."), "A crowd of twelve thousand four hundred watched.");
  assert.equal(speakableText("1,000 yards and 2,005 yards"), "one thousand yards and two thousand five yards");
  assert.equal(speakableText("ran 1580 yards before 25000 fans"), "ran fifteen hundred eighty yards before twenty-five thousand fans");
  assert.equal(speakableText("a 1,580-yard season"), "a fifteen hundred eighty-yard season");
});

test("years, scores and small numbers stay as written", () => {
  assert.equal(speakableText("In 2026 they won 24-17 with 3.5 sacks and 30 points."), "In 2026 they won 24-17 with 3.5 sacks and 30 points.");
});

test("money reads as dollars", () => {
  assert.equal(speakableText("a $45 million contract"), "a forty-five million dollar contract");
  assert.equal(speakableText("fined $300."), "fined three hundred dollars.");
  assert.equal(speakableText("a $2.5 billion bid"), "a two point five billion dollar bid");
});

test("number words cover the full range", () => {
  assert.equal(numberWords(0), "zero");
  assert.equal(numberWords(1100), "eleven hundred");
  assert.equal(numberWords(2000), "two thousand");
  assert.equal(numberWords(101234), "one hundred one thousand two hundred thirty-four");
  assert.equal(numberWords(3000000), "three million");
});
