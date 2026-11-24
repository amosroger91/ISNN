import { open, readFile } from "node:fs/promises";
import { setTimeout as pause } from "node:timers/promises";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const UPLOAD_URL = "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";
const CHUNK_SIZE = 8 * 1024 * 1024;
const MAX_RECOVERY_ATTEMPTS = 4;
const PRIVACY = new Set(["public", "unlisted", "private"]);

export function youtubeConfigured() {
  return ["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"].every((key) => process.env[key]?.trim());
}

function unknownUpload(message) {
  return Object.assign(new Error(message), { uploadUncertain: true });
}

function googleSession(value) {
  try {
    const url = new URL(value);
    if (["https://www.googleapis.com", "https://youtube.googleapis.com"].includes(url.origin) &&
        url.pathname === "/upload/youtube/v3/videos" && url.searchParams.has("upload_id") && !url.username && !url.password) {
      return url.href;
    }
  } catch {
    // An invalid response or saved session must never receive OAuth credentials.
  }
  throw unknownUpload("YouTube supplied an invalid upload session URL.");
}

async function httpError(response, context) {
  const body = await response.json().catch(() => null);
  const reason = body?.error?.errors?.[0]?.reason || body?.error;
  const code = typeof reason === "string" && /^[a-zA-Z_]{1,80}$/.test(reason) ? `, ${reason}` : "";
  return new Error(`${context} (HTTP ${response.status}${code}).`);
}

function withTimeout(signal, milliseconds) {
  const timeout = AbortSignal.timeout(milliseconds);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export async function youtubeAccessToken(fetchImpl = fetch, signal) {
  return getAccessToken(fetchImpl, signal);
}

async function getAccessToken(fetchImpl, signal) {
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    body: new URLSearchParams({
      client_id: process.env.YOUTUBE_CLIENT_ID.trim(),
      client_secret: process.env.YOUTUBE_CLIENT_SECRET.trim(),
      refresh_token: process.env.YOUTUBE_REFRESH_TOKEN.trim(),
      grant_type: "refresh_token",
    }),
    redirect: "error",
    signal: withTimeout(signal, 30_000),
  });
  if (!response.ok) {
    const error = await httpError(response, "YouTube authentication failed");
    if (/invalid_grant/.test(error.message)) {
      const base = process.env.PUBLIC_URL?.trim().replace(/\/+$/, "") || "";
      error.message += ` Google expired or revoked the channel sign-in. Reconnect YouTube at ${base}/api/sports/youtube/reconnect`;
      error.reconnect = true;
    }
    throw error;
  }
  const { access_token: token } = await response.json();
  if (!token) throw new Error("Google did not return a YouTube access token.");
  return token;
}

function metadataText(value) {
  return String(value ?? "").replace(/[<>]/g, "").replace(/\r\n?/g, "\n").trim();
}

function limitUtf8(text, length) {
  let remaining = length;
  let output = "";
  for (const character of text) {
    remaining -= Buffer.byteLength(character);
    if (remaining < 0) break;
    output += character;
  }
  return output;
}

function formatTimestamp(time) {
  const minutes = Math.floor(time / 60);
  const seconds = String(time % 60).padStart(2, "0");
  if (minutes < 60) return `${String(minutes).padStart(2, "0")}:${seconds}`;
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")}:${seconds}`;
}

function chapterText(episode) {
  const { chapters, duration } = episode;
  if (chapters?.length < 3 || chapters?.[0]?.start !== 0 || !Number.isFinite(duration)) return "";
  const labels = chapters.map(({ headline }) => limitUtf8(metadataText(headline).replace(/\s+/g, " "), 100).trimEnd());
  const usable = chapters.every(({ start }, index) => {
    const end = chapters[index + 1]?.start ?? duration;
    return labels[index] && Number.isFinite(start) && end - start >= 10;
  });
  if (!usable) return "";
  return `\n\nChapters\n${chapters.map(({ start }, index) => `${formatTimestamp(Math.floor(start))} ${labels[index]}`).join("\n")}`;
}

// The whole description stays short enough to read: the hook and show line,
// chapters, the synthetic-voice note, footage licence credits (required for
// Creative Commons clips), then hashtags. Reporting-source links are left out.
export const DESCRIPTION_CHARACTERS = 1500;
const characters = (text) => Array.from(text).length;

function videoDescription(episode) {
  // Hashtags go last; YouTube shows the first three above the title.
  const hashtags = (episode.hashtags || []).filter((tag) => /^#[A-Za-z][A-Za-z0-9]{1,29}$/.test(tag)).slice(0, 15).join(" ");
  const closing = hashtags ? `\n\n${hashtags}` : "";
  const body = metadataText(episode.description);
  let tail = `${chapterText(episode)}\n\nNarration uses a synthetic voice.`;
  // Licence credits may not be squeezed out by a long hook: the body is
  // counted at no more than 600 characters while they are placed.
  const room = () => DESCRIPTION_CHARACTERS - Math.min(characters(body), 600) - characters(tail) - characters(closing);
  if (episode.footageCredits?.length) {
    let credits = "\n\nFootage credits";
    for (const clip of episode.footageCredits) {
      const note = clip.type === "photo" ? clip.license : `${clip.license}, excerpt, muted`;
      const line = metadataText(`${clip.title} — ${clip.creator} (${note})\n${clip.url}\n${clip.licenseUrl}`);
      if (characters(`${credits}\n${line}`) <= room()) credits += `\n${line}`;
    }
    if (credits !== "\n\nFootage credits") tail += credits;
  }
  // The body gives way last: trimmed only if chapters and credits overflow.
  const fit = Array.from(body).slice(0, Math.max(0, DESCRIPTION_CHARACTERS - characters(tail) - characters(closing))).join("");
  const description = limitUtf8(fit, 5000 - Buffer.byteLength(tail) - Buffer.byteLength(closing)).trimEnd();
  return `${description}${tail}${closing}`.trim();
}

const TITLE_LIMIT = 100;

function rundownDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || "")) return "";
  const stamp = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(stamp.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  }).format(stamp);
}

// Episode and Short titles share one prefix so a day's uploads read as one show.
export function youtubeTitle({ date, headline } = {}) {
  const when = rundownDate(date);
  const base = when ? `The Rundown | ${when}` : "The Rundown";
  const story = metadataText(headline).replace(/\s+/g, " ").trim();
  const full = story ? `${base} | ${story}` : base;
  return Array.from(full).slice(0, TITLE_LIMIT).join("").trimEnd() || "The Rundown";
}

function cueSeconds(value) {
  const match = /(\d+):(\d{2}):(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

export function srtCues(text) {
  const cues = [];
  for (const block of String(text || "").replace(/^\uFEFF/, "").split(/\r?\n\s*\r?\n/)) {
    const lines = block.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex < 0) continue;
    const start = cueSeconds(lines[timingIndex].split("-->")[0]);
    const label = lines.slice(timingIndex + 1).join(" ").replace(/\s+/g, " ").trim();
    if (start === null || !label) continue;
    cues.push({ start, label });
  }
  return cues;
}

function timestampLines(entries) {
  if (!entries?.length) return "";
  const lines = [];
  for (const entry of entries) {
    if (!Number.isFinite(entry?.start) || entry.start < 0) continue;
    const label = limitUtf8(metadataText(entry.label).replace(/\s+/g, " "), 100).trimEnd();
    if (!label) continue;
    lines.push(`${formatTimestamp(Math.floor(entry.start))} ${label}`);
  }
  return lines.join("\n");
}

// Chapter lines stay in videoDescription when YouTube can use them. Otherwise
// the same timestamps are written into the description body. The hook leads;
// the show line follows it, since YouTube previews only the first lines.
export function youtubeDescription({ date, entries, episode } = {}) {
  const when = rundownDate(date || episode?.date);
  const showLine = when
    ? `The Rundown · ${when} · Wellspring Media Sports with Isaac Doss`
    : "The Rundown · Wellspring Media Sports with Isaac Doss";
  const original = metadataText(episode?.description);
  const body = original.includes(showLine) ? original : [original, showLine].filter(Boolean).join("\n\n");
  if (chapterText(episode || {})) return body;
  const lines = timestampLines(entries);
  return lines ? `${body}\n\n${lines}` : body;
}

async function initiateUpload(request, episode, total, privacyStatus) {
  const title = Array.from(metadataText(episode.title).replace(/\s+/g, " ")).slice(0, 100).join("").trimEnd();
  if (!title) throw new Error("The episode needs a YouTube title.");
  const response = await request(UPLOAD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "X-Upload-Content-Length": String(total),
      "X-Upload-Content-Type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: {
        title, description: videoDescription(episode), categoryId: "17", defaultAudioLanguage: "en",
        ...(episode.tags?.length && { tags: episode.tags.map((tag) => metadataText(tag).replace(/[",]/g, "").slice(0, 60)).filter(Boolean) }),
      },
      // Sports news for a general audience: never declared made for kids.
      // A scheduled video uploads private and YouTube makes it public at publishAt.
      status: episode.publishAt && privacyStatus === "public"
        ? { privacyStatus: "private", publishAt: episode.publishAt, selfDeclaredMadeForKids: false }
        : { privacyStatus, selfDeclaredMadeForKids: false },
    }),
  }, 30_000);
  if (!response.ok) throw await httpError(response, "Could not start the YouTube upload");
  return googleSession(response.headers.get("location"));
}

async function readChunk(handle, offset, length) {
  const bytes = Buffer.allocUnsafe(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(bytes, read, length - read, offset + read);
    if (!bytesRead) throw new Error("The rendered MP4 changed while YouTube was uploading it.");
    read += bytesRead;
  }
  return bytes;
}

async function resumeUpload({ request, session, total, handle, onSession, signal, checkFirst }) {
  let offset = 0;
  let probe = checkFirst;
  let recoveryAttempts = 0;
  while (offset < total) {
    signal?.throwIfAborted();
    const length = Math.min(CHUNK_SIZE, total - offset);
    const headers = probe
      ? { "Content-Length": "0", "Content-Range": `bytes */${total}` }
      : { "Content-Type": "video/mp4", "Content-Length": String(length), "Content-Range": `bytes ${offset}-${offset + length - 1}/${total}` };
    const body = probe ? undefined : await readChunk(handle, offset, length);
    const response = await request(session, { method: "PUT", headers, body }, probe ? 30_000 : 180_000).catch(() => null);
    signal?.throwIfAborted();

    if (response?.ok) {
      const video = await response.json().catch(() => null);
      if (!/^[\w-]{11}$/.test(video?.id || "")) {
        throw unknownUpload("YouTube accepted the upload and did not return a usable video ID. Check YouTube Studio.");
      }
      return {
        id: video.id, url: `https://youtu.be/${video.id}`, privacyStatus: video.status?.privacyStatus ?? null,
        publishAt: video.status?.publishAt ?? null,
      };
    }
    if ([404, 410].includes(response?.status)) {
      throw unknownUpload("The YouTube upload session expired. Check YouTube Studio for the episode before uploading it again.");
    }
    if (response?.status === 308) {
      const continuation = response.headers.get("location");
      if (continuation && continuation !== session) {
        session = googleSession(continuation);
        await onSession(session);
      }
      const range = response.headers.get("range");
      const match = range?.match(/^bytes=0-(\d+)$/i);
      const next = match ? Number(match[1]) + 1 : 0;
      if ((range && !match) || !Number.isSafeInteger(next) || next >= total || next < offset) {
        throw unknownUpload("YouTube returned an inconsistent upload offset. Check YouTube Studio for the episode.");
      }
      if (probe || next > offset) {
        if (next > offset) recoveryAttempts = 0;
        offset = next;
        probe = false;
        continue;
      }
    } else if (response && response.status !== 408 && response.status !== 429 && response.status < 500) {
      throw await httpError(response, "YouTube refused the upload");
    }

    // Ask Google how many bytes it actually has before retrying any media.
    if (++recoveryAttempts > MAX_RECOVERY_ATTEMPTS) {
      throw new Error("YouTube has not confirmed the upload. Retry the saved session or check YouTube Studio.");
    }
    probe = true;
    await pause(1000 * 2 ** (recoveryAttempts - 1), undefined, { signal });
  }
}

// A thumbnail failure is not an upload failure. Quota stops the rest of the
// edition's thumbnails; a phone-verification 403 is "unavailable".
export function classifyThumbnailError(error) {
  const message = String(error?.message || error || "");
  if (/quotaExceeded|uploadLimitExceeded|dailyLimitExceeded|rateLimitExceeded/iu.test(message)) {
    return { status: "failed", halt: "quota" };
  }
  if (/HTTP\s+403\b/iu.test(message) && /forbidden|custom thumbnail|verif/iu.test(message)) {
    return { status: "unavailable", halt: "unavailable" };
  }
  return { status: "failed", halt: null };
}

export async function setThumbnail({ videoId, file, signal, fetchImpl = fetch }) {
  if (!/^[\w-]{11}$/u.test(String(videoId || ""))) throw new Error("YouTube video id is not valid.");
  if (!youtubeConfigured()) throw new Error("Configure the YouTube channel's offline OAuth credentials first.");
  const bytes = await readFile(file);
  const token = await getAccessToken(fetchImpl, signal);
  const response = await fetchImpl(
    `https://www.googleapis.com/upload/youtube/v3/thumbnails/set?videoId=${encodeURIComponent(videoId)}&uploadType=media`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "image/jpeg",
        "Content-Length": String(bytes.length),
      },
      body: bytes,
      redirect: "error",
      signal: withTimeout(signal, 60_000),
    },
  );
  if (!response.ok) throw await httpError(response, "YouTube refused the thumbnail");
  return response.json().catch(() => ({}));
}

export async function uploadEpisode({ file, episode, sessionUrl, onSession, signal, fetchImpl = fetch }) {
  if (!youtubeConfigured()) throw new Error("Configure the YouTube channel's offline OAuth credentials first.");
  if (typeof onSession !== "function") throw new Error("The YouTube upload requires durable session storage.");
  const privacyStatus = process.env.YOUTUBE_PRIVACY_STATUS?.trim() || "public";
  if (!PRIVACY.has(privacyStatus)) throw new Error("YOUTUBE_PRIVACY_STATUS must be public, unlisted, or private.");
  let session = sessionUrl ? googleSession(sessionUrl) : null;
  const handle = await open(file, "r");
  try {
    const { size: total } = await handle.stat();
    if (!total) throw new Error("The rendered MP4 is empty.");
    const token = await getAccessToken(fetchImpl, signal);
    const request = (url, options, timeout) => fetchImpl(url, {
      ...options,
      redirect: "manual",
      headers: { ...options.headers, Authorization: `Bearer ${token}` },
      signal: withTimeout(signal, timeout),
    });
    if (!session) {
      session = await initiateUpload(request, episode, total, privacyStatus);
      await onSession(session);
    }
    return await resumeUpload({ request, session, total, handle, onSession, signal, checkFirst: Boolean(sessionUrl) });
  } finally {
    await handle.close();
  }
}
