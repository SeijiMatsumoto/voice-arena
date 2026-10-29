/**
 * Checkable claims in a sentence: money, percentages, clock times, dates and counted quantities.
 * Each claim normalizes to a key so "$15", "15 dollars" and "fifteen dollars" compare equal.
 */

export type ClaimKind = "money" | "percent" | "time" | "date" | "quantity";

export interface Claim {
  kind: ClaimKind;
  key: string;
  text: string;
}

const SMALL: Record<string, number> = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};
const MONTHS = [
  "january", "february", "march", "april", "may", "june",
  "july", "august", "september", "october", "november", "december",
];
const UNITS: Record<string, string> = {
  day: "day", days: "day", week: "week", weeks: "week", month: "month", months: "month",
  year: "year", years: "year", hour: "hour", hours: "hour", minute: "minute", minutes: "minute",
  session: "session", sessions: "session", visit: "visit", visits: "visit",
  class: "class", classes: "class", time: "time", times: "time", mbps: "mbps", gb: "gb",
};

const NUMBER_WORD = `(?:${[...Object.keys(SMALL), ...Object.keys(TENS), "hundred", "thousand"].join("|")})`;
const NUMBER_PHRASE = new RegExp(`\\b${NUMBER_WORD}(?:[\\s-]+(?:and\\s+)?${NUMBER_WORD})*\\b`, "gi");

function phraseToNumber(phrase: string): number | null {
  let total = 0;
  let current = 0;
  for (const word of phrase.toLowerCase().split(/[\s-]+/)) {
    if (word === "and") continue;
    if (word in SMALL) current += SMALL[word]!;
    else if (word in TENS) current += TENS[word]!;
    else if (word === "hundred") current = (current || 1) * 100;
    else if (word === "thousand") {
      total += (current || 1) * 1000;
      current = 0;
    } else return null;
  }
  return total + current;
}

/** Curly quotes and apostrophes as straight ones, so "I’ve" matches the same patterns as "I've". */
export function straightenQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"');
}

/** Spelled-out numbers become digits, so a voice-styled sentence compares with a written source. */
export function normalizeNumbers(text: string): string {
  // "the one you booked" becomes "the 1 you booked"; harmless, since only number + unit forms are claims.
  return text.replace(NUMBER_PHRASE, (phrase) => {
    const n = phraseToNumber(phrase);
    return n === null ? phrase : String(n);
  });
}

const MONEY = /\$\s?(\d[\d,]*(?:\.\d{1,2})?)|\b(\d[\d,]*(?:\.\d{1,2})?)\s*(?:dollars?|usd)\b/gi;
const PERCENT = /\b(\d+(?:\.\d+)?)\s*(?:%|percent\b)/gi;
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?=\W|$)|\b(noon|midnight)\b/gi;
const DATE_MD = new RegExp(`\\b(${MONTHS.join("|")})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
const DATE_DM = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${MONTHS.join("|")})\\b`, "gi");
const MONTH_BEFORE = new RegExp(`\\b(?:${MONTHS.join("|")})\\s+$`, "i");
const DATE_NUM = /\b(\d{1,2})\/(\d{1,2})(?:\/\d{2,4})?\b/g;
const QUANTITY = new RegExp(`\\b(\\d+(?:\\.\\d+)?)[\\s-]*(${Object.keys(UNITS).join("|")})\\b`, "gi");

function cents(raw: string): string {
  return String(Math.round(Number(raw.replace(/,/g, "")) * 100));
}

export function extractClaims(sentence: string): Claim[] {
  const text = normalizeNumbers(sentence);
  const claims: Claim[] = [];
  for (const m of text.matchAll(MONEY)) {
    claims.push({ kind: "money", key: `money:${cents(m[1] ?? m[2]!)}`, text: m[0] });
  }
  for (const m of text.matchAll(PERCENT)) {
    claims.push({ kind: "percent", key: `percent:${Number(m[1])}`, text: m[0] });
  }
  for (const m of text.matchAll(TIME)) {
    if (m[4]) {
      claims.push({ kind: "time", key: `time:${m[4].toLowerCase() === "noon" ? 720 : 0}`, text: m[0] });
      continue;
    }
    let hour = Number(m[1]) % 12;
    if (m[3]!.toLowerCase().startsWith("p")) hour += 12;
    claims.push({ kind: "time", key: `time:${hour * 60 + Number(m[2] ?? 0)}`, text: m[0] });
  }
  for (const m of text.matchAll(DATE_MD)) {
    claims.push({ kind: "date", key: `date:${MONTHS.indexOf(m[1]!.toLowerCase()) + 1}-${Number(m[2])}`, text: m[0] });
  }
  for (const m of text.matchAll(DATE_DM)) {
    claims.push({ kind: "date", key: `date:${MONTHS.indexOf(m[2]!.toLowerCase()) + 1}-${Number(m[1])}`, text: m[0] });
  }
  for (const m of text.matchAll(DATE_NUM)) {
    claims.push({ kind: "date", key: `date:${Number(m[1])}-${Number(m[2])}`, text: m[0] });
  }
  for (const m of text.matchAll(QUANTITY)) {
    // "1 time" is how people say "once", not a checkable quantity.
    if (UNITS[m[2]!.toLowerCase()] === "time" && Number(m[1]) <= 1) continue;
    // "your September 18 visit": the 18 is the date's day, already a date claim.
    if (MONTH_BEFORE.test(text.slice(0, m.index))) continue;
    claims.push({ kind: "quantity", key: `quantity:${Number(m[1])}:${UNITS[m[2]!.toLowerCase()]}`, text: m[0] });
  }
  return claims;
}

/** Every claim key that appears anywhere in the source text. */
export function claimKeys(sourceText: string): Set<string> {
  const keys = new Set<string>();
  // Sources are long; extract line by line so a match never spans unrelated lines.
  for (const line of sourceText.split(/\n+/)) {
    for (const claim of extractClaims(line)) keys.add(claim.key);
  }
  return keys;
}

const ACTION_CLAIM =
  /\b(?:i(?:'ve| have)|we(?:'ve| have)|i just|that(?:'s| has been| is)|it(?:'s| has been)|you(?:'re| are) (?:all )?(?:set|booked|scheduled))\b.{0,40}\b(?:logged|scheduled|booked|cancel(?:l)?ed|applied|waived|processed|refunded|updated|changed|noted|sent|set up|arranged|confirmed)\b/i;

/** "I've waived the fee" style claims: true only if the action really happened on this call. */
export function claimsAction(sentence: string): boolean {
  return ACTION_CLAIM.test(straightenQuotes(sentence));
}
