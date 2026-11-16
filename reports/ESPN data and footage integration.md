# ESPN data, assets, and footage

**Status: plan for review. No code in this change.**
**Implementation owner: the next agent. Editorial owner: Isaac. Host and desk owner: Roger.**
**Decisions locked 2026-11-15 by Roger:**

- The overnight scan covers **NBA, NCAA, and MLB**. NFL, NHL, WNBA, and soccer stay in the league table and stay off.
- **NCAA** means men's college basketball, which was verified live, plus college football and women's college basketball after the same scoreboard call returns 200. If Roger meant men's basketball only, leave the other two off.
- Cached ESPN logos and headshots **do not air**. Plates stay original ISNN graphics. A still is composited only after a rights grant covers it.
- ESPN and YouTube footage is **discovered and reviewed, not downloaded**. Bytes enter a render only from an operator-supplied file that already passes the existing rights check.

Re-read the working tree before editing. On 2026-11-15 these files were dirty with sport, league, and team tagging, and another agent was still wrapping that work: `client/sports/App.jsx`, `client/sports/style.css`, `server/sports/desk.mjs`, `server/sports/routes.mjs`, `server/sports/sample.mjs`, `test/sports-newsroom.test.mjs`. Build on that shape. Do not revert it.

The broader show this has to fit is [Overtime Desk broadcast upgrade.md](Overtime%20Desk%20broadcast%20upgrade.md). This plan replaces the "wait for Sportradar" data source with ESPN's public scoreboard. It does not replace the evidence ledger or the rights gate.

## Outcome

With `SPORTS_EVIDENCE=espn`, the desk wakes up, reads yesterday's NBA, NCAA, and MLB finals from ESPN, pitches a few verified stories whose numbers are claims, and renders the 1080p episode and one Short per segment on original scorebug and stat plates. Logos and headshots sit in a cache. Highlight clips sit in the story card as references Isaac can approve. Nothing is uploaded during tests. With the variable unset, the desk stays on the fixture adapter and makes no ESPN calls.

One unavailable league, game, image, or clip must not stop the morning show.

## Do not implement

These are constraints, not leftovers.

- Do not call `watch.auth.api.espn.com` or any Brightcove auth URL. Do not download ESPN CDN video, including paths under `espnmedia-cdn.akamaized.net`. Highlight JSON carries those URLs. Store the public clip page and the metadata. Leave the media URLs unread.
- Do not add yt-dlp, youtube-dl, or any other YouTube downloader. Do not scrape YouTube pages for stream URLs. A public YouTube URL, if one is matched later, is a reference string.
- Do not put an ESPN logo, headshot, or thumbnail on the episode, the Short, or the thumbnail until `canUse` accepts that still for that surface.
- Do not mark the ESPN adapter's contract as allowing `display`, `model`, or `archive` of ESPN's articles, images, or video. Facts in the normalized game may be verified and spoken. ESPN's prose, artwork, and footage may not.
- Do not send odds, the pick center, or against-the-spread fields into the ledger, the script, or the plate. Drop them on ingest.
- Do not publish to YouTube from a test, a smoke command, or a proof render.
- Do not rewrite `research.mjs`, the YouTube uploader, the ledger record types, or the fixture render. Extend them at the hooks named below.

Fair use is not a grant. Adding a bug, a voiceover, a crop, or a shorter in-out does not clear a clip. The pipeline must not claim it can prevent Content ID matches, takedowns, or strikes.

## What the code does today

`SportsDesk` in `server/sports/desk.mjs` is the orchestrator. Cron hits `POST /api/sports/cron` every minute. Before 8:00 a.m. Central, `tick` researches and builds. At 8:00 a.m. it uploads. After that the tick returns. Once an upload session exists, the edition is locked.

The evidence port is `server/sports/evidence.mjs`. An adapter exposes `name`, `capabilities`, `contract`, `listGames({ date, asOf })`, and `gameEvidence(gameId, { asOf })`. `scanSlate` writes snapshots, an event version, and claims, then returns coverage. `SportsDesk.scanSlate` turns a game that has a story into a topic. In the working tree that topic already receives `sport`, `league`, and `teams` as `[away.name, home.name]`. Covered topics are selected. A late final is withheld. A source correction supersedes the claim, clears the rendered cut, and shows the reason.

`bindEvidence` refuses `lockRevision` unless every number in a headline or factual narration block is licensed by a supported claim, or by the event's date, competition, and season. Feed copy that has no typed claims goes through `deriveClaims`, which requires each number to appear in a cited excerpt.

`writeLive` sends only topics that lack `topic.script` to the model. Scanned topics already carry a script and skip the model. `queueBuild` still refuses every non-practice build when no research model is configured. That check has to narrow, or an ESPN scan cannot render without a model.

`planShots` and `enforceShots` in `server/sports/rights.mjs` choose a `ShotUse` only when `canUse` passes for the channel, surface, territory, and planned air time. Anything else is `{ kind: "Fallback", fallback: "Play diagram" }`. The renderer records that decision and does not open a video file. `renderEpisode` in `server/sports/produce.mjs` draws one PNG plate per segment, narrates with Kokoro, encodes a 1920×1080 episode and a 1080×1920 Short per segment, and writes `timeline.json`, `credits.json`, and `qc.json`. Credits still say the package contains original plates and no game footage.

Practice mode is the edition used when no research model is configured. `npm run render:fixture -- --voice none` renders `server/sports/fixtures/finals-2016-game7.json` with no network and no upload. That command has to keep doing that.

Deployment budget is two vCPUs and 1,800 MB, set in `deploy/docker-compose.yml`.

## Endpoints that answered on 2026-11-15

Read-only GETs, no API key. Re-verify anything marked unverified before relying on it. Do not invent a path that 404s.

Scoreboard, verified:

`https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard?dates=YYYYMMDD`

| League | Path | Check |
| --- | --- | --- |
| NBA | `basketball/nba` | `dates=20261114` returned 5 finals, including event `401909980`, Denver Nuggets at New Orleans Pelicans, 116–108 |
| Men's college basketball | `basketball/mens-college-basketball` | `dates=20261114&limit=20` returned 2 events |
| MLB | `baseball/mlb` | `dates=20261114` returned 0 events and HTTP 200. Empty is a quiet league |
| College football | `football/college-football` | Not requested yet. Enable only after a 200 |
| Women's college basketball | `basketball/womens-college-basketball` | Not requested yet. Enable only after a 200 |
| NFL | `football/nfl` | 0 events on the 14th, 12 on `dates=20261115`. In the table, off by default |
| NHL | `hockey/nhl` | 14 events on the 14th. In the table, off by default |
| WNBA | `basketball/wnba` | 0 events on the 14th. Off by default |
| Premier League | `soccer/eng.1` | 0 events on the 14th. Off by default |

Game detail, verified for `401909980`:

`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event={id}`

Top-level keys include `boxscore`, `plays`, `leaders`, `injuries`, `standings`, `news`, `header`, `article`, `videos`, `winprobability`, `pickcenter`, `odds`, `againstTheSpread`. Drop the last three before the payload is stored. `plays` on that game had 511 entries. Fetch a summary only for a shortlisted game, not for every game on the slate.

Box score shape: `boxscore.players[].statistics[]` has `labels`, `names`, and `athletes[].stats` as parallel arrays. Labels on that game were `MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, +/-`. Team stats use names such as `threePointFieldGoalsMade-threePointFieldGoalsAttempted=4-16`. Parse the made and attempted sides. Do not treat the string as one number.

Scoreboard event shape that mattered:

- `events[].id`, `date`, `name`, `shortName`, `season`, `status`
- `competitions[0].status.type.name` was `STATUS_FINAL`, `state` `post`, `completed` true, `detail` `Final`
- `competitors[]` has `homeAway`, `winner`, `score`, `linescores`, `records` (`total=4-10`), `leaders`, and `team` (`id`, `abbreviation`, `displayName`, `color`, `alternateColor`, `logo`, `logoDark`)
- `leaders` on the competitor included `points: Nikola Jokic = 26`
- `highlights[]` and `headlines[]` are present
- Event links are human pages: summary, box score, highlights, play-by-play, recap on `www.espn.com`. Those pages are the source URLs to store

Other verified calls:

| Need | URL | Note |
| --- | --- | --- |
| Teams | `.../basketball/nba/teams` and `.../teams/7` | Denver is team `7` |
| Roster | `.../teams/7/roster` | 17 athletes on that call |
| Player | `https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}` | Identity and headshot |
| Player season line | `https://site.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/{id}/overview` | Labels included `GP, MIN, FG%, 3P%, FT%, REB, AST, BLK, STL, PF, TO, PTS` |
| Standings | `https://site.api.espn.com/apis/v2/sports/basketball/nba/standings` | About 165 KB. Site v2 `/standings` is **404** |
| News | `.../basketball/nba/news?limit=5` | Headlines only. Do not paste article bodies into narration |
| Leaders | `https://site.web.api.espn.com/apis/site/v3/sports/basketball/nba/leaders` | About 2.4 MB. Site v2 `/leaders` is **404** |
| Leaders, smaller | `https://sports.core.api.espn.com/v2/sports/basketball/leagues/nba/leaders?limit=5` | Reference style (`$ref`). Prefer per-game leaders from the scoreboard and summary |

Logo file that was actually fetched: `https://a.espncdn.com/i/teamlogos/nba/500/den.png` is a 500 px PNG, IHDR color type 6 (RGBA), about 81 KB. The scoreboard's `team.logo` field pointed at the `/scoreboard/` variant instead. Prefer the 500 px RGBA path when caching, and still do not composite it.

Headshot field on a box-score athlete: `athlete.headshot.href`, shaped like `https://a.espncdn.com/i/headshots/nba/players/full/{id}.png`.

Highlight object on that Nuggets game: `source` is `espn`, `duration` is 73, plus `geoRestrictions` (a country whitelist that included the US), `timeRestrictions` (`embargoDate`, `expirationDate`), a thumbnail on the ESPN media CDN, and links whose playback hrefs are on the authenticated watch host. Summary `videos[]` uses the same object. One entry was a 15-second clip headed "Aaron Gordon gets the basket plus the foul". Discovery stores id, headline, duration, thumbnail URL, the public page `https://www.espn.com/video/clip/_/id/{clipId}`, geo whitelist, and embargo and expiration. It does not store or fetch the playback href.

`https://www.youtube.com/feeds/videos.xml?channel_id=UCiWLfSweyRNmLpgEHekhoAg` returned 404 to a plain request. Do not depend on it. Game identity comes from the ESPN event id already on the summary.

Status names still need a frozen example for anything other than `STATUS_FINAL`. Confirm `STATUS_SCHEDULED`, `STATUS_IN_PROGRESS`, and `STATUS_POSTPONED` from a real response, or from ESPN's documented status list if a live non-final game is unavailable. Map unknown statuses to `awaiting verification` rather than to `final`.

These endpoints are unauthenticated and undocumented. They can change or go away. ESPN's terms restrict automated collection and reuse. The adapter is opt-in, caches aggressively, and identifies itself with a descriptive User-Agent. Turning `SPORTS_EVIDENCE` off is the kill switch.

## Date window

The edition date is the Central morning of the broadcast. `tick` loads that date. At 12:30 a.m. Central on 15 November, the games to recap are the ones that started the previous evening.

The Nuggets tip is the proof. It is on `dates=20261114` and its event timestamp is `2026-11-15T00:00Z`, which is 6:00 p.m. Central on 14 November. Querying ESPN with the edition date would select Sunday's unplayed slate and miss Saturday night.

Window for edition date `D`, in `America/Chicago` unless `SPORTS_TIMEZONE` overrides it:

- Start: 06:00 local on `D - 1 day`
- End: 08:00 local on `D` (air time)

Request both ESPN calendar dates, `D - 1` and `D`. Keep a game when its start instant falls inside the window. Pitch a result only when the mapped status is `final`. An in-progress game inside the window is `awaiting verification` and is rescanned on the existing 15-minute overnight retry until it is final or the 8:00 a.m. hour begins. A postponed game is listed with that reason and is not a result story. A scheduled game outside the window is ignored.

Every claim and script line carries the game's own start date. The edition date and the game date are different fields and must stay different in tests.

## Normalized game

Map ESPN into the object `ingestGame` already consumes. Do not add a second scan path.

Required shape, matching `gameSchema` in `server/sports/fixtures.mjs` except that live ids are ESPN event ids (digits) so the id pattern in the fixture schema must not be forced onto live games:

- `id`: ESPN event id as a string
- `league`: `NBA`, `NCAAB`, `NCAAW`, `NCAAF`, or `MLB`
- `sport`: `basketball`, `football`, or `baseball`
- `competition`: season display name plus a plain label, such as `NBA regular season`
- `season`: from the event, such as `2026-27`
- `home`, `away`: `{ id, name, short }` where `short` is the ESPN abbreviation
- `startTime`: ISO timestamp from the competition
- `status`: `scheduled`, `in-progress`, `final`, or `postponed`
- `scoreStates`: from linescores, last entry is the final when the game is final
- `plays`: only the scoring plays, or a short list of major plays, from the summary. Cap what is stored. Do not persist all 511 plays on every shortlisted game unless a claim needs one of them
- `leaders`: `{ player, team, stats }` parsed through the label row
- `reports`: one box-score snapshot whose `sourceUrl` is the public ESPN box-score page, `provider` `espn`, `originGroup` `espn-{league}`, `excerpt` a short factual line the desk wrote from the numbers, `payload` the normalized game with odds removed
- `story`: headline, narration, and claims, produced by the ranker for a game that makes the rundown. Games that do not make the rundown still return coverage and do not need a story
- `media`: `{ assets: [], grants: [] }` until an operator file is attached. Image cache records are not media assets, because they have no grant

Claims use the existing fields: `key`, `text`, `value`, `unit`, `subject`, `period`, `clock`, `asOf`, and `evidence` with a locator. Locators are paths into the stored payload, for example `score.home`, `score.away`, `leaders.points`. `asOf` is `final` only when the status is final. A non-final result claim is withheld by the rule already in `ingestGame`.

`scoreAssociation` must still hold. A final-score claim names the winner and both numbers as the event records them.

Coverage stays the existing set: `quiet`, `covered`, `awaiting verification`, `source unavailable`. A final with a story whose claims are all supported is `covered`. A game still going is `awaiting verification`. A failed league fetch is `source unavailable` for that league and does not fail the scan.

## Ranker

Deterministic. The model does not invent the list or the numbers.

Score every final inside the window. Suggested order, highest tier first, then the raw margin or counting stat as the tie break:

1. Overtime. Detect it from the status detail or from a period after regulation. Confirm the field on a real overtime game before shipping the tier. If the field is missing, skip the tier rather than guess.
2. Margin of 3 or fewer in the sport's scoring unit (points or runs).
3. Upset. Winner's win percentage, from the `total` record on that competitor, is lower than the loser's. Ignore records that are missing or not `W-L`.
4. Highest points by one player on the slate. Basketball uses the points leader. Baseball uses the closest equivalent that the box score actually labels, and omits the tier if the label is absent.
5. Most made three-pointers by one team, from the team stat name above. Basketball only.
6. A league-leading line, only when a leaders category was fetched and the player's game stat is that category's leader. Do not call the 2.4 MB leaders document unless a pitch needs this tier.

Take the top four covered games as included topics. Further covered games stay on the slate, unselected, so Isaac can add one. Cap remains `maxTopics` (12).

Headline and narration are templates filled from claims. Name the game date, both teams, the winner, the score, and the one leader the tier used. Keep a segment inside the existing narration limit (the fixture schema caps a story at 750 characters and the writer aims for 35 to 75 spoken words). No betting language, no "buzzing", no claim that a record was broken unless a structured field says so.

If `SPORTS_LLM_URL` is set, the model may paraphrase that narration. Run the existing number check against the claim texts. If the paraphrase adds a number, keep the template. Isaac's take is appended by the desk as it is today, attributed, and is not evidence.

## Client behavior

One shared client in `server/sports/espn/client.mjs`.

- Opt-in. Constructed only when `SPORTS_EVIDENCE=espn`.
- One request at a time, plus a short gap (200 ms is enough).
- Three tries, exponential backoff, on 429 and 5xx and network errors. A 404 on a known-optional path is a recorded miss, not a retry storm.
- Cache GET bodies under `DATA_DIR/sports/cache/espn/`, keyed by URL and a digest. Final scoreboards and final summaries can live for the rest of the edition. An in-progress scoreboard expires after 2 minutes. Player and team documents expire after 12 hours.
- Timeout around 15 seconds so one hung call cannot pin the tick.
- User-Agent `ISNN-Overtime-Desk`.
- Never follow a link whose host is `watch.auth.api.espn.com`.
- Strip `odds`, `pickcenter`, and `againstTheSpread` before writing a cache file that will become a ledger payload.

`listGames` reads scoreboards only. `gameEvidence` reads the cached scoreboard row and, for a shortlisted id, the summary. A summary failure leaves the scoreboard row in place and sets that game to `awaiting verification` or `source unavailable` with the reason. The other games still return.

## Assets

`server/sports/assets.mjs`. Root is `DATA_DIR/sports/assets/`, gitignored. Layout:

```text
data/sports/assets/
  nba/teams/{espnTeamId}.png
  nba/players/{espnPlayerId}.png
  ncaab/...
  ncaaf/...
  ncaaw/...
  mlb/...
```

Each file has a sidecar JSON: source URL, SHA-256, byte length, width, height, retrieved time, league, entity id, `licenseStatus: "unlicensed"`, and `grantId: null`. The same hash is not stored twice. A non-image body, a tiny file, or a decode failure is recorded as a miss and the plate still renders.

Resolve logos from `https://a.espncdn.com/i/teamlogos/{espnLeague}/500/{abbr}.png` after checking that path answers for NBA. Confirm the college and MLB logo path with one HEAD or a small GET during implementation. If a league path 404s, skip the cache for that team.

Resolve headshots from the `headshot.href` on the athlete, and only for players who appear in a pitched leader line. Do not roster-crawl the league.

Default cache cap is 500 MB for images. `SPORTS_ASSET_CACHE_MB` overrides it. Cleanup deletes unreferenced files older than 14 days when the cap is exceeded. Referenced means a current edition's ledger or footage record names the hash.

These files are not `MediaAsset` rows and `planShots` does not see them. The day a grant exists, an operator record in `DATA_DIR/sports/rights.json` can point at the same hash. Until then the plate uses abbreviations and the team colors as hex values, which are facts about the paint, drawn by our code.

## Footage records

`server/sports/footage.mjs` stores discovery next to the edition, not inside the aired package.

For each pitched game, candidates come from `competitions[0].highlights` and `summary.videos`, already tied to that event id. Fields: clip id, event id, headline, duration, thumbnail URL, public clip page, geo whitelist, embargo, expiration, source `espn`. Reject a candidate whose headline names a team that is not on the game. Same-name collisions are the desk's existing standard.

Isaac, on the story card, can mark a candidate `approved` or `rejected` and can set in and out seconds. Suggested length is 8 seconds. Hard cap is 15 seconds. The full highlight is never the suggestion. Approval writes the decision and the timecodes. It does not fetch media.

The only ingest path is an operator file dropped for that event, with a grant already valid for `canUse`. Ingest probes the file with the existing `probe` helper, checks codec and duration, hashes it, and creates a `MediaAsset` bound to the event id, the grant, and the approved source range. A file that fails probe is quarantined. Audio follows the grant: if the grant has no `audio` component, the shot stays muted, which `canUse` already returns.

Cache cap for dropped footage defaults to 2 GB, `SPORTS_FOOTAGE_CACHE_MB`. Cleanup follows the same 14-day unreferenced rule. Do not delete a file named by the current edition's render.

YouTube, if added in a follow-up, is a title match against a verified channel RSS: both team nicknames and the game date must appear, or the item is discarded. Store the watch URL. Do not resolve it to media.

## Renderer

Keep the plate as the picture for every segment. Extend `drawChapter` and `drawShort` with:

- A scorebug: away abbreviation, away score, home abbreviation, home score, and the game date in Central.
- Team colors as the two chips behind the abbreviations. Colors come from the ESPN hex fields. If a color is missing, use the existing lime and white.
- The leader line from the claims, for example `Jokic 26 PTS, 8 REB, 10 AST`.
- A source line: `Source: ESPN box score` plus the public box-score host, not a copied recap sentence.
- The play diagram when the segment already has one.

Both 1920×1080 and 1080×1920 get the same facts, with the Short's type sized for a phone. Captions, narration timing, loudness, and A/V sync stay on the current path. House target remains −16 LUFS ±1 and ≤ −1 dBTP.

When a segment has a `ShotUse` that still passes `enforceShots`, build a 960×540 muted proxy of the approved range and overlay it in the plate's diagram well for that range only. One clip at a time. If the proxy, the overlay, or the memory fails, encode the still plate and add the existing rights warning. Do not fail the episode.

Update the credits `graphics` line so it describes what that render actually used. A plate-only render keeps the current sentence. A render that composited a granted clip says so and points at the `ShotUse`.

`PACKAGE.version` in `produce.mjs` bumps when the plate layout changes, so old timelines stay identifiable.

## Desk wiring

- `SportsDesk` gains the ESPN adapter when `SPORTS_EVIDENCE=espn`. Default remains `FixtureEvidenceAdapter`.
- `settings` exposes `evidenceProvider` (it already does) and the league list.
- `tick`, while the hour is before 8 and the edition is editable and the provider is ESPN, calls `scanSlate` on the same retry budget research already uses. A scan failure is logged and does not abort the tick.
- After a scan, RSS research still runs only when a model and feeds are configured, and only to fill topics that are not already tied to an `eventId`. It must not duplicate a game already pitched.
- `queueBuild`: if every selected topic has a `script` or a non-empty `take`, build without a research model. Keep the current error when a selected topic has neither.
- Routes stay as they are for scan, topic edits, claims, and chat. Add a small footage route only if the story card needs it: list candidates, set approval and in-out, attach a local file path that the server checks is inside the footage cache. Reject a path outside that directory.
- The story card shows sport tags (already in the working tree), the coverage reason, the claim list, and the clip candidates with duration and the public page. Approve and reject are buttons. There is no download button.
- Scan slate in the header keeps working for the fixture adapter and for ESPN.

Structured log lines, one JSON object per line, for each ESPN request (league, path, status, duration, cache hit), each scan (edition date, games, covered, withheld, failed leagues), and each render fallback. No payloads in the log.

## Config

Add to `.env.example` and the README schedule section:

```bash
# SPORTS_EVIDENCE=espn
# SPORTS_ESPN_LEAGUES=nba,ncaab,mlb
# SPORTS_ASSET_CACHE_MB=500
# SPORTS_FOOTAGE_CACHE_MB=2048
# SPORTS_ESPN_USER_AGENT=ISNN-Overtime-Desk
```

`ncaaf` and `ncaaw` are accepted tokens and omitted from the default until their scoreboards are verified. Document the footage rule in the README in plain language: ESPN clips are references, and only a granted local file can be composited.

`.env` itself is not a deliverable. Do not commit secrets or turn on publish.

## Tests

Frozen responses live in `test/fixtures/espn/`. Trim them. Keep one NBA final (the Nuggets game is the obvious capture), one men's college basketball scoreboard row, one empty MLB scoreboard, one summary box score with the label row, and one highlight object with playback hrefs removed. Tests load these files through the adapter. `npm test` must not open a socket. Give the client a `fetchImpl` the way research tests already do, and also a fixture mode that never calls `fetch`.

Cover at least:

- Normalization of the Nuggets game: status final, 116–108, winner Denver, Jokic 26/8/10, both team ids, Central game date distinct from a 15 November edition date.
- The date window drops a game that starts after 8:00 a.m. Central on edition morning and keeps the 6:00 p.m. Central tip from the night before.
- Odds keys are absent from the stored payload.
- A non-final game does not become a covered result.
- An empty MLB scoreboard yields zero games and a successful scan.
- A 500 from one league yields `source unavailable` for that league and pitches from the leagues that returned.
- The ranker emits claims whose numbers match the payload, and `lockRevision` accepts the story.
- A paraphrase that introduces a new number is discarded.
- The asset cache writes one file for two requests of the same URL and records `unlicensed`.
- A highlight candidate stores the public clip page and has no playback host in the saved record.
- `planShots` still falls back when the only visuals are unlicensed cache files.
- `planShots` uses a granted local file bound to the same event and falls back when the file's `eventId` differs.
- `render:fixture -- --voice none` is unchanged and contacts no host.
- A plate render of the frozen Nuggets story, with the placeholder narrator, produces a 1920×1080 segment and a Short, and the credits name the ESPN box score. This can be a focused test or a documented `node` script under `scripts/` that writes to a gitignored folder. It does not upload.

Existing commands that must stay green:

```bash
npm test
npm run build
npm run render:fixture -- --voice none
```

Add `npm run espn:smoke` as a manual read-only script. It requests the NBA scoreboard for yesterday in Central, prints event ids, matchups, and statuses, and exits. It does not write an edition, render, or upload. Run it once if the network is available and paste the counts into the handoff. Skip it in CI.

## Files

New:

- `server/sports/espn/client.mjs`
- `server/sports/espn/normalize.mjs`
- `server/sports/espn/rank.mjs`
- `server/sports/espn/adapter.mjs`
- `server/sports/assets.mjs`
- `server/sports/footage.mjs`
- `test/fixtures/espn/` with the trimmed captures
- `test/sports-espn.test.mjs`
- `scripts/espn-smoke.mjs`

Edit, narrowly:

- `server/sports/desk.mjs` for adapter selection, the overnight scan, and the scripted build check
- `server/sports/produce.mjs` for the scorebug, the leader line, the conditional proxy, and the credits line
- `server/sports/routes.mjs` and `client/sports/App.jsx` for footage review on the story card
- `.env.example`, `README.md`, and `.gitignore` for `data/sports/assets/` and `data/sports/cache/`

Leave `server/sports/research.mjs`, `server/sports/youtube.mjs`, `server/sports/ledger.mjs`, and `scripts/render-fixture.mjs` alone unless a test proves a one-line hook is required. If the number check has to be reused, export the existing helper instead of copying it.

## Order of work

1. Client, cache, and frozen fixtures. No desk wiring. Tests for fetch, retry, and the 404 standings path.
2. Normalize and rank. Lock a revision from the Nuggets fixture through the real ledger.
3. Adapter behind `scanSlate`. Desk flag. Date-window test. Failure isolation.
4. Asset cache. Confirm logo paths for `nba`, `mlb`, and men's college basketball. Unlicensed sidecars.
5. Plates. Placeholder-narrator render of the frozen story. Credits and QC.
6. Footage records and the story-card review. Public URLs only. Granted-file ingest covered by the existing rights tests plus one new case.
7. Proxy overlay, only after the plate render is green. Fallback if the proxy fails.
8. README, `.env.example`, smoke script, then `npm test`, `npm run build`, and `npm run render:fixture -- --voice none`.

## Handoff notes for the reviewer

Confirm or correct these before implementation, and say which you checked against the live code rather than against this file:

- The dirty sport, league, and team tagging is the topic shape to keep. If that work landed differently, follow the code.
- `queueBuild`'s model requirement is the gate that blocks a scripted ESPN lineup. The narrow fix is described above.
- College football and women's college basketball were not requested during planning. Verify the paths, then add `ncaaf` and `ncaaw` to the default list, or leave them documented and off.
- Overtime detection needs a real ESPN field. Do not ship a guessed one.
- Non-final status names need one real sample.
- MLB logo and headshot URL patterns need one real sample. NBA's patterns are verified.
- The highlight playback host must stay out of saved records. If a reviewer thinks a progressive-download URL is "just a file on a CDN", that is the line this plan already drew.
- Memory: a summary with hundreds of plays plus Kokoro plus FFmpeg is the risk on the 1,800 MB box. Shortlist first, cap stored plays, and proxy one clip at a time.

## Implementation log

Kept by the implementing agent. Check items off as they land; a later agent picks up from the first unchecked item. Commits are on `main`, not pushed.

### Verified against live ESPN responses on 2026-11-15 (23:30 Central)

- College football `football/college-football` and women's college basketball `basketball/womens-college-basketball` scoreboards both returned 200 with finals for `dates=20261114`. Per Roger's decision, `ncaaf` and `ncaaw` join the default league list.
- Status names seen: `STATUS_FINAL` (`state: "post"`, `completed: true`) and `STATUS_SCHEDULED` (`state: "pre"`, `period: 0`, `detail: "Mon, November 16th at 7:00 PM EST"`). In-progress and postponed were not on any probed scoreboard; the normalizer maps `state: "in"` to `in-progress`, a name containing `POSTPONED`/`CANCELED` to `postponed`, and anything unknown to `awaiting verification` through `in-progress`.
- Overtime field: `competitions[0].status.type.detail` is `"Final/OT"` and `status.period` exceeds regulation (NY @ TOR `401909990`, period 5; NMSU @ MOST `401870796`, period 5). `linescores` length matches the period count. The overtime tier can ship.
- MLB scoreboard `dates=20261114` and `dates=20261025`: 200 with zero events (offseason). Empty is a quiet league.
- Summary `401909980`: keys include `odds`, `pickcenter`, `againstTheSpread` (dropped on ingest); `plays` 511 with 128 `scoringPlay: true`; `videos` 9 with `geoRestrictions`, `timeRestrictions` and playback links on the watch host (never stored); box-score labels `MIN, PTS, FG, 3PT, FT, REB, AST, TO, STL, BLK, OREB, DREB, PF, +/-`; team stats such as `threePointFieldGoalsMade-threePointFieldGoalsAttempted = "4-16"`.
- Image paths that answered 200 `image/png`: `teamlogos/nba/500/den.png` (81 KB), `teamlogos/mlb/500/nyy.png`, `teamlogos/ncaa/500/{teamId}.png` (college logos key on the numeric team id, not the abbreviation), `headshots/nba/players/full/{id}.png`, `headshots/mlb/players/full/{id}.png`.
- Raw captures are kept outside the repo; trimmed copies go to `test/fixtures/espn/`.

### Steps

- [x] 1. Client, cache, frozen fixtures (`server/sports/espn/client.mjs`, `test/fixtures/espn/`). Fetch, retry, cache, and the site-v2 standings 404 are covered in `test/sports-espn.test.mjs`. Playback hosts and odds are scrubbed before the cache write.
- [x] 2. Normalize and rank (`normalize.mjs`, `rank.mjs`). The Nuggets fixture locks through the real ledger: final 116–108, Denver, Jokic 26/8/10, game date November 14 against a November 15 edition. The threes tier runs only when that team stat is already on the game; summaries are fetched for the shortlist and do not reshuffle it.
- [x] 3. Adapter behind `scanSlate`, `SPORTS_EVIDENCE=espn`, date window, failure isolation, overnight scan in `tick`, scripted build without a model. One league returning 500 stays `source unavailable`. A summary failure withholds that game. The newsroom test builds the scripted cut with no research model.
- [x] 4. Asset cache (`server/sports/assets.mjs`) with unlicensed sidecars. NBA and MLB logos use the abbreviation; college logos use the numeric team id. A pitched basketball leader's headshot is cached from `headshot.href` only. The same hash is stored once. `planShots` still falls back because the sidecar is `unlicensed` and `grantId` is null. The cache runs only when `SPORTS_EVIDENCE=espn`, and a cache failure does not drop the slate.
- [x] 5. Scorebug and leader plates, credits line, `PACKAGE.version` bump. The plate draws team chips (abbreviation, score, team colors), the leader line and the source panel; `PACKAGE` is `wellspring-media-sports` v10. The anchor nameplate is a timed opening lower third (`ANCHOR_WINDOW` in `produce.mjs`, overlaid for 0.3–3.4 s on the episode and 0.3–1.9 s on each Short) rather than a static part of the bug; `test/sports-production.test.mjs` checks it appears and leaves. Note for Roger: the working tree that landed between sessions paints cached ESPN team marks and player headshots onto plates through `data/sports/assets/manifest.json` (`server/sports/marks.mjs`), which departs from the locked decision that cached ESPN logos do not air. Left as found; decide whether the manifest stays empty until a grant exists.
- [x] 6. Footage records and story-card review. ESPN highlights discovered on the event (`clipsFrom` in `normalize.mjs`) ride through `ingestGame` as `discovery` and land on the topic as `clips`: public page, duration, embargo, expiry, geo list. Isaac approves a source range (8 s suggested, 15 s cap) or rejects via `POST /api/sports/topics/:id/clips/:clipId`; decisions survive a rescan; no playback host is stored and nothing is fetched. Granted-file ingest is the operator drop described in README under Game footage (`operatorFootage` in `footage.mjs`). The working tree also carries a Wikimedia Commons CC0/CC BY footage finder (`CommonsFootage`), which is outside this plan.
- [x] 7. Proxy overlay. `prepareFootage` / `footageFilters` in `produce.mjs` cut the approved range of a granted local file and overlay it in the plate well for that range only; a failed probe or overlay leaves the plate and records the rights warning.
- [x] 8. README ("ESPN scoreboard as the evidence source"), `.env.example`, `.gitignore` (`data/sports/assets/`, `data/sports/cache/`), `scripts/espn-smoke.mjs` as `npm run espn:smoke`. Verification on 2026-11-16: `npm test` 73/73, `npm run build` clean, `npm run render:fixture -- --voice none` renders with no network. `npm run espn:smoke` on 2026-11-16 listed the NBA scoreboard for 2026-11-15: 9 events, 9 finals (one Final/OT), 0 not final.
