import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createCanvas } from "../server/canvas.mjs";
import { root } from "../server/config.mjs";
import { commonsPhoto, photoLicense, storyImagery } from "../server/sports/imagery.mjs";

const segment = {
  headline: "Jake Bauers homers for the Boston Red Sox",
  narration: "Jake Bauers drove in the run for the Boston Red Sox.",
  footage: { sport: "baseball", teams: ["Boston Red Sox"], people: ["Jake Bauers"] },
};

function page({
  pageid, title, license = "CC BY 4.0", description, artist = "Camera operator", date = "2024-06-01",
  width = 1600, height = 1000, mime = "image/jpeg", restrictions = "",
} = {}) {
  const file = /\.(?:jpe?g|png)$/iu.test(title) ? title : `${title}.jpg`;
  const metadata = {
    LicenseShortName: { value: license },
    Artist: { value: artist },
    ImageDescription: { value: description },
    DateTimeOriginal: { value: date },
  };
  if (restrictions) metadata.Restrictions = { value: restrictions };
  return {
    pageid, title: `File:${file}`,
    imageinfo: [{
      mime, width, height,
      thumburl: `https://upload.wikimedia.org/wikipedia/commons/thumb/${pageid}.jpg`,
      descriptionurl: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file)}`,
      extmetadata: metadata,
    }],
  };
}

const pages = [
  page({ pageid: 1, title: "Jake Bauers batting", license: "Public domain", description: "Jake Bauers swings at a pitch for the Red Sox.", date: "2018-04-02", artist: "Public photographer" }),
  page({ pageid: 2, title: "Red Sox game action", license: "CC BY 4.0", description: "The Boston Red Sox infielder swings during the baseball game.", date: "2024-08-12", artist: "Team photographer" }),
  page({ pageid: 3, title: "ShareAlike swing", license: "CC BY-SA 4.0", description: "Jake Bauers swings at a pitch.", date: "2024-08-01" }),
  page({ pageid: 4, title: "Boston Red Sox logo", license: "CC BY 4.0", description: "Boston Red Sox player swings at a pitch.", date: "2024-08-01" }),
  page({ pageid: 5, title: "Tiny frame", license: "CC BY 4.0", description: "Jake Bauers swings at a pitch.", width: 400, height: 300 }),
  page({ pageid: 6, title: "Restricted swing", license: "CC BY 4.0", description: "Jake Bauers swings at a pitch.", restrictions: "trademarked" }),
  page({ pageid: 7, title: "Narrow swing.png", license: "CC0", description: "Jake Bauers swings at a pitch.", mime: "image/png", width: 800, height: 1600 }),
];

async function temporary(t) {
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(path.join(data, "sports-imagery-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("keeps CC BY 2.5 and PD-USGov and rejects ShareAlike", () => {
  assert.equal(photoLicense("CC BY 2.5").license, "CC BY 2.5");
  assert.match(photoLicense("CC BY 2.5").licenseUrl, /\/by\/2\.5\/?$/u);
  assert.equal(photoLicense("PD-USGov").license, "PD-USGov");
  assert.equal(photoLicense("CC BY-SA 4.0"), null);
  assert.equal(photoLicense("CC BY-NC 4.0"), null);
  const subjects = [{ aliases: ["jake bauers"], team: false }, { aliases: ["boston red sox", "red sox"], team: true }];
  const by = commonsPhoto(page({ pageid: 11, title: "Licensed swing", license: "CC BY 2.5", description: "Jake Bauers swings at a pitch." }), subjects, "baseball");
  const gov = commonsPhoto(page({ pageid: 12, title: "Agency swing", license: "PD-USGov", description: "Jake Bauers swings at a pitch.", artist: "U.S. Government" }), subjects, "baseball");
  assert.equal(by.license, "CC BY 2.5");
  assert.equal(gov.license, "PD-USGov");
  assert.equal(commonsPhoto(page({ pageid: 13, title: "Shared swing", license: "CC BY-SA 3.0", description: "Jake Bauers swings at a pitch." }), subjects, "baseball"), null);
});

test("ranks a named person ahead of team gameplay and drops logos, ShareAlike, restrictions and small files", async (t) => {
  const directory = await temporary(t);
  const jpeg = createCanvas(64, 48);
  jpeg.getContext("2d").fillRect(0, 0, 64, 48);
  const bytes = jpeg.toBuffer("image/jpeg");
  let searches = 0;
  const photos = await storyImagery(segment, {
    directory, allowPreview: true, duration: 8,
    fetchImpl: async (url) => {
      const href = String(url);
      if (href.startsWith("https://upload.wikimedia.org/")) {
        return new Response(bytes, { status: 200, headers: { "content-type": "image/jpeg" } });
      }
      searches += 1;
      assert.match(new URL(href).searchParams.get("gsrsearch"), /filetype:bitmap/u);
      return Response.json({ query: { pages } });
    },
  });
  assert.ok(searches > 0);
  assert.equal(photos.length, 2);
  assert.equal(photos[0].kind, "person");
  assert.equal(photos[1].kind, "team");
  assert.deepEqual(photos.map((photo) => photo.credit.license), ["Public domain", "CC BY 4.0"]);
  for (const photo of photos) {
    assert.ok(photo.credit.creator);
    assert.match(photo.credit.url, /^https:\/\/commons\.wikimedia\.org\/wiki\/File:/u);
    assert.equal(photo.credit.type, "photo");
    assert.doesNotMatch(photo.credit.license, /SA/u);
  }
});

test("returns no photos when Commons cannot be reached", async (t) => {
  const directory = await temporary(t);
  const offline = await storyImagery(segment, {
    directory, fetchImpl: async () => { throw new Error("offline"); },
  });
  assert.deepEqual(offline, []);
  let called = false;
  const empty = await storyImagery({ headline: "A quiet night", narration: "Nothing to show." }, {
    directory, fetchImpl: async () => { called = true; throw new Error("offline"); },
  });
  assert.equal(called, false);
  assert.deepEqual(empty, []);
});
