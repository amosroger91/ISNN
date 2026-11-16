import { mediaAssetSchema, rightsGrantSchema } from "./fixtures.mjs";

// Asset controls. A MediaAsset is usable only through a RightsGrant that names
// the channel, surface, territory and time window; every use is bound to a
// ShotUse record, and anything that fails falls back to the original "Play
// diagram" plate the renderer already draws.
export const SURFACES = ["episode", "short", "thumbnail", "still"];
export const FALLBACK = "Play diagram";
export { mediaAssetSchema, rightsGrantSchema };

const time = (value) => value ? Date.parse(value) : null;

export function canUse(asset, grant, surface, channel, territory, plannedAirAt) {
  const fail = (code, reason) => ({ ok: false, code, reason });
  if (!asset) return fail("no-asset", "No asset was supplied.");
  if (!grant) return fail("no-grant", "The asset has no rights grant on file.");
  if (!SURFACES.includes(surface)) return fail("surface", `Unknown surface ${surface}.`);
  if (asset.status === "revoked") return fail("asset-revoked", "The licensor revoked this asset.");
  if (asset.status === "quarantined") return fail("asset-quarantined", "The asset failed import validation and is quarantined.");
  if (asset.grantId !== grant.id || (asset.grantVersion || 1) !== (grant.version || 1)) return fail("grant-mismatch", `The asset is bound to grant ${asset.grantId} v${asset.grantVersion || 1}, not ${grant.id} v${grant.version || 1}.`);
  if (grant.status === "revoked") return fail("grant-revoked", `${grant.licensor} revoked grant ${grant.id}.`);
  if (grant.status === "expired") return fail("grant-expired", `Grant ${grant.id} is marked expired.`);
  if (!grant.channels.includes(channel)) return fail("channel", `Grant ${grant.id} does not cover the ${channel} channel.`);
  if (!grant.surfaces.includes(surface)) return fail("surface", `Grant ${grant.id} does not cover the ${surface} surface.`);
  if (!grant.territories.includes("worldwide") && !grant.territories.includes(territory)) return fail("territory", `Grant ${grant.id} does not cover ${territory}.`);
  const air = time(plannedAirAt);
  if (!Number.isFinite(air)) return fail("air-time", "A planned air time is required.");
  const embargo = time(grant.window?.embargoUntil);
  const expires = time(grant.window?.expiresAt);
  if (embargo && air < embargo) return fail("embargo", `Grant ${grant.id} is embargoed until ${grant.window.embargoUntil}.`);
  if (expires && air >= expires) return fail("grant-expired", `Grant ${grant.id} expired at ${grant.window.expiresAt}, before the planned air time.`);
  return { ok: true, code: "ok", reason: null, audio: grant.components.includes("audio") && asset.audio ? "original" : "muted" };
}

// Candidate assets for a segment: exact-event matches only, ranked by capture time.
export function candidatesFor(segment, catalog) {
  if (!segment.eventId) return [];
  const requested = segment.assetIds ? new Set(segment.assetIds) : null;
  return (catalog.assets || []).filter((asset) => requested ? requested.has(asset.id) : asset.eventId === segment.eventId).sort((a, b) => a.captureTime.localeCompare(b.captureTime));
}

// Selection: builds one ShotUse per surface or records the fallback and why.
export function planShots(segment, { catalog = { assets: [], grants: [] }, channel, territory = "worldwide", airAt, revision = 0, surfaces = ["episode", "short"] }) {
  const grants = new Map((catalog.grants || []).map((grant) => [grant.id, grant]));
  const plan = {};
  for (const surface of surfaces) {
    const rejected = [];
    let use = null;
    for (const asset of candidatesFor(segment, catalog)) {
      if (asset.eventId !== segment.eventId) {
        rejected.push({ assetId: asset.id, code: "event-mismatch", reason: `Asset ${asset.id} belongs to ${asset.eventId}, not ${segment.eventId}.` });
        continue;
      }
      const grant = grants.get(asset.grantId);
      const check = canUse(asset, grant, surface, channel, territory, airAt);
      if (!check.ok) {
        rejected.push({ assetId: asset.id, code: check.code, reason: check.reason });
        continue;
      }
      use = {
        kind: "ShotUse", assetId: asset.id, assetSha256: asset.sha256, grantId: grant.id, grantVersion: grant.version || 1, revision, surface, channel, territory, plannedAirAt: airAt,
        output: { inFrame: null, outFrame: null }, source: { in: asset.sourceIn || null, out: asset.sourceOut || null }, eventClock: asset.eventClock || null,
        audio: check.audio, overlays: ["lower third", "scorebug preserved"], credit: asset.credit, proofClaims: segment.claimIds || [], fallback: FALLBACK,
      };
      break;
    }
    plan[surface] = use || { kind: "Fallback", surface, fallback: FALLBACK, reasons: rejected.length ? rejected : [{ code: "no-candidate", reason: segment.eventId ? "No exact-event asset is in the catalog." : "The segment has no canonical event." }] };
  }
  return plan;
}

// Render-time recheck: a ShotUse selected earlier must still clear against the
// current catalog and the actual planned air time, or the plate falls back.
export function enforceShots(segments, { catalog, channel, territory = "worldwide", airAt }) {
  const assets = new Map((catalog?.assets || []).map((asset) => [asset.id, asset]));
  const grants = new Map((catalog?.grants || []).map((grant) => [grant.id, grant]));
  return segments.map((segment) => {
    if (!segment.shots) return null;
    const result = {};
    for (const [surface, shot] of Object.entries(segment.shots)) {
      if (shot.kind !== "ShotUse") {
        result[surface] = shot;
        continue;
      }
      const asset = assets.get(shot.assetId);
      const grant = grants.get(shot.grantId);
      const mismatch = asset && segment.eventId && asset.eventId !== segment.eventId;
      const check = mismatch ? { ok: false, code: "event-mismatch", reason: `Asset ${asset.id} belongs to ${asset.eventId}, not ${segment.eventId}.` } : canUse(asset, grant, surface, channel, territory, airAt);
      result[surface] = check.ok
        ? { ...shot, plannedAirAt: airAt, audio: check.audio, recheckedAt: new Date().toISOString() }
        : { kind: "Fallback", surface, fallback: FALLBACK, reasons: [{ assetId: shot.assetId, code: check.code, reason: check.reason }], replaced: shot.assetId };
    }
    return result;
  });
}

// Territories every asset in a cut allows, so release metadata can honor the narrowest grant.
export function territoriesFor(shots, catalog) {
  const grants = new Map((catalog?.grants || []).map((grant) => [grant.id, grant]));
  let allowed = null;
  for (const shot of shots) {
    if (shot?.kind !== "ShotUse") continue;
    const territories = grants.get(shot.grantId)?.territories || [];
    if (territories.includes("worldwide")) continue;
    allowed = allowed ? allowed.filter((territory) => territories.includes(territory)) : [...territories];
  }
  return allowed || ["worldwide"];
}
