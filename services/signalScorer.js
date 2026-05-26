import { getThresholdConfig } from '../config/index.js';

/**
 * Signal Confidence Scorer
 *
 * Evaluates the strength of a liquidation signal using:
 *   - Liquidation abnormality (ratio)
 *   - Path quality (MFE, MAE, efficiency, retention, momentum phase)
 *   - OI participation (side-aware)
 *   - Multi-TF context
 *   - Penalties
 *
 * Returns a normalized score 0–10 (one decimal) with a classification label.
 */

/** Theoretical maximum raw score (additive sections only) */
const RAW_THEORETICAL_MAX = 2 + 6.5 + 2 + 1; // A + B + C + D = 11.5

/** Score labels by range */
const LABELS = {
  WEAK: 'WEAK',
  MEDIUM: 'MEDIUM',
  STRONG: 'STRONG',
  EXTREME: 'EXTREME',
};

function classify(score) {
  if (score >= 9) return LABELS.EXTREME;
  if (score >= 7) return LABELS.STRONG;
  if (score >= 4) return LABELS.MEDIUM;
  return LABELS.WEAK;
}

/**
 * Score path quality from geometry metrics.
 * Replaces old Section B (price reaction) + acceptance + retention.
 *
 * @param {import('./signalReactionTracker.js').PathQuality} pq
 * @returns {{ score: number, breakdown: object }}
 */
function scorePathQuality(pq) {
  let score = 0;
  const breakdown = {};

  const { mfe, mae, retention, efficiency, isSweep, momentumPhase, hasMeaningfulImpulse } = pq;

  // --- No meaningful impulse: penalty ---
  if (!hasMeaningfulImpulse) {
    score -= 1;
    breakdown.noImpulse = -1;
    return { score, breakdown };
  }

  // --- MFE magnitude (one bounded contribution, not triple-counted via deltas) ---
  // TODO: replace with ATR-normalized thresholds per symbol
  let mfeScore = 0;
  if (mfe >= 1.0) mfeScore = 2;
  else if (mfe >= 0.5) mfeScore = 1;
  else if (mfe >= 0.3) mfeScore = 0.5;
  score += mfeScore;
  breakdown.mfe = mfeScore;

  // --- Efficiency: how clean was the path ---
  let effScore = 0;
  if (efficiency > 0.7) effScore = 2;
  else if (efficiency > 0.4) effScore = 1;
  else if (efficiency < -0.3) effScore = -2;  // strong reversal
  else if (efficiency < 0) effScore = -1;     // mild reversal
  score += effScore;
  breakdown.efficiency = effScore;

  // --- Retention: did the move hold ---
  let retScore = 0;
  if (retention !== null) {
    if (retention > 0.7) retScore = 1.5;
    else if (retention > 0.4) retScore = 0.5;
    else if (retention < 0) retScore = -1;   // ended against direction
  }
  score += retScore;
  breakdown.retention = retScore;

  // --- Momentum phase: late peak is bullish for continuation ---
  let phaseScore = 0;
  if (momentumPhase === 'late_peak') phaseScore = 1;       // still building
  else if (momentumPhase === 'early_peak') phaseScore = -0.5;  // exhausted early
  score += phaseScore;
  breakdown.phase = phaseScore;

  // --- Sweep penalty (classic liquidity grab) ---
  if (isSweep) {
    score -= 2;
    breakdown.sweep = -2;
  }

  // --- Whipsaw penalty (no conviction) ---
  if (mae > mfe * 0.6 && retention !== null && retention < 0.4) {
    score -= 1;
    breakdown.whipsaw = -1;
  }

  return { score, breakdown };
}

/**
 * Score OI delta with side-aware interpretation.
 *
 * SHORT liquidation (price went UP):
 *   dOI > 0 = new LONGS entering (bullish continuation confirmation)
 *   dOI < 0 = shorts just closing, no new longs (weak basis)
 *
 * LONG liquidation (price went DOWN):
 *   dOI > 0 = new SHORTS entering (bearish continuation confirmation)
 *   dOI < 0 = longs just capitulating, no new shorts (possible bounce)
 *
 * @param {number} dOI - OI delta in %
 * @param {'long'|'short'} side
 * @returns {number}
 */
function scoreOI(dOI, side) {
  // Both sides: positive dOI means new positions entering → confirms continuation
  if (dOI > 2) return 2;
  if (dOI > 1) return 1;
  // Negative dOI: positions closing → exhaustion / flush complete
  if (dOI < -2) return -1;
  return 0;
}

/**
 * Score a reaction result.
 *
 * @param {import('./signalReactionTracker.js').ReactionResult} reaction
 * @returns {{ score: number, label: string }}
 */
export function scoreReaction(reaction) {
  let score = 0;

  const { ratio, dOI, side, position_5m, position_30m, lowData5m, lowData30m, pathQuality } = reaction;

  // ── A. Liquidation strength (ratio) ────────────────────
  // Ratio is a necessary condition, not the main signal — reduced weight
  if (ratio >= 12) {
    score += 2;
  } else if (ratio >= 8) {
    score += 1.5;
  } else if (ratio >= 5) {
    score += 1;
  } else if (ratio >= 3) {
    score += 0.5;
  }

  // ── B. Path quality (replaces old B + acceptance + retention) ──
  const pqResult = scorePathQuality(pathQuality);
  score += pqResult.score;

  // ── C. OI delta (side-aware) ───────────────────────────
  score += scoreOI(dOI, side);

  // ── D. Multi-TF context (reduced weight) ────────────────
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

  if ((isHigh5m && isHigh30m) || (isLow5m && isLow30m)) {
    score += 1;
  }
  if ((isHigh5m && isLow30m) || (isLow5m && isHigh30m)) {
    score -= 1;
  }

  // ── E. Penalties ───────────────────────────────────────
  if (lowData5m || lowData30m) {
    score -= 1;
  }

  const { absThreshold } = getThresholdConfig(reaction.symbol);
  if (typeof reaction.L_now === 'number' && reaction.L_now < absThreshold * 2) {
    score -= 1;
  }

  // ── Normalize & classify ───────────────────────────────
  const normalizedScore = (score / RAW_THEORETICAL_MAX) * 10;
  const roundedScore = Math.round(normalizedScore * 10) / 10;
  const finalScore = Math.max(0, Math.min(10, roundedScore));
  const label = classify(finalScore);

  return { score: finalScore, label };
}

export { LABELS, classify };