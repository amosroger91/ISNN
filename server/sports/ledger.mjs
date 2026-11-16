import { createHash } from "node:crypto";
import { readJson, saveJson } from "../storage.mjs";

// The evidence ledger: every aired number and headline maps to a Claim, every
// Claim to SourceSnapshots with exact locators, and every locked
// RundownRevision to the Claims it depends on. A correction supersedes a Claim
// and invalidates the revisions that cited it.
export const LEDGER_VERSION = 1;
export const CLAIM_DERIVATION = "claims/1";
export const ALLOWED_USES = ["verify", "quote", "display", "model", "archive"];
export const RETENTION = ["link-only", "excerpt", "full"];
export const DISPOSITIONS = ["supported", "conflict", "withheld", "superseded"];

export const digest = (value) => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const numbersIn = (text) => String(text ?? "").replace(/(?<=\d),(?=\d{3}\b)/gu, "").match(/\d+(?:\.\d+)?/gu) || [];
const opinionBlock = /^Isaac[’']s take\.?/iu;

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  return value;
}
export const fingerprint = (value) => digest(JSON.stringify(sortKeys(value)));

export class LedgerError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.status = 409;
    this.details = details;
  }
}

const empty = () => ({ version: LEDGER_VERSION, snapshots: {}, events: {}, claims: {}, revisions: {}, corrections: [], trends: [] });
const flat = (value) => Array.isArray(value) ? value.flatMap(flat) : [value];

export class EvidenceLedger {
  constructor(data = empty(), file = null) {
    this.data = { ...empty(), ...data };
    this.file = file;
  }

  static async open(file) {
    try {
      return new EvidenceLedger(await readJson(file), file);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return new EvidenceLedger(empty(), file);
    }
  }

  async save() {
    if (this.file) await saveJson(this.file, this.data);
  }

  get snapshots() { return Object.values(this.data.snapshots); }
  get events() { return Object.values(this.data.events); }
  get claims() { return Object.values(this.data.claims); }
  get revisions() { return Object.values(this.data.revisions); }
  get corrections() { return this.data.corrections; }

  // SourceSnapshot: identical content from one origin group is one snapshot,
  // however many syndicated URLs carry it. Independent origins stay distinct.
  snapshot({ provider, originGroup, sourceUrl = null, recordId = null, sourceTime = null, retrievedAt, version = "1", kind = null, title = null, excerpt = null, payload = null, allowedUses = ["verify"], retention = "link-only" }) {
    if (!provider || !originGroup) throw new LedgerError("A source snapshot needs a provider and an origin group.");
    if (!sourceUrl && !recordId) throw new LedgerError("A source snapshot needs a source URL or a record ID.");
    if (!retrievedAt) throw new LedgerError("A source snapshot needs its retrieval time.");
    if (!RETENTION.includes(retention) || !allowedUses.every((use) => ALLOWED_USES.includes(use))) throw new LedgerError("Unknown retention class or allowed use.");
    const content = fingerprint({ originGroup, kind, version, payload, title, excerpt });
    const id = `snap_${content.slice(0, 20)}`;
    const existing = this.data.snapshots[id];
    if (existing) {
      if (sourceUrl && !existing.urls.includes(sourceUrl)) existing.urls.push(sourceUrl);
      existing.seen += 1;
      return existing;
    }
    const record = {
      id, kind: "SourceSnapshot", type: kind, provider, originGroup, sourceUrl, urls: sourceUrl ? [sourceUrl] : [], recordId, sourceTime, retrievedAt, version,
      digest: content, allowedUses, retention, title, excerpt: retention === "link-only" ? null : excerpt, payload: retention === "full" ? payload : null, seen: 1,
    };
    this.data.snapshots[id] = record;
    return record;
  }

  versionsOf(canonicalGameId) {
    return this.events.filter((event) => event.canonicalGameId === canonicalGameId).sort((a, b) => a.version - b.version);
  }

  latestEvent(canonicalGameId) {
    return this.versionsOf(canonicalGameId).at(-1) || null;
  }

  // EventVersion: a new version only when the normalized game state changed.
  event({ canonicalGameId, league, competition, season, participants, startTime, status, plays = [], scoreStates = [], upstream = [] }) {
    if (!canonicalGameId || !league || !startTime || !status) throw new LedgerError("An event version needs a canonical game ID, league, start time and status.");
    const versions = this.versionsOf(canonicalGameId);
    const latest = versions.at(-1);
    const content = fingerprint({ status, plays, scoreStates, participants, startTime, competition, season });
    if (latest && latest.digest === content) return latest;
    const version = versions.length + 1;
    const record = {
      id: `evt_${canonicalGameId}_v${version}`, kind: "EventVersion", canonicalGameId, version, league, competition, season, participants, startTime, status,
      plays, scoreStates, upstream, digest: content, supersedes: latest?.id || null, supersededBy: null,
    };
    if (latest) latest.supersededBy = record.id;
    this.data.events[record.id] = record;
    return record;
  }

  claimByKey(gameId, storyId, key) {
    return this.claims.find((claim) => claim.gameId === gameId && claim.storyId === storyId && claim.key === key && claim.disposition !== "superseded") || null;
  }

  // Claim: literal text, typed value and unit, subject, period and clock, as-of
  // time, evidence with locators and stance, and a computed disposition.
  claim({ eventId = null, storyId, key = null, text, value = null, unit = null, subject = {}, period = null, clock = null, asOf = null, evidence = [], disposition = null, reason = null, review = null, derivation = CLAIM_DERIVATION, at }) {
    if (!storyId || !text) throw new LedgerError("A claim needs a story ID and its literal text.");
    const event = eventId ? this.data.events[eventId] : null;
    if (eventId && !event) throw new LedgerError(`Unknown event version ${eventId}.`);
    const links = evidence.map(({ snapshotId, locator, stance = "supports" }) => {
      if (!this.data.snapshots[snapshotId]) throw new LedgerError(`Claim evidence cites an unknown snapshot ${snapshotId}.`);
      if (!locator) throw new LedgerError("Claim evidence needs an exact locator.");
      if (!["supports", "contradicts"].includes(stance)) throw new LedgerError("Evidence stance must be supports or contradicts.");
      return { snapshotId, locator, stance };
    });
    const gameId = event?.canonicalGameId || null;
    const id = `clm_${fingerprint({ gameId, storyId, key: key || text, value, unit }).slice(0, 20)}`;
    const existing = this.data.claims[id];
    if (existing && existing.disposition !== "superseded") {
      for (const link of links) {
        if (!existing.evidence.some((item) => item.snapshotId === link.snapshotId && item.locator === link.locator)) existing.evidence.push(link);
      }
      if (!existing.review?.decision) {
        const computed = computeDisposition(existing.evidence, disposition, reason);
        existing.disposition = computed.disposition;
        existing.reason = computed.reason;
        existing.review = computed.review;
      }
      return existing;
    }
    const computed = computeDisposition(links, disposition, reason);
    const record = {
      id, kind: "Claim", eventId, gameId, storyId, key, text, value, unit, subject, period, clock, asOf, evidence: links,
      ...computed, review: review || computed.review, derivation, createdAt: at || null, supersedes: null, supersededBy: null,
    };
    this.data.claims[id] = record;
    return record;
  }

  // Isaac's decision on a conflict, or a manual withhold, recorded with its author.
  resolve(claimId, { disposition, reason, by, at }) {
    const claim = this.data.claims[claimId];
    if (!claim) throw new LedgerError(`Unknown claim ${claimId}.`, { status: 404 });
    if (claim.disposition === "superseded") throw new LedgerError("A superseded claim cannot be resolved. Resolve its replacement.");
    if (!["supported", "withheld"].includes(disposition)) throw new LedgerError("Resolve a claim as supported or withheld.");
    if (!reason || !by) throw new LedgerError("A resolution needs its author and reason.");
    claim.disposition = disposition;
    claim.reason = disposition === "withheld" ? reason : null;
    claim.review = { required: true, by, at, reason, decision: disposition };
    return claim;
  }

  // A late correction: the old claim is superseded, the replacement recorded,
  // and every locked revision that cited the old claim is invalidated.
  supersede(claimId, replacement, { reason, at, by = "evidence" }) {
    const previous = this.data.claims[claimId];
    if (!previous) throw new LedgerError(`Unknown claim ${claimId}.`, { status: 404 });
    if (previous.disposition === "superseded") throw new LedgerError("This claim was already superseded.");
    if (!reason) throw new LedgerError("A correction needs a reason.");
    const input = { ...previous, ...replacement, at, review: null, disposition: replacement.disposition ?? null, reason: replacement.reason ?? null };
    delete input.id;
    delete input.supersedes;
    delete input.supersededBy;
    delete input.createdAt;
    const claim = this.claim(input);
    if (claim.id === previous.id) throw new LedgerError("A correction must change the claim's value, unit or text.");
    previous.disposition = "superseded";
    previous.supersededBy = claim.id;
    previous.supersededAt = at;
    claim.supersedes = previous.id;
    const affected = this.revisions.filter((revision) => revision.status === "locked" && revision.stories.some((story) => story.claimIds.includes(claimId)));
    for (const revision of affected) {
      revision.status = "invalidated";
      revision.invalidation = { at, reason, claimId, replacementId: claim.id, segments: revision.stories.filter((story) => story.claimIds.includes(claimId)).map((story) => story.segmentId) };
    }
    const correction = {
      id: `cor_${fingerprint({ claimId, replacementId: claim.id, at }).slice(0, 16)}`, kind: "Correction", at, by, reason, claimId, replacementId: claim.id,
      previousText: previous.text, text: claim.text, revisions: affected.map((revision) => revision.id),
      segments: [...new Set(affected.flatMap((revision) => revision.invalidation.segments))],
    };
    this.data.corrections.push(correction);
    return { claim, previous, affected, correction };
  }

  independentOrigins(claim) {
    return new Set(claim.evidence.filter(({ stance }) => stance === "supports").map(({ snapshotId }) => this.data.snapshots[snapshotId]?.originGroup).filter(Boolean)).size;
  }

  // Numbers a claim licenses in copy: its typed values, its text, clock and period.
  allowances(claim) {
    const numbers = new Set();
    for (const value of flat(claim.value)) if (typeof value === "number") numbers.add(String(value));
    for (const text of [claim.text, claim.clock, claim.period]) for (const number of numbersIn(text)) numbers.add(number);
    return numbers;
  }

  // Numbers the event itself licenses: its date, competition and season.
  eventAllowances(event) {
    const numbers = new Set();
    if (!event) return numbers;
    const date = new Date(event.startTime);
    for (const part of [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]) numbers.add(String(part));
    for (const text of [event.competition, event.season]) for (const number of numbersIn(text)) numbers.add(number);
    return numbers;
  }

  // Checks one story against its claims: every number in a factual block or the
  // headline must be licensed by a supported claim or the event, each block gets
  // its citation list, and bound claims must be supported.
  verifyStory({ segmentId, headline, narration, claimIds = [], opinion = false, kind = "story", trend = null, storyId = null }) {
    const issues = [];
    const claims = claimIds.map((id) => {
      const claim = this.data.claims[id];
      if (!claim) issues.push(`Claim ${id} is not in the ledger.`);
      return claim;
    }).filter(Boolean);
    for (const claim of claims) {
      if (claim.disposition === "superseded") issues.push(`“${claim.text}” was superseded by “${this.data.claims[claim.supersededBy]?.text}”. Rewrite the copy before it airs.`);
      else if (claim.disposition === "conflict") issues.push(`“${claim.text}” has contradictory evidence and needs Isaac's decision.`);
      else if (claim.disposition === "withheld") issues.push(`“${claim.text}” is withheld: ${claim.reason || "no supporting evidence"}.`);
    }
    const supported = claims.filter((claim) => claim.disposition === "supported");
    const events = [...new Set(supported.map((claim) => claim.eventId).filter(Boolean))].map((id) => this.data.events[id]);
    const licensed = new Set(events.flatMap((event) => [...this.eventAllowances(event)]));
    const allowances = supported.map((claim) => ({ claim, numbers: this.allowances(claim) }));
    for (const { numbers } of allowances) for (const number of numbers) licensed.add(number);
    const check = (text, blockKind) => {
      const numbers = numbersIn(text);
      const uncovered = [...new Set(numbers.filter((number) => !licensed.has(number)))];
      const cited = numbers.length
        ? allowances.filter(({ numbers: own }) => numbers.some((number) => own.has(number))).map(({ claim }) => claim.id)
        : supported.map((claim) => claim.id);
      return { kind: blockKind, text, claimIds: cited, uncovered };
    };
    const blocks = opinion ? [{ kind: "opinion", text: narration, claimIds: [], uncovered: [] }]
      : narration.split(/\n\n+/u).map((text) => opinionBlock.test(text) ? { kind: "opinion", text, claimIds: [], uncovered: [] } : check(text, "fact"));
    const citations = [check(headline, "headline"), ...blocks];
    if (!opinion) {
      if (!supported.length) issues.push("The segment has no supported claim behind its copy.");
      for (const block of citations) {
        if (block.uncovered.length) issues.push(`${block.kind === "headline" ? "The headline" : "The narration"} cites numbers without evidence: ${block.uncovered.join(", ")}.`);
      }
      if (!citations[0].claimIds.length && supported.length) issues.push("The headline does not map to any claim.");
    }
    if (kind === "trend") {
      if (!trend?.airable) issues.push(`The trend angle is not cleared to air: ${trend?.recommendation || "no trend check"}.`);
      else if (!trend.matchedStoryId || trend.matchedStoryId !== storyId) issues.push("The trend angle is not connected to the canonical story ID.");
      else if (!trend.verified) issues.push("The trend angle rests on an unverified story.");
    }
    return { segmentId, ok: issues.length === 0, issues, citations, claimIds: claims.map((claim) => claim.id) };
  }

  // RundownRevision: ordered stories with stable segment IDs, locked claims, a
  // citation map per block, Isaac's wording and the package digest.
  lockRevision({ date, revision, stories, approvals = [], packageDigest = null, at }) {
    if (!date || !Number.isInteger(revision) || !stories?.length) throw new LedgerError("A rundown revision needs a date, a revision number and stories.");
    const verified = stories.map((story, index) => {
      const segmentId = story.segmentId || `segment-${String(index + 1).padStart(2, "0")}`;
      const result = this.verifyStory({ ...story, segmentId });
      return {
        segmentId, topicId: story.topicId || null, storyId: story.storyId || null, eventId: story.eventId || null, kind: story.kind || "story",
        headline: story.headline, narration: story.narration, claimIds: result.claimIds, citations: result.citations,
        wording: { narration: story.narration, byIsaac: story.wording?.byIsaac || null, paraphraseApproved: story.wording?.paraphraseApproved || false },
        shortRelease: { segmentId, surface: "short" }, verification: { ok: result.ok, issues: result.issues },
      };
    });
    const ok = verified.every((story) => story.verification.ok);
    const id = `rev_${date}_${revision}_${fingerprint(verified.map(({ segmentId, claimIds, narration }) => ({ segmentId, claimIds, narration }))).slice(0, 10)}`;
    const record = { id, kind: "RundownRevision", date, revision, status: ok ? "locked" : "rejected", stories: verified, approvals, packageDigest, lockedAt: at, invalidation: null };
    this.data.revisions[id] = record;
    if (!ok) {
      const issues = verified.filter((story) => !story.verification.ok).map((story) => `${story.headline}: ${story.verification.issues.join(" ")}`);
      throw new LedgerError(`The rundown did not pass evidence review. ${issues.join(" ")}`, { revision: record, issues });
    }
    return record;
  }

  // Claims as they travel into credits.json: evidence resolved to URLs and locators.
  publicClaims(claimIds) {
    return claimIds.map((id) => this.data.claims[id]).filter(Boolean).map((claim) => ({
      id: claim.id, text: claim.text, value: claim.value, unit: claim.unit, subject: claim.subject, period: claim.period, clock: claim.clock, asOf: claim.asOf,
      disposition: claim.disposition, supersedes: claim.supersedes, derivation: claim.derivation,
      evidence: claim.evidence.map(({ snapshotId, locator, stance }) => {
        const snapshot = this.data.snapshots[snapshotId];
        return { id: snapshotId, url: snapshot?.sourceUrl || null, provider: snapshot?.provider || null, originGroup: snapshot?.originGroup || null, sourceTime: snapshot?.sourceTime || null, locator, stance };
      }),
    }));
  }

  view() {
    return {
      version: this.data.version,
      snapshots: this.snapshots.map(({ payload, ...snapshot }) => snapshot),
      events: this.events.map(({ plays, scoreStates, ...event }) => ({ ...event, plays: plays.length, final: scoreStates.at(-1) || null })),
      claims: this.claims, revisions: this.revisions, corrections: this.corrections, trends: this.data.trends,
    };
  }
}

function computeDisposition(evidence, disposition, reason) {
  const supports = evidence.filter((item) => item.stance === "supports");
  const contradicts = evidence.filter((item) => item.stance === "contradicts");
  if (disposition === "withheld") return { disposition, reason: reason || "Withheld pending verification.", review: { required: false } };
  if (contradicts.length) return { disposition: "conflict", reason: reason || "Evidence disagrees. Route to Isaac.", review: { required: true } };
  if (!supports.length) return { disposition: "withheld", reason: reason || "No supporting evidence.", review: { required: false } };
  if (disposition === "conflict") return { disposition, reason: reason || "Flagged for review.", review: { required: true } };
  return { disposition: "supported", reason: null, review: { required: false } };
}
