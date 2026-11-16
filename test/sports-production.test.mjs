import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { root } from "../server/config.mjs";
import { probe } from "../server/media.mjs";
import { LOUDNESS, SHORT, cues, renderEpisode, srtFile } from "../server/sports/produce.mjs";
import { listFixtures, loadFixture, placeholderNarrate, wordCount } from "../server/sports/fixtures.mjs";
import { uploadEpisode } from "../server/sports/youtube.mjs";
import { wav } from "../server/voice.mjs";

const episode = {
  title: "Saturday's short-yardage story",
  description: "The adjustments that changed the game.",
  date: "2026-11-15",
  segments: [{
    headline: "The fourth quarter came down to one adjustment",
    narration: "The defense tightened its rotation on the final drive.",
    sources: [{ publisher: "League newsroom", title: "Fourth-quarter notes", url: "https://example.org/league/game" }],
  }, {
    id: "watch",
    headline: "What to watch on Sunday",
    narration: "Start by watching the pressure up front.",
    sources: [],
    diagram: { sport: "football", caption: "Original recreation.", markers: [
      { n: 1, x: 0.5, y: 0.3, role: "offense", label: "Quarterback under center" },
      { n: 2, x: 0.5, y: 0.45, role: "defense", label: "Edge pressure" },
    ], paths: [[2, 1]] },
  }],
};

async function temporary(t) {
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(path.join(data, "sports-production-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("renders the 1080p episode, one vertical Short per segment, captions and manifests, and cleans staging files", async (t) => {
  const directory = await temporary(t);
  const narrate = async (parts, _voice, file) => {
    const rate = 24000;
    const audio = Float32Array.from({ length: 6 * rate }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / rate) * 0.15);
    await writeFile(file, wav(audio, rate));
    return {
      duration: audio.length / rate,
      segments: parts.map((part, index) => ({ ...part, start: index * 3 + 0.1, end: index * 3 + 2.9 })),
    };
  };
  const rendered = await renderEpisode(episode, directory, undefined, undefined, narrate);
  assert.deepEqual((await readdir(directory)).sort(), ["captions.srt", "credits.json", "episode.mp4", "qc.json", "shorts", "timeline.json"]);
  assert.deepEqual((await readdir(path.join(directory, "shorts"))).sort(), ["segment-01.mp4", "segment-01.srt", "segment-02.mp4", "segment-02.srt"]);
  assert.equal(rendered.chapters[1].start, 3.1);
  assert.equal(rendered.shorts.length, 2);
  assert.deepEqual(rendered.shorts.map(({ id }) => id), ["segment-01", "watch"]);
  const info = await probe(path.join(directory, "episode.mp4"));
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.duration, "6.000000");
  assert.equal(video.codec_name, "h264");
  assert.equal(info.streams.find((stream) => stream.codec_type === "audio").codec_name, "aac");
  const short = await probe(path.join(directory, "shorts/segment-02.mp4"));
  const portrait = short.streams.find((stream) => stream.codec_type === "video");
  assert.equal(portrait.width, SHORT.width);
  assert.equal(portrait.height, SHORT.height);
  assert.ok(Math.abs(Number(short.format.duration) - (6 - 3.1)) < 0.15);
  const timeline = JSON.parse(await readFile(path.join(directory, "timeline.json"), "utf8"));
  assert.equal(timeline.segments[1].start, 3.1);
  assert.equal(timeline.segments[1].short.file, "shorts/segment-02.mp4");
  assert.equal(timeline.segments[1].diagram.sport, "football");
  const qc = JSON.parse(await readFile(path.join(directory, "qc.json"), "utf8"));
  assert.equal(qc.passed, true);
  assert.equal(qc.outputs.length, 3);
  assert.ok(qc.outputs.every((output) => output.checks.sync && output.checks.picture && output.checks.sound));
  assert.ok(qc.outputs.every((output) => Number.isFinite(output.loudness?.integrated)));
  const credits = JSON.parse(await readFile(path.join(directory, "credits.json"), "utf8"));
  assert.equal(credits.segments[0].sources[0].url, "https://example.org/league/game");
  const srt = await readFile(path.join(directory, "shorts/segment-02.srt"), "utf8");
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:0[1-3],\d{3}\nStart by watching the pressure\nup front\./u);
});

test("caption cues split long parts and shift to the Short's clock", () => {
  const list = cues([{ text: "One two three four five six seven eight nine ten eleven twelve.", start: 10, end: 14 }], { offset: 10, chars: 20 });
  assert.ok(list.length >= 2);
  assert.equal(list[0].start, 0);
  assert.ok(Math.abs(list.at(-1).end - 4) < 1e-9);
  assert.match(srtFile(list), /^1\n00:00:00,000 --> /u);
});

test("the frozen historical fixture validates, paces its segments for Shorts and cites evidence", async () => {
  assert.ok((await listFixtures()).includes("finals-2016-game7"));
  const fixture = await loadFixture("finals-2016-game7");
  assert.equal(fixture.date, "2016-06-19");
  for (const segment of fixture.segments) {
    const words = wordCount(segment.narration);
    assert.ok(words >= 35 && words <= 75, `${segment.id} has ${words} words`);
    assert.ok(segment.sources.every(({ url }) => url.startsWith("https://")));
    assert.ok(segment.claims.every(({ evidence }) => segment.sources.some(({ url }) => url === evidence)), `${segment.id} cites a source outside its list`);
  }
  assert.equal(fixture.segments.filter(({ diagram }) => diagram).length, 2);
  await assert.rejects(loadFixture(path.join(root, "package.json")));
});

test("the placeholder narrator keeps Kokoro's timing contract", async (t) => {
  const file = path.join(await temporary(t), "narration.wav");
  const parts = [{ kind: 0, text: "Ten words of narration that will be timed by count here.", pause: 0.52 }, { kind: 1, text: "Short.", pause: 0.3 }];
  const result = await placeholderNarrate(parts, "none", file);
  assert.equal(result.segments.length, 2);
  assert.ok(result.segments[0].end - result.segments[0].start > 3.5);
  assert.ok(result.segments[1].start > result.segments[0].end);
  assert.ok(Math.abs(result.duration - (result.segments[1].end + 0.3)) < 0.01);
  assert.ok(Number.isFinite(LOUDNESS.integrated));
});

const session = "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=fixture";
const videoId = "abc123de_45";

async function uploadFixture(t) {
  const credentials = {
    YOUTUBE_CLIENT_ID: "test-id",
    YOUTUBE_CLIENT_SECRET: "test-secret",
    YOUTUBE_REFRESH_TOKEN: "test-refresh-token",
    YOUTUBE_PRIVACY_STATUS: "unlisted",
  };
  for (const [key, value] of Object.entries(credentials)) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const file = path.join(await temporary(t), "episode.mp4");
  await writeFile(file, "fixture");
  return file;
}

test("persists the Google upload session before sending video bytes", async (t) => {
  const file = await uploadFixture(t);
  let savedSession;
  let calls = 0;
  const content = { ...episode, duration: 44, chapters: [
    { start: 0, headline: "The fourth quarter" },
    { start: 12.4, headline: "The Sunday slate" },
    { start: 25.2, headline: "Matchups" },
  ] };
  const upload = await uploadEpisode({ file, episode: content, onSession: (value) => { savedSession = value; }, fetchImpl: async (url, options) => {
    if (++calls === 1) return Response.json({ access_token: "fixture-token" });
    if (calls === 2) {
      assert.match(url, /uploadType=resumable/);
      const metadata = JSON.parse(options.body);
      assert.equal(metadata.status.privacyStatus, "unlisted");
      assert.match(metadata.snippet.description, /00:00 The fourth quarter\n00:12 The Sunday slate\n00:25 Matchups/);
      assert.match(metadata.snippet.description, /https:\/\/example.org\/league\/game/);
      return new Response(null, { headers: { location: session } });
    }
    assert.equal(url, savedSession);
    assert.equal(options.headers["Content-Range"], "bytes 0-6/7");
    assert.equal(options.body.toString(), "fixture");
    return Response.json({ id: videoId, status: { privacyStatus: "unlisted" } }, { status: 201 });
  } });
  assert.equal(calls, 3);
  assert.deepEqual(upload, { id: videoId, url: `https://youtu.be/${videoId}`, privacyStatus: "unlisted" });
});

test("resumes only the unconfirmed bytes of the saved session", async (t) => {
  const file = await uploadFixture(t);
  let calls = 0;
  const upload = await uploadEpisode({ file, episode, sessionUrl: session, onSession: () => assert.fail("unexpected new upload session"), fetchImpl: async (url, options) => {
    if (++calls === 1) return Response.json({ access_token: "fixture-token" });
    assert.equal(url, session);
    if (calls === 2) {
      assert.equal(options.headers["Content-Range"], "bytes */7");
      return new Response(null, { status: 308, headers: { range: "bytes=0-3" } });
    }
    assert.equal(options.headers["Content-Range"], "bytes 4-6/7");
    assert.equal(options.body.toString(), "ure");
    return Response.json({ id: videoId });
  } });
  assert.equal(calls, 3);
  assert.equal(upload.id, videoId);
});

test("recovers an accepted video ID after the previous process lost the response", async (t) => {
  const file = await uploadFixture(t);
  let calls = 0;
  const upload = await uploadEpisode({ file, episode, sessionUrl: session, onSession: () => assert.fail("unexpected new upload session"), fetchImpl: async (url, options) => {
    if (++calls === 1) return Response.json({ access_token: "fixture-token" });
    assert.equal(url, session);
    assert.equal(options.headers["Content-Range"], "bytes */7");
    assert.equal(options.body, undefined);
    return Response.json({ id: videoId, status: { privacyStatus: "private" } }, { status: 201 });
  } });
  assert.equal(calls, 2);
  assert.equal(upload.id, videoId);
  assert.equal(upload.privacyStatus, "private");
});

test("stops for reconciliation when an earlier upload session has expired", async (t) => {
  const file = await uploadFixture(t);
  let calls = 0;
  await assert.rejects(uploadEpisode({ file, episode, sessionUrl: session, onSession: () => assert.fail("unexpected new upload session"), fetchImpl: async (url, options) => {
    if (++calls === 1) return Response.json({ access_token: "fixture-token" });
    assert.equal(url, session);
    assert.equal(options.method, "PUT");
    return new Response(null, { status: 404 });
  } }), { uploadUncertain: true });
  assert.equal(calls, 2);
});
