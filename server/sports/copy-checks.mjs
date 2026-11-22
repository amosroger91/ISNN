// A model audit is still required for meaning. This catches invented proper names
// even when the model incorrectly approves its own rewrite.
const introductory = new Set("a an the our next now then and but for from with to in on at by of as this that today morning tonight college sports basketball baseball football hockey soccer isaac take lead story meanwhile finally while although though despite however after before both each some several most many few even also still".split(" "));
// Sentence-opening roles describe a person; they are not part of the name.
const roles = new Set("coach coaches head assistant interim former manager managers player players quarterback quarterbacks guard guards forward forwards center centers pitcher pitchers rookie rookies veteran veterans star stars captain captains president senior junior freshman sophomore".split(" "));
const words = (text) => String(text || "").normalize("NFKD").replace(/\p{M}/gu, "").replace(/['’]s\b/giu, "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];

export function verifySupportedNames(text, sources) {
  const evidence = ` ${words(sources.map(({ title, excerpt }) => `${title || ""} ${excerpt || ""}`).join(" ")).join(" ")} `;
  const names = String(text).match(/\b\p{Lu}[\p{L}'’-]+(?:\s+\p{Lu}[\p{L}'’-]+){1,4}/gu) || [];
  for (const name of names) {
    // "Texas Tech's Thomas Castellanos" contains two existing names. A
    // possessive connects them; it does not create one new four-word name.
    for (const part of name.split(/['’]s(?:\s|$)/giu)) {
      const tokens = words(part);
      while (introductory.has(tokens[0]) || roles.has(tokens[0])) tokens.shift();
      while (introductory.has(tokens.at(-1))) tokens.pop();
      if (tokens.length >= 2 && !evidence.includes(` ${tokens.join(" ")} `)) {
        throw new Error(`Sports copy needs editorial review. The name “${part}” is absent from this story's evidence.`);
      }
    }
  }
}

export function verifySeasonTiming(text, sources) {
  const evidence = sources.map(({ title, excerpt }) => `${title || ""} ${excerpt || ""}`).join(" ");
  if (!/\b(?:amid(?:st)?|during) [^.!?]{0,60}\bseason\b|\bjust dropped to\b/iu.test(evidence)) return;
  const records = new Set(sources.flatMap(({ title, excerpt }) => `${title || ""} ${(excerpt || "").slice(0, 200)}`.match(/\b\d{1,2}[–-]\d{1,2}\b/gu) || []).map((record) => record.replace("–", "-")));
  for (const [, record] of String(text).matchAll(/\b(?:after|following) an? (\d{1,2}[–-]\d{1,2}) season\b/giu)) {
    if (records.has(record.replace("–", "-"))) throw new Error("Sports copy needs editorial review. An ongoing season's current record was described as a completed season.");
  }
}
