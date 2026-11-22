import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { MAX_EPISODE_STORIES } from "../../shared/sports-limits.mjs";
import { deskError } from "./desk.mjs";
import { commonsFileTitle } from "./footage.mjs";
import { youtubeVideoId } from "./youtube-footage.mjs";
import { editorialEdits as chatEdits } from "./editorial.mjs";
import path from "node:path";
import { CATEGORIES, KINDS, REPEATS, ReminderBook } from "./reminders.mjs";
import { ListenStation } from "./listen.mjs";
import { CommentFeed } from "./comments.mjs";
import { EmergencyDesk } from "./emergency.mjs";
import { dataDir, root } from "../config.mjs";

const date = z.iso.date();
const requestDate = z.object({ date: date.optional() });
const topicId = z.string().regex(/^[\w-]{1,60}$/);
const claimId = z.string().regex(/^clm_[a-f0-9]{20}$/);
const title = z.string().trim().min(3).max(160);
const summary = z.string().trim().max(1200);
const take = z.string().trim().max(1800);
const clipUrl = z.union([z.literal(""), z.string().trim().max(1200).refine((value) => commonsFileTitle(value) || youtubeVideoId(value), "Use a YouTube video link or Wikimedia Commons File page.")]);
const url = z.url({ protocol: /^https?$/ }).max(1200).refine((value) => {
  const parsed = URL.parse(value);
  return parsed && !parsed.username && !parsed.password;
}, "Use an HTTP or HTTPS source link without credentials.");
const aliases = z.array(z.string().trim().min(2).max(80)).max(12);
const sport = z.enum(["basketball", "football", "baseball", "hockey", "soccer", "mma", "other"]).nullable();
const league = z.string().trim().min(2).max(40).nullable();
const teams = z.array(z.string().trim().min(2).max(60)).max(6);
const tagging = { sport: sport.optional(), league: league.optional(), teams: teams.optional() };
const topicFields = z.object({ title, summary, take, selected: z.boolean() });
const patchTopic = requestDate.extend(topicFields.partial().shape).extend({
  clipUrl: clipUrl.optional(),
  takeScript: z.string().trim().max(1200).optional(), draftTake: z.boolean().optional(),
  headline: z.string().trim().min(3).max(140).optional(), narration: z.string().trim().min(20).max(1800).optional(),
  storyId: z.string().trim().min(3).max(120).nullable().optional(), aliases: aliases.optional(), ...tagging,
});
const addTopic = requestDate.extend({ title, summary: summary.optional(), take: take.optional(), takeScript: z.string().trim().max(1200).optional(), clipUrl: clipUrl.optional(), url: url.optional(), excerpt: z.string().trim().max(1000).optional(), ...tagging });
const chatInput = requestDate.extend({ message: z.string().trim().min(1).max(2400), topicId: topicId.optional() });
const scanInput = requestDate.extend({ asOf: z.iso.datetime().optional() });
const trendInput = requestDate.extend({ aliases: aliases.optional() });
const coreInput = requestDate.extend({ topicId: topicId.nullable() });
const reason = z.string().trim().min(3).max(400);
const correctionInput = requestDate.extend({
  text: z.string().trim().min(3).max(300),
  value: z.union([z.number(), z.array(z.number()).max(6), z.string().trim().max(80), z.boolean()]).optional(),
  unit: z.string().trim().max(60).optional(),
  evidence: z.object({ url, locator: z.string().trim().min(1).max(160), publisher: z.string().trim().max(80).optional(), title: z.string().trim().max(200).optional(), excerpt: z.string().trim().max(1000).optional() }),
  reason,
});
const resolutionInput = requestDate.extend({ disposition: z.enum(["supported", "withheld"]), reason });
const clipId = z.string().regex(/^[\w.-]{1,80}$/u);
const clipReview = requestDate.extend({
  decision: z.enum(["approved", "rejected"]), in: z.number().min(0).max(3600).optional(), out: z.number().min(0).max(3600).optional(),
}).refine(({ in: start, out: end }) => start === undefined || end === undefined || end > start, "The out point must come after the in point.");

const reminderId = z.uuid();
const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/u, "Use a YYYY-MM month.");
const reminderFields = z.object({
  kind: z.enum(KINDS).optional(),
  category: z.enum(CATEGORIES).optional(),
  title: z.string().trim().min(1, "Name the reminder.").max(120),
  date,
  time: z.union([z.literal(""), z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/u, "Use a HH:MM time.")]).nullable().optional(),
  notes: z.string().trim().max(600).optional(),
  repeat: z.enum(REPEATS).optional(),
  leadDays: z.number().int().min(0).max(30).optional(),
});
const reminderQuery = z.object({ month: month.optional() });
const dismissal = z.object({ occurrence: date, stage: z.enum(["today", "tomorrow", "soon"]) });

function directLoopback(req) {
  return ["localhost", "127.0.0.1", "[::1]"].includes(req.hostname) &&
    ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress) &&
    !req.get("x-forwarded-for") && !req.get("forwarded");
}

function matches(value, expected) {
  const a = Buffer.from(value);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function deskAccess(req, res, next) {
  const password = process.env.SPORTS_DESK_PASSWORD;
  res.set("Cache-Control", "private, no-store");
  if (!password) {
    if (directLoopback(req)) return next();
    return res.status(403).json({ error: "Set SPORTS_DESK_PASSWORD to open the sports desk remotely." });
  }
  const authorization = /^Basic ([A-Za-z0-9+/=]+)$/i.exec(req.get("authorization") || "");
  const expected = `${process.env.SPORTS_DESK_USER || "isaac"}:${password}`;
  if (authorization && matches(Buffer.from(authorization[1], "base64").toString("utf8"), expected)) return next();
  res.set("WWW-Authenticate", 'Basic realm="Wellspring Media Sports", charset="UTF-8"');
  return res.status(401).json({ error: "Sign in to the sports desk." });
}

export function mountSports(app, desk, reminders = desk.reminders || new ReminderBook({
  file: path.join(desk.directory, "reminders.json"), timezone: desk.settings?.timezone, now: () => desk.now(),
})) {
  app.get("/", deskAccess, (_req, _res, next) => next());
  // Old bookmarks of the desk's former address.
  app.get(/^\/sports\/?$/i, (_req, res) => res.redirect(308, "/"));

  const router = Router();
  router.post("/cron", async (req, res) => {
    if (!directLoopback(req) || req.get("origin") || req.get("sec-fetch-site")) throw deskError(403, "Run the sports cron from the app host.");
    await desk.tick();
    res.sendStatus(204);
  });
  router.use(deskAccess);
  router.get("/edition", async (_req, res) => res.json(await desk.view()));
  // Listen with Roger: the desk PC's Spotify audio, for signed-in viewers only.
  const station = desk.listenStation || new ListenStation();
  router.get("/listen", async (_req, res) => res.json(await station.status()));
  router.get("/listen/stream", async (_req, res) => {
    res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "no-store", "X-Accel-Buffering": "no" });
    if (!await station.listen(res)) return res.status(404).json({ error: "Spotify isn’t open on the desk PC." });
    res.flushHeaders();
  });
  router.post("/revision", async (req, res) => {
    const { date } = requestDate.parse(req.body || {});
    res.json(await desk.reopen(date));
  });
  router.post("/cancel", async (req, res) => {
    const { date } = requestDate.parse(req.body || {});
    res.json(await desk.cancelGeneration(date));
  });
  router.get("/ledger", async (_req, res) => res.json(await desk.ledgerView()));
  router.get("/trend", async (_req, res) => {
    const { edition } = await desk.view();
    res.json({ date: edition.date, trendDesk: edition.trendDesk, providers: desk.settings.trendProviders });
  });
  for (const task of ["research", "build"]) {
    router.post(`/${task}`, async (req, res) => {
      const { date } = requestDate.parse(req.body || {});
      res.status(202).json(await desk.run(task, date));
    });
  }
  const youtubeTarget = z.union([z.literal("episode"), z.coerce.number().int().min(1).max(MAX_EPISODE_STORIES)]);
  router.post("/youtube", async (req, res) => {
    const { date, target } = requestDate.extend({ target: youtubeTarget }).parse(req.body || {});
    res.status(202).json(await desk.uploadNow(target, date));
  });
  router.post("/youtube/all", async (req, res) => {
    const { date } = requestDate.parse(req.body || {});
    res.status(202).json(await desk.uploadAll(date));
  });
  router.post("/youtube/thumbnail", async (req, res) => {
    const { date, target } = requestDate.extend({ target: youtubeTarget }).parse(req.body || {});
    res.json(await desk.resendThumbnail(target, date));
  });
  router.post("/thumbnails", async (req, res) => {
    const { date, target, text } = requestDate.extend({
      target: youtubeTarget.optional(),
      text: z.string().max(80).optional(),
    }).parse(req.body || {});
    res.json(await desk.regenerateThumbnails({ date, target, text }));
  });
  router.post("/comments", async (_req, res) => {
    res.status(202).json(await desk.replyToComments());
  });
  const commentFeed = desk.commentFeed || new CommentFeed();
  router.get("/comments/threads", async (req, res) => {
    const { refresh } = z.object({ refresh: z.enum(["1"]).optional() }).parse(req.query);
    try {
      res.json(await commentFeed.view({ refresh: Boolean(refresh) }));
    } catch (error) {
      // Shown on the tab as-is: missing credentials, scope or quota.
      throw deskError(409, error.message);
    }
  });
  router.post("/evidence/scan", async (req, res) => {
    const { date, asOf } = scanInput.parse(req.body || {});
    res.json(await desk.scanSlate(date, { asOf }));
  });
  router.get("/reminders", async (req, res) => {
    res.json(await reminders.view(reminderQuery.parse(req.query).month));
  });
  router.post("/reminders", async (req, res) => {
    const { month: shown } = reminderQuery.parse(req.query);
    res.status(201).json(await reminders.add(reminderFields.parse(req.body), shown));
  });
  router.patch("/reminders/:id", async (req, res) => {
    const { month: shown } = reminderQuery.parse(req.query);
    res.json(await reminders.update(reminderId.parse(req.params.id), reminderFields.partial().parse(req.body), shown));
  });
  router.delete("/reminders/:id", async (req, res) => {
    const { month: shown } = reminderQuery.parse(req.query);
    res.json(await reminders.remove(reminderId.parse(req.params.id), shown));
  });
  router.post("/reminders/:id/dismiss", async (req, res) => {
    const { month: shown } = reminderQuery.parse(req.query);
    const { occurrence, stage } = dismissal.parse(req.body);
    res.json(await reminders.dismiss(reminderId.parse(req.params.id), occurrence, stage, shown));
  });
  router.patch("/topics/:id", async (req, res) => {
    const { date, ...changes } = patchTopic.parse(req.body);
    res.json(await desk.changeTopic(topicId.parse(req.params.id), changes, date));
  });
  router.post("/topics", async (req, res) => {
    const { date, ...topic } = addTopic.parse(req.body);
    if (topic.excerpt && !topic.url) throw deskError(400, "Add the source link for this excerpt.");
    res.status(201).json(await desk.changeTopic(null, topic, date));
  });
  router.post("/topics/:id/clips/:clipId", async (req, res) => {
    const { date, ...review } = clipReview.parse(req.body);
    res.json(await desk.reviewClip(topicId.parse(req.params.id), clipId.parse(req.params.clipId), review, date));
  });
  router.post("/topics/:id/trend", async (req, res) => {
    const { date, aliases: list } = trendInput.parse(req.body || {});
    res.json(await desk.checkTrend(topicId.parse(req.params.id), { aliases: list }, date));
  });
  router.post("/trend/core", async (req, res) => {
    const { date, topicId: core } = coreInput.parse(req.body);
    res.json(await desk.lockCoreStory(core, date));
  });
  router.post("/claims/:id/correct", async (req, res) => {
    const { date, ...correction } = correctionInput.parse(req.body);
    res.json(await desk.correctClaim(claimId.parse(req.params.id), correction, date));
  });
  router.post("/claims/:id/resolve", async (req, res) => {
    const { date, ...resolution } = resolutionInput.parse(req.body);
    res.json(await desk.resolveClaim(claimId.parse(req.params.id), resolution, date));
  });
  router.post("/chat", async (req, res) => {
    const { date, message, topicId } = chatInput.parse(req.body);
    res.json(await desk.postChat(message, topicId, date, (edits) => chatEdits.parse(edits)));
  });
  const revisionNumber = z.coerce.number().int().nonnegative().safe();
  router.get("/video/:date/:revision", async (req, res) => {
    res.type("mp4").sendFile(await desk.videoPath(date.parse(req.params.date), revisionNumber.parse(req.params.revision)));
  });
  router.get("/video/:date/:revision/short/:segment", async (req, res) => {
    const segment = z.coerce.number().int().positive().max(MAX_EPISODE_STORIES).parse(req.params.segment);
    res.type("mp4").sendFile(await desk.videoPath(date.parse(req.params.date), revisionNumber.parse(req.params.revision), segment));
  });
  router.get("/thumbnail/:date/:revision/:target", async (req, res) => {
    const target = z.union([z.literal("episode"), z.coerce.number().int().min(1).max(MAX_EPISODE_STORIES)]).parse(req.params.target);
    res.type("jpeg").sendFile(await desk.thumbnailPath(date.parse(req.params.date), revisionNumber.parse(req.params.revision), target));
  });
  // Emergency fix: chat with the Claude Code CLI on this PC (see emergency.mjs).
  const emergency = desk.emergency || new EmergencyDesk({ directory: path.join(dataDir, "emergency"), root });
  const chatRef = z.string().regex(/^[a-z0-9-]{6,40}$/);
  router.get("/emergency", async (req, res) => {
    const id = req.query.id ? chatRef.parse(req.query.id) : undefined;
    res.json(emergency.view(id));
  });
  router.post("/emergency", async (req, res) => {
    const { message, id } = z.object({ message: z.string().trim().min(1).max(8000), id: chatRef.optional() }).parse(req.body || {});
    res.status(202).json(await emergency.send(message, id));
  });
  router.post("/emergency/stop", async (req, res) => {
    const { id } = z.object({ id: chatRef }).parse(req.body || {});
    res.json(await emergency.stop(id));
  });
  app.use("/api/sports", router);
}
