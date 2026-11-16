import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../config.mjs";
import { readJson, saveJson } from "../storage.mjs";
import { AssetCache } from "./assets.mjs";
import { FixtureEvidenceAdapter, scanSlate } from "./evidence.mjs";
import { EspnEvidenceAdapter } from "./espn/adapter.mjs";
import { EvidenceLedger, LedgerError, fingerprint, numbersIn } from "./ledger.mjs";
import { draftIsaacTake, editTopics, researchConfigured, researchEdition, writeAnchorScript, writeEpisode } from "./research.mjs";
import { platesFor } from "./marks.mjs";
import { canUse, planShots } from "./rights.mjs";
import { coverageScope, inScope } from "./scope.mjs";
import { opinionSegment, sampleEpisode, sampleTopics, scriptedSegment, takeNarration } from "./sample.mjs";
import { GoogleTrendingNowAdapter, collectObservations, scoreTrend, trendSegment } from "./trend.mjs";
import { uploadEpisode, youtubeConfigured } from "./youtube.mjs";

const maxTopics = 12;
const overnightRetry = 15 * 60_000;
const uploadRetry = 4 * 60_000;
const airHour = 8;
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

// The UTC instant of a local wall-clock hour on a date in the desk's time zone.
export function zonedTime(date, hour, timezone) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:00:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess)).map(({ type, value }) => [type, value]));
  const seen = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (seen - guess)).toISOString();
}

function isolatedRender(episode, directory, onProgress) {
  return new Promise((resolve, reject) => {
    const worker = fork(workerFile, [], { windowsHide: true, stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const timeout = setTimeout(() => {
      reject(new Error("The sports render exceeded its 40-minute time limit."));
      worker.kill();
    }, 40 * 60_000).unref();
    worker.on("message", ({ progress, metadata, error }) => {
      if (progress) onProgress(progress);
      if (metadata) resolve(metadata);
      if (error) reject(new Error(error));
    });
    worker.once("error", reject);
    worker.once("exit", () => {
      clearTimeout(timeout);
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

function publicView(edition, settings, progress) {
  const { sessionUrl, ...publication } = edition.publication;
  const { episode, ...render } = edition.render || {};
  const { anchorCache, ...visible } = edition;
  return { edition: { ...visible, render: edition.render ? render : null, publication, locked: publicationLocked(edition), progress }, settings };
}

const publicationLocked = ({ publication }) => Boolean(publication.sessionUrl || ["uploading", "published", "uncertain"].includes(publication.status));

function message(role, content, at) {
  return { id: randomUUID(), role, content, at };
}

function topicsScripted(edition) {
  const selected = edition.topics.filter((topic) => topic.selected);
  return selected.length > 0 && selected.every((topic) => topic.script?.narration || takeNarration(topic));
}

function newTopic({ title, summary = "", take = "", selected = true, clipUrl = "", url, excerpt = "", sport = null, league = null, teams = [] }) {
  return {
    id: randomUUID(), title, summary, take, selected, sport, league, teams, ...(clipUrl && { clipUrl }),
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
    draftTake = draftIsaacTake,
    chat = editTopics,
    render = isolatedRender,
    upload = uploadEpisode,
    canResearch = researchConfigured,
    canUpload = youtubeConfigured,
    evidence,
    trend = [new GoogleTrendingNowAdapter()],
    catalog = null,
    scope = coverageScope(),
    rebuildDelay = 2500,
  } = {}) {
    this.directory = directory;
    this.scope = scope;
    this.evidence = evidence || (process.env.SPORTS_EVIDENCE === "espn" ? new EspnEvidenceAdapter({ timezone, assets: new AssetCache() }) : new FixtureEvidenceAdapter());
    this.settings = {
      timezone, publishEnabled, privacy, channel, territory, researchConfigured: canResearch(), youtubeConfigured: canUpload(),
      evidenceProvider: this.evidence?.name || null, trendProviders: trend.map((adapter) => adapter.name), scope,
    };
    this.now = now;
    this.research = research;
    this.write = write;
    this.anchor = anchor;
    this.generateTake = draftTake;
    this.ask = chat;
    this.render = render;
    this.upload = upload;
    this.trendAdapters = trend;
    this.catalog = catalog;
    this.rebuildDelay = rebuildDelay;
    this.tail = Promise.resolve();
  }

  clock() {
    return localClock(this.now(), this.settings.timezone);
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
    }
    return edition;
  }

  save(edition) {
    edition.updatedAt = this.now().toISOString();
    return saveJson(path.join(this.directoryFor(edition), "edition.json"), edition);
  }

  response(edition) {
    return publicView(edition, this.settings, this.work?.date === edition.date ? this.work.progress : undefined);
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

  launch(edition, task, callback) {
    const work = { date: edition.date, task };
    this.work = work;
    work.done = Promise.resolve().then(callback).catch(async (error) => {
      const cause = error.cause?.message ? ` (${error.cause.name || "cause"}: ${error.cause.message})` : "";
      console.error(`[sports ${task} ${work.date}] ${error.message}${cause}`);
      await this.serialized(async () => {
        const latest = await this.load(work.date);
        if (task === "publish") {
          latest.publication.status = error.uploadUncertain ? "uncertain" : "failed";
          latest.publication.error = error.message;
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
    });
  }

  async queueResearch(edition) {
    if (!this.settings.researchConfigured || edition.sample) throw deskError(409, "Set a sports research model to run live research. The practice rundown is available now.");
    this.ensureEditable(edition);
    edition.status = "researching";
    edition.error = null;
    edition.lastResearchAttempt = this.now().toISOString();
    edition.researchAttempts = (edition.researchAttempts || 0) + 1;
    await this.save(edition);
    this.launch(edition, "research", async () => {
      const topics = await this.research(edition.date);
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
        return current;
      });
      await this.produce(snapshot);
    });
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
      return { title: `Wellspring Media Sports | ${snapshot.date}`, description: "The overnight recap.", segments: selected.map((topic) => topic.script ? scriptedSegment(topic) : opinionSegment(topic)) };
    }
    const unscripted = selected.filter((topic) => !topic.script);
    const written = unscripted.length
      ? await this.write({ ...snapshot, topics: unscripted })
      : { title: `Wellspring Media Sports | ${snapshot.date}`, description: "The overnight recap with every number bound to its evidence.", segments: [] };
    const byTopic = new Map(unscripted.map((topic, index) => [topic.id, written.segments[index]]));
    const segments = selected.map((topic) => topic.script ? scriptedSegment(topic) : byTopic.get(topic.id) && { ...byTopic.get(topic.id), topicId: topic.id }).filter(Boolean);
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
    const keyed = scripted.map((item) => ({ ...item, key: fingerprint({ draft: item.topic.script.narration, claims: item.topic.claimIds, position: position(item.index) }) }));
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
        })) });
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
    const { topicSources = [], ...draft } = snapshot.sample ? sampleEpisode(snapshot) : await this.writeLive(snapshot);
    const selected = snapshot.topics.filter((topic) => topic.selected);
    const episode = {
      ...draft, title: draft.title?.replace(/Overtime Desk/giu, "Wellspring Media Sports") || "Wellspring Media Sports", date: snapshot.date, airAt: this.airTimeFor(snapshot.date), channel: this.settings.channel, territory: this.settings.territory,
      footageSearch: !snapshot.sample && process.env.SPORTS_CLIP_DISCOVERY !== "off",
      segments: draft.segments.map((segment, index) => {
        const topic = snapshot.topics.find((candidate) => candidate.id === segment.topicId) || selected[index];
        return {
          ...segment, topicId: topic?.id || null, eventId: segment.eventId ?? topic?.eventId ?? null, id: segment.id || topic?.eventId || undefined,
          ...(topic && { footage: { clipUrl: topic.clipUrl, sport: topic.sport, teams: topic.teams, people: topic.entities, gameDate: topic.gameDate, topicTitle: topic.title } }),
        };
      }),
    };
    const trend = trendSegment(this.trendAngles(snapshot));
    if (trend) episode.segments.push(trend);
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
      metadata = await this.render(episode, directory, (progress) => { this.work.progress = progress; });
      await access(path.join(directory, "episode.mp4"));
    } catch (error) {
      await rm(directory, { recursive: true, force: true }).catch(() => {});
      throw error;
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
      for (const { id, sources } of topicSources) {
        const topic = current.topics.find((topic) => topic.id === id);
        if (topic) topic.sources = [...new Map([...topic.sources, ...sources].map((source) => [source.url, source])).values()];
      }
      const base = `/api/sports/video/${snapshot.date}/${snapshot.revision}`;
      if (snapshot.anchorCache) current.anchorCache = snapshot.anchorCache;
      current.render = {
        title: episode.title, duration: metadata.duration, revisionId: revision.id, anchor: snapshot.anchor || null,
        episode: { ...episode, chapters: metadata.chapters, duration: metadata.duration, footageCredits: metadata.footageCredits || [] }, revision: snapshot.revision,
        createdAt: this.now().toISOString(), build, url: `${base}?cut=${build}`, qc: metadata.qc || null, shots: metadata.shots || null,
        shorts: (metadata.shorts || []).map((short) => ({ ...short, url: `${base}/short/${short.segment}?cut=${build}` })),
      };
      current.verification = {
        revisionId: revision.id, revision: snapshot.revision, ok: true, at: revision.lockedAt,
        segments: revision.stories.map(({ segmentId, headline, kind, claimIds }) => ({ segmentId, headline, kind, claims: claimIds.length })),
      };
      current.status = "ready";
      await this.save(current);
    });
  }

  async queueBuild(edition) {
    this.ensureEditable(edition);
    if (!edition.topics.some(({ selected }) => selected)) throw deskError(409, "Include at least one topic before building an episode.");
    if (!edition.sample && !this.settings.researchConfigured && !topicsScripted(edition)) throw deskError(409, "Set a sports research model to write the script.");
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
        if (edition.sample || !edition.topics.some(({ selected }) => selected)) return;
        if (!this.settings.researchConfigured && !topicsScripted(edition)) return;
        if (edition.render?.revision !== edition.revision) await this.queueBuild(edition);
      }).catch((error) => { if (error.status !== 409) console.error(error); });
    }, this.rebuildDelay).unref();
  }

  run(task, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      if (this.work) throw deskError(409, "A studio job is already running.");
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
    const result = await this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const before = topicsDigest(edition.topics);
      if (changes.league && !inScope(changes.league, this.scope)) throw deskError(409, `Coverage is limited to ${this.scope.label}.`);
      const { headline, narration, draftTake, ...rest } = changes;
      let topic;
      let previousTake;
      if (topicId) {
        topic = edition.topics.find(({ id }) => id === topicId);
        if (!topic) throw deskError(404, "Topic not found.");
        previousTake = topic.take || "";
        if (headline !== undefined || narration !== undefined) {
          if (!topic.script) throw deskError(409, "Only a story scanned from evidence carries an editable script.");
          topic.script = { ...topic.script, ...(headline !== undefined && { headline }), ...(narration !== undefined && { narration }) };
        }
        Object.assign(topic, rest);
      } else {
        if (edition.topics.length >= maxTopics) throw deskError(409, `An edition can hold ${maxTopics} topics.`);
        topic = newTopic(rest);
        previousTake = "";
        edition.topics.push(topic);
      }
      const notesChanged = previousTake !== (topic.take || "");
      if (draftTake && !topic.take?.trim()) throw deskError(400, "Add take notes before drafting.");
      if (draftTake && !this.settings.researchConfigured) throw deskError(409, "Connect a model to draft the take script.");
      if (topic.take?.trim() && this.settings.researchConfigured && (notesChanged || draftTake)) {
        return { topic, date: edition.date, revision: edition.revision };
      }
      if (notesChanged) topic.takeScript = "";
      return { view: await this.saveEdits(edition, before) };
    });
    if (result.view) return result.view;
    await this.fillTakeScript(result.topic);
    return this.serialized(async () => {
      const edition = await this.readCurrent(result.date);
      this.ensureEditable(edition);
      if (edition.revision !== result.revision) throw deskError(409, "The rundown changed while the take was drafting. Save again.");
      const before = topicsDigest(edition.topics);
      if (topicId) {
        const index = edition.topics.findIndex(({ id }) => id === topicId);
        if (index < 0) throw deskError(404, "Topic not found.");
        edition.topics[index] = { ...result.topic, trend: edition.topics[index].trend };
      } else edition.topics.push(result.topic);
      return this.saveEdits(edition, before);
    });
  }

  async postChat(content, topicId, expectedDate, validateEdits) {
    const snapshot = await this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      if (topicId && !edition.topics.some(({ id }) => id === topicId)) throw deskError(404, "Topic not found.");
      return edition;
    });
    const answer = snapshot.sample ? previewChat(content, topicId) : await this.ask(snapshot, content, topicId);
    const edits = validateEdits(answer.edits);
    const takeScripts = new Map();
    for (const [index, { id, url, ...changes }] of edits.entries()) {
      const original = snapshot.topics.find((topic) => topic.id === id);
      if (changes.take === undefined || changes.take === (original?.take || "")) continue;
      const topic = original ? { ...original, ...changes } : newTopic({ ...changes, url });
      topic.takeScript = "";
      if (topic.take.trim() && this.settings.researchConfigured) await this.fillTakeScript(topic);
      takeScripts.set(index, topic.takeScript);
    }
    return this.serialized(async () => {
      const edition = await this.readCurrent(snapshot.date);
      this.ensureEditable(edition);
      if (snapshot.revision !== edition.revision || snapshot.messages.at(-1)?.id !== edition.messages.at(-1)?.id) {
        throw deskError(409, "The rundown changed while the editor was replying. Send the message again.");
      }
      const before = topicsDigest(edition.topics);
      for (const [index, { id, url, ...changes }] of edits.entries()) {
        const takeScript = takeScripts.has(index) ? { takeScript: takeScripts.get(index) } : {};
        if (id) {
          const topic = edition.topics.find((topic) => topic.id === id);
          if (!topic) throw deskError(409, "The editor returned a topic that is no longer in the rundown.");
          Object.assign(topic, changes, takeScript);
        } else {
          if (edition.topics.length >= maxTopics) throw deskError(409, `An edition can hold ${maxTopics} topics.`);
          edition.topics.push({ ...newTopic({ ...changes, url }), ...takeScript });
        }
      }
      const at = this.now().toISOString();
      edition.messages = [...edition.messages, message("user", content, at), message("assistant", answer.reply, at)].slice(-80);
      return this.saveEdits(edition, before);
    });
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

  async publish(edition) {
    if (!this.settings.publishEnabled || edition.sample || edition.publication.status === "published") return;
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
    const localClips = (edition.render.shots || []).filter((entry) => entry?.episode?.footageKind === "exact" && !entry.episode.credit);
    if (localClips.length) {
      const catalog = await this.catalogFor(edition);
      const cleared = localClips.every(({ segment, episode }) => {
        const publishedShot = edition.render.episode.segments[segment - 1]?.shots?.episode;
        const asset = catalog.assets.find(({ id }) => id === episode.use);
        const grant = catalog.grants.find(({ id }) => id === publishedShot?.grantId);
        return asset && asset.sha256 === publishedShot?.assetSha256 && grant && (grant.version || 1) === publishedShot?.grantVersion &&
          grant.components.includes("video") && grant.alterations?.overlays !== false &&
          canUse(asset, grant, "episode", this.settings.channel, this.settings.territory, this.now().toISOString()).ok;
      });
      if (!cleared) {
        edition.publication = { ...pub, status: "held", error: "Game footage clearance changed after rendering. Rebuild the episode before publishing." };
        await this.save(edition);
        return;
      }
    }
    edition.publication = { ...pub, status: "uploading", error: null, attempts: (pub.attempts || 0) + 1, lastAttempt: this.now().toISOString() };
    await this.save(edition);
    this.launch(edition, "publish", async () => {
      const result = await this.upload({
        file, episode: edition.render.episode, sessionUrl: pub.sessionUrl,
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
    });
  }

  tick() {
    return this.serialized(async () => {
      const { date, hour } = this.clock();
      if (this.work || hour > 8) return;
      const edition = await this.load(date);
      if (hour === 8) return this.publish(edition);
      if (this.evidence?.name === "espn" && hour < 8 && !publicationLocked(edition)) await this.scanIfDue(edition);
      if (edition.sample) return;
      if (!this.settings.researchConfigured) {
        if (topicsScripted(edition) && edition.render?.revision !== edition.revision && (edition.buildAttempts || 0) < 3 &&
            (!edition.lastBuildAttempt || this.now().getTime() - Date.parse(edition.lastBuildAttempt) >= overnightRetry)) return this.queueBuild(edition);
        return;
      }
      const canRetry = (attempts, at) => (attempts || 0) < 3 && (!at || this.now().getTime() - Date.parse(at) >= overnightRetry);
      if (!edition.researchedAt && canRetry(edition.researchAttempts, edition.lastResearchAttempt)) return this.queueResearch(edition);
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
      if (edition.render?.revision !== revision) throw deskError(404, "Sports preview not found.");
      const directory = this.renderDirectoryFor(edition);
      if (segment === undefined) return path.join(directory, "episode.mp4");
      const short = (edition.render.shorts || []).find((short) => short.segment === segment);
      if (!short) throw deskError(404, "Short not found.");
      return path.join(directory, short.file);
    });
  }
}
