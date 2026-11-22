import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { root } from "../server/config.mjs";
import { probe } from "../server/media.mjs";
import { LOUDNESS, SHORT, cues, narrationParts, renderEpisode, srtFile, visualTeamCues } from "../server/sports/produce.mjs";
import { listFixtures, loadFixture, placeholderNarrate, wordCount } from "../server/sports/fixtures.mjs";
import { DESCRIPTION_CHARACTERS, srtCues, uploadEpisode, youtubeDescription, youtubeTitle } from "../server/sports/youtube.mjs";
import { wav } from "../server/voice.mjs";

const grant = {
  id: "g-test", version: 1, licensor: "Test Network", status: "active", components: ["video"], channels: ["isnn-youtube"], surfaces: ["episode"], territories: ["worldwide"],
  window: { expiresAt: "2026-11-15T12:00:00Z" }, credit: "Courtesy Test Network", claimContact: "rights@test.example", evidenceRef: "grants/test.pdf",
};
const asset = { id: "clip-1", providerId: "p1", eventId: "game-1", captureTime: "2026-11-15T03:00:00Z", credit: "Courtesy Test Network", grantId: "g-test", grantVersion: 1, sha256: "a".repeat(64), status: "available" };
const episode = {
  title: "Saturday's short-yardage story",
  description: "The adjustments that changed the game.",
  date: "2026-11-15",
  revisionId: "rev_test",
  rights: { channel: "isnn-youtube", territory: "worldwide", airAt: "2026-11-15T14:00:00Z", catalog: { assets: [asset], grants: [grant] } },
  segments: [{
    headline: "The fourth quarter came down to one adjustment",
    narration: "The defense tightened its rotation on the final drive.",
    sources: [{ publisher: "League newsroom", title: "Fourth-quarter notes", url: "https://example.org/league/game" }],
    eventId: "game-1", claims: [{ id: "clm_test", text: "Rotation tightened", evidence: [{ id: "snap_test", locator: "notes" }] }],
    // Selected while the grant was live; by air time it has expired, so the render must fall back.
    shots: { episode: { kind: "ShotUse", assetId: "clip-1", grantId: "g-test", grantVersion: 1, surface: "episode" }, short: { kind: "Fallback", surface: "short", fallback: "Play diagram", reasons: [{ code: "surface", reason: "Grant g-test does not cover the short surface." }] } },
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

test("keeps narration words intact and leaves longer pauses for paragraph and chapter breaks", () => {
  const lead = "Here's the play. The defense stayed patient.";
  const firstClause = "The defense dropped all the way back into coverage,";
  const longSentence = `${firstClause} while the quarterback worked through every option near the sideline and waited for a receiver to come all the way back across the field.`;
  const segments = [{ narration: `${lead} ${longSentence}\n\nWatch the linebacker.` }, { narration: "Now to the next game." }];
  const parts = narrationParts({ segments });
  assert.equal(parts[0].text, lead);
  assert.equal(parts[0].pause, 0.15);
  assert.equal(parts[1].text, firstClause);
  assert.equal(parts[1].pause, 0.10);
  assert.equal(parts.at(-3).pause, 0.24);
  assert.equal(parts.at(-2).pause, 0.34);
  assert.equal(parts.at(-1).kind, 1);
  assert.equal(parts.filter(({ kind }) => kind === 0).map(({ text }) => text).join(" "), segments[0].narration.replace(/\s+/gu, " "));
});

async function temporary(t) {
  const data = path.join(root, "data");
  await mkdir(data, { recursive: true });
  const directory = await mkdtemp(path.join(data, "sports-production-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("a broadcast-only trend recap does not add a Short or break segment manifests", async (t) => {
  const previous = process.env.SPORTS_MOTION;
  t.after(() => { if (previous === undefined) delete process.env.SPORTS_MOTION; else process.env.SPORTS_MOTION = previous; });
  const narrate = async (parts, _voice, file) => {
    const rate = 24000, duration = parts.length * 3;
    await writeFile(file, wav(Float32Array.from({ length: Math.ceil(duration * rate) }, (_, i) => Math.sin(i * 2 * Math.PI * 440 / rate) * 0.15), rate));
    return { duration, segments: parts.map((part, i) => ({ ...part, start: i * 3, end: (i + 1) * 3 })) };
  };
  for (const motion of ["off", "on"]) {
    process.env.SPORTS_MOTION = motion;
    const directory = await temporary(t);
    const input = { ...episode, segments: episode.segments.map((segment, i) => i === 1 ? { ...segment, kind: "trend", short: false } : segment) };
    const rendered = await renderEpisode(input, directory, undefined, undefined, narrate);
    assert.equal(rendered.shorts.length, 1);
    assert.deepEqual(rendered.shorts.map(({ segment }) => segment), [1]);
    const timeline = JSON.parse(await readFile(path.join(directory, "timeline.json"), "utf8"));
    assert.equal(timeline.segments.length, 2, "both segments remain in the full episode");
    assert.ok(timeline.segments[0].short);
    assert.equal(timeline.segments[1].short, null);
  }
});

test("renders the 1080p episode, one vertical Short per segment, captions and manifests, and cleans staging files", async (t) => {
  const previousMotion = process.env.SPORTS_MOTION;
  process.env.SPORTS_MOTION = "on";
  t.after(() => {
    if (previousMotion === undefined) delete process.env.SPORTS_MOTION;
    else process.env.SPORTS_MOTION = previousMotion;
  });
  const directory = await temporary(t);
  const withBookends = {
    ...episode, intro: "Here is the morning rundown.", outro: "Thanks for watching today.",
    outroAnnouncement: "Like, comment, and subscribe for more!",
  };
  const narrate = async (parts, _voice, file) => {
    const rate = 24000;
    assert.equal(parts.at(-1).voice, "lafontaine");
    assert.equal(parts.at(-2).voice, undefined);
    const audio = Float32Array.from({ length: 15 * rate }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / rate) * 0.15);
    await writeFile(file, wav(audio, rate));
    return {
      duration: audio.length / rate,
      segments: parts.map((part, index) => ({ ...part, start: index * 3 + 0.1, end: index * 3 + 2.9 })),
    };
  };
  const rendered = await renderEpisode(withBookends, directory, undefined, undefined, narrate);
  assert.deepEqual((await readdir(directory)).sort(), ["captions.srt", "credits.json", "episode.mp4", "qc.json", "shorts", "timeline.json"]);
  assert.deepEqual((await readdir(path.join(directory, "shorts"))).sort(), ["segment-01.mp4", "segment-01.srt", "segment-02.mp4", "segment-02.srt"]);
  assert.equal(rendered.chapters[1].start, 3.1);
  assert.deepEqual(rendered.chapters.map(({ start }) => start), [0, 3.1, 6.1, 9.1]);
  assert.equal(rendered.shorts.length, 2);
  assert.deepEqual(rendered.shorts.map(({ id }) => id), ["segment-01", "watch"]);
  const info = await probe(path.join(directory, "episode.mp4"));
  const video = info.streams.find((stream) => stream.codec_type === "video");
  assert.equal(video.duration, "15.000000");
  assert.equal(video.codec_name, "h264");
  assert.equal(info.streams.find((stream) => stream.codec_type === "audio").codec_name, "aac");
  const short = await probe(path.join(directory, "shorts/segment-02.mp4"));
  const portrait = short.streams.find((stream) => stream.codec_type === "video");
  assert.equal(portrait.width, SHORT.width);
  assert.equal(portrait.height, SHORT.height);
  assert.ok(Math.abs(Number(short.format.duration) - 3) < 0.15);
  const timeline = JSON.parse(await readFile(path.join(directory, "timeline.json"), "utf8"));
  assert.deepEqual(timeline.intro, { start: 0, end: 3.1 });
  assert.equal(timeline.outro.start, 9.1);
  assert.equal(timeline.outro.end, timeline.closingAnnouncement.start);
  assert.equal(timeline.closingAnnouncement.voiceStart, 12.1);
  assert.equal(timeline.closingAnnouncement.end, 15);
  assert.equal(timeline.segments[1].start, 6.1);
  assert.equal(timeline.segments[1].short.file, "shorts/segment-02.mp4");
  assert.equal(timeline.segments[1].diagram.sport, "football");
  const qc = JSON.parse(await readFile(path.join(directory, "qc.json"), "utf8"));
  assert.equal(qc.passed, true);
  assert.equal(qc.motion, true);
  assert.ok(qc.renderSeconds > 0);
  assert.equal(qc.outputs.length, 3);
  assert.ok(qc.outputs.every((output) => output.checks.motion && output.motion.longestStillSeconds <= 1.5));
  assert.ok(qc.outputs.every((output) => output.checks.sync && output.checks.picture && output.checks.sound));
  assert.ok(qc.outputs.every((output) => Number.isFinite(output.loudness?.integrated)));
  const credits = JSON.parse(await readFile(path.join(directory, "credits.json"), "utf8"));
  assert.equal(credits.music[0].asset, "assets/background-music.mp3");
  assert.equal(credits.music[0].targetBelowNarrationLu, 27);
  assert.equal(credits.segments[0].sources[0].url, "https://example.org/league/game");
  assert.equal(credits.revisionId, "rev_test");
  assert.equal(credits.segments[0].claims[0].id, "clm_test");
  assert.equal(credits.segments[0].shots.episode.kind, "Fallback", "the grant expired before air, so the clip is replaced at render");
  assert.equal(credits.segments[0].shots.episode.reasons[0].code, "grant-expired");
  assert.equal(credits.segments[0].shots.short.fallback, "Play diagram");
  assert.equal(timeline.segments[0].short.shot.fallback, "Play diagram");
  assert.equal(timeline.segments[1].shots, null);
  assert.ok(qc.warnings.some((warning) => /clip clip-1 replaced by the Play diagram/u.test(warning)));
  assert.equal(rendered.shots[0].episode.fallback, "Play diagram");
  const srt = await readFile(path.join(directory, "shorts/segment-02.srt"), "utf8");
  assert.match(srt, /^1\n00:00:00,000 --> 00:00:0[1-3],\d{3}\nStart by watching the pressure\nup front\./u);
  assert.doesNotMatch(srt, /morning rundown|Thanks for watching|subscribe/u);
});

test("the announcer's bumper opens a league block in the episode but not in that story's Short", async (t) => {
  const previousMotion = process.env.SPORTS_MOTION;
  process.env.SPORTS_MOTION = "on";
  t.after(() => {
    if (previousMotion === undefined) delete process.env.SPORTS_MOTION;
    else process.env.SPORTS_MOTION = previousMotion;
  });
  const directory = await temporary(t);
  const bumped = { ...episode, rights: undefined, segments: [
    { ...episode.segments[1], id: "nba-1", league: "NBA", bumper: "We start with the NBA news." },
    { ...episode.segments[1], id: "mlb-1", league: "MLB", bumper: "And now for the MLB news.", narration: "The pitching staff held firm all night." },
  ] };
  const parts = narrationParts(bumped);
  assert.deepEqual(parts.map(({ kind, voice, bumper }) => [kind, voice || "isaac", Boolean(bumper)]),
    [[0, "lafontaine", true], [0, "isaac", false], [1, "lafontaine", true], [1, "isaac", false]]);
  const narrate = async (spoken, _voice, file) => {
    const rate = 24000;
    const audio = Float32Array.from({ length: 12 * rate }, (_, index) => Math.sin(index * 2 * Math.PI * 440 / rate) * 0.15);
    await writeFile(file, wav(audio, rate));
    return { duration: 12, segments: spoken.map(({ kind, text }, index) => ({ kind, text, start: index * 3 + 0.1, end: index * 3 + 2.9 })) };
  };
  const rendered = await renderEpisode(bumped, directory, undefined, undefined, narrate);
  assert.deepEqual(rendered.chapters.map(({ start }) => start), [0, 6.1], "the chapter starts with the bumper");
  assert.ok(Math.abs(rendered.shorts[1].start - 8.98) < 0.01, "the Short starts just before Isaac");
  // The story, then the Shorts-only sign-off.
  assert.ok(rendered.shorts[1].signoff > 0, "the Short ends on the sign-off");
  assert.ok(Math.abs(rendered.shorts[1].duration - rendered.shorts[1].signoff - 3.02) < 0.01);
  const srt = await readFile(path.join(directory, "shorts/segment-02.srt"), "utf8");
  assert.doesNotMatch(srt, /MLB news/u);
  assert.match(srt, /pitching staff/u);
  assert.match(srt, /subscribe to Wellspring/u);
  const captions = await readFile(path.join(directory, "captions.srt"), "utf8");
  assert.match(captions, /And now for the MLB news\./u);
  assert.doesNotMatch(captions, /subscribe to Wellspring/u, "the episode never plays the Shorts' sign-off");
});

test("team graphics follow each narrated matchup and clear while archive footage plays", () => {
  const teams = ["Michigan State", "Duke", "Texas Tech", "Illinois"];
  const parts = [
    { text: "Michigan State beat Duke.", start: 1, end: 4 },
    { text: "Texas Tech won against Illinois.", start: 4, end: 7 },
    { text: "Duke and Illinois are projected to fall.", start: 7, end: 10 },
  ];
  assert.deepEqual(visualTeamCues(teams, parts, { start: 1, end: 4 }), [
    { start: 4, end: 7, teams: ["Texas Tech", "Illinois"] },
    { start: 7, end: 10, teams: ["Duke", "Illinois"] },
  ]);
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

test("builds one Rundown title and puts timestamps in the description", () => {
  assert.equal(youtubeTitle({ date: "2026-11-16" }), "The Rundown | November 16, 2026");
  assert.equal(youtubeTitle({ date: "2026-11-16", headline: "Josh Hart's night" }), "The Rundown | November 16, 2026 | Josh Hart's night");
  assert.equal(youtubeTitle({ date: "2026-11-16", headline: "x".repeat(200) }).length, 100);
  const few = youtubeDescription({
    date: "2026-11-16",
    entries: [{ start: 0, label: "Opening" }, { start: 18.2, label: "The take" }],
    episode: { description: "Lane Kiffin and LSU.", date: "2026-11-16" },
  });
  assert.match(few, /^Lane Kiffin and LSU\.\n\nThe Rundown · November 16, 2026 · Wellspring Media Sports with Isaac Doss\n\n00:00 Opening\n00:18 The take$/);
  const chapters = [
    { start: 0, headline: "The fourth quarter" },
    { start: 12.4, headline: "The Sunday slate" },
    { start: 25.2, headline: "Matchups" },
  ];
  const described = youtubeDescription({
    date: "2026-11-16",
    entries: chapters.map(({ start, headline }) => ({ start, label: headline })),
    episode: { ...episode, date: "2026-11-16", duration: 44, chapters },
  });
  assert.match(described, /The Rundown · November 16, 2026 · Wellspring Media Sports with Isaac Doss/);
  assert.doesNotMatch(described, /00:00 The fourth quarter/);
  assert.deepEqual(srtCues("1\n00:00:00,000 --> 00:00:02,000\nJosh Hart\nat the rim\n\n2\n00:00:12,500 --> 00:00:14,000\nThe take\n"), [
    { start: 0, label: "Josh Hart at the rim" },
    { start: 12, label: "The take" },
  ]);
});

test("persists the Google upload session before sending video bytes", async (t) => {
  const file = await uploadFixture(t);
  let savedSession;
  let calls = 0;
  const content = { ...episode, duration: 44, hashtags: ["#NBA", "#WellspringMediaSports"], tags: ["NBA", "Wellspring Media Sports"], footageCredits: [
    { type: "photo", title: "Jake Bauers swings", creator: "Camera operator", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", url: "https://commons.wikimedia.org/wiki/File:Jake.jpg" },
    { title: "Game action", creator: "Archive", license: "CC0", licenseUrl: "https://creativecommons.org/publicdomain/zero/1.0/", url: "https://commons.wikimedia.org/wiki/File:Game.webm" },
  ], chapters: [
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
      assert.equal(metadata.status.selfDeclaredMadeForKids, false, "never declared made for kids");
      assert.match(metadata.snippet.description, /00:00 The fourth quarter\n00:12 The Sunday slate\n00:25 Matchups/);
      assert.doesNotMatch(metadata.snippet.description, /example\.org|Reporting sources/u, "no reporting-source links");
      assert.ok(Array.from(metadata.snippet.description).length <= DESCRIPTION_CHARACTERS);
      assert.match(metadata.snippet.description, /Jake Bauers swings — Camera operator \(CC BY 4.0\)/);
      assert.doesNotMatch(metadata.snippet.description, /Jake Bauers swings — Camera operator \(CC BY 4\.0, excerpt, muted\)/);
      assert.match(metadata.snippet.description, /Game action — Archive \(CC0, excerpt, muted\)/);
      assert.match(metadata.snippet.description, /\n\n#NBA #WellspringMediaSports$/u, "hashtags close the description");
      assert.deepEqual(metadata.snippet.tags, ["NBA", "Wellspring Media Sports"]);
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

test("a long description is cut to the character cap but keeps its credits and hashtags", async (t) => {
  const file = await uploadFixture(t);
  let description = "";
  let calls = 0;
  await uploadEpisode({ file, episode: { ...episode, description: "Big night. ".repeat(400), hashtags: ["#NBA"], footageCredits: [
    { type: "photo", title: "Jake Bauers swings", creator: "Camera operator", license: "CC BY 4.0", licenseUrl: "https://creativecommons.org/licenses/by/4.0/", url: "https://commons.wikimedia.org/wiki/File:Jake.jpg" },
  ] }, onSession: () => {}, fetchImpl: async (_url, options) => {
    if (++calls === 1) return Response.json({ access_token: "fixture-token" });
    if (calls === 2) {
      description = JSON.parse(options.body).snippet.description;
      return new Response(null, { headers: { location: session } });
    }
    return Response.json({ id: videoId }, { status: 201 });
  } });
  assert.ok(Array.from(description).length <= DESCRIPTION_CHARACTERS);
  assert.match(description, /^Big night./u);
  assert.ok(description.includes("Jake Bauers swings — Camera operator (CC BY 4.0)"));
  assert.match(description, /#NBA$/u);
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
