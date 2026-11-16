import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../config.mjs";
import { LEAGUES, safeImageUrl } from "./espn/client.mjs";

// Cached ESPN logos and headshots. The files stay off the episode until a
// rights grant covers the still. planShots never sees these records.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const MIN_BYTES = 32;
const MIN_EDGE = 16;
const MISS_TTL_MS = 12 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

const digest = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function logoUrl(leagueKey, team) {
  const folder = LEAGUES[leagueKey]?.logo;
  if (!folder || !team) return null;
  // College marks are keyed by the numeric team id. NBA and MLB use the abbreviation.
  const token = folder === "ncaa" ? String(team.id || "") : String(team.short || "").toLowerCase();
  if (!/^[a-z0-9]{1,12}$/iu.test(token) || token.toLowerCase() === "tbd") return null;
  return `https://a.espncdn.com/i/teamlogos/${folder}/500/${token}.png`;
}

export function pngSize(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < MIN_BYTES || !buffer.subarray(0, 8).equals(PNG)) return null;
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") return null;
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (width < MIN_EDGE || height < MIN_EDGE || width > 4096 || height > 4096) return null;
  return { width, height };
}

export class AssetCache {
  constructor({
    root = path.join(dataDir, "sports", "assets"),
    fetchImpl = fetch,
    now = () => new Date(),
    capBytes = (Number(process.env.SPORTS_ASSET_CACHE_MB) || 500) * 1024 * 1024,
    gapMs = 200,
    timeoutMs = 15_000,
    retries = 3,
    backoffMs = 250,
    userAgent = process.env.SPORTS_ESPN_USER_AGENT || "ISNN-Overtime-Desk",
    log = (line) => console.log(JSON.stringify(line)),
  } = {}) {
    this.root = root;
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.capBytes = capBytes;
    this.gapMs = gapMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.backoffMs = backoffMs;
    this.userAgent = userAgent;
    this.log = log;
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
  }

  location(leagueKey, kind, entityId) {
    const league = LEAGUES[leagueKey];
    const id = String(entityId || "").replace(/[^a-z0-9_-]/giu, "");
    if (!league || !id || (kind !== "team" && kind !== "player")) return null;
    const folder = kind === "player" ? "players" : "teams";
    return {
      leagueKey,
      kind,
      entityId: id,
      relative: path.join(leagueKey, folder, `${id}.png`),
      sidecar: path.join(this.root, leagueKey, folder, `${id}.json`),
      image: path.join(this.root, leagueKey, folder, `${id}.png`),
    };
  }

  // Logos for both clubs, plus the one basketball leader the story actually pitches.
  async cacheGame(game) {
    const saved = [];
    for (const team of [game?.home, game?.away]) {
      const url = logoUrl(game?.leagueKey, team);
      if (!url || !team?.id) continue;
      saved.push(await this.store({ url, leagueKey: game.leagueKey, kind: "team", entityId: team.id }));
    }
    if (game?.sport === "basketball") {
      const leader = (game.leaders || []).find((item) => Number.isFinite(item.stats?.points) && item.playerId && item.headshot);
      if (leader) saved.push(await this.store({ url: leader.headshot, leagueKey: game.leagueKey, kind: "player", entityId: leader.playerId }));
    }
    return saved;
  }

  store(request) {
    const run = this.queue.then(() => this.write(request));
    this.queue = run.catch(() => {});
    return run;
  }

  async write({ url, leagueKey, kind, entityId }) {
    const allowed = safeImageUrl(url);
    const place = this.location(leagueKey, kind, entityId);
    if (!allowed || !place) return { miss: true, reason: "refused", url: url || null };
    const saved = await this.readSidecar(place.sidecar);
    if (saved?.url === allowed && saved.sha256) return saved;
    const missed = await this.readMiss(allowed);
    if (missed) return missed;
    const fetched = await this.fetchBytes(allowed);
    if (fetched.miss) return this.recordMiss(allowed, fetched.miss);
    const size = pngSize(fetched.bytes);
    if (!size) return this.recordMiss(allowed, "not a usable png");
    const sha256 = digest(fetched.bytes);
    const prior = (await this.records()).find((record) => record.sha256 === sha256 && record.file);
    const file = prior?.file || place.relative;
    if (!prior) {
      await mkdir(path.dirname(place.image), { recursive: true });
      const temporary = `${place.image}.tmp`;
      await writeFile(temporary, fetched.bytes);
      await rename(temporary, place.image);
    }
    const record = {
      url: allowed,
      sha256,
      bytes: fetched.bytes.length,
      width: size.width,
      height: size.height,
      retrieved: this.now().toISOString(),
      league: leagueKey,
      entityId: place.entityId,
      kind,
      licenseStatus: "unlicensed",
      grantId: null,
      file,
      ...(prior && { shared: true }),
    };
    await mkdir(path.dirname(place.sidecar), { recursive: true });
    const temporary = `${place.sidecar}.tmp`;
    await writeFile(temporary, JSON.stringify(record));
    await rename(temporary, place.sidecar);
    this.log({ asset: { league: leagueKey, kind, entityId: place.entityId, sha256, shared: Boolean(prior), licenseStatus: "unlicensed" } });
    return record;
  }

  async fetchBytes(url) {
    let last = "unreachable";
    for (let attempt = 1; attempt <= this.retries; attempt += 1) {
      const wait = Math.max(0, this.lastRequestAt + this.gapMs - Date.now());
      if (wait) await sleep(wait);
      this.lastRequestAt = Date.now();
      try {
        const response = await this.fetchImpl(url, {
          headers: { "User-Agent": this.userAgent, Accept: "image/png" },
          redirect: "manual",
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (response.status >= 300 && response.status < 400) return { miss: "redirect" };
        if (response.status === 404) return { miss: "404" };
        if (response.status === 429 || response.status >= 500) {
          last = `HTTP ${response.status}`;
          await sleep(this.backoffMs * 2 ** (attempt - 1));
          continue;
        }
        if (!response.ok) return { miss: `HTTP ${response.status}` };
        const type = response.headers.get("content-type") || "";
        if (type && !/image\/png|application\/octet-stream/iu.test(type)) return { miss: "type" };
        return { bytes: Buffer.from(await response.arrayBuffer()) };
      } catch (error) {
        last = error.message || "unreachable";
        await sleep(this.backoffMs * 2 ** (attempt - 1));
      }
    }
    return { miss: last };
  }

  missPath(url) {
    return path.join(this.root, "misses", `${digest(url)}.json`);
  }

  async readMiss(url) {
    try {
      const record = JSON.parse(await readFile(this.missPath(url), "utf8"));
      if (record.url !== url || this.now().getTime() - Date.parse(record.retrieved) > MISS_TTL_MS) return null;
      return { miss: true, reason: record.reason, url };
    } catch {
      return null;
    }
  }

  async recordMiss(url, reason) {
    const file = this.missPath(url);
    await mkdir(path.dirname(file), { recursive: true });
    const record = { url, reason, retrieved: this.now().toISOString() };
    await writeFile(file, JSON.stringify(record));
    this.log({ asset: { url, miss: reason } });
    return { miss: true, reason, url };
  }

  async readSidecar(file) {
    try {
      return JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
  }

  async records() {
    let names = [];
    try {
      names = await readdir(this.root, { recursive: true });
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const records = [];
    for (const name of names) {
      const relative = String(name);
      if (!relative.endsWith(".json") || relative.split(path.sep).includes("misses")) continue;
      const sidecarPath = path.join(this.root, relative);
      const record = await this.readSidecar(sidecarPath);
      if (!record?.sha256 || !record.file) continue;
      records.push({ ...record, sidecarPath });
    }
    return records;
  }

  // When the image directory is over the cap, drop unreferenced files older than 14 days.
  async cleanup({ referenced = new Set(), maxAgeMs = 14 * DAY_MS } = {}) {
    const records = await this.records();
    const files = new Map();
    for (const record of records) {
      const current = files.get(record.file) || { file: record.file, bytes: 0, records: [] };
      current.bytes = Math.max(current.bytes, Number(record.bytes) || 0);
      current.records.push(record);
      files.set(record.file, current);
    }
    let total = [...files.values()].reduce((sum, file) => sum + file.bytes, 0);
    if (total <= this.capBytes) return { deleted: 0, total };
    const doomed = [...files.values()]
      .filter((file) => file.records.every((record) => !referenced.has(record.sha256) && this.now().getTime() - Date.parse(record.retrieved) > maxAgeMs))
      .sort((a, b) => Date.parse(a.records[0].retrieved) - Date.parse(b.records[0].retrieved));
    let deleted = 0;
    for (const file of doomed) {
      if (total <= this.capBytes) break;
      await rm(path.join(this.root, file.file), { force: true });
      for (const record of file.records) await rm(record.sidecarPath, { force: true });
      total -= file.bytes;
      deleted += 1;
    }
    return { deleted, total };
  }
}
