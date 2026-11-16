import { timingSafeEqual } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { deskError } from "./desk.mjs";

const date = z.iso.date();
const requestDate = z.object({ date: date.optional() });
const topicId = z.string().regex(/^[\w-]{1,60}$/);
const claimId = z.string().regex(/^clm_[a-f0-9]{20}$/);
const title = z.string().trim().min(3).max(160);
const summary = z.string().trim().max(1200);
const take = z.string().trim().max(1800);
const url = z.url({ protocol: /^https?$/ }).max(1200).refine((value) => {
  const parsed = URL.parse(value);
  return parsed && !parsed.username && !parsed.password;
}, "Use an HTTP or HTTPS source link without credentials.");
const aliases = z.array(z.string().trim().min(2).max(80)).max(12);
const topicFields = z.object({ title, summary, take, selected: z.boolean() });
const patchTopic = requestDate.extend(topicFields.partial().shape).extend({
  headline: z.string().trim().min(3).max(140).optional(), narration: z.string().trim().min(20).max(750).optional(),
  storyId: z.string().trim().min(3).max(120).nullable().optional(), aliases: aliases.optional(),
});
const addTopic = requestDate.extend({ title, summary: summary.optional(), take: take.optional(), url: url.optional(), excerpt: z.string().trim().max(1000).optional() });
const chatInput = requestDate.extend({ message: z.string().trim().min(1).max(2400), topicId: topicId.optional() });
const chatEdits = z.array(topicFields.partial().extend({ id: topicId.optional(), url: url.optional() })).max(12).refine(
  (edits) => edits.every((edit) => edit.id || edit.title), "A new topic needs a title.",
);
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
  res.set("WWW-Authenticate", 'Basic realm="Overtime Desk", charset="UTF-8"');
  return res.status(401).json({ error: "Sign in to the sports desk." });
}

export function mountSports(app, desk) {
  app.get(/^\/sports\/?$/i, deskAccess, (req, res, next) => {
    if (req.path !== "/sports") return res.redirect(308, "/sports");
    next();
  });

  const router = Router();
  router.post("/cron", async (req, res) => {
    if (!directLoopback(req) || req.get("origin") || req.get("sec-fetch-site")) throw deskError(403, "Run the sports cron from the app host.");
    await desk.tick();
    res.sendStatus(204);
  });
  router.use(deskAccess);
  router.get("/edition", async (_req, res) => res.json(await desk.view()));
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
  router.post("/evidence/scan", async (req, res) => {
    const { date, asOf } = scanInput.parse(req.body || {});
    res.json(await desk.scanSlate(date, { asOf }));
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
    const segment = z.coerce.number().int().positive().max(12).parse(req.params.segment);
    res.type("mp4").sendFile(await desk.videoPath(date.parse(req.params.date), revisionNumber.parse(req.params.revision), segment));
  });
  app.use("/api/sports", router);
}
