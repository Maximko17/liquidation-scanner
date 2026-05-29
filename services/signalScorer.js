import { getThresholdConfig } from '../config/index.js';

/**
 * Signal Confidence Scorer
 *
 * Evaluates the strength of a liquidation signal using:
 *   - Liquidation abnormality (ratio)
 *   - Path quality (MFE, MAE, efficiency, retention, momentum phase)
 *   - Participation quality (CVD, aggressor shift, large traders, intensity)
 *   - OI participation (side-aware)
 *   - Multi-TF context
 *   - Penalties
 *
 * Returns a normalized score 0–10 (one decimal) with a classification label.
 */

/**
 * Theoretical maximum raw score (additive sections only):
 *   A. Ratio:        0 to 2
 *   B. Path quality: -3 to 6.5
 *   C. Participation: -4.5 to 6
 *   D. OI:           -1 to 2
 *   E. Context:      -1 to 1
 *   = 17.5 (penalties subtractive below)
 */
const RAW_THEORETICAL_MAX = 17.5;

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

  if (!hasMeaningfulImpulse) {
    score -= 1;
    breakdown.noImpulse = -1;
    return { score, breakdown };
  }

  // MFE magnitude
  let mfeScore = 0;
  if (mfe >= 1.0) mfeScore = 2;
  else if (mfe >= 0.5) mfeScore = 1;
  else if (mfe >= 0.3) mfeScore = 0.5;
  score += mfeScore;
  breakdown.mfe = mfeScore;

  // Efficiency
  let effScore = 0;
  if (efficiency > 0.7) effScore = 2;
  else if (efficiency > 0.4) effScore = 1;
  else if (efficiency < -0.3) effScore = -2;
  else if (efficiency < 0) effScore = -1;
  score += effScore;
  breakdown.efficiency = effScore;

  // Retention
  let retScore = 0;
  if (retention !== null) {
    if (retention > 0.7) retScore = 1.5;
    else if (retention > 0.4) retScore = 0.5;
    else if (retention < 0) retScore = -1;
  }
  score += retScore;
  breakdown.retention = retScore;

  // Momentum phase
  let phaseScore = 0;
  if (momentumPhase === 'late_peak') phaseScore = 1;
  else if (momentumPhase === 'early_peak') phaseScore = -0.5;
  score += phaseScore;
  breakdown.phase = phaseScore;

  // Sweep penalty
  if (isSweep) {
    score -= 2;
    breakdown.sweep = -2;
  }

  // Whipsaw penalty
  if (mae > mfe * 0.6 && retention !== null && retention < 0.4) {
    score -= 1;
    breakdown.whipsaw = -1;
  }

  return { score, breakdown };
}

/**
 * Score participation quality from trade flow (CVD) metrics.
 * Independent dimension — measures voluntary trade flow around the liquidation.
 *
 * @param {import('./signalReactionTracker.js').ParticipationResult} p
 * @returns {{ score: number, breakdown: object }}
 */
function scoreParticipation(p) {
  let score = 0;
  const breakdown = {};

  const {
    cvd15_aligned, cvd60_aligned, participationRatio,
    aggBuyShift, largeParticipation, intensitySurge,
    tradeCount_15s, label,
  } = p;

  // Insufficient data — neutral, do not score
  if (label === 'insufficient_flow_data' || tradeCount_15s < 5) {
    breakdown.note = 'insufficient_data';
    return { score: 0, breakdown };
  }

  // Main signal: aligned CVD presence
  if (label === 'strong_aligned_participation') {
    score += 3;
    breakdown.alignedFlow = 3;
  } else if (label === 'passive_aligned') {
    score += 1;
    breakdown.alignedFlow = 1;
  } else if (label === 'liquidity_vacuum') {
    score -= 1.5;
    breakdown.vacuum = -1.5;
  } else if (label === 'absorption_against') {
    score -= 2.5;
    breakdown.absorption = -2.5;
  }

  // Bonus: aggressor balance shift confirms direction
  if (aggBuyShift !== null) {
    if (aggBuyShift > 0.15) {
      score += 1;
      breakdown.aggressorShift = 1;
    } else if (aggBuyShift < -0.15) {
      score -= 1;
      breakdown.aggressorShift = -1;
    }
  }

  // Bonus: large traders aligned (institutional confirmation)
  if (largeParticipation > 0.2) {
    score += 1;
    breakdown.largeTraders = 1;
  } else if (largeParticipation < -0.2) {
    score -= 1;
    breakdown.largeTraders = -1;
  }

  // Bonus: intensity surge (market woke up and engaged)
  if (intensitySurge > 3 && cvd15_aligned > 0) {
    score += 0.5;
    breakdown.intensity = 0.5;
  }

  // Sanity: persistent flow (60s confirms 15s)
  if (cvd60_aligned > 0 && cvd15_aligned > 0 && cvd60_aligned >= cvd15_aligned * 0.7) {
    score += 0.5;
    breakdown.persistence = 0.5;
  } else if (cvd15_aligned > 0 && cvd60_aligned < 0) {
    // Flow reversed within window — bad sign
    score -= 1;
    breakdown.flowReversal = -1;
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
  if (dOI > 2) return 2;
  if (dOI > 1) return 1;
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

  const { ratio, dOI, side, position_5m, position_30m, lowData5m, lowData30m, pathQuality, participation } = reaction;

  // ── A. Liquidation strength (ratio) ────────────────────
  if (ratio >= 12) {
    score += 2;
  } else if (ratio >= 8) {
    score += 1.5;
  } else if (ratio >= 5) {
    score += 1;
  } else if (ratio >= 3) {
    score += 0.5;
  }

  // ── B. Path quality ────────────────────────────────────
  score += scorePathQuality(pathQuality).score;

  // ── C. Participation quality (CVD/trade flow) ────────────
  if (participation) {
    score += scoreParticipation(participation).score;
  }

  // ── D. OI delta (side-aware) ───────────────────────────
  score += scoreOI(dOI, side);

  // ── E. Multi-TF context ────────────────────────────────
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

  // ── F. Penalties ───────────────────────────────────────
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