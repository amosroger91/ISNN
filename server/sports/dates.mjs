const writtenFormat = new Intl.DateTimeFormat("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
const monthFormat = new Intl.DateTimeFormat("en-US", { month: "long", timeZone: "UTC" });
const ordinals = [
  "", "first", "second", "third", "fourth", "fifth", "sixth", "seventh", "eighth", "ninth", "tenth",
  "eleventh", "twelfth", "thirteenth", "fourteenth", "fifteenth", "sixteenth", "seventeenth", "eighteenth", "nineteenth", "twentieth",
  "twenty-first", "twenty-second", "twenty-third", "twenty-fourth", "twenty-fifth", "twenty-sixth", "twenty-seventh", "twenty-eighth", "twenty-ninth", "thirtieth",
  "thirty-first",
];

function editionStamp(iso) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso || "")) return null;
  const date = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function spokenYear(year) {
  const small = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const underHundred = (value) => {
    if (value < 20) return small[value];
    const ten = Math.floor(value / 10);
    const one = value % 10;
    return one ? `${tens[ten]}-${small[one]}` : tens[ten];
  };
  if (year >= 2000 && year <= 2009) return year === 2000 ? "two thousand" : `two thousand ${small[year - 2000]}`;
  if (year >= 2010 && year <= 2099) return `twenty ${underHundred(year - 2000)}`;
  return String(year);
}

// Numerals on the card: "November 16, 2026".
export function writtenDate(iso) {
  const date = editionStamp(iso);
  return date ? writtenFormat.format(date) : "";
}

// Spoken English: "November sixteenth, twenty twenty-six".
export function spokenDate(iso) {
  const date = editionStamp(iso);
  if (!date) return "";
  return `${monthFormat.format(date)} ${ordinals[date.getUTCDate()]}, ${spokenYear(date.getUTCFullYear())}`;
}

// "college football, the NBA, and Major League Baseball".
function spokenList(items) {
  if (items.length < 3) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

// The announcer's opening: the date, then the sports on today's show, then Isaac.
export function openingIntro(iso, sports = []) {
  const when = spokenDate(iso);
  const lineup = sports.length ? ` On today’s show: ${spokenList(sports)}.` : "";
  return `How’s it going, everyone? Thanks for tuning in to Wellspring Media Sports.${when ? ` It’s ${when}.` : ""}${lineup} Here’s your host, Isaac Doss.`;
}
