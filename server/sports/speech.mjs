// Text for Isaac's voice only. The voice model reads "1,580" digit by digit and
// stumbles on the comma ("fif- fif- fiftee… hatey yards"), so numbers it would
// trip on are written out as words first. Captions and graphics keep the digits.
const ones = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const scales = [[1e9, "billion"], [1e6, "million"], [1e3, "thousand"]];

function underHundred(n) {
  if (n < 20) return ones[n];
  return n % 10 ? `${tens[Math.floor(n / 10)]}-${ones[n % 10]}` : tens[Math.floor(n / 10)];
}

function underThousand(n) {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return underHundred(rest);
  return rest ? `${ones[hundreds]} hundred ${underHundred(rest)}` : `${ones[hundreds]} hundred`;
}

export function numberWords(n) {
  if (!Number.isSafeInteger(n) || n < 0) return String(n);
  if (n === 0) return "zero";
  // 1,580 is said the way a broadcaster says it: "fifteen hundred eighty".
  if (n >= 1100 && n < 10000 && Math.floor(n / 100) % 10) {
    const rest = n % 100;
    return `${underHundred(Math.floor(n / 100))} hundred${rest ? ` ${underHundred(rest)}` : ""}`;
  }
  const words = [];
  let rest = n;
  for (const [size, name] of scales) {
    if (rest >= size) {
      words.push(`${underThousand(Math.floor(rest / size))} ${name}`);
      rest %= size;
    }
  }
  if (rest) words.push(underThousand(rest));
  return words.join(" ");
}

const decimal = (digits) => [...digits].map((digit) => ones[Number(digit)]).join(" ");

export function speakableText(text) {
  return String(text ?? "")
    // Money: $1,500,000 · $45 million · $2.5 billion become words then "dollars".
    // Before a noun it is "a forty-five million dollar contract".
    .replace(/\$(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?(\s+(?:million|billion|thousand))?(?=(\s+[a-z])?)/gu, (_, whole, fraction, scale, noun) =>
      `${numberWords(Number(whole.replaceAll(",", "")))}${fraction ? ` point ${decimal(fraction)}` : ""}${scale || ""} ${noun ? "dollar" : "dollars"}`)
    // Grouped thousands, with an optional decimal: 1,580 · 12,400 · 1,234.5
    .replace(/(?<![\d.,])(\d{1,3}(?:,\d{3})+)(?:\.(\d+))?(?![\d,]*\d)/gu, (_, whole, fraction) =>
      `${numberWords(Number(whole.replaceAll(",", "")))}${fraction ? ` point ${decimal(fraction)}` : ""}`)
    // Ungrouped numbers of four or more digits that are not years: 1580 yards, 25000 fans.
    .replace(/(?<![\d.,$])(\d{4,9})(?![\d.,]*\d)/gu, (match, digits) => {
      const n = Number(digits);
      if (digits.length === 4 && n >= 1900 && n <= 2099) return match;
      return numberWords(n);
    });
}
