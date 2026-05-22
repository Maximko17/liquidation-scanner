import { getThresholdConfig } from '../config/index.js';

/**
 * Signal Confidence Scorer
 *
 * Pure function — evaluates the strength of a liquidation signal
 * using ratio, price reaction, OI delta, and market context.
 *
 * Returns a normalized score 0–10 (one decimal) with a classification label.
 */

/** Theoretical maximum raw score (additive sections only, before penalties) */
const RAW_THEORETICAL_MAX = 14;

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
 * @returns {{ score: number, label: string, retentionAdjustment: number, structureAdjustment: number }}
 */
export function scoreReaction(reaction) {
  let score = 0;

  const {
    ratio, dp5, dp15, dp60, dOI,
    position_5m, position_30m, lowData5m, lowData30m,
    classification, retentionRatio, finalMove, side,
  } = reaction;

  // ── A. Liquidation strength (ratio) ────────────────────
  if (ratio >= 12) {
    score += 4;
  } else if (ratio >= 8) {
    score += 3;
  } else if (ratio >= 5) {
    score += 2;
  } else if (ratio >= 3) {
    score += 1;
  }

  // ── B. Price reaction ──────────────────────────────────
  // Favorable direction multiplier: SHORT → +1 (bullish), LONG → −1 (bearish)
  const favDir = side === 'short' ? 1 : -1;
  // Projected deltas onto favorable direction (positive = moving favorably)
  const dp5f = dp5 * favDir;
  const dp15f = dp15 * favDir;
  const dp60f = dp60 * favDir;

  if (classification === 'STRONG_CONTINUATION' || classification === 'ABSORPTION') {
    if (dp5f >= 0.25) score += 1;
    if (dp15f >= 0.15) score += 1;
    if (dp60f >= 0.3) score += 1;
  }

  if (classification === 'REVERSAL') {
    // Reversal means price went opposite to favorable direction
    if (dp15f <= -0.15) score += 1;
    if (dp60f <= -0.2) score += 1;
  }

  // ── C. Open Interest ───────────────────────────────────
  if (dOI > 2) {
    score += 2;
  } else if (dOI > 1) {
    score += 1;
  } else if (dOI < -2) {
    score -= 1;
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

  // ── F. Impulse retention adjustment ────────────────────
  let retentionAdjustment = 0;

  // Only score retention when the impulse was meaningful
  if (reaction.meaningfulImpulse !== false && typeof retentionRatio === 'number' && typeof finalMove === 'number') {
    // Full reversal — price went opposite direction of max impulse
    if ((side === 'short' && finalMove < 0) || (side === 'long' && finalMove > 0)) {
      retentionAdjustment = -2;
    } else if (retentionRatio >= 0.7) {
      retentionAdjustment = +2;
    } else if (retentionRatio >= 0.3) {
      retentionAdjustment = 0;
    } else {
      retentionAdjustment = -1;
    }
  }

  score += retentionAdjustment;

  // ── G. Market structure acceptance adjustment ──────────
  const structureAdjustment = typeof reaction.structureScoreAdjustment === 'number'
    ? reaction.structureScoreAdjustment
    : 0;
  score += structureAdjustment;

  // ── Hard cap for weak impulses ─────────────────────────
  if (reaction.meaningfulImpulse === false) {
    score = Math.min(score, 4);
  }

  // ── Normalize & classify ───────────────────────────────
  const normalizedScore = (score / RAW_THEORETICAL_MAX) * 10;
  const roundedScore = Math.round(normalizedScore * 10) / 10;
  const finalScore = Math.max(0, Math.min(10, roundedScore));
  const label = classify(finalScore);

  return { score: finalScore, label, retentionAdjustment, structureAdjustment };
}

export { LABELS, classify };