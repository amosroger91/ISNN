import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { root } from "../server/config.mjs";
import { CommentFeed, engageChannelComments, planComments, presentThreads } from "../server/sports/comments.mjs";
import { SportsDesk } from "../server/sports/desk.mjs";
import { draftCommentReply } from "../server/sports/research.mjs";

const channelId = "UCchannel000000000000001";
const viewer = "UCviewer00000000000000001";

function comment(id, { author = viewer, text = "Nice recap", rating = "none", at = "2026-11-16T12:00:00.000Z", status = "published", name = "Sam" } = {}) {
  return {
    id,
    snippet: {
      authorDisplayName: name,
      authorChannelId: { value: author },
      textOriginal: text,
      viewerRating: rating,
      canRate: true,
      publishedAt: at,
      moderationStatus: status,
    },
  };
}

function thread(id, videoId, top, replies = []) {
  return { id, snippet: { videoId, totalReplyCount: replies.length, topLevelComment: top }, replies: { comments: replies } };
}

function installYouTube(t) {
  for (const [key, value] of Object.entries({
    YOUTUBE_CLIENT_ID: "client",
    YOUTUBE_CLIENT_SECRET: "secret",
    YOUTUBE_REFRESH_TOKEN: "refresh",
  })) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
}

test("plans likes and replies for unanswered comments on every video", () => {
  const entries = [
    ...flatten(thread("t1", "videoOne1111", comment("old1", { rating: "like" }), [
      comment("ours", { author: channelId, text: "Thanks for watching.", at: "2026-11-16T12:05:00.000Z" }),
      comment("new1", { author: "UCviewer00000000000000002", name: "Ada", text: "What about the fourth quarter?", at: "2026-11-16T12:10:00.000Z" }),
    ])),
    ...flatten(thread("t2", "videoTwo2222", comment("plain", { text: "Loved the Sparks segment." }))),
    ...flatten(thread("t3", "videoOne1111", comment("spam1", { status: "likelySpam", text: "buy followers" }))),
    ...flatten(thread("t4", "videoOne1111", comment("mine", { author: channelId, text: "Tonight's rundown is up." }))),
  ];
  const plan = planComments(entries, { channelId, repliedIds: new Set(["plain"]) });
  assert.deepEqual(plan.likes.map((entry) => entry.comment.id), ["plain", "new1"]);
  assert.deepEqual(plan.replies.map((entry) => entry.comment.id), ["new1"]);
});

function flatten(thread) {
  const top = thread.snippet.topLevelComment;
  return [
    { comment: top, videoId: thread.snippet.videoId, topId: top.id },
    ...thread.replies.comments.map((comment) => ({ comment, videoId: thread.snippet.videoId, topId: top.id })),
  ];
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function youtubeFetch(pages, calls) {
  return async (url, options = {}) => {
    const href = String(url);
    calls.push({ href, method: options.method || "GET", body: options.body, authorization: options.headers?.Authorization });
    if (href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "test-token" });
    if (href.includes("/channels?")) return json({ items: [{ id: channelId }] });
    if (href.includes("/commentThreads?")) {
      const page = new URL(href).searchParams.get("pageToken") || "";
      const found = pages[page];
      if (!found) return json({ items: [] });
      return json(found);
    }
    if (href.includes("/comments?") && (options.method || "GET") === "GET") return json({ items: [] });
    if (href.includes("/videos?")) return json({ items: [{ id: "videoOne1111", snippet: { title: "The Rundown" } }, { id: "videoTwo2222", snippet: { title: "Sparks recap" } }] });
    if (href.includes("/comments/rate?")) return new Response(null, { status: 204 });
    if (href.includes("/comments?") && options.method === "POST") return json({ id: "posted1" });
    return json({ error: { errors: [{ reason: "notFound" }] } }, 404);
  };
}

test("counts unliked comments and replies once across the channel", async (t) => {
  installYouTube(t);
  const calls = [];
  const pages = {
    "": {
      items: [
        thread("t1", "videoOne1111", comment("old1", { rating: "like" }), [
          comment("ours", { author: channelId, text: "Thanks for watching.", at: "2026-11-16T12:05:00.000Z" }),
          comment("new1", { author: "UCviewer00000000000000002", name: "Ada", text: "What about the fourth quarter?", at: "2026-11-16T12:10:00.000Z" }),
        ]),
      ],
      nextPageToken: "page-2",
    },
    "page-2": { items: [thread("t2", "videoTwo2222", comment("plain", { text: "Loved the Sparks segment." }))] },
  };
  const asked = [];
  const result = await engageChannelComments({
    fetchImpl: youtubeFetch(pages, calls),
    repliedIds: ["plain"],
    replyFor: async (comment) => {
      asked.push(comment);
      return `Thanks, ${comment.author}. https://evil.example`;
    },
  });
  assert.deepEqual(asked.map((comment) => comment.text), ["What about the fourth quarter?"]);
  assert.equal(asked[0].videoTitle, "The Rundown");
  assert.equal(result.liked, 0);
  assert.equal(result.unliked, 2);
  assert.equal(result.replied, 1);
  assert.equal(result.remaining, 0);
  assert.equal(result.likesUnsupported, true);
  assert.ok(result.repliedIds.includes("plain"));
  assert.ok(result.repliedIds.includes("new1"));
  const post = calls.find((call) => call.method === "POST" && call.href.includes("/comments?"));
  assert.equal(JSON.parse(post.body).snippet.parentId, "old1");
  assert.equal(JSON.parse(post.body).snippet.textOriginal, "Thanks, Ada.");
  assert.equal(post.authorization, "Bearer test-token");
  assert.equal(calls.filter((call) => call.href.includes("/comments/rate?")).length, 0);
});

test("a missing like method still posts the model reply", async (t) => {
  installYouTube(t);
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    calls.push(href);
    if (href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "test-token" });
    if (href.includes("/channels?")) return json({ items: [{ id: channelId }] });
    if (href.includes("/commentThreads?")) return json({ items: [thread("t2", "videoTwo2222", comment("plain"))] });
    if (href.includes("/videos?")) return json({ items: [] });
    if (href.includes("/comments/rate?")) return json({ error: { message: "Not Found" } }, 404);
    if (href.includes("/comments?") && options.method === "POST") return json({ id: "posted1" });
    return json({ items: [] });
  };
  const result = await engageChannelComments({
    fetchImpl,
    replyFor: async () => "Glad you watched.",
  });
  assert.equal(result.liked, 0);
  assert.equal(result.replied, 1);
  assert.equal(result.likesUnsupported, true);
  assert.equal(calls.filter((href) => href.includes("/comments/rate?")).length, 0);
});

test("a comment the model declines is marked handled without posting", async (t) => {
  installYouTube(t);
  let posts = 0;
  const fetchImpl = async (url, options = {}) => {
    const href = String(url);
    if (href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "test-token" });
    if (href.includes("/channels?")) return json({ items: [{ id: channelId }] });
    if (href.includes("/commentThreads?")) return json({ items: [thread("t2", "videoTwo2222", comment("plain"))] });
    if (href.includes("/comments?") && options.method === "POST") { posts += 1; return json({ id: "posted1" }); }
    return json({ items: [] });
  };
  const result = await engageChannelComments({ fetchImpl, replyFor: async () => null });
  assert.equal(posts, 0);
  assert.equal(result.replied, 0);
  assert.equal(result.failed, 0);
  assert.equal(result.remaining, 0);
  assert.deepEqual(result.repliedIds, ["plain"]);
});

test("comment reads explain a token that can only upload", async (t) => {
  installYouTube(t);
  const fetchImpl = async (url) => {
    const href = String(url);
    if (href.startsWith("https://oauth2.googleapis.com/token")) return json({ access_token: "test-token" });
    return json({ error: { errors: [{ reason: "insufficientPermissions" }] } }, 403);
  };
  await assert.rejects(
    engageChannelComments({ fetchImpl, replyFor: async () => "Thanks." }),
    /youtube\.force-ssl/,
  );
});

test("draftCommentReply uses the sports model", async (t) => {
  for (const key of ["SPORTS_LLM_API", "SPORTS_LLM_FALLBACK_MODEL", "SPORTS_LLM_API_KEY"]) {
    const previous = process.env[key];
    delete process.env[key];
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  const previous = process.env.SPORTS_LLM_URL;
  process.env.SPORTS_LLM_URL = "https://model.example/v1";
  t.after(() => {
    if (previous === undefined) delete process.env.SPORTS_LLM_URL;
    else process.env.SPORTS_LLM_URL = previous;
  });
  const reply = await draftCommentReply(
    { author: "Sam", text: "Great recap of the Sparks game", videoTitle: "The Rundown" },
    { fetchImpl: async () => json({ choices: [{ message: { content: JSON.stringify({ reply: "Glad the Sparks recap landed." }) } }] }) },
  );
  assert.equal(reply, "Glad the Sparks recap landed.");

  // A stock "I don't have that in front of me" reply is rewritten once.
  const drafts = ["I don't have the foul count in front of me.", "those whistles were wild 😂"];
  let asked = 0;
  const human = await draftCommentReply(
    { author: "Sam", text: "How many fouls?", videoTitle: "The Rundown" },
    { fetchImpl: async () => json({ choices: [{ message: { content: JSON.stringify({ skip: false, reply: drafts[asked++] }) } }] }) },
  );
  assert.equal(human, "those whistles were wild 😂");
  assert.equal(asked, 2);

  // A slur gets no reply, without asking the model.
  let called = false;
  const skipped = await draftCommentReply(
    { author: "troll", text: "this game is goy slop", videoTitle: "GTA 6" },
    { fetchImpl: async () => { called = true; return json({}); } },
  );
  assert.equal(skipped, null);
  assert.equal(called, false);
});

test("the comment button runs across the channel and refuses a second pass while busy", async (t) => {
  const directory = await mkdtemp(path.join(root, "data", "sports-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const desk = new SportsDesk({
    directory,
    canResearch: () => true,
    canUpload: () => true,
    commentReply: async () => "Thanks for watching.",
    engage: async ({ replyFor }) => {
      await gate;
      assert.equal(await replyFor({ author: "Sam", text: "hello", videoTitle: "The Rundown" }), "Thanks for watching.");
      return { liked: 2, replied: 1, failed: 0, remaining: 3, likesUnsupported: false, error: null, likedIds: ["comment1"], repliedIds: ["comment1"] };
    },
  });
  const started = await desk.replyToComments();
  assert.equal(started.comments.status, "running");
  await assert.rejects(desk.replyToComments(), /already running/);
  release();
  await desk.commentWork;
  const done = await desk.view();
  assert.equal(done.comments.status, "done");
  assert.equal(done.comments.liked, 2);
  assert.equal(done.comments.replied, 1);
  assert.equal(done.comments.remaining, 3);
  assert.equal(done.comments.likedIds, undefined);

  const quiet = new SportsDesk({ directory, canResearch: () => false, canUpload: () => true });
  await assert.rejects(quiet.replyToComments(), /model/);
  const offline = new SportsDesk({ directory, canResearch: () => true, canUpload: () => false });
  await assert.rejects(offline.replyToComments(), /YouTube OAuth/);

  const { app } = await createApp({ sports: desk });
  const browser = request(app);
  const authenticate = (req) => process.env.SPORTS_DESK_PASSWORD
    ? req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD) : req;
  const again = await authenticate(browser.post("/api/sports/comments")).expect(202);
  assert.ok(["running", "done"].includes(again.body.comments.status));
  if (desk.commentWork) await desk.commentWork;
  assert.equal((await desk.view()).comments.status, "done");
});

test("the Comments tab lists threads newest first with replies in order and the channel's replies marked", () => {
  const comment = (id, author, channel, at, text, extra = {}) => ({ id, snippet: { authorDisplayName: author, authorChannelId: { value: channel }, publishedAt: at, textOriginal: text, likeCount: 2, ...extra } });
  const threads = presentThreads([
    { snippet: { videoId: "vid00000001", topLevelComment: comment("c1", "@fan", "UCfan", "2026-11-19T10:00:00Z", "Great show") },
      replies: { comments: [comment("r2", "@other", "UCother", "2026-11-19T12:00:00Z", "Agreed"), comment("r1", "Wellspring", "UCme", "2026-11-19T11:00:00Z", "Thanks!")] } },
    { snippet: { videoId: "vid00000002", topLevelComment: comment("c2", "@new", "UCnew", "2026-11-20T01:00:00Z", "<b>Boozer</b> all day") } },
    { snippet: { videoId: "vid00000002", topLevelComment: comment("c3", "@spam", "UCspam", "2026-11-20T02:00:00Z", "buy now", { moderationStatus: "likelySpam" }) } },
  ], { channelId: "UCme", titles: new Map([["vid00000001", "The Rundown | Nov 19"]]) });
  assert.deepEqual(threads.map(({ id }) => id), ["c3", "c2", "c1"]);
  const answered = threads.find(({ id }) => id === "c1");
  assert.equal(answered.videoTitle, "The Rundown | Nov 19");
  assert.equal(answered.answered, true);
  assert.deepEqual(answered.replies.map(({ id, mine }) => `${id}:${mine}`), ["r1:true", "r2:false"]);
  assert.equal(threads.find(({ id }) => id === "c2").answered, false);
  assert.equal(threads.find(({ id }) => id === "c2").text, "Boozer all day");
  assert.equal(threads[0].held, true);
});

test("the comment feed is cached briefly and served through the desk API", async (t) => {
  let loads = 0;
  let clock = 0;
  const feed = new CommentFeed({ now: () => clock, load: async () => {
    loads += 1;
    return [{ id: "c1", answered: false, held: false, replies: [] }, { id: "c2", answered: true, held: false, replies: [] }];
  } });
  assert.equal((await feed.view()).unanswered, 1);
  await feed.view();
  assert.equal(loads, 1, "a second view within two minutes uses the cache");
  await feed.view({ refresh: true });
  clock = 200_000;
  await feed.view();
  assert.equal(loads, 3);

  const directory = await mkdtemp(path.join(root, "data", "comments-tab-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const failing = { directory, settings: { timezone: "America/Chicago" }, now: () => new Date(), commentFeed: { view: async () => { throw new Error("YouTube comment quota is used up for today. Run this again tomorrow."); } } };
  const { app } = await createApp({ sports: failing });
  const signIn = (req) => process.env.SPORTS_DESK_PASSWORD ? req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD) : req;
  const failed = await signIn(request(app).get("/api/sports/comments/threads")).expect(409);
  assert.match(failed.body.error, /quota is used up/u);
  const working = await createApp({ sports: { ...failing, commentFeed: feed } });
  const listed = await signIn(request(working.app).get("/api/sports/comments/threads?refresh=1")).expect(200);
  assert.equal(listed.body.total, 2);
});
