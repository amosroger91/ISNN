import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import request from "supertest";
import { createApp } from "../server/app.mjs";
import { dueReminders, localDate, nextOccurrence, occurrencesBetween } from "../server/sports/reminders.mjs";

test("repeating reminders find their next date, clamping short months", () => {
  assert.equal(nextOccurrence({ date: "2026-11-25", repeat: "none" }, "2026-11-20"), "2026-11-25");
  assert.equal(nextOccurrence({ date: "2026-11-10", repeat: "none" }, "2026-11-20"), null);
  assert.equal(nextOccurrence({ date: "2026-11-02", repeat: "weekly" }, "2026-11-20"), "2026-11-23");
  assert.equal(nextOccurrence({ date: "2026-11-20", repeat: "weekly" }, "2026-11-20"), "2026-11-20");
  assert.equal(nextOccurrence({ date: "2026-01-31", repeat: "monthly" }, "2027-02-01"), "2027-02-28");
  assert.equal(nextOccurrence({ date: "2024-02-29", repeat: "yearly" }, "2026-11-20"), "2027-02-28");
  assert.equal(nextOccurrence({ date: "2020-03-15", repeat: "yearly" }, "2026-11-20"), "2027-03-15");
  assert.deepEqual(occurrencesBetween({ date: "2026-11-02", repeat: "weekly" }, "2026-11-01", "2026-11-30"),
    ["2026-11-02", "2026-11-09", "2026-11-16", "2026-11-23", "2026-11-30"]);
  assert.equal(localDate(new Date("2026-11-21T03:00:00Z"), "America/Chicago"), "2026-11-20");
});

test("notices show the day before and the day of, earlier with a heads-up, and stay dismissed per stage", () => {
  const today = "2026-11-20";
  const book = [
    { id: "a", title: "Today", date: "2026-11-20", repeat: "none", leadDays: 0, dismissed: [] },
    { id: "b", title: "Tomorrow", date: "2026-11-21", repeat: "none", leadDays: 0, dismissed: [] },
    { id: "c", title: "Too far", date: "2026-11-25", repeat: "none", leadDays: 0, dismissed: [] },
    { id: "d", title: "Heads-up", date: "2026-11-25", repeat: "none", leadDays: 7, dismissed: [] },
    { id: "e", title: "Dismissed", date: "2026-11-21", repeat: "none", leadDays: 0, dismissed: ["2026-11-21:tomorrow"] },
  ];
  assert.deepEqual(dueReminders(book, today).map(({ id, stage }) => `${id}:${stage}`), ["a:today", "b:tomorrow", "d:soon"]);
  // A notice dismissed the day before comes back on the day.
  assert.deepEqual(dueReminders(book, "2026-11-21").map(({ id, stage }) => `${id}:${stage}`).sort(), ["b:today", "d:soon", "e:today"]);
});

test("the calendar API adds, edits, dismisses and deletes reminders", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "isnn-reminders-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const time = new Date("2026-11-20T15:00:00Z");
  const desk = { directory, settings: { timezone: "America/Chicago" }, now: () => time };
  const { app } = await createApp({ sports: desk });
  const signIn = (req) => process.env.SPORTS_DESK_PASSWORD ? req.auth(process.env.SPORTS_DESK_USER || "isaac", process.env.SPORTS_DESK_PASSWORD) : req;
  const call = (method, url, body) => {
    const req = signIn(request(app)[method](`/api/sports${url}`));
    return body ? req.send(body) : req;
  };

  const empty = await call("get", "/reminders").expect(200);
  assert.equal(empty.body.today, "2026-11-20");
  assert.deepEqual(empty.body.due, []);

  await call("post", "/reminders", { title: "", date: "2026-11-21" }).expect(400);
  const added = await call("post", "/reminders?month=2026-11", { title: "Selection show", date: "2026-11-21", time: "18:30", repeat: "none", leadDays: 0 }).expect(201);
  const [reminder] = added.body.reminders;
  assert.equal(reminder.title, "Selection show");
  assert.deepEqual(added.body.occurrences, [{ id: reminder.id, date: "2026-11-21" }]);
  assert.deepEqual(added.body.due.map(({ stage, time: at }) => `${stage} ${at}`), ["tomorrow 18:30"]);

  const dismissed = await call("post", `/reminders/${reminder.id}/dismiss`, { occurrence: "2026-11-21", stage: "tomorrow" }).expect(200);
  assert.deepEqual(dismissed.body.due, []);

  // Moving the date clears old dismissals.
  const moved = await call("patch", `/reminders/${reminder.id}`, { date: "2026-11-20", notes: "Bring the bracket" }).expect(200);
  assert.deepEqual(moved.body.due.map(({ stage, notes }) => `${stage}: ${notes}`), ["today: Bring the bracket"]);

  const later = await call("get", "/reminders?month=2026-12").expect(200);
  assert.deepEqual(later.body.occurrences, []);
  assert.equal(later.body.due.length, 1, "notices do not depend on the month being viewed");

  // A story topic keeps its section, drops reminder-only fields and stays off the notices.
  const scheduled = await call("post", "/reminders", { kind: "topic", category: "other", title: "gta trailer??", date: "2026-11-20", time: "09:00", leadDays: 7 }).expect(201);
  const topicEntry = scheduled.body.reminders.find(({ kind }) => kind === "topic");
  assert.deepEqual({ category: topicEntry.category, time: topicEntry.time, leadDays: topicEntry.leadDays }, { category: "other", time: null, leadDays: 0 });
  assert.equal(scheduled.body.due.length, 1);
  await call("post", "/reminders", { kind: "chore", title: "x", date: "2026-11-20" }).expect(400);
  await call("delete", `/reminders/${topicEntry.id}`).expect(200);

  const removed = await call("delete", `/reminders/${reminder.id}`).expect(200);
  assert.deepEqual(removed.body.reminders, []);
  await call("delete", `/reminders/${reminder.id}`).expect(404);
});
