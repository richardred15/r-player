/**
 * Ranking rules, kept in one place so the behaviour is testable.
 *
 *  - Every song begins at score 0.
 *  - Thumbs up: +10 (toggle; un-liking reverses it).
 *  - Played to the end: +1.
 *  - Skip penalty is based on the **fraction of the track heard** (so short songs
 *    aren't unfairly punished by absolute-second thresholds):
 *      < 25%        → -2
 *      25% – 50%    → -1
 *      50% – 90%    →  0   (a fair listen; no penalty)
 *      ≥ 90%        → +1   (counts as a full play, same as finishing it)
 */
export const SCORE = {
  LIKE: 10,
  SKIP_FAST: -2,
  SKIP_SLOW: -1,
  COMPLETE: 1,
} as const;

/** At/above this fraction heard, a skip counts as a completed play. */
export const COMPLETE_FRACTION = 0.9;
/** At/above this fraction heard, a skip is penalty-free. */
export const NO_PENALTY_FRACTION = 0.5;
/** At/above this fraction heard, a skip is the lighter penalty; below it, the heavier one. */
export const SLOW_FRACTION = 0.25;

/**
 * Score delta for skipping a track after hearing `elapsedSecs` of `durationSecs`.
 * Uses the fraction heard, not absolute seconds. Returns 0 when the duration is
 * unknown (can't compute a fraction, so don't penalise).
 */
export function skipDelta(elapsedSecs: number, durationSecs: number): number {
  if (!durationSecs || durationSecs <= 0 || !isFinite(durationSecs)) return 0;
  const fraction = elapsedSecs / durationSecs;
  if (fraction >= COMPLETE_FRACTION) return SCORE.COMPLETE;
  if (fraction >= NO_PENALTY_FRACTION) return 0;
  if (fraction >= SLOW_FRACTION) return SCORE.SKIP_SLOW;
  return SCORE.SKIP_FAST;
}

/** Score delta for letting a track play to completion. */
export function completeDelta(): number {
  return SCORE.COMPLETE;
}

/** Score delta for toggling the liked flag. */
export function likeDelta(nowLiked: boolean): number {
  return nowLiked ? SCORE.LIKE : -SCORE.LIKE;
}
