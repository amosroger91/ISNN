import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { classifyThumbnailError, setThumbnail } from "../server/sports/youtube.mjs";

function useTestCredentials(t) {
  const keys = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  process.env.YOUTUBE_CLIENT_ID = "test-id";
  process.env.YOUTUBE_CLIENT_SECRET = "test-secret";
  process.env.YOUTUBE_REFRESH_TOKEN = "test-refresh";
  t.after(() => {
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
}

test("setThumbnail posts a jpeg with the video id and bearer token", async (t) => {
  useTestCredentials(t);
  const directory = await mkdtemp(path.join(tmpdir(), "isnn-thumb-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "episode.jpg");
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const seen = [];
  const fetchImpl = async (url, options) => {
    seen.push({ url: String(url), options });
    if (String(url).includes("oauth2.googleapis.com")) {
      return { ok: true, json: async () => ({ access_token: "token-1" }) };
    }
    return { ok: true, json: async () => ({ items: [] }) };
  };
  await setThumbnail({ videoId: "abc123de_45", file, fetchImpl });
  assert.equal(seen.length, 2);
  assert.match(seen[1].url, /videoId=abc123de_45/);
  assert.match(seen[1].url, /uploadType=media/);
  assert.equal(seen[1].options.method, "POST");
  assert.equal(seen[1].options.headers.Authorization, "Bearer token-1");
  assert.equal(seen[1].options.headers["Content-Type"], "image/jpeg");
  assert.equal(seen[1].options.headers["Content-Length"], "4");
});

test("a video id is rejected before any network call", async () => {
  let calls = 0;
  await assert.rejects(
    setThumbnail({ videoId: "test", file: "missing.jpg", fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({}) }; } }),
    /video id is not valid/u,
  );
  assert.equal(calls, 0);
});

test("a 403 forbidden is unavailable, and quota is classified first", async (t) => {
  useTestCredentials(t);
  const directory = await mkdtemp(path.join(tmpdir(), "isnn-thumb-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "episode.jpg");
  await writeFile(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const fetchFor = (reason) => async (url) => {
    if (String(url).includes("oauth2.googleapis.com")) return { ok: true, json: async () => ({ access_token: "token-1" }) };
    return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason }] } }) };
  };
  await assert.rejects(setThumbnail({ videoId: "abc123de_45", file, fetchImpl: fetchFor("forbidden") }), /forbidden/u);
  try {
    await setThumbnail({ videoId: "abc123de_45", file, fetchImpl: fetchFor("forbidden") });
  } catch (error) {
    assert.deepEqual(classifyThumbnailError(error), { status: "unavailable", halt: "unavailable" });
  }
  try {
    await setThumbnail({ videoId: "abc123de_45", file, fetchImpl: fetchFor("quotaExceeded") });
  } catch (error) {
    assert.deepEqual(classifyThumbnailError(error), { status: "failed", halt: "quota" });
  }
});

test("a scheduled upload goes up private with its publish time", async (t) => {
  useTestCredentials(t);
  const { uploadEpisode } = await import("../server/sports/youtube.mjs");
  const directory = await mkdtemp(path.join(tmpdir(), "isnn-sched-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "short.mp4");
  await writeFile(file, "video");
  let metadata;
  const fetchImpl = async (url, options) => {
    if (String(url).includes("oauth2.googleapis.com")) return { ok: true, json: async () => ({ access_token: "token-1" }) };
    if (options.method === "POST") {
      metadata = JSON.parse(options.body);
      return { ok: true, headers: new Headers({ location: "https://www.googleapis.com/upload/youtube/v3/videos?upload_id=abc" }) };
    }
    return { ok: true, status: 200, json: async () => ({ id: "abc123de_45", status: { privacyStatus: "private", publishAt: "2026-11-16T16:00:00Z" } }) };
  };
  const result = await uploadEpisode({
    file, episode: { title: "Story #Shorts", publishAt: "2026-11-16T16:00:00.000Z" }, onSession: async () => {}, fetchImpl,
  });
  assert.deepEqual(metadata.status, { privacyStatus: "private", publishAt: "2026-11-16T16:00:00.000Z", selfDeclaredMadeForKids: false });
  assert.equal(result.publishAt, "2026-11-16T16:00:00Z");
});
