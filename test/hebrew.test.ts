import { describe, expect, it } from 'vitest';
import { hebrewOrienter, visualToLogical } from '../src/language/hebrew';

// Made-up descriptors. Visual order is how the TPS stores text: reversed, with Latin runs kept.
const visual = (logical: string) => visualToLogical(logical);

describe('Hebrew descriptors', () => {
  it('converts visual order to logical, keeping Latin runs intact', () => {
    expect(visualToLogical('T-12 ל המרזה תרקב')).toBe('בקרת הזרמה ל T-12');
    expect(visualToLogical('P-7 תבאשמ בצמ')).toBe('מצב משאבת P-7');
    // The conversion is its own inverse.
    expect(visual(visual('שסתום כניסה V-3'))).toBe('שסתום כניסה V-3');
  });

  it('converts strings stored in visual order and leaves logical ones alone', () => {
    const visual1 = visual('לחץ במיכלים גבוה'); // final letters at word start once reversed
    const visual2 = visual('מים ל- T-2 מ- T-1'); // dash before a prefix letter once reversed
    const logical1 = 'T-4 מים לניקוז'; // final letter at word end
    const ambiguous = visual('ברז ניקוז T-5'); // no final letters: decided by vocabulary
    const teaches = visual('ברז ניקוז ראשי למיכלים'); // visual, with final letters
    const orient = hebrewOrienter([visual1, visual2, logical1, ambiguous, teaches]);
    expect(orient(visual1)).toBe('לחץ במיכלים גבוה');
    expect(orient(visual2)).toBe('מים ל- T-2 מ- T-1');
    expect(orient(logical1)).toBe(logical1);
    expect(orient(ambiguous)).toBe('ברז ניקוז T-5');
  });

  it('leaves text without Hebrew unchanged', () => {
    expect(hebrewOrienter(['PUMP P101'])('PUMP P101')).toBe('PUMP P101');
  });
});
