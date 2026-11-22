import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createCanvas, loadImage } from "../canvas.mjs";
import { storyColor } from "./broadcast.mjs";
import { heroLogoWells, paintThumbnail } from "./thumbnail-art.mjs";
import { teamsInText, wording } from "./footage.mjs";
import { logosForTitle } from "./team-logos.mjs";

// Custom YouTube thumbnails for the episode and each Short. Photos are the
// ones the motion render already chose. A rebuild with the same date and
// stories draws the same frame.
const EPISODE_SIZE = { width: 1280, height: 720 };
const SHORT_SIZE = { width: 1080, height: 1920 };
const JPEG_LIMIT = 2 * 1024 * 1024;
const LOGO_CAP = 2;
const logoBounds = new WeakMap();

export function thumbnailsEnabled() {
  return (process.env.SPORTS_THUMBNAILS || "on").toLowerCase() !== "off";
}

export function shortThumbnailsEnabled() {
  return (process.env.SPORTS_SHORT_THUMBNAILS || "on").toLowerCase() !== "off";
}

export function cleanThumbnailLine(text) {
  return String(text ?? "")
    .replace(/[’‘]/gu, "'")
    .replace(/[^A-Za-z0-9$%'\-\s]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toUpperCase()
    .split(" ")
    .filter(Boolean)
    .slice(0, 4)
    .join(" ");
}

// 2–4 words, and every number already appears in the copy this video aired.
export function thumbnailAllowed(line, copy) {
  const text = String(line || "").trim();
  const words = text.split(/\s+/u).filter(Boolean);
  if (words.length < 2 || words.length > 4) return false;
  if (words.some((word) => !/^[\p{L}\p{N}$%'-]+$/u.test(word))) return false;
  const found = text.match(/\d+(?:[.,]\d+)?/gu) || [];
  const source = String(copy || "").match(/\d+(?:[.,]\d+)?/gu) || [];
  return found.every((number) => source.includes(number));
}

// Keep the complete approved hook. The display layout fits real glyph widths
// instead of silently dropping the last word based on a character estimate.
export function fitThumbnailText(text) {
  const line = cleanThumbnailLine(text);
  return line.split(" ").filter(Boolean).length < 2 ? "SPORTS RUNDOWN" : line;
}

export function thumbnailDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date || "")) return "";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" })
    .format(new Date(`${date}T12:00:00Z`))
    .toUpperCase();
}

// Commons photos are already license-filtered. This drops ShareAlike, preview
// footage, grants that do not list the thumbnail surface, and ESPN marks.
export function usableThumbnailPhoto(photo) {
  if (!photo) return false;
  const license = String(photo.credit?.license || photo.license || "");
  if (/sa|nc|nd/iu.test(license)) return false;
  if (photo.previewOnly || photo.credit?.previewOnly) return false;
  const surfaces = photo.grantSurfaces || photo.credit?.grantSurfaces || photo.credit?.surfaces;
  if (Array.isArray(surfaces) && !surfaces.includes("thumbnail")) return false;
  const blob = `${photo.file || ""} ${photo.url || ""} ${photo.credit?.url || ""} ${photo.credit?.title || ""}`;
  if (/espn/iu.test(blob) && /headshot|logo|wordmark/iu.test(blob)) return false;
  return true;
}

async function asImage(photo) {
  if (!photo || !usableThumbnailPhoto(photo)) return null;
  const source = photo.image || photo;
  if (source?.width && source?.height && typeof source.getContext === "function") return source;
  const file = typeof photo === "string" ? photo : photo.file;
  if (!file) return null;
  try {
    return await loadImage(file);
  } catch {
    return null;
  }
}

// Marks are not photos. usableThumbnailPhoto refuses an ESPN logo file, so a
// team mark is loaded on its own and drawn on top of the cover.
function isCanvas(value) {
  return Boolean(value?.width && value?.height && typeof value.getContext === "function");
}

async function asMark(logo) {
  if (isCanvas(logo)) return logo;
  if (isCanvas(logo?.image)) return logo.image;
  const file = typeof logo === "string" ? logo : logo?.file;
  if (!file) return null;
  try {
    return await loadImage(file);
  } catch {
    return null;
  }
}

export function logoWells(kind, count, width) {
  return heroLogoWells(kind, count, width);
}

function markBounds(image) {
  const cached = logoBounds.get(image);
  if (cached) return cached;
  const scratch = createCanvas(image.width, image.height);
  const ctx = scratch.getContext("2d");
  ctx.drawImage(image, 0, 0);
  const { data, width, height } = ctx.getImageData(0, 0, image.width, image.height);
  const white = (index) => data[index + 3] > 240 && data[index] > 242 && data[index + 1] > 242 && data[index + 2] > 242;
  const corners = [0, (width - 1) * 4, (height - 1) * width * 4, (width * height - 1) * 4];
  const whiteMatte = corners.filter(white).length >= 3;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (data[index + 3] < 24) continue;
      if (whiteMatte && white(index)) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  const box = maxX < 0
    ? { x: 0, y: 0, width, height }
    : { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
  logoBounds.set(image, box);
  return box;
}

// A cover is one editorial idea. Only use that story's photos, with subjects
// named in the hook preferred over another person mentioned in its reporting.
export function coverStoriesForText(text, stories = []) {
  const named = teamsInText(text);
  const words = wording(text).split(" ").filter((word) => word.length > 3);
  const ranked = stories.map((story, index) => {
    const blob = [story.headline, ...(story.teams || [])].filter(Boolean).join(" ");
    const teams = teamsInText(blob, { sport: story.sport });
    const teamScore = named.filter((team) => teams.some((hit) => hit.canonical === team.canonical)).length * 20;
    const headline = wording(story.headline || "").split(" ");
    const score = teamScore + words.filter((word) => headline.includes(word)).length;
    return { story, index, score };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  return ranked.length ? [ranked[0].story] : [];
}

export async function drawThumbnail({ kind = "episode", stories = [], photos, text, color, date, logos = [] } = {}) {
  const short = kind === "short";
  const { width, height } = short ? SHORT_SIZE : EPISODE_SIZE;
  const canvas = createCanvas(width, height);
  const lead = coverStoriesForText(text, stories)[0] || {};
  const line = fitThumbnailText(text, { kind });
  const wanted = wording(line).split(" ");
  const candidates = (Array.isArray(photos) ? photos : lead.photos || [])
    .filter(usableThumbnailPhoto)
    .map((photo, index) => ({ photo, index, score:
      wording(photo.subject || "").split(" ").filter((word) => word.length > 2 && wanted.includes(word)).length * 10
      + (photo.kind === "person" ? 1 : 0) }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const panels = [];
  for (const { photo } of candidates) {
    const image = await asImage(photo);
    if (image) { panels.push({ image, focalPoint: photo.focalPoint }); break; }
  }
  const marks = [];
  const markColors = [];
  for (const logo of logos || []) {
    if (marks.length >= LOGO_CAP) break;
    const image = await asMark(logo);
    if (image) {
      marks.push(image);
      markColors.push(/^#[0-9a-f]{6}$/iu.test(logo?.color || "") ? logo.color : null);
    }
  }
  paintThumbnail({ canvas, text: line, photos: panels, marks, story: lead,
    color: color || markColors[0] || storyColor(lead), secondaryColor: markColors[1],
    date: thumbnailDate(date), cropBounds: markBounds, kind });
  canvas.thumbnailText = line;
  return canvas;
}

function meanLuminance(ctx, width, height) {
  const data = ctx.getImageData(0, 0, width, height).data;
  let total = 0;
  const count = data.length / 4;
  for (let index = 0; index < data.length; index += 4) {
    total += 0.2126 * data[index] + 0.7152 * data[index + 1] + 0.0722 * data[index + 2];
  }
  return total / count;
}

export function measureThumbnail(canvas) {
  const ctx = canvas.getContext("2d");
  return {
    width: canvas.width,
    height: canvas.height,
    mean: meanLuminance(ctx, canvas.width, canvas.height),
    text: canvas.thumbnailText || "",
    textBox: canvas.textBox || null,
  };
}

export async function encodeThumbnail(canvas) {
  let quality = 88;
  let buffer = await canvas.encode("jpeg", quality);
  while (buffer.length > JPEG_LIMIT && quality > 46) {
    quality -= 6;
    buffer = await canvas.encode("jpeg", quality);
  }
  return buffer;
}

export function inspectThumbnail(canvas, buffer, { width, height }) {
  const measured = measureThumbnail(canvas);
  const failures = [];
  if (canvas.width !== width || canvas.height !== height) failures.push(`dimensions ${canvas.width}x${canvas.height}`);
  if (!buffer || buffer.length >= JPEG_LIMIT) failures.push("file is 2 MB or larger");
  if (measured.mean < 40 || measured.mean > 215) failures.push(`luminance ${measured.mean.toFixed(1)}`);
  if (!measured.textBox || measured.text.split(" ").filter(Boolean).length < 2) failures.push("text box was not drawn");
  return {
    passed: failures.length === 0,
    failures,
    width: canvas.width,
    height: canvas.height,
    bytes: buffer?.length || 0,
    mean: Number(measured.mean.toFixed(2)),
    text: measured.text,
    textBox: measured.textBox,
  };
}

async function updateJson(file, mutate) {
  let json;
  try {
    json = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  mutate(json);
  await writeFile(file, JSON.stringify(json, null, 2));
}

function storyFrom(episode, photos, index) {
  const segment = episode.segments?.[index] || {};
  const extra = (photos || []).find((item) => item.segment === index + 1) || {};
  return {
    segment: index + 1,
    id: extra.id || segment.id || segment.topicId || index + 1,
    league: segment.league || extra.league || "",
    sport: segment.footage?.sport || segment.sport || extra.sport || "",
    headline: segment.headline || extra.headline || "",
    teams: segment.footage?.teams || extra.teams || [],
    plate: segment.plate || extra.plate || null,
    photos: extra.photos || segment.photos || [],
  };
}

// Writes thumbnails/episode.jpg and one JPEG per Short into the cut folder.
// A failed check throws so the edition is not marked ready.
export async function renderCutThumbnails({ directory, episode, listing, photos = [], shorts = [] }) {
  if (!thumbnailsEnabled()) return null;
  const folder = path.join(directory, "thumbnails");
  await mkdir(folder, { recursive: true });
  const stories = (episode?.segments || []).map((_, index) => storyFrom(episode, photos, index));
  const files = { episode: "thumbnails/episode.jpg", shorts: {} };
  const checks = [];
  const logoCache = { directories: new Map() };
  const jobs = [
    {
      label: "episode",
      kind: "episode",
      file: files.episode,
      text: listing?.episode?.thumbnail,
      stories,
      size: EPISODE_SIZE,
    },
    ...shorts.map((short) => ({
      label: `Short ${short.segment}`,
      kind: "short",
      file: `thumbnails/segment-${String(short.segment).padStart(2, "0")}.jpg`,
      text: listing?.shorts?.find((item) => item.segment === short.segment)?.thumbnail,
      stories: [stories[(short.segment || 1) - 1] || stories[0] || {}],
      size: SHORT_SIZE,
    })),
  ];
  for (const job of jobs) {
    const coverStories = coverStoriesForText(job.text, job.stories.filter(Boolean));
    const lead = coverStories[0] || {};
    const coverText = [job.text, lead.headline, ...(lead.teams || [])].filter(Boolean).join(" ");
    let logos = [];
    try {
      logos = await logosForTitle(coverText, { stories: coverStories, limit: LOGO_CAP, cache: logoCache });
    } catch {
      logos = [];
    }
    const canvas = await drawThumbnail({
      kind: job.kind,
      stories: coverStories,
      text: job.text,
      date: episode?.date,
      logos,
    });
    const jpeg = await encodeThumbnail(canvas);
    const check = inspectThumbnail(canvas, jpeg, job.size);
    checks.push({ target: job.kind === "episode" ? "episode" : String(job.stories[0]?.segment || job.label), ...check });
    if (!check.passed) throw new Error(`The ${job.label} thumbnail failed checks: ${check.failures.join("; ")}.`);
    await writeFile(path.join(directory, job.file), jpeg);
    if (job.kind === "short") files.shorts[String(job.stories[0]?.segment || "")] = job.file;
  }
  await updateJson(path.join(directory, "timeline.json"), (timeline) => {
    timeline.thumbnails = files;
  });
  await updateJson(path.join(directory, "qc.json"), (qc) => {
    qc.thumbnails = checks;
  });
  return { files, checks };
}
