import priceStreamService from './priceStreamService.js';
import { scoreReaction } from './signalScorer.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Post-Signal Reaction Tracker
 *
 * After a liquidation spike alert is triggered, this module:
 *   1. Captures price_0 and oi_0 at signal time
 *   2. Schedules snapshots at +5s, +15s, +60s
 *   3. Tracks path geometry: favorable extreme, adverse extreme, time-to-MFE
 *   4. Computes path quality metrics: MFE, MAE, finalMove, retention, efficiency
 *   5. Derives a human-readable path label from geometry (not rigid rules)
 *   6. Sends a secondary alert with the path analysis
 *
 * Merge logic for cascading signals:
 *   - If a new alert arrives within MERGE_WINDOW_MS (10s) of an active signal
 *     for the same symbol+side → merge (sum L_now, keep max ratio)
 *   - Otherwise → create new tracking instance
 *   - Max MAX_ACTIVE_SIGNALS (3) per symbol+side
 */

/**
 * Derive a human-readable path label from geometry metrics.
 * This is for display only — scoring uses continuous metrics, not this label.
 *
 * @param {object} params
 * @param {number} params.mfe
 * @param {number} params.mae
 * @param {number} params.finalMove
 * @param {number|null} params.retention
 * @param {number} params.efficiency
 * @param {boolean} params.isSweep
 * @param {string} params.momentumPhase
 * @param {boolean} params.hasMeaningfulImpulse
 * @returns {string}
 */
function derivePathLabel({ mfe, mae, finalMove, retention, efficiency, isSweep, momentumPhase, hasMeaningfulImpulse }) {
  if (!hasMeaningfulImpulse) {
    if (mae < 0.2) return 'dead_reaction';
    return 'absorbed';
  }

  if (isSweep) return 'liquidity_sweep';

  if (finalMove < 0 && Math.abs(finalMove) > mfe * 0.5) return 'failed_move';

  if (efficiency > 0.7 && retention !== null && retention > 0.7) {
    return momentumPhase === 'late_peak' ? 'building_continuation' : 'clean_continuation';
  }

  if (efficiency > 0.4 && retention !== null && retention > 0.4) return 'partial_continuation';

  if (mae > mfe * 0.6) return 'whipsaw';

  return 'weak_continuation';
}

class SignalReactionTracker {
  constructor() {
    /** @type {Map<string, Map<string, SignalState[]>>} symbol → side → active signals */
    this.activeSignals = new Map();
    /** @type {Array<(reaction: ReactionResult) => void>} */
    this.reactionCallbacks = [];

    priceStreamService.onPriceUpdate((symbol, price) => this._onPriceTick(symbol, price));
  }

  /**
   * Entry point: called when liquidationTracker fires an alert.
   * @param {import('./liquidationTracker.js').LiquidationAlert} alert
   */
  startTracking(alert) {
    const { symbol, side, L_now, ratio, timestamp } = alert;

    if (!this.activeSignals.has(symbol)) {
      this.activeSignals.set(symbol, new Map());
    }
    const sideMap = this.activeSignals.get(symbol);
    if (!sideMap.has(side)) {
      sideMap.set(side, []);
    }
    const signals = sideMap.get(side);

    const mergeWindow = config.REACTION_MERGE_WINDOW_MS || 10_000;
    for (const existing of signals) {
      if (timestamp - existing.startTime < mergeWindow) {
        existing.L_now += L_now;
        existing.ratio = Math.max(existing.ratio, ratio);
        existing.lastUpdateTime = timestamp;
        existing.mergeCount++;
        existing.merged = true;
        logger.info(
          `Reaction: merged cascade into ${existing.id} (L=${existing.L_now.toFixed(0)}, ratio=${existing.ratio.toFixed(1)}x, merges=${existing.mergeCount})`
        );
        return;
      }
    }

    const maxActive = config.REACTION_MAX_ACTIVE_SIGNALS || 3;
    while (signals.length >= maxActive) {
      const oldest = signals.shift();
      this._clearTimers(oldest);
      logger.info(`Reaction: evicted oldest signal ${oldest.id} (limit=${maxActive})`);
    }

    const id = `${symbol}:${side}:${timestamp}`;
    /** @type {SignalState} */
    const state = {
      id,
      symbol,
      side,
      startTime: timestamp,
      lastUpdateTime: timestamp,
      L_now,
      ratio,
      price_0: null,
      oi_0: null,
      price_5s: null,
      price_15s: null,
      price_60s: null,
      oi_5s: null,
      oi_15s: null,
      oi_60s: null,
      extremePriceSeen: null,
      adverseExtreme: null,
      timeOfMFE: 0,
      timers: { t5: null, t15: null, t60: null, cleanup: null },
      merged: false,
      mergeCount: 0,
    };

    signals.push(state);
    logger.info(`Reaction: started tracking ${id} (L=${L_now.toFixed(0)}, ratio=${ratio.toFixed(1)}x)`);

    this._initTracking(state);
  }

  async _initTracking(state) {
    const snap = priceStreamService.getClosestSnapshot(state.symbol, Date.now());
    if (!snap) {
      logger.error(`Reaction ${state.id}: no price data in buffer — aborting tracking`);
      this._removeSignal(state);
      return;
    }

    state.price_0 = snap.price;
    state.oi_0 = snap.openInterest;
    state.extremePriceSeen = snap.price;
    state.adverseExtreme = snap.price;
    logger.debug(`Reaction ${state.id}: price_0=${state.price_0}, oi_0=${state.oi_0}`);

    state.timers.t5 = setTimeout(() => this._capture5s(state), 5_000);
    state.timers.t15 = setTimeout(() => this._capture15s(state), 15_000);
    state.timers.t60 = setTimeout(() => this._capture60s(state), 60_000);
    state.timers.cleanup = setTimeout(() => this._cleanup(state), 90_000);
  }

  /**
   * Event-driven path geometry tracking.
   * Tracks favorable extreme (MFE), adverse extreme (MAE), and time-to-MFE.
   */
  _onPriceTick(symbol, price) {
    const sideMap = this.activeSignals.get(symbol);
    if (!sideMap) return;

    for (const [, signals] of sideMap) {
      for (const state of signals) {
        if (state.extremePriceSeen === null) continue;

        const tickDelta = (Date.now() - state.startTime) / 1000;

        if (state.side === 'short') {
          if (price > state.extremePriceSeen) {
            state.extremePriceSeen = price;
            state.timeOfMFE = tickDelta;
          }
          if (state.adverseExtreme === null || price < state.adverseExtreme) {
            state.adverseExtreme = price;
          }
        } else {
          if (price < state.extremePriceSeen) {
            state.extremePriceSeen = price;
            state.timeOfMFE = tickDelta;
          }
          if (state.adverseExtreme === null || price > state.adverseExtreme) {
            state.adverseExtreme = price;
          }
        }
      }
    }
  }

  async _capture5s(state) {
    const targetTime = state.startTime + 5_000;
    const snap = priceStreamService.getClosestSnapshot(state.symbol, targetTime);
    state.price_5s = snap?.price ?? state.price_0;
    state.oi_5s = snap?.openInterest || state.oi_0;
    logger.debug(`Reaction ${state.id}: price_5s=${state.price_5s}, oi_5s=${state.oi_5s}`);
  }

  async _capture15s(state) {
    const targetTime = state.startTime + 15_000;
    const snap = priceStreamService.getClosestSnapshot(state.symbol, targetTime);
    state.price_15s = snap?.price ?? state.price_5s ?? state.price_0;
    state.oi_15s = snap?.openInterest || state.oi_5s || state.oi_0;
    logger.debug(`Reaction ${state.id}: price_15s=${state.price_15s}, oi_15s=${state.oi_15s}`);
  }

  async _capture60s(state) {
    const targetTime = state.startTime + 60_000;
    const snap = priceStreamService.getClosestSnapshot(state.symbol, targetTime);
    state.price_60s = snap?.price ?? state.price_15s ?? state.price_0;
    state.oi_60s = snap?.openInterest || state.oi_0;
    logger.debug(`Reaction ${state.id}: price_60s=${state.price_60s}, oi_60s=${state.oi_60s}`);

    this._finalize(state);
  }

  _finalize(state) {
    const p0 = state.price_0 || 0;
    const p5 = state.price_5s ?? p0;
    const p15 = state.price_15s ?? p5;
    const p60 = state.price_60s ?? p15;
    const oi0 = state.oi_0 || 0;
    const oi60 = state.oi_60s ?? oi0;
    const extreme = state.extremePriceSeen ?? p0;
    const adv = state.adverseExtreme ?? p0;

    // Price deltas (secondary diagnostics)
    const dp5 = p0 > 0 ? ((p5 - p0) / p0) * 100 : 0;
    const dp15 = p5 > 0 ? ((p15 - p5) / p5) * 100 : 0;
    const dp60 = p15 > 0 ? ((p60 - p15) / p15) * 100 : 0;

    // Temporal OI deltas
    const oi5 = state.oi_5s ?? oi0;
    const oi15 = state.oi_15s ?? oi5;
    const dOI = oi0 > 0 ? ((oi60 - oi0) / oi0) * 100 : 0;
    const dOI5 = oi0 > 0 ? ((oi5 - oi0) / oi0) * 100 : 0;
    const dOI15 = oi0 > 0 ? ((oi15 - oi0) / oi0) * 100 : 0;
    const dOI60 = oi0 > 0 ? ((oi60 - oi0) / oi0) * 100 : 0;

    // ── Path geometry: four core metrics ──────────────────
    const mfe = state.side === 'short'
      ? ((extreme - p0) / p0) * 100
      : ((p0 - extreme) / p0) * 100;

    const mae = state.side === 'short'
      ? ((p0 - adv) / p0) * 100
      : ((adv - p0) / p0) * 100;

    const finalMove = state.side === 'short'
      ? ((p60 - p0) / p0) * 100
      : ((p0 - p60) / p0) * 100;

    const timeToMFE = state.timeOfMFE;

    // ── Derived path quality indicators ────────────────────
    // TODO: replace 0.3 with ATR-based threshold per symbol
    const MIN_MEANINGFUL_MFE = 0.3;
    const hasMeaningfulImpulse = mfe >= MIN_MEANINGFUL_MFE;

    const retention = hasMeaningfulImpulse
      ? Math.max(-1, Math.min(1, finalMove / mfe))
      : null;

    const efficiency = (mfe + mae) > 0
      ? finalMove / (mfe + mae)
      : 0;

    const isSweep = hasMeaningfulImpulse
      && retention !== null
      && retention < 0.2
      && timeToMFE < 15
      && mfe > 2 * mae;

    let momentumPhase;
    if (!hasMeaningfulImpulse) {
      momentumPhase = 'no_impulse';
    } else if (timeToMFE < 15) {
      momentumPhase = 'early_peak';
    } else if (timeToMFE >= 45) {
      momentumPhase = 'late_peak';
    } else {
      momentumPhase = 'mid_peak';
    }

    const pathLabel = derivePathLabel({
      mfe, mae, finalMove, retention, efficiency,
      isSweep, momentumPhase, hasMeaningfulImpulse,
    });

    /** @type {PathQuality} */
    const pathQuality = {
      mfe,
      mae,
      finalMove,
      timeToMFE,
      retention,
      efficiency,
      isSweep,
      momentumPhase,
      hasMeaningfulImpulse,
      label: pathLabel,
    };

    // ── Market context (secondary diagnostics) ─────────────
    const preEventTime = state.startTime - 1_000;
    const range5m = priceStreamService.getRange(state.symbol, config.CONTEXT_SHORT_RANGE_MS, preEventTime);
    const range30m = priceStreamService.getRange(state.symbol, config.CONTEXT_MID_RANGE_MS, preEventTime);

    let position_5m = null;
    let position_30m = null;
    let lowData5m = false;
    let lowData30m = false;

    if (range5m && range5m.high !== range5m.low) {
      position_5m = (p60 - range5m.low) / (range5m.high - range5m.low);
      lowData5m = range5m.coverage < config.CONTEXT_MIN_COVERAGE;
    }
    if (range30m && range30m.high !== range30m.low) {
      position_30m = (p60 - range30m.low) / (range30m.high - range30m.low);
      lowData30m = range30m.coverage < config.CONTEXT_MIN_COVERAGE;
    }

    /** @type {ReactionResult} */
    const reaction = {
      symbol: state.symbol,
      side: state.side,
      ratio: state.ratio,
      L_now: state.L_now,
      startTime: state.startTime,
      dp5,
      dp15,
      dp60,
      dOI,
      dOI5,
      dOI15,
      dOI60,
      merged: state.merged,
      mergeCount: state.mergeCount,
      position_5m,
      position_30m,
      lowData5m,
      lowData30m,
      pathQuality,
    };

    // ── Confidence score ──────────────────────────────────
    const { score: confidenceScore, label: confidenceLabel } = scoreReaction(reaction);
    reaction.confidenceScore = confidenceScore;
    reaction.confidenceLabel = confidenceLabel;

    logger.info(
      `Reaction ${state.id}: ${pathLabel} | MFE=${mfe.toFixed(2)}% MAE=${mae.toFixed(2)}% final=${finalMove.toFixed(2)}% ret=${retention !== null ? retention.toFixed(2) : 'N/A'} eff=${efficiency.toFixed(2)} tMFE=${timeToMFE.toFixed(1)}s`
    );

    for (const cb of this.reactionCallbacks) {
      try {
        cb(reaction);
      } catch (error) {
        logger.error('Error in reaction callback', { error });
      }
    }
  }

  _typeLabel(side) {
    return side === 'short' ? 'SHORT SQUEEZE 🟢' : 'LONG LIQUIDATION CASCADE 🔴';
  }

  /**
   * Format a reaction result into a human-readable message.
   * @param {ReactionResult} reaction
   * @returns {string}
   */
  formatReaction(reaction) {
    const typeLabel = this._typeLabel(reaction.side);
    const mergeNote = reaction.merged ? ` (merged x${reaction.mergeCount})` : '';
    const pq = reaction.pathQuality;

    // Temporal OI breakdown
    const oiLines = ['ΔOI:'];
    if (typeof reaction.dOI5 === 'number') oiLines.push(`• 5s:  ${this._fmtPct(reaction.dOI5)}`);
    if (typeof reaction.dOI15 === 'number') oiLines.push(`• 15s: ${this._fmtPct(reaction.dOI15)}`);
    if (typeof reaction.dOI60 === 'number') oiLines.push(`• 60s: ${this._fmtPct(reaction.dOI60)}`);

    // Position context (secondary)
    const contextLines = [];
    if (reaction.position_5m !== null) {
      contextLines.push('');
      contextLines.push(`Position 5m: ${reaction.position_5m.toFixed(2)}`);
    }
    if (reaction.position_30m !== null) {
      contextLines.push(`Position 30m: ${reaction.position_30m.toFixed(2)}`);
    }

    // Path Quality section
    const pathBlock = this._buildPathQualityBlock(pq);

    // Confidence
    const confidenceLine = reaction.confidenceScore !== undefined
      ? `\nConfidence: ${reaction.confidenceScore}/10 (${reaction.confidenceLabel})`
      : '';

    return [
      `📊 ${reaction.symbol} ${typeLabel} (${reaction.ratio.toFixed(1)}x)${mergeNote}`,
      ``,
      `Δ5s:  ${this._fmtPct(reaction.dp5)}`,
      `Δ15s: ${this._fmtPct(reaction.dp15)}`,
      `Δ60s: ${this._fmtPct(reaction.dp60)}`,
      ...oiLines,
      ...contextLines,
      ...pathBlock,
      confidenceLine,
    ].filter(Boolean).join('\n');
  }

  /**
   * Build the Path Quality display block.
   * Template varies by path label.
   * @param {PathQuality} pq
   * @returns {string[]}
   */
  _buildPathQualityBlock(pq) {
    if (!pq) return [];

    const lines = ['', '📐 Path Quality'];

    // Core metrics line
    const mfeLine = `- MFE ${this._fmtPct(pq.mfe)} in ${pq.timeToMFE.toFixed(0)}s | MAE ${this._fmtPct(pq.mae)}`;
    lines.push(mfeLine);

    // Retention
    if (pq.retention !== null) {
      const retPct = Math.round(pq.retention * 100);
      const retNote = pq.retention < 0.3 ? ' (faded)' : '';
      lines.push(`- Retention: ${retPct}%${retNote}`);
    }

    // Efficiency
    const effDesc = pq.efficiency > 0.7 ? ' (clean path)' : pq.efficiency < 0 ? ' (reversal)' : '';
    lines.push(`- Efficiency: ${pq.efficiency.toFixed(2)}${effDesc}`);

    // Final move
    lines.push(`- Final: ${this._fmtPct(pq.finalMove)}`);

    // Interpretation line
    lines.push('');
    lines.push(...this._pathInterpretationLines(pq));

    return lines;
  }

  /**
   * Human-readable interpretation lines based on path label.
   * @param {PathQuality} pq
   * @returns {string[]}
   */
  _pathInterpretationLines(pq) {
    switch (pq.label) {
      case 'clean_continuation':
        return ['→ CLEAN CONTINUATION', '→ momentum sustained through observation window'];
      case 'building_continuation':
        return ['→ BUILDING CONTINUATION', '→ still developing at end of window', '→ momentum may extend further'];
      case 'partial_continuation':
        return ['→ PARTIAL CONTINUATION', '→ some resistance encountered', '→ moderate directional quality'];
      case 'weak_continuation':
        return ['→ WEAK CONTINUATION', '→ low directional conviction'];
      case 'liquidity_sweep':
        return ['⚠️ LIQUIDITY SWEEP', '→ fast spike, complete fade', '→ high reversal risk'];
      case 'failed_move':
        return ['→ FAILED MOVE', '→ market rejected the direction', '→ high reversal probability'];
      case 'whipsaw':
        return ['⚠️ WHIPSAW', '→ significant two-way movement', '→ no conviction'];
      case 'dead_reaction':
        return ['→ DEAD REACTION', '→ no meaningful displacement', '→ market ignored the liquidation'];
      case 'absorbed':
        return ['→ ABSORBED', '→ event was absorbed without moving price'];
      default:
        return [`→ ${pq.label.replace(/_/g, ' ').toUpperCase()}`];
    }
  }

  _fmtPct(value) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  }

  _removeSignal(state) {
    const sideMap = this.activeSignals.get(state.symbol);
    if (!sideMap) return;
    const signals = sideMap.get(state.side);
    if (!signals) return;
    const idx = signals.indexOf(state);
    if (idx !== -1) signals.splice(idx, 1);
    this._clearTimers(state);
    if (signals.length === 0) sideMap.delete(state.side);
    if (sideMap.size === 0) this.activeSignals.delete(state.symbol);
  }

  _cleanup(state) {
    logger.debug(`Reaction: cleanup ${state.id}`);
    this._removeSignal(state);
  }

  _clearTimers(state) {
    for (const key of Object.keys(state.timers)) {
      if (state.timers[key]) {
        clearTimeout(state.timers[key]);
        state.timers[key] = null;
      }
    }
  }

  onReaction(callback) {
    this.reactionCallbacks.push(callback);
  }

  stop() {
    for (const sideMap of this.activeSignals.values()) {
      for (const signals of sideMap.values()) {
        for (const state of signals) {
          this._clearTimers(state);
        }
      }
    }
    this.activeSignals.clear();
    this.reactionCallbacks = [];
    logger.info('Reaction tracker stopped');
  }

  getTrackedSignalCount() {
    let count = 0;
    for (const sideMap of this.activeSignals.values()) {
      for (const signals of sideMap.values()) {
        count += signals.length;
      }
    }
    return count;
  }
}

// ── Type definitions (JSDoc) ───────────────────────────────

/**
 * @typedef {object} SignalState
 * @property {string} id
 * @property {string} symbol
 * @property {'long'|'short'} side
 * @property {number} startTime
 * @property {number} lastUpdateTime
 * @property {number} L_now
 * @property {number} ratio
 * @property {number|null} price_0
 * @property {number|null} oi_0
 * @property {number|null} price_5s
 * @property {number|null} price_15s
 * @property {number|null} price_60s
 * @property {number|null} oi_5s
 * @property {number|null} oi_15s
 * @property {number|null} oi_60s
 * @property {number|null} extremePriceSeen
 * @property {number|null} adverseExtreme
 * @property {number} timeOfMFE
 * @property {{ t5: NodeJS.Timeout|null, t15: NodeJS.Timeout|null, t60: NodeJS.Timeout|null, cleanup: NodeJS.Timeout|null }} timers
 * @property {boolean} merged
 * @property {number} mergeCount
 */

/**
 * @typedef {object} PathQuality
 * @property {number} mfe
 * @property {number} mae
 * @property {number} finalMove
 * @property {number} timeToMFE
 * @property {number|null} retention
 * @property {number} efficiency
 * @property {boolean} isSweep
 * @property {'no_impulse'|'early_peak'|'mid_peak'|'late_peak'} momentumPhase
 * @property {boolean} hasMeaningfulImpulse
 * @property {string} label
 */

/**
 * @typedef {object} ReactionResult
 * @property {string} symbol
 * @property {'long'|'short'} side
 * @property {number} ratio
 * @property {number} L_now
 * @property {number} startTime
 * @property {number} dp5
 * @property {number} dp15
 * @property {number} dp60
 * @property {number} dOI
 * @property {number} dOI5
 * @property {number} dOI15
 * @property {number} dOI60
 * @property {boolean} merged
 * @property {number} mergeCount
 * @property {number|null} position_5m
 * @property {number|null} position_30m
 * @property {boolean} lowData5m
 * @property {boolean} lowData30m
 * @property {PathQuality} pathQuality
 * @property {number} [confidenceScore]
 * @property {string} [confidenceLabel]
 */

// Singleton
const reactionTracker = new SignalReactionTracker();
export default reactionTracker;