import { getThresholdConfig } from '../config/index.js';

/**
 * Signal Confidence Scorer
 *
 * Pure function — evaluates the strength of a liquidation signal
 * using ratio, price reaction, OI delta, and market context.
 *
 * Returns a score 0–10 with a classification label.
 */

/** Score labels by range */
const LABELS = {
  WEAK: 'WEAK',
  MEDIUM: 'MEDIUM',
  STRONG: 'STRONG',
  EXTREME: 'EXTREME',
};

/**
 * Classify score into a human-readable label.
 * @param {number} score
 * @returns {string}
 */
function classify(score) {
  if (score >= 9) return LABELS.EXTREME;
  if (score >= 7) return LABELS.STRONG;
  if (score >= 4) return LABELS.MEDIUM;
  return LABELS.WEAK;
}

/**
 * Score a reaction result.
 *
 * @param {import('./signalReactionTracker.js').ReactionResult} reaction
 * @returns {{ score: number, label: string }}
 */
export function scoreReaction(reaction) {
  let score = 0;

  const { ratio, dp5, dp15, dp60, dOI, position_5m, position_30m, lowData5m, lowData30m, classification } = reaction;

  // ── A. Liquidation strength (ratio) ────────────────────
  if (ratio >= 8) {
    score += 3;
  } else if (ratio >= 6) {
    score += 2;
  } else if (ratio >= 4) {
    score += 1;
  }

  // ── B. Price reaction ──────────────────────────────────
  if (classification === 'STRONG_CONTINUATION' || classification === 'ABSORPTION') {
    if (dp5 >= 0.25) score += 1;
    if (dp15 >= 0.15) score += 2;
    if (dp60 >= 0.3) score += 2;
  }

  if (classification === 'REVERSAL') {
    if (dp15 <= -0.15) score += 2;
    if (dp60 <= -0.2) score += 2;
  }

  // ── C. Open Interest ───────────────────────────────────
  if (dOI > 1) {
    score += 1;
  } else if (dOI < -1) {
    // positions closing — neutral (no bonus)
  }

  // ── D. Market context (multi-timeframe) ────────────────
  let isHigh5m = false;
  let isLow5m = false;
  let isHigh30m = false;
  let isLow30m = false;

  if (position_5m !== null) {
    isHigh5m = position_5m > 0.8;
    isLow5m = position_5m < 0.2;
  }
  if (position_30m !== null) {
    isHigh30m = position_30m > 0.8;
    isLow30m = position_30m < 0.2;
  }

  // Alignment: both TFs at same extreme → high conviction
  if ((isHigh5m && isHigh30m) || (isLow5m && isLow30m)) {
    score += 2;
  }

  // Conflict: divergent extremes → lower conviction
  if ((isHigh5m && isLow30m) || (isLow5m && isHigh30m)) {
    score -= 1;
  }

  // ── E. Penalties ───────────────────────────────────────
  // Low data coverage
  if (lowData5m || lowData30m) {
    score -= 1;
  }

  // Absolute size penalty: L_now barely above absThreshold * 2
  const { absThreshold } = getThresholdConfig(reaction.symbol);
  if (typeof reaction.L_now === 'number' && reaction.L_now < absThreshold * 2) {
    score -= 1;
  }

  // ── Normalize & classify ───────────────────────────────
  score = Math.max(0, Math.min(10, score));
  const label = classify(score);

  return { score, label };
}

export { LABELS, classify };