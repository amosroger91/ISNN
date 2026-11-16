import { open } from "node:fs/promises";
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
  if (!response.ok) throw await httpError(response, "YouTube authentication failed");
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

function videoDescription(episode) {
  const lines = new Map();
  for (const segment of episode.segments || []) {
    for (const source of segment.sources || []) {
      try {
        const url = new URL(source.url);
        if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) continue;
        const publisher = metadataText(source.publisher ?? url.hostname).replace(/\s+/g, " ");
        lines.set(url.href, `${publisher}\n${url.href}`);
      } catch {
        continue;
      }
    }
  }
  let credits = `${chapterText(episode)}\n\nNarration uses a synthetic voice.`;
  if (episode.footageCredits?.length) {
    credits += "\n\nFootage credits";
    for (const clip of episode.footageCredits) {
      const line = metadataText(`${clip.title} — ${clip.creator} (${clip.license}, excerpt, muted)\n${clip.url}\n${clip.licenseUrl}`);
      if (Buffer.byteLength(`${credits}\n${line}`) <= 4400) credits += `\n${line}`;
    }
  }
  if (lines.size) {
    credits += "\n\nReporting sources";
    for (const line of lines.values()) {
      if (Buffer.byteLength(`${credits}\n${line}`) <= 3500) credits += `\n${line}`;
    }
  }
  const description = limitUtf8(metadataText(episode.description), 5000 - Buffer.byteLength(credits)).trimEnd();
  return `${description}${credits}`.trim();
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
      snippet: { title, description: videoDescription(episode), categoryId: "17", defaultAudioLanguage: "en" },
      status: { privacyStatus },
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
      return { id: video.id, url: `https://youtu.be/${video.id}`, privacyStatus: video.status?.privacyStatus ?? null };
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
