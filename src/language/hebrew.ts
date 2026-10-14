// The TPS stores Hebrew text in visual order: the characters as they appear on a left-to-right
// screen, so `בורר` ("selector") is stored as `ררוב`. Some descriptors were typed in logical order
// by other tools, so each string is classified before it is converted for display.

const HEBREW_WORD = /[א-ת]{2,}/g;
const FINAL = 'ךםןףץ';
const NON_FINAL = 'כמנפצ';
/** A left-to-right run inside a right-to-left line: Latin letters, digits and their punctuation. */
const LTR_RUN = /[A-Za-z0-9][A-Za-z0-9 .,:;/()%+\-_#]*[A-Za-z0-9]|[A-Za-z0-9]/g;

const reverse = (s: string) => [...s].reverse().join('');
const hebrewWords = (s: string) => s.match(HEBREW_WORD) ?? [];

export function hasHebrew(s: string): boolean {
  return /[א-ת]/.test(s);
}

/** Visual to logical order: reverse the line, then restore each left-to-right run. */
export function visualToLogical(s: string): string {
  return reverse(s).replace(LTR_RUN, reverse);
}

/**
 * Positive when the string looks visual, negative when it looks logical, 0 when there is no
 * evidence. Final letter forms only end words; a prefix letter's dash follows it (`ל-`).
 */
function evidence(s: string): number {
  let score = 0;
  for (const w of hebrewWords(s)) {
    if (FINAL.includes(w[0])) score++;
    if (NON_FINAL.includes(w[w.length - 1])) score++;
    if (FINAL.includes(w[w.length - 1])) score--;
  }
  score += (s.match(/(^|\s)-[א-ת](?=\s|$)/g) ?? []).length;
  score -= (s.match(/(^|\s)[א-ת]-(?=\s|$)/g) ?? []).length;
  return score;
}

/**
 * Decide the order of every Hebrew string in a collection and return a converter to logical
 * order. Strings with clear evidence decide themselves and teach a vocabulary of logical-order
 * words; the rest are decided by which orientation of their words that vocabulary knows better.
 */
export function hebrewOrienter(strings: Iterable<string>): (s: string) => string {
  const visual = new Map<string, boolean>();
  const vocabulary = new Map<string, number>();
  const pending: string[] = [];
  for (const s of strings) {
    if (!hasHebrew(s) || visual.has(s)) continue;
    const e = evidence(s);
    if (e === 0) {
      pending.push(s);
      continue;
    }
    visual.set(s, e > 0);
    for (const w of hebrewWords(s)) {
      const logical = e > 0 ? reverse(w) : w;
      vocabulary.set(logical, (vocabulary.get(logical) ?? 0) + 1);
    }
  }
  for (const s of pending) {
    let asIs = 0;
    let reversed = 0;
    for (const w of hebrewWords(s)) {
      asIs += vocabulary.get(w) ?? 0;
      reversed += vocabulary.get(reverse(w)) ?? 0;
    }
    visual.set(s, reversed > asIs);
  }
  return (s) => ((visual.get(s) ?? evidence(s) > 0) ? visualToLogical(s) : s);
}
