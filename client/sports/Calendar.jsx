import { useState } from "react";
import { BellRing, CalendarDays, ChevronLeft, ChevronRight, Clock3, LoaderCircle, Newspaper, Pencil, Plus, Repeat, Trash2, X } from "lucide-react";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
export const LEAD_OPTIONS = [
  { value: 0, label: "The day before and the day of" },
  { value: 3, label: "3 days before" },
  { value: 7, label: "A week before" },
  { value: 14, label: "Two weeks before" },
  { value: 30, label: "A month before" },
];
const REPEAT_LABELS = { none: "Doesn’t repeat", weekly: "Every week", monthly: "Every month", yearly: "Every year" };

const utc = (date) => new Date(`${date}T12:00:00Z`);
const format = (date, options) => new Intl.DateTimeFormat("en-US", { timeZone: "UTC", ...options }).format(utc(date));
export const shiftMonth = (month, by) => {
  const stamp = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1 + by, 1));
  return stamp.toISOString().slice(0, 7);
};
const addDays = (date, days) => new Date(utc(date).getTime() + days * 86_400_000).toISOString().slice(0, 10);

export function clockTime(time) {
  if (!time) return "";
  const [hours, minutes] = time.split(":").map(Number);
  return `${hours % 12 || 12}:${String(minutes).padStart(2, "0")} ${hours < 12 ? "AM" : "PM"}`;
}

// "Today at 3:00 PM", "Tomorrow", "In 5 days · Fri, Nov 27".
export function dueLabel({ stage, daysUntil, occurrence, time }) {
  const when = stage === "today" ? "Today" : stage === "tomorrow" ? "Tomorrow" : `In ${daysUntil} days · ${format(occurrence, { weekday: "short", month: "short", day: "numeric" })}`;
  return time ? `${when} at ${clockTime(time)}` : when;
}

// Six weeks starting on the Sunday on or before the first of the month.
function monthCells(month) {
  const first = `${month}-01`;
  const start = addDays(first, -utc(first).getUTCDay());
  return Array.from({ length: 42 }, (_, index) => addDays(start, index));
}

function ReminderForm({ reminder, kind: startKind, date, pending, onSave, onClose }) {
  const [fields, setFields] = useState({
    kind: reminder?.kind || startKind || "reminder", category: reminder?.category || "sports",
    title: reminder?.title || "", date: reminder?.date || date, time: reminder?.time || "",
    repeat: reminder?.repeat || "none", leadDays: reminder?.leadDays ?? 0, notes: reminder?.notes || "",
  });
  const field = (name) => ({ value: fields[name], onChange: (event) => setFields((current) => ({ ...current, [name]: event.target.value })) });
  const topic = fields.kind === "topic";
  const noun = topic ? "topic" : "reminder";
  return (
    <form className="od-topic-form od-reminder-form" onSubmit={async (event) => {
      event.preventDefault();
      const saved = await onSave(topic
        ? { kind: "topic", category: fields.category, title: fields.title, date: fields.date, repeat: fields.repeat, notes: fields.notes }
        : { kind: "reminder", title: fields.title, date: fields.date, repeat: fields.repeat, notes: fields.notes, leadDays: Number(fields.leadDays), time: fields.time || null });
      if (saved) onClose();
    }}>
      {!reminder && <div className="od-kind-switch" role="radiogroup" aria-label="What to schedule">
        {[["reminder", "Reminder", BellRing], ["topic", "Story topic", Newspaper]].map(([value, label, Icon]) => (
          <button key={value} type="button" role="radio" aria-checked={fields.kind === value} className={fields.kind === value ? "is-active" : ""}
            onClick={() => setFields((current) => ({ ...current, kind: value }))}><Icon size={14} /> {label}</button>
        ))}
      </div>}
      {topic && <p className="od-form-hint">Jot it down however you like. On this day it leads the rundown, and research finds the reporting to flesh it out.</p>}
      <label>{topic ? "Topic" : "What’s happening"}<input required maxLength={120} autoFocus
        placeholder={topic ? "Boozer vs. Lendeborg, who’s the real rookie of the year" : "Selection Sunday, Isaac out of town…"} {...field("title")} /></label>
      <div className="od-form-row">
        <label>{topic ? "Show day" : "Date"}<input type="date" required {...field("date")} /></label>
        {topic
          ? <label>Section<select {...field("category")}><option value="sports">Sports</option><option value="other">Other news</option></select></label>
          : <label>Time (optional)<input type="time" {...field("time")} /></label>}
      </div>
      <div className="od-form-row">
        <label>Repeats<select {...field("repeat")}>
          {Object.entries(REPEAT_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        {!topic && <label>Remind us<select {...field("leadDays")}>
          {LEAD_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select></label>}
      </div>
      <label>{topic ? "Angle or notes (optional)" : "Notes"}<textarea rows={3} maxLength={600}
        placeholder={topic ? "Rough is fine: what you want covered, who to mention, your hot take" : "Anything to remember for the show"} {...field("notes")} /></label>
      <div className="od-form-actions">
        <button type="button" className="od-button od-button-quiet" onClick={onClose}>Cancel</button>
        <button type="submit" className="od-button od-button-accent" disabled={pending}>
          {pending ? <LoaderCircle className="od-spin" size={14} /> : topic ? <Newspaper size={14} /> : <BellRing size={14} />} {reminder ? `Save ${noun}` : topic ? "Schedule topic" : "Add reminder"}
        </button>
      </div>
    </form>
  );
}

function ReminderItem({ reminder, date, pending, onEdit, onDelete }) {
  return (
    <li className={`od-reminder${reminder.kind === "topic" ? " is-topic" : ""}`}>
      <div>
        <strong>{reminder.kind === "topic" && <Newspaper size={13} className="od-topic-icon" aria-label="Story topic" />} {reminder.title}</strong>
        <span className="od-reminder-meta">
          {reminder.kind === "topic" && <span className="od-topic-badge">{reminder.category === "other" ? "Other news topic" : "Story topic"}</span>}
          {date && <>{format(date, { weekday: "short", month: "short", day: "numeric" })}</>}
          {reminder.time && <><Clock3 size={12} /> {clockTime(reminder.time)}</>}
          {reminder.repeat !== "none" && <><Repeat size={12} /> {REPEAT_LABELS[reminder.repeat]}</>}
        </span>
        {reminder.notes && <p>{reminder.notes}</p>}
      </div>
      {onEdit && <div className="od-reminder-actions">
        <button type="button" className="od-icon-button" aria-label={`Edit ${reminder.title}`} disabled={pending} onClick={onEdit}><Pencil size={14} /></button>
        <button type="button" className="od-icon-button" aria-label={`Delete ${reminder.title}`} disabled={pending} onClick={onDelete}><Trash2 size={14} /></button>
      </div>}
    </li>
  );
}

export function CalendarTab({ book, error, pending, onMonth, onSave, onDelete }) {
  const today = book?.today;
  const month = book?.month;
  const [selected, setSelected] = useState(null);
  const [editing, setEditing] = useState(null); // "new", "new-topic" or an entry id
  const day = selected || today;
  if (!book) {
    return <div className="od-panel od-empty">{error ? error : <><LoaderCircle className="od-spin" size={20} /> Loading the calendar…</>}</div>;
  }
  const byId = new Map(book.reminders.map((reminder) => [reminder.id, reminder]));
  const onDay = new Map();
  for (const { id, date } of book.occurrences) onDay.set(date, [...(onDay.get(date) || []), byId.get(id)].filter(Boolean));
  const dayReminders = onDay.get(day) || [];
  const creating = editing === "new" || editing === "new-topic";
  const editingReminder = editing && !creating ? byId.get(editing) : null;
  const pick = (date) => {
    setSelected(date);
    setEditing(null);
    if (date.slice(0, 7) !== month) onMonth(date.slice(0, 7));
  };
  const remove = async (reminder) => {
    if (!window.confirm(`Delete ${reminder.kind === "topic" ? "the topic " : ""}“${reminder.title}”${reminder.repeat !== "none" ? " and all its repeats" : ""}?`)) return;
    await onDelete(reminder.id);
    setEditing(null);
  };

  return (
    <section className="od-calendar" aria-labelledby="od-calendar-title">
      <header className="od-section-heading">
        <div>
          <h2 id="od-calendar-title">Calendar</h2>
          <p>Reminders notify you the day before and the day of. Story topics lead the rundown on their show day.</p>
        </div>
        <div className="od-section-actions">
          <button type="button" className="od-button" disabled={pending} onClick={() => { setSelected(day); setEditing("new-topic"); }}>
            <Newspaper size={15} /> Schedule topic
          </button>
          <button type="button" className="od-button od-button-accent" disabled={pending} onClick={() => { setSelected(day); setEditing("new"); }}>
            <Plus size={16} /> Add reminder
          </button>
        </div>
      </header>
      {error && <div className="od-notice is-error" role="alert"><span>{error}</span></div>}
      <div className="od-calendar-grid">
        <div className="od-panel od-month">
          <div className="od-month-bar">
            <button type="button" className="od-icon-button" aria-label="Previous month" onClick={() => onMonth(shiftMonth(month, -1))}><ChevronLeft size={18} /></button>
            <h3>{format(`${month}-01`, { month: "long", year: "numeric" })}</h3>
            <button type="button" className="od-icon-button" aria-label="Next month" onClick={() => onMonth(shiftMonth(month, 1))}><ChevronRight size={18} /></button>
            <button type="button" className="od-button od-button-quiet" disabled={month === today.slice(0, 7) && day === today} onClick={() => pick(today)}>Today</button>
          </div>
          <div className="od-month-days" role="grid" aria-label={format(`${month}-01`, { month: "long", year: "numeric" })}>
            {WEEKDAYS.map((name) => <div key={name} className="od-weekday" role="columnheader">{name}</div>)}
            {monthCells(month).map((date) => {
              const items = onDay.get(date) || [];
              const classes = ["od-day", date.slice(0, 7) !== month && "is-outside", date === today && "is-today", date === day && "is-selected", date < today && "is-past"].filter(Boolean).join(" ");
              return (
                <button key={date} type="button" role="gridcell" className={classes} aria-selected={date === day}
                  aria-label={`${format(date, { weekday: "long", month: "long", day: "numeric" })}${items.length ? `, ${items.length} reminder${items.length > 1 ? "s" : ""}` : ""}`}
                  onClick={() => pick(date)} onDoubleClick={() => { pick(date); setEditing("new"); }}>
                  <span className="od-day-number">{Number(date.slice(8))}</span>
                  {items.slice(0, 2).map((item) => <span key={item.id} className={`od-day-chip${item.kind === "topic" ? " is-topic" : ""}`}>{item.time ? `${clockTime(item.time)} ` : ""}{item.title}</span>)}
                  {items.length > 2 && <span className="od-day-more">+{items.length - 2} more</span>}
                  {items.length > 0 && <span className="od-day-dot" aria-hidden="true" />}
                </button>
              );
            })}
          </div>
        </div>
        <aside className="od-panel od-day-panel">
          <div className="od-day-panel-head">
            <h3>{format(day, { weekday: "long", month: "long", day: "numeric" })}</h3>
            {editing ? <button type="button" className="od-icon-button" aria-label="Close the form" onClick={() => setEditing(null)}><X size={16} /></button>
              : <button type="button" className="od-button" disabled={pending} onClick={() => setEditing("new")}><Plus size={14} /> Add</button>}
          </div>
          {editing && <ReminderForm key={`${editing}-${day}`} reminder={editingReminder} kind={editing === "new-topic" ? "topic" : "reminder"} date={day} pending={pending}
            onSave={(fields) => onSave(editingReminder?.id, fields)} onClose={() => setEditing(null)} />}
          {!editing && (dayReminders.length
            ? <ul className="od-reminder-list">{dayReminders.map((reminder) => <ReminderItem key={reminder.id} reminder={reminder} pending={pending}
              onEdit={() => setEditing(reminder.id)} onDelete={() => remove(reminder)} />)}</ul>
            : <p className="od-form-hint">Nothing on this day yet. Choose Add for a reminder or a story topic.</p>)}
          <h4 className="od-upcoming-title"><CalendarDays size={14} /> Coming up</h4>
          {book.upcoming.length
            ? <ul className="od-reminder-list">{book.upcoming.map(({ id, date }) => byId.get(id) && <ReminderItem key={id} reminder={byId.get(id)} date={date} />)}</ul>
            : <p className="od-form-hint">No reminders scheduled.</p>}
        </aside>
      </div>
    </section>
  );
}
