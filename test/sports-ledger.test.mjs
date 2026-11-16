import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { root } from "../server/config.mjs";
import { FixtureEvidenceAdapter, ingestEpisodeFixture, ingestGame, scanSlate, scoreAssociation } from "../server/sports/evidence.mjs";
import { loadAllSlates, loadFixture } from "../server/sports/fixtures.mjs";
import { EvidenceLedger, LedgerError, numbersIn } from "../server/sports/ledger.mjs";

const after = "2026-11-17T12:00:00Z";
const story = (result, extra = {}) => ({ segmentId: result.gameId, storyId: result.gameId, headline: result.story.headline, narration: result.story.narration, claimIds: result.story.claimIds, ...extra });

test("replays every game of seven multi-sport slates and binds each aired number to a claim with evidence IDs", async () => {
  const slates = await loadAllSlates();
  assert.ok(slates.length >= 7, `${slates.length} slates`);
  const games = slates.flatMap(({ games }) => games);
  assert.ok(games.length >= 30, `${games.length} games`);
  assert.ok(new Set(games.map(({ sport }) => sport)).size >= 5);
  const adapter = new FixtureEvidenceAdapter({ slates });
  const ledger = new EvidenceLedger();
  const refused = [];
  let verified = 0;
  for (const game of games) {
    const result = await ingestGame(ledger, adapter, game.id, { asOf: after });
    if (!result.story) {
      assert.ok(["quiet", "source unavailable"].includes(result.coverage), `${game.id} ${result.coverage}`);
      continue;
    }
    const check = ledger.verifyStory(story(result));
    if (!check.ok) {
      refused.push({ id: game.id, issues: check.issues });
      continue;
    }
    verified++;
    for (const block of check.citations) {
      assert.equal(block.uncovered.length, 0);
      assert.ok(block.claimIds.length > 0, `${game.id} ${block.kind} cites no claim`);
    }
    for (const claim of ledger.publicClaims(result.story.claimIds)) {
      assert.ok(claim.evidence.length > 0 && claim.evidence.every(({ id, locator }) => id.startsWith("snap_") && locator));
    }
    for (const number of numbersIn(result.story.narration)) assert.ok(check.citations.some((block) => block.kind === "fact" && !block.uncovered.includes(number)));
  }
  assert.ok(verified >= 28, `${verified} verified`);
  assert.deepEqual(refused.map(({ id }) => id), ["2026-11-12-cup-unm-atl"]);
  assert.match(refused[0].issues[0], /contradictory evidence/u);
});

test("a late correction supersedes the claim, invalidates the locked revision and carries the reason", async () => {
  const adapter = new FixtureEvidenceAdapter();
  const ledger = new EvidenceLedger();
  const id = "2026-11-10-nba-spo-blc";
  const early = await ingestGame(ledger, adapter, id, { asOf: "2026-11-11T04:00:00Z" });
  assert.equal(early.coverage, "covered");
  const original = ledger.claimByKey(id, id, "leader:Owen Castellano");
  assert.deepEqual(original.value, [31, 7, 5]);
  const revision = ledger.lockRevision({ date: "2026-11-11", revision: 1, stories: [story(early)], at: "2026-11-11T05:00:00Z" });
  assert.equal(revision.status, "locked");
  assert.deepEqual(revision.stories[0].shortRelease, { segmentId: id, surface: "short" });

  const late = await ingestGame(ledger, adapter, id, { asOf: "2026-11-11T06:30:00Z" });
  const replacement = ledger.claimByKey(id, id, "leader:Owen Castellano");
  assert.deepEqual(replacement.value, [29, 7, 5]);
  assert.equal(replacement.supersedes, original.id);
  assert.equal(ledger.data.claims[original.id].disposition, "superseded");
  assert.equal(revision.status, "invalidated");
  assert.match(revision.invalidation.reason, /reassigned a fourth-quarter basket/u);
  assert.deepEqual(revision.invalidation.segments, [id]);
  assert.equal(ledger.corrections.length, 1);
  assert.deepEqual(ledger.corrections[0].revisions, [revision.id]);

  const stale = ledger.verifyStory(story(early));
  assert.equal(stale.ok, false);
  assert.match(stale.issues[0], /superseded/u);
  assert.match(late.story.narration, /29 points/u);
  assert.equal(ledger.verifyStory(story(late)).ok, true);
  assert.throws(() => ledger.lockRevision({ date: "2026-11-11", revision: 2, stories: [story(early)], at: after }), LedgerError);
});

test("a late West Coast finish withholds the result until the final arrives", async () => {
  const adapter = new FixtureEvidenceAdapter();
  const ledger = new EvidenceLedger();
  const id = "2026-11-11-nba-csm-iwb";
  const midnight = await ingestGame(ledger, adapter, id, { asOf: "2026-11-12T06:30:00Z" });
  assert.equal(midnight.status, "in-progress");
  assert.equal(midnight.coverage, "awaiting verification");
  const byKey = Object.fromEntries(midnight.claims.map((claim) => [claim.key, claim]));
  assert.equal(byKey["final-score"].disposition, "withheld");
  assert.match(byKey["final-score"].reason, /not final/u);
  assert.equal(byKey["decisive-play"].disposition, "supported");
  assert.equal(ledger.verifyStory(story(midnight)).ok, false);
  const later = await ingestGame(ledger, adapter, id, { asOf: "2026-11-12T07:05:00Z" });
  assert.equal(later.status, "final");
  assert.equal(later.coverage, "covered");
  assert.equal(ledger.versionsOf(id).length, 2);
  assert.equal(ledger.verifyStory(story(later)).ok, true);
});

test("syndicated duplicates collapse to one snapshot and count as one origin", async () => {
  const adapter = new FixtureEvidenceAdapter();
  const ledger = new EvidenceLedger();
  const result = await ingestGame(ledger, adapter, "2026-11-10-nfl-pkg-lsh", { asOf: after });
  assert.equal(result.snapshots.length, 5);
  assert.equal(new Set(result.snapshots.map(({ id }) => id)).size, 3);
  const wire = result.snapshots.find(({ originGroup }) => originGroup === "wire-service");
  assert.equal(wire.urls.length, 3);
  assert.equal(wire.seen, 3);
  assert.equal(result.independentOrigins, 2);
  assert.equal(ledger.independentOrigins(result.claims.find(({ key }) => key === "final-score")), 2);
});

test("a source outage is reported as unavailable and nothing from it can air", async () => {
  const adapter = new FixtureEvidenceAdapter();
  const ledger = new EvidenceLedger();
  const result = await ingestGame(ledger, adapter, "2026-11-11-nhl-tml-gbw", { asOf: after });
  assert.equal(result.coverage, "source unavailable");
  assert.equal(result.claims.length, 0);
  assert.equal(result.event, null);
  const check = ledger.verifyStory({ segmentId: "x", headline: "Wolves win", narration: "The Wolves won on the road and lead the division.", claimIds: [] });
  assert.equal(check.ok, false);
  assert.match(check.issues[0], /no supported claim/u);
});

test("winner and score association: a contested wire report is a conflict until Isaac rules", async () => {
  const adapter = new FixtureEvidenceAdapter();
  const ledger = new EvidenceLedger();
  const id = "2026-11-12-cup-unm-atl";
  const result = await ingestGame(ledger, adapter, id, { asOf: after });
  const final = result.claims.find(({ key }) => key === "final-score");
  assert.equal(final.disposition, "conflict");
  assert.equal(final.review.required, true);
  assert.equal(result.coverage, "awaiting verification");
  const { game } = await adapter.gameEvidence(id, { asOf: after });
  assert.match(scoreAssociation({ key: "final-score", value: [2, 1], subject: { team: "atl" } }, game), /does not match/u);
  assert.match(scoreAssociation({ key: "final-score", value: [1, 2], subject: { team: "unm" } }, game), /not higher/u);
  assert.equal(scoreAssociation({ key: "final-score", value: [2, 1], subject: { team: "unm" } }, game), null);
  assert.throws(() => ledger.resolve(final.id, { disposition: "supported", by: "isaac", at: after }), LedgerError);
  ledger.resolve(final.id, { disposition: "supported", reason: "The official line score and play-by-play agree; the wire lede swapped the sides.", by: "isaac", at: after });
  assert.equal(final.review.by, "isaac");
  assert.equal(ledger.verifyStory(story(result)).ok, true);
  const postponed = await ingestGame(ledger, adapter, "2026-11-12-nhl-hlb-sfp", { asOf: after });
  assert.equal(postponed.coverage, "quiet");
  assert.equal(postponed.reason, "Postponed.");
});

test("a slate scan reports coverage per game and the ledger round-trips through disk", async (t) => {
  await mkdir(path.join(root, "data"), { recursive: true });
  const directory = await mkdtemp(path.join(root, "data", "sports-ledger-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "ledger.json");
  const ledger = await EvidenceLedger.open(file);
  const results = await scanSlate(ledger, new FixtureEvidenceAdapter(), { date: "2026-11-12", asOf: "2026-11-12T06:30:00Z" });
  assert.deepEqual(results.map(({ coverage }) => coverage), ["awaiting verification", "source unavailable", "covered", "covered", "covered"]);
  await ledger.save();
  const reopened = await EvidenceLedger.open(file);
  assert.equal(reopened.claims.length, ledger.claims.length);
  assert.equal(reopened.snapshots.length, ledger.snapshots.length);
  assert.ok(reopened.view().snapshots.every((snapshot) => snapshot.payload === undefined));
});

test("the frozen 2016 fixture locks through the ledger with claim and snapshot IDs in its credits", async () => {
  const ledger = new EvidenceLedger();
  const { revision, episode } = ingestEpisodeFixture(ledger, await loadFixture("finals-2016-game7"));
  assert.equal(revision.status, "locked");
  assert.equal(episode.segments.length, 3);
  assert.ok(episode.segments.every((segment) => segment.claims.length && segment.claims.every((claim) => claim.id.startsWith("clm_") && claim.evidence[0].id.startsWith("snap_"))));
  assert.ok(episode.segments.every((segment) => segment.citations.every((block) => block.uncovered.length === 0)));
});
