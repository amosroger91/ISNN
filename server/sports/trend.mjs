// Check trend: attention signals scored against one canonical story. Attention
// measures audience interest; the evidence ledger decides what is true.
export const SCORE_VERSION = "trend/1";
export const RECOMMENDATIONS = ["standalone video pitch", "daily segment", "watch", "insufficient evidence", "signal unavailable"];
export const WEIGHTS = { surge: 40, persistence: 25, corroboration: 20, novelty: 15 };
const TRAFFIC_BASELINE = 500_000;
const FRESH_WINDOW = 6 * 60 * 60_000;
const MIN_GAP = 15 * 60_000;
const promotional = /\b(?:tickets?|presale|promo code|giveaway|sweepstakes|merch|jersey sale|discount|betting odds|sportsbook|parlay|best bets)\b/iu;
const retrospective = /\b(?:anniversary|throwback|years ago|on this day|classic game|documentary)\b/iu;

const normalize = (text) => String(text || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/gu, "").replace(/[^a-z0-9]+/gu, " ").trim();
const contains = (haystack, needle) => needle && ` ${normalize(haystack)} `.includes(` ${normalize(needle)} `);
const clamp = (value, max) => Math.max(0, Math.min(max, Math.round(value)));
const registrable = (url) => {
  try {
    const parts = new URL(url).hostname.split(".");
    return parts.slice(-2).join(".");
  } catch {
    return null;
  }
};

const entities = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…",
};
const decode = (text) => text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/giu, (original, entity) => {
  if (!entity.startsWith("#")) return entities[entity.toLowerCase()] ?? original;
  const code = entity[1].toLowerCase() === "x" ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : " ";
});
const cdata = (value) => value.trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/u, "$1");
const field = (xml, tag) => xml.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}\\s*>`, "iu"))?.[1] || "";
const text = (value) => decode(cdata(value)).replace(/<\/?[a-z][^>]*>/giu, " ").replace(/\s+/gu, " ").trim();
const traffic = (value) => {
  const digits = value.replace(/[^\d]/gu, "");
  return digits ? Number(digits) : null;
};

// Google Trending Now RSS: one item per trending query with approximate
// traffic, a publish time and the news items Google associates with it.
export function parseTrendingRss(xml, { geo = "US", retrievedAt = new Date().toISOString(), sourceUrl } = {}) {
  if (!/<rss\b/iu.test(xml) || /<!DOCTYPE\b/iu.test(xml)) throw new Error("Trending Now returned something other than an RSS 2.0 feed.");
  const observations = [];
  for (const [, item] of xml.matchAll(/<item\b[^>]*>([\s\S]*?)<\/item\s*>/giu)) {
    const query = text(field(item, "title"));
    const published = Date.parse(text(field(item, "pubDate")));
    if (!query || !Number.isFinite(published)) continue;
    const news = [...item.matchAll(/<ht:news_item\b[^>]*>([\s\S]*?)<\/ht:news_item\s*>/giu)].map(([, entry]) => ({
      title: text(field(entry, "ht:news_item_title")), url: decode(cdata(field(entry, "ht:news_item_url"))), publisher: text(field(entry, "ht:news_item_source")),
    })).filter((entry) => entry.title || entry.url);
    observations.push({
      provider: "google-trending-now", geo, query, traffic: traffic(text(field(item, "ht:approx_traffic"))), metric: "approx_traffic", unit: "searches", period: "trending now",
      observedAt: new Date(published).toISOString(), retrievedAt, sourceUrl: sourceUrl || `https://trends.google.com/trending?geo=${geo}`, news, active: true,
    });
  }
  return observations;
}

export class GoogleTrendingNowAdapter {
  constructor({ geo = "US", fetchImpl = fetch, url } = {}) {
    this.name = "google-trending-now";
    this.geo = geo;
    this.url = url || `https://trends.google.com/trending/rss?geo=${geo}`;
    this.fetchImpl = fetchImpl;
  }

  async observe({ now = new Date(), signal } = {}) {
    const response = await this.fetchImpl(this.url, { headers: { Accept: "application/rss+xml, application/xml, text/xml" }, redirect: "error", signal: signal || AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error(`Trending Now returned HTTP ${response.status}.`);
    return parseTrendingRss(await response.text(), { geo: this.geo, retrievedAt: now.toISOString(), sourceUrl: `https://trends.google.com/trending?geo=${this.geo}` });
  }
}

// Fixture adapter: canned observations, or a function that returns them (or
// throws, to simulate a feed outage).
export class FixtureTrendAdapter {
  constructor(observations = [], name = "fixture-trend") {
    this.name = name;
    this.observations = observations;
  }

  async observe({ now = new Date() } = {}) {
    const list = typeof this.observations === "function" ? await this.observations({ now }) : this.observations;
    return list.map((observation) => ({ provider: this.name, metric: "approx_traffic", unit: "searches", period: "fixture", geo: "US", retrievedAt: now.toISOString(), news: [], active: true, ...observation }));
  }
}

export async function collectObservations(adapters, { now = new Date(), signal } = {}) {
  const settled = await Promise.allSettled(adapters.map((adapter) => adapter.observe({ now, signal })));
  return {
    observations: settled.flatMap((result) => result.status === "fulfilled" ? result.value : []),
    failures: settled.map((result, index) => result.status === "rejected" ? { provider: adapters[index].name, error: result.reason?.message || String(result.reason) } : null).filter(Boolean),
  };
}

// Maps one observation to the story: the query must match an alias, and the
// observation's coverage must connect to the same dated story through a
// second entity. A matching name alone is a same-name collision.
export function matchObservation(observation, story) {
  const aliases = [...new Set([...(story.aliases || []), ...(story.entities || [])])].filter(Boolean);
  const matchedAlias = aliases.find((alias) => contains(observation.query, alias) || contains(alias, observation.query));
  if (!matchedAlias) return { matched: false, kind: "none", reason: "The query matches none of the story's aliases." };
  const corpus = [observation.query, ...(observation.news || []).flatMap((item) => [item.title, item.publisher])].join(" · ");
  const others = (story.entities || []).filter((entity) => normalize(entity) !== normalize(matchedAlias) && !contains(matchedAlias, entity) && !contains(entity, matchedAlias));
  const linked = others.filter((entity) => contains(corpus, entity));
  const sourceLink = (observation.news || []).some((item) => (story.sourceUrls || []).includes(item.url));
  const keywordLink = (story.keywords || []).some((keyword) => contains(corpus, keyword));
  if (!linked.length && !sourceLink && !keywordLink) {
    return { matched: false, kind: "collision", alias: matchedAlias, reason: `“${observation.query}” matches ${matchedAlias} but its coverage does not connect to the dated story.` };
  }
  return { matched: true, kind: "linked", alias: matchedAlias, linked: linked.length ? linked : sourceLink ? ["source link"] : ["keyword"] };
}

export function classifyObservation(observation, story, { lockAt, seen }) {
  const corpusText = [observation.query, ...(observation.news || []).map((item) => item.title)].join(" ");
  if (promotional.test(corpusText)) return { qualifies: false, reason: "promotion" };
  if (retrospective.test(corpusText)) return { qualifies: false, reason: "stale term" };
  const at = Date.parse(observation.observedAt);
  if (!Number.isFinite(at)) return { qualifies: false, reason: "no observation time" };
  if (at > Date.parse(lockAt) + 5 * 60_000) return { qualifies: false, reason: "after lock" };
  const related = (story.aliases || []).concat(story.entities || []).some((alias) => contains(observation.query, alias) || contains(alias, observation.query));
  if (at < Date.parse(lockAt) - 48 * 60 * 60_000 || (story.date && at < Date.parse(`${story.date}T00:00:00Z`) - 36 * 60 * 60_000)) {
    return { qualifies: false, reason: related ? "stale" : "unrelated" };
  }
  const match = matchObservation(observation, story);
  if (!match.matched) return { qualifies: false, reason: match.kind === "collision" ? "same-name collision" : "unrelated", detail: match.reason };
  const urls = (observation.news || []).map((item) => item.url).filter(Boolean);
  const repost = urls.length > 0 && urls.every((url) => seen.urls.has(url)) && (observation.traffic ?? 0) <= seen.traffic;
  for (const url of urls) seen.urls.add(url);
  seen.traffic = Math.max(seen.traffic, observation.traffic ?? 0);
  if (repost) return { qualifies: false, reason: "repost spike", match };
  return { qualifies: true, match };
}

// The pilot scorecard: surge 0–40, persistence 0–25, independent attention
// corroboration 0–20, editorial novelty 0–15, with each filter recorded.
export function scoreTrend({ story, observations = [], failures = [], now = new Date(), lockAt = now, coveredAngles = [] }) {
  const lock = new Date(lockAt).toISOString();
  const card = {
    scoreVersion: SCORE_VERSION, storyId: story.id || null, matchedStoryId: null, query: null, aliases: story.aliases || [], verified: Boolean(story.verified),
    providers: [...new Set(observations.map(({ provider }) => provider))], geo: observations[0]?.geo || "US", period: observations[0]?.period || null, metric: "approx_traffic", unit: "searches",
    observedAt: null, retrievedAt: observations.map(({ retrievedAt }) => retrievedAt).sort().at(-1) || now.toISOString(), sourceUrl: null, lockAt: lock,
    components: { surge: 0, persistence: 0, corroboration: 0, novelty: 0 }, score: 0, recommendation: "insufficient evidence", airable: false,
    explanation: [], missing: [], filtered: [], comparison: { observations: observations.length, qualifying: 0, windowMax: null, independentSources: 0 }, failures, checkedAt: now.toISOString(),
  };
  const finish = (recommendation, note) => {
    card.recommendation = recommendation;
    if (note) card.explanation.push(note);
    card.score = Object.values(card.components).reduce((sum, value) => sum + value, 0);
    card.airable = ["daily segment", "standalone video pitch"].includes(recommendation) && card.matchedStoryId !== null && card.matchedStoryId === card.storyId && card.verified;
    return card;
  };
  if (!observations.length && failures.length) return finish("signal unavailable", `No attention signal: ${failures.map(({ provider, error }) => `${provider} (${error})`).join(", ")}.`);
  if (failures.length) card.missing.push(...failures.map(({ provider }) => `${provider} unavailable`));
  if (!story.id) return finish("insufficient evidence", "Lock a canonical story ID before checking the trend.");

  const seen = { urls: new Set(), traffic: 0 };
  const qualifying = [];
  for (const observation of [...observations].sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt))) {
    const verdict = classifyObservation(observation, story, { lockAt: lock, seen });
    if (verdict.qualifies) qualifying.push({ observation, match: verdict.match });
    else if (verdict.reason !== "unrelated") card.filtered.push({ query: observation.query, observedAt: observation.observedAt, reason: verdict.reason, detail: verdict.detail || null });
  }
  card.comparison.qualifying = qualifying.length;
  if (!story.verified) {
    const note = qualifying.length ? "The story has no verified claim in the ledger; attention cannot clear it to air." : "The story is unverified and no qualifying attention was found.";
    return finish("insufficient evidence", note);
  }
  if (!qualifying.length) {
    const reasons = [...new Set(card.filtered.map(({ reason }) => reason))];
    return finish("watch", reasons.length ? `No qualifying trend. Filtered: ${reasons.join(", ")}.` : "No qualifying trend for this story in the current window.");
  }

  const latest = qualifying.at(-1);
  const peak = qualifying.reduce((best, item) => (item.observation.traffic ?? -1) > (best.observation.traffic ?? -1) ? item : best, qualifying[0]);
  card.matchedStoryId = story.id;
  card.query = peak.observation.query;
  card.observedAt = latest.observation.observedAt;
  card.sourceUrl = peak.observation.sourceUrl || null;
  const windowMax = Math.max(TRAFFIC_BASELINE, ...observations.map(({ traffic: value }) => value ?? 0));
  card.comparison.windowMax = windowMax;
  if (peak.observation.traffic === null || peak.observation.traffic === undefined) card.missing.push("traffic estimate");
  else card.components.surge = clamp(WEIGHTS.surge * Math.sqrt(peak.observation.traffic / windowMax), WEIGHTS.surge);

  const times = qualifying.map(({ observation }) => Date.parse(observation.observedAt));
  const span = Math.max(...times) - Math.min(...times);
  const fresh = Date.parse(lock) - Math.max(...times) <= FRESH_WINDOW;
  if (qualifying.length >= 3 && span >= 2 * 60 * 60_000) card.components.persistence = 25;
  else if (qualifying.length >= 2 && span >= 60 * 60_000) card.components.persistence = 20;
  else if (qualifying.length >= 2 && span >= MIN_GAP) card.components.persistence = 15;
  else card.components.persistence = 5;
  if (!fresh) {
    card.components.persistence = Math.min(card.components.persistence, 5);
    card.missing.push("fresh observation within six hours of lock");
  }
  if (qualifying.length < 2) card.missing.push("second observation at least 15 minutes later");

  const providers = new Set(qualifying.map(({ observation }) => observation.provider));
  const publishers = new Set(qualifying.flatMap(({ observation }) => (observation.news || []).map((item) => registrable(item.url) || normalize(item.publisher)).filter(Boolean)));
  const independent = providers.size + publishers.size;
  card.comparison.independentSources = independent;
  card.components.corroboration = clamp(8 * providers.size + 4 * publishers.size, WEIGHTS.corroboration);

  const covered = coveredAngles.some((angle) => contains(angle, story.id) || (story.angle && contains(angle, story.angle)));
  card.components.novelty = covered ? (story.newEvidence ? 7 : 0) : 15;
  if (covered && !story.newEvidence) {
    card.filtered.push({ query: card.query, reason: "previously covered without new evidence" });
    return finish("watch", "This angle already aired and brings no new evidence.");
  }

  card.explanation.push(`${peak.observation.query}: peak ${peak.observation.traffic ?? "unknown"} ${card.unit} via ${peak.observation.provider}, ${qualifying.length} qualifying observation${qualifying.length === 1 ? "" : "s"} over ${Math.round(span / 60_000)} minutes, ${independent} independent attention source${independent === 1 ? "" : "s"}.`);
  card.explanation.push(`Connected through ${peak.match.linked.join(", ")}; ${card.filtered.length} observation${card.filtered.length === 1 ? "" : "s"} filtered.`);
  const total = Object.values(card.components).reduce((sum, value) => sum + value, 0);
  const inScope = ["core", "secondary"].includes(story.scope || "core");
  if (total >= 85 && fresh && independent >= 2 && (story.visualEvidence || story.originalAnalysis)) {
    return finish("standalone video pitch", inScope ? "Also eligible for the trend segment." : "Out of this episode's scope; Isaac decides whether to develop it.");
  }
  if (total >= 70 && fresh && card.components.persistence >= 15) {
    if (!inScope) return finish("watch", "Qualified attention, but the pitch is outside this episode's locked core story.");
    return finish("daily segment", `Fresh, persistent signal on the locked story (${total}).`);
  }
  return finish("watch", total >= 70 ? "Score qualifies but the signal is not fresh or persistent enough." : `Score ${total} is below the daily-segment threshold.`);
}

// The trend segment: one or two cleared angles on the locked core story, with
// the attention numbers themselves bound to the trend snapshot as claims.
export function trendSegment(angles) {
  const cleared = angles.filter((angle) => angle.card?.airable).slice(0, 2);
  if (!cleared.length) return null;
  const lines = cleared.map(({ card, topic }) => `Searches for ${card.query} rose to about ${peakTraffic(card)} on ${card.providers[0] || "the attention feed"}, connected to ${topic.title}.`);
  return {
    kind: "trend", headline: `Trending: ${cleared.map(({ card }) => card.query).join(" and ")}`,
    narration: `${lines.join(" ")} ${cleared.length === 1 ? "That is the angle the desk is watching this morning." : "Both angles trace back to the same verified story."}`,
    sources: cleared.map(({ card }) => ({ publisher: card.providers[0] || "attention feed", title: `Trending: ${card.query}`, url: card.sourceUrl })).filter((source) => source.url),
    trend: cleared.map(({ card }) => card), topicIds: cleared.map(({ topic }) => topic.id),
  };
}

const peakTraffic = (card) => {
  const match = /peak (\d+)/u.exec(card.explanation[0] || "");
  return match ? `${match[1]} ${card.unit}` : "an unmeasured volume";
};
