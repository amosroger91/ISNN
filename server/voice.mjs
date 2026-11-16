import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { env } from "@huggingface/transformers";
import { dataDir, modelCacheDir, root } from "./config.mjs";

// Kokoro-82M (Apache-2.0): natural, expressive narration that runs on the CPU.
env.cacheDir = modelCacheDir;
export const VOICES = {
  af_heart: "Heart — warm, gentle (female)",
  af_bella: "Bella — bright, clear (female)",
  bf_emma: "Emma — calm British (female)",
  am_michael: "Michael — steady, reassuring (male)",
  am_fenrir: "Fenrir — deep, resonant (male)",
  bm_george: "George — classic British (male)",
  bm_lewis: "Lewis — deep, weathered (male)",
};
export const DEFAULT_VOICE = "am_michael";
const RATE = 24000;
// Default pace and pause between parts (the desk passes its own speed).
const SPEED = 0.9;
const PAUSE_BETWEEN_CHUNKS = 0.38;

let engine;
async function loadVoice(report) {
  const { KokoroTTS } = await import("kokoro-js");
  let last = 0;
  engine ||= KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", {
    dtype: process.env.KOKORO_DTYPE || "fp32",
    device: "cpu",
    progress_callback: (event) => {
      if (event.status !== "progress" || Date.now() - last < 750) return;
      last = Date.now();
      report(`Downloading the narration voice: ${Math.round(event.progress || 0)}%…`);
    },
  });
  try {
    return await engine;
  } catch (error) {
    engine = null;
    throw error;
  }
}

// Gently fades a chunk's edges so joins never click.
function soften(samples) {
  const fade = Math.min(samples.length >> 2, Math.round(RATE * 0.012));
  for (let i = 0; i < fade; i++) {
    samples[i] *= i / fade;
    samples[samples.length - 1 - i] *= i / fade;
  }
  return samples;
}

// Narrates a list of parts in order and records where each spoken part sits.
export async function narrateParts(parts, voice, file, report = () => {}, signal, { speed = SPEED, prepareText = (text) => text } = {}) {
  if (voice === "isaac" || process.env.SPORTS_TTS === "qwen") return narrateIsaac(parts, file, report, signal, { prepareText });
  if (!Object.hasOwn(VOICES, voice)) voice = DEFAULT_VOICE;
  const tts = await loadVoice(report);
  const lead = Math.round(RATE * 0.15);
  const pieces = [new Float32Array(lead)];
  const segments = [];
  let cursor = lead;
  try {
    for (const [index, part] of parts.entries()) {
      signal?.throwIfAborted();
      report(`Recording the narration (${index + 1} of ${parts.length})…`);
      const audio = await tts.generate(prepareText(part.text), { voice, speed });
      const samples = soften(Float32Array.from(audio.audio));
      segments.push({ kind: part.kind, text: part.text, start: cursor / RATE, end: (cursor + samples.length) / RATE });
      const silence = new Float32Array(Math.round(RATE * (index === parts.length - 1 ? 0.3 : part.pause ?? PAUSE_BETWEEN_CHUNKS)));
      pieces.push(samples, silence);
      cursor += samples.length + silence.length;
    }
    const total = new Float32Array(cursor);
    let offset = 0;
    for (const piece of pieces) {
      total.set(piece, offset);
      offset += piece.length;
    }
    await writeFile(file, wav(total, RATE));
    return { file, voice, engine: "kokoro", rate: RATE, duration: total.length / RATE, segments };
  } finally {
    // Keep memory free for rendering, even if narration was cancelled.
    engine = null;
    await tts.model?.dispose?.();
  }
}

const ISAAC_MODEL = process.env.SPORTS_TTS_MODEL || path.join(modelCacheDir, "..", "qwen3-tts-0.6B-Base");
const ISAAC_REF = process.env.SPORTS_VOICE_REF || path.join(dataDir, "sports", "voice", "isaac.wav");
const ISAAC_TEXT = process.env.SPORTS_VOICE_REF_TEXT || path.join(dataDir, "sports", "voice", "isaac.txt");

// One Python process speaks every part, so the clone loads once per episode.
async function narrateIsaac(parts, file, report, signal, { prepareText = (text) => text } = {}) {
  signal?.throwIfAborted();
  const directory = await mkdtemp(path.join(tmpdir(), "isaac-narration-"));
  try {
    const job = path.join(directory, "job.json");
    await writeFile(job, JSON.stringify({
      model: ISAAC_MODEL,
      refAudio: ISAAC_REF,
      refText: ISAAC_TEXT,
      outDir: directory,
      parts: parts.map((part) => prepareText(part.text)),
    }));
    signal?.throwIfAborted();
    report("Loading Isaac's voice…");
    await runIsaac(job, report, signal);
    const { rate, files, pacing } = JSON.parse(await readFile(path.join(directory, "result.json"), "utf8"));
    if (rate !== RATE) throw new Error(`Isaac's voice returned ${rate} Hz audio. The desk expects ${RATE} Hz.`);
    const lead = Math.round(RATE * 0.10);
    const pieces = [new Float32Array(lead)];
    const segments = [];
    let cursor = lead;
    for (const [index, part] of parts.entries()) {
      const samples = soften(await readWav(path.join(directory, files[index])));
      segments.push({ kind: part.kind, text: part.text, start: cursor / RATE, end: (cursor + samples.length) / RATE });
      const silence = new Float32Array(Math.round(RATE * (index === parts.length - 1 ? 0.22 : part.pause ?? PAUSE_BETWEEN_CHUNKS)));
      pieces.push(samples, silence);
      cursor += samples.length + silence.length;
    }
    const total = new Float32Array(cursor);
    let offset = 0;
    for (const piece of pieces) {
      total.set(piece, offset);
      offset += piece.length;
    }
    await writeFile(file, wav(total, RATE));
    return { file, voice: "isaac", engine: "qwen3-tts-0.6b-base", rate: RATE, duration: total.length / RATE, segments, pacing };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function isaacFailure(errorText, code) {
  const text = String(errorText || "");
  const cause = text.match(/CUDA error:[^\n]+|AcceleratorError:[^\n]+|RuntimeError:[^\n]+/);
  if (cause) return cause[0].replace(/^AcceleratorError:\s*/u, "").trim();
  const useful = text.split("\n").map((line) => line.trim()).filter((line) => line && !/sox|SoX|sourceforge|path variables|LOADING|PART \d|RETAKE \d|pad_token_id|^\^+\s*$/iu.test(line));
  return useful.at(-1) || `Isaac's voice exited ${code}.`;
}

function runIsaac(job, report, signal) {
  const once = () => new Promise((resolve, reject) => {
    const child = spawn(process.env.SPORTS_TTS_PYTHON || "python", [path.join(root, "scripts", "isaac-narrate.py"), job], { stdio: ["ignore", "ignore", "pipe"] });
    let errorText = "";
    const stop = () => child.kill();
    signal?.addEventListener("abort", stop, { once: true });
    child.stderr.on("data", (chunk) => {
      const line = String(chunk);
      errorText += line;
      const match = line.match(/PART (\d+)\/(\d+)/);
      if (match) report(`Recording Isaac (${match[1]} of ${match[2]})…`);
      const retake = line.match(/RETAKE (\d+)/);
      if (retake) report(`Retaking Isaac’s narration (phrase ${retake[1]})…`);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      signal?.removeEventListener("abort", stop);
      if (signal?.aborted) reject(signal.reason);
      else if (code === 0) resolve();
      else reject(Object.assign(new Error(isaacFailure(errorText, code)), { detail: errorText }));
    });
  });
  return once().catch((error) => {
    if (signal?.aborted || !/CUDA error|illegal memory access|AcceleratorError/u.test(`${error.message}\n${error.detail || ""}`)) throw error;
    report("Isaac’s voice hit a graphics fault. Recording the episode again…");
    return once();
  });
}

async function readWav(file) {
  const buffer = await readFile(file);
  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    if (id === "data") {
      const samples = new Float32Array(size / 2);
      for (let index = 0; index < samples.length; index += 1) samples[index] = buffer.readInt16LE(offset + 8 + index * 2) / 32768;
      return samples;
    }
    offset += 8 + size + (size % 2);
  }
  throw new Error(`No audio data in ${file}.`);
}

// 16-bit mono PCM WAV.
export function wav(samples, rate) {
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples.length * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++)
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), 44 + i * 2);
  return buffer;
}
