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
 * Normalization denominator: a *realistic achievable* strong-signal raw score, NOT the
 * impossible sum of every section's max (sections don't jointly max out, and negatives drag
 * the realized range down). The old 17.5 (sum-of-bests) squashed everything toward 0 and made
 * STRONG/EXTREME unreachable. 11 maps a genuinely strong signal to ~10/10 while keeping the
 * 0–10 cutoffs (4/7/9) reachable. PROVISIONAL — Phase F should set this from the observed
 * raw-score distribution (~95th pct). Revisit when Phase C double-counts (path) are fixed.
 * Section ranges (current): A 0..2, B -3..6.5, C ~-4.4..4.4, D -1..2, E -1..1.
 */
const RAW_THEORETICAL_MAX = 11;

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

  const { mfe, mae, mfe_sigma, retention, efficiency, isSweep, momentumPhase, hasMeaningfulImpulse } = pq;

  if (!hasMeaningfulImpulse) {
    score -= 1;
    breakdown.noImpulse = -1;
    return { score, breakdown };
  }

  // MFE magnitude — volatility-normalized (σ) when available, raw-% fallback otherwise.
  // σ tiers relaxed (was 3/2/1): a clean reaction is ~2σ; 3σ for the top tier was unreachable.
  let mfeScore = 0;
  if (mfe_sigma != null) {
    if (mfe_sigma >= 2.5) mfeScore = 2;
    else if (mfe_sigma >= 1.5) mfeScore = 1;
    else if (mfe_sigma >= 1) mfeScore = 0.5;
  } else {
    if (mfe >= 1.0) mfeScore = 2;
    else if (mfe >= 0.5) mfeScore = 1;
    else if (mfe >= 0.3) mfeScore = 0.5;
  }
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
  const breakdown = {};

  const {
    cvd15_aligned, cvd60_aligned, participationRatio,
    aggBuyShift, largeParticipation, tradeCount_15s, label,
  } = p;

  // Insufficient data — neutral, do not score (data-sufficiency gate, not a categorical label)
  if (label === 'insufficient_flow_data' || tradeCount_15s < 5) {
    breakdown.note = 'insufficient_data';
    return { score: 0, breakdown };
  }

  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // Continuous scoring off the numbers (labels are display-only, §9). All terms smooth
  // and clamped — no cliff edges. Inputs are de-contaminated (voluntary) flow.

  // Main: voluntary aligned flow vs liquidation size. Signed — positive = continuation
  // support, negative = absorption against (scaled by magnitude, not a flat penalty).
  const prTerm = clamp(participationRatio, -1.5, 1.5) * 2;       // ±3
  breakdown.participation = prTerm;

  // Aggressor balance shift vs baseline (side-corrected upstream).
  let aggTerm = 0;
  if (aggBuyShift !== null) {
    aggTerm = clamp(aggBuyShift, -0.5, 0.5) * 1.5;              // ±0.75
    breakdown.aggressorShift = aggTerm;
  }

  // Large-trader alignment — counted ONCE here (removes the old label double-count).
  const largeTerm = clamp(largeParticipation, -0.4, 0.4) * 2;   // ±0.8
  breakdown.largeTraders = largeTerm;

  // Persistence: does the 60s flow still agree in sign with the 15s flow?
  let persist = 0;
  if (cvd15_aligned !== 0 && cvd60_aligned !== 0) {
    persist = Math.sign(cvd60_aligned) === Math.sign(cvd15_aligned) ? 0.3 : -0.3;
    breakdown.persistence = persist;
  }

  const score = prTerm + aggTerm + largeTerm + persist;         // ≈ [-4.4, +4.4]
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