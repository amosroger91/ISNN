import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadImage } from "../canvas.mjs";
import { dataDir } from "../config.mjs";
import { footageSubjects, gameplay, includes, wording } from "./footage.mjs";

// Still photographs for the motion layer. ShareAlike stays blocked, the same
// rule CommonsFootage uses for video: CC0, public domain, and CC BY only.
const commonsOrigin = "https://commons.wikimedia.org";
const uploadOrigin = "https://upload.wikimedia.org";
const maxBytes = 8 * 1024 * 1024;
const rejectedArt = /logo|wordmark|uniform|jersey|seal|map|signature|diagram|chart|ticket|card|stamp|coin|poster|cover|screenshot/iu;
const licenseUrls = new Map([
  ["CC0", "https://creativecommons.org/publicdomain/zero/1.0/"],
  ["CC0 1.0", "https://creativecommons.org/publicdomain/zero/1.0/"],
  ["CC BY 4.0", "https://creativecommons.org/licenses/by/4.0/"],
  ["CC BY 3.0", "https://creativecommons.org/licenses/by/3.0/"],
  ["CC BY 2.5", "https://creativecommons.org/licenses/by/2.5/"],
  ["CC BY 2.0", "https://creativecommons.org/licenses/by/2.0/"],
  ["Public domain", "https://creativecommons.org/publicdomain/mark/1.0/"],
  ["PD", "https://creativecommons.org/publicdomain/mark/1.0/"],
  ["PD-USGov", "https://commons.wikimedia.org/wiki/Template:PD-USGov"],
  ["PD-US", "https://commons.wikimedia.org/wiki/Template:PD-US"],
]);

const plain = (value) => String(value || "").replace(/<[^>]*>/gu, " ").replace(/&nbsp;|&#160;/gu, " ")
  .replace(/&amp;/gu, "&").replace(/&#\d+;/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 600);

export function photoLicense(name) {
  const license = String(name || "").trim();
  if (!license || /sa|nc|nd/iu.test(license)) return null;
  if (licenseUrls.has(license)) return { license, licenseUrl: licenseUrls.get(license) };
  if (/^cc0\b/iu.test(license)) return { license, licenseUrl: licenseUrls.get("CC0") };
  if (/^public domain\b/iu.test(license) || /^pd(?:-|$)/iu.test(license)) return { license, licenseUrl: licenseUrls.get("Public domain") };
  return null;
}

// People first, then teams. Narration only adds a name when it is already one
// of this story's teams or people, so a random capitalized phrase is not a search.
export function imagerySubjects(segment) {
  const subjects = footageSubjects(segment).map((subject) => ({ ...subject, aliases: [...subject.aliases] }));
  const known = new Map();
  for (const name of segment.footage?.teams || []) known.set(wording(name), true);
  for (const name of segment.footage?.people || []) known.set(wording(name), false);
  for (const subject of subjects) for (const alias of subject.aliases) known.set(alias, subject.team);
  const names = String(segment.narration || "").match(/\b[\p{Lu}][\p{L}'’-]+(?:\s+[\p{Lu}][\p{L}'’-]+){1,2}\b/gu) || [];
  for (const raw of names) {
    const name = wording(raw);
    if (!known.has(name) || subjects.some((subject) => subject.aliases.includes(name))) continue;
    subjects.push({ aliases: [name], team: known.get(name) });
  }
  subjects.sort((a, b) => Number(a.team) - Number(b.team));
  return subjects;
}

export function commonsPhoto(page, subjects, sport) {
  const info = page?.imageinfo?.[0];
  if (!info || !Array.isArray(subjects) || !subjects.length) return null;
  const width = Number(info.width || info.thumbwidth || 0);
  const height = Number(info.height || info.thumbheight || 0);
  const jpeg = info.mime === "image/jpeg";
  const png = info.mime === "image/png" && width >= 1200;
  if ((!jpeg && !png) || width < 1000 || height < 700) return null;
  const metadata = info.extmetadata || {};
  const field = (name) => plain(metadata[name]?.value);
  if (field("Restrictions")) return null;
  const license = photoLicense(field("LicenseShortName"));
  if (!license) return null;
  const title = String(page.title || "").replace(/^File:/u, "").replace(/\.(?:jpe?g|png)$/iu, "").replaceAll("_", " ");
  const description = field("ImageDescription");
  if (rejectedArt.test(`${title} ${description}`)) return null;
  const downloadUrl = URL.parse(info.thumburl || "");
  const source = URL.parse(info.descriptionurl || "");
  if (!downloadUrl || downloadUrl.origin !== uploadOrigin || downloadUrl.username || downloadUrl.password) return null;
  if (!source || source.origin !== commonsOrigin || source.username || source.password) return null;
  const text = wording(`${title} ${description}`);
  const subject = subjects.find((item) => item.aliases.some((alias) => includes(text, alias)));
  if (!subject) return null;
  const creator = field("Artist");
  if (!creator) return null;
  return {
    pageUrl: source.href, downloadUrl: downloadUrl.href, title, description, creator,
    date: field("DateTimeOriginal"), width, height, portrait: height >= width, sport,
    ...license, subject, kind: subject.team ? "team" : "person",
  };
}

function describedPerson(photo, subjects) {
  const description = wording(photo.description || "");
  return subjects.some((subject) => !subject.team && subject.aliases.some((alias) => includes(description, alias)));
}

function teamInGame(photo, subjects, sport) {
  const description = wording(`${photo.title} ${photo.description}`);
  const team = subjects.some((subject) => subject.team && subject.aliases.some((alias) => includes(description, alias)));
  const played = sport && gameplay[sport] ? gameplay[sport].test(description) : false;
  return team && played;
}

export function rankPhotos(photos, subjects, sport, { portrait = false } = {}) {
  const time = (photo) => {
    const parsed = Date.parse(photo.date || "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [...photos].sort((a, b) => describedPerson(b, subjects) - describedPerson(a, subjects)
    || teamInGame(b, subjects, sport) - teamInGame(a, subjects, sport)
    || (portrait ? Number(b.portrait) - Number(a.portrait) : 0)
    || time(b) - time(a));
}

function photoQueries(subjects, sport) {
  const queries = [];
  for (const subject of subjects) {
    const name = subject.aliases[0];
    if (!name) continue;
    queries.push(`"${name}" filetype:bitmap`);
    if (subject.team && sport) queries.push(`"${name}" ${sport} filetype:bitmap`);
  }
  return queries.slice(0, 10);
}

function mixPhotos(ranked, count) {
  const people = ranked.filter((photo) => photo.kind === "person");
  const teams = ranked.filter((photo) => photo.kind === "team");
  const picked = [];
  const seen = new Set();
  const push = (photo) => {
    if (!photo || seen.has(photo.pageUrl) || picked.length >= count) return;
    seen.add(photo.pageUrl);
    picked.push(photo);
  };
  let person = 0;
  let team = 0;
  while (picked.length < count && (person < people.length || team < teams.length)) {
    if (person <= team && person < people.length) push(people[person++]);
    else if (team < teams.length) push(teams[team++]);
    else if (person < people.length) push(people[person++]);
    else break;
  }
  return picked;
}

function requestOptions(timeout, signal) {
  const deadline = AbortSignal.timeout(timeout);
  return {
    headers: { "User-Agent": "WellspringMediaSports/1.0 (Wikimedia Commons attribution shown on air)" },
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  };
}

async function searchPhotos(fetchImpl, query, subjects, sport, signal) {
  const params = new URLSearchParams({
    action: "query", format: "json", formatversion: "2", generator: "search", gsrnamespace: "6", gsrlimit: "40",
    gsrsearch: query, prop: "imageinfo", iiprop: "url|size|mime|extmetadata", iiurlwidth: "2400", maxlag: "5",
    iiextmetadatafilter: "Artist|LicenseShortName|Restrictions|ImageDescription|DateTimeOriginal",
  });
  const response = await fetchImpl(`${commonsOrigin}/w/api.php?${params}`, requestOptions(4500, signal));
  if (!response.ok) return [];
  const result = await response.json();
  const found = [];
  for (const page of result.query?.pages || []) {
    const photo = commonsPhoto(page, subjects, sport);
    if (photo) found.push(photo);
  }
  return found;
}

async function readBody(response) {
  if (!response?.ok || !response.body) return null;
  if (!/^image\/(?:jpeg|png)/iu.test(response.headers.get("content-type") || "")) return null;
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) return null;
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return length ? Buffer.concat(chunks) : null;
}

async function materialize(photo, directory, fetchImpl, signal) {
  await mkdir(directory, { recursive: true });
  const key = createHash("sha1").update(photo.pageUrl).digest("hex");
  const file = path.join(directory, `${key}.jpg`);
  const sidecar = path.join(directory, `${key}.json`);
  const credit = {
    title: photo.title, creator: photo.creator, license: photo.license, licenseUrl: photo.licenseUrl,
    url: photo.pageUrl, type: "photo",
  };
  const stored = { ...credit, subject: photo.subject, kind: photo.kind, width: photo.width, height: photo.height };
  try {
    const image = await loadImage(file);
    const meta = JSON.parse(await readFile(sidecar, "utf8"));
    if (meta?.url === photo.pageUrl) return { image, file, credit: meta, subject: meta.subject, kind: meta.kind };
  } catch {
    // Cache miss, or a half-written file. Download again.
  }
  const response = await fetchImpl(photo.downloadUrl, requestOptions(12000, signal));
  const bytes = await readBody(response);
  if (!bytes) return null;
  await writeFile(file, bytes);
  await writeFile(sidecar, JSON.stringify(stored));
  try {
    return { image: await loadImage(file), file, credit, subject: photo.subject, kind: photo.kind };
  } catch {
    return null;
  }
}

// One photo per four seconds, at least four and at most twelve when that many qualify.
export async function storyImagery(segment, { signal, fetchImpl = fetch, allowPreview = false, duration = 16, directory, portrait = false } = {}) {
  // allowPreview does not admit ShareAlike. Photos follow the desk's public-upload rule.
  void allowPreview;
  const sport = segment.footage?.sport && gameplay[segment.footage.sport] ? segment.footage.sport : "";
  const subjects = imagerySubjects(segment);
  const count = Math.min(12, Math.max(4, Math.round(Number(duration) / 4) || 4));
  const cache = directory || path.join(dataDir, "sports", "assets", "photos");
  const fetchJson = async (query, group) => {
    try {
      return await searchPhotos(fetchImpl, query, group, sport, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return [];
    }
  };
  try {
    const found = new Map();
    const queries = subjects.length ? photoQueries(subjects, sport) : [];
    for (let start = 0; start < queries.length; start += 3) {
      const batch = await Promise.all(queries.slice(start, start + 3).map((query) => fetchJson(query, subjects)));
      for (const photo of batch.flat()) found.set(photo.pageUrl, photo);
    }
    if (!found.size && sport) {
      const generic = { aliases: [sport, `${sport} game`], team: true };
      for (const photo of await fetchJson(`"${sport} game" filetype:bitmap`, [generic])) found.set(photo.pageUrl, photo);
    }
    const ranked = rankPhotos([...found.values()], subjects.length ? subjects : [{ aliases: [sport], team: true }], sport, { portrait });
    const wanted = mixPhotos(ranked, count);
    const extras = ranked.filter((photo) => !wanted.some((item) => item.pageUrl === photo.pageUrl));
    const saved = [];
    for (const photo of [...wanted, ...extras]) {
      if (saved.length >= count) break;
      const item = await materialize(photo, cache, fetchImpl, signal);
      if (item) saved.push(item);
    }
    return saved;
  } catch (error) {
    if (signal?.aborted) throw error;
    return [];
  }
}
