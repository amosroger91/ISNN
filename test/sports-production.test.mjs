import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { root } from "../server/config.mjs";
import { probe } from "../server/media.mjs";
import { renderEpisode } from "../server/sports/produce.mjs";
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
    headline: "What to watch on Sunday",
    narration: "Start by watching the pressure up front.",
    sources: [],
  }],
};

async function temporary(t) {
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(path.join(data, "sports-production-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("renders a playable two-chapter 1080p episode and cleans staging files", async (t) => {
  const directory = await temporary(t);
  const narrate = async (parts, _voice, file) => {
    const rate = 24000;
    const audio = Float32Array.from({ length: 2 * rate }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / rate) * 0.15);
    await writeFile(file, wav(audio, rate));
    return {
      duration: audio.length / rate,
      segments: parts.map((part, index) => ({ ...part, start: index + 0.1, end: index + 0.9 })),
    };
  };
  const rendered = await renderEpisode(episode, directory, undefined, undefined, narrate);
  assert.deepEqual(await readdir(directory), ["episode.mp4"]);
  assert.equal(rendered.chapters[1].start, 1.1);
  const info = await probe(path.join(directory, "episode.mp4"));
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.duration, "2.000000");
  assert.equal(video.codec_name, "h264");
  assert.equal(info.streams.find((stream) => stream.codec_type === "audio").codec_name, "aac");
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
