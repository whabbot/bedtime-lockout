export type Strictness = "Gentle" | "Firm" | "Unmovable";

export type GraceCaps = {
  Gentle: number;
  Firm: number;
  Unmovable: number;
};

/**
 * Caps the requested grace period to the maximum allowed for the given strictness level.
 * Returns the minimum of the requested value (clamped to 0) and the strictness cap.
 *
 * @param requestedMs - The requested grace period in milliseconds
 * @param strictness - The strictness level ('Gentle', 'Firm', or 'Unmovable')
 * @param caps - The grace caps for each strictness level
 * @returns The capped grace period in milliseconds
 */
export function capGrace(requestedMs: number, strictness: Strictness, caps: GraceCaps): number {
  // Clamp the requested value to [0, +Infinity]
  const clamped = Math.max(requestedMs, 0);
  // Apply the strictness cap
  return Math.min(clamped, caps[strictness]);
}
