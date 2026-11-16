import express from "express";
import { access } from "node:fs/promises";
import { ZodError } from "zod";
import { ffmpegPath, ffprobePath, host, publicUrl } from "./config.mjs";
import { SportsDesk } from "./sports/desk.mjs";
import { mountSports } from "./sports/routes.mjs";

export async function createApp({ sports = new SportsDesk() } = {}) {
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const allowed = new Set(["localhost", "127.0.0.1", "[::1]", host]);
    if (publicUrl) allowed.add(new URL(publicUrl).hostname);
    if (!allowed.has(req.hostname)) return res.status(403).json({ error: "This app accepts local requests only." });
    res.set("X-Content-Type-Options", "nosniff");
    res.set("Referrer-Policy", "no-referrer");
    const origin = req.get("origin");
    if (origin && !["GET", "HEAD"].includes(req.method) && origin !== `${req.protocol}://${req.get("host")}` && origin !== publicUrl)
      return res.status(403).json({ error: "Cross-origin requests are not allowed." });
    next();
  });
  app.use(express.json({ limit: "64kb" }));
  // The desk is the whole site.
  app.get("/", (_req, res) => res.redirect("/sports"));
  mountSports(app, sports);

  app.get("/api/health", async (_req, res) => {
    const available = (file) => access(file).then(() => true, () => false);
    const tools = { ffmpeg: await available(ffmpegPath), ffprobe: await available(ffprobePath) };
    res.json({ ok: true, ready: Object.values(tools).every(Boolean), tools });
  });

  app.use("/api", (_req, res) => res.status(404).json({ error: "Endpoint not found." }));
  app.use((error, _req, res, _next) => {
    if (error instanceof ZodError) return res.status(400).json({ error: error.issues[0]?.message || "Invalid request." });
    if (error.code === "ENOENT") return res.status(404).json({ error: "Video or file not found." });
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "Invalid JSON." });
    if (error.status && error.status < 500) return res.status(error.status).json({ error: error.message });
    console.error(error);
    res.status(500).json({ error: "The server could not complete the request. Check the terminal for details." });
  });
  return { app, sports };
}
