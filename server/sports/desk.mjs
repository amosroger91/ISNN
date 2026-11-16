import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { dataDir } from "../config.mjs";
import { readJson, saveJson } from "../storage.mjs";
import { editTopics, researchConfigured, researchEdition, writeEpisode } from "./research.mjs";
import { sampleEpisode, sampleTopics } from "./sample.mjs";
import { uploadEpisode, youtubeConfigured } from "./youtube.mjs";

const maxTopics = 12;
const overnightRetry = 15 * 60_000;
const uploadRetry = 4 * 60_000;
const workerFile = fileURLToPath(new URL("./render-worker.mjs", import.meta.url));

export function deskError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function localClock(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour) };
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

export class SportsDesk {
  constructor({
    directory = path.join(dataDir, "sports"),
    timezone = process.env.SPORTS_TIMEZONE || "America/Chicago",
    publishEnabled = process.env.SPORTS_PUBLISH_ENABLED === "true",
    privacy = process.env.YOUTUBE_PRIVACY_STATUS || "public",
    now = () => new Date(),
    research = researchEdition,
    write = writeEpisode,
    chat = editTopics,
    render = isolatedRender,
    upload = uploadEpisode,
    canResearch = researchConfigured,
    canUpload = youtubeConfigured,
    rebuildDelay = 2500,
  } = {}) {
    this.directory = directory;
    this.settings = { timezone, publishEnabled, privacy, researchConfigured: canResearch(), youtubeConfigured: canUpload() };
    this.now = now;
    this.research = research;
    this.write = write;
    this.ask = chat;
    this.render = render;
    this.upload = upload;
    this.rebuildDelay = rebuildDelay;
    this.tail = Promise.resolve();
  }

  clock() {
    return localClock(this.now(), this.settings.timezone);
  }

  serialized(action) {
    const run = this.tail.then(action);
    this.tail = run.catch(() => {});
    return run;
  }

  directoryFor({ date, sample }) {
    return path.join(this.directory, sample ? "practice" : "editions", date);
  }

  async load(date) {
    const read = (sample) => readJson(path.join(this.directoryFor({ date, sample }), "edition.json")).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    const sample = !this.settings.researchConfigured;
    const edition = (await read(false)) || (sample && await read(true)) || createEdition(date, sample);
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

  async produce(snapshot) {
    this.work.progress = { percent: 2, message: "Writing the broadcast script…" };
    const { topicSources = [], ...draft } = snapshot.sample ? sampleEpisode(snapshot) : await this.write(snapshot);
    const episode = { ...draft, date: snapshot.date };
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
        title: episode.title, duration: metadata.duration,
        episode: { ...episode, chapters: metadata.chapters, duration: metadata.duration }, revision: snapshot.revision,
        createdAt: this.now().toISOString(), url: base, qc: metadata.qc || null,
        shorts: (metadata.shorts || []).map((short) => ({ ...short, url: `${base}/short/${short.segment}` })),
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
    if (before !== JSON.stringify(edition.topics)) {
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
      const before = JSON.stringify(edition.topics);
      if (topicId) {
        const topic = edition.topics.find(({ id }) => id === topicId);
        if (!topic) throw deskError(404, "Topic not found.");
        Object.assign(topic, changes);
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
      const before = JSON.stringify(edition.topics);
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
