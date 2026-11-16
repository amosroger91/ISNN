import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { dataDir } from "../../config.mjs";

// One shared client for ESPN's public site API. Opt-in (SPORTS_EVIDENCE=espn),
// read-only, one request at a time with a short gap, retries with backoff on
// 429, 5xx and network errors, a GET cache under DATA_DIR/sports/cache/espn,
// a descriptive User-Agent, and a hard refusal of the authenticated watch host.
export const ESPN_BASE = "https://site.api.espn.com/apis/site/v2/sports";
export const BLOCKED_HOSTS = new Set(["watch.auth.api.espn.com"]);
export const LEAGUES = {
  nba: { path: "basketball/nba", sport: "basketball", league: "NBA", logo: "nba", competition: "NBA" },
  ncaab: { path: "basketball/mens-college-basketball", sport: "basketball", league: "NCAAB", logo: "ncaa", competition: "men's college basketball" },
  ncaaw: { path: "basketball/womens-college-basketball", sport: "basketball", league: "NCAAW", logo: "ncaa", competition: "women's college basketball" },
  ncaaf: { path: "football/college-football", sport: "football", league: "NCAAF", logo: "ncaa", competition: "college football" },
  mlb: { path: "baseball/mlb", sport: "baseball", league: "MLB", logo: "mlb", competition: "MLB" },
  nfl: { path: "football/nfl", sport: "football", league: "NFL", logo: "nfl", competition: "NFL", off: true },
  nhl: { path: "hockey/nhl", sport: "hockey", league: "NHL", logo: "nhl", competition: "NHL", off: true },
  wnba: { path: "basketball/wnba", sport: "basketball", league: "WNBA", logo: "wnba", competition: "WNBA", off: true },
  epl: { path: "soccer/eng.1", sport: "soccer", league: "Premier League", logo: "soccer", competition: "Premier League", off: true },
};
export const DEFAULT_ESPN_LEAGUES = ["nba", "ncaab", "ncaaf", "ncaaw", "mlb"];
const TTL = { final: 12 * 60 * 60_000, live: 2 * 60_000, reference: 12 * 60 * 60_000 };
const ODDS_KEYS = new Set(["odds", "pickcenter", "againstTheSpread"]);
const PLAYBACK_HOSTS = new Set(["watch.auth.api.espn.com"]);

// Site v2 standings answers 404. The working document is apis/v2. Tests pin the
// 404 path so a retry storm cannot hide behind an optional miss.
export function standingsUrl(leagueKey, kind = "v2") {
  const league = LEAGUES[leagueKey];
  if (!league) throw new Error(`Unknown ESPN league ${leagueKey}.`);
  const [sport, slug] = league.path.split("/");
  const base = kind === "site" ? "https://site.api.espn.com/apis/site/v2/sports" : "https://site.api.espn.com/apis/v2/sports";
  return `${base}/${sport}/${slug}/standings`;
}

// Logos and headshots are cached from this host only. Anything else, including
// the authenticated watch host, is refused before a request is made.
export function safeImageUrl(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) return null;
  try {
    const url = new URL(value);
    if (url.hostname !== "a.espncdn.com" || BLOCKED_HOSTS.has(url.hostname)) return null;
    if (!url.pathname.toLowerCase().endsWith(".png")) return null;
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

const playbackUrl = (value) => {
  if (typeof value !== "string" || !value.startsWith("http")) return false;
  try {
    return PLAYBACK_HOSTS.has(new URL(value).hostname);
  } catch {
    return false;
  }
};

// Betting fields and authenticated playback links never reach the cache or the ledger.
export function scrubBody(body) {
  if (Array.isArray(body)) return body.map(scrubBody);
  if (!body || typeof body !== "object") return body;
  const out = {};
  for (const [key, value] of Object.entries(body)) {
    if (ODDS_KEYS.has(key) || key === "progressiveDownload" || playbackUrl(value)) continue;
    out[key] = scrubBody(value);
  }
  return out;
}

export function espnLeagues(env = process.env) {
  const configured = (env.SPORTS_ESPN_LEAGUES || "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean);
  const keys = configured.length ? configured : DEFAULT_ESPN_LEAGUES;
  const unknown = keys.filter((key) => !LEAGUES[key]);
  if (unknown.length) throw new Error(`SPORTS_ESPN_LEAGUES names unknown leagues: ${unknown.join(", ")}. Known: ${Object.keys(LEAGUES).join(", ")}.`);
  return keys;
}

// Betting fields never reach the cache, the ledger, the script or the plate.
export function stripOdds(body) {
  return scrubBody(body);
}

const digest = (value) => createHash("sha256").update(value).digest("hex");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const yyyymmdd = (date) => date.replaceAll("-", "");

export class EspnClient {
  constructor({
    fetchImpl = fetch, cacheDir = path.join(dataDir, "sports", "cache", "espn"), userAgent = process.env.SPORTS_ESPN_USER_AGENT || "ISNN-Overtime-Desk",
    now = () => new Date(), gapMs = 200, timeoutMs = 15_000, retries = 3, backoffMs = 250, log = (line) => console.log(JSON.stringify(line)), fixtures = null,
  } = {}) {
    this.fetchImpl = fetchImpl;
    this.cacheDir = cacheDir;
    this.userAgent = userAgent;
    this.now = now;
    this.gapMs = gapMs;
    this.timeoutMs = timeoutMs;
    this.retries = retries;
    this.backoffMs = backoffMs;
    this.log = log;
    // Fixture mode: a map or function from URL to body; fetch is never called.
    this.fixtures = fixtures;
    this.queue = Promise.resolve();
    this.lastRequestAt = 0;
  }

  cacheFile(url) {
    return path.join(this.cacheDir, `${digest(url)}.json`);
  }

  async readCache(url, ttlMs) {
    try {
      const entry = JSON.parse(await readFile(this.cacheFile(url), "utf8"));
      if (entry.url !== url || this.now().getTime() - Date.parse(entry.storedAt) > ttlMs) return null;
      return entry;
    } catch {
      return null;
    }
  }

  async writeCache(url, status, body) {
    await mkdir(this.cacheDir, { recursive: true });
    const file = this.cacheFile(url);
    await writeFile(`${file}.tmp`, JSON.stringify({ url, storedAt: this.now().toISOString(), status, body }));
    await rename(`${file}.tmp`, file);
  }

  // Serialized GET with cache, retries and a structured log line per request.
  get(url, { ttlMs = TTL.reference, optional = false, strip = false } = {}) {
    const host = new URL(url).hostname;
    if (BLOCKED_HOSTS.has(host)) return Promise.reject(new Error(`Refusing to request the authenticated host ${host}.`));
    const run = this.queue.then(() => this.request(url, { ttlMs, optional, strip }));
    this.queue = run.catch(() => {});
    return run;
  }

  async request(url, { ttlMs, optional, strip }) {
    const started = Date.now();
    const pathname = new URL(url).pathname + new URL(url).search;
    if (this.fixtures) {
      const found = typeof this.fixtures === "function" ? await this.fixtures(url) : this.fixtures.get?.(url) ?? this.fixtures[url];
      const status = found === undefined ? 404 : 200;
      this.log({ espn: { path: pathname, status, ms: 0, cache: "fixture" } });
      if (status === 404 && !optional) throw new Error(`No ESPN fixture for ${pathname}.`);
      return { status, body: found === undefined ? null : scrubBody(found), cached: false, url };
    }
    const cached = await this.readCache(url, ttlMs);
    if (cached) {
      this.log({ espn: { path: pathname, status: cached.status, ms: 0, cache: "hit" } });
      return { status: cached.status, body: cached.body, cached: true, url };
    }
    let attempt = 0;
    let lastError;
    while (attempt < this.retries) {
      attempt++;
      const wait = Math.max(0, this.lastRequestAt + this.gapMs - Date.now());
      if (wait) await sleep(wait);
      this.lastRequestAt = Date.now();
      let response;
      try {
        response = await this.fetchImpl(url, { headers: { "User-Agent": this.userAgent, Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(this.timeoutMs) });
      } catch (error) {
        lastError = error;
        this.log({ espn: { path: pathname, status: 0, ms: Date.now() - started, cache: "miss", error: error.message, attempt } });
        await sleep(this.backoffMs * 2 ** (attempt - 1));
        continue;
      }
      const status = response.status;
      if (status === 404 && optional) {
        this.log({ espn: { path: pathname, status, ms: Date.now() - started, cache: "miss" } });
        await this.writeCache(url, status, null);
        return { status, body: null, cached: false, url };
      }
      if (status === 429 || status >= 500) {
        lastError = new Error(`ESPN returned HTTP ${status}.`);
        this.log({ espn: { path: pathname, status, ms: Date.now() - started, cache: "miss", attempt } });
        await sleep(this.backoffMs * 2 ** (attempt - 1));
        continue;
      }
      if (!response.ok) throw new Error(`ESPN returned HTTP ${status} for ${pathname}.`);
      let body;
      try {
        body = await response.json();
      } catch (error) {
        throw new Error(`ESPN returned a body that is not JSON for ${pathname}.`, { cause: error });
      }
      body = scrubBody(body);
      this.log({ espn: { path: pathname, status, ms: Date.now() - started, cache: "miss" } });
      await this.writeCache(url, status, body);
      return { status, body, cached: false, url };
    }
    throw new Error(`ESPN did not answer ${pathname} after ${this.retries} tries: ${lastError?.message || "unknown error"}.`);
  }

  // A scoreboard for one ESPN calendar date. Finished days cache for the
  // rest of the edition; a day with live games expires after two minutes.
  async scoreboard(leagueKey, date, { limit } = {}) {
    const league = LEAGUES[leagueKey];
    if (!league) throw new Error(`Unknown ESPN league ${leagueKey}.`);
    const url = `${ESPN_BASE}/${league.path}/scoreboard?dates=${yyyymmdd(date)}${limit ? `&limit=${limit}` : ""}`;
    const probe = await this.readCache(url, TTL.live);
    if (probe) return probe.body;
    const stale = await this.readCache(url, TTL.final);
    if (stale && isSettled(stale.body)) return stale.body;
    const { body } = await this.get(url, { ttlMs: 0 });
    return body;
  }

  async summary(leagueKey, eventId) {
    const league = LEAGUES[leagueKey];
    const url = `${ESPN_BASE}/${league.path}/summary?event=${eventId}`;
    const probe = await this.readCache(url, TTL.live);
    if (probe) return probe.body;
    const stale = await this.readCache(url, TTL.final);
    if (stale && stale.body?.header?.competitions?.[0]?.status?.type?.state === "post") return stale.body;
    const { body } = await this.get(url, { ttlMs: 0, strip: true });
    return body;
  }

  async team(leagueKey, teamId) {
    const { body } = await this.get(`${ESPN_BASE}/${LEAGUES[leagueKey].path}/teams/${teamId}`, { ttlMs: TTL.reference, optional: true });
    return body;
  }

  async athlete(leagueKey, athleteId) {
    const league = LEAGUES[leagueKey];
    const { body } = await this.get(`https://site.web.api.espn.com/apis/common/v3/sports/${league.path}/athletes/${athleteId}`, { ttlMs: TTL.reference, optional: true });
    return body;
  }
}

const isSettled = (board) => Array.isArray(board?.events) && board.events.every((event) => event.competitions?.[0]?.status?.type?.state === "post");
