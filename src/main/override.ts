/** Normalizes for comparison: trims, lowercases, and collapses internal whitespace runs to a single space. */
function normalize(input: string): string {
  return input.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * True iff `input`, once trimmed/lowercased/whitespace-collapsed, exactly
 * equals `phrase` under the same normalization. Deliberately not a substring
 * match — the override phrase must be spoken deliberately on its own,
 * not merely appear somewhere inside a longer sentence.
 */
export function matchOverride(input: string, phrase: string): boolean {
  return normalize(input) === normalize(phrase);
}
