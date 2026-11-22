import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { ListenStation, nowPlaying } from "../server/sports/listen.mjs";

function fakeProcess() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => { child.killed = true; };
  return child;
}

function fakeListener() {
  const res = new EventEmitter();
  res.chunks = [];
  res.writableLength = 0;
  res.ended = false;
  res.write = (chunk) => { res.chunks.push(String(chunk)); return true; };
  res.end = () => { res.ended = true; };
  res.destroy = () => res.emit("close");
  return res;
}

test("now playing reads the Spotify window title and treats the bare app name as paused", () => {
  assert.equal(nowPlaying("Cardinal Black - Adeline"), "Cardinal Black - Adeline");
  assert.equal(nowPlaying("Spotify Premium"), "");
  assert.equal(nowPlaying("Spotify"), "");
  assert.equal(nowPlaying(""), "");
});

test("one capture feeds every listener and stops with the last one", async () => {
  const captures = [];
  const encoders = [];
  let spotify = { pid: 4242, title: "Cardinal Black - Adeline" };
  const station = new ListenStation({
    find: async () => spotify,
    capture: async (pid) => { const child = fakeProcess(); child.pid = pid; captures.push(child); return child; },
    encoder: () => { const child = fakeProcess(); encoders.push(child); return child; },
    cacheMs: 0,
  });
  assert.deepEqual(await station.status(), { active: true, playing: true, title: "Cardinal Black - Adeline", listeners: 0 });

  const first = fakeListener();
  const second = fakeListener();
  assert.equal(await station.listen(first), true);
  assert.equal(await station.listen(second), true);
  assert.equal(captures.length, 1, "a second listener shares the running capture");
  assert.equal(captures[0].pid, 4242);
  encoders[0].stdout.write("mp3-frame");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(first.chunks, ["mp3-frame"]);
  assert.deepEqual(second.chunks, ["mp3-frame"]);
  assert.equal((await station.status()).listeners, 2);

  first.emit("close");
  assert.equal(captures[0].killed, false);
  second.emit("close");
  assert.equal(captures[0].killed, true, "the capture stops with the last listener");
  assert.equal(encoders[0].killed, true);

  // Spotify quitting ends the streams of everyone still listening.
  const third = fakeListener();
  await station.listen(third);
  assert.equal(captures.length, 2);
  captures[1].emit("exit", 0);
  assert.equal(third.ended, true);
  assert.equal(station.listeners.size, 0);

  spotify = null;
  assert.equal(await station.listen(fakeListener()), false);
  assert.deepEqual(await station.status(), { active: false, playing: false, title: "", listeners: 0 });
});

test("a listener too far behind is dropped instead of buffering forever", async () => {
  const encoders = [];
  const station = new ListenStation({
    find: async () => ({ pid: 1, title: "Spotify" }),
    capture: async () => fakeProcess(),
    encoder: () => { const child = fakeProcess(); encoders.push(child); return child; },
  });
  const slow = fakeListener();
  await station.listen(slow);
  slow.writableLength = 2 * 1024 * 1024;
  encoders[0].stdout.write("frame");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(slow.chunks, []);
  assert.equal(station.listeners.size, 0);
});

test("the listen routes sit behind the desk sign-in and report a closed Spotify", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "isnn-listen-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const listenStation = new ListenStation({ find: async () => null });
  const desk = { directory, settings: { timezone: "America/Chicago" }, now: () => new Date(), listenStation };
  const { app } = await createApp({ sports: desk });
  const signIn = (req) => process.env.SPORTS_DESK_PASSWORD ? req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD) : req;
  const status = await signIn(request(app).get("/api/sports/listen")).expect(200);
  assert.equal(status.body.active, false);
  await signIn(request(app).get("/api/sports/listen/stream")).expect(404);
  if (process.env.SPORTS_DESK_PASSWORD) await request(app).get("/api/sports/listen/stream").expect(401);
});
