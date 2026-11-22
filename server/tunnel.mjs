import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";

// A Cloudflare quick tunnel: a public https://<random>.trycloudflare.com link
// to this desk with no account or domain. The link changes every time the
// tunnel starts, so the desk accepts only the one it is serving right now and
// writes it to a file for the operator to send on.
let current = null;
export const tunnelHost = () => current;

const announced = /https:\/\/(?!api\.)([a-z0-9-]+\.trycloudflare\.com)/u;

export function startQuickTunnel({ binary = "cloudflared", port, file, log = console.log }) {
  const target = `http://127.0.0.1:${port}`;
  // A hard server restart can leave the working tunnel alive. Reuse it so
  // fixing the desk does not invalidate the viewer's URL and sign-in.
  let adopted;
  if (process.platform === "win32") {
    try {
      const previous = new URL(readFileSync(file, "utf8").trim());
      if (previous.protocol === "https:" && /^[a-z0-9-]+\.trycloudflare\.com$/u.test(previous.hostname) && !previous.username && !previous.password) {
        const result = spawnSync("powershell.exe", ["-NoProfile", "-Command",
          `Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object CommandLine -like '*--url ${target}*' | Select-Object -First 1 -ExpandProperty ProcessId`],
          { encoding: "utf8", windowsHide: true, timeout: 20_000 });
        const pid = Number(result.stdout?.trim());
        if (Number.isInteger(pid) && pid > 0) { adopted = pid; current = previous.hostname; }
      }
    } catch { /* no usable tunnel was left behind */ }
  }
  let child;
  let stopped = false;
  const run = () => {
    let output = "";
    child = spawn(binary, ["tunnel", "--no-autoupdate", "--url", target], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    child.stderr.on("data", (chunk) => {
      output = (output + chunk).slice(-4000);
      const match = announced.exec(output);
      if (!match || match[1] === current) return;
      current = match[1];
      log(`Quick tunnel: https://${current}/`);
      writeFile(file, `https://${current}/\n`).catch(() => {});
    });
    child.on("error", (error) => log(`[tunnel] ${error.message}`));
    child.on("exit", (code) => {
      current = null;
      if (stopped) return;
      log(`[tunnel] cloudflared exited (${code}); starting a new tunnel in 30 seconds.`);
      setTimeout(() => { if (!stopped) run(); }, 30_000);
    });
  };
  let monitor;
  if (adopted) {
    log(`Reusing quick tunnel: https://${current}/`);
    monitor = setInterval(() => {
      try { process.kill(adopted, 0); } catch {
        clearInterval(monitor); adopted = null; current = null; if (!stopped) run();
      }
    }, 10_000).unref();
  } else run();
  return () => {
    stopped = true;
    current = null;
    clearInterval(monitor);
    if (adopted) return Promise.resolve();
    child?.kill();
    return rm(file, { force: true }).catch(() => {});
  };
}
