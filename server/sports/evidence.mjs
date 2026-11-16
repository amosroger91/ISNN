import { loadAllSlates } from "./fixtures.mjs";

// Provider-neutral evidence port. An adapter exposes:
//   name, capabilities { schedule, boxscore, playByPlay, changes, network }
//   contract { allowedUses, retention }            what the source terms permit the ledger to keep
//   listGames({ date, asOf })                       → [{ id, league, sport, status, startTime, home, away }]
//   gameEvidence(gameId, { asOf })                  → { game } as the source knew it at asOf
// Sportradar or SportsDataIO fit the same port once a contract exists; the
// fixture adapter reads the committed slates and never touches the network.
export const COVERAGE = ["quiet", "covered", "awaiting verification", "source unavailable"];

const summary = ({ id, league, sport, competition, status, startTime, finalAt, home, away, scenario }) => ({ id, league, sport, competition, status, startTime, finalAt: finalAt || null, home, away, scenario });

export class FixtureEvidenceAdapter {
  constructor({ slates = null } = {}) {
    this.name = "fixture";
    this.capabilities = { schedule: true, boxscore: true, playByPlay: true, changes: true, network: false };
    this.contract = { allowedUses: ["verify", "display", "archive"], retention: "full" };
    this.slates = slates;
  }

  async load() {
    if (!this.slates) this.slates = await loadAllSlates();
    return this.slates;
  }

  async listGames({ date, asOf } = {}) {
    const slates = await this.load();
    return slates.filter((slate) => !date || slate.date === date).flatMap((slate) => slate.games.map((game) => summary(viewAt(game, asOf).game)));
  }

  async gameEvidence(gameId, { asOf } = {}) {
    const slates = await this.load();
    const game = slates.flatMap((slate) => slate.games).find((candidate) => candidate.id === gameId);
    if (!game) throw Object.assign(new Error(`Unknown game ${gameId}.`), { status: 404 });
    return viewAt(game, asOf);
  }
}

// The game as the source would have reported it at a moment in time: reports
// published later are not yet visible, a game past tip but before its final is
// in progress, and corrections apply only once their report exists.
export function viewAt(game, asOf) {
  const cutoff = asOf ? Date.parse(asOf) : Infinity;
  const visible = game.reports.map((report, index) => ({ ...report, index })).filter((report) => Date.parse(report.sourceTime) <= cutoff);
  const corrections = (game.corrections || []).filter((correction) => Date.parse(correction.at) <= cutoff);
  let status = game.status;
  if (status === "final" && game.finalAt && Date.parse(game.finalAt) > cutoff) status = Date.parse(game.startTime) <= cutoff ? "in-progress" : "scheduled";
  const scoreStates = status === "final" ? game.scoreStates : game.scoreStates.filter((state) => state.at && Date.parse(state.at) <= cutoff);
  const plays = (game.plays || []).filter((play) => !play.at || Date.parse(play.at) <= cutoff);
  let story = game.story || null;
  if (story && corrections.length) {
    // The pitch copy follows the corrected record, so a rescan carries the new
    // number into the script as well as the claim.
    let { headline, narration } = story;
    const claims = story.claims.map((claim) => {
      const correction = corrections.findLast((item) => item.key === claim.key);
      if (!correction) return claim;
      const report = game.reports[correction.report];
      headline = headline.replaceAll(claim.text, correction.text);
      narration = narration.replaceAll(claim.text, correction.text);
      return { ...claim, value: correction.value, text: correction.text, evidence: [{ report: correction.report, locator: report.kind === "correction" ? "Stat correction" : claim.evidence[0].locator }], correction: { at: correction.at, reason: correction.reason } };
    });
    story = { ...story, headline, narration, claims };
  }
  return { game: { ...game, status, scoreStates, plays, reports: visible, corrections, story }, asOf: asOf || null };
}

const finalOf = (game) => game.status === "final" ? game.scoreStates.at(-1) || null : null;
const sideOf = (game, team) => team === game.home.id || team === game.home.name ? "home" : team === game.away.id || team === game.away.name ? "away" : null;

// Winner and score association: a final-score claim must name the side that
// actually has the higher score, with both numbers as the event records them.
export function scoreAssociation(claim, game) {
  if (claim.key !== "final-score" || !Array.isArray(claim.value) || claim.value.length !== 2) return null;
  const final = finalOf(game);
  if (!final) return null;
  const [first, second] = claim.value;
  const side = claim.subject?.team ? sideOf(game, claim.subject.team) : null;
  if (claim.subject?.team && !side) return `The claim names a team that did not play in ${game.id}.`;
  if (side) {
    const other = side === "home" ? "away" : "home";
    if (first <= second) return "The claim names a winner whose score is not higher.";
    if (final[side] !== first || final[other] !== second) return `The claim's score ${first}-${second} does not match the event record ${final.home}-${final.away}.`;
    return null;
  }
  const sorted = [final.home, final.away].sort((a, b) => b - a);
  const claimed = [first, second].sort((a, b) => b - a);
  return sorted[0] === claimed[0] && sorted[1] === claimed[1] ? null : `The claim's score does not match the event record ${final.home}-${final.away}.`;
}

// Reads one game through the adapter into the ledger: snapshots for each
// report, an event version, and the story's claims with their dispositions.
export async function ingestGame(ledger, adapter, gameId, { asOf, retrievedAt = asOf || new Date().toISOString() } = {}) {
  const { game } = await adapter.gameEvidence(gameId, { asOf });
  const base = { gameId: game.id, league: game.league, sport: game.sport, competition: game.competition, status: game.status, title: `${game.away.name} at ${game.home.name}`, home: game.home, away: game.away, startTime: game.startTime, scenario: game.scenario || [] };
  if (!game.reports.length) {
    return { ...base, coverage: "source unavailable", reason: "No evidence report was available from the configured sources.", event: null, snapshots: [], claims: [], story: null, entities: [game.home.name, game.away.name], independentOrigins: 0 };
  }
  const snapshots = game.reports.map((report) => ledger.snapshot({
    provider: report.provider, originGroup: report.originGroup, sourceUrl: report.url, sourceTime: report.sourceTime, retrievedAt, version: report.version || "1",
    kind: report.kind, title: report.title || null, excerpt: report.excerpt || null, payload: report.payload || null, allowedUses: adapter.contract.allowedUses, retention: adapter.contract.retention,
  }));
  const byIndex = new Map(game.reports.map((report, position) => [report.index, snapshots[position]]));
  const event = ledger.event({
    canonicalGameId: game.id, league: game.league, competition: game.competition, season: game.season,
    participants: [{ role: "home", ...game.home }, { role: "away", ...game.away }], startTime: game.startTime, status: game.status,
    plays: game.plays, scoreStates: game.scoreStates, upstream: snapshots.map(({ id }) => id),
  });
  const claims = [];
  for (const input of game.story?.claims || []) {
    const evidence = input.evidence.map(({ report, locator, stance }) => {
      const snapshot = byIndex.get(report);
      return snapshot && { snapshotId: snapshot.id, locator, stance: stance || "supports" };
    }).filter(Boolean);
    let disposition = null;
    let reason = null;
    const association = scoreAssociation(input, game);
    if (input.asOf === "final" && game.status !== "final") {
      disposition = "withheld";
      reason = `The game was not final at ${asOf || "the scan"}; the result awaits verification.`;
    } else if (association) {
      disposition = "conflict";
      reason = association;
    } else if (!evidence.length) {
      disposition = "withheld";
      reason = "The supporting report had not been published at the scan.";
    }
    const claimInput = {
      eventId: event.id, storyId: game.id, key: input.key, text: input.text, value: input.value ?? null, unit: input.unit || null, subject: input.subject || {},
      period: input.period ?? null, clock: input.clock ?? null, asOf: input.asOf, evidence, disposition, reason, at: retrievedAt,
    };
    const prior = ledger.claimByKey(game.id, game.id, input.key);
    const changed = prior && (JSON.stringify(prior.value) !== JSON.stringify(claimInput.value) || prior.text !== claimInput.text);
    claims.push(changed
      ? ledger.supersede(prior.id, claimInput, { reason: input.correction?.reason || "The source changed its record.", at: retrievedAt }).claim
      : ledger.claim(claimInput));
  }
  const entities = [...new Set([game.home.name, game.away.name, game.home.name.split(" ").at(-1), game.away.name.split(" ").at(-1), ...game.leaders.map(({ player }) => player), ...game.plays.map(({ player }) => player).filter(Boolean)])];
  const supported = claims.filter((claim) => claim.disposition === "supported");
  let coverage = "quiet";
  let reason = game.status === "postponed" ? "Postponed." : null;
  if (game.story) {
    if (game.status === "final" && claims.length && supported.length === claims.length) coverage = "covered";
    else {
      coverage = "awaiting verification";
      reason = claims.find((claim) => claim.disposition !== "supported")?.reason || "Not final.";
    }
  }
  return {
    ...base, coverage, reason, event, snapshots, claims, entities,
    independentOrigins: new Set(snapshots.map((snapshot) => snapshot.originGroup)).size,
    story: game.story ? { headline: game.story.headline, narration: game.story.narration, diagram: game.story.diagram || null, claimIds: claims.map(({ id }) => id) } : null,
    media: game.media || { assets: [], grants: [] },
  };
}

// An episode fixture (a frozen historical game with hand-written segments and
// claims) read into a ledger, so the offline proof carries the same claim and
// evidence IDs as a desk edition.
export function ingestEpisodeFixture(ledger, fixture, { at = new Date().toISOString() } = {}) {
  const game = fixture.game || {};
  const final = game.final && typeof game.final === "object" ? Object.entries(game.final) : [];
  const participants = [game.home && { role: "home", id: game.home, name: game.home }, game.away && { role: "away", id: game.away, name: game.away }].filter(Boolean);
  const event = ledger.event({
    canonicalGameId: fixture.name, league: game.league || "unknown", competition: game.competition || fixture.title, season: game.season || fixture.date.slice(0, 4),
    participants, startTime: `${fixture.date}T00:00:00Z`, status: "final",
    scoreStates: final.length === 2 ? [{ period: "final", home: final.find(([name]) => name === game.home || (game.home || "").includes(name))?.[1] ?? final[1][1], away: final.find(([name]) => name === game.away || (game.away || "").includes(name))?.[1] ?? final[0][1] }] : [],
  });
  const snapshots = new Map();
  const segments = fixture.segments.map((segment) => {
    for (const source of segment.sources) {
      if (!snapshots.has(source.url)) {
        snapshots.set(source.url, ledger.snapshot({ provider: source.publisher, originGroup: source.publisher, sourceUrl: source.url, sourceTime: null, retrievedAt: at, kind: "boxscore", title: source.title, allowedUses: ["verify"], retention: "link-only" }));
      }
    }
    const claimIds = segment.claims.map((claim) => ledger.claim({
      eventId: event.id, storyId: fixture.name, key: `${segment.id}:${claim.text}`, text: claim.text, value: claim.value ?? claim.score ?? null, unit: claim.unit || null,
      subject: { player: claim.player, team: claim.team }, period: claim.period ?? null, clock: claim.clock ?? null, asOf: claim.asOf || "final",
      evidence: [{ snapshotId: snapshots.get(claim.evidence)?.id, locator: claim.locator }].filter(({ snapshotId }) => snapshotId), at,
    }).id);
    return { ...segment, topicId: segment.id, eventId: fixture.name, claimIds };
  });
  const revision = ledger.lockRevision({
    date: fixture.date, revision: 0, at, approvals: [{ by: "fixture", at, kind: "frozen historical fixture" }],
    stories: segments.map((segment) => ({ segmentId: segment.id, storyId: fixture.name, eventId: event.id, headline: segment.headline, narration: segment.narration, claimIds: segment.claimIds })),
  });
  return {
    revision,
    episode: { ...fixture, revisionId: revision.id, segments: segments.map((segment, index) => ({ ...segment, claims: ledger.publicClaims(segment.claimIds), citations: revision.stories[index].citations })) },
  };
}

// Scans a whole slate: one coverage row per game, plus the pitches the desk can use.
export async function scanSlate(ledger, adapter, { date, asOf, retrievedAt }) {
  const games = await adapter.listGames({ date, asOf });
  const results = [];
  for (const game of games) results.push(await ingestGame(ledger, adapter, game.id, { asOf, retrievedAt }));
  return results;
}
