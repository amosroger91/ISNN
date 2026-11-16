import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../config.mjs";
import { readJson, saveJson } from "../storage.mjs";
import { FixtureEvidenceAdapter, scanSlate } from "./evidence.mjs";
import { EvidenceLedger, LedgerError, fingerprint, numbersIn } from "./ledger.mjs";
import { editTopics, researchConfigured, researchEdition, writeEpisode } from "./research.mjs";
import { planShots } from "./rights.mjs";
import { sampleEpisode, sampleTopics } from "./sample.mjs";
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
  };
}

function publicView(edition, settings, progress) {
  const { sessionUrl, ...publication } = edition.publication;
  const { episode, ...render } = edition.render || {};
  return { edition: { ...edition, render: edition.render ? render : null, publication, locked: publicationLocked(edition), progress }, settings };
}

const publicationLocked = ({ publication }) => Boolean(publication.sessionUrl || ["uploading", "published", "uncertain"].includes(publication.status));

function message(role, content, at) {
  return { id: randomUUID(), role, content, at };
}

function newTopic({ title, summary = "", take = "", selected = true, url, excerpt = "" }) {
  return {
    id: randomUUID(), title, summary, take, selected,
    sources: url ? [{ title: "Source supplied by Isaac", publisher: new URL(url).hostname, url, excerpt }] : [],
  };
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
    chat = editTopics,
    render = isolatedRender,
    upload = uploadEpisode,
    canResearch = researchConfigured,
    canUpload = youtubeConfigured,
    evidence = new FixtureEvidenceAdapter(),
    trend = [new GoogleTrendingNowAdapter()],
    catalog = null,
    rebuildDelay = 2500,
  } = {}) {
    this.directory = directory;
    this.settings = {
      timezone, publishEnabled, privacy, channel, territory, researchConfigured: canResearch(), youtubeConfigured: canUpload(),
      evidenceProvider: evidence?.name || null, trendProviders: trend.map((adapter) => adapter.name),
    };
    this.now = now;
    this.research = research;
    this.write = write;
    this.ask = chat;
    this.render = render;
    this.upload = upload;
    this.evidence = evidence;
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
    const sample = !this.settings.researchConfigured;
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
      console.error(`[sports ${task} ${work.date}] ${error.message}`);
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

  async produce(snapshot) {
    this.work.progress = { percent: 2, message: "Writing the broadcast script…" };
    const { topicSources = [], ...draft } = snapshot.sample ? sampleEpisode(snapshot) : await this.write(snapshot);
    const selected = snapshot.topics.filter((topic) => topic.selected);
    const episode = {
      ...draft, date: snapshot.date, airAt: this.airTimeFor(snapshot.date), channel: this.settings.channel, territory: this.settings.territory,
      segments: draft.segments.map((segment, index) => {
        const topic = snapshot.topics.find((candidate) => candidate.id === segment.topicId) || selected[index];
        return { ...segment, topicId: topic?.id || null, eventId: segment.eventId ?? topic?.eventId ?? null, id: segment.id || topic?.eventId || undefined };
      }),
    };
    const trend = trendSegment(this.trendAngles(snapshot));
    if (trend) episode.segments.push(trend);
    this.work.progress = { percent: 4, message: "Checking every number against the evidence ledger…" };
    const { revision } = await this.bindEvidence(snapshot, episode);
    const catalog = await this.catalogFor(snapshot);
    episode.rights = { channel: this.settings.channel, territory: this.settings.territory, airAt: episode.airAt, catalog };
    episode.segments = episode.segments.map((segment) => ({
      ...segment, claimIds: segment.claims.map(({ id }) => id),
      shots: segment.eventId ? planShots(segment, { catalog, channel: this.settings.channel, territory: this.settings.territory, airAt: episode.airAt, revision: snapshot.revision }) : null,
    }));
    const directory = path.join(this.directoryFor(snapshot), String(snapshot.revision));
    await mkdir(directory, { recursive: true });
    const metadata = await this.render(episode, directory, (progress) => { this.work.progress = progress; });
    await access(path.join(directory, "episode.mp4"));
    await this.serialized(async () => {
      const current = await this.load(snapshot.date);
      if (snapshot.revision !== current.revision) {
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
      current.render = {
        title: episode.title, duration: metadata.duration, revisionId: revision.id,
        episode: { ...episode, chapters: metadata.chapters, duration: metadata.duration }, revision: snapshot.revision,
        createdAt: this.now().toISOString(), url: base, qc: metadata.qc || null, shots: metadata.shots || null,
        shorts: (metadata.shorts || []).map((short) => ({ ...short, url: `${base}/short/${short.segment}` })),
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
    if (!edition.sample && !this.settings.researchConfigured) throw deskError(409, "Set a sports research model to write the script.");
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
        if (edition.sample || !this.settings.researchConfigured || !edition.topics.some(({ selected }) => selected)) return;
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

  changeTopic(topicId, changes, expectedDate) {
    return this.serialized(async () => {
      const edition = await this.readCurrent(expectedDate);
      this.ensureEditable(edition);
      const before = topicsDigest(edition.topics);
      if (topicId) {
        const topic = edition.topics.find(({ id }) => id === topicId);
        if (!topic) throw deskError(404, "Topic not found.");
        const { headline, narration, ...rest } = changes;
        if (headline !== undefined || narration !== undefined) {
          if (!topic.script) throw deskError(409, "Only a story scanned from evidence carries an editable script.");
          topic.script = { ...topic.script, ...(headline !== undefined && { headline }), ...(narration !== undefined && { narration }) };
        }
        Object.assign(topic, rest);
      } else {
        if (edition.topics.length >= maxTopics) throw deskError(409, `An edition can hold ${maxTopics} topics.`);
        edition.topics.push(newTopic(changes));
      }
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
    return this.serialized(async () => {
      const edition = await this.readCurrent(snapshot.date);
      this.ensureEditable(edition);
      if (snapshot.revision !== edition.revision || snapshot.messages.at(-1)?.id !== edition.messages.at(-1)?.id) {
        throw deskError(409, "The rundown changed while the editor was replying. Send the message again.");
      }
      const before = topicsDigest(edition.topics);
      for (const { id, url, ...changes } of edits) {
        if (id) {
          const topic = edition.topics.find((topic) => topic.id === id);
          if (!topic) throw deskError(409, "The editor returned a topic that is no longer in the rundown.");
          Object.assign(topic, changes);
        } else {
          if (edition.topics.length >= maxTopics) throw deskError(409, `An edition can hold ${maxTopics} topics.`);
          edition.topics.push(newTopic({ ...changes, url }));
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
      this.ensureEditable(edition);
      if (!this.evidence) throw deskError(409, "No evidence adapter is configured.");
      const ledger = await this.ledgerFor(edition);
      const at = asOf || this.now().toISOString();
      const known = new Set(edition.corrections.map(({ id }) => id));
      const results = await scanSlate(ledger, this.evidence, { date: edition.date, asOf: at, retrievedAt: this.now().toISOString() });
      await ledger.save();
      const before = topicsDigest(edition.topics);
      edition.slate = results.map((result) => ({
        gameId: result.gameId, league: result.league, sport: result.sport, title: result.title, status: result.status, coverage: result.coverage, reason: result.reason,
        claims: result.claims.length, supported: result.claims.filter(({ disposition }) => disposition === "supported").length, independentOrigins: result.independentOrigins, scannedAt: at,
      }));
      edition.lastScan = { at, provider: this.evidence.name, games: results.length };
      for (const result of results.filter(({ story }) => story)) {
        let topic = edition.topics.find((candidate) => candidate.eventId === result.gameId);
        if (!topic) {
          if (edition.topics.length >= maxTopics) break;
          topic = { ...newTopic({ title: result.story.headline, summary: `${result.title}, ${result.competition}.` }), selected: result.coverage === "covered", eventId: result.gameId, storyId: result.gameId };
          edition.topics.push(topic);
        }
        topic.title = result.story.headline;
        topic.script = { headline: result.story.headline, narration: result.story.narration, diagram: result.story.diagram };
        topic.claimIds = result.story.claimIds;
        topic.coverage = result.coverage;
        topic.coverageReason = result.reason;
        topic.entities = result.entities;
        topic.aliases ||= [...new Set([result.home.name, result.away.name, `${result.home.short} ${result.away.short}`])];
        topic.media = result.media;
        topic.sources = [...new Map([...topic.sources, ...result.snapshots.map((snapshot) => ({ publisher: snapshot.provider, title: snapshot.title || snapshot.type, url: snapshot.sourceUrl }))]
          .filter(({ url }) => url).map((source) => [source.url, source])).values()].slice(0, 6);
      }
      // Once the scan has produced a verified recap, the evergreen practice
      // placeholders leave the lineup so the practice cut is the show, not tips.
      if (results.some(({ coverage }) => coverage === "covered")) {
        const placeholders = new Set(sampleTopics().map(({ id }) => id));
        for (const topic of edition.topics) {
          if (!topic.eventId && (topic.practice || placeholders.has(topic.id))) topic.selected = false;
        }
      }
      for (const correction of ledger.corrections.filter(({ id }) => !known.has(id))) this.applyCorrection(edition, correction, ledger);
      return this.saveEdits(edition, before);
    });
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
    const file = path.join(this.directoryFor(edition), String(edition.revision), "episode.mp4");
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
      if (edition.sample || !this.settings.researchConfigured) return;
      const canRetry = (attempts, at) => (attempts || 0) < 3 && (!at || this.now().getTime() - Date.parse(at) >= overnightRetry);
      if (!edition.researchedAt && canRetry(edition.researchAttempts, edition.lastResearchAttempt)) return this.queueResearch(edition);
      if (edition.researchedAt && edition.topics.some(({ selected }) => selected) && edition.render?.revision !== edition.revision &&
          canRetry(edition.buildAttempts, edition.lastBuildAttempt)) return this.queueBuild(edition);
    });
  }

  videoPath(date, revision, segment) {
    return this.serialized(async () => {
      const edition = await this.load(date);
      if (edition.render?.revision !== revision) throw deskError(404, "Sports preview not found.");
      const directory = path.join(this.directoryFor(edition), String(revision));
      if (segment === undefined) return path.join(directory, "episode.mp4");
      const short = (edition.render.shorts || []).find((short) => short.segment === segment);
      if (!short) throw deskError(404, "Short not found.");
      return path.join(directory, short.file);
    });
  }
}
