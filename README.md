# ISNN · Overtime Desk

ISNN's overnight sports newsroom. Every night the desk reads the configured publisher feeds, builds a sourced rundown, checks the draft against its sources, and renders a 1080p multi-sport recap with captions and original broadcast graphics, plus one vertical Short per segment. Isaac edits the rundown directly or through chat between midnight and air. At 8:00 a.m. Central, cron submits the current revision to YouTube.

The plan for growing this into the full broadcast lives in [reports/Overtime Desk broadcast upgrade.md](reports/Overtime%20Desk%20broadcast%20upgrade.md), with the supporting research under [research_notes](research_notes/Overtime%20Desk%20broadcast%20upgrade/).

## Run locally

```bash
npm ci
npm run dev
```

Open [http://127.0.0.1:4320/sports](http://127.0.0.1:4320/sports). Without a research model the desk opens the practice rundown, which supports topic edits, chat commands and a preview render with no model or YouTube account. Narration uses Kokoro on the CPU and downloads its voice (about 300 MB) into `MODEL_CACHE_DIR` on the first render.

```bash
npm test          # desk, ledger, trend, rights, research and production tests with simulated model, feed and YouTube responses
npm run build     # production client bundle in dist/
```

### Offline proof of the show

```bash
npm run render:fixture                      # frozen historical game, Kokoro narration
npm run render:fixture -- --voice none      # placeholder narrator: no model download, runs in CI
npm run render:fixture -- --out proof/      # choose the output folder
```

The fixture command renders a frozen historical game from `server/sports/fixtures/` with local assets only. It makes no model calls and no uploads. It writes `episode.mp4`, one `shorts/segment-NN.mp4` per segment, SRT captions for each cut, `timeline.json`, `credits.json` (claims with evidence IDs), `ledger.json`, `qc.json` (dimensions, codecs, measured loudness, A/V sync, rights fallbacks), a frame contact sheet, a phone-size frame per Short, and the render time and peak memory.

## How an edition is made

- **Midnight Central.** Research reads the feeds, picks one to four stories, cites sources per story and verifies the copy against the excerpts. The script writer turns the included topics into segments, Isaac's takes are attributed separately, and the render worker produces the episode and its Shorts in an isolated process.
- **Between midnight and air.** Isaac can add, include or bench a story, inspect its evidence, change the angle or add a take, directly or through chat. Live edits queue a new render. For a factual topic outside the feeds, add a source URL and a supporting excerpt.
- **8 a.m. Central.** Cron submits the finished, current revision to YouTube. The first attempt starts at 8 a.m. and retries may occur through 8:59 a.m. while the app is running. If the current revision is missing or fails its checks, the desk holds the upload. Once an upload starts, that edition is locked.

## Evidence ledger

Every edition keeps a `ledger.json` next to its `edition.json` under `DATA_DIR/sports`. It holds four records, implemented in [server/sports/ledger.mjs](server/sports/ledger.mjs):

| Record | What it holds |
| --- | --- |
| `SourceSnapshot` | Provider, origin group, URL or record ID, source and retrieval time, version, payload digest, allowed uses and retention class. Identical content from one origin group is one snapshot however many syndicated URLs carry it. |
| `EventVersion` | Canonical game ID, league, competition, season, participants, start time, status, plays and score states, upstream snapshots, and the version it supersedes. |
| `Claim` | Literal text, typed value and unit, player or team, period and clock, as-of time, evidence IDs with exact locators and a supports/contradicts stance, disposition (`supported`, `conflict`, `withheld`, `superseded`), derivation version and review. |
| `RundownRevision` | Ordered stories with stable segment IDs, locked claim IDs, a citation map for the headline and each script block, Isaac's wording, approvals and the package digest. Each segment maps to one Short release item. |

Before any render, the desk locks a revision: every number in a headline or factual narration block must be licensed by a supported claim (or by the event's own date, competition and season), every bound claim must be supported, and a trend segment must point at the canonical story it was scored against. A rundown that fails is refused with the reason shown in the desk, and the render never starts. `credits.json` carries each segment's claims with their snapshot IDs, URLs and locators.

Evidence arrives through a provider-neutral adapter ([server/sports/evidence.mjs](server/sports/evidence.mjs)). The credential-free fixture adapter reads the synthetic slates under `server/sports/fixtures/slates/` (seven nights, 33 fictional games across basketball, football, baseball, hockey and soccer) and makes no network calls; Sportradar or SportsDataIO fit the same port once a contract exists. **Scan slate** in the desk records a coverage state per game (`quiet`, `covered`, `awaiting verification`, `source unavailable`) and turns covered games into pitches with claims. A late West Coast finish is withheld until its final arrives, a contested wire report becomes a conflict that Isaac rules on, and a correction published by the source supersedes the old claim, invalidates the dependent revision, clears the rendered cut and lists the reason under the episode preview. Isaac can also correct a claim directly with a new source URL and locator, or rule on a conflict, from the claims list on each story.

Live, feed-sourced copy goes through the same gate: each cited excerpt becomes a snapshot and each numbered sentence a claim that must find its numbers in one of those excerpts.

## Check trend

**Check trend** on any pitch scores attention against that story's canonical ID ([server/sports/trend.mjs](server/sports/trend.mjs)): surge 0–40, persistence 0–25, independent attention corroboration 0–20 and editorial novelty 0–15, with each missing signal and filtered observation listed. A query must match one of the story's editable aliases and its coverage must connect to the same dated story through a second entity; a shared name alone is a same-name collision and is rejected whatever its traffic. Promotions, retrospective terms, stale observations and repost spikes are filtered. Recommendations are `daily segment` (70–84 with a fresh, persistent signal), `standalone video pitch` (85+ with at least two independent attention sources and original analysis or visual evidence), `watch`, `insufficient evidence` (an unverified story or no canonical ID) and `signal unavailable` (feed failure).

The first provider is the US Google Trending Now RSS export; a fixture adapter serves the tests. Repeated checks keep earlier observations so persistence builds over the night. Isaac locks the episode's core story with **Make core**; one or two cleared angles become a trend segment with its own Short, and the ledger refuses any trend angle that is not airable, not connected to the canonical story, or built on an unverified story. The day's scorecards are available at `GET /api/sports/trend`.

## Rights records

[server/sports/rights.mjs](server/sports/rights.mjs) defines `MediaAsset` (provider ID and version, exact event, people, capture time, dimensions, credit, grant reference, SHA-256, status), `RightsGrant` (licensor, components, channels, surfaces, territories, embargo and expiry window, alterations, retention, AI processing, credit, claim contact, and a reference to the signed grant kept outside the catalog) and `ShotUse` (asset hash, revision, grant version, output and source ranges, event clock, audio choice, overlays, proof claims and fallback). `canUse(asset, grant, surface, channel, territory, plannedAirAt)` is enforced when shots are selected for the episode and each Short, and again inside the render against the actual planned air time. Anything that fails, including a clip filed under the wrong game, an expired or embargoed grant, a revoked asset or a long-form-only grant on a Short, falls back to the original **Play diagram** plate, and the reason is written to `timeline.json`, `credits.json` and the QC warnings. The operator catalog lives at `DATA_DIR/sports/rights.json` (`{ "assets": [], "grants": [] }`); the fixture slates carry their own pilot catalog.

## Schedule and accounts

1. Configure `SPORTS_LLM_URL`, `SPORTS_LLM_MODEL` and, for a hosted model, `SPORTS_LLM_API_KEY`. Use a model that reliably follows structured editorial instructions. To choose coverage, set `SPORTS_FEEDS` to a JSON array of up to eight `{ "publisher", "url" }` objects. Set `SPORTS_TIMEZONE` to change the IANA time zone.
2. Set `SPORTS_DESK_PASSWORD` for access outside the app host, and use the desk over HTTPS on your configured `PUBLIC_URL`. Isaac signs in as `isaac` by default. Keep one app instance writing to the same persistent `DATA_DIR`. Editions live in `DATA_DIR/sports`.
3. Enable YouTube Data API v3 and obtain an offline OAuth refresh token for the ISNN channel with the `https://www.googleapis.com/auth/youtube.upload` scope. In Google's OAuth Playground, register the Playground redirect URI on your web OAuth client and use **Use your own OAuth credentials** to authorize the channel and exchange the authorization code. Set `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET` and `YOUTUBE_REFRESH_TOKEN`. Set `SPORTS_PUBLISH_ENABLED=true` to start uploads, and choose `YOUTUBE_PRIVACY_STATUS` (`public` by default, or `unlisted` or `private`). [Google OAuth Playground](https://developers.google.com/oauthplayground/), [YouTube upload reference](https://developers.google.com/youtube/data/reference/rest/v3/videos/insert).
4. Install the entry in [deploy/sports.crontab](deploy/sports.crontab) with `crontab -e` on the Compose host. It calls the app each minute, and the app uses `SPORTS_TIMEZONE` for midnight and the 8 a.m. upload window regardless of the host cron time zone. For a bare Node install, use `* * * * * cd /absolute/path/to/isnn && /absolute/path/to/node scripts/sports-cron.mjs`.

## Deploy

[deploy/docker-compose.yml](deploy/docker-compose.yml) runs the desk from `/opt/isnn` on port 4320 with the handoff's two-vCPU, 1,800 MB budget. [deploy/isnn.conf](deploy/isnn.conf) is the Apache vhost and [deploy/server-deploy.sh](deploy/server-deploy.sh) the pull-and-rebuild script for a forced-command deploy key. Replace `isnn.example.com` with the desk's hostname in both the compose file and the vhost. The GitHub workflow runs tests, the build and the offline fixture render on every push; it does not deploy.

## Open items with an owner

| Item | Owner | Next action |
| --- | --- | --- |
| Desk hostname, TLS and `PUBLIC_URL` | Roger | Pick the ISNN hostname, point DNS at the host, run certbot, set it in `deploy/` and `.env`. |
| YouTube channel OAuth client and privacy policy page | Isaac | Create the ISNN Google Cloud project and channel; Google's consent screen needs a privacy policy URL, which this repo no longer serves. |
| Research model and feeds | Isaac | Choose the model endpoint and the publisher feed list for the first shadow nights. |
| Structured NBA data, footage and music rights | Isaac | Inquiries described in the handoff report; the desk runs on fixtures until agreements exist. |
