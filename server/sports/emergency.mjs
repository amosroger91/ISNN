import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

// Emergency fix: a chat on the desk page with the Claude Code CLI on this PC,
// for when a build fails and nobody is at the keyboard. Each message is one
// `claude -p` run that resumes the same Claude session. The agent can change
// code and restart the desk, so it must not live inside the desk's process
// tree: Task Scheduler ends every process in the "ISNN Desk" job when the task
// stops, which would kill the agent halfway through its own restart. Each run
// is therefore started through WMI (outside the job) with its output streamed
// to a file under data/emergency, and the page polls that file, so the chat
// carries on after the desk comes back.
const run = promisify(execFile);
const MAX_MESSAGE = 8000;

export function emergencyContext(root) {
  return [
    "You are the on-call engineer for the Wellspring Media Sports desk (ISNN), reached from the Emergency fix chat on the desk's web page.",
    "The person may be on a phone, away from the PC. Keep replies short and plain. Say what you found, what you changed and whether it is verified.",
    `Repository: ${root}. Node ESM server, React client. Tests: npm test (they must pass before any restart).`,
    "The live desk is the Windows scheduled task \"ISNN Desk\" (scripts/windows/run-desk.cmd), serving http://127.0.0.1:4320. Its log is data/logs/desk.log.",
    "Each day's edition is data/sports/editions/<YYYY-MM-DD>/edition.json (status, error, generationRetry, buildAttempts). Finished cuts are in the revision folders beside it.",
    "To restart the desk after a fix, run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows/restart-desk.ps1 . You run outside the desk, so the restart does not stop you.",
    "Rules: reproduce a failure before fixing it, fix the cause rather than the symptom, add or update a test, run npm test, then restart. Never upload to YouTube, never change publishing or upload settings, never delete editions or footage, never commit or push.",
    "If the fix needs a decision only the owner can make, stop and ask in one short question.",
  ].join("\n");
}

// Turns Claude's stream-json lines into what the chat shows.
export function readEvents(text) {
  const items = [];
  let sessionId = null;
  let done = false;
  for (const line of String(text || "").split(/\r?\n/u)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.session_id) sessionId = event.session_id;
    if (event.type === "assistant") {
      for (const block of event.message?.content || []) {
        if (block.type === "text" && block.text?.trim()) items.push({ kind: "text", text: block.text.trim() });
        if (block.type === "tool_use") items.push({ kind: "tool", text: toolLine(block.name, block.input) });
      }
    } else if (event.type === "result") {
      done = true;
      if (event.is_error) items.push({ kind: "error", text: String(event.result || event.subtype || "The agent stopped with an error.").slice(0, 2000) });
    }
  }
  return { items, sessionId, done };
}

function toolLine(name, input = {}) {
  const detail = input.command || input.file_path || input.path || input.pattern || input.url || input.description || "";
  return `${name}${detail ? `: ${String(detail).replace(/\s+/gu, " ").slice(0, 220)}` : ""}`;
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// Starts the command through WMI so it is not part of the desk's job object.
export async function launchDetached(commandLine, cwd) {
  const script = "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $env:EMERGENCY_COMMAND; CurrentDirectory = $env:EMERGENCY_CWD }; "
    + "if ($r.ReturnValue -ne 0) { throw \"Win32_Process.Create returned $($r.ReturnValue)\" }; $r.ProcessId";
  const { stdout } = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    env: { ...process.env, EMERGENCY_COMMAND: commandLine, EMERGENCY_CWD: cwd }, windowsHide: true, timeout: 60_000,
  });
  const pid = Number.parseInt(String(stdout).trim().split(/\s+/u).pop(), 10);
  if (!Number.isInteger(pid)) throw new Error("The emergency agent did not start.");
  return pid;
}

export class EmergencyDesk {
  constructor({ directory, root, claude = process.env.SPORTS_EMERGENCY_CLAUDE || "claude", launch = launchDetached, isAlive = alive, stop } = {}) {
    this.directory = directory;
    this.root = root;
    this.claude = claude;
    this.launch = launch;
    this.isAlive = isAlive;
    this.stopProcess = stop || ((pid) => run("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true }).catch(() => {}));
  }

  get enabled() {
    return !/^(?:0|false|off|no)$/iu.test(process.env.SPORTS_EMERGENCY_AGENT || "");
  }

  folder(id) {
    if (!/^[a-z0-9-]{6,40}$/u.test(String(id || ""))) throw Object.assign(new Error("No such emergency chat."), { status: 404 });
    return path.join(this.directory, id);
  }

  meta(id) {
    const file = path.join(this.folder(id), "meta.json");
    if (!existsSync(file)) throw Object.assign(new Error("No such emergency chat."), { status: 404 });
    return JSON.parse(readFileSync(file, "utf8"));
  }

  latestId() {
    if (!existsSync(this.directory)) return null;
    const ids = readdirSync(this.directory).filter((name) => existsSync(path.join(this.directory, name, "meta.json")));
    ids.sort((a, b) => this.meta(b).createdAt.localeCompare(this.meta(a).createdAt));
    return ids[0] || null;
  }

  view(id = this.latestId()) {
    if (!id) return { enabled: this.enabled, chat: null };
    const meta = this.meta(id);
    let sessionId = null;
    let running = false;
    const turns = meta.turns.map((turn) => {
      const events = path.join(this.folder(id), `turn-${turn.n}.jsonl`);
      const read = readEvents(existsSync(events) ? readFileSync(events, "utf8") : "");
      if (read.sessionId) sessionId = read.sessionId;
      const stillRunning = !read.done && this.isAlive(turn.pid);
      if (stillRunning) running = true;
      const items = [...read.items];
      if (!read.done && !stillRunning) {
        const errors = path.join(this.folder(id), `turn-${turn.n}.err`);
        const detail = existsSync(errors) ? readFileSync(errors, "utf8").trim().slice(-1500) : "";
        items.push({ kind: "error", text: turn.stopped ? "Stopped." : `The agent ended without finishing.${detail ? ` ${detail}` : ""}` });
      }
      return { n: turn.n, at: turn.at, message: turn.message, items, running: stillRunning };
    });
    return { enabled: this.enabled, chat: { id, createdAt: meta.createdAt, sessionId, running, turns } };
  }

  async send(message, id) {
    if (!this.enabled) throw Object.assign(new Error("The emergency agent is switched off (SPORTS_EMERGENCY_AGENT)."), { status: 403 });
    const text = String(message || "").trim().slice(0, MAX_MESSAGE);
    if (!text) throw Object.assign(new Error("Write what is wrong first."), { status: 400 });
    const fresh = !id;
    const chatId = id || `${new Date().toISOString().slice(0, 10)}-${randomBytes(4).toString("hex")}`;
    const folder = this.folder(chatId);
    const current = fresh ? null : this.view(chatId).chat;
    if (current?.running) throw Object.assign(new Error("The agent is still working on the last message."), { status: 409 });
    if (!fresh && !current) throw Object.assign(new Error("No such emergency chat."), { status: 404 });
    mkdirSync(folder, { recursive: true });
    const meta = fresh ? { id: chatId, createdAt: new Date().toISOString(), turns: [] } : this.meta(chatId);
    const n = meta.turns.length + 1;
    const prompt = path.join(folder, `prompt-${n}.txt`);
    writeFileSync(prompt, fresh ? `${emergencyContext(this.root)}\n\nThe owner writes:\n${text}` : text);
    const resume = current?.sessionId ? ` --resume ${current.sessionId}` : "";
    const quote = (value) => `"${value}"`;
    const commandLine = `cmd.exe /d /s /c "${quote(this.claude)} -p --output-format stream-json --verbose --dangerously-skip-permissions${resume}`
      + ` < ${quote(prompt)} > ${quote(path.join(folder, `turn-${n}.jsonl`))} 2> ${quote(path.join(folder, `turn-${n}.err`))}"`;
    const pid = await this.launch(commandLine, this.root);
    meta.turns.push({ n, at: new Date().toISOString(), message: text, pid });
    writeFileSync(path.join(folder, "meta.json"), JSON.stringify(meta, null, 2));
    return this.view(chatId);
  }

  async stop(id) {
    const meta = this.meta(id);
    const last = meta.turns.at(-1);
    if (last && this.isAlive(last.pid)) {
      await this.stopProcess(last.pid);
      last.stopped = true;
      writeFileSync(path.join(this.folder(id), "meta.json"), JSON.stringify(meta, null, 2));
    }
    return this.view(id);
  }
}
