import assert from "node:assert/strict";
import test from "node:test";
import { loadTrendFixture } from "../server/sports/fixtures.mjs";
import { EvidenceLedger, LedgerError } from "../server/sports/ledger.mjs";
import { FixtureTrendAdapter, GoogleTrendingNowAdapter, collectObservations, parseTrendingRss, scoreTrend, trendSegment } from "../server/sports/trend.mjs";

const fixture = await loadTrendFixture();
const now = new Date(fixture.now);
const run = (name, story = fixture.story, extra = {}) => scoreTrend({ story, observations: fixture.scenarios[name], now, ...extra });

test("true same-event movement earns a daily segment and a bigger verified surge a standalone pitch", () => {
  const daily = run("sameEvent");
  assert.equal(daily.recommendation, "daily segment");
  assert.equal(daily.airable, true);
  assert.equal(daily.matchedStoryId, fixture.story.id);
  assert.ok(daily.score >= 70 && daily.score < 85, `${daily.score}`);
  assert.deepEqual(Object.keys(daily.components), ["surge", "persistence", "corroboration", "novelty"]);
  assert.equal(daily.components.persistence, 25);
  assert.ok(daily.components.surge <= 40 && daily.components.corroboration <= 20 && daily.components.novelty <= 15);
  assert.match(daily.explanation[0], /3 qualifying observations/u);
  assert.equal(daily.scoreVersion, "trend/1");
  const standalone = run("standalone");
  assert.equal(standalone.recommendation, "standalone video pitch");
  assert.ok(standalone.score >= 85);
  assert.ok(standalone.comparison.independentSources >= 2);
  const withoutAnalysis = run("standalone", { ...fixture.story, originalAnalysis: false, visualEvidence: false });
  assert.equal(withoutAnalysis.recommendation, "daily segment");
  const outOfScope = run("sameEvent", { ...fixture.story, scope: "out" });
  assert.equal(outOfScope.recommendation, "watch");
  assert.equal(outOfScope.airable, false);
  const covered = run("sameEvent", { ...fixture.story, newEvidence: false }, { coveredAngles: [fixture.story.id] });
  assert.equal(covered.recommendation, "watch");
  assert.equal(covered.components.novelty, 0);
});

test("no qualifying trend is a watch for a verified story, and a feed outage is signal unavailable", () => {
  const quiet = run("noTrend");
  assert.equal(quiet.recommendation, "watch");
  assert.equal(quiet.airable, false);
  assert.equal(quiet.comparison.qualifying, 0);
  const outage = scoreTrend({ story: fixture.story, observations: [], failures: [{ provider: "google-trending-now", error: "HTTP 503" }], now });
  assert.equal(outage.recommendation, "signal unavailable");
  assert.match(outage.explanation[0], /HTTP 503/u);
  const partial = scoreTrend({ story: fixture.story, observations: fixture.scenarios.sameEvent, failures: [{ provider: "x-counts", error: "timeout" }], now });
  assert.deepEqual(partial.missing, ["x-counts unavailable"]);
  assert.equal(scoreTrend({ story: { ...fixture.story, id: null }, observations: fixture.scenarios.sameEvent, now }).recommendation, "insufficient evidence");
});

test("stale terms, promotions and repost spikes are filtered and cannot clear the angle", () => {
  const stale = run("stale");
  assert.deepEqual(stale.filtered.map(({ reason }) => reason).sort(), ["stale", "stale term"]);
  assert.equal(stale.airable, false);
  const promo = run("promo");
  assert.deepEqual(promo.filtered.map(({ reason }) => reason), ["promotion", "promotion"]);
  assert.equal(promo.recommendation, "watch");
  const repost = run("repost");
  assert.equal(repost.filtered.filter(({ reason }) => reason === "repost spike").length, 2);
  assert.equal(repost.components.persistence, 5);
  assert.deepEqual(repost.missing, ["second observation at least 15 minutes later"]);
  assert.equal(repost.airable, false);
  const old = scoreTrend({ story: fixture.story, observations: fixture.scenarios.sameEvent, now: new Date("2026-11-16T20:00:00Z") });
  assert.ok(old.missing.includes("fresh observation within six hours of lock"));
  assert.equal(old.components.persistence, 5);
  assert.equal(old.airable, false);
});

test("a same-name collision is rejected even with more search traffic than the real story", () => {
  const collision = run("collision");
  assert.equal(collision.comparison.qualifying, 0);
  assert.deepEqual([...new Set(collision.filtered.map(({ reason }) => reason))], ["same-name collision"]);
  assert.match(collision.filtered[0].detail, /does not connect to the dated story/u);
  assert.equal(collision.airable, false);
  assert.ok(fixture.scenarios.collision[0].traffic > fixture.scenarios.sameEvent.at(-1).traffic);
});

test("a high-interest unverified rumor is insufficient evidence, never airable", () => {
  const rumor = run("rumor", { ...fixture.story, verified: false, aliases: [...fixture.story.aliases, "Mara Quill trade"] });
  assert.equal(rumor.recommendation, "insufficient evidence");
  assert.equal(rumor.airable, false);
  assert.ok(rumor.comparison.qualifying >= 1, "the attention is real; the story is not verified");
  assert.match(rumor.explanation[0], /no verified claim/u);
});

test("no unconnected or unverified trend angle reaches a locked revision or a trend segment", () => {
  const ledger = new EvidenceLedger();
  const at = fixture.now;
  const snapshot = ledger.snapshot({ provider: "google-trending-now", originGroup: "google-trending-now", sourceUrl: "https://trends.google.com/trending?geo=US", retrievedAt: at, title: "Trending", allowedUses: ["verify"], retention: "link-only" });
  const claim = ledger.claim({ storyId: fixture.story.id, key: "trend:q", text: "Mara Quill: peak 100000 searches", value: 100000, unit: "searches", evidence: [{ snapshotId: snapshot.id, locator: "approx_traffic" }], at });
  const base = { date: "2026-11-16", revision: 1, at };
  const segment = (card) => ({ segmentId: "trend", kind: "trend", storyId: fixture.story.id, headline: "Trending: Mara Quill", narration: "Searches for Mara Quill rose to about 100000 searches overnight.", claimIds: [claim.id], trend: card });
  const cleared = run("sameEvent");
  assert.equal(ledger.lockRevision({ ...base, stories: [segment(cleared)] }).status, "locked");
  assert.throws(() => ledger.lockRevision({ ...base, revision: 2, stories: [segment(run("collision"))] }), (error) => error instanceof LedgerError && /not cleared to air/u.test(error.message));
  assert.throws(() => ledger.lockRevision({ ...base, revision: 3, stories: [segment({ ...cleared, matchedStoryId: "another-game" })] }), /not connected to the canonical story/u);
  assert.throws(() => ledger.lockRevision({ ...base, revision: 4, stories: [segment({ ...cleared, verified: false })] }), /unverified story/u);
  assert.throws(() => ledger.lockRevision({ ...base, revision: 5, stories: [segment(null)] }), /no trend check/u);
  const topic = { id: "t1", title: fixture.story.title };
  assert.equal(trendSegment([{ topic, card: run("collision") }, { topic, card: run("rumor", { ...fixture.story, verified: false }) }]), null);
  const built = trendSegment([{ topic, card: cleared }]);
  assert.equal(built.kind, "trend");
  assert.match(built.narration, /100000 searches/u);
  assert.equal(built.sources[0].url, "https://trends.google.com/trending?geo=US");
});

test("the Google Trending Now adapter parses the RSS export and reports outages", async () => {
  const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:ht="https://trends.google.com/trending/rss"><channel><title>Daily Search Trends</title>
    <item><title>Mara Quill</title><ht:approx_traffic>200,000+</ht:approx_traffic><pubDate>Mon, 16 Nov 2026 09:40:00 -0800</pubDate>
      <ht:news_item><ht:news_item_title>Quill&#39;s corner three sinks the Stags</ht:news_item_title><ht:news_item_url>https://news-a.example/nba/quill?utm=1&amp;x=2</ht:news_item_url><ht:news_item_source>News A</ht:news_item_source></ht:news_item>
    </item>
    <item><title><![CDATA[weather radar]]></title><ht:approx_traffic>1,000,000+</ht:approx_traffic><pubDate>Mon, 16 Nov 2026 10:00:00 -0800</pubDate></item>
    <item><title>broken</title><pubDate>not a date</pubDate></item>
  </channel></rss>`;
  const observations = parseTrendingRss(xml, { geo: "US", retrievedAt: fixture.now });
  assert.equal(observations.length, 2);
  assert.equal(observations[0].traffic, 200000);
  assert.equal(observations[0].observedAt, "2026-11-16T17:40:00.000Z");
  assert.equal(observations[0].news[0].title, "Quill's corner three sinks the Stags");
  assert.equal(observations[0].news[0].url, "https://news-a.example/nba/quill?utm=1&x=2");
  assert.equal(observations[0].provider, "google-trending-now");
  assert.throws(() => parseTrendingRss("<html><body>blocked</body></html>"), /RSS/u);
  const adapter = new GoogleTrendingNowAdapter({ geo: "US", fetchImpl: async (url) => {
    assert.equal(url, "https://trends.google.com/trending/rss?geo=US");
    return new Response(xml, { status: 200 });
  } });
  assert.equal((await adapter.observe({ now })).length, 2);
  const down = new GoogleTrendingNowAdapter({ fetchImpl: async () => new Response("", { status: 503 }) });
  const result = await collectObservations([down, new FixtureTrendAdapter(fixture.scenarios.sameEvent)], { now });
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].error, /503/u);
  assert.equal(result.observations.length, 3);
});
