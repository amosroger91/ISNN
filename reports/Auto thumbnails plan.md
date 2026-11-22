# Auto thumbnails plan

Handoff for the implementing agent. Goal: every build makes a custom YouTube
thumbnail for the episode and for each Short. The desk uploads each thumbnail
right after its video. Each one shows the real people or teams from that video
and a short, punchy line of text.

## 1. Where things stand
- **Builds:** `renderEpisode()` in `server/sports/produce.mjs` renders the episode
  and one Short per story. The motion renderer (`motion.mjs`, `broadcast.mjs`,
  `imagery.mjs`, `lottie.mjs`; see `reports/Motion B-roll plan.md`) is in the
  tree. During each build it already picks licensed Commons photos per story:
  - `storyImagery(segment, …)` returns photos ranked person first, then team.
    Each photo has `image`, `file`, `credit`, `subject` and `kind`.
  - Their credits go into `footageCredits`.
  - **Reuse those photos.** Don't search again.
- **Colors:** `broadcast.mjs` has `TEAM_COLORS`, `LEAGUE_COLORS` and
  `storyColor(story)`. Export `storyColor` (and the logo-bug drawing, if useful)
  so the thumbnails match the video.
- **Listing:** `server/sports/metadata.mjs` and `writeVideoListing()` in
  `research.mjs` write each video's title, description and hashtags at build
  time. The result is stored at `edition.render.listing`. The model's drafts are
  checked against the aired copy (numbers, plus the fact audit) and fall back to
  headlines. The thumbnail text (2.2) follows the same pattern.
- **Uploads:**
  - `desk.mjs` `startYoutubeUpload(edition, target)` uploads the episode
    (`"episode"`) or a Short (segment number). The slot is then set to
    `status: "published"` with `id` (around line 1284).
  - `youtube.mjs` has the OAuth token helper (`youtubeAccessToken`/`getAccessToken`)
    and `httpError`.
  - The channel token already has the `youtube.upload` scope (README).
    `thumbnails.set` accepts that scope, so no new consent is needed.
- **Rights:** the fixture grant schema already lists a `"thumbnail"` surface
  (`fixtures.mjs`). Same rule as the video:
  - Only CC0, public domain or CC BY photos. **No ShareAlike** (blocked for
    release), and **no ESPN headshots or logos**.
  - Operator footage stills only when the grant's surfaces include `"thumbnail"`.

## 2. What to build

### 2.1 `server/sports/thumbnail.mjs`: drawing
- `drawThumbnail({ kind: "episode"|"short", stories, photos, text, color, date })`
  returns an `@napi-rs/canvas` canvas. Write it out with
  `canvas.encode("jpeg", 88)`, stepping quality down until the file is under
  2 MB (YouTube's limit).
- **Episode, 1280×720 (16:9):**
  - Two or three diagonal panels, each holding the top photo from one of the
    first two or three stories. Prefer `kind: "person"`, and use different
    leagues where possible.
  - Each panel gets a light team-color tint and a 6 px colored divider.
  - **Big text:** the thumbnail line, 2–4 words in uppercase Atkinson Hyperlegible
    Bold. It's at least 120 px tall at 1280 wide, white with an 8 px dark stroke
    and a drop shadow, on the left or bottom third.
  - Small details: the Wellspring Media logo bug (`assets/wellspring-media-logo.png`)
    top-left, a league tag chip, and the date ("NOV 19").
- **Short, 1080×1920 (9:16):**
  - One full-bleed photo: the story's top person photo, cropped to the upper
    third where faces usually are, as the motion renderer does.
  - Huge text in the middle third (2–4 words), a league chip, and the logo bug.
- **Crop:** for portrait photos, keep the top 15–45% band in frame.
- **Readability:**
  - A dark gradient under the text area.
  - The text must stay legible when shrunk to 320×180 (episode) or 180×320
    (Short). Check that each letter height is at least 14 px after scaling;
    otherwise drop to fewer words or a bigger font.
- **No photos available** (offline fixtures, or nobody has a licensed image):
  draw graphics only, with the team or league color field, a Lottie frame from
  `league-burst.json` drawn with `drawLottie` at progress 0.6, and the big text.
  Never output a plain card with only a headline.
- **Seeded randomness:** seed panel angles and photo choice by date plus segment
  id, so a rebuild gives the same thumbnail.

### 2.2 Thumbnail text (2–4 words)
- Extend `writeVideoListing()`, in its schema and prompt, with `thumbnail` per
  video: 2–4 words, no punctuation except `$`, `%`, `-` and `'`.
  - Name a person or team, or a key number from the copy. Examples:
    "BAUERS GETS $58M", "LEBRON FIRES BACK", "DUKE STUNNED".
  - It goes through the same checks as titles: every number must be in that
    story's copy, plus the fact audit.
  - Thumbnail lines must differ from each other within the edition.
- Fallback in `metadata.mjs` `fallbackListing()`: the subject (the first person
  or team in `imagerySubjects`/`footageSubjects`) plus the first number in the
  headline, if any. Otherwise use the headline's first clause cut to 4 words.
  Uppercase it.
- Store it on the listing: `listing.episode.thumbnail` and
  `listing.shorts[i].thumbnail`.

### 2.3 Wiring into the build
- In `renderEpisode()`, after the photos are chosen and the listing text exists,
  draw:
  - `thumbnails/episode.jpg`;
  - `thumbnails/segment-NN.jpg` for each Short, numbered like `shorts/`.
- Order of work:
  - The listing is written in `desk.produce()` after the render, so either move
    `writeListing()` before the render, or draw the thumbnails in `produce()`
    after the listing.
  - Simplest: have `renderEpisode()` return the chosen top photos per story in
    its metadata (paths plus credit). Then `produce()` draws the thumbnails once
    `writeListing()` has run.
- Copy the files into the cut folder next to `episode.mp4`. Record them in
  `edition.render.thumbnails = { episode: "thumbnails/episode.jpg", shorts: { "1": "thumbnails/segment-01.jpg", … } }`
  and in `timeline.json`.
- **QC** (add to `qc.json`; fail the build if any fails):
  - JPEG with exact dimensions;
  - under 2 MB;
  - mean luminance between 40 and 215, so not black or washed out;
  - the text box was drawn.
- Setting: `SPORTS_THUMBNAILS=on` (default on). `off` skips both drawing and
  uploading.

### 2.4 Upload (`youtube.mjs` and `desk.mjs`)
- `youtube.mjs`: add
  `export async function setThumbnail({ videoId, file, signal, fetchImpl = fetch })`.
  - It sends `POST https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=<id>&uploadType=media`.
  - Headers: `Authorization: Bearer <token>`, `Content-Type: image/jpeg`,
    `Content-Length`. The body is the file bytes. Use a 60 s timeout.
  - Check `videoId` against `^[\w-]{11}$`. Read errors with `httpError`.
  - Each call costs about 50 quota units.
- `desk.mjs`:
  - After a slot is saved as `published` in `startYoutubeUpload`'s launched job,
    upload that video's thumbnail if the file exists. Record
    `slot.thumbnail = { status: "set"|"failed"|"unavailable", error, at }`.
  - **A thumbnail failure never changes the video's published status.**
  - **403 handling:**
    - The channel can't use custom thumbnails until it is phone-verified. When
      that is the cause (reason `forbidden`, or text mentioning custom thumbnails
      or verification), set `status: "unavailable"`.
    - Stop trying thumbnails for the rest of that edition (same idea as
      `quotaSpent`), and show the reason in the desk.
  - **Transient errors (5xx, timeout):** `publishShorts`/`tick` retry a `failed`
    thumbnail once, at least 4 minutes later.
  - `quotaSpent` errors also stop thumbnail attempts.
  - Manual button: `POST /api/sports/youtube/thumbnail { date, target }` in
    `routes.mjs`, behind `deskAccess`. It re-sends the thumbnail for an already
    published video.
- **Shorts caveat (check on the first live run):**
  - YouTube's support for custom thumbnails on Shorts set through the API is
    limited and has changed over time.
  - Call `thumbnails.set` for Shorts too, and record the result.
  - After the first morning, check in YouTube Studio whether the Short shows it.
    If YouTube ignores it, stop uploading Short thumbnails (setting
    `SPORTS_SHORT_THUMBNAILS=off`) but keep generating them for the desk preview.
    Write down the finding in this file.

### 2.5 Desk UI (`client/sports/App.jsx`)
- Show each video's thumbnail next to its title in the publish panel. Serve it
  with `GET /api/sports/thumbnail/:date/:revision/:target` behind `deskAccess`,
  validating target as `episode` or a number from 1 to 12.
- Show the thumbnail status: set, failed (with the error), or unavailable (with
  "verify the channel's phone number in YouTube Studio to enable custom
  thumbnails").
- A **Regenerate** button redraws the thumbnails from the current cut without
  re-rendering video. Optional: let Isaac edit the 2–4 word line, which redraws
  and, if the video is already published, re-uploads it.

## 3. Tests (`npm test`)
- `test/sports-thumbnail.test.mjs`:
  - **Episode thumbnail from two fixture photos:** 1280×720 JPEG, under 2 MB,
    luminance in range, and the text box drawn (sample pixels for white text).
    Same seed gives identical output.
  - **Short thumbnail:** 1080×1920.
  - **No photos:** the graphics-only version is still valid and has text.
  - **Shrink check:** a 6-word line falls back to 4 words or a bigger layout.
- `metadata` tests:
  - A thumbnail line with a number not in the copy falls back.
  - Duplicate lines get de-duplicated.
  - The fallback derives subject plus number.
- `youtube` tests, with a fake fetch:
  - `setThumbnail` sends `image/jpeg` with the right `videoId` and bearer token.
  - A 403 "forbidden" is surfaced as unavailable.
- `desk` tests:
  - After the 8 a.m. episode upload, the thumbnail is uploaded and the slot
    records `thumbnail.status === "set"`.
  - A thumbnail failure leaves the video `published`.
  - `unavailable` stops further thumbnail attempts but not Short uploads.
  - Use the existing `fixture()` with an injected `thumbnail` uploader, like
    `upload`.

## 4. Acceptance
1. Build a real edition (desk Build button, or let the overnight run do it).
   `data/sports/editions/<date>/<rev>/cut-*/thumbnails/` holds `episode.jpg`
   and one JPEG per Short.
2. Each thumbnail shows the actual people or teams from that video (or
   graphics, if none are licensed), with a readable 2–4 word line. Any number
   shown is in that story's copy.
3. After the 8 a.m. upload, YouTube Studio shows the custom thumbnail on the
   episode. Record the Shorts result per 2.4.
4. If the channel isn't verified for custom thumbnails, the desk says so
   clearly, and videos still publish.
5. `npm test` is green, apart from any known, documented failures.

## 5. Operating context (do not break)
- The desk runs on this PC as the scheduled task **"ISNN Desk"**:
  - midnight research;
  - overnight build;
  - **8:00 episode upload**, then Shorts through 10:59.
- After code changes, stop the `node server\index.mjs` process and run
  `Start-ScheduledTask "ISNN Desk"`. Restarting changes Isaac's quick-tunnel
  link (`data\tunnel-url.txt`), so tell the owner the new link.
- `.env` holds secrets (YouTube OAuth, desk password). Never print or commit it.
- There is a lot of uncommitted work in the tree. Commit only when the owner asks.
- Use "Wellspring Media Sports" naming, never "The Word".
