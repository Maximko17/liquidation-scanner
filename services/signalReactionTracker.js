import priceStreamService from './priceStreamService.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Post-Signal Reaction Tracker
 *
 * After a liquidation spike alert is triggered, this module:
 *   1. Captures price_0 and oi_0 at signal time
 *   2. Schedules snapshots at +5s, +15s, +60s
 *   3. Computes ΔP (price deltas) and ΔOI (open interest delta)
 *   4. Classifies the signal: STRONG_CONTINUATION | REVERSAL | ABSORPTION | IGNORE
 *   5. Sends a secondary alert with the reaction analysis
 *
 * Merge logic for cascading signals:
 *   - If a new alert arrives within MERGE_WINDOW_MS (10s) of an active signal
 *     for the same symbol+side → merge (sum L_now, keep max ratio)
 *   - Otherwise → create new tracking instance
 *   - Max MAX_ACTIVE_SIGNALS (3) per symbol+side
 */

class SignalReactionTracker {
  constructor() {
    /** @type {Map<string, Map<string, SignalState[]>>} symbol → side → active signals */
    this.activeSignals = new Map();
    /** @type {Array<(reaction: ReactionResult) => void>} */
    this.reactionCallbacks = [];
  }

  /**
   * Entry point: called when liquidationTracker fires an alert.
   * Applies merge logic for cascading signals within the merge window.
   * @param {import('./liquidationTracker.js').LiquidationAlert} alert
   */
  startTracking(alert) {
    const { symbol, side, L_now, ratio, timestamp } = alert;

    // ── 1. Get (or create) the symbol+side bucket ──────────
    if (!this.activeSignals.has(symbol)) {
      this.activeSignals.set(symbol, new Map());
    }
    const sideMap = this.activeSignals.get(symbol);
    if (!sideMap.has(side)) {
      sideMap.set(side, []);
    }
    const signals = sideMap.get(side);

    // ── 2. Check for merge with existing active signal ─────
    const mergeWindow = config.REACTION_MERGE_WINDOW_MS || 10_000;
    for (const existing of signals) {
      if (timestamp - existing.startTime < mergeWindow) {
        // MERGE: update existing signal
        existing.L_now += L_now;
        existing.ratio = Math.max(existing.ratio, ratio);
        existing.lastUpdateTime = timestamp;
        existing.mergeCount++;
        existing.merged = true;
        logger.info(
          `Reaction: merged cascade into ${existing.id} (L=${existing.L_now.toFixed(0)}, ratio=${existing.ratio.toFixed(1)}x, merges=${existing.mergeCount})`
        );
        return; // Do NOT create a new signal
      }
    }

    // ── 3. Limit check: evict oldest if exceeded ───────────
    const maxActive = config.REACTION_MAX_ACTIVE_SIGNALS || 3;
    while (signals.length >= maxActive) {
      const oldest = signals.shift();
      this._clearTimers(oldest);
      logger.info(`Reaction: evicted oldest signal ${oldest.id} (limit=${maxActive})`);
    }

    // ── 4. Create new signal state ─────────────────────────
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
      oi_60s: null,
      timers: { t5: null, t15: null, t60: null, cleanup: null },
      merged: false,
      mergeCount: 0,
    };

    signals.push(state);
    logger.info(`Reaction: started tracking ${id} (L=${L_now.toFixed(0)}, ratio=${ratio.toFixed(1)}x)`);

    // ── 5. Init: fetch price_0 + oi_0, then schedule timers ─
    this._initTracking(state);
  }

  /**
   * Fetch initial price & OI, then schedule 5s/15s/60s/90s timers.
   * @param {SignalState} state
   */
  async _initTracking(state) {
    const snap = priceStreamService.getClosestSnapshot(state.symbol, Date.now());
    if (!snap) {
      logger.error(`Reaction ${state.id}: no price data in buffer — aborting tracking`);
      this._removeSignal(state);
      return;
    }

    state.price_0 = snap.price;
    state.oi_0 = snap.openInterest;
    logger.debug(`Reaction ${state.id}: price_0=${state.price_0}, oi_0=${state.oi_0}`);

    // Schedule captures
    state.timers.t5 = setTimeout(() => this._capture5s(state), 5_000);
    state.timers.t15 = setTimeout(() => this._capture15s(state), 15_000);
    state.timers.t60 = setTimeout(() => this._capture60s(state), 60_000);
    state.timers.cleanup = setTimeout(() => this._cleanup(state), 90_000);
  }

  /**
   * +5s: capture price_5s.
   * @param {SignalState} state
   */
  async _capture5s(state) {
    const targetTime = state.startTime + 5_000;
    const snap = priceStreamService.getClosestSnapshot(state.symbol, targetTime);
    state.price_5s = snap?.price ?? state.price_0;
    logger.debug(`Reaction ${state.id}: price_5s=${state.price_5s}`);
  }

  /**
   * +15s: capture price_15s.
   * @param {SignalState} state
   */
  async _capture15s(state) {
    const targetTime = state.startTime + 15_000;
    const snap = priceStreamService.getClosestSnapshot(state.symbol, targetTime);
    state.price_15s = snap?.price ?? state.price_5s ?? state.price_0;
    logger.debug(`Reaction ${state.id}: price_15s=${state.price_15s}`);
  }

  /**
   * +60s: capture price_60s and oi_60s, then finalize classification.
   * @param {SignalState} state
   */
  async _capture60s(state) {
    const targetTime = state.startTime + 60_000;
    const snap = priceStreamService.getClosestSnapshot(state.symbol, targetTime);
    state.price_60s = snap?.price ?? state.price_15s ?? state.price_0;
    state.oi_60s = snap?.openInterest ?? state.oi_0;
    logger.debug(`Reaction ${state.id}: price_60s=${state.price_60s}, oi_60s=${state.oi_60s}`);

    // Classify and emit
    this._finalize(state);
  }

  /**
   * Compute deltas, classify, build reaction result, notify listeners.
   * @param {SignalState} state
   */
  _finalize(state) {
    const p0 = state.price_0 || 0;
    const p5 = state.price_5s ?? p0;
    const p15 = state.price_15s ?? p5;
    const p60 = state.price_60s ?? p15;
    const oi0 = state.oi_0 || 0;
    const oi60 = state.oi_60s ?? oi0;

    // ── Compute deltas (in %) ──────────────────────────────
    const dp5 = p0 > 0 ? ((p5 - p0) / p0) * 100 : 0;
    const dp15 = p5 > 0 ? ((p15 - p5) / p5) * 100 : 0;
    const dp60 = p15 > 0 ? ((p60 - p15) / p15) * 100 : 0;
    const dOI = oi0 > 0 ? ((oi60 - oi0) / oi0) * 100 : 0;

    // ── Classify ───────────────────────────────────────────
    const classification = this._classify(dp5, dp15, dp60);

    // ── OI interpretation ──────────────────────────────────
    let oiLabel;
    if (dOI > 0.5) {
      oiLabel = '🟢 OI: new positions entering';
    } else if (dOI < -0.5) {
      oiLabel = '🔴 OI: positions closing';
    } else {
      oiLabel = '⚪ OI: unchanged';
    }

    // ── Market context (price ranges from ticker buffer) ──
    const now = Date.now();
    const range5m = priceStreamService.getRange(state.symbol, config.CONTEXT_SHORT_RANGE_MS, now);
    const range30m = priceStreamService.getRange(state.symbol, config.CONTEXT_MID_RANGE_MS, now);

    let position_5m = null;
    let position_30m = null;
    let lowData5m = false;
    let lowData30m = false;
    let contextLabel = '';

    if (range5m && range5m.high !== range5m.low) {
      position_5m = (p60 - range5m.low) / (range5m.high - range5m.low);
      lowData5m = range5m.coverage < config.CONTEXT_MIN_COVERAGE;
    }
    if (range30m && range30m.high !== range30m.low) {
      position_30m = (p60 - range30m.low) / (range30m.high - range30m.low);
      lowData30m = range30m.coverage < config.CONTEXT_MIN_COVERAGE;
    }

    if (position_5m !== null && position_30m !== null) {
      contextLabel = this._buildContextLabel(position_5m, position_30m, lowData5m, lowData30m);
    }

    /** @type {ReactionResult} */
    const reaction = {
      symbol: state.symbol,
      side: state.side,
      ratio: state.ratio,
      startTime: state.startTime,
      dp5,
      dp15,
      dp60,
      dOI,
      oiLabel,
      classification,
      merged: state.merged,
      mergeCount: state.mergeCount,
      position_5m,
      position_30m,
      lowData5m,
      lowData30m,
      contextLabel,
    };

    logger.info(
      `Reaction ${state.id}: ${classification} | ΔP5=${dp5.toFixed(2)}% ΔP15=${dp15.toFixed(2)}% ΔP60=${dp60.toFixed(2)}% ΔOI=${dOI.toFixed(2)}%`
    );

    // ── Notify listeners ───────────────────────────────────
    for (const cb of this.reactionCallbacks) {
      try {
        cb(reaction);
      } catch (error) {
        logger.error('Error in reaction callback', { error });
      }
    }
  }

  /**
   * Classify the post-signal price reaction.
   * @param {number} dp5  - ΔP5 in %
   * @param {number} dp15 - ΔP15 in %
   * @param {number} dp60 - ΔP60 in %
   * @returns {'STRONG_CONTINUATION'|'REVERSAL'|'ABSORPTION'|'IGNORE'}
   */
  _classify(dp5, dp15, dp60) {
    const strong = config.REACTION_DP5_STRONG;
    const cont15 = config.REACTION_DP15_CONTINUATION;
    const rev15 = config.REACTION_DP15_REVERSAL;
    const cont60 = config.REACTION_DP60_CONTINUATION;
    const rev60 = config.REACTION_DP60_REVERSAL;
    const absorbMax = config.REACTION_ABSORPTION_MAX;

    // STRONG_CONTINUATION
    if (dp5 >= strong && dp15 >= cont15 && dp60 >= cont60) {
      return 'STRONG_CONTINUATION';
    }

    // REVERSAL
    if (dp5 >= strong && dp15 <= rev15 && dp60 <= rev60) {
      return 'REVERSAL';
    }

    // ABSORPTION
    if (dp5 >= strong && Math.abs(dp15) < absorbMax && Math.abs(dp60) < absorbMax) {
      return 'ABSORPTION';
    }

    // IGNORE
    return 'IGNORE';
  }

  /**
   * Build multi-timeframe context interpretation label.
   *
   * CASE 1 — Alignment: both TFs near same extreme → "Strong resistance/support"
   * CASE 2 — Local only: 5m extreme, 30m mid-range → "Local high/low, no HTF"
   * CASE 3 — Conflict: one near high, other near low → "Range expansion / conflicting"
   *
   * @param {number} pos5  - Position in 5m range (0..1)
   * @param {number} pos30 - Position in 30m range (0..1)
   * @param {boolean} lowData5  - 5m coverage < threshold
   * @param {boolean} lowData30 - 30m coverage < threshold
   * @returns {string}
   */
  _buildContextLabel(pos5, pos30, lowData5, lowData30) {
    const nearHigh5 = pos5 > 0.8;
    const nearLow5 = pos5 < 0.2;
    const nearHigh30 = pos30 > 0.8;
    const nearLow30 = pos30 < 0.2;

    let label = '';

    // CASE 1: Alignment — strong multi-TF context
    if (nearHigh5 && nearHigh30) {
      label = '→ Strong resistance (multi-timeframe)';
    } else if (nearLow5 && nearLow30) {
      label = '→ Strong support (multi-timeframe)';

    // CASE 2: Local extreme only (5m extreme, 30m mid-range)
    } else if (nearHigh5 && pos30 >= 0.3 && pos30 <= 0.7) {
      label = '→ Local high (5m), no HTF resistance';
    } else if (nearLow5 && pos30 >= 0.3 && pos30 <= 0.7) {
      label = '→ Local low (5m), no HTF support';

    // CASE 3: Conflict — divergent extremes
    } else if ((nearHigh5 && nearLow30) || (nearLow5 && nearHigh30)) {
      label = '→ Range expansion / conflicting signals';

    // Partial: single-TF near extreme
    } else if (nearHigh5) {
      label = '→ Near resistance (5m)';
    } else if (nearLow5) {
      label = '→ Near support (5m)';
    } else if (nearHigh30) {
      label = '→ Near resistance (30m)';
    } else if (nearLow30) {
      label = '→ Near support (30m)';
    }

    // Low data warning
    if (lowData5 || lowData30) {
      label += ' | ⚠ low context reliability';
    }

    return label;
  }

  /**
   * Build human-readable type label for a reaction.
   * LONG liquidation → "LONG SQUEEZE" (shorts got liquidated → price rises)
   * SHORT liquidation → "SHORT LIQUIDATION CASCADE" (longs got liquidated → price drops)
   * @param {'long'|'short'} side
   * @returns {string}
   */
  _typeLabel(side) {
    return side === 'long' ? 'LONG SQUEEZE 🟢' : 'SHORT LIQUIDATION CASCADE 🔴';
  }

  /**
   * Format a reaction result into a human-readable message.
   * @param {ReactionResult} reaction
   * @returns {string}
   */
  formatReaction(reaction) {
    const typeLabel = this._typeLabel(reaction.side);
    const mergeNote = reaction.merged ? ` (merged x${reaction.mergeCount})` : '';

    // Market context lines
    const contextLines = [];
    if (reaction.position_5m !== null) {
      contextLines.push('');
      contextLines.push(`Position 5m: ${reaction.position_5m.toFixed(2)}`);
    }
    if (reaction.position_30m !== null) {
      contextLines.push(`Position 30m: ${reaction.position_30m.toFixed(2)}`);
    }
    if (reaction.contextLabel) {
      contextLines.push(reaction.contextLabel);
    }

    return [
      `📊 ${reaction.symbol} ${typeLabel} (${reaction.ratio.toFixed(1)}x)${mergeNote}`,
      ``,
      `Δ5s:  ${this._fmtPct(reaction.dp5)}`,
      `Δ15s: ${this._fmtPct(reaction.dp15)}`,
      `Δ60s: ${this._fmtPct(reaction.dp60)}`,
      `ΔOI:  ${this._fmtPct(reaction.dOI)}`,
      ...contextLines,
      ``,
      `→ ${reaction.classification}`,
      `${reaction.oiLabel}`,
    ].join('\n');
  }

  /**
   * Format a percentage value with sign.
   * @param {number} value
   * @returns {string}
   */
  _fmtPct(value) {
    const sign = value >= 0 ? '+' : '';
    return `${sign}${value.toFixed(2)}%`;
  }

  /**
   * Remove a signal and clear its timers.
   * @param {SignalState} state
   */
  _removeSignal(state) {
    const sideMap = this.activeSignals.get(state.symbol);
    if (!sideMap) return;

    const signals = sideMap.get(state.side);
    if (!signals) return;

    const idx = signals.indexOf(state);
    if (idx !== -1) {
      signals.splice(idx, 1);
    }

    this._clearTimers(state);

    // Clean up empty buckets
    if (signals.length === 0) {
      sideMap.delete(state.side);
    }
    if (sideMap.size === 0) {
      this.activeSignals.delete(state.symbol);
    }
  }

  /**
   * Cleanup: remove signal after 90s.
   * @param {SignalState} state
   */
  _cleanup(state) {
    logger.debug(`Reaction: cleanup ${state.id}`);
    this._removeSignal(state);
  }

  /**
   * Clear all pending timers for a signal state.
   * @param {SignalState} state
   */
  _clearTimers(state) {
    for (const key of Object.keys(state.timers)) {
      if (state.timers[key]) {
        clearTimeout(state.timers[key]);
        state.timers[key] = null;
      }
    }
  }

  /**
   * Register a callback for reaction results.
   * @param {(reaction: ReactionResult) => void} callback
   */
  onReaction(callback) {
    this.reactionCallbacks.push(callback);
  }

  /**
   * Graceful shutdown: clear all pending timers and state.
   */
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

  /**
   * Get count of currently tracked signals.
   * @returns {number}
   */
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
 * @property {number|null} oi_60s
 * @property {{ t5: NodeJS.Timeout|null, t15: NodeJS.Timeout|null, t60: NodeJS.Timeout|null, cleanup: NodeJS.Timeout|null }} timers
 * @property {boolean} merged
 * @property {number} mergeCount
 */

/**
 * @typedef {object} ReactionResult
 * @property {string} symbol
 * @property {'long'|'short'} side
 * @property {number} ratio
 * @property {number} startTime
 * @property {number} dp5
 * @property {number} dp15
 * @property {number} dp60
 * @property {number} dOI
 * @property {string} oiLabel
 * @property {'STRONG_CONTINUATION'|'REVERSAL'|'ABSORPTION'|'IGNORE'} classification
 * @property {boolean} merged
 * @property {number} mergeCount
 */

// Singleton
const reactionTracker = new SignalReactionTracker();
export default reactionTracker;