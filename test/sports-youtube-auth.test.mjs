import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { PLAYGROUND_REDIRECT, YoutubeReconnect, saveEnvValue } from "../server/sports/youtube-auth.mjs";
import { youtubeAccessToken } from "../server/sports/youtube.mjs";

function credentials(t) {
  const keys = ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN", "YOUTUBE_REDIRECT_URI", "PUBLIC_URL"];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  Object.assign(process.env, { YOUTUBE_CLIENT_ID: "id-1", YOUTUBE_CLIENT_SECRET: "secret-1", YOUTUBE_REFRESH_TOKEN: "old-token", PUBLIC_URL: "https://desk.example" });
  delete process.env.YOUTUBE_REDIRECT_URI;
  t.after(() => {
    for (const key of keys) previous[key] === undefined ? delete process.env[key] : (process.env[key] = previous[key]);
  });
}

async function envFile(t, text) {
  const directory = await mkdtemp(path.join(tmpdir(), "isnn-auth-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, ".env");
  await writeFile(file, text);
  return file;
}

test("an expired refresh token names the reconnect page", async (t) => {
  credentials(t);
  const fetchImpl = async () => ({ ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) });
  await assert.rejects(youtubeAccessToken(fetchImpl), (error) => {
    assert.match(error.message, /invalid_grant/);
    assert.match(error.message, /https:\/\/desk\.example\/api\/sports\/youtube\/reconnect/);
    assert.equal(error.reconnect, true);
    return true;
  });
});

test("a pasted Playground address saves the new refresh token and uses it at once", async (t) => {
  credentials(t);
  const file = await envFile(t, "A=1\nYOUTUBE_REFRESH_TOKEN=old-token\nB=2\n");
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: Object.fromEntries(options.body) });
    return { ok: true, json: async () => ({ refresh_token: "1//new-token", scope: "youtube.upload" }) };
  };
  const reconnect = new YoutubeReconnect({ envFile: file, fetchImpl });
  const start = new URL(await reconnect.start());
  assert.equal(start.searchParams.get("redirect_uri"), PLAYGROUND_REDIRECT);
  assert.equal(start.searchParams.get("access_type"), "offline");
  assert.equal(start.searchParams.get("prompt"), "consent");
  const state = start.searchParams.get("state");
  await reconnect.complete(`${PLAYGROUND_REDIRECT}/?state=${state}&code=4/0Abc-defGHIJ&scope=x`);
  assert.equal(calls[0].body.code, "4/0Abc-defGHIJ");
  assert.equal(calls[0].body.redirect_uri, PLAYGROUND_REDIRECT);
  assert.equal(calls[0].body.grant_type, "authorization_code");
  assert.equal(await readFile(file, "utf8"), "A=1\nYOUTUBE_REFRESH_TOKEN=1//new-token\nB=2\n");
  assert.equal(process.env.YOUTUBE_REFRESH_TOKEN, "1//new-token");
});

test("reconnect refuses a mismatched state, a missing code and a reused sign-in", async (t) => {
  credentials(t);
  const file = await envFile(t, "YOUTUBE_REFRESH_TOKEN=old-token\n");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ refresh_token: "new-token" }) });
  const reconnect = new YoutubeReconnect({ envFile: file, fetchImpl });
  await assert.rejects(reconnect.complete("4/0Abc-defGHIJ"), /expired/);
  await reconnect.start();
  await assert.rejects(reconnect.complete(`${PLAYGROUND_REDIRECT}/?state=wrong&code=4/0Abc-defGHIJ`), /does not match/);
  await assert.rejects(reconnect.complete(`${PLAYGROUND_REDIRECT}/?error=access_denied`), /did not grant/);
  await assert.rejects(reconnect.complete("hello"), /no Google sign-in code/);
  await reconnect.complete("4/0Abc-defGHIJ");
  await assert.rejects(reconnect.complete("4/0Abc-defGHIJ"), /expired/);
  assert.equal(await readFile(file, "utf8"), "YOUTUBE_REFRESH_TOKEN=new-token\n");
});

test("saveEnvValue appends a missing key and rejects odd values", async (t) => {
  const file = await envFile(t, "A=1");
  await saveEnvValue(file, "YOUTUBE_REFRESH_TOKEN", "tok");
  assert.equal(await readFile(file, "utf8"), "A=1\nYOUTUBE_REFRESH_TOKEN=tok\n");
  await assert.rejects(saveEnvValue(file, "YOUTUBE_REFRESH_TOKEN", "bad\nX=1"), /unexpected/);
});

test("a pending sign-in survives a desk restart", async (t) => {
  credentials(t);
  const file = await envFile(t, "YOUTUBE_REFRESH_TOKEN=old-token\n");
  const stateFile = path.join(path.dirname(file), "pending.json");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ refresh_token: "new-token" }) });
  const state = new URL(await new YoutubeReconnect({ envFile: file, stateFile, fetchImpl }).start()).searchParams.get("state");
  await new YoutubeReconnect({ envFile: file, stateFile, fetchImpl }).complete(`${PLAYGROUND_REDIRECT}/?state=${state}&code=4/0Abc-defGHIJ`);
  assert.equal(await readFile(file, "utf8"), "YOUTUBE_REFRESH_TOKEN=new-token\n");
});

test("starting a second sign-in does not void the first", async (t) => {
  credentials(t);
  const file = await envFile(t, "YOUTUBE_REFRESH_TOKEN=old-token\n");
  const fetchImpl = async () => ({ ok: true, json: async () => ({ refresh_token: "new-token" }) });
  const reconnect = new YoutubeReconnect({ envFile: file, stateFile: path.join(path.dirname(file), "pending.json"), fetchImpl });
  const first = new URL(await reconnect.start()).searchParams.get("state");
  await reconnect.start();
  await reconnect.complete(`${PLAYGROUND_REDIRECT}/?state=${first}&code=4/0Abc-defGHIJ`);
  assert.equal(process.env.YOUTUBE_REFRESH_TOKEN, "new-token");
});
