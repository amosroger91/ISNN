import { execFile, fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dataDir } from "../config.mjs";
import { DAILY_STORY_TARGET, MAX_EPISODE_STORIES, PREFERRED_SHORTS_COUNT } from "../../shared/sports-limits.mjs";
import { readJson, saveJson } from "../storage.mjs";
import { AssetCache } from "./assets.mjs";
import { FixtureEvidenceAdapter, scanSlate } from "./evidence.mjs";
import { EspnEvidenceAdapter } from "./espn/adapter.mjs";
import { EvidenceLedger, LedgerError, fingerprint, numbersIn } from "./ledger.mjs";
import { engageChannelComments, normalizeComments } from "./comments.mjs";
import { draftCommentReply, draftIsaacTake, editTopics, releaseResearchModel, researchConfigured, researchEdition, writeAnchorScript, writeEpisode, writeVideoListing } from "./research.mjs";
import { fallbackListing, finishListing, hashtagsFor, keywordTags, titleWithTags } from "./metadata.mjs";
import { cleanThumbnailLine, renderCutThumbnails, shortThumbnailsEnabled, thumbnailAllowed, thumbnailsEnabled } from "./thumbnail.mjs";
import { platesFor } from "./marks.mjs";
import { canUse, planShots } from "./rights.mjs";
import { OTHER_NEWS, coverageScope, groupByLeague, inScope, leagueFamily, sportName } from "./scope.mjs";
import { ReminderBook } from "./reminders.mjs";
import { opinionSegment, sampleEpisode, sampleTopics, scriptedSegment, takeNarration } from "./sample.mjs";
import { GoogleTrendingNowAdapter, collectObservations, scoreTrend, trendSegment } from "./trend.mjs";
import { openingIntro } from "./dates.mjs";
import { verifySupportedNames } from "./copy-checks.mjs";
import { directEditorialAnswer, directEditorialSelection, editorialEdits, questionOnly } from "./editorial.mjs";
import { classifyThumbnailError, setThumbnail, uploadEpisode, youtubeConfigured, youtubeDescription, youtubeTitle } from "./youtube.mjs";

const maxTopics = 48;
const overnightRetry = 15 * 60_000;
// Automatic retries for one job. Narration, footage and cuts are cached, so a
// retry resumes; a job that still fails after this many stops and shows why.
const MAX_GENERATION_RETRIES = Number(process.env.SPORTS_MAX_RETRIES) || 3;
const DETERMINISTIC_FAILURE = /did not pass output validation|kept stuttering|Reword that line/u;
// Copy corrections from the model take seconds and usually succeed on a later
// pass, so they get more tries than a render.
const MODEL_CORRECTION = /sports copy|model returned|editorial review|invalid feed match|unsupported numbers/iu;
const retryLimit = (error) => (MODEL_CORRECTION.test(error.message) ? MAX_GENERATION_RETRIES * 3 : MAX_GENERATION_RETRIES);
// Fact-check corrections and other failures count separately, so a story that
// took several drafts does not use up the retries a later render failure needs.
const retryKind = (error) => (MODEL_CORRECTION.test(error.message) ? "corrections" : "failures");
// A story whose drafts keep failing the fact check is left out of the show
// after this many rounds, instead of failing the whole build.
const STORY_ROUNDS = 5;
const uploadRetry = 4 * 60_000;
// Shorts keep uploading (and retrying) through 10:59 local after the 8 a.m. episode.
const shortsUntilHour = 10;
const quotaSpent = /quotaExceeded|uploadLimitExceeded|dailyLimitExceeded|rateLimitExceeded/u;
const airHour = 8;
// The episode goes public at 8 a.m.; the Shorts are spread from 10 a.m. to
// 9 p.m. (desk time) so the channel posts all day instead of all at once.
const shortsFirstHour = 10;
const shortsLastHour = 21;
// YouTube needs a scheduled time comfortably in the future; a Short whose
// slot has passed (a late or manual upload) goes public at once.
const scheduleLead = 15 * 60_000;
// If the episode is not on YouTube this long after air time, the desk starts
// the Emergency fix agent once for that day (see uploadEmergency).
const uploadEmergencyAfter = 15 * 60_000;
const workerFile = fileURLToPath(new URL("./render-worker.mjs", import.meta.url));
const sentenceSplitter = new Intl.Segmenter("en-US", { granularity: "sentence" });

export function deskError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function localClock(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
}

// The next day's edition opens at 9 p.m. so the editor has the evening for
// editorial work before the overnight build. After the rollover, hour counts
// back from the show date's midnight (21:00 is -3), so it stays "overnight".
export const rolloverHour = 21;
export function editionClock(now, timezone) {
  const local = localClock(now, timezone);
  if (local.hour < rolloverHour) return local;
  const next = new Date(Date.parse(`${local.date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
  return { date: next, hour: local.hour - 24 };
}

// The UTC instant of a local wall-clock hour on a date in the desk's time zone.
export function zonedTime(date, hour, timezone) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess)).map(({ type, value }) => [type, value]));
  const seen = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (seen - guess)).toISOString();
}

function killTree(child) {
  if (process.platform === "win32" && child.pid) {
    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true }, () => {});
  } else child.kill("SIGKILL");
}

async function isolatedRender(episode, directory, onProgress, signal) {
  onProgress({ percent: 4, message: "Freeing local model memory for Isaac’s narration…" });
  await releaseResearchModel();
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = fork(workerFile, [], { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    let cancellation;
    const abort = () => {
      if (worker.connected) worker.send({ cancel: true }, () => {});
      // A forced stop takes the whole tree: on Windows, killing the worker
      // alone left its narrator and ffmpeg children running.
      cancellation = setTimeout(() => killTree(worker), 5000).unref();
    };
    signal?.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(() => {
      reject(new Error("The sports render exceeded its 2-hour time limit."));
      abort();
    }, 120 * 60_000).unref();
    worker.on("message", ({ progress, metadata, error }) => {
      if (progress) onProgress(progress);
      if (metadata) resolve(metadata);
      if (error) reject(new Error(error));
    });
    worker.once("error", reject);
    worker.once("exit", () => {
      clearTimeout(timeout);
      clearTimeout(cancellation);
      signal?.removeEventListener("abort", abort);
      reject(new Error("The sports render worker stopped unexpectedly."));
    });
    worker.send({ episode, directory }, (error) => { if (error) reject(error); });
  });
}

function createEdition(date, sample = false) {
  return {
    date, sample, status: "waiting", revision: 0, topics: sample ? sampleTopics() : [], messages: [],
    render: null, publication: { status: "pending" }, updatedAt: null,
    slate: [], corrections: [], trendDesk: { coreTopicId: null, lockedAt: null, checks: [] }, verification: null,
    scanFailures: 0, lastScanAttempt: null,
  };
}

function publicYoutube(youtube = {}) {
  const strip = (slot) => {
    if (!slot) return { status: "pending" };
    const { sessionUrl, ...rest } = slot;
    return { status: "pending", ...rest };
  };
  const shorts = {};
  for (const [key, slot] of Object.entries(youtube.shorts || {})) shorts[key] = strip(slot);
  return {
    episode: strip(youtube.episode),
    shorts,
    ...(youtube.thumbnailHalt ? { thumbnailHalt: youtube.thumbnailHalt } : {}),
  };
}

function presentComments(state, running) {
  const { likedIds, repliedIds, ...shown } = state;
  if (shown.status === "running" && !running) {
    return { ...shown, status: "failed", error: shown.error || "Comment replies stopped before they finished. Run them again." };
  }
  return shown;
}

function publicView(edition, settings, progress) {
  const { sessionUrl, ...publication } = edition.publication;
  const { episode, ...render } = edition.render || {};
  const { anchorCache, scriptCache, ...visible } = edition;
  return {
    edition: {
      ...visible, render: edition.render ? render : null, publication, youtube: publicYoutube(edition.youtube),
      releases: (edition.releases || []).map(({ revision, publication, youtube, render, at }) => ({ revision, at,
        publication: { status: publication?.status, url: publication?.url, id: publication?.id }, youtube: publicYoutube(youtube),
        render: render ? { revision: render.revision, build: render.build, url: render.url, title: render.title } : null,
      })),
      locked: publicationLocked(edition), progress,
    },
    settings,
  };
}

const publicationLocked = ({ publication }) => Boolean(publication.sessionUrl || ["uploading", "published", "uncertain"].includes(publication.status));

// The announcer opens each league's block ("And now for the NBA news.") and
// returns the sports in airing order for the opening roll call.
export function announceSports(segments) {
  const lineup = [];
  segments.forEach((segment, index) => {
    const family = leagueFamily(segment.league);
    delete segment.bumper;
    if (!family || segment.kind === "trend" || (index > 0 && leagueFamily(segments[index - 1].league) === family)) return;
    const leagues = [];
    for (let next = index; next < segments.length && leagueFamily(segments[next].league) === family; next++) leagues.push(segments[next].league);
    const name = sportName(leagues);
    segment.bumper = lineup.length ? `And now for the ${name.news} news.` : `We start with the ${name.news} news.`;
    lineup.push(name.spoken);
  });
  return lineup;
}

function message(role, content, at) {
  return { id: randomUUID(), role, content, at };
}

function topicsScripted(edition) {
  const selected = edition.topics.filter((topic) => topic.selected);
  return selected.length > 0 && selected.every((topic) => topic.script?.narration || takeNarration(topic));
}

function newTopic({ title, summary = "", take = "", takeScript = "", selected = true, clipUrl = "", url, excerpt = "", sport = null, league = null, teams = [] }) {
  return {
    id: randomUUID(), title, summary, take, selected, sport, league, teams, ...(clipUrl && { clipUrl }), ...(takeScript && { takeScript }),
    sources: url ? [{ title: "Source supplied by Isaac", publisher: new URL(url).hostname, url, excerpt }] : [],
  };
}

// Discovered highlight references: a public page, duration and restrictions.
// Isaac's decisions survive a rescan; a suggested range is 8 seconds and the
// hard cap is 15. No media is ever fetched for these.
const CLIP_SUGGESTED = 8;
const CLIP_CAP = 15;
function mergeClips(existing = [], discovered = []) {
  const kept = new Map(existing.map((clip) => [clip.id, clip]));
  return discovered.slice(0, 8).map((clip) => {
    const prior = kept.get(clip.id);
    const out = Math.min(CLIP_SUGGESTED, clip.duration || CLIP_SUGGESTED);
    return { ...clip, decision: prior?.decision || null, in: prior?.in ?? 0, out: prior?.out ?? out, reviewedAt: prior?.reviewedAt || null, reviewedBy: prior?.reviewedBy || null };
  });
}

// What counts as an editorial change: everything about a topic except the
// volatile parts of its last trend check.
const topicsDigest = (topics) => JSON.stringify(topics.map(({ trend, ...topic }) => ({ ...topic, trend: trend && { airable: trend.airable, query: trend.query, matchedStoryId: trend.matchedStoryId } })));

function mergeResearch(existing, researched) {
  const urls = new Set(existing.flatMap((topic) => topic.sources.map((source) => source.url)));
  const titles = new Set(existing.map((topic) => topic.title.toLowerCase()));
  const fresh = researched.filter((topic) => !titles.has(topic.title.toLowerCase()) && !topic.sources.some(({ url }) => urls.has(url)));
  return [...existing, ...fresh].slice(0, maxTopics);
}

function previewChat(content, topicId) {
  const [, field, value] = /^(take|title|summary|add):\s*(\S[\s\S]*)$/i.exec(content) || [];
  if (field?.toLowerCase() === "add") {
    return { reply: "I added the topic to the rundown. Give it a take to include it in the practice video.", edits: [{ title: value }] };
  }
  if (topicId && field) return { reply: "I updated the selected topic.", edits: [{ id: topicId, [field.toLowerCase()]: value }] };
  if (topicId && /^(include|exclude)$/i.test(content)) {
    return { reply: "I updated the lineup.", edits: [{ id: topicId, selected: /^include$/i.test(content) }] };
  }
  return { reply: "For the practice edition, type ‘add: Your topic’ or select a topic and type ‘take: Your analysis’, ‘title: New title’, ‘include’ or ‘exclude’.", edits: [] };
}

const hostOf = (url) => {
  try {
    return new URL(url).hostname;
  } catch {
    return "source";
  }
};
const opinionBlock = /^Isaac[’']s take\.?/iu;

// Feed-sourced copy: each cited source becomes a snapshot, each numbered
// sentence a claim whose numbers must appear in one of those sources.
function deriveClaims(ledger, segment, topic, at) {
  const sources = (segment.sources || []).filter((source) => source.excerpt?.trim() && source.url);
  if (!sources.length) return [];
  const storyId = topic?.storyId || topic?.eventId || topic?.id || segment.id || "segment";
  const snapshots = sources.map((source) => ({ source, snapshot: ledger.snapshot({
    provider: source.publisher || hostOf(source.url), originGroup: source.publisher || hostOf(source.url), sourceUrl: source.url, sourceTime: source.publishedAt || null,
    retrievedAt: at, kind: "wire", title: source.title || null, excerpt: source.excerpt, allowedUses: ["verify"], retention: "excerpt",
  }) }));
  const ids = snapshots.map(({ source, snapshot }) => ledger.claim({
    storyId, key: `source:${snapshot.id}`, text: source.title || `Reporting by ${source.publisher || hostOf(source.url)}`, evidence: [{ snapshotId: snapshot.id, locator: "title and excerpt" }], at,
  }).id);
  const blocks = [segment.headline, ...String(segment.narration || "").split(/\n\n+/u).filter((block) => !opinionBlock.test(block))];
  for (const block of blocks) {
    for (const { segment: sentence } of sentenceSplitter.segment(block)) {
      const numbers = numbersIn(sentence);
      if (!numbers.length) continue;
      const support = snapshots.filter(({ source }) => {
        const present = new Set(numbersIn(`${source.title} ${source.excerpt}`));
        return numbers.every((number) => present.has(number));
      });
      ids.push(ledger.claim({
        storyId, key: `derived:${fingerprint(sentence.trim()).slice(0, 12)}`, text: sentence.trim(), value: numbers.map(Number), unit: "as written",
        evidence: support.map(({ snapshot }) => ({ snapshotId: snapshot.id, locator: "excerpt" })), reason: support.length ? null : "The number does not appear in any cited source.", at,
      }).id);
    }
  }
  return ids;
}

// The attention numbers in a trend segment are claims too, bound to the
// scorecard's own snapshot of the provider feed.
function trendClaims(ledger, segment, at) {
  return (segment.trend || []).map((card) => {
    const snapshot = ledger.snapshot({
      provider: card.providers[0] || "attention", originGroup: card.providers[0] || "attention", sourceUrl: card.sourceUrl || undefined, recordId: card.sourceUrl ? undefined : `trend:${card.storyId}:${card.checkedAt}`,
      sourceTime: card.observedAt, retrievedAt: card.retrievedAt || at, kind: "wire", title: `Trending: ${card.query}`, payload: card, allowedUses: ["verify", "display"], retention: "full",
    });
    return ledger.claim({
      storyId: card.storyId, key: `trend:${card.query}`, text: card.explanation[0] || `Trending: ${card.query}`, value: card.score, unit: card.unit,
      evidence: [{ snapshotId: snapshot.id, locator: `${card.metric} at ${card.observedAt}` }], at,
    }).id;
  });
}

export class SportsDesk {
  constructor({
    directory = path.join(dataDir, "sports"),
    timezone = process.env.SPORTS_TIMEZONE || "America/Chicago",
    publishEnabled = process.env.SPORTS_PUBLISH_ENABLED === "true",
    privacy = process.env.YOUTUBE_PRIVACY_STATUS || "public",
    channel = process.env.SPORTS_CHANNEL || "isnn-youtube",
    territory = process.env.SPORTS_TERRITORY || "worldwide",
    now = () => new Date(),
    research = researchEdition,
    write = writeEpisode,
    anchor = writeAnchorScript,
    listing = writeVideoListing,
    draftTake = draftIsaacTake,
    commentReply = draftCommentReply,
    chat = editTopics,
    render = isolatedRender,
    upload = uploadEpisode,
    thumbnail = setThumbnail,
    engage = engageChannelComments,
    canResearch = researchConfigured,
    canUpload = youtubeConfigured,
    evidence,
    trend = [new GoogleTrendingNowAdapter()],
    catalog = null,
    scope = coverageScope(),
    rebuildDelay = 2500,
    generationRetryDelay = 10_000,
    emergency = null,
    authCheck = null,
  } = {}) {
    this.directory = directory;
    this.scope = scope;
    this.evidence = evidence || (process.env.SPORTS_EVIDENCE === "espn" ? new EspnEvidenceAdapter({ timezone, assets: new AssetCache() }) : new FixtureEvidenceAdapter());
    this.settings = {
      timezone, publishEnabled, privacy, channel, territory, dailyStoryTarget: DAILY_STORY_TARGET, preferredShortsCount: PREFERRED_SHORTS_COUNT, maxEpisodeStories: MAX_EPISODE_STORIES, researchConfigured: canResearch(), youtubeConfigured: canUpload(),
      evidenceProvider: this.evidence?.name || null, trendProviders: trend.map((adapter) => adapter.name), scope,
    };
    this.now = now;
    this.reminders = new ReminderBook({ file: path.join(directory, "reminders.json"), timezone, now: () => this.now() });
    this.research = research;
    this.write = write;
    this.anchor = anchor;
    this.listing = listing;
    this.generateTake = draftTake;
    this.commentReply = commentReply;
    this.engage = engage;
    this.ask = chat;
    this.render = render;
    this.upload = upload;
    this.thumbnail = thumbnail;
    this.trendAdapters = trend;
    this.catalog = catalog;
    this.rebuildDelay = rebuildDelay;
    this.generationRetryDelay = generationRetryDelay;
    // The Emergency fix agent (emergency.mjs). Production only: tests and
    // sandboxes leave it null, so nothing is ever launched from them.
    this.emergency = emergency;
    // Production only: checks the YouTube sign-in through the day so an expired
    // refresh token shows on the desk the evening before, not at 8 a.m.
    this.authCheck = authCheck;
    this.youtubeAuth = null;
    this.youtubeAuthChecking = null;
    this.tail = Promise.resolve();
    this.commentWork = null;
  }

  clock() {
    return editionClock(this.now(), this.settings.timezone);
  }

  airTimeFor(date) {
    return zonedTime(date, airHour, this.settings.timezone);
  }

  serialized(action) {
    const run = this.tail.then(action);
    this.tail = run.catch(() => {});
    return run;
  }

  directoryFor({ date, sample }) {
    return path.join(this.directory, sample ? "practice" : "editions", date);
  }

  ledgerFor(edition) {
    return EvidenceLedger.open(path.join(this.directoryFor(edition), "ledger.json"));
  }

  // The rights catalog: an operator drop at DATA_DIR/sports/rights.json plus
  // whatever the evidence adapter delivered with each game.
  async catalogFor(edition) {
    let base = this.catalog;
    if (!base) {
      base = await readJson(path.join(this.directory, "rights.json")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return { assets: [], grants: [] };
      });
    }
    const assets = new Map((base.assets || []).map((asset) => [asset.id, asset]));
    const grants = new Map((base.grants || []).map((grant) => [grant.id, grant]));
    for (const topic of edition.topics) {
      for (const asset of topic.media?.assets || []) if (!assets.has(asset.id)) assets.set(asset.id, asset);
      for (const grant of topic.media?.grants || []) if (!grants.has(grant.id)) grants.set(grant.id, grant);
    }
    return { assets: [...assets.values()], grants: [...grants.values()] };
  }

  async load(date) {
    const read = (sample) => readJson(path.join(this.directoryFor({ date, sample }), "edition.json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const sample = !this.settings.researchConfigured && this.evidence?.name !== "espn";
    const edition = (await read(false)) || (sample && await read(true)) || createEdition(date, sample);
    for (const [key, value] of Object.entries(createEdition(date, sample))) if (edition[key] === undefined) edition[key] = value;
    if (this.work?.date !== date) {
      if (["researching", "building"].includes(edition.status)) {
        edition.status = "failed";
        edition.error = "The studio restarted before the job finished. Run the job again to continue.";
      }
      if (edition.publication.status === "uploading") {
        edition.publication.status = "failed";
        edition.publication.error = "The studio restarted during publishing. The next attempt will check the saved upload session.";
      }
      const interrupted = "The studio restarted during the YouTube upload. The next attempt will check the saved upload session.";
      if (edition.youtube?.episode?.status === "uploading") {
        edition.youtube.episode.status = "failed";
        edition.youtube.episode.error = interrupted;
      }
      for (const slot of Object.values(edition.youtube?.shorts || {})) {
        if (slot?.status === "uploading") {
          slot.status = "failed";
          slot.error = interrupted;
        }
      }
    }
    return edition;
  }

  save(edition) {
    let included = 0;
    for (const topic of edition.topics) if (topic.selected && ++included > MAX_EPISODE_STORIES) topic.selected = false;
    edition.updatedAt = this.now().toISOString();
    return saveJson(path.join(this.directoryFor(edition), "edition.json"), edition);
  }

  commentsFile() {
    return path.join(this.directory, "comments.json");
  }

  async loadComments() {
    const saved = await readJson(this.commentsFile()).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    return normalizeComments(saved);
  }

  saveComments(state) {
    return saveJson(this.commentsFile(), normalizeComments(state));
  }

  async response(edition) {
    const view = publicView(edition, this.settings, this.work?.date === edition.date ? this.work.progress : undefined);
    view.comments = presentComments(await this.loadComments(), Boolean(this.commentWork));
    view.edition.uploadAvailability = await this.uploadAvailability(edition);
    view.edition.youtubeAuth = this.youtubeAuth;
    return view;
  }

  view() {
    return this.serialized(async () => this.response(await this.load(this.clock().date)));
  }

  ledgerView() {
    return this.serialized(async () => (await this.ledgerFor(await this.load(this.clock().date))).view());
  }

  async readCurrent(expectedDate) {
    const { date } = this.clock();
    if (expectedDate && expectedDate !== date) throw deskError(409, "A new edition just opened. Refresh before editing.");
    return this.load(date);
  }

  ensureEditable(edition) {
    if (publicationLocked(edition)) {
      throw deskError(409, "This edition is locked because its video was submitted to YouTube.");
    }
  }

  async beginRevision(edition) {
    if (edition.publication?.status !== "published") {
      this.ensureEditable(edition);
      return edition;
    }
    if (this.work || Object.values(edition.youtube?.shorts || {}).some((slot) => slot?.status === "uploading")) throw deskError(409, "Wait for the current studio job to finish before starting a new revision.");
    edition.releases = [...(edition.releases || []), {
      revision: edition.render?.revision ?? edition.revision, at: this.now().toISOString(),
      publication: edition.publication, youtube: edition.youtube || {}, render: edition.render,
      // What aired, so researching this edition again never repeats it.
      topics: edition.topics.filter(({ selected }) => selected),
    }];
    edition.publication = { status: "pending" };
    edition.youtube = {};
    edition.manualRevision = true;
    edition.revision++;
    edition.status = "waiting";
    edition.error = null;
    edition.verification = null;
    edition.buildAttempts = 0;
    edition.lastBuildAttempt = null;
    await this.save(edition);
    return edition;
  }

  reopen(expectedDate) {
    return this.serialized(async () => this.response(await this.beginRevision(await this.readCurrent(expectedDate))));
  }

  launch(edition, task, callback, target = null) {
    const work = { date: edition.date, task, target, revision: edition.revision, controller: new AbortController() };
    this.work = work;
    const generation = task === "build" || task === "research";
    const execute = async () => {
      for (;;) {
        work.controller.signal.throwIfAborted();
        try { return await (work.resume || callback)(); }
        catch (error) {
          if (!generation || work.controller.signal.aborted || error instanceof LedgerError ||
              (error.status >= 400 && error.status < 500) || /Set SPORTS_|Select at least|Select up to|needs reported evidence|HTTP (?:401|403|404)/u.test(error.message) ||
              // The same input fails the same way: show it instead of rendering again.
              DETERMINISTIC_FAILURE.test(error.message) ||
              (!error.storyRound && (work[retryKind(error)] || 0) >= retryLimit(error))) throw error;
          const stage = work.progress?.message || "Generating the video";
          work.lastError = error.message;
          work.retries = (work.retries || 0) + 1;
          if (!error.storyRound) work[retryKind(error)] = (work[retryKind(error)] || 0) + 1;
          const retryDelay = error.storyRound ? Math.min(this.generationRetryDelay, 5_000) : Math.min(this.generationRetryDelay * work.retries, 60_000);
          let superseded = false;
          await this.serialized(async () => {
            const latest = await this.load(work.date);
            if (latest.revision !== work.revision) { this.rebuildDate = work.date; superseded = true; return; }
            latest.error = null;
            // A story redraft is routine progress, not a failure: no error text
            // and no retry notice on the page.
            latest.generationRetry = error.storyRound ? null : { attempt: work.retries, error: error.message, stage, retryAt: new Date(this.now().getTime() + retryDelay).toISOString() };
            work.progress = error.storyRound
              ? { percent: work.progress?.percent || 2, message: `${error.redraft}…` }
              : { percent: work.progress?.percent || 2, message: `Retrying automatically in ${Math.ceil(retryDelay / 1000)}s (retry ${work.retries}). ${stage}. ${error.message}` };
            await this.save(latest);
          });
          if (superseded) return;
          console.warn(`[sports ${task}] automatic retry ${work.retries}: ${error.message}`);
          await delay(retryDelay, undefined, { signal: work.controller.signal });
        }
      }
    };
    work.done = Promise.resolve().then(execute).catch(async (error) => {
      if (generation && work.controller.signal.aborted) {
        await this.serialized(async () => {
          const latest = await this.load(work.date);
          latest.status = "waiting";
          latest.error = null;
          latest.generationRetry = null;
          latest.buildPaused = true;
          await this.save(latest);
        });
        return;
      }
      const cause = error.cause?.message ? ` (${error.cause.name || "cause"}: ${error.cause.message})` : "";
      console.error(`[sports ${task} ${work.date}] ${error.message}${cause}`);
      await this.serialized(async () => {
        const latest = await this.load(work.date);
        if (task === "publish") {
          latest.publication.status = error.uploadUncertain ? "uncertain" : "failed";
          latest.publication.error = error.message;
        } else if (task === "youtube") {
          const slot = this.youtubeSlot(latest, work.target);
          this.assignYoutubeSlot(latest, work.target, {
            ...slot, status: error.uploadUncertain ? "uncertain" : "failed", error: error.message,
          });
        } else {
          latest.status = "failed";
          latest.error = error.message;
          if (error instanceof LedgerError && error.details?.revision) {
            latest.verification = { revisionId: error.details.revision.id, revision: error.details.revision.revision, ok: false, issues: error.details.issues, at: this.now().toISOString() };
          }
        }
        await this.save(latest);
      });
    }).catch(console.error).finally(() => {
      this.work = null;
      if (this.rebuildDate) this.scheduleBuild(this.rebuildDate);
      if (task === "youtube" && this.uploadQueue?.date === work.date) this.continueUploadAll().catch(console.error);
    });
  }

  async cancelGeneration(expectedDate) {
    const work = await this.serialized(async () => {
      await this.readCurrent(expectedDate);
      const active = this.work;
      if (!active || !["build", "research"].includes(active.task)) return null;
      this.rebuildDate = null;
      clearTimeout(this.rebuildTimer);
      active.controller.abort();
      return active;
    });
    if (work) await work.done;
    return this.view();
  }

  async queueResearch(edition) {
    if (!this.settings.researchConfigured || edition.sample) throw deskError(409, "Set a sports research model to run live research. The practice rundown is available now.");
    this.ensureEditable(edition);
    edition.buildPaused = false;
    edition.generationRetry = null;
    edition.status = "researching";
    edition.error = null;
    edition.lastResearchAttempt = this.now().toISOString();
    edition.researchAttempts = (edition.researchAttempts || 0) + 1;
    const scheduled = await this.applyScheduledTopics(edition);
    await this.save(edition);
    this.launch(edition, "research", async () => {
      const aired = (edition.releases || []).flatMap((release) => release.topics || []);
      const topics = await this.research(edition.date, { signal: this.work.controller.signal, existing: structuredClone(edition.topics), ...(scheduled.length && { scheduled }), ...(aired.length && { aired: structuredClone(aired) }) });
      const snapshot = await this.serialized(async () => {
        const current = await this.load(edition.date);
        const merged = mergeResearch(current.topics, topics);
        if (!current.researchedAt || merged.length !== current.topics.length) {
          current.revision++;
          current.buildAttempts = 0;
        }
        current.topics = merged;
        current.researchedAt = this.now().toISOString();
        await this.markBuilding(current);
        this.work.revision = current.revision;
        return current;
      });
      this.work.resume = () => this.produce(snapshot);
      await this.work.resume();
    });
  }

  // Story topics Isaac scheduled on the calendar for this show day lead the
  // rundown. Each joins once per edition (deleting it keeps it out); the build
  // then matches its informal framing to real reporting like any editor story.
  // Returns every topic scheduled for the day, so research does not repeat them.
  async applyScheduledTopics(edition) {
    const due = await this.reminders.topicsFor(edition.date).catch((error) => {
      console.warn(`[sports calendar] ${error.message}`);
      return [];
    });
    const applied = new Set(edition.scheduledTopics || []);
    const added = [];
    for (const entry of due) {
      if (applied.has(entry.id) || edition.topics.length + added.length >= maxTopics) continue;
      const other = entry.category === "other";
      const included = edition.topics.filter(({ selected }) => selected).length + added.length;
      added.push({
        ...newTopic({ title: entry.title, summary: entry.notes, selected: included < MAX_EPISODE_STORIES, ...(other && { sport: "other", league: OTHER_NEWS }) }),
        scheduled: { id: entry.id, date: edition.date },
      });
      applied.add(entry.id);
    }
    if (added.length) {
      edition.topics = [...added, ...edition.topics];
      edition.scheduledTopics = [...applied];
    }
    return due.map(({ title, notes }) => ({ title, notes }));
  }

  async markBuilding(edition) {
    edition.status = "building";
    edition.error = null;
    edition.lastBuildAttempt = this.now().toISOString();
    edition.buildAttempts = (edition.buildAttempts || 0) + 1;
    await this.save(edition);
  }

  // Trend angles cleared for this edition: airable cards on included topics
  // that sit inside the locked core story's scope.
  trendAngles(edition) {
    const { coreTopicId } = edition.trendDesk || {};
    return edition.topics.filter((topic) => topic.selected && topic.trend?.airable && (!coreTopicId || topic.id === coreTopicId || topic.trend.scope === "secondary"))
      .map((topic) => ({ topic, card: topic.trend }));
  }

  // Locks the rundown revision in the ledger: every segment's claims resolved,
  // every number licensed, then the public claims attached for credits.json.
  async bindEvidence(snapshot, episode) {
    const ledger = await this.ledgerFor(snapshot);
    const selected = snapshot.topics.filter((topic) => topic.selected);
    const at = this.now().toISOString();
    const stories = episode.segments.map((segment, index) => {
      const topic = snapshot.topics.find((candidate) => candidate.id === segment.topicId) || (segment.kind === "trend" ? null : selected[index]);
      // A trend segment rests on its attention snapshot and on the claims of the verified story it points at.
      const claimIds = new Set(segment.kind === "trend"
        ? [...trendClaims(ledger, segment, at), ...(segment.topicIds || []).flatMap((id) => snapshot.topics.find((candidate) => candidate.id === id)?.claimIds || [])]
        : topic?.claimIds || []);
      // Feed-sourced copy derives its claims from the cited excerpts; a story scanned from evidence already carries typed claims.
      if (segment.kind !== "trend" && !segment.opinion && !topic?.claimIds?.length) for (const id of deriveClaims(ledger, segment, topic, at)) claimIds.add(id);
      const storyId = segment.kind === "trend" ? segment.trend?.[0]?.storyId || null : topic?.storyId || topic?.eventId || null;
      return {
        segmentId: segment.id || topic?.eventId || `segment-${String(index + 1).padStart(2, "0")}`, topicId: topic?.id || null, storyId,
        eventId: topic?.eventId ? ledger.latestEvent(topic.eventId)?.id || null : null, kind: segment.kind || "story",
        headline: segment.headline, narration: segment.narration, claimIds: [...claimIds], opinion: Boolean(segment.opinion), trend: segment.trend?.[0] || null,
        wording: { byIsaac: topic?.take?.trim() || null },
      };
    });
    let revision;
    try {
      revision = ledger.lockRevision({
        date: snapshot.date, revision: snapshot.revision, stories, at,
        approvals: [{ by: "desk", at, kind: "deterministic evidence review" }], packageDigest: fingerprint({ title: episode.title, segments: episode.segments.map(({ headline, narration }) => ({ headline, narration })) }),
      });
    } finally {
      await ledger.save();
    }
    episode.segments = episode.segments.map((segment, index) => ({
      ...segment, id: revision.stories[index].segmentId, claims: ledger.publicClaims(revision.stories[index].claimIds), citations: revision.stories[index].citations,
    }));
    episode.revisionId = revision.id;
    return { ledger, revision };
  }

  // Live editions: stories scanned from evidence render from their scripts;
  // only feed-sourced and take-only topics go to the model writer.
  async writeLive(snapshot) {
    const selected = snapshot.topics.filter((topic) => topic.selected);
    if (!this.settings.researchConfigured) {
      return { title: "Wellspring Media Sports", description: "The overnight recap.", segments: selected.map((topic) => topic.script ? scriptedSegment(topic) : opinionSegment(topic)) };
    }
    const unscripted = selected.filter((topic) => !topic.script);
    const written = { title: "Wellspring Media Sports", description: "The overnight recap with every number bound to its evidence.", segments: [], topicSources: [] };
    const cache = snapshot.scriptCache || {};
    snapshot.scriptCache = cache;
    // A story with no reporting is left out with its reason; the rest still air.
    snapshot.skipped = {};
    // The last draft the fact check rejected, for Isaac to mark true.
    snapshot.rejected = {};
    const pieces = new Map();
    for (const [index, topic] of unscripted.entries()) {
      const key = fingerprint({ version: 4, model: process.env.SPORTS_LLM_MODEL, topic });
      // Left out by an earlier attempt (saved with the verified scripts, so a
      // restart does not redraft it). Editing the story changes its key.
      const leftOut = cache[key]?.leftOut;
      if (leftOut) {
        snapshot.skipped[topic.id] = leftOut;
        if (cache[key].draft) snapshot.rejected[topic.id] = cache[key].draft;
        continue;
      }
      this.work.progress = { percent: 2 + Math.round(index / unscripted.length * 2), message: `${cache[key] ? "Using verified script" : "Writing and checking story"} ${index + 1} of ${unscripted.length}: ${topic.title}` };
      let piece = cache[key];
      if (!piece) {
        try {
          piece = await this.write({ ...snapshot, topics: [topic] }, { signal: this.work.controller.signal, editorialFeedback: this.work.lastError });
        } catch (error) {
          if (error?.code !== "unsourced") {
            if (this.work.controller.signal.aborted || !MODEL_CORRECTION.test(error.message)) throw error;
            const rounds = this.work.storyRounds ||= {};
            rounds[topic.id] = (rounds[topic.id] || 0) + 1;
            // Bounded per story here, so it does not count toward the build's limit.
            if (rounds[topic.id] < STORY_ROUNDS) {
              throw Object.assign(error, { storyRound: true,
                redraft: `Redrafting story ${index + 1} of ${unscripted.length} after the fact check (round ${rounds[topic.id] + 1} of ${STORY_ROUNDS}): ${topic.title}` });
            }
            error.message = `Left out: its drafts failed the fact check ${STORY_ROUNDS} times. ${error.message}`;
            this.work.lastError = null;
            const draft = error.draft?.segments?.[0];
            cache[key] = { leftOut: error.message, ...(draft?.spoken && { draft }) };
            if (draft?.spoken) snapshot.rejected[topic.id] = draft;
            await this.serialized(async () => {
              const current = await this.load(snapshot.date);
              if (current.revision !== snapshot.revision) return;
              current.scriptCache = Object.fromEntries(Object.entries({ ...current.scriptCache, [key]: cache[key] }).slice(-60));
              await this.save(current);
            });
          }
          console.warn(`[sports desk] ${topic.title}: ${error.message}`);
          snapshot.skipped[topic.id] = error.message;
          continue;
        }
      }
      if (piece.segments?.length !== 1) throw new Error(`The script for “${topic.title}” did not return exactly one story.`);
      if (!pieces.size) { written.title = piece.title; written.description = piece.description; }
      pieces.set(topic.id, piece.segments[0]);
      written.segments.push(piece.segments[0]);
      written.topicSources.push(...(piece.topicSources || []));
      if (!cache[key]) {
        this.work.lastError = null;
        cache[key] = piece;
        // Persist each verified story before starting the next model call.
        // A timeout, restart, or later render failure can resume this work.
        await this.serialized(async () => {
          const current = await this.load(snapshot.date);
          if (current.revision !== snapshot.revision) return;
          current.scriptCache = Object.fromEntries(Object.entries({ ...current.scriptCache, [key]: piece }).slice(-60));
          await this.save(current);
        });
      }
    }
    snapshot.scriptCache = cache;
    const byTopic = pieces;
    const segments = selected.map((topic) => topic.script ? scriptedSegment(topic) : byTopic.get(topic.id) && { ...byTopic.get(topic.id), topicId: topic.id }).filter(Boolean);
    if (!segments.length) throw new Error(Object.values(snapshot.skipped)[0] || "No included story could be written.");
    return { ...written, segments: await this.voiceScripted(snapshot, segments) };
  }

  // The anchor pass for scripted stories: the model turns each factual draft
  // into spoken copy, every number is rechecked against the ledger, and a
  // rewrite that fails falls back to the draft. Accepted copy is cached by the
  // draft and its claims so an unrelated edit does not re-ask the model.
  async voiceScripted(snapshot, segments) {
    const scripted = segments.map((segment, index) => ({ segment, index, topic: snapshot.topics.find(({ id }) => id === segment.topicId) }))
      .filter(({ topic }) => topic?.script && topic.claimIds?.length);
    if (!scripted.length || !this.settings.researchConfigured) return segments;
    const ledger = await this.ledgerFor(snapshot);
    const cache = snapshot.anchorCache || {};
    const position = (index) => index === 0 ? "lead story" : index === segments.length - 1 ? "last story" : `story ${index + 1} of ${segments.length}`;
    const keyed = scripted.map((item) => ({ ...item, key: fingerprint({ copyVersion: 2, draft: item.topic.script.narration, claims: item.topic.claimIds, position: position(item.index) }) }));
    const pending = keyed.filter(({ key }) => !cache[key]);
    const voiced = new Map();
    let outcome = { status: "cached", issues: [] };
    if (pending.length) {
      try {
        this.work.progress = { percent: 3, message: "Writing the anchor script…" };
        const written = await this.anchor({ date: snapshot.date, segments: pending.map(({ segment, index, topic }) => ({
          id: segment.id || topic.eventId, position: position(index), headline: topic.script.headline, draft: topic.script.narration,
          sport: topic.sport, league: topic.league, teams: topic.teams,
          claims: ledger.publicClaims(topic.claimIds).filter(({ disposition }) => disposition === "supported").map(({ text, value, unit, subject, period, clock }) => ({ text, value, unit, subject, period, clock })),
        })) }, { signal: this.work.controller.signal });
        for (const { id, narration } of written) voiced.set(id, narration);
        outcome = { status: "written", issues: [] };
      } catch (error) {
        outcome = { status: "fallback", issues: [error.message] };
      }
    }
    const anchor = [];
    for (const { segment, topic, key } of keyed) {
      const id = segment.id || topic.eventId;
      let narration = cache[key] || voiced.get(id) || null;
      let status = cache[key] ? "cached" : narration ? "written" : "fallback";
      if (narration) {
        try {
          verifySupportedNames(narration, ledger.publicClaims(topic.claimIds).filter(({ disposition }) => disposition === "supported").map(({ text }) => ({ title: text, excerpt: text })));
        } catch (error) {
          outcome.issues.push(error.message);
          narration = null;
          status = "fallback";
          delete cache[key];
        }
      }
      if (narration) {
        const licensed = ledger.licensedNumbers(topic.claimIds);
        const uncovered = [...new Set(numbersIn(narration).filter((number) => !licensed.has(number)))];
        if (uncovered.length) {
          outcome.issues.push(`${topic.script.headline}: the anchor copy used numbers outside the evidence (${uncovered.join(", ")}); the factual draft aired instead.`);
          narration = null;
          status = "fallback";
        } else {
          cache[key] = narration;
        }
      }
      const body = narration || topic.script.narration;
      segment.draft = topic.script.narration;
      segment.narration = [body, takeNarration(topic)].filter(Boolean).join("\n\n");
      anchor.push({ id, headline: topic.script.headline, status, narration: body });
    }
    snapshot.anchorCache = Object.fromEntries(Object.entries(cache).slice(-60));
    snapshot.anchor = { ...outcome, segments: anchor, at: this.now().toISOString() };
    return segments;
  }

  async produce(snapshot) {
    this.work.progress = { percent: 2, message: "Writing the broadcast script…" };
    // One block per league: the stories of a league air together.
    snapshot.topics = groupByLeague(snapshot.topics);
    const { topicSources = [], ...draft } = snapshot.sample ? sampleEpisode(snapshot) : await this.writeLive(snapshot);
    const selected = snapshot.topics.filter((topic) => topic.selected);
    const episode = {
      ...draft, title: draft.title?.replace(/Overtime Desk/giu, "Wellspring Media Sports") || "Wellspring Media Sports", date: snapshot.date, airAt: this.airTimeFor(snapshot.date), channel: this.settings.channel, territory: this.settings.territory,
      intro: openingIntro(snapshot.date),
      openingVoice: "lafontaine",
      outro: draft.outro || "That’s the rundown for today. I’m Isaac Doss for Wellspring Media Sports. Thanks for spending part of your morning with us.",
      outroAnnouncement: "Thank you for watching Wellspring Media. Like, comment, and subscribe for more!",
      footageSearch: !snapshot.sample && process.env.SPORTS_CLIP_DISCOVERY !== "off",
      footagePreview: Boolean(snapshot.sample),
      segments: draft.segments.map((segment, index) => {
        const topic = snapshot.topics.find((candidate) => candidate.id === segment.topicId) || selected[index];
        return {
          ...segment, topicId: topic?.id || null, eventId: segment.eventId ?? topic?.eventId ?? null, id: segment.id || topic?.eventId || undefined,
          ...(topic?.league && { league: topic.league }),
          ...(topic && { footage: { clipUrl: topic.clipUrl, sport: topic.sport, teams: topic.teams, people: topic.entities, gameDate: topic.gameDate, topicTitle: topic.title } }),
        };
      }),
    };
    episode.intro = openingIntro(snapshot.date, announceSports(episode.segments));
    const trend = trendSegment(this.trendAngles(snapshot));
    // The trend recap stays in the broadcast; Shorts correspond one-for-one
    // with Isaac's selected stories, rather than adding an unselected bonus.
    if (trend) episode.segments.push({ ...trend, short: false });
    this.work.progress = { percent: 4, message: "Checking every number against the evidence ledger…" };
    const { revision, ledger } = await this.bindEvidence(snapshot, episode);
    const plates = await platesFor(selected, { gameFor: (id) => ledger.latestEvent(id) });
    const catalog = await this.catalogFor(snapshot);
    episode.rights = { channel: this.settings.channel, territory: this.settings.territory, airAt: episode.airAt, catalog };
    episode.segments = episode.segments.map((segment) => ({
      ...segment, claimIds: segment.claims.map(({ id }) => id),
      ...(plates.has(segment.topicId) && { plate: plates.get(segment.topicId) }),
      shots: segment.eventId ? planShots(segment, { catalog, channel: this.settings.channel, territory: this.settings.territory, airAt: episode.airAt, revision: snapshot.revision }) : null,
    }));
    const revisionDirectory = path.join(this.directoryFor(snapshot), String(snapshot.revision));
    await mkdir(revisionDirectory, { recursive: true });
    // Windows may hold the old MP4 open while a player streams it.
    const directory = await mkdtemp(path.join(revisionDirectory, "cut-"));
    const build = path.basename(directory);
    let metadata;
    try {
      metadata = await this.render(episode, directory, (progress) => { this.work.progress = progress; }, this.work.controller.signal);
      this.work.controller.signal.throwIfAborted();
      await access(path.join(directory, "episode.mp4"));
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
    }
    this.work.progress = { percent: 97, message: "Writing the YouTube titles and descriptions…" };
    const listing = await this.writeListing(episode);
    this.work.controller.signal.throwIfAborted();
    let thumbnails = null;
    if (thumbnailsEnabled()) {
      this.work.progress = { percent: 98, message: "Drawing the YouTube thumbnails…" };
      try {
        thumbnails = await renderCutThumbnails({
          directory, episode, listing, photos: metadata.thumbnailPhotos || [], shorts: metadata.shorts || [],
        });
      } catch (error) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }
    if (thumbnails && metadata.shorts?.length) {
      this.work.progress = { percent: 99, message: "Putting each Short's thumbnail on its opening frames…" };
      await this.coverShorts(directory, metadata.shorts, this.work.controller.signal);
    }
    await this.serialized(async () => {
      const current = await this.load(snapshot.date);
      if (snapshot.revision !== current.revision) {
        await rm(directory, { recursive: true, force: true }).catch(() => {});
        current.status = "waiting";
        await this.save(current);
        this.rebuildDate = current.date;
        return;
      }
      // Show why a story was left out; a story that aired loses any old reason.
      for (const topic of current.topics) {
        if (snapshot.skipped?.[topic.id]) topic.skipReason = snapshot.skipped[topic.id];
        else delete topic.skipReason;
        if (snapshot.rejected?.[topic.id]) topic.rejectedDraft = snapshot.rejected[topic.id];
        else delete topic.rejectedDraft;
      }
      for (const { id, sources } of topicSources) {
        const topic = current.topics.find((topic) => topic.id === id);
        if (topic) topic.sources = [...new Map([...topic.sources, ...sources].map((source) => [source.url, source])).values()];
      }
      const base = `/api/sports/video/${snapshot.date}/${snapshot.revision}`;
      if (snapshot.anchorCache) current.anchorCache = snapshot.anchorCache;
      current.render = {
        title: episode.title, duration: metadata.duration, revisionId: revision.id, anchor: snapshot.anchor || null, listing,
        episode: {
          ...episode, chapters: metadata.chapters, duration: metadata.duration, footageCredits: metadata.footageCredits || [],
          thumbnailPhotos: metadata.thumbnailPhotos || [],
        }, revision: snapshot.revision,
        createdAt: this.now().toISOString(), build, url: `${base}?cut=${build}`,
        qc: (metadata.qc || thumbnails) ? { ...(metadata.qc || {}), ...(thumbnails ? { thumbnails: thumbnails.checks } : {}) } : null,
        shots: metadata.shots || null,
        thumbnails: thumbnails?.files || null,
        shorts: (metadata.shorts || []).map((short) => ({ ...short, url: `${base}/short/${short.segment}?cut=${build}` })),
      };
      current.verification = {
        revisionId: revision.id, revision: snapshot.revision, ok: true, at: revision.lockedAt,
        segments: revision.stories.map(({ segmentId, headline, kind, claimIds }) => ({ segmentId, headline, kind, claims: claimIds.length })),
      };
      current.status = "ready";
      current.generationRetry = null;
      await this.save(current);
    });
  }

  async queueBuild(edition) {
    this.ensureEditable(edition);
    if (!edition.topics.some(({ selected }) => selected)) throw deskError(409, "Include at least one topic before building an episode.");
    if (!edition.sample && !this.settings.researchConfigured && !topicsScripted(edition)) throw deskError(409, "Set a sports research model to write the script.");
    edition.buildPaused = false;
    edition.generationRetry = null;
    await this.markBuilding(edition);
    this.launch(edition, "build", () => this.produce(edition));
  }

  scheduleBuild(date) {
    clearTimeout(this.rebuildTimer);
    this.rebuildDate = date;
    this.rebuildTimer = setTimeout(() => {
      this.serialized(async () => {
        if (this.rebuildDate !== date || this.work) return;
        this.rebuildDate = null;
        if (this.clock().date !== date) return;
        const edition = await this.load(date);
        if (edition.sample || edition.buildPaused || !edition.topics.some(({ selected }) => selected)) return;
        if (!this.settings.researchConfigured && !topicsScripted(edition)) return;
        if (edition.render?.revision !== edition.revision) await this.queueBuild(edition);
      }).catch((error) => { if (error.status !== 409) console.error(error); });
    }, this.rebuildDelay).unref();
  }

  run(task, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      if (this.work) throw deskError(409, "A studio job is already running.");
      await this.beginRevision(edition);
      if (task === "research") await this.queueResearch(edition);
      else await this.queueBuild(edition);
      return this.response(edition);
    });
  }

  async saveEdits(edition, before) {
    if (before !== topicsDigest(edition.topics)) {
      edition.revision++;
      edition.buildAttempts = 0;
      edition.lastBuildAttempt = null;
      edition.error = null;
      if (this.work?.date !== edition.date) edition.status = "waiting";
      if (!edition.sample) this.scheduleBuild(edition.date);
    }
    await this.save(edition);
    return this.response(edition);
  }

  async fillTakeScript(topic) {
    try {
      topic.takeScript = await this.generateTake(topic);
    } catch (error) {
      throw deskError(422, `The take wasn’t saved. ${error.message}`);
    }
  }

  async changeTopic(topicId, changes, expectedDate) {
    if (changes.sport === "other" || leagueFamily(changes.league) === "OTHER") {
      changes = { ...changes, sport: "other", league: OTHER_NEWS, teams: [] };
    }
    const result = await this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const before = topicsDigest(edition.topics);
      if (changes.selected === true && !edition.topics.find(({ id }) => id === topicId)?.selected && edition.topics.filter(({ selected }) => selected).length >= MAX_EPISODE_STORIES) throw deskError(409, "Twenty stories are already included. Exclude one before including another.");
      if (changes.league && !inScope(changes.league, this.scope)) throw deskError(409, `Coverage is limited to ${this.scope.label}.`);
      const { headline, narration, draftTake, ...rest } = changes;
      let topic;
      let previousTake;
      if (topicId) {
        topic = edition.topics.find(({ id }) => id === topicId);
        if (!topic) throw deskError(404, "Topic not found.");
        previousTake = topic.take || "";
        if (headline !== undefined || narration !== undefined) {
          if (!topic.script && (!narration || !topic.sources?.some(({ url, excerpt }) => url && excerpt?.trim()))) {
            throw deskError(409, "Add reporting evidence and narration before saving a story script.");
          }
          topic.script = { headline: topic.title.slice(0, 140), ...topic.script, ...(headline !== undefined && { headline }), ...(narration !== undefined && { narration }) };
        }
        Object.assign(topic, rest);
        if (Object.keys(changes).some((name) => name !== "selected")) { delete topic.skipReason; delete topic.rejectedDraft; }
      } else {
        if (edition.topics.length >= maxTopics) throw deskError(409, `An edition can hold ${maxTopics} topics.`);
        topic = newTopic(rest);
        if (edition.topics.filter(({ selected }) => selected).length >= MAX_EPISODE_STORIES) topic.selected = false;
        previousTake = "";
        edition.topics.push(topic);
      }
      const notesChanged = previousTake !== (topic.take || "");
      if (draftTake && !topic.take?.trim()) throw deskError(400, "Add take notes before drafting.");
      if (draftTake && !this.settings.researchConfigured) throw deskError(409, "Connect a model to draft the take script.");
      // A script Isaac typed in this save airs as written and is never redrafted.
      const typedScript = Boolean(changes.takeScript?.trim());
      if (notesChanged && !typedScript) topic.takeScript = "";
      if (typedScript) { delete topic.takeError; delete topic.takeDraftingAt; }
      // The story saves now; the take script drafts in the background, since
      // the local model may be busy with a build for minutes.
      const drafting = topic.take?.trim() && this.settings.researchConfigured && (draftTake || (notesChanged && !typedScript));
      if (drafting) {
        topic.takeDraftingAt = this.now().toISOString();
        delete topic.takeError;
      }
      return { view: await this.saveEdits(edition, before), drafting: drafting && { date: edition.date, id: topic.id, take: topic.take } };
    });
    if (result.drafting) this.takeDraft = this.draftTakeLater(result.drafting);
    return result.view;
  }

  // YouTube's Shorts feed shows a frame of the video, not the uploaded
  // thumbnail, so each Short opens on its thumbnail card. A Short this fails
  // on keeps its plain opening; the build goes on.
  async coverShorts(directory, shorts, signal) {
    const { coverShortOpening } = await import("./produce.mjs");
    for (const short of shorts) {
      const cover = path.join(directory, "thumbnails", path.basename(short.file).replace(/\.mp4$/u, ".jpg"));
      try {
        await access(cover);
        await coverShortOpening(path.join(directory, short.file), cover, signal);
      } catch (error) {
        if (signal?.aborted) throw error;
        console.warn(`[sports build] ${short.file} keeps its plain opening: ${error.message}`);
      }
    }
  }

  // Isaac marks a story the fact check left out as true: the draft it rejected
  // becomes the story's script, which airs as written, and the cut rebuilds.
  approveDraft(topicId, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const topic = edition.topics.find(({ id }) => id === topicId);
      if (!topic) throw deskError(404, "Topic not found.");
      const draft = topic.rejectedDraft;
      if (!draft?.spoken) throw deskError(409, "This story has no rejected draft to mark true.");
      if (!topic.selected && edition.topics.filter(({ selected }) => selected).length >= MAX_EPISODE_STORIES) throw deskError(409, "Twenty stories are already included. Exclude one before including another.");
      const before = topicsDigest(edition.topics);
      topic.sources = [...new Map([...(topic.sources || []), ...(draft.sources || [])].map((source) => [source.url, source])).values()];
      topic.script = { headline: draft.headline.slice(0, 140), narration: draft.spoken.slice(0, 1800) };
      topic.editorApproved = { at: this.now().toISOString(), reason: topic.skipReason || "" };
      topic.selected = true;
      delete topic.skipReason;
      delete topic.rejectedDraft;
      return this.saveEdits(edition, before);
    });
  }

  // Drafts a take script and files it on the story, unless the notes changed
  // meanwhile (a newer draft is then on its way) or the edition was locked.
  async draftTakeLater({ date, id, take }) {
    try {
      const edition = await this.load(date);
      const topic = edition.topics.find((candidate) => candidate.id === id);
      if (!topic || topic.take !== take) return;
      let script = "";
      let failure = "";
      try {
        script = await this.generateTake(topic);
      } catch (error) {
        failure = error.message;
      }
      await this.serialized(async () => {
        const current = await this.load(date);
        const story = current.topics.find((candidate) => candidate.id === id);
        // Notes changed, or Isaac typed his own script meanwhile: keep his.
        if (!story || story.take !== take || !story.takeDraftingAt) return;
        try { this.ensureEditable(current); } catch { return; }
        const before = topicsDigest(current.topics);
        delete story.takeDraftingAt;
        if (script) {
          story.takeScript = script;
          delete story.takeError;
        } else story.takeError = `The take script wasn’t drafted. ${failure}`;
        await this.saveEdits(current, before);
      });
    } catch (error) {
      console.warn(`[sports desk] take draft: ${error.message}`);
    }
  }

  async postChat(content, topicId, expectedDate, validateEdits = (edits) => editorialEdits.parse(edits)) {
    // Model calls happen outside the queue, so a question cannot hold up status
    // polling, Stop, or ordinary story edits. A stale edit plan is retried.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await this.serialized(async () => {
        const edition = await this.readCurrent(expectedDate);
        if (topicId && !edition.topics.some(({ id }) => id === topicId)) throw deskError(404, "Topic not found.");
        const modelUrl = URL.parse(process.env.SPORTS_LLM_URL || "");
        return { ...structuredClone(edition), editorialState: {
          status: edition.status, progress: this.work?.date === edition.date ? this.work.progress : null,
          locked: publicationLocked(edition), error: edition.error || null,
          model: process.env.SPORTS_LLM_MODEL || null,
          localModel: Boolean(modelUrl && ["localhost", "127.0.0.1", "[::1]"].includes(modelUrl.hostname)),
          timezone: this.settings.timezone, publication: edition.publication?.status,
          allowedLeagues: this.scope.options?.map(({ league }) => league) || [...this.scope.leagues, OTHER_NEWS],
          storyLimit: maxTopics, includedLimit: MAX_EPISODE_STORIES, buildPaused: edition.buildPaused,
          render: edition.render && { revision: edition.render.revision, title: edition.render.title, createdAt: edition.render.createdAt },
          verification: edition.verification, generationRetry: edition.generationRetry,
        } };
      });
      const direct = directEditorialAnswer(snapshot, content);
      const selection = directEditorialSelection(content, topicId);
      const answer = direct ? { reply: direct, edits: [] }
        : selection && snapshot.editorialState.locked ? { reply: "This edition is locked for publishing. Open a new revision to edit its stories.", edits: [] }
        : selection || (snapshot.sample ? previewChat(content, topicId) : await this.ask(snapshot, content, topicId));
      const edits = validateEdits(answer.edits || []);
      if (questionOnly(content) && edits.length) throw deskError(422, "A question cannot change the rundown. Ask for the edit directly.");
      const saved = await this.serialized(async () => {
        const current = await this.readCurrent(snapshot.date);
        if (snapshot.revision !== current.revision || snapshot.messages.at(-1)?.id !== current.messages.at(-1)?.id) return null;
        if (edits.length) this.ensureEditable(current);
        // Validate the entire batch on a copy before persisting any story.
        const edition = structuredClone(current);
        const before = topicsDigest(edition.topics);
        const drafting = [];
        const receipts = [];
        const defaultSelections = [];
        for (const { id, url, excerpt, headline, narration, ...fields } of edits) {
          let changes = { ...fields };
          if (changes.sport === "other" || /^other(?: news)?$/iu.test(changes.league || "")) {
            changes = { ...changes, sport: "other", league: OTHER_NEWS, teams: [] };
          }
          if (changes.league && !inScope(changes.league, this.scope)) throw deskError(409, `Coverage is limited to ${this.scope.label}, plus Other news.`);
          let topic = id ? edition.topics.find((topic) => topic.id === id) : null;
          if (id && !topic) throw deskError(409, "The editor returned a topic that is no longer in the rundown.");
          if (!id && edition.topics.length >= maxTopics) throw deskError(409, `An edition can hold ${maxTopics} topics.`);
          const previous = topic ? structuredClone(topic) : null;
          if (!topic) {
            topic = newTopic(changes);
            edition.topics.push(topic);
            if (changes.selected === undefined) defaultSelections.push(topic);
          } else Object.assign(topic, changes);
          if (url) {
            topic.sources ||= [];
            const source = topic.sources.find((source) => source.url === url);
            if (source) {
              if (excerpt !== undefined) source.excerpt = excerpt;
            } else topic.sources.push({ title: "Source supplied by Isaac", publisher: new URL(url).hostname, url, excerpt: excerpt || "" });
          }
          if (narration !== undefined) {
            if (!topic.script && !topic.sources?.some(({ url, excerpt }) => url && excerpt?.trim())) throw deskError(409, "Add reporting evidence before saving a factual narration script.");
            topic.script = { headline: topic.title.slice(0, 140), ...topic.script, narration };
          }
          if (headline !== undefined) {
            if (topic.script) topic.script.headline = headline;
            else topic.title = headline;
          } else if (changes.title !== undefined && topic.script) topic.script.headline = changes.title.slice(0, 140);
          const notesChanged = changes.take !== undefined && changes.take !== (previous?.take || "");
          const typedScript = changes.takeScript !== undefined;
          if (notesChanged && !typedScript) topic.takeScript = "";
          if (notesChanged || typedScript) { delete topic.takeError; delete topic.takeDraftingAt; }
          if (notesChanged && !typedScript && topic.take?.trim() && this.settings.researchConfigured) {
            topic.takeDraftingAt = this.now().toISOString();
            drafting.push({ date: edition.date, id: topic.id, take: topic.take });
          }
          if (Object.keys(changes).some((field) => field !== "selected") || url || headline || narration) { delete topic.skipReason; delete topic.rejectedDraft; }
          receipts.push({ topic, previous, fields: [...Object.keys(fields), ...(url ? ["source"] : []), ...(headline !== undefined ? ["headline"] : []), ...(narration !== undefined ? ["narration"] : [])] });
        }
        // New stories still save when all twenty slots are occupied; report that
        // they were excluded. Explicit include requests must respect the limit.
        let included = edition.topics.filter(({ selected }) => selected).length;
        for (const topic of [...defaultSelections].reverse()) if (included > MAX_EPISODE_STORIES && topic.selected) { topic.selected = false; included--; }
        if (included > MAX_EPISODE_STORIES) throw deskError(409, "Twenty stories are already included. Exclude one before including another.");
        const labels = { title: "title", summary: "reporting notes", take: "editorial take", takeScript: "on-air take", headline: "on-air headline", narration: "narration", selected: "inclusion", sport: "sport", league: "category", teams: "teams", clipUrl: "footage link", source: "source" };
        const changes = receipts.map(({ topic, previous, fields }) => {
          if (!previous) return `Added “${topic.title}”${topic.league ? ` to ${topic.league}` : ""} (${topic.selected ? "included" : defaultSelections.includes(topic) && included >= MAX_EPISODE_STORIES ? "excluded; all 20 story slots are occupied" : "excluded"}).`;
          if (JSON.stringify(previous) === JSON.stringify(topic)) return `“${topic.title}” already has those values.`;
          return `Updated “${topic.title}”: ${[...new Set(fields.map((field) => labels[field] || field))].join(", ")}${fields.includes("selected") ? ` (${topic.selected ? "included" : "excluded"})` : ""}.`;
        });
        const at = this.now().toISOString();
        let reply = answer.reply;
        if (changes.length) reply = `Saved changes:\n${changes.join("\n")}`;
        else if (/^(?:done[.! ]|request accepted\b|(?:added|updated|saved|changed|removed)\b|i (?:have |just )?(?:added|updated|saved|changed|removed)\b|i've (?:added|updated|saved|changed|removed)\b)/iu.test(reply)) reply = "I haven’t changed the rundown. Tell me which story and what you want to change.";
        edition.messages = [...edition.messages, message("user", content, at), message("assistant", reply, at)].slice(-80);
        return { view: await this.saveEdits(edition, before), drafting };
      });
      if (!saved) continue;
      for (const request of saved.drafting) this.takeDraft = this.draftTakeLater(request);
      return saved.view;
    }
    throw deskError(409, "The rundown kept changing while the editor was replying. Your message has not made any changes; try it again.");
  }

  // Scans the slate through the evidence adapter: coverage per game, a pitch
  // per covered story, and any correction the source published since.
  scanSlate(expectedDate, { asOf } = {}) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      return this.applyScan(edition, { asOf });
    });
  }

  // Already inside the desk queue. tick calls this directly so a scan cannot
  // wait on the same queue it is running in.
  async applyScan(edition, { asOf } = {}) {
    this.ensureEditable(edition);
    if (!this.evidence) throw deskError(409, "No evidence adapter is configured.");
    return this.writeScan(edition, { asOf });
  }

  async writeScan(edition, { asOf } = {}) {
      const ledger = await this.ledgerFor(edition);
      const at = asOf || this.now().toISOString();
      const known = new Set(edition.corrections.map(({ id }) => id));
      const results = await scanSlate(ledger, this.evidence, { date: edition.date, asOf: at, retrievedAt: this.now().toISOString(), timezone: this.settings.timezone });
      await ledger.save();
      const before = topicsDigest(edition.topics);
      // Games outside the coverage scope stay visible in the slate but are never pitched.
      const covered = (result) => inScope(result.league, this.scope);
      edition.slate = results.map((result) => ({
        gameId: result.gameId, league: result.league, sport: result.sport, title: result.title, status: result.status,
        coverage: covered(result) ? result.coverage : "out of scope", reason: covered(result) ? result.reason : `Coverage is limited to ${this.scope.label}.`,
        claims: result.claims.length, supported: result.claims.filter(({ disposition }) => disposition === "supported").length, independentOrigins: result.independentOrigins, scannedAt: at,
      }));
      edition.lastScan = { at, provider: this.evidence.name, games: results.length, scope: this.scope.leagues };
      // Stories already in the rundown from a league outside the scope are benched.
      for (const topic of edition.topics) {
        if (topic.league && !inScope(topic.league, this.scope)) {
          topic.selected = false;
          topic.coverage = "out of scope";
          topic.coverageReason = `Coverage is limited to ${this.scope.label}.`;
        }
      }
      for (const result of results.filter((item) => item.story && covered(item))) {
        let topic = edition.topics.find((candidate) => candidate.eventId === result.gameId);
        if (!topic) {
          if (edition.topics.length >= maxTopics) break;
          topic = { ...newTopic({ title: result.story.headline, summary: `${result.title}, ${result.competition}.` }), selected: result.coverage === "covered" && result.included !== false, eventId: result.gameId, storyId: result.gameId };
          edition.topics.push(topic);
        }
        topic.title = result.story.headline;
        topic.sport = result.sport;
        topic.league = result.league;
        topic.teams = [result.away.name, result.home.name];
      if (result.startTime) topic.gameDate = localClock(new Date(result.startTime), this.settings.timezone).date;
        topic.script = { headline: result.story.headline, narration: result.story.narration, diagram: result.story.diagram };
        topic.claimIds = result.story.claimIds;
        topic.coverage = result.coverage;
        topic.coverageReason = result.reason;
        topic.entities = result.entities;
        topic.aliases ||= [...new Set([result.home.name, result.away.name, `${result.home.short} ${result.away.short}`])];
        topic.media = result.media;
        topic.clips = mergeClips(topic.clips, result.discovery);
        topic.sources = [...new Map([...topic.sources, ...result.snapshots.map((snapshot) => ({ publisher: snapshot.provider, title: snapshot.title || snapshot.type, url: snapshot.sourceUrl }))]
          .filter(({ url }) => url).map((source) => [source.url, source])).values()].slice(0, 6);
      }
      // Once the scan has produced a verified recap, the evergreen practice
      // placeholders leave the lineup so the practice cut is the show, not tips.
      if (results.some((result) => result.coverage === "covered" && covered(result))) {
        const placeholders = new Set(sampleTopics().map(({ id }) => id));
        for (const topic of edition.topics) {
          if (!topic.eventId && (topic.practice || placeholders.has(topic.id))) topic.selected = false;
        }
      }
      for (const correction of ledger.corrections.filter(({ id }) => !known.has(id))) this.applyCorrection(edition, correction, ledger);
      edition.scanFailures = 0;
      return this.saveEdits(edition, before);
  }

  // Isaac's review of a discovered clip: approve or reject, and the source
  // range he wants. The decision is a record; nothing is fetched.
  reviewClip(topicId, clipId, { decision, in: start, out: end }, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const topic = edition.topics.find(({ id }) => id === topicId);
      if (!topic) throw deskError(404, "Topic not found.");
      const clip = (topic.clips || []).find((item) => item.id === clipId);
      if (!clip) throw deskError(404, "Clip not found on this story.");
      const before = topicsDigest(edition.topics);
      const from = Math.max(0, start ?? clip.in ?? 0);
      let to = end ?? clip.out ?? Math.min(from + CLIP_SUGGESTED, clip.duration ?? from + CLIP_SUGGESTED);
      if (clip.duration) to = Math.min(to, clip.duration);
      if (to - from < 1) throw deskError(400, "A clip range needs at least one second.");
      if (to - from > CLIP_CAP) throw deskError(400, `A clip range is capped at ${CLIP_CAP} seconds.`);
      Object.assign(clip, { decision, in: Number(from.toFixed(2)), out: Number(to.toFixed(2)), reviewedAt: this.now().toISOString(), reviewedBy: "isaac" });
      return this.saveEdits(edition, before);
    });
  }

  // Overnight ESPN scans use the same 15-minute gap as research. A failure is
  // logged and does not abort the tick. Three failures stop the retries.
  async scanIfDue(edition) {
    const awaiting = (edition.slate || []).some((row) => row.coverage === "awaiting verification");
    if ((edition.lastScan && !awaiting) || (edition.scanFailures || 0) >= 3) return;
    if (edition.lastScanAttempt && this.now().getTime() - Date.parse(edition.lastScanAttempt) < overnightRetry) return;
    edition.lastScanAttempt = this.now().toISOString();
    try {
      await this.applyScan(edition);
    } catch (error) {
      edition.scanFailures = (edition.scanFailures || 0) + 1;
      console.log(JSON.stringify({ scan: { date: edition.date, provider: this.evidence?.name, error: error.message } }));
      await this.save(edition);
    }
  }

  // A superseded claim: the topics that cite it move to the replacement, the
  // scripted copy follows, the rendered cut is withdrawn and the reason shown.
  applyCorrection(edition, correction, ledger) {
    const replacement = ledger.data.claims[correction.replacementId];
    const topics = edition.topics.filter((topic) => (topic.claimIds || []).includes(correction.claimId));
    for (const topic of topics) {
      topic.claimIds = topic.claimIds.map((id) => id === correction.claimId ? correction.replacementId : id);
      if (topic.script && correction.previousText) {
        topic.script.narration = topic.script.narration.replaceAll(correction.previousText, correction.text);
        topic.script.headline = topic.script.headline.replaceAll(correction.previousText, correction.text);
        topic.title = topic.title.replaceAll(correction.previousText, correction.text);
      }
      topic.coverage = (topic.claimIds || []).every((id) => ledger.data.claims[id]?.disposition === "supported") ? "covered" : "awaiting verification";
      topic.coverageReason = `Corrected ${correction.at}: ${correction.reason}`;
      const evidence = replacement?.evidence?.[0] && ledger.data.snapshots[replacement.evidence[0].snapshotId];
      if (evidence?.sourceUrl && !topic.sources.some(({ url }) => url === evidence.sourceUrl)) {
        topic.sources = [...topic.sources, { publisher: evidence.provider, title: evidence.title || "Correction", url: evidence.sourceUrl, excerpt: evidence.excerpt || "" }].slice(0, 6);
      }
    }
    const dependent = edition.render && (correction.revisions.includes(edition.render.revisionId) || edition.render.revision === edition.revision);
    edition.corrections = [...edition.corrections, {
      id: correction.id, at: correction.at, by: correction.by, reason: correction.reason, claimId: correction.claimId, replacementId: correction.replacementId,
      previousText: correction.previousText, text: correction.text, topics: topics.map(({ id, title }) => ({ id, title })), segments: correction.segments,
      invalidatedRevision: dependent ? edition.render.revision : null,
    }].slice(-30);
    if (dependent) {
      edition.render = null;
      if (this.work?.date !== edition.date) edition.status = "waiting";
    }
  }

  correctClaim(claimId, { text, value, unit, evidence, reason }, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const ledger = await this.ledgerFor(edition);
      const at = this.now().toISOString();
      const publisher = evidence.publisher || hostOf(evidence.url);
      const snapshot = ledger.snapshot({
        provider: publisher, originGroup: publisher, sourceUrl: evidence.url, sourceTime: at, retrievedAt: at, kind: "correction", title: evidence.title || `Correction supplied by Isaac`,
        excerpt: evidence.excerpt || null, allowedUses: ["verify"], retention: evidence.excerpt ? "excerpt" : "link-only",
      });
      const replacement = { text, evidence: [{ snapshotId: snapshot.id, locator: evidence.locator, stance: "supports" }] };
      if (value !== undefined) replacement.value = value;
      if (unit !== undefined) replacement.unit = unit;
      let result;
      try {
        result = ledger.supersede(claimId, replacement, { reason, at, by: "isaac" });
      } catch (error) {
        if (error instanceof LedgerError) throw deskError(error.details?.status || 409, error.message);
        throw error;
      }
      await ledger.save();
      const before = topicsDigest(edition.topics);
      this.applyCorrection(edition, result.correction, ledger);
      return this.saveEdits(edition, before);
    });
  }

  resolveClaim(claimId, { disposition, reason }, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const ledger = await this.ledgerFor(edition);
      try {
        ledger.resolve(claimId, { disposition, reason, by: "isaac", at: this.now().toISOString() });
      } catch (error) {
        if (error instanceof LedgerError) throw deskError(error.details?.status || 409, error.message);
        throw error;
      }
      await ledger.save();
      const before = topicsDigest(edition.topics);
      for (const topic of edition.topics.filter((topic) => (topic.claimIds || []).includes(claimId))) {
        topic.coverage = topic.claimIds.every((id) => ledger.data.claims[id]?.disposition === "supported") ? "covered" : "awaiting verification";
        topic.coverageReason = `Isaac ruled “${ledger.data.claims[claimId].text}” ${disposition}: ${reason}`;
      }
      return this.saveEdits(edition, before);
    });
  }

  // Check trend on one pitch: collect fresh observations, keep them with the
  // earlier ones for persistence, and score against the canonical story.
  checkTrend(topicId, { aliases } = {}, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const topic = edition.topics.find(({ id }) => id === topicId);
      if (!topic) throw deskError(404, "Topic not found.");
      if (aliases) topic.aliases = aliases;
      const now = this.now();
      const { observations, failures } = await collectObservations(this.trendAdapters, { now });
      const ledger = await this.ledgerFor(edition);
      const storyId = topic.storyId || topic.eventId || null;
      let kept = ledger.data.trends.find((entry) => entry.topicId === topic.id);
      if (!kept) {
        kept = { topicId: topic.id, storyId, observations: [], cards: [] };
        ledger.data.trends.push(kept);
      }
      kept.storyId = storyId;
      for (const observation of observations) {
        if (!kept.observations.some((item) => item.provider === observation.provider && item.query === observation.query && item.observedAt === observation.observedAt)) kept.observations.push(observation);
      }
      kept.observations = kept.observations.filter((item) => now.getTime() - Date.parse(item.observedAt) <= 48 * 60 * 60_000).slice(-400);
      const claims = (topic.claimIds || []).map((id) => ledger.data.claims[id]).filter(Boolean);
      const { coreTopicId, secondaryTopicId } = edition.trendDesk;
      const story = {
        id: storyId, title: topic.title, date: edition.date, entities: topic.entities || [], aliases: topic.aliases || [topic.title],
        sourceUrls: topic.sources.map(({ url }) => url), verified: claims.some(({ disposition }) => disposition === "supported"),
        visualEvidence: Boolean(topic.media?.assets?.length), originalAnalysis: Boolean(topic.take?.trim()), angle: topic.title, newEvidence: true,
        scope: !coreTopicId || coreTopicId === topic.id ? "core" : secondaryTopicId === topic.id ? "secondary" : "out",
      };
      const card = { ...scoreTrend({ story, observations: kept.observations, failures, now, lockAt: now, coveredAngles: edition.trendDesk.coveredAngles || [] }), scope: story.scope, topicId: topic.id };
      kept.cards = [...kept.cards, card].slice(-20);
      await ledger.save();
      const before = topicsDigest(edition.topics);
      topic.trend = card;
      edition.trendDesk.checks = edition.topics.filter((item) => item.trend).map((item) => ({
        topicId: item.id, title: item.title, query: item.trend.query, score: item.trend.score, components: item.trend.components,
        recommendation: item.trend.recommendation, airable: item.trend.airable, checkedAt: item.trend.checkedAt, scope: item.trend.scope,
      }));
      return this.saveEdits(edition, before);
    });
  }

  lockCoreStory(topicId, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      if (topicId && !edition.topics.some(({ id }) => id === topicId)) throw deskError(404, "Topic not found.");
      const before = topicsDigest(edition.topics);
      edition.trendDesk = { ...edition.trendDesk, coreTopicId: topicId, lockedAt: topicId ? this.now().toISOString() : null, approval: topicId ? { by: "isaac", at: this.now().toISOString() } : null };
      for (const topic of edition.topics) {
        if (topic.trend) {
          topic.trend.scope = !topicId || topicId === topic.id ? "core" : "out";
          topic.trend.airable = topic.trend.airable && topic.trend.scope !== "out";
        }
      }
      return this.saveEdits(edition, before);
    });
  }

  normalizeTarget(target) {
    if (target === "episode") return "episode";
    const segment = Number(target);
    if (Number.isInteger(segment) && segment >= 1 && segment <= MAX_EPISODE_STORIES) return segment;
    throw deskError(400, "Choose the episode or a Short to upload.");
  }

  youtubeRecord(edition) {
    if (!edition.youtube) edition.youtube = { episode: { status: "pending" }, shorts: {} };
    if (!edition.youtube.episode) edition.youtube.episode = { status: "pending" };
    if (!edition.youtube.shorts) edition.youtube.shorts = {};
    return edition.youtube;
  }

  youtubeSlot(edition, target) {
    const record = this.youtubeRecord(edition);
    if (target === "episode") return record.episode;
    const key = String(target);
    if (!record.shorts[key]) record.shorts[key] = { status: "pending" };
    return record.shorts[key];
  }

  assignYoutubeSlot(edition, target, slot) {
    const record = this.youtubeRecord(edition);
    if (target === "episode") record.episode = slot;
    else record.shorts[String(target)] = slot;
  }

  // Same release holds as the morning publish. A blocked cut is not uploaded.
  async uploadBlocked(edition, target = "episode") {
    const surface = target === "episode" ? "episode" : "short";
    const shots = (edition.render?.shots || []).filter((entry) => entry &&
      (surface === "episode" || entry.segment === target));
    const credits = surface === "episode" ? edition.render?.episode?.footageCredits || [] : shots.map((shot) => shot.short?.credit);
    if (credits.some((credit) => credit?.previewOnly)) {
      return "This cut includes preview-only ShareAlike footage. Clear that clip for release or replace it before uploading.";
    }
    const localClips = shots.filter((entry) => entry[surface]?.footageKind === "exact" && !entry[surface].credit);
    if (!localClips.length) return null;
    const catalog = await this.catalogFor(edition);
    const cleared = localClips.every((entry) => {
      const shot = entry[surface];
      const publishedShot = edition.render.episode.segments[entry.segment - 1]?.shots?.[surface];
      const asset = catalog.assets.find(({ id }) => id === shot.use);
      const grant = catalog.grants.find(({ id }) => id === publishedShot?.grantId);
      return asset && asset.sha256 === publishedShot?.assetSha256 && grant && (grant.version || 1) === publishedShot?.grantVersion &&
        grant.components.includes("video") && grant.alterations?.overlays !== false &&
        canUse(asset, grant, surface, this.settings.channel, this.settings.territory, this.now().toISOString()).ok;
    });
    return cleared ? null : "Game footage clearance changed after rendering. Rebuild the video before publishing.";
  }

  // Titles, descriptions and hashtags for the episode and each Short. The
  // model's drafts are checked field by field; a failure uses the headlines.
  async writeListing(episode) {
    const stories = episode.segments.map((segment, index) => ({
      number: index + 1, league: segment.league || null, teams: segment.footage?.teams || [], headline: segment.headline, copy: segment.narration,
    }));
    let drafts = null;
    if (this.settings.researchConfigured && !episode.footagePreview) {
      try {
        drafts = await this.listing({ date: episode.date, stories }, { signal: this.work?.controller.signal });
      } catch (error) {
        this.work?.controller.signal.throwIfAborted();
        console.log(JSON.stringify({ listing: { date: episode.date, error: error.message } }));
      }
    }
    return { ...finishListing(episode, drafts), at: this.now().toISOString() };
  }

  async youtubePackage(edition, target) {
    const directory = this.renderDirectoryFor(edition);
    const date = edition.date;
    const rendered = edition.render?.episode || {};
    if (target === "episode") {
      const file = path.join(directory, "episode.mp4");
      await access(file).catch(() => { throw deskError(409, "The current revision has no completed video."); });
      const entries = (rendered.chapters || []).map(({ start, headline }) => ({ start, label: headline }));
      const listing = this.listingFor(edition).episode;
      return {
        file,
        episode: {
          ...rendered, title: titleWithTags(listing.title, listing.hashtags) || youtubeTitle({ date }),
          description: youtubeDescription({ date, entries, episode: { ...rendered, description: listing.description } }),
          hashtags: listing.hashtags, tags: keywordTags(listing.hashtags, rendered.segments || []),
        },
      };
    }
    const short = (edition.render?.shorts || []).find((item) => item.segment === target);
    if (!short) throw deskError(404, "Short not found.");
    const file = path.join(directory, short.file);
    await access(file).catch(() => { throw deskError(409, "That Short is not in the current cut."); });
    const segment = (rendered.segments || []).find((item, index) => (short.id && item.id === short.id) || index + 1 === target)
      || { headline: short.headline, sources: [] };
    const credit = edition.render.shots?.find((shot) => shot?.segment === target)?.short?.credit;
    // A Short with no listing entry is titled from its own headline.
    const listing = this.listingFor(edition).shorts.find((item) => item.segment === target)
      || { title: short.headline || youtubeTitle({ date }), description: short.headline || "", hashtags: hashtagsFor([segment], { short: true }) };
    const story = { description: listing.description, date, segments: [segment], footageCredits: credit ? [credit] : [] };
    return {
      file,
      episode: {
        title: titleWithTags(listing.title, listing.hashtags, { short: true }),
        description: youtubeDescription({ date, episode: story }),
        hashtags: listing.hashtags, tags: keywordTags(listing.hashtags, [segment]),
        date, duration: short.duration, segments: [segment],
      },
    };
  }

  // A cut rendered before listings existed gets the headline-based one.
  listingFor(edition) {
    if (edition.render?.listing) return edition.render.listing;
    const rendered = edition.render?.episode || {};
    return fallbackListing({ date: edition.date, segments: rendered.segments || [] });
  }

  uploadPrecondition(edition) {
    if (this.work) return "A studio job is already running.";
    if (edition.sample) return "The practice edition is not uploaded to YouTube.";
    if (edition.status !== "ready" || !edition.render || edition.render.revision !== edition.revision) {
      return edition.status === "failed" ? "The last build failed. Rebuild the video before uploading." : "Finish the current cut before uploading it.";
    }
    if (!this.settings.youtubeConfigured) return "Add YouTube OAuth credentials to .env, then restart the desk.";
    return null;
  }

  async uploadAvailability(edition) {
    const reason = this.uploadPrecondition(edition);
    if (reason) return { reason };
    const directory = this.renderDirectoryFor(edition);
    const exists = (file) => access(path.join(directory, file)).then(() => true, () => false);
    const publication = edition.publication || {};
    const [episode, ...shorts] = await Promise.all([
      exists("episode.mp4").then((found) => !found ? "The current cut has no completed episode file." : this.uploadBlocked(edition)),
      ...(edition.render.shorts || []).map(async (short) => [
        short.segment, await exists(short.file) ? await this.uploadBlocked(edition, short.segment) : "That Short is missing from the current cut.",
      ]),
    ]);
    return {
      episode: publication.sessionUrl && publication.status !== "published"
        ? publication.error || "Check YouTube Studio before uploading this episode again." : episode,
      shorts: Object.fromEntries(shorts),
    };
  }

  uploadNow(target, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      const chosen = this.normalizeTarget(target);
      const precondition = this.uploadPrecondition(edition);
      if (precondition) throw deskError(409, precondition);
      if (chosen === "episode") {
        const publication = edition.publication || {};
        if (publication.status === "published") throw deskError(409, "This episode is already on YouTube.");
        if (publication.status === "uploading") throw deskError(409, "This episode is already uploading.");
        if (publication.status === "uncertain" || publication.sessionUrl) {
          throw deskError(409, publication.error || "Check YouTube Studio before uploading this episode again.");
        }
      }
      const slot = this.youtubeSlot(edition, chosen);
      if (slot.status === "published") throw deskError(409, "This video is already on YouTube.");
      if (slot.status === "uploading") throw deskError(409, "This video is already uploading.");
      if (slot.status === "uncertain") throw deskError(409, slot.error || "Check YouTube Studio before uploading this video again.");
      const blocked = await this.uploadBlocked(edition, chosen);
      if (blocked) throw deskError(409, blocked);
      await this.startYoutubeUpload(edition, chosen);
      return this.response(edition);
    });
  }

  // Shared by the desk's upload buttons and the morning Shorts run. Callers
  // check the slot and the release holds first; this resumes a saved session.
  // Upload all: the episode, then every Short of the current cut, one at a
  // time. Anything already on YouTube, uploading or held is skipped.
  uploadAll(expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      const precondition = this.uploadPrecondition(edition);
      if (precondition) throw deskError(409, precondition);
      if (this.work) throw deskError(409, "A studio job is already running.");
      const targets = await this.pendingUploads(edition);
      if (!targets.length) throw deskError(409, "Everything in this cut is already on YouTube.");
      this.uploadQueue = { date: edition.date, revision: edition.revision, targets: targets.slice(1) };
      await this.startYoutubeUpload(edition, targets[0]);
      return this.response(edition);
    });
  }

  async pendingUploads(edition) {
    const targets = [];
    const episodeDone = edition.publication?.status === "published" || edition.publication?.sessionUrl;
    if (!episodeDone && !["published", "uploading", "uncertain"].includes(this.youtubeSlot(edition, "episode").status) &&
        !await this.uploadBlocked(edition, "episode")) targets.push("episode");
    for (const short of edition.render?.shorts || []) {
      const slot = this.youtubeSlot(edition, short.segment);
      if (["published", "uploading", "uncertain"].includes(slot.status)) continue;
      if (await this.uploadBlocked(edition, short.segment)) continue;
      targets.push(short.segment);
    }
    return targets;
  }

  continueUploadAll() {
    return this.serialized(async () => {
      const queue = this.uploadQueue;
      if (!queue || this.work) return;
      const edition = await this.load(queue.date);
      // A new cut or a spent YouTube quota ends the run.
      const quota = Object.values(this.youtubeRecord(edition).shorts || {}).some(({ error }) => quotaSpent.test(error || "")) ||
        quotaSpent.test(this.youtubeSlot(edition, "episode").error || "");
      if (edition.revision !== queue.revision || this.uploadPrecondition(edition) || quota || !queue.targets.length) {
        this.uploadQueue = null;
        return;
      }
      while (queue.targets.length) {
        const target = queue.targets.shift();
        if (["published", "uploading", "uncertain"].includes(this.youtubeSlot(edition, target).status)) continue;
        await this.startYoutubeUpload(edition, target);
        return;
      }
      this.uploadQueue = null;
    });
  }

  // The Short's place in the day: the first at shortsFirstHour, the last at
  // shortsLastHour, the rest evenly between. Null when the slot has passed.
  shortPublishTime(edition, segment) {
    if (!this.settings.publishEnabled || edition.sample) return null;
    const order = (edition.render?.shorts || []).map((short) => short.segment);
    const index = order.indexOf(segment);
    if (index < 0) return null;
    const first = Date.parse(zonedTime(edition.date, shortsFirstHour, this.settings.timezone));
    const last = Date.parse(zonedTime(edition.date, shortsLastHour, this.settings.timezone));
    const step = order.length > 1 ? (last - first) / (order.length - 1) : 0;
    // Whole minutes, as YouTube Studio shows them.
    const at = Math.round((first + step * index) / 60_000) * 60_000;
    return at - this.now().getTime() >= scheduleLead ? new Date(at).toISOString() : null;
  }

  async startYoutubeUpload(edition, chosen) {
    const slot = this.youtubeSlot(edition, chosen);
    const prepared = await this.youtubePackage(edition, chosen);
    const publishAt = typeof chosen === "number" ? this.shortPublishTime(edition, chosen) : null;
    if (publishAt) prepared.episode = { ...prepared.episode, publishAt };
    const sessionUrl = slot.sessionUrl;
    this.assignYoutubeSlot(edition, chosen, {
      ...slot, status: "uploading", error: null, title: prepared.episode.title,
      attempts: (slot.attempts || 0) + 1, lastAttempt: this.now().toISOString(),
    });
    await this.save(edition);
    this.launch(edition, "youtube", async () => {
      const result = await this.upload({
        file: prepared.file, episode: prepared.episode, sessionUrl,
        onSession: (nextSession) => this.serialized(async () => {
          const current = await this.load(edition.date);
          const currentSlot = this.youtubeSlot(current, chosen);
          this.assignYoutubeSlot(current, chosen, { ...currentSlot, sessionUrl: nextSession });
          await this.save(current);
        }),
      });
      await this.serialized(async () => {
        const current = await this.load(edition.date);
        this.assignYoutubeSlot(current, chosen, {
          status: "published", id: result.id, url: result.url, privacyStatus: result.privacyStatus,
          ...(result.publishAt && { publishAt: result.publishAt }),
          title: prepared.episode.title, at: this.now().toISOString(), error: null,
        });
        await this.save(current);
      });
      try {
        await this.attachThumbnail(edition.date, chosen);
      } catch (error) {
        console.error(`[sports thumbnail ${edition.date}] ${error.message}`);
      }
    }, chosen);
  }

  // After the long-form episode is public, upload every Short of the same cut,
  // one at a time, in segment order. A failed Short retries like the episode
  // (four attempts, four minutes apart, resuming its saved session); an
  // uncertain one waits for a person to check YouTube Studio.
  async publishShorts(edition) {
    if (!this.settings.publishEnabled || edition.sample || edition.publication?.status !== "published") return;
    if (this.uploadPrecondition(edition)) return;
    // Every upload draws on one daily YouTube quota. Once YouTube says it is
    // spent, the remaining Shorts stop for the day instead of burning retries.
    if (Object.values(this.youtubeRecord(edition).shorts || {}).some(({ error }) => quotaSpent.test(error || ""))) return;
    for (const short of edition.render.shorts || []) {
      const slot = this.youtubeSlot(edition, short.segment);
      if (["published", "uploading", "uncertain"].includes(slot.status) || (slot.attempts || 0) >= 4) continue;
      if (slot.lastAttempt && this.now().getTime() - Date.parse(slot.lastAttempt) < uploadRetry) return;
      const blocked = await this.uploadBlocked(edition, short.segment);
      if (blocked) {
        if (slot.status !== "held" || slot.error !== blocked) {
          this.assignYoutubeSlot(edition, short.segment, { ...slot, status: "held", error: blocked });
          await this.save(edition);
        }
        continue;
      }
      return this.startYoutubeUpload(edition, short.segment);
    }
  }

  replyToComments() {
    return this.serialized(async () => {
      if (!this.settings.youtubeConfigured) throw deskError(409, "Add YouTube OAuth credentials to .env, then restart the desk.");
      if (!this.settings.researchConfigured) throw deskError(409, "Connect a model before replying to YouTube comments.");
      if (this.commentWork) throw deskError(409, "Comment replies are already running.");
      const state = await this.loadComments();
      const baseline = {
        ...state, status: "running", error: null, liked: 0, replied: 0, failed: 0, remaining: 0, unliked: 0, likesUnsupported: false,
      };
      await this.saveComments(baseline);
      this.commentWork = this.finishComments(baseline).finally(() => { this.commentWork = null; });
      return this.response(await this.load(this.clock().date));
    });
  }

  async finishComments(baseline) {
    await Promise.resolve();
    try {
      const result = await this.engage({
        likedIds: baseline.likedIds,
        repliedIds: baseline.repliedIds,
        replyFor: (comment) => this.commentReply(comment),
        signal: AbortSignal.timeout(12 * 60_000),
        onProgress: (partial) => this.saveComments({ ...baseline, ...partial, status: "running" }),
      });
      await this.saveComments({ ...baseline, ...result, status: "done", at: this.now().toISOString() });
    } catch (error) {
      console.error(`[sports comments] ${error.message}`);
      const current = normalizeComments(await readJson(this.commentsFile()).catch(() => baseline));
      await this.saveComments({
        ...current,
        status: "failed",
        error: error.name === "TimeoutError" || error.name === "AbortError"
          ? "Comment replies paused before the inbox was finished. Click again to continue."
          : error.message,
        at: this.now().toISOString(),
      });
    }
  }

  async publish(edition) {
    if (!this.settings.publishEnabled || edition.sample || edition.publication.status === "published") return;
    // Uploaded from the desk's button: the automatic publish must not post it twice.
    if (["published", "uploading", "uncertain"].includes(edition.youtube?.episode?.status)) return;
    const pub = edition.publication;
    const file = path.join(this.renderDirectoryFor(edition), "episode.mp4");
    const ready = edition.status === "ready" && edition.render?.revision === edition.revision;
    const videoExists = ready && await access(file).then(() => true, () => false);
    if (!this.settings.youtubeConfigured || !videoExists) {
      const error = !this.settings.youtubeConfigured ? "Connect a YouTube channel to publish." : "The current revision has no completed video. Publishing is on hold.";
      if (!pub.sessionUrl && (pub.status !== "held" || pub.error !== error)) {
        edition.publication = { status: "held", error };
        await this.save(edition);
      }
      return;
    }
    if (pub.status === "uncertain" || (pub.attempts || 0) >= 4 ||
        (pub.lastAttempt && this.now().getTime() - Date.parse(pub.lastAttempt) < uploadRetry)) return;
    const previewOnly = edition.render.episode.footageCredits?.some(({ previewOnly }) => previewOnly);
    const blocked = await this.uploadBlocked(edition);
    if (blocked) {
      if (previewOnly) {
        if (!pub.sessionUrl && (pub.status !== "held" || pub.error !== blocked)) {
          edition.publication = { ...pub, status: "held", error: blocked };
          await this.save(edition);
        }
      } else {
        edition.publication = { ...pub, status: "held", error: blocked };
        await this.save(edition);
      }
      return;
    }
    const prepared = await this.youtubePackage(edition, "episode");
    edition.publication = { ...pub, status: "uploading", error: null, attempts: (pub.attempts || 0) + 1, lastAttempt: this.now().toISOString() };
    await this.save(edition);
    this.launch(edition, "publish", async () => {
      const result = await this.upload({
        file: prepared.file, episode: prepared.episode, sessionUrl: pub.sessionUrl,
        onSession: (sessionUrl) => this.serialized(async () => {
          const current = await this.load(edition.date);
          current.publication.sessionUrl = sessionUrl;
          await this.save(current);
        }),
      });
      await this.serialized(async () => {
        const current = await this.load(edition.date);
        current.publication = { ...result, status: "published", at: this.now().toISOString() };
        await this.save(current);
      });
      try {
        await this.attachThumbnail(edition.date, "episode");
      } catch (error) {
        console.error(`[sports thumbnail ${edition.date}] ${error.message}`);
      }
    });
  }

  // 8:15 a.m. and the episode is not on YouTube (the build failed or is still
  // running, or the upload failed or is held): start the Emergency fix agent,
  // told to fix whatever is wrong, watch the build until it is ready and
  // upload the episode. Once per edition, recorded on it, so a desk restart by
  // the agent does not start a second one. Called inside tick's serialization.
  async uploadEmergency(edition) {
    if (!this.emergency || !this.settings.publishEnabled || edition.sample || edition.uploadEmergency) return false;
    if (this.now().getTime() < Date.parse(this.airTimeFor(edition.date)) + uploadEmergencyAfter) return false;
    const published = edition.publication?.status === "published" || edition.youtube?.episode?.status === "published";
    const uploading = ["uploading"].includes(edition.publication?.status) || edition.youtube?.episode?.status === "uploading";
    if (published || (uploading && ["publish", "youtube"].includes(this.work?.task))) return false;
    const reason = edition.status !== "ready"
      ? `the build is ${edition.status}${edition.error ? `: ${edition.error}` : ""}`
      : `the upload is ${edition.publication?.status || "not started"}${edition.publication?.error ? `: ${edition.publication.error}` : ""}`;
    const state = JSON.stringify({
      status: edition.status, error: edition.error || null, generationRetry: edition.generationRetry || null,
      buildAttempts: edition.buildAttempts || 0, running: this.work ? `${this.work.task} ${this.work.date}` : null,
      publication: edition.publication || null, episodeSlot: edition.youtube?.episode || null,
    });
    const record = { at: this.now().toISOString(), reason };
    try {
      const { uploadEmergencyBrief } = await import("./emergency.mjs");
      const view = await this.emergency.send(`The ${edition.date} episode is not on YouTube: ${reason}. Fix it, watch the build until it is ready, and upload the episode.`,
        undefined, { brief: uploadEmergencyBrief(this.emergency.root, { date: edition.date, state }) });
      record.chat = view.chat?.id || null;
      console.warn(`[sports emergency] ${edition.date}: the episode missed its upload (${reason}); started the Emergency fix agent (chat ${record.chat}).`);
    } catch (error) {
      record.error = error.message;
      console.error(`[sports emergency] ${edition.date}: could not start the Emergency fix agent: ${error.message}`);
    }
    edition.uploadEmergency = record;
    await this.save(edition);
    return true;
  }

  // Every 2 hours while the sign-in works; every 10 minutes once it has
  // expired, so the warning clears soon after the owner reconnects.
  checkYoutubeAuth({ force = false } = {}) {
    if (!this.authCheck || !this.settings.youtubeConfigured || this.youtubeAuthChecking) return this.youtubeAuthChecking;
    const last = this.youtubeAuth ? Date.parse(this.youtubeAuth.checkedAt) : 0;
    const every = this.youtubeAuth?.status === "expired" ? 10 * 60_000 : 2 * 60 * 60_000;
    if (!force && this.now().getTime() - last < every) return null;
    this.youtubeAuthChecking = (async () => {
      const checkedAt = this.now().toISOString();
      try {
        await this.authCheck();
        if (this.youtubeAuth?.status === "expired") console.log("[sports youtube] the channel sign-in works again.");
        this.youtubeAuth = { status: "ok", checkedAt, error: null };
      } catch (error) {
        // Only a revoked or expired token needs the owner; network trouble is retried.
        if (!error.reconnect) {
          this.youtubeAuth = { ...(this.youtubeAuth || { status: "unknown" }), checkedAt };
          return;
        }
        if (this.youtubeAuth?.status !== "expired") console.warn(`[sports youtube] ${error.message}`);
        this.youtubeAuth = { status: "expired", checkedAt, error: error.message };
      }
    })().finally(() => { this.youtubeAuthChecking = null; });
    return this.youtubeAuthChecking;
  }

  tick() {
    this.checkYoutubeAuth();
    return this.serialized(async () => {
      const { date, hour } = this.clock();
      // At the rollover, a build or research still running for an earlier
      // show is stopped so the new edition's research can start.
      if (this.work && this.work.date < date && ["build", "research"].includes(this.work.task)) {
        console.warn(`[sports desk] stopping the ${this.work.date} ${this.work.task}: the ${date} edition is open.`);
        this.rebuildDate = null;
        clearTimeout(this.rebuildTimer);
        this.work.controller.abort();
        return;
      }
      if (this.emergency && hour >= airHour && hour <= shortsUntilHour && await this.uploadEmergency(await this.load(date))) return;
      if (this.work || hour > shortsUntilHour) return;
      const edition = await this.load(date);
      // A replacement cut is an editorial draft; publishing it is a separate,
      // explicit action, even when the original aired on the daily schedule.
      if (edition.manualRevision || edition.buildPaused) return;
      // 8 a.m.: the long-form episode, then its Shorts. Shorts that are still
      // retrying may finish until shortsUntilHour; the episode stays at 8.
      if (hour >= 8) {
        if (hour === 8 && edition.publication?.status !== "published") return this.publish(edition);
        await this.retryThumbnails(edition);
        return this.publishShorts(edition);
      }
      if (this.evidence?.name === "espn" && hour < 8 && !publicationLocked(edition)) await this.scanIfDue(edition);
      if (edition.sample) return;
      if (!this.settings.researchConfigured) {
        if (topicsScripted(edition) && edition.render?.revision !== edition.revision && (edition.buildAttempts || 0) < 3 &&
            (!edition.lastBuildAttempt || this.now().getTime() - Date.parse(edition.lastBuildAttempt) >= overnightRetry)) return this.queueBuild(edition);
        return;
      }
      const canRetry = (attempts, at) => (attempts || 0) < 3 && (!at || this.now().getTime() - Date.parse(at) >= overnightRetry);
      // An edition that already has a cut is never re-researched on its own:
      // a restart mid-research once rewrote a finished rundown.
      if (!edition.researchedAt && !edition.render && canRetry(edition.researchAttempts, edition.lastResearchAttempt)) return this.queueResearch(edition);
      if (edition.researchedAt && edition.topics.some(({ selected }) => selected) && edition.render?.revision !== edition.revision &&
          canRetry(edition.buildAttempts, edition.lastBuildAttempt)) return this.queueBuild(edition);
    });
  }

  renderDirectoryFor(edition) {
    return path.join(this.directoryFor(edition), String(edition.render?.revision ?? edition.revision), edition.render?.build || "");
  }

  videoPath(date, revision, segment) {
    return this.serialized(async () => {
      const edition = await this.load(date);
      const render = edition.render?.revision === revision ? edition.render : (edition.releases || []).find((release) => release.render?.revision === revision)?.render;
      if (!render) throw deskError(404, "Sports preview not found.");
      const directory = path.join(this.directoryFor(edition), String(revision), render.build || "");
      if (segment === undefined) return path.join(directory, "episode.mp4");
      const short = (render.shorts || []).find((short) => short.segment === segment);
      if (!short) throw deskError(404, "Short not found.");
      return path.join(directory, short.file);
    });
  }

  // The slot that actually went out: the 8 a.m. episode lives on publication,
  // a manual episode upload and every Short live on youtube.
  publishedSlot(edition, target) {
    if (target === "episode") {
      if (edition.publication?.status === "published" && edition.publication.id) return edition.publication;
      if (edition.youtube?.episode?.status === "published" && edition.youtube.episode.id) return edition.youtube.episode;
      return null;
    }
    const slot = edition.youtube?.shorts?.[String(target)];
    return slot?.status === "published" && slot.id ? slot : null;
  }

  thumbnailRelative(edition, target) {
    const files = edition.render?.thumbnails;
    if (!files) return null;
    const relative = target === "episode" ? files.episode : files.shorts?.[String(target)];
    if (typeof relative !== "string" || !/^thumbnails\/(?:episode|segment-\d{2})\.jpg$/u.test(relative)) return null;
    return relative;
  }

  thumbnailPath(date, revision, target) {
    return this.serialized(async () => {
      const edition = await this.load(date);
      if (edition.render?.revision !== revision) throw deskError(404, "Sports preview not found.");
      const chosen = this.normalizeTarget(target);
      const relative = this.thumbnailRelative(edition, chosen);
      if (!relative) throw deskError(404, "Thumbnail not found.");
      const directory = this.renderDirectoryFor(edition);
      const resolved = path.resolve(directory, relative);
      if (!resolved.startsWith(`${path.resolve(directory)}${path.sep}`)) throw deskError(404, "Thumbnail not found.");
      await access(resolved).catch(() => { throw deskError(404, "Thumbnail not found."); });
      return resolved;
    });
  }

  // Mutates only slot.thumbnail. Callers that already hold the desk lock call
  // this directly; attachThumbnail takes the lock for upload callbacks.
  async applyThumbnail(edition, target, { force = false } = {}) {
    if (!thumbnailsEnabled()) return;
    if (target !== "episode" && !shortThumbnailsEnabled()) return;
    if (!force && edition.youtube?.thumbnailHalt) return;
    const slot = this.publishedSlot(edition, target);
    if (!slot?.id) return;
    const previous = slot.thumbnail;
    if (!force && (previous?.status === "set" || previous?.status === "unavailable")) return;
    const attempts = (previous?.attempts || 0) + 1;
    const at = this.now().toISOString();
    const relative = this.thumbnailRelative(edition, target);
    const file = relative ? path.join(this.renderDirectoryFor(edition), relative) : null;
    const record = async (thumbnail, halt) => {
      slot.thumbnail = thumbnail;
      if (halt || edition.youtube?.thumbnailHalt) {
        const youtube = this.youtubeRecord(edition);
        if (halt) youtube.thumbnailHalt = { reason: halt, error: thumbnail.error, at };
        else delete youtube.thumbnailHalt;
      }
      await this.save(edition);
    };
    const missing = !file || await access(file).then(() => false, () => true);
    if (missing) {
      await record({ status: "failed", error: "The thumbnail file is missing.", at, attempts });
      return;
    }
    try {
      await this.thumbnail({ videoId: slot.id, file, signal: AbortSignal.timeout(60_000) });
      await record({ status: "set", error: null, at, attempts });
    } catch (error) {
      console.error(`[sports thumbnail ${edition.date} ${target}] ${error.message}`);
      const classified = classifyThumbnailError(error);
      await record({ status: classified.status, error: error.message, at, attempts }, classified.halt);
    }
  }

  attachThumbnail(date, target) {
    return this.serialized(async () => {
      const edition = await this.load(date);
      await this.applyThumbnail(edition, target);
    });
  }

  // One failed thumbnail per tick, and only one extra attempt.
  async retryThumbnails(edition) {
    if (!thumbnailsEnabled() || edition.youtube?.thumbnailHalt) return;
    const targets = ["episode", ...(edition.render?.shorts || []).map((short) => short.segment)];
    for (const target of targets) {
      if (target !== "episode" && !shortThumbnailsEnabled()) continue;
      const thumbnail = this.publishedSlot(edition, target)?.thumbnail;
      if (thumbnail?.status !== "failed" || (thumbnail.attempts || 0) >= 2) continue;
      if (thumbnail.at && this.now().getTime() - Date.parse(thumbnail.at) < uploadRetry) continue;
      await this.applyThumbnail(edition, target);
      return;
    }
  }

  resendThumbnail(target, expectedDate) {
    return this.serialized(async () => {
      if (this.work) throw deskError(409, "A studio job is already running.");
      const edition = await this.readCurrent(expectedDate);
      const chosen = this.normalizeTarget(target);
      if (!thumbnailsEnabled() || (chosen !== "episode" && !shortThumbnailsEnabled())) {
        throw deskError(409, "Thumbnails are turned off.");
      }
      if (!this.publishedSlot(edition, chosen)) throw deskError(409, "Publish the video before setting its thumbnail.");
      await this.applyThumbnail(edition, chosen, { force: true });
      return this.response(edition);
    });
  }

  copyForThumbnail(edition, target) {
    const segments = edition.render?.episode?.segments || [];
    if (target === "episode") return segments.map((segment) => `${segment.headline || ""} ${segment.narration || ""}`).join(" ");
    const segment = segments[Number(target) - 1];
    return `${segment?.headline || ""} ${segment?.narration || ""}`;
  }

  // Redraws the current cut's thumbnails without rendering the video again.
  regenerateThumbnails({ date, target, text } = {}) {
    return this.serialized(async () => {
      if (this.work) throw deskError(409, "A studio job is already running.");
      if (!thumbnailsEnabled()) throw deskError(409, "Thumbnails are turned off.");
      const edition = await this.readCurrent(date);
      if (edition.status !== "ready" || !edition.render || edition.render.revision !== edition.revision) {
        throw deskError(409, "Finish the current cut before redrawing thumbnails.");
      }
      const chosen = target === undefined || target === null || target === "" ? null : this.normalizeTarget(target);
      if (!edition.render.listing) {
        edition.render.listing = {
          ...fallbackListing({ date: edition.date, segments: edition.render.episode?.segments || [] }),
          at: this.now().toISOString(),
        };
      }
      const listing = edition.render.listing;
      if (chosen && text !== undefined && String(text).trim()) {
        const line = cleanThumbnailLine(text);
        if (!thumbnailAllowed(line, this.copyForThumbnail(edition, chosen))) {
          throw deskError(422, "Use 2 to 4 words, and only numbers that are in the story.");
        }
        const others = [
          chosen === "episode" ? null : listing.episode?.thumbnail,
          ...(listing.shorts || []).filter((short) => short.segment !== chosen).map((short) => short.thumbnail),
        ].filter(Boolean);
        if (others.some((item) => item.toLowerCase() === line.toLowerCase())) {
          throw deskError(422, "That thumbnail line is already on another video in this edition.");
        }
        if (chosen === "episode") listing.episode = { ...listing.episode, thumbnail: line };
        else {
          const short = (listing.shorts || []).find((item) => item.segment === chosen);
          if (short) short.thumbnail = line;
          else listing.shorts = [...(listing.shorts || []), { segment: chosen, title: "", description: "", hashtags: [], thumbnail: line }];
        }
      }
      const directory = this.renderDirectoryFor(edition);
      const drawn = await renderCutThumbnails({
        directory,
        episode: { ...edition.render.episode, date: edition.date },
        listing,
        photos: edition.render.episode?.thumbnailPhotos || [],
        shorts: edition.render.shorts || [],
      });
      edition.render.thumbnails = drawn?.files || null;
      edition.render.qc = { ...(edition.render.qc || {}), ...(drawn ? { thumbnails: drawn.checks } : {}) };
      await this.save(edition);
      const targets = chosen ? [chosen] : ["episode", ...(edition.render.shorts || []).map((short) => short.segment)];
      for (const item of targets) {
        if (this.publishedSlot(edition, item)) await this.applyThumbnail(edition, item, { force: true });
      }
      return this.response(await this.load(edition.date));
    });
  }
}
