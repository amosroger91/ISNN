import { youtubeAccessToken, youtubeConfigured } from "./youtube.mjs";

const API = "https://www.googleapis.com/youtube/v3";
const SKIPPED = new Set(["heldForReview", "likelySpam", "rejected"]);
const STOP = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "quotaExceeded", "dailyLimitExceeded"]);
const SCOPE_ERROR = "Reauthorize the YouTube channel with the youtube.force-ssl scope, then update YOUTUBE_REFRESH_TOKEN. The upload scope cannot read or reply to comments.";

export function blankComments() {
  return {
    status: "idle", liked: 0, replied: 0, failed: 0, remaining: 0,
    unliked: 0, likesUnsupported: false, error: null, at: null, likedIds: [], repliedIds: [],
  };
}

function idList(value) {
  if (!Array.isArray(value)) return [];
  return value.filter((id) => typeof id === "string" && /^[\w.-]{1,128}$/u.test(id)).slice(-5000);
}

export function normalizeComments(value) {
  const blank = blankComments();
  if (!value || typeof value !== "object") return blank;
  const status = ["idle", "running", "done", "failed"].includes(value.status) ? value.status : "idle";
  const count = (item) => Number.isInteger(item) && item >= 0 ? item : 0;
  return {
    ...blank,
    status,
    liked: count(value.liked),
    replied: count(value.replied),
    failed: count(value.failed),
    remaining: count(value.remaining),
    unliked: count(value.unliked),
    likesUnsupported: Boolean(value.likesUnsupported),
    error: typeof value.error === "string" ? value.error.slice(0, 300) : null,
    at: typeof value.at === "string" ? value.at : null,
    likedIds: idList(value.likedIds),
    repliedIds: idList(value.repliedIds),
  };
}

function authorId(comment) {
  return comment?.snippet?.authorChannelId?.value || "";
}

function publishedAt(comment) {
  const time = Date.parse(comment?.snippet?.publishedAt || "");
  return Number.isFinite(time) ? time : 0;
}

export function commentText(comment) {
  return String(comment?.snippet?.textOriginal || comment?.snippet?.textDisplay || "")
    .replace(/<[^>]*>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function usableId(id) {
  return typeof id === "string" && /^[\w.-]{1,128}$/u.test(id);
}

// One row per comment on the channel, top-level and reply, across every video.
export function flattenThreads(threads) {
  const entries = [];
  for (const thread of threads || []) {
    const top = thread?.snippet?.topLevelComment;
    if (!usableId(top?.id)) continue;
    const videoId = thread?.snippet?.videoId || top?.snippet?.videoId || "";
    const replies = thread?.replies?.comments || [];
    entries.push({ comment: top, videoId, topId: top.id });
    for (const reply of replies) {
      if (usableId(reply?.id)) entries.push({ comment: reply, videoId, topId: top.id });
    }
  }
  return entries;
}

export function planComments(entries, { channelId, repliedIds = new Set() } = {}) {
  const threads = new Map();
  for (const entry of entries) {
    const list = threads.get(entry.topId) || [];
    list.push(entry);
    threads.set(entry.topId, list);
  }
  const seen = new Set();
  const likes = [];
  const replies = [];
  for (const entry of entries) {
    const id = entry.comment?.id;
    if (!usableId(id) || seen.has(id) || authorId(entry.comment) === channelId) continue;
    const snippet = entry.comment.snippet || {};
    if (SKIPPED.has(snippet.moderationStatus)) continue;
    seen.add(id);
    if (snippet.viewerRating !== "like" && snippet.canRate !== false) likes.push(entry);
    const mine = (threads.get(entry.topId) || []).filter((item) => authorId(item.comment) === channelId);
    const answered = repliedIds.has(id) || mine.some((item) => publishedAt(item.comment) >= publishedAt(entry.comment));
    if (!answered) replies.push(entry);
  }
  const byTime = (a, b) => publishedAt(a.comment) - publishedAt(b.comment);
  likes.sort(byTime);
  replies.sort(byTime);
  return { likes, replies };
}

function withTimeout(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function youtubeError(response, context) {
  const body = await response.json().catch(() => null);
  const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
  const code = typeof reason === "string" && /^[\w.]{1,80}$/u.test(reason) ? `, ${reason}` : "";
  const error = new Error(`${context} (HTTP ${response.status}${code}).`);
  error.status = response.status;
  error.reason = typeof reason === "string" ? reason : "";
  return error;
}

function stopError(error) {
  if (!STOP.has(error.reason)) return null;
  if (error.reason === "quotaExceeded" || error.reason === "dailyLimitExceeded") {
    return new Error("YouTube comment quota is used up for today. Run this again tomorrow.");
  }
  return new Error(SCOPE_ERROR);
}

async function youtubeJson(request, url, context) {
  const response = await request(url, { method: "GET" });
  if (!response.ok) throw await youtubeError(response, context);
  return response.json();
}

async function ownChannel(request) {
  const url = new URL(`${API}/channels`);
  url.searchParams.set("part", "id");
  url.searchParams.set("mine", "true");
  const data = await youtubeJson(request, url, "Could not identify the YouTube channel");
  const id = data.items?.[0]?.id;
  if (!usableId(id)) throw new Error("YouTube did not return the channel id.");
  return id;
}

async function paged(request, build, context) {
  const items = [];
  const seen = new Set();
  let pageToken = "";
  for (let page = 0; page < 50; page += 1) {
    const url = build(pageToken);
    const data = await youtubeJson(request, url, context);
    items.push(...(data.items || []));
    if (!data.nextPageToken || seen.has(data.nextPageToken)) break;
    seen.add(data.nextPageToken);
    pageToken = data.nextPageToken;
  }
  return items;
}

function listThreads(request, channelId) {
  return paged(request, (pageToken) => {
    const url = new URL(`${API}/commentThreads`);
    url.searchParams.set("part", "snippet,replies");
    url.searchParams.set("allThreadsRelatedToChannelId", channelId);
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("textFormat", "plainText");
    url.searchParams.set("order", "time");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return url;
  }, "Could not list YouTube comments");
}

function listReplies(request, parentId) {
  return paged(request, (pageToken) => {
    const url = new URL(`${API}/comments`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("parentId", parentId);
    url.searchParams.set("maxResults", "100");
    url.searchParams.set("textFormat", "plainText");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    return url;
  }, "Could not list comment replies");
}

async function completeThreads(request, threads) {
  for (const thread of threads) {
    const top = thread?.snippet?.topLevelComment;
    const total = thread?.snippet?.totalReplyCount || 0;
    const included = thread?.replies?.comments?.length || 0;
    if (!usableId(top?.id) || total <= included) continue;
    const replies = await listReplies(request, top.id);
    thread.replies = { comments: replies };
  }
  return threads;
}

async function videoTitles(request, ids) {
  const titles = new Map();
  const unique = [...new Set(ids.filter(usableId))];
  for (let index = 0; index < unique.length; index += 50) {
    const url = new URL(`${API}/videos`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("id", unique.slice(index, index + 50).join(","));
    const data = await youtubeJson(request, url, "Could not read video titles").catch(() => null);
    for (const video of data?.items || []) if (video?.id) titles.set(video.id, video.snippet?.title || "");
  }
  return titles;
}

function publicReply(text) {
  return [...String(text || "").replace(/https?:\/\/\S+/giu, "").replace(/[<>]/g, "").replace(/\s+/gu, " ").trim()]
    .slice(0, 400)
    .join("")
    .trim();
}

function remember(ids, id) {
  return [...ids.filter((item) => item !== id), id].slice(-5000);
}

// The Comments tab: every thread on the channel, newest first, with its
// replies in order and the channel's own replies marked. Read-only.
function shownComment(comment, channelId) {
  const snippet = comment?.snippet || {};
  return {
    id: comment.id,
    author: String(snippet.authorDisplayName || "Viewer").slice(0, 80),
    text: commentText(comment).slice(0, 2000),
    publishedAt: snippet.publishedAt || null,
    likes: Number.isInteger(snippet.likeCount) ? snippet.likeCount : 0,
    mine: Boolean(channelId) && authorId(comment) === channelId,
    held: SKIPPED.has(snippet.moderationStatus),
  };
}

export function presentThreads(threads, { channelId, titles = new Map() } = {}) {
  const shown = [];
  for (const thread of threads || []) {
    const top = thread?.snippet?.topLevelComment;
    if (!usableId(top?.id)) continue;
    const videoId = thread?.snippet?.videoId || top?.snippet?.videoId || "";
    const replies = (thread?.replies?.comments || []).filter((reply) => usableId(reply?.id))
      .sort((a, b) => publishedAt(a) - publishedAt(b))
      .map((reply) => shownComment(reply, channelId));
    const comment = shownComment(top, channelId);
    shown.push({
      ...comment,
      videoId: usableId(videoId) ? videoId : "",
      videoTitle: String(titles.get(videoId) || "").slice(0, 140),
      replies,
      answered: comment.mine || replies.some((reply) => reply.mine),
    });
  }
  return shown.sort((a, b) => Date.parse(b.publishedAt || 0) - Date.parse(a.publishedAt || 0));
}

export async function channelThreads({ fetchImpl = fetch, signal } = {}) {
  if (!youtubeConfigured()) throw new Error("Configure the YouTube channel's offline OAuth credentials first.");
  const token = await youtubeAccessToken(fetchImpl, signal);
  const request = (url, options = {}) => fetchImpl(url.href, {
    ...options,
    redirect: "error",
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
    signal: withTimeout(signal, 30_000),
  });
  try {
    const channelId = await ownChannel(request);
    const threads = await completeThreads(request, await listThreads(request, channelId));
    const titles = await videoTitles(request, threads.map((thread) => thread?.snippet?.videoId || ""));
    return presentThreads(threads, { channelId, titles });
  } catch (error) {
    throw stopError(error) || error;
  }
}

// Caches the thread list briefly; every listing costs YouTube quota.
export class CommentFeed {
  constructor({ load = channelThreads, now = () => Date.now(), maxAge = 120_000 } = {}) {
    this.load = load;
    this.now = now;
    this.maxAge = maxAge;
    this.cached = null;
    this.loading = null;
  }

  async view({ refresh = false } = {}) {
    if (!refresh && this.cached && this.now() - this.cached.fetched < this.maxAge) return this.cached.view;
    this.loading ||= this.load().then((threads) => {
      const view = {
        threads,
        at: new Date(this.now()).toISOString(),
        total: threads.length,
        unanswered: threads.filter((thread) => !thread.answered && !thread.held).length,
      };
      this.cached = { view, fetched: this.now() };
      return view;
    }).finally(() => { this.loading = null; });
    return this.loading;
  }
}

export async function engageChannelComments({
  fetchImpl = fetch,
  signal,
  replyFor,
  likedIds = [],
  repliedIds = [],
  onProgress,
  maxReplies = Infinity,
} = {}) {
  if (!youtubeConfigured()) throw new Error("Configure the YouTube channel's offline OAuth credentials first.");
  if (typeof replyFor !== "function") throw new Error("A comment reply needs the sports model.");
  const token = await youtubeAccessToken(fetchImpl, signal);
  const request = (url, options = {}) => fetchImpl(url.href, {
    ...options,
    redirect: "error",
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
    signal: withTimeout(signal, 30_000),
  });
  let channelId;
  let threads;
  try {
    channelId = await ownChannel(request);
    threads = await completeThreads(request, await listThreads(request, channelId));
  } catch (error) {
    throw stopError(error) || error;
  }
  const entries = flattenThreads(threads);
  const planned = planComments(entries, { channelId, repliedIds: new Set(repliedIds) });
  const titles = await videoTitles(request, entries.map((entry) => entry.videoId));
  let replied = 0;
  let failed = 0;
  let replyBudget = maxReplies;
  let answered = idList(repliedIds);
  const pendingReplies = new Set(planned.replies.map(({ comment }) => comment.id));
  let error = null;

  const snapshot = () => ({
    liked: 0, replied, failed, error, unliked: planned.likes.length,
    likesUnsupported: planned.likes.length > 0,
    remaining: pendingReplies.size,
    likedIds: idList(likedIds),
    repliedIds: answered,
  });
  const report = async () => {
    try { await onProgress?.(snapshot()); } catch (progressError) { console.error(`[sports comments] ${progressError.message}`); }
  };

  await report();
  for (const entry of planned.replies) {
    if (replyBudget <= 0) break;
    signal?.throwIfAborted();
    const id = entry.comment.id;
    try {
      const text = publicReply(await replyFor({
        author: String(entry.comment.snippet?.authorDisplayName || "viewer").slice(0, 80),
        text: commentText(entry.comment).slice(0, 1000),
        videoTitle: String(titles.get(entry.videoId) || "").slice(0, 140),
      }));
      if (!text) throw new Error("The sports model returned an empty comment reply.");
      const url = new URL(`${API}/comments`);
      url.searchParams.set("part", "snippet");
      const response = await request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ snippet: { parentId: entry.topId, textOriginal: text } }),
      });
      if (!response.ok) throw await youtubeError(response, "Could not reply to the comment");
      replied += 1;
      replyBudget -= 1;
      pendingReplies.delete(id);
      answered = remember(answered, id);
    } catch (replyError) {
      const halted = stopError(replyError);
      if (halted) throw halted;
      failed += 1;
      error = replyError.message;
    }
    await report();
  }
  return snapshot();
}
