import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

// The desk calendar: dated reminders Isaac and the team add ahead of time.
// A reminder may repeat. Each occurrence raises a notice from its heads-up day
// (at least the day before) through the day itself; a dismissed notice stays
// dismissed for that occurrence and stage only, so "tomorrow" and "today" each
// get their own notice. Dates are judged in the desk's time zone.

// A "topic" entry is a story idea scheduled for a show day: on that day's
// research it joins the rundown at the top and the build finds its reporting.
export const REPEATS = ["none", "weekly", "monthly", "yearly"];
export const KINDS = ["reminder", "topic"];
export const CATEGORIES = ["sports", "other"];
const MAX_REMINDERS = 500;
const DAY = 86_400_000;

const parseDay = (date) => Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
const formatDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const addDays = (date, days) => formatDay(parseDay(date) + days * DAY);
export const daysBetween = (from, to) => Math.round((parseDay(to) - parseDay(from)) / DAY);
const lastDayOfMonth = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

// The calendar date in a time zone, as YYYY-MM-DD.
export function localDate(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

// The occurrence on or after `from`, or null when a one-time date has passed.
export function nextOccurrence(reminder, from) {
  const { date, repeat = "none" } = reminder;
  if (date >= from || repeat === "none") return date >= from ? date : null;
  if (repeat === "weekly") {
    const weeks = Math.ceil(daysBetween(date, from) / 7);
    return addDays(date, weeks * 7);
  }
  const day = Number(date.slice(8, 10));
  const month = Number(date.slice(5, 7)) - 1;
  let year = Number(from.slice(0, 4));
  let candidateMonth = repeat === "monthly" ? Number(from.slice(5, 7)) - 1 : month;
  for (let step = 0; step < 3; step += 1) {
    const clamped = Math.min(day, lastDayOfMonth(year, candidateMonth));
    const candidate = formatDay(Date.UTC(year, candidateMonth, clamped));
    if (candidate >= from) return candidate;
    if (repeat === "monthly") {
      candidateMonth += 1;
      if (candidateMonth > 11) { candidateMonth = 0; year += 1; }
    } else year += 1;
  }
  return null;
}

// Every occurrence in [from, to], inclusive.
export function occurrencesBetween(reminder, from, to) {
  const dates = [];
  let cursor = from;
  while (cursor <= to && dates.length < 40) {
    const next = nextOccurrence(reminder, cursor);
    if (!next || next > to) break;
    dates.push(next);
    if ((reminder.repeat || "none") === "none") break;
    cursor = addDays(next, 1);
  }
  return dates;
}

const stageFor = (daysUntil) => (daysUntil === 0 ? "today" : daysUntil === 1 ? "tomorrow" : "soon");

// The notices showing now: occurrences from today through each heads-up window.
export function dueReminders(reminders, today) {
  const due = [];
  for (const reminder of reminders) {
    // Scheduled topics surface in that day's rundown, not as notices.
    if (reminder.kind === "topic") continue;
    const occurrence = nextOccurrence(reminder, today);
    if (!occurrence) continue;
    const daysUntil = daysBetween(today, occurrence);
    if (daysUntil > Math.max(1, reminder.leadDays || 0)) continue;
    const stage = stageFor(daysUntil);
    if (reminder.dismissed?.includes(`${occurrence}:${stage}`)) continue;
    due.push({ id: reminder.id, title: reminder.title, notes: reminder.notes, time: reminder.time, occurrence, daysUntil, stage });
  }
  return due.sort((a, b) => a.daysUntil - b.daysUntil || (a.time || "").localeCompare(b.time || "") || a.title.localeCompare(b.title));
}

// The story topics scheduled for one show day, in the order they were added.
export function scheduledTopics(reminders, date) {
  return reminders.filter((entry) => entry.kind === "topic" && nextOccurrence(entry, date) === date);
}

const notFound = () => Object.assign(new Error("Reminder not found."), { status: 404 });

export class ReminderBook {
  constructor({ file, timezone = "America/Chicago", now = () => new Date() }) {
    this.file = file;
    this.timezone = timezone;
    this.now = now;
    this.queue = Promise.resolve();
  }

  today() {
    return localDate(this.now(), this.timezone);
  }

  async read() {
    try {
      const parsed = JSON.parse(await readFile(this.file, "utf8"));
      return Array.isArray(parsed.reminders) ? parsed.reminders : [];
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
  }

  async write(reminders) {
    await mkdir(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ reminders }, null, 2)}\n`);
    await rename(temporary, this.file);
  }

  // One change at a time, so two quick saves never overwrite each other.
  change(edit) {
    const run = this.queue.then(async () => {
      const reminders = await this.read();
      const next = await edit(reminders);
      await this.write(next);
      return next;
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // The book as the calendar shows it: every reminder, the notices due now,
  // and each occurrence in the month being viewed (YYYY-MM).
  async view(month) {
    const today = this.today();
    const reminders = (await this.read()).sort((a, b) => a.date.localeCompare(b.date) || (a.time || "").localeCompare(b.time || ""));
    const shown = month || today.slice(0, 7);
    const from = `${shown}-01`;
    const to = addDays(formatDay(Date.UTC(Number(shown.slice(0, 4)), Number(shown.slice(5, 7)), 1)), -1);
    const occurrences = reminders.flatMap((reminder) => occurrencesBetween(reminder, from, to).map((date) => ({ id: reminder.id, date })));
    const upcoming = reminders
      .map((reminder) => ({ id: reminder.id, date: nextOccurrence(reminder, today) }))
      .filter(({ date }) => date)
      .sort((a, b) => a.date.localeCompare(b.date))
      .slice(0, 8);
    return { today, timezone: this.timezone, month: shown, reminders, occurrences, upcoming, due: dueReminders(reminders, today) };
  }

  async topicsFor(date) {
    return scheduledTopics(await this.read(), date);
  }

  async add(fields, month) {
    await this.change((reminders) => {
      if (reminders.length >= MAX_REMINDERS) throw Object.assign(new Error(`The calendar holds ${MAX_REMINDERS} reminders. Delete old ones first.`), { status: 409 });
      return [...reminders, { id: randomUUID(), ...clean(fields), dismissed: [], createdAt: this.now().toISOString() }];
    });
    return this.view(month);
  }

  async update(id, fields, month) {
    await this.change((reminders) => {
      const reminder = reminders.find((entry) => entry.id === id);
      if (!reminder) throw notFound();
      const moved = (fields.date && fields.date !== reminder.date) || (fields.repeat && fields.repeat !== reminder.repeat);
      Object.assign(reminder, clean({ ...reminder, ...fields }), moved ? { dismissed: [] } : {});
      return reminders;
    });
    return this.view(month);
  }

  async remove(id, month) {
    await this.change((reminders) => {
      if (!reminders.some((entry) => entry.id === id)) throw notFound();
      return reminders.filter((entry) => entry.id !== id);
    });
    return this.view(month);
  }

  async dismiss(id, occurrence, stage, month) {
    const today = this.today();
    await this.change((reminders) => {
      const reminder = reminders.find((entry) => entry.id === id);
      if (!reminder) throw notFound();
      // Keep the list short: dismissals for past occurrences no longer matter.
      const kept = (reminder.dismissed || []).filter((key) => key.slice(0, 10) >= today);
      reminder.dismissed = [...new Set([...kept, `${occurrence}:${stage}`])];
      return reminders;
    });
    return this.view(month);
  }
}

function clean({ kind = "reminder", category = "sports", title, date, time = null, notes = "", repeat = "none", leadDays = 0 }) {
  const topic = kind === "topic";
  return { kind, ...(topic && { category }), title, date, time: topic ? null : time || null, notes: notes || "", repeat, leadDays: topic ? 0 : leadDays };
}
