/**
 * Ranking rules (from spec.md), kept in one place so the behaviour is testable.
 *
 *  - Every song begins at score 0.
 *  - Thumbs up: +10 (toggle; un-liking reverses it).
 *  - Skipped in 30s or less: -2.
 *  - Skipped in 1 minute or less (but over 30s): -1.
 *  - Played to the end: +1.
 */
export const SCORE = {
  LIKE: 10,
  SKIP_FAST: -2,
  SKIP_SLOW: -1,
  COMPLETE: 1,
} as const;

export const SKIP_FAST_SECS = 30;
export const SKIP_SLOW_SECS = 60;

/**
 * Score delta for skipping a track `elapsedSecs` into playback.
 * Returns 0 when skipped after the 1-minute window (no penalty).
 */
export function skipDelta(elapsedSecs: number): number {
  if (elapsedSecs <= SKIP_FAST_SECS) return SCORE.SKIP_FAST;
  if (elapsedSecs <= SKIP_SLOW_SECS) return SCORE.SKIP_SLOW;
  return 0;
}

/** Score delta for letting a track play to completion. */
export function completeDelta(): number {
  return SCORE.COMPLETE;
}

/** Score delta for toggling the liked flag. */
export function likeDelta(nowLiked: boolean): number {
  return nowLiked ? SCORE.LIKE : -SCORE.LIKE;
}
