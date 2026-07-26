export type TolerantViolationStatus = 'pass' | 'warn' | 'fail';

const TRAILING_INVISIBLE_CHARACTERS = /[\s\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]+$/gu;
const VALID_END_PUNCTUATION = /[.!?؟:۔…！？：][\u0022\u0027\u00BB\u2019\u201D\u276F\u3009\u300B\u3011\u3015\u3017\u3019\u301B\uFF09\uFF3D\uFF5D)\]}]*$/u;

// A small number of local readability issues should remain a warning so the
// criterion bar stays amber. Three or more issues are treated as a failure.
export const getTolerantViolationStatus = (violationCount: number): TolerantViolationStatus => {
  if (violationCount <= 0) return 'pass';
  if (violationCount <= 2) return 'warn';
  return 'fail';
};

export const hasValidParagraphEndPunctuation = (text: string): boolean => {
  const visibleEnding = String(text || '').replace(TRAILING_INVISIBLE_CHARACTERS, '');
  return VALID_END_PUNCTUATION.test(visibleEnding);
};
