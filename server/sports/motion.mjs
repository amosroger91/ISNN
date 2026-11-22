import { once } from "node:events";
import { spawn } from "node:child_process";
import { createTimeline } from "animejs";
import { createCanvas } from "../canvas.mjs";
import { ffmpegPath } from "../config.mjs";
import { run } from "../process.mjs";

// Mean absolute difference, on a 0–255 scale, below which a sampled pair counts
// as still. A run of those pairs longer than 1.5s fails the build.
export const STILL_DIFF = 1.5;
// Holds up to this long are reported as warnings; longer ones fail the build.
export const STILL_FAIL_SECONDS = 5;
const SAMPLE_STEP = 0.5;

function spawnProcess(args, { signal, timeout }) {
  const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
  });
  let encodeError = null;
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("The motion encode timed out."));
    }, timeout);
    const abort = () => {
      child.kill();
      reject(new Error("Cancelled."));
    };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.on("error", (error) => {
      encodeError = error;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (code === 0) resolve();
      else reject(encodeError || new Error(stderr.trim() || `ffmpeg exited with code ${code}.`));
    });
  });
  return { child, done, stderr: () => stderr };
}

// Splits the timeline the same way the canvas does: the first clip that contains
// a moment wins, and adjacent pieces of the same file play as one shot.
export function underlaySegments(clips, duration) {
  const list = (clips || []).filter((clip) => clip?.file && clip.end > clip.start);
  if (!(duration > 0) || !list.length) return [];
  const points = [0, duration];
  for (const clip of list) {
    if (clip.start > 0 && clip.start < duration) points.push(clip.start);
    if (clip.end > 0 && clip.end < duration) points.push(clip.end);
  }
  points.sort((left, right) => left - right);
  const segments = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index];
    const end = points[index + 1];
    if (end - start < 0.001) continue;
    const clip = list.find((item) => start >= item.start && start < item.end) || null;
    const file = clip?.file || null;
    const previous = segments.at(-1);
    if (previous && previous.file === file && Math.abs(previous.end - start) < 0.001) {
      previous.end = end;
      continue;
    }
    segments.push({ file, start, end });
  }
  return segments;
}

// The broadcast canvas is premultiplied RGBA. ffmpeg places that overlay on the
// footage, so Node never copies a 1080p game frame into the canvas.
export function underlayGraph({ width, height, fps, clips, duration }) {
  const segments = underlaySegments(clips, duration);
  if (!segments.some((segment) => segment.file)) return null;
  const inputs = [];
  const filters = [];
  const pieces = [];
  let inputIndex = 1;
  for (const segment of segments) {
    const length = Math.max(0.001, segment.end - segment.start).toFixed(6);
    const label = `u${pieces.length}`;
    if (!segment.file) {
      filters.push(`color=c=black:s=${width}x${height}:r=${fps}:d=${length},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[${label}]`);
    } else {
      inputs.push({ file: segment.file, duration: length });
      filters.push(`[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},setsar=1,fps=${fps},trim=duration=${length},setpts=PTS-STARTPTS,format=yuv420p[${label}]`);
      inputIndex += 1;
    }
    pieces.push(`[${label}]`);
  }
  filters.push(`${pieces.join("")}concat=n=${pieces.length}:v=1:a=0[bg]`);
  filters.push("[bg][0:v]overlay=0:0:format=auto:alpha=premultiplied:eof_action=pass[v]");
  return { inputs, filters: filters.join(";"), audioInput: inputIndex };
}

// Draws every frame in Node and pipes raw RGBA to ffmpeg. build() registers
// anime.js tweens; seek() makes frame n deterministic.
export async function renderMotion({
  width, height, fps = 30, duration, build, draw, prepare, audio, output, signal, report, timeout, underlay,
}) {
  if (!(width > 0 && height > 0 && fps > 0 && duration > 0) || !audio?.file || !output) {
    throw new Error("renderMotion needs a frame size, a duration, an audio file and an output path.");
  }
  const state = {};
  const timeline = createTimeline({ autoplay: false });
  build(timeline, state);
  const frames = Math.max(1, Math.round(duration * fps));
  const trim = audio.trim
    ? `atrim=start=${audio.trim.start.toFixed(6)}:end=${audio.trim.end.toFixed(6)},asetpts=PTS-STARTPTS,`
    : "";
  const audioFilter = `${trim}${audio.filter || "anull"}`;
  const graph = Array.isArray(underlay) && underlay.length
    ? underlayGraph({ width, height, fps, clips: underlay, duration })
    : null;
  const audioInput = graph ? graph.audioInput : 1;
  const args = [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${width}x${height}`, "-r", String(fps), "-i", "pipe:0",
    ...(graph ? graph.inputs.flatMap((input) => ["-stream_loop", "-1", "-t", input.duration, "-i", input.file]) : []),
    "-i", audio.file,
    "-filter_complex", graph
      ? `${graph.filters};[${audioInput}:a]${audioFilter}[a]`
      : `[0:v]format=yuv420p[v];[1:a]${audioFilter}[a]`,
    "-map", "[v]", "-map", "[a]",
    "-c:v", "libx264", "-threads", "6", "-preset", "fast", "-crf", "18", "-pix_fmt", "yuv420p",
    "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
    "-r", String(fps), "-fps_mode", "cfr",
    "-ar", "48000", "-ac", "2", "-c:a", "aac", "-b:a", "192k",
    "-movflags", "+faststart", "-t", duration.toFixed(6), output,
  ];
  const encodeTimeout = timeout || Math.max(120_000, duration * 8_000);
  const { child, done } = spawnProcess(args, { signal, timeout: encodeTimeout });
  const fail = done.then(() => null, (error) => error);
  child.stdin.on("error", () => {});
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  const started = performance.now();
  const bytes = width * height * 4;
  try {
    for (let index = 0; index < frames; index += 1) {
      signal?.throwIfAborted();
      const early = await Promise.race([fail, Promise.resolve(null)]);
      if (early) throw early;
      const t = index / fps;
      timeline.seek((index * 1000) / fps);
      if (prepare) await prepare(t);
      draw(ctx, state, t);
      const raw = canvas.data();
      if (raw.length !== bytes) throw new Error(`Frame buffer is ${raw.length} bytes, expected ${bytes}.`);
      const frame = Buffer.from(raw);
      if (!child.stdin.write(frame)) await once(child.stdin, "drain");
      if (report && index % fps === 0) report(index / frames);
    }
    child.stdin.end();
    await done;
  } catch (error) {
    child.kill();
    child.stdin.destroy();
    await done.catch(() => {});
    throw error;
  }
  const renderFps = frames / Math.max(0.001, (performance.now() - started) / 1000);
  return { frames, renderFps: Number(renderFps.toFixed(2)) };
}

// Decodes a scaled clip as raw RGBA, one frame per read, in order.
export function openRawClip(file, width, height, signal) {
  const size = width * height * 4;
  const args = [
    "-hide_banner", "-loglevel", "error", "-i", file,
    "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=30`,
    "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1",
  ];
  const child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", () => {});
  const abort = () => child.kill();
  signal?.addEventListener("abort", abort, { once: true });
  let pending = Buffer.alloc(0);
  let waiter = null;
  let ended = false;
  const pump = () => {
    if (!waiter || pending.length < size) return;
    const frame = Buffer.from(pending.subarray(0, size));
    pending = pending.subarray(size);
    const resolve = waiter;
    waiter = null;
    resolve(frame);
  };
  child.stdout.on("data", (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    pump();
  });
  child.stdout.on("end", () => {
    ended = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  });
  child.on("error", () => {
    ended = true;
    if (waiter) {
      const resolve = waiter;
      waiter = null;
      resolve(null);
    }
  });
  return {
    read() {
      if (pending.length >= size) {
        const frame = Buffer.from(pending.subarray(0, size));
        pending = pending.subarray(size);
        return Promise.resolve(frame);
      }
      if (ended) return Promise.resolve(null);
      return new Promise((resolve) => {
        waiter = resolve;
        pump();
      });
    },
    close() {
      signal?.removeEventListener("abort", abort);
      child.kill();
    },
  };
}

export async function measureMotion(file, signal) {
  const buffer = await run(ffmpegPath, [
    "-hide_banner", "-loglevel", "error", "-i", file,
    "-vf", "fps=2,scale=64:36,format=gray",
    "-f", "rawvideo", "-pix_fmt", "gray", "pipe:1",
  ], { signal, binary: true, maxBytes: 80 * 1024 * 1024, timeout: 180_000 });
  const size = 64 * 36;
  const frames = Math.floor(buffer.length / size);
  let minDiff = Number.POSITIVE_INFINITY;
  let longest = 0;
  let runLength = 0;
  for (let index = 1; index < frames; index += 1) {
    let total = 0;
    const previous = (index - 1) * size;
    const current = index * size;
    for (let pixel = 0; pixel < size; pixel += 1) total += Math.abs(buffer[current + pixel] - buffer[previous + pixel]);
    const diff = total / size;
    if (diff < minDiff) minDiff = diff;
    if (diff < STILL_DIFF) {
      runLength += SAMPLE_STEP;
      if (runLength > longest) longest = runLength;
    } else runLength = 0;
  }
  if (!Number.isFinite(minDiff)) minDiff = 0;
  const longestStillSeconds = Number(longest.toFixed(2));
  return {
    minDiff: Number(minDiff.toFixed(3)),
    longestStillSeconds,
    samples: frames,
    passed: frames >= 2 && longestStillSeconds <= STILL_FAIL_SECONDS,
    smooth: longestStillSeconds <= 1.5,
  };
}
