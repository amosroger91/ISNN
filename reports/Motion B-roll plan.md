# Motion B-roll plan: real players, constant movement

Handoff for the implementing agent. The goal: every second of the episode and
of every Short is moving, and each story shows the real people and teams it is
about. No still cards with only captions changing.

The owner's words: *"I don't want a boring still clip, I want movement and real
players/people from the teams we're talking about throughout the whole clip...
ASSURE that the video isn't boring/still. I want MOTION AND ANIMATION."* He
asked for anime.js (https://animejs.com/) and diffusionstudio/lottie
(https://github.com/diffusionstudio/lottie).

---

## 1. Where things stand

### The problem, confirmed on real output
Frames from the Nov 18 episode (`data/sports/editions/2026-11-18/1/cut-*/episode.mp4`)
and its Shorts are a static text card: the headline, a "Reporting sources" box,
a faint field diagram and burned-in captions. Only the captions and the progress
bar change. When B-roll plays, it is a Commons clip inset on another static
plate, often a stadium or crowd.

### How the renderer works today (`server/sports/produce.mjs`)
- `renderEpisode()` (around line 979) narrates, then draws **one PNG per chapter**:
  `drawChapter()` (around 521), `drawShort()` (565) and `drawBookend()` (193).
- The PNGs are concatenated with an ffconcat list (`chapters.ffconcat`) and turned
  into video at `FPS = 30`.
- B-roll: `prepareFootage()` (around 895) finds Commons videos (`footage.mjs`
  `CommonsFootage`) and the archive (`footage-archive.mjs`). It cuts each one
  onto a full-frame static plate with ffmpeg. `footageFilters()` overlays those
  cuts on the slides during set time windows.
- Captions are ASS subtitles (`cues()`, `assFile()`) burned in by ffmpeg.
  `visualTeamCues()` times team chips to the narration.
- Encode settings live in `encode` (around 756): x264 `fast`, CRF 18, yuv420p,
  bt709, AAC 192k. Sizes are `EPISODE` 1920×1080 and `SHORT` 1080×1920.
- Each Short is cut from the episode audio over `span.shortStart → span.end`.
  `shortStart` skips the announcer's league bumper, so keep that.
- `narration.segments` gives every spoken phrase with `kind` (the segment
  index, `-1` for the intro), `text`, `start`, `end` and a `bumper` flag. **That
  is the timing source for all animation.**

### The libraries, already checked
Both are installed and in `package.json`: `animejs@4.5.0` and `canvaskit-wasm@0.42.0`.

- **anime.js v4 works headlessly in Node** on plain JS objects. Use
  `createTimeline({ autoplay: false })`, then `.add(stateObject, {...}, offset)`
  and `tl.seek(ms)`. Each seek updates the object's properties, and seeking
  backwards works, so frames are deterministic. Verified with
  `x: [0,100], ease: "outExpo"`: seek(250) gave 82.3, seek(1000) gave 100.0, and
  seek(400) after that gave 93.8. No browser and no requestAnimationFrame loop
  are needed.
- **diffusionstudio/lottie is not a renderer.** It is an MIT-licensed skill for
  coding agents that *authors* Lottie JSON (`npx skills add diffusionstudio/lottie`,
  the skill is `text-to-lottie`). Its preview player runs on **canvaskit-wasm**
  (Skia's Skottie). So: author Lottie JSON (by hand or with that skill) and play
  it with canvaskit's Skottie. **Verified headless in Node:**
  ```js
  const CanvasKitInit = require("canvaskit-wasm/bin/full/canvaskit.js");
  const CK = await CanvasKitInit({ locateFile: (f) => require.resolve(`canvaskit-wasm/bin/full/${f}`) });
  const anim = CK.MakeAnimation(JSON.stringify(lottieJson));   // duration(), fps()
  const surface = CK.MakeSurface(w, h); const canvas = surface.getCanvas();
  canvas.clear(CK.TRANSPARENT); anim.seekFrame(frame); anim.render(canvas, CK.LTRBRect(0, 0, w, h)); surface.flush();
  const rgba = canvas.readPixels(0, 0, { width: w, height: h, colorType: CK.ColorType.RGBA_8888,
    alphaType: CK.AlphaType.Unpremul, colorSpace: CK.ColorSpace.SRGB });
  ```
  A test square keyframed from x=0 to x=200 over 30 frames rendered at x=0, 70
  and 169 for frames 0, 15 and 29. Use the **`bin/full`** build, which includes
  Skottie. The test script is `data/scratch/libcheck.mjs` (in gitignored `data/`).
- The project canvas is **`@napi-rs/canvas`** (Skia), wrapped by `server/canvas.mjs`
  with the Atkinson Hyperlegible fonts. Keep using it for 2D drawing. Use
  CanvasKit **only** for Lottie: put the RGBA from `readPixels` into a scratch
  `@napi-rs` canvas with `putImageData`, then `drawImage` that onto the frame.

### Real photos: availability and rights
On Commons (`filetype:bitmap` search), these counts of photos **without
ShareAlike** came back for today's subjects:

| Subject | Results | CC BY | PD/CC0 |
|---|---|---|---|
| Jake Bauers | 14 | 10 | 0 |
| LeBron James | 40 | 24 | 0 |
| Boston Red Sox | 40 | 5 | 23 |
| Duke Blue Devils men's basketball | 40 | 3 | 27 |
| Georgia Bulldogs football | 40 | 4 | 32 |
| Philadelphia 76ers | 40 | 2 | 16 |
| Yaxel Lendeborg | 20 | 0 | 19 |
| Trev Alberts, Andrej Stojakovic | 0 | 0 | 0 |

**Rights rule (do not change it without the owner's OK):** the desk deliberately
blocks ShareAlike (CC BY-SA) material from public uploads. See `previewLicenses`
in `footage.mjs` and the `previewOnly` checks in `desk.mjs` around lines 1115 and
1374. Photos follow the same rule:
- Accept CC0, public domain (incl. PD-USGov) and CC BY 2.0/2.5/3.0/4.0.
- Reject BY-SA and anything with `Restrictions`.
- Credit every photo used: title, creator, license and URL go into
  `footageCredits`, which already flows into the YouTube description.
- Many PD/CC0 hits are logos, so filter them out (below).
- **Do not** add ESPN headshots or logos to the motion layer. The plates
  already use ESPN art without a grant, and that was flagged as a problem.
- **Do not** use broadcast or league highlight footage. There is no license.
  The real people come from licensed photos, plus Commons video where one exists.

---

## 2. What to build

### 2.1 `server/sports/imagery.mjs`: photos of the story's people and teams
- **Subjects:** reuse `footageSubjects(segment)` from `footage.mjs`. It returns
  teams with aliases, plus people taken from `footage.people` and names in the
  headline. Also scan the narration for capitalized two- or three-word names that
  match `footage.teams`/`footage.people`. People come first, then teams.
- **Search:** use the Commons API like `CommonsFootage.search()`: same User-Agent,
  `maxlag`, timeouts, and `redirect: "error"`. Query `"<name>" filetype:bitmap`
  with `gsrlimit=40`, `prop=imageinfo`, `iiprop=url|size|mime|extmetadata`, and
  `iiurlwidth=2400` to get a scaled thumbnail URL instead of a 40 MB original.
  For teams, also query `"<team>" <sport>`, e.g. `"Boston Red Sox" baseball`.
- **Filter:**
  - `image/jpeg` (allow png only when width ≥ 1200).
  - Width ≥ 1000 and height ≥ 700 (for Shorts, prefer height ≥ width when one
    exists).
  - The allowed licenses above; no `Restrictions`.
  - The URL is on `upload.wikimedia.org`.
  - Reject titles or descriptions matching
    `/logo|wordmark|uniform|jersey|seal|map|signature|diagram|chart|ticket|card|stamp|coin|poster|cover|screenshot/i`.
  - The title or description must contain one of the subject's aliases
    (use `wording()`/`includes()` from footage.mjs).
- **Rank:**
  1. A person named in the description.
  2. A team plus a game word (`gameplay[sport]` regexes in footage.mjs).
  3. Newer `DateTimeOriginal` first.
- **Target:** about one photo per 4 seconds of narration, at least 4 per story
  and at most 12. Mix people and teams, and never show the same photo twice in a
  row.
- **Download:** fetch the scaled thumbnail URL, cap at 8 MB, check the content
  type, and cache under `data/sports/assets/photos/<sha1>.jpg` with a JSON
  sidecar (license, creator, url) so later builds reuse it. Decode with
  `loadImage`.
- **Faces (keep it cheap):** no ML. Center the Ken Burns pan on the upper third
  of portrait-orientation photos, because that's where heads usually are.
  Otherwise use the center.
- **Export:**
  `storyImagery(segment, { signal, fetchImpl, allowPreview }) → [{ image, file, credit, subject, kind: "person"|"team" }]`.
- **Fallback when nothing qualifies** (e.g. Trev Alberts): sport-generic CC0/PD
  action photos via `"<sport> game" filetype:bitmap`, filtered the same way.
  Last resort is fully animated graphics (2.3). **Never** fall back to a still card.

### 2.2 `server/sports/motion.mjs`: the frame-by-frame renderer
The core idea: instead of PNG slides plus an ffconcat list, draw every frame in
Node and pipe raw RGBA into ffmpeg.

```js
// renderMotion({ width, height, fps, duration, build: (tl, state) => void, draw: (ctx, state, t) => void,
//                audio: { file, trim }, captions?: assFile, output, signal })
```
- Create `state = {}` and a paused anime.js timeline. Let `build()` add every
  tween for the whole video, timed in milliseconds from the narration phrase
  times.
- Spawn ffmpeg:
  `-f rawvideo -pix_fmt rgba -s WxH -r 30 -i pipe:0 -i <audio>` with
  `-filter_complex "[0:v]format=yuv420p[v];[1:a]atrim...,<normalizer>[a]"`,
  then `...encode` and `-t duration`. Burned ASS captions are optional (2.4).
- For each frame `n`:
  1. `tl.seek(n*1000/fps)`.
  2. `draw(ctx, state, t)`.
  3. Take the frame bytes from the `@napi-rs` canvas (`ctx.getImageData` or
     `canvas.data()`; check which is faster).
  4. `stdin.write()`, and await `drain` when it returns false (backpressure).
- Reuse one canvas per video. Check `signal` every frame. Report progress through
  the existing `report(percent, message)`.
- Budget: aim for at least 20 fps rendered. The Nov 18 episode ran 241 s, which
  is 7,230 frames, so about 6 minutes. 8 Shorts of about 30 s each is another
  7,200 frames. The build runs overnight with hours to spare, but measure, and
  log fps in `qc.json`.
- **Video clips inside the motion layer:** when `prepareFootage` finds a real
  Commons game clip ("exact" or play B-roll), don't composite it on a static
  plate. Change the cut to output a plain scaled and cropped clip
  (`scale=W:H:force_original_aspect_ratio=increase,crop=W:H,fps=30`). Then read
  its frames one by one with a small reader: ffmpeg writes `rawvideo rgba` to
  stdout, and exactly `W*H*4` bytes are read per frame, in order. Draw that frame
  as the full-bleed background during its time window, with the graphics on top.
  This replaces `footageFilters()` and the plate composites.

### 2.3 Motion design: what moves, and when
Every element is a tween on `state`, keyed to phrase times. Use `outExpo`/`outBack`
easing for entrances, `inOutSine` for drift, and `inExpo` for exits.

**Constant layer (never static):**
- **Photo background:**
  - Ken Burns on every photo: scale 1.08 → 1.20 and a 3–6% pan in a random
    direction (seeded by segment id so renders repeat).
  - Change photos every 3.5–5 s, or when the narration names a different
    subject. Use `visualTeamCues()` and the phrase text to pick the photo of the
    person or team being spoken about, matching the subject's aliases.
  - Transitions are a 0.4 s crossfade, or a 0.5 s Lottie wipe at the start of
    each new story.
  - Darken with a gradient (bottom 55% and the left side) so text reads.
  - Add a subtle team-color tint: map `footage.teams` to colors. Start with a
    small built-in table for teams in scope and fall back to the league color.
- **Drifting accents:** two or three translucent diagonal bars or rings in the
  team or league color, always moving slowly (anime.js `loop`, or a linear
  tween across the whole span).
- **Progress bar:** the existing story progress, drawn in canvas with a moving
  glint.

**Story entrance (first 1.5 s of each span, from `span.start`):**
- A Lottie stinger: diagonal team-color bars sweep across the frame (0.6 s).
- League tag ("COLLEGE FOOTBALL", "NBA", "MLB") slides in from the left.
- Headline reveals word by word (staggered `translateY` 40→0 and opacity, 60 ms
  stagger, `outExpo`). After about 4 s it shrinks to a lower-third, so the
  photos get most of the frame.
- Team chips (name plus color swatch) pop in with `outBack`.

**Timed callouts (throughout, driven by the narration):**
- **Numbers:**
  - For each phrase containing a number licensed by the segment's claims
    (`segment.claims` values, or numbers in the headline), show a big stat card.
    The number counts up to its value in 0.8 s, with a label of 2–4 words from
    the phrase, e.g. "26 HOME RUNS", "$58 MILLION".
  - Hold it 2.5 s, then slide it out.
  - Never show a number that isn't in the copy.
- **Names:** when a phrase names a person who has a photo, show a name strap
  ("JAKE BAUERS · RED SOX") on the lower third while that photo is up.
- **Scores:** when the segment has a final score (`segment.plate` /
  `ledger.latestEvent` gives teams and scores), show an animated score bug: two
  team bars slide in and the numbers count up.

**Bumpers and bookends:**
- League bumper (`segment.bumper`, voiced by the announcer): a full-frame Lottie
  burst in the league color, with the league name in big kinetic type, during
  the bumper phrase times.
- Intro (`kind === -1`): the logo scales in over the Lottie burst, then the date,
  then a fast montage strip of the day's story photos sliding across.
- Outro and closing announcement: the reverse montage and a subscribe-free sign-off.

**Shorts (1080×1920):**
- Same pieces, re-laid out: photo full-bleed and kinetic captions large in the
  middle third. The headline sits at the top for the first 3 s, then collapses
  to a small tag.
- Change photos faster (every 2.5–3.5 s). Shorts need movement in the first 0.5 s.

### 2.4 Captions
- Draw captions in canvas instead of burning ASS, so they can move: line pop-in,
  plus an active-word highlight in the brand cyan.
- Approximate word timing by spreading each phrase's `start`–`end` across its
  words by character count.
- Keep line breaking from `cues()` (45 characters for the episode, 30 for Shorts)
  and keep writing `captions.srt` / `shorts/*.srt` exactly as now. YouTube and
  `desk.mjs` read them.

### 2.5 Lottie assets (`assets/lottie/*.json`, plus `server/sports/lottie.mjs`)
- Author these Lottie files, by hand or with the diffusionstudio `text-to-lottie`
  skill:
  1. `stinger-bars.json`: diagonal bar wipe, 0.6 s.
  2. `league-burst.json`: radial burst plus rings, 1.2 s.
  3. `pulse-ring.json`: looping accent, 2 s.
  4. `count-flash.json`: a flash behind a stat card, 0.5 s.
- Use color slots for team and league colors. Either generate the JSON from a JS
  function that takes the colors, or edit the fill `c.k` values in the parsed
  JSON before `MakeAnimation`.
- `lottie.mjs`:
  - Loads CanvasKit **once** per render (it takes about 1 s).
  - Caches `MakeAnimation` per JSON and color set.
  - Exposes `drawLottie(ctx, name, colors, progress0to1, rect)`. This renders on
    a CanvasKit surface the size of `rect` only, then copies it onto the frame
    through the scratch canvas.
  - Calls `anim.delete()` and `surface.delete()` at the end. CanvasKit memory is
    manual.

### 2.6 Wiring into `renderEpisode()`
- Keep narration, `narrationParts`, chapters, spans, music mix, loudness
  (`loudnessOf`/`normalizer`), QC (`inspect`), `timeline.json`, `credits.json`
  and every manifest field. The desk, the YouTube listings
  (`server/sports/metadata.mjs`) and the tests depend on them.
- Replace:
  - the slide PNGs plus `chapters.ffconcat`;
  - the playhead overlay;
  - `footageFilters` overlays;
  - ASS burn-in.

  Each of these becomes one `renderMotion()` call for the episode and one per
  Short. Each Short's audio uses `atrim` over `shortStart → end` as now.
- Add photo credits to `footageCredits`. `metadata.mjs`/`youtube.mjs` already put
  credits in the description.
- Fixture and preview renders (`episode.footagePreview`, the tests) must work
  **offline**. Inject `fetchImpl`, and when it fails, fall back to animated
  graphics only. That fallback still moves.
- Put the motion renderer behind `SPORTS_MOTION=on` (default on). With `off`, the
  old renderer runs, so a regression can be switched off without a deploy.

---

## 3. Guarantee that it isn't still

Add a QC check so the build fails if any stretch is static:
- After encoding, sample a frame every 0.5 s.
- Compute the mean absolute pixel difference between neighbouring samples at
  low resolution, e.g. 64×36 grayscale via ffmpeg
  `-vf fps=2,scale=64:36,format=gray`.
- **Fail QC** when two consecutive samples differ by less than a small threshold
  (start around 1.5/255) for more than 1.5 s anywhere, in the episode or any
  Short.
- Record `motion: { minDiff, longestStillSeconds }` per output in `qc.json`.
- That turns "assure it isn't boring" into a check that can fail. The existing
  `outputs.every(o => o.passed)` gate then blocks the upload.

---

## 4. Tests (Node test runner, `npm test`)
- `test/sports-motion.test.mjs`:
  - `renderMotion` with a 2 s timeline at 320×180: the output probes with the
    right duration and fps, and the motion check passes.
  - A deliberately static timeline fails the motion check.
- `test/sports-imagery.test.mjs`, with a fake `fetchImpl` returning Commons JSON:
  - BY-SA, logos and too-small images are rejected; CC BY and PD are kept.
  - The person named in the description ranks first.
  - Credits carry license, creator and URL.
- Lottie: load `stinger-bars.json` through `lottie.mjs`, render frames 0 / mid /
  end, and assert that the pixels change and the frame is transparent outside the
  shapes.
- Update `test/sports-production.test.mjs`, "renders the 1080p episode…":
  - Its portrait-pixel check has been failing since someone's layout work (stale
    coordinates). Replace it with the motion QC assertion.
  - Keep its duration, Shorts, captions.srt, timeline and credits assertions.
- Every existing test must still pass. Right now 98 of 99 pass; the one failure
  is the stale portrait test above.

---

## 5. Acceptance (check on a real edition)
1. Rebuild a real edition, Nov 18 or the next one, with `npm run render:fixture`
   or the desk's Build button. Watch the episode and two Shorts.
2. Each story shows photos of the people or teams being talked about, and
   switches photos when the narration switches subject. The credits list every
   photo.
3. No stretch longer than 1.5 s without visible movement. The QC motion check
   passes and is in `qc.json`.
4. Stat cards show only numbers that are in that story's copy.
5. Render time is logged. The episode plus Shorts must finish well before the
   8 a.m. upload. Builds start after midnight research, so stay under about 45
   minutes.
6. `npm test` is green, apart from anything explicitly noted.

## 6. Operating context (do not break)
- The desk runs on this Windows PC as the scheduled task **"ISNN Desk"**
  (`scripts/windows/run-desk.cmd`). It ticks itself every minute:
  - midnight research;
  - overnight build;
  - **8:00 episode upload**, then Shorts through 10:59.
- After code changes, restart the task, or the old code keeps running:
  ```
  stop the node process running server\index.mjs, then: Start-ScheduledTask "ISNN Desk"
  ```
  Restarting changes the Cloudflare quick-tunnel link that Isaac uses. The new
  link is in `data\tunnel-url.txt`, so tell the owner.
- The GPU is shared with Isaac's voice (Qwen3-TTS, `scripts/isaac-narrate.py`).
  Rendering is CPU (Skia plus x264), so don't render while narration runs. The
  pipeline is already sequential.
- `.env` holds secrets (YouTube OAuth, desk password). Never print or commit it.
- There is a lot of uncommitted work in the tree. Commit only when the owner asks.
- Use "Wellspring Media Sports" naming, never "The Word". The repo is ISNN.
