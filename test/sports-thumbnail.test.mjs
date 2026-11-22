import assert from "node:assert/strict";
import test from "node:test";
import { createCanvas, loadImage } from "../server/canvas.mjs";
import {
  coverStoriesForText, drawThumbnail, encodeThumbnail, fitThumbnailText, inspectThumbnail, logoWells, measureThumbnail,
} from "../server/sports/thumbnail.mjs";

function solid(width, height, color) {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

const stories = [
  { id: "sox", league: "MLB", teams: ["Boston Red Sox"] },
  { id: "lakers", league: "NBA", teams: ["Los Angeles Lakers"] },
];

function photos() {
  return [
    { image: solid(900, 1400, "rgb(80,100,120)"), kind: "person" },
    { image: solid(900, 1400, "rgb(90,110,140)"), kind: "person" },
  ];
}

function whitePixels(canvas) {
  const box = canvas.textBox;
  const data = canvas.getContext("2d").getImageData(box.x, box.y, box.width, box.height).data;
  let white = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (data[index] > 220 && data[index + 1] > 220 && data[index + 2] > 220) white += 1;
  }
  return white;
}

test("an episode thumbnail is a 1280x720 JPEG with readable text, and the same seed matches", async () => {
  const input = {
    kind: "episode", stories, photos: photos(), text: "one two three four five six", date: "2026-11-19",
  };
  const first = await drawThumbnail(input);
  const second = await drawThumbnail({ ...input, photos: photos() });
  const jpeg = await encodeThumbnail(first);
  const again = await encodeThumbnail(second);
  assert.deepEqual(jpeg, again);
  const image = await loadImage(jpeg);
  assert.equal(image.width, 1280);
  assert.equal(image.height, 720);
  assert.ok(jpeg.length < 2 * 1024 * 1024);
  const check = inspectThumbnail(first, jpeg, { width: 1280, height: 720 });
  assert.deepEqual(check.failures, []);
  assert.equal(first.thumbnailText, "ONE TWO THREE FOUR");
  assert.deepEqual(first.logoWells, []);
  assert.ok(whitePixels(first) > 30, `white pixels ${whitePixels(first)}`);
  const decoded = createCanvas(image.width, image.height);
  decoded.getContext("2d").drawImage(image, 0, 0);
  const mean = measureThumbnail(decoded).mean;
  assert.ok(mean >= 40 && mean <= 215, `decoded luminance ${mean}`);
});

test("a Short thumbnail is 1080x1920", async () => {
  const canvas = await drawThumbnail({
    kind: "short",
    stories: [stories[0]],
    photos: [photos()[0]],
    text: "RED SOX 58",
    date: "2026-11-19",
  });
  const jpeg = await encodeThumbnail(canvas);
  const check = inspectThumbnail(canvas, jpeg, { width: 1080, height: 1920 });
  assert.deepEqual(check.failures, []);
  assert.equal(canvas.thumbnailText, "RED SOX 58");
  assert.ok(whitePixels(canvas) > 30);
});

test("no photos still draws a graphic with text", async () => {
  const canvas = await drawThumbnail({
    kind: "episode",
    stories: [{ id: "nba", league: "NBA" }],
    text: "LAKERS WIN AGAIN",
    date: "2026-11-19",
  });
  const jpeg = await encodeThumbnail(canvas);
  const check = inspectThumbnail(canvas, jpeg, { width: 1280, height: 720 });
  assert.deepEqual(check.failures, []);
  assert.equal(canvas.thumbnailText, "LAKERS WIN AGAIN");
  assert.deepEqual(canvas.logoWells, []);
  assert.ok(whitePixels(canvas) > 30);
});

test("a washed-out photo and a black photo both settle into range", async () => {
  for (const color of ["#ffffff", "#000000"]) {
    const canvas = await drawThumbnail({
      kind: "episode",
      stories,
      photos: [{ image: solid(800, 800, color), kind: "team" }],
      text: "BOSTON RED SOX",
      date: "2026-11-19",
    });
    const jpeg = await encodeThumbnail(canvas);
    const check = inspectThumbnail(canvas, jpeg, { width: 1280, height: 720 });
    assert.deepEqual(check.failures, [], color);
  }
});

test("a six-word line keeps four words", () => {
  assert.equal(fitThumbnailText("alpha bravo charlie delta echo foxtrot"), "ALPHA BRAVO CHARLIE DELTA");
});

function pixel(canvas, x, y) {
  return canvas.getContext("2d").getImageData(x, y, 1, 1).data;
}

test("real team marks are large hero elements, with two at most", async () => {
  assert.ok(logoWells("episode", 1, 1280)[0].size >= 300);
  assert.ok(logoWells("short", 1, 1080)[0].size >= 400);
  const canvas = await drawThumbnail({
    kind: "episode",
    stories: [{ id: "duke", league: "NCAAB" }],
    photos: [{ image: solid(900, 600, "rgb(40, 70, 90)"), kind: "team" }],
    text: "DUKE FALLS HARD",
    date: "2026-11-19",
    logos: [
      solid(80, 80, "rgb(220, 20, 20)"),
      solid(80, 80, "rgb(20, 20, 220)"),
      solid(80, 80, "rgb(20, 180, 20)"),
    ],
  });
  assert.equal(canvas.logoWells.length, 2);
  const center = (well) => pixel(canvas, Math.round(well.x + well.size / 2), Math.round(well.y + well.size / 2));
  const left = center(canvas.logoWells[0]);
  const right = center(canvas.logoWells[1]);
  assert.ok(left[0] > 180 && left[1] < 80 && left[2] < 80, `left ${left}`);
  assert.ok(right[2] > 180 && right[0] < 80, `right ${right}`);
  const jpeg = await encodeThumbnail(canvas);
  assert.deepEqual(inspectThumbnail(canvas, jpeg, { width: 1280, height: 720 }).failures, []);
});

test("a Short keeps its logo stamp clear of the headline and photo subject", async () => {
  const canvas = await drawThumbnail({
    kind: "short",
    stories: [{ id: "sox", league: "MLB" }],
    photos: [{ image: solid(800, 1400, "rgb(30, 40, 50)"), kind: "person" }],
    text: "RED SOX 58",
    date: "2026-11-19",
    logos: [solid(64, 64, "rgb(200, 30, 40)")],
  });
  assert.equal(canvas.logoWells.length, 1);
  const well = canvas.logoWells[0];
  assert.ok(well.y + well.size < canvas.textBox.y);
  const mark = pixel(canvas, Math.round(well.x + well.size / 2), Math.round(well.y + well.size / 2));
  assert.ok(mark[0] > 160 && mark[2] < 80, `mark ${mark}`);
  const jpeg = await encodeThumbnail(canvas);
  assert.deepEqual(inspectThumbnail(canvas, jpeg, { width: 1080, height: 1920 }).failures, []);
});

test("an ESPN logo file is refused as the photo and still drawn as a mark", async () => {
  const canvas = await drawThumbnail({
    kind: "episode",
    stories: [{ id: "duke", league: "NCAAB" }],
    photos: [{
      file: "https://a.espncdn.com/i/headshots/nba/players/full/1.png",
      url: "https://a.espncdn.com/i/teamlogos/nba/500/duke.png",
    }],
    text: "DUKE FALLS HARD",
    date: "2026-11-19",
    logos: [solid(48, 48, "rgb(10, 40, 180)")],
  });
  assert.equal(canvas.logoWells.length, 1);
  const well = canvas.logoWells[0];
  const mark = pixel(canvas, Math.round(well.x + well.size / 2), Math.round(well.y + well.size / 2));
  assert.ok(mark[2] > 140 && mark[0] < 80, `mark ${mark}`);
});

test("the cover hook selects its story even when that story is later in the rundown", () => {
  const stories = [
    { headline: "Lakers win again", teams: ["Los Angeles Lakers"], sport: "basketball" },
    { headline: "Duke falls to Illinois", teams: ["Duke Blue Devils", "Illinois Fighting Illini"], sport: "basketball" },
    { headline: "New telescope reveals distant galaxies", league: "Other news", sport: "other" },
  ];
  assert.deepEqual(coverStoriesForText("DUKE FALLS HARD", stories), [stories[1]]);
  assert.deepEqual(coverStoriesForText("DISTANT GALAXIES REVEALED", stories), [stories[2]]);
});

test("long words stay inside both layouts without losing the hook", async () => {
  for (const kind of ["episode", "short"]) {
    const canvas = await drawThumbnail({ kind, text: "CHAMPIONSHIP EXPECTATIONS SHIFT AGAIN",
      logos: [solid(80, 80, "#15387d")], stories: [{ league: "Other news" }] });
    const box = canvas.textBox;
    assert.equal(canvas.thumbnailText, "CHAMPIONSHIP EXPECTATIONS SHIFT AGAIN");
    assert.ok(box.x >= 0 && box.y >= 0);
    assert.ok(box.x + box.width <= canvas.width);
    assert.ok(box.y + box.height < canvas.height);
    const logo = canvas.logoWells[0];
    assert.ok(box.x + box.width < logo.x || box.y > logo.y + logo.size);
  }
});
