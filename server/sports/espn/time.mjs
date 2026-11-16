// Edition window in the desk time zone. The morning show on date D recaps games
// that started after 6:00 a.m. local on D-1 and before 8:00 a.m. local on D.
// Same conversion as desk.zonedTime, with a minute so 6:00 is exact.

export function zonedInstant(date, hour, minute, timezone) {
  const guess = Date.parse(`${date}T${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:00Z`);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(new Date(guess)).map(({ type, value }) => [type, value]));
  const seen = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute));
  return new Date(guess - (seen - guess)).toISOString();
}

export function shiftDate(date, days) {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

export function editionWindow(date, timezone = "America/Chicago") {
  return {
    start: zonedInstant(shiftDate(date, -1), 6, 0, timezone),
    end: zonedInstant(date, 8, 0, timezone),
  };
}

export function inEditionWindow(startTime, date, timezone = "America/Chicago") {
  const time = Date.parse(startTime);
  const { start, end } = editionWindow(date, timezone);
  return time >= Date.parse(start) && time < Date.parse(end);
}

export function calendarDate(iso, timezone = "America/Chicago") {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date(iso)).map(({ type, value }) => [type, value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function calendarLabel(iso, timezone = "America/Chicago") {
  return new Intl.DateTimeFormat("en-US", { timeZone: timezone, month: "long", day: "numeric" }).format(new Date(iso));
}
