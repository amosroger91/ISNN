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
npm test          # desk, research and production tests with simulated model and YouTube responses
npm run build     # production client bundle in dist/
```

### Offline proof of the show

```bash
npm run render:fixture                      # frozen historical game, Kokoro narration
npm run render:fixture -- --voice none      # placeholder narrator: no model download, runs in CI
npm run render:fixture -- --out proof/      # choose the output folder
```

The fixture command renders a frozen historical game from `server/sports/fixtures/` with local assets only. It makes no model calls and no uploads. It writes `episode.mp4`, one `shorts/segment-NN.mp4` per segment, SRT captions for each cut, `timeline.json`, `credits.json`, `qc.json` (dimensions, codecs, measured loudness, A/V sync), a frame contact sheet, a phone-size frame per Short, and the render time and peak memory.

## How an edition is made

- **Midnight Central.** Research reads the feeds, picks one to four stories, cites sources per story and verifies the copy against the excerpts. The script writer turns the included topics into segments, Isaac's takes are attributed separately, and the render worker produces the episode and its Shorts in an isolated process.
- **Between midnight and air.** Isaac can add, include or bench a story, inspect its evidence, change the angle or add a take, directly or through chat. Live edits queue a new render. For a factual topic outside the feeds, add a source URL and a supporting excerpt.
- **8 a.m. Central.** Cron submits the finished, current revision to YouTube. The first attempt starts at 8 a.m. and retries may occur through 8:59 a.m. while the app is running. If the current revision is missing or fails its checks, the desk holds the upload. Once an upload starts, that edition is locked.

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
