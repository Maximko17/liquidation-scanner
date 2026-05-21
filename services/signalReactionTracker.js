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
 *   3. Tracks impulse retention: extreme price (highest/lowest) via live WS
 *   4. Computes ΔP (price deltas), ΔOI (open interest delta), retention metrics
 *   5. Analyzes market structure acceptance (post-impulse price zone)
 *   6. Classifies the signal: STRONG_CONTINUATION | REVERSAL | ABSORPTION | NO_FOLLOW_THROUGH
 *   7. Sends a secondary alert with the reaction analysis
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

    // Listen to live WebSocket price updates for impulse retention
    priceStreamService.onPriceUpdate((symbol, price) => this._onPriceTick(symbol, price));
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
      extremePriceSeen: null,
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
    state.extremePriceSeen = snap.price;
    logger.debug(`Reaction ${state.id}: price_0=${state.price_0}, oi_0=${state.oi_0}`);

    // Schedule captures
    state.timers.t5 = setTimeout(() => this._capture5s(state), 5_000);
    state.timers.t15 = setTimeout(() => this._capture15s(state), 15_000);
    state.timers.t60 = setTimeout(() => this._capture60s(state), 60_000);
    state.timers.cleanup = setTimeout(() => this._cleanup(state), 90_000);
  }

  /**
   * Event-driven impulse tracking — called on every WebSocket ticker update.
   * Updates the most favorable price seen during the 60s reaction window.
   * @param {string} symbol
   * @param {number} price
   */
  _onPriceTick(symbol, price) {
    const sideMap = this.activeSignals.get(symbol);
    if (!sideMap) return;

    for (const [, signals] of sideMap) {
      for (const state of signals) {
        if (state.extremePriceSeen === null) continue;

        if (state.side === 'short') {
          // Short liquidation → price squeezes UP → track highest
          if (price > state.extremePriceSeen) {
            state.extremePriceSeen = price;
          }
        } else {
          // Long liquidation → price cascades DOWN → track lowest
          if (price < state.extremePriceSeen) {
            state.extremePriceSeen = price;
          }
        }
      }
    }
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
    state.oi_60s = snap?.openInterest || state.oi_0;
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
    const extreme = state.extremePriceSeen ?? p0;

    // ── Compute deltas (in %) ──────────────────────────────
    const dp5 = p0 > 0 ? ((p5 - p0) / p0) * 100 : 0;
    const dp15 = p5 > 0 ? ((p15 - p5) / p5) * 100 : 0;
    const dp60 = p15 > 0 ? ((p60 - p15) / p15) * 100 : 0;
    const dOI = oi0 > 0 ? ((oi60 - oi0) / oi0) * 100 : 0;

    // ── Impulse retention ──────────────────────────────────
    // maxMove = maximum favorable impulse magnitude (always positive %)
    const maxMove = state.side === 'short'
      ? ((extreme - p0) / p0) * 100        // highest price → positive
      : ((p0 - extreme) / p0) * 100;        // lowest price → positive (invert)

    // finalMove = net result from p0 to p60 (signed %)
    const finalMove = ((p60 - p0) / p0) * 100;

    const meaningfulImpulse = Math.abs(maxMove) >= config.MIN_MEANINGFUL_IMPULSE;

    const absMax = Math.abs(maxMove);
    const absFinal = Math.abs(finalMove);
    const retentionRatio = meaningfulImpulse && absMax > 0 ? Math.min(absFinal / absMax, 1) : 0;
    const retentionPct = Math.round(retentionRatio * 100);
    const retentionLabel = meaningfulImpulse
      ? this._buildRetentionLabel(finalMove, maxMove, retentionRatio, state.side)
      : ['→ no meaningful follow-through', '→ liquidation caused minimal displacement', '→ market mostly ignored the event'];

    // ── Classify ───────────────────────────────────────────
    const classification = this._classify(dp5, dp15, dp60, state.side);

    // ── OI interpretation ──────────────────────────────────
    let oiLabel;
    if (dOI > 0.2) {
      oiLabel = `ΔOI: ${this._fmtPct(dOI)} 🟢 entering`;
    } else if (dOI < -0.2) {
      oiLabel = `ΔOI: ${this._fmtPct(dOI)} 🔴 closing`;
    } else {
      oiLabel = `ΔOI: ${this._fmtPct(dOI)} (unchanged)`;
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

    // ── Market structure acceptance ────────────────────────
    const structureAnalysis = this._analyzeStructureAcceptance(
      state.side, position_30m, retentionRatio, lowData30m, maxMove
    );

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
      oiLabel,
      classification,
      merged: state.merged,
      mergeCount: state.mergeCount,
      position_5m,
      position_30m,
      lowData5m,
      lowData30m,
      contextLabel,
      maxMove,
      finalMove,
      retentionRatio,
      retentionPct,
      retentionLabel,
      meaningfulImpulse,
      structureState: structureAnalysis.structureState,
      structureLabels: structureAnalysis.structureLabels,
      structureScoreAdjustment: structureAnalysis.structureScoreAdjustment,
    };

    // ── Confidence score ──────────────────────────────────
    const {
      score: confidenceScore, label: confidenceLabel,
      retentionAdjustment, structureAdjustment,
    } = scoreReaction(reaction);
    reaction.confidenceScore = confidenceScore;
    reaction.confidenceLabel = confidenceLabel;
    reaction.retentionAdjustment = retentionAdjustment;
    reaction.structureAdjustment = structureAdjustment;

    logger.info(
      `Reaction ${state.id}: ${classification} | ΔP5=${dp5.toFixed(2)}% ΔP15=${dp15.toFixed(2)}% ΔP60=${dp60.toFixed(2)}% ΔOI=${dOI.toFixed(2)}% | retention=${retentionRatio.toFixed(2)} | structure=${structureAnalysis.structureState}`
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
   * Side-aware: uses sign of dp5 to determine favorable direction,
   * then compares dp15/dp60 relative to it.
   *
   * @param {number} dp5  - ΔP5 in %
   * @param {number} dp15 - ΔP15 in %
   * @param {number} dp60 - ΔP60 in %
   * @param {'long'|'short'} side
   * @returns {'STRONG_CONTINUATION'|'REVERSAL'|'ABSORPTION'|'NO_FOLLOW_THROUGH'}
   */
  _classify(dp5, dp15, dp60, side) {
    const strong = config.REACTION_DP5_STRONG;
    const cont15 = config.REACTION_DP15_CONTINUATION;
    const rev15 = config.REACTION_DP15_REVERSAL;
    const cont60 = config.REACTION_DP60_CONTINUATION;
    const rev60 = config.REACTION_DP60_REVERSAL;
    const absorbMax = config.REACTION_ABSORPTION_MAX;

    // Gate: was the initial 5s move strong enough in either direction?
    if (Math.abs(dp5) < strong) {
      return 'NO_FOLLOW_THROUGH';
    }

    // Favorable direction: SHORT → UP (+1), LONG → DOWN (−1)
    const favDir = side === 'short' ? 1 : -1;

    // dp15 and dp60 projected onto favorable direction
    const p15 = dp15 * favDir;
    const p60 = dp60 * favDir;

    // Is price continuing in the favorable direction?
    const dp15Continues = p15 >= cont15 && p15 >= 0;
    const dp60Continues = p60 >= cont60 && p60 >= 0;

    // Is price reversing (going opposite to favorable direction)?
    const dp15Reverses = p15 <= rev15 && p15 <= 0;
    const dp60Reverses = p60 <= rev60 && p60 <= 0;

    // Is price flat after initial impulse?
    const dp15Flat = Math.abs(dp15) < absorbMax;
    const dp60Flat = Math.abs(dp60) < absorbMax;

    if (dp15Continues && dp60Continues) {
      return 'STRONG_CONTINUATION';
    }

    if (dp15Reverses && dp60Reverses) {
      return 'REVERSAL';
    }

    if (dp15Flat && dp60Flat) {
      return 'ABSORPTION';
    }

    return 'NO_FOLLOW_THROUGH';
  }

  /**
   * Analyze whether the market structurally accepted the new price zone
   * after the liquidation impulse.
   *
   * Gated by MIN_IMPULSE_FOR_STRUCTURE — tiny moves skip structure analysis.
   *
   * @param {'long'|'short'} side
   * @param {number|null} position30m - Position in 30m range (0..1)
   * @param {number} retentionRatio - Clamped 0..1
   * @param {boolean} lowData30m - Whether 30m coverage is below threshold
   * @param {number} maxMove - Maximum favorable impulse magnitude (positive %)
   * @returns {{ structureState: string, structureScoreAdjustment: number, structureLabels: string[] }}
   */
  _analyzeStructureAcceptance(side, position30m, retentionRatio, lowData30m, maxMove) {
    // No context data available
    if (position30m === null) {
      return { structureState: 'no_context', structureScoreAdjustment: 0, structureLabels: [] };
    }

    // Impulse too small for meaningful structure analysis
    if (Math.abs(maxMove) < config.MIN_IMPULSE_FOR_STRUCTURE) {
      return { structureState: 'insufficient_impulse', structureScoreAdjustment: 0, structureLabels: [] };
    }

    /** @type {string} */
    let structureState;
    /** @type {number} */
    let structureScoreAdjustment;
    /** @type {string[]} */
    let structureLabels;

    if (side === 'short') {
      // SHORT liquidation → bullish squeeze → look for acceptance near highs
      if (position30m >= 0.8 && retentionRatio >= 0.7) {
        structureState = 'breakout_accepted';
        structureScoreAdjustment = +1;
        structureLabels = [
          '→ breakout accepted',
          '→ price holding near range highs',
          '→ bullish continuation more likely',
        ];
      } else if (position30m >= 0.4) {
        structureState = 'partial_acceptance';
        structureScoreAdjustment = 0;
        structureLabels = [
          '→ partial breakout',
          '→ mixed continuation quality',
        ];
      } else {
        structureState = 'failed_breakout';
        structureScoreAdjustment = -1;
        structureLabels = [
          '→ breakout failed',
          '→ price returned into prior range',
          '→ squeeze probably rejected',
        ];
      }
    } else {
      // LONG liquidation → bearish cascade → look for acceptance near lows
      if (position30m <= 0.2 && retentionRatio >= 0.7) {
        structureState = 'breakdown_accepted';
        structureScoreAdjustment = +1;
        structureLabels = [
          '→ breakdown accepted',
          '→ price holding near range lows',
          '→ bearish continuation more likely',
        ];
      } else if (position30m <= 0.6) {
        structureState = 'partial_acceptance';
        structureScoreAdjustment = 0;
        structureLabels = [
          '→ partial breakdown',
          '→ mixed continuation quality',
        ];
      } else {
        structureState = 'failed_breakdown';
        structureScoreAdjustment = -1;
        structureLabels = [
          '→ breakdown failed',
          '→ price recovered back into range',
          '→ cascade probably rejected',
        ];
      }
    }

    if (lowData30m) {
      structureLabels.push(' ⚠ low context reliability');
    }

    return { structureState, structureScoreAdjustment, structureLabels };
  }

  /**
   * Build human-readable impulse retention interpretation.
   * @param {number} finalMove - Net % move from p0 to p60
   * @param {number} maxMove - Maximum favorable impulse magnitude (positive %)
   * @param {number} retentionRatio - Clamped 0..1 ratio
   * @param {'long'|'short'} side
   * @returns {string[]}
   */
  _buildRetentionLabel(finalMove, maxMove, retentionRatio, side) {
    // FULL REVERSAL — price went opposite direction of max impulse
    if (side === 'short' && finalMove < 0) {
      return ['→ market fully rejected move', '→ high reversal probability'];
    }
    if (side === 'long' && finalMove > 0) {
      return ['→ market fully rejected move', '→ high reversal probability'];
    }

    // Normal retention interpretation
    if (retentionRatio >= 0.7) {
      return ['→ market accepted impulse', '→ continuation more likely'];
    }
    if (retentionRatio >= 0.3) {
      return ['→ impulse weakening', '→ mixed continuation'];
    }
    return ['→ impulse mostly rejected', '→ likely liquidity sweep'];
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
   * side='short' — shorts liquidated → price squeezes UP
   * side='long'  — longs liquidated → price cascades DOWN
   * @param {'long'|'short'} side — the liquidated side
   * @returns {string}
   */
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

    // Classification human-readable block
    const classificationBlock = this._classificationBlock(reaction.classification);

    // Unified Market Acceptance block (retention + structure merged)
    const marketAcceptanceBlock = this._buildMarketAcceptanceBlock(reaction);

    // Confidence line
    const confidenceLine = reaction.confidenceScore !== undefined
      ? `\nConfidence: ${reaction.confidenceScore}/10 (${reaction.confidenceLabel})`
      : '';

    // Retention impact line
    const retentionImpactLine = reaction.retentionAdjustment !== undefined && reaction.retentionAdjustment !== 0
      ? `Retention impact: ${reaction.retentionAdjustment >= 0 ? '+' : ''}${reaction.retentionAdjustment} (${reaction.retentionAdjustment > 0 ? 'market accepted impulse' : reaction.retentionAdjustment === -2 ? 'full rejection detected' : 'impulse weakened'})`
      : '';

    // Structure impact line
    const structureImpactLine = reaction.structureAdjustment !== undefined && reaction.structureAdjustment !== 0
      ? `Structure impact: ${reaction.structureAdjustment >= 0 ? '+' : ''}${reaction.structureAdjustment} (${reaction.structureAdjustment > 0 ? 'price holding near extremes' : 'failed to hold new price zone'})`
      : '';

    return [
      `📊 ${reaction.symbol} ${typeLabel} (${reaction.ratio.toFixed(1)}x)${mergeNote}`,
      ``,
      `Δ5s:  ${this._fmtPct(reaction.dp5)}`,
      `Δ15s: ${this._fmtPct(reaction.dp15)}`,
      `Δ60s: ${this._fmtPct(reaction.dp60)}`,
      reaction.oiLabel,
      ...contextLines,
      ...marketAcceptanceBlock,
      ``,
      ...classificationBlock,
      confidenceLine,
      retentionImpactLine,
      structureImpactLine,
    ].filter(Boolean).join('\n');
  }

  /**
   * Build unified 🎯 Market Acceptance block combining retention + structure analysis.
   * @param {ReactionResult} reaction
   * @returns {string[]}
   */
  _buildMarketAcceptanceBlock(reaction) {
    if (reaction.maxMove === undefined) return [];

    const lines = [
      '',
      '🎯 Market Acceptance:',
      `• Max move: ${this._fmtPct(reaction.maxMove)}`,
      `• Final move: ${this._fmtPct(reaction.finalMove)}`,
      `• Impulse retained: ${reaction.retentionPct}%`,
    ];

    // Structure sub-section — only if impulse was meaningful and context exists
    if (
      reaction.structureState &&
      reaction.structureState !== 'insufficient_impulse' &&
      reaction.structureState !== 'no_context' &&
      reaction.position_30m !== null
    ) {
      lines.push(`• 30m Position: ${reaction.position_30m.toFixed(2)}`);
      lines.push('');
      lines.push(...reaction.structureLabels);
    } else {
      // No structure analysis: show retention-only labels
      lines.push('');
      lines.push(...reaction.retentionLabel);
    }

    return lines;
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
   * Build human-readable classification block (3 lines).
   * @param {'STRONG_CONTINUATION'|'REVERSAL'|'ABSORPTION'|'NO_FOLLOW_THROUGH'} classification
   * @returns {string[]}
   */
  _classificationBlock(classification) {
    switch (classification) {
      case 'STRONG_CONTINUATION':
        return [
          '→ STRONG CONTINUATION',
          '→ market continued liquidation direction',
          '→ momentum remains strong',
        ];
      case 'REVERSAL':
        return [
          '→ REVERSAL',
          '→ market rejected liquidation direction',
          '→ reversal pressure detected',
        ];
      case 'ABSORPTION':
        return [
          '→ ABSORPTION',
          '→ liquidation was absorbed by market',
          '→ low directional follow-through',
        ];
      default:
        return [
          '→ NO FOLLOW-THROUGH',
          '→ liquidation had weak market impact',
          '→ momentum faded quickly',
        ];
    }
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
 * @property {number|null} extremePriceSeen
 * @property {{ t5: NodeJS.Timeout|null, t15: NodeJS.Timeout|null, t60: NodeJS.Timeout|null, cleanup: NodeJS.Timeout|null }} timers
 * @property {boolean} merged
 * @property {number} mergeCount
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
 * @property {string} oiLabel
 * @property {'STRONG_CONTINUATION'|'REVERSAL'|'ABSORPTION'|'NO_FOLLOW_THROUGH'} classification
 * @property {boolean} merged
 * @property {number} mergeCount
 * @property {number|null} position_5m
 * @property {number|null} position_30m
 * @property {boolean} lowData5m
 * @property {boolean} lowData30m
 * @property {string} contextLabel
 * @property {number} maxMove
 * @property {number} finalMove
 * @property {number} retentionRatio
 * @property {number} retentionPct
 * @property {string[]} retentionLabel
 * @property {boolean} meaningfulImpulse
 * @property {number} [confidenceScore]
 * @property {string} [confidenceLabel]
 * @property {number} [retentionAdjustment]
 * @property {string} structureState
 * @property {string[]} structureLabels
 * @property {number} structureScoreAdjustment
 * @property {number} [structureAdjustment]
 */

// Singleton
const reactionTracker = new SignalReactionTracker();
export default reactionTracker;