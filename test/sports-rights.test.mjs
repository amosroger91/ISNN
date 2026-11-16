import assert from "node:assert/strict";
import test from "node:test";
import { FixtureEvidenceAdapter } from "../server/sports/evidence.mjs";
import { FALLBACK, canUse, enforceShots, planShots, territoriesFor } from "../server/sports/rights.mjs";

const channel = "isnn-youtube";
const airAt = "2026-11-14T14:00:00Z";

async function pilot() {
  const adapter = new FixtureEvidenceAdapter();
  const games = await adapter.listGames({ date: "2026-11-14" });
  const byId = {};
  for (const { id } of games) byId[id] = (await adapter.gameEvidence(id)).game;
  const assets = Object.values(byId).flatMap(({ media }) => media.assets);
  const grants = Object.values(byId).flatMap(({ media }) => media.grants);
  return { byId, catalog: { assets, grants } };
}

test("canUse checks the grant's channel, surface, territory, window and status for the planned air time", async () => {
  const { catalog } = await pilot();
  const asset = catalog.assets.find(({ id }) => id === "clip-quill-stepback");
  const grant = catalog.grants.find(({ id }) => id === "g-pilot-live");
  assert.equal(canUse(asset, grant, "episode", channel, "worldwide", airAt).ok, true);
  assert.equal(canUse(asset, grant, "short", channel, "US", airAt).audio, "muted");
  assert.equal(canUse(asset, grant, "episode", "other-channel", "worldwide", airAt).code, "channel");
  assert.equal(canUse(asset, grant, "thumbnail", channel, "worldwide", airAt).code, "surface");
  assert.equal(canUse(asset, { ...grant, territories: ["US"] }, "episode", channel, "CA", airAt).code, "territory");
  assert.equal(canUse(asset, { ...grant, version: 2 }, "episode", channel, "worldwide", airAt).code, "grant-mismatch");
  assert.equal(canUse(asset, { ...grant, status: "revoked" }, "episode", channel, "worldwide", airAt).code, "grant-revoked");
  assert.equal(canUse({ ...asset, status: "revoked" }, grant, "episode", channel, "worldwide", airAt).code, "asset-revoked");
  assert.equal(canUse(asset, grant, "episode", channel, "worldwide", "2027-07-01T12:00:00Z").code, "grant-expired");
  assert.equal(canUse(asset, null, "episode", channel, "worldwide", airAt).code, "no-grant");
  assert.equal(canUse(asset, grant, "episode", channel, "worldwide", undefined).code, "air-time");
});

test("selection uses an exact-event clip and rejects the misfiled wrong-game clip", async () => {
  const { catalog } = await pilot();
  const segment = { eventId: "2026-11-13-nba-hcg-blc", claimIds: ["clm_a"] };
  const plan = planShots(segment, { catalog, channel, airAt, revision: 3 });
  assert.equal(plan.episode.kind, "ShotUse");
  assert.equal(plan.episode.assetId, "clip-quill-stepback");
  assert.equal(plan.episode.grantId, "g-pilot-live");
  assert.equal(plan.episode.revision, 3);
  assert.deepEqual(plan.episode.proofClaims, ["clm_a"]);
  assert.equal(plan.short.kind, "ShotUse");
  const ncaab = planShots({ eventId: "2026-11-13-ncaab-mtu-prg", assetIds: ["clip-misfiled-owls"] }, { catalog, channel, airAt });
  assert.equal(ncaab.episode.kind, "ShotUse", "the clip is cleared for the game it actually belongs to");
  const wrong = planShots({ eventId: "2026-11-13-nba-hcg-blc", assetIds: ["clip-misfiled-owls"] }, { catalog, channel, airAt });
  assert.equal(wrong.episode.fallback, FALLBACK);
  assert.equal(wrong.episode.reasons[0].code, "event-mismatch");
  const none = planShots({ eventId: null }, { catalog, channel, airAt });
  assert.equal(none.short.reasons[0].code, "no-candidate");
});

test("rights expiry, embargo and revocation fall back to the Play diagram with the reason", async () => {
  const { catalog } = await pilot();
  const expired = planShots({ eventId: "2026-11-13-nfl-lsh-ngf" }, { catalog, channel, airAt });
  assert.equal(expired.episode.fallback, FALLBACK);
  assert.equal(expired.episode.reasons[0].code, "grant-expired");
  const beforeExpiry = planShots({ eventId: "2026-11-13-nfl-lsh-ngf" }, { catalog, channel, airAt: "2026-11-14T10:00:00Z" });
  assert.equal(beforeExpiry.episode.kind, "ShotUse");
  const soccer = planShots({ eventId: "2026-11-13-mls-sph-rcb" }, { catalog, channel, airAt });
  assert.deepEqual(soccer.episode.reasons.map(({ code }) => code), ["embargo", "grant-revoked"]);
  assert.equal(soccer.short.fallback, FALLBACK);
});

test("a long-form-only grant clears the episode but sends the Short to the diagram", async () => {
  const { catalog } = await pilot();
  const plan = planShots({ eventId: "2026-11-13-nhl-gbw-sfp" }, { catalog, channel, airAt });
  assert.equal(plan.episode.kind, "ShotUse");
  assert.equal(plan.episode.grantId, "g-longform-only");
  assert.equal(plan.short.fallback, FALLBACK);
  assert.equal(plan.short.reasons[0].code, "surface");
});

test("render-time enforcement replaces a selected shot whose grant expired or was revoked since selection", async () => {
  const { catalog } = await pilot();
  const segment = { eventId: "2026-11-13-nfl-lsh-ngf", shots: planShots({ eventId: "2026-11-13-nfl-lsh-ngf" }, { catalog, channel, airAt: "2026-11-14T10:00:00Z" }) };
  assert.equal(segment.shots.episode.kind, "ShotUse");
  const [slipped] = enforceShots([segment], { catalog, channel, airAt });
  assert.equal(slipped.episode.kind, "Fallback");
  assert.equal(slipped.episode.replaced, "clip-arrington-td");
  assert.equal(slipped.episode.reasons[0].code, "grant-expired");
  const revoked = { assets: catalog.assets, grants: catalog.grants.map((grant) => grant.id === "g-pilot-live" ? { ...grant, status: "revoked" } : grant) };
  const live = { eventId: "2026-11-13-nba-hcg-blc", shots: planShots({ eventId: "2026-11-13-nba-hcg-blc" }, { catalog, channel, airAt }) };
  const [pulled] = enforceShots([live], { catalog: revoked, channel, airAt });
  assert.equal(pulled.short.reasons[0].code, "grant-revoked");
  const moved = { eventId: "2026-11-13-ncaab-mtu-prg", shots: live.shots };
  assert.equal(enforceShots([moved], { catalog, channel, airAt })[0].episode.reasons[0].code, "event-mismatch");
  assert.deepEqual(enforceShots([{ eventId: null }], { catalog, channel, airAt }), [null]);
  assert.deepEqual(territoriesFor([live.shots.episode], catalog), ["worldwide"]);
  assert.deepEqual(territoriesFor([live.shots.episode], { grants: [{ ...catalog.grants[0], territories: ["US", "CA"] }] }), ["US", "CA"]);
});
