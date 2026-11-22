import express from "express";
import { spawn } from "node:child_process";
import path from "node:path";
import { createApp } from "./app.mjs";
import { SportsDesk } from "./sports/desk.mjs";
import { EmergencyDesk } from "./sports/emergency.mjs";
import { dataDir, root, port, host } from "./config.mjs";
import { startQuickTunnel } from "./tunnel.mjs";

// The live desk gets the Emergency fix agent: the page's chat and the 8:15 a.m.
// trigger when the episode is not on YouTube share one EmergencyDesk.
const emergency = new EmergencyDesk({ directory: path.join(dataDir, "emergency"), root });
const { app, sports } = await createApp({ sports: new SportsDesk({ emergency }) });
let vite;
if (process.argv.includes("--dev")) {
  const { createServer } = await import("vite");
  vite = await createServer({
    root,
    server: { middlewareMode: true },
    appType: "spa",
  });
  app.use(vite.middlewares);
} else {
  app.use(express.static(path.join(root, "dist")));
  app.get("/{*path}", (_req, res) =>
    res.sendFile(path.join(root, "dist/index.html")),
  );
}
const server = app.listen(port, host, () =>
  console.log(`Wellspring Media Sports is ready at http://${host}:${port}/`),
);

// Hosts without cron (a Windows desktop) let the server drive its own schedule:
// the same once-a-minute tick that deploy/sports.crontab sends to /api/sports/cron.
// The desk serializes ticks, so an external cron alongside this is harmless.
let ticker;
if (process.env.SPORTS_SELF_CRON === "true") {
  const tick = () => sports.tick().catch((error) => console.error(`[sports tick] ${error.message}`));
  ticker = setInterval(tick, 60_000);
  setTimeout(tick, 5_000);
  console.log("Overnight schedule: ticking every minute in this process.");
}
// Windows: hold off idle sleep while this server runs. The helper watches this
// process and lets go when it exits, even after a crash.
let keepAwake;
if (process.env.SPORTS_KEEP_AWAKE === "true" && process.platform === "win32") {
  keepAwake = spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
    path.join(root, "scripts", "windows", "keep-awake.ps1"), "-WhilePid", String(process.pid)], { stdio: "ignore", windowsHide: true });
  keepAwake.on("error", (error) => console.error(`[keep awake] ${error.message}`));
  console.log("Keeping this PC awake while the desk runs.");
}
// A public quick-tunnel link for remote access. It needs the desk login, so it
// will not start without SPORTS_DESK_PASSWORD.
let stopTunnel;
if (process.env.SPORTS_QUICK_TUNNEL === "true") {
  if (!process.env.SPORTS_DESK_PASSWORD) console.error("[tunnel] Set SPORTS_DESK_PASSWORD before opening a public tunnel; the tunnel was not started.");
  else stopTunnel = startQuickTunnel({ binary: process.env.SPORTS_CLOUDFLARED || "cloudflared", port, file: path.join(dataDir, "tunnel-url.txt") });
}
async function shutdown() {
  clearInterval(ticker);
  keepAwake?.kill();
  await stopTunnel?.();
  await vite?.close();
  server.close();
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
