import { execFile, spawn } from "node:child_process";
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { dataDir, ffmpegPath, root } from "../config.mjs";

// "Listen with Roger": the audio of the Spotify app on the desk PC, streamed
// as MP3 to signed-in desk viewers. One capture and one encoder feed every
// listener; they start with the first listener and stop with the last.
// The capture takes only Spotify's process tree (WASAPI process loopback),
// never other system sound. Windows 10 2004 or later only.

const run = promisify(execFile);
const CSC = "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe";
const SOURCE = path.join(root, "scripts", "windows", "spotify-capture.cs");
const HELPER = path.join(dataDir, "bin", "spotify-capture.exe");
const MAX_BACKLOG = 1024 * 1024; // A listener this far behind is dropped.

// The root Spotify process and its window title ("Artist - Song" while
// playing, "Spotify Premium" when paused), or null when Spotify is closed.
export async function findSpotify() {
  if (process.platform !== "win32") return null;
  const script = "$p = @(Get-CimInstance Win32_Process -Filter \"name='Spotify.exe'\"); if (-not $p.Count) { return }; "
    + "$ids = $p.ProcessId; $root = $p | Where-Object { $ids -notcontains $_.ParentProcessId } | Select-Object -First 1; "
    + "$title = (Get-Process -Id $ids -ErrorAction SilentlyContinue | Where-Object MainWindowTitle | Select-Object -First 1).MainWindowTitle; "
    + "[pscustomobject]@{ pid = $root.ProcessId; title = \"$title\" } | ConvertTo-Json -Compress";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 15_000, windowsHide: true });
  const found = stdout.trim() ? JSON.parse(stdout) : null;
  return found?.pid ? { pid: Number(found.pid), title: String(found.title || "") } : null;
}

// Builds the capture helper from source the first time, or after it changes.
export async function captureHelper() {
  const [source, built] = await Promise.all([stat(SOURCE), stat(HELPER).catch(() => null)]);
  if (built && built.mtimeMs >= source.mtimeMs) return HELPER;
  await mkdir(path.dirname(HELPER), { recursive: true });
  await run(CSC, ["/nologo", "/optimize", "/platform:x64", "/target:exe", `/out:${HELPER}`, SOURCE], { timeout: 60_000, windowsHide: true });
  return HELPER;
}

async function spawnCapture(pid) {
  return spawn(await captureHelper(), [String(pid)], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
}

function spawnEncoder() {
  return spawn(ffmpegPath, [
    "-hide_banner", "-loglevel", "error",
    "-f", "s16le", "-ar", "48000", "-ac", "2", "-i", "pipe:0",
    "-c:a", "libmp3lame", "-b:a", "192k", "-write_xing", "0", "-flush_packets", "1", "-f", "mp3", "pipe:1",
  ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
}

// "Artist - Song" while a track plays; the bare app name means paused.
export function nowPlaying(title) {
  const value = String(title || "").trim();
  return value && !/^Spotify(\s|$)/iu.test(value) ? value : "";
}

export class ListenStation {
  constructor({ find = findSpotify, capture = spawnCapture, encoder = spawnEncoder, cacheMs = 5000, now = () => Date.now() } = {}) {
    this.find = find;
    this.capture = capture;
    this.encoder = encoder;
    this.cacheMs = cacheMs;
    this.now = now;
    this.listeners = new Set();
    this.pipeline = null;
    this.cached = null;
  }

  async spotify() {
    if (this.cached && this.now() - this.cached.at < this.cacheMs) return this.cached.found;
    let found = null;
    try {
      found = await this.find();
    } catch (error) {
      console.warn(`[listen] Spotify lookup failed: ${error.message}`);
    }
    this.cached = { found, at: this.now() };
    return found;
  }

  async status() {
    const found = await this.spotify();
    const title = nowPlaying(found?.title);
    return { active: Boolean(found), playing: Boolean(title), title, listeners: this.listeners.size };
  }

  // Adds an HTTP response as a listener. Resolves false when Spotify is closed.
  async listen(res) {
    const found = await this.spotify();
    if (!found) return false;
    if (!this.pipeline) await this.start(found.pid);
    this.listeners.add(res);
    const leave = () => this.leave(res);
    res.on("close", leave);
    res.on("error", leave);
    return true;
  }

  async start(pid) {
    const capture = await this.capture(pid);
    const encoder = this.encoder();
    const pipeline = { capture, encoder };
    this.pipeline = pipeline;
    capture.stdout.pipe(encoder.stdin);
    encoder.stdin.on("error", () => {});
    encoder.stdout.on("data", (chunk) => {
      for (const res of this.listeners) {
        if (res.writableLength > MAX_BACKLOG) {
          res.destroy();
          continue;
        }
        res.write(chunk);
      }
    });
    capture.stderr?.on("data", (text) => console.warn(`[listen capture] ${String(text).trim()}`));
    encoder.stderr?.on("data", (text) => console.warn(`[listen encoder] ${String(text).trim()}`));
    // Spotify quit or the helper failed: end every listener's stream.
    const finish = () => {
      if (this.pipeline !== pipeline) return;
      this.stop();
      for (const res of this.listeners) res.end();
      this.listeners.clear();
      this.cached = null;
    };
    capture.on("exit", finish);
    capture.on("error", finish);
    encoder.on("exit", finish);
    encoder.on("error", finish);
  }

  leave(res) {
    if (!this.listeners.delete(res)) return;
    if (!this.listeners.size) this.stop();
  }

  stop() {
    const pipeline = this.pipeline;
    this.pipeline = null;
    if (!pipeline) return;
    pipeline.capture.kill();
    pipeline.encoder.kill();
  }
}
