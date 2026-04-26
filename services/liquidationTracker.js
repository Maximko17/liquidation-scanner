import config, { getThresholdConfig } from '../config/index.js';
import median from '../utils/median.js';
import logger from '../utils/logger.js';

/**
 * Liquidation Tracking Engine
 *
 * Per-symbol data structures:
 *   buffer:  { long: Event[], short: Event[] }        — last BUFFER_DURATION_MS of events
 *   history: { long: HistoryEntry[], short: [...] }    — last HISTORY_DURATION_MS of L_now values
 *   prevL:   { long: number, short: number }           — previous tick's L_now (used for threshold crossing)
 *   alertArmed: { long: boolean, short: boolean }     — if false and threshold was crossed up → fire alert
 *
 * Every tick (WINDOW_TICK_MS):
 *   1. For each symbol, sum sizes where now - time ≤ WINDOW_SIZE_MS  → L_long_now, L_short_now
 *   2. Clean old events from buffer
 *   3. Store L_now values in history (with timestamp)
 *   4. Clean old history entries
 *   5. Compute baseline = max(median(history), MIN_BASELINE)
 *   6. threshold = baseline * RATIO
 *   7. Check crossing: L_now > ABS_THRESHOLD && L_now ≥ threshold && prevL < threshold → ALERT
 *   8. If L_now < threshold → reset check (allow future alerts)
 *   9. prevL = L_now
 */
class LiquidationTracker {
  constructor() {
    /** @type {Map<string, SymbolData>} */
    this.symbols = new Map();
    this.alertCallbacks = [];
    this.tickInterval = null;
  }

  /**
   * Initialize a symbol's data structures if not already tracked.
   * @param {string} symbol
   */
  _ensureSymbol(symbol) {
    if (!this.symbols.has(symbol)) {
      this.symbols.set(symbol, {
        buffer: { long: [], short: [] },
        history: { long: [], short: [] },
        prevL: { long: 0, short: 0 },
        alertArmed: { long: true, short: true },
      });
    }
  }

  /**
   * Ingest a normalized liquidation event.
   * @param {{ symbol: string, side: 'long'|'short', size: number, time: number }} event
   */
  handleEvent(event) {
    const { symbol, side, size, time } = event;

    if (!symbol || !side || size <= 0) {
      return;
    }

    this._ensureSymbol(symbol);

    const data = this.symbols.get(symbol);
    data.buffer[side].push({ size, time });

    logger.debug(`Tracker: ${symbol} ${side} +${size} (buffer: ${data.buffer[side].length})`);
  }

  /**
   * Start the periodic tick that runs the sliding window + signal logic.
   */
  start() {
    if (this.tickInterval) {
      return; // Already running
    }

    logger.info(`Starting liquidation tracker tick every ${config.WINDOW_TICK_MS}ms`);
    this.tickInterval = setInterval(() => this._tick(), config.WINDOW_TICK_MS);
  }

  /**
   * Stop the tick interval.
   */
  stop() {
    if (this.tickInterval) {
      clearInterval(this.tickInterval);
      this.tickInterval = null;
      logger.info('Liquidation tracker stopped');
    }
  }

  /**
   * Core logic — runs every WINDOW_TICK_MS.
   */
  _tick() {
    const now = Date.now();

    for (const [symbol, data] of this.symbols) {
      const thresholds = getThresholdConfig(symbol);

      // Process both long and short sides independently
      for (const side of ['long', 'short']) {
        this._processSide(symbol, side, data, thresholds, now);
      }
    }
  }

  /**
   * Process one side (long or short) for a given symbol.
   * @param {string} symbol
   * @param {'long'|'short'} side
   * @param {SymbolData} data
   * @param {{ minBaseline: number, absThreshold: number, ratio: number }} thresholds
   * @param {number} now - Current timestamp ms
   */
  _processSide(symbol, side, data, thresholds, now) {
    const events = data.buffer[side];
    const history = data.history[side];

    // 1. Sliding window: sum sizes where now - time <= WINDOW_SIZE_MS
    const windowCutoff = now - config.WINDOW_SIZE_MS;
    let L_now = 0;

    for (const evt of events) {
      if (now - evt.time <= config.WINDOW_SIZE_MS) {
        L_now += evt.size;
      }
    }

    // 2. Clean buffer: remove events older than BUFFER_DURATION_MS
    const bufferCutoff = now - config.BUFFER_DURATION_MS;
    data.buffer[side] = events.filter((evt) => evt.time > bufferCutoff);

    // 3. Store L_now in history (always, even if 0)
    history.push({ value: L_now, timestamp: now });

    // 4. Clean history: remove entries older than HISTORY_DURATION_MS
    const historyCutoff = now - config.HISTORY_DURATION_MS;
    while (history.length > 0 && history[0].timestamp < historyCutoff) {
      history.shift();
    }

    // Cap history to a reasonable size to prevent unbounded growth
    const maxHistory = Math.ceil(config.HISTORY_DURATION_MS / config.WINDOW_TICK_MS) + 100;
    while (history.length > maxHistory) {
      history.shift();
    }

    // 5. Compute baseline = max(median(history_values), MIN_BASELINE)
    const historyValues = history.map((h) => h.value);
    const baselineRaw = median(historyValues);
    const baseline = Math.max(baselineRaw, thresholds.minBaseline);

    // 6. Compute threshold
    const threshold = baseline * thresholds.ratio;

    // 7. Check threshold crossing (duplicate prevention)
    const prevL = data.prevL[side];
    const absOk = L_now > thresholds.absThreshold;
    const ratioOk = L_now >= threshold;
    const crossingUp = prevL < threshold;

    if (absOk && ratioOk && crossingUp && data.alertArmed[side]) {
      // FIRE ALERT
      data.alertArmed[side] = false; // Prevent duplicates while above threshold

      const ratio = baseline > 0 ? L_now / baseline : Infinity;

      const alert = {
        symbol,
        side,
        L_now,
        baseline,
        ratio,
        threshold,
        absThreshold: thresholds.absThreshold,
        timestamp: now,
      };

      logger.info(
        `🚨 ALERT: ${symbol} ${side.toUpperCase()} L=${L_now.toFixed(0)} baseline=${baseline.toFixed(0)} ratio=${ratio.toFixed(1)}x`
      );

      for (const cb of this.alertCallbacks) {
        try {
          cb(alert);
        } catch (error) {
          logger.error('Error in alert callback', { error });
        }
      }
    }

    // 8. Reset: if value drops below threshold, re-arm alerts
    if (L_now < threshold) {
      data.alertArmed[side] = true;
    }

    // 9. Store previous L_now for next tick
    data.prevL[side] = L_now;
  }

  /**
   * Register a callback for alerts.
   * @param {(alert: LiquidationAlert) => void} callback
   */
  onAlert(callback) {
    this.alertCallbacks.push(callback);
  }

  /**
   * Get snapshot of current state for a symbol (useful for debugging/status).
   * @param {string} symbol
   * @returns {object|null}
   */
  getSymbolState(symbol) {
    const data = this.symbols.get(symbol);
    if (!data) return null;

    const now = Date.now();
    const state = {};

    for (const side of ['long', 'short']) {
      const L_now = data.buffer[side]
        .filter((evt) => now - evt.time <= config.WINDOW_SIZE_MS)
        .reduce((sum, evt) => sum + evt.size, 0);

      const historyValues = data.history[side].map((h) => h.value);
      const baselineRaw = median(historyValues);
      const thresholds = getThresholdConfig(symbol);
      const baseline = Math.max(baselineRaw, thresholds.minBaseline);

      state[side] = {
        L_now,
        baseline,
        bufferCount: data.buffer[side].length,
        historyCount: data.history[side].length,
        alertArmed: data.alertArmed[side],
        prevL: data.prevL[side],
      };
    }

    return state;
  }

  /**
   * Get count of currently tracked symbols.
   * @returns {number}
   */
  getTrackedSymbolCount() {
    return this.symbols.size;
  }
}

// ── Type definitions (JSDoc) ───────────────────────────────

/**
 * @typedef {object} LiquidationEvent
 * @property {string} symbol
 * @property {'long'|'short'} side
 * @property {number} size
 * @property {number} time
 */

/**
 * @typedef {object} HistoryEntry
 * @property {number} value
 * @property {number} timestamp
 */

/**
 * @typedef {object} SymbolData
 * @property {{ long: LiquidationEvent[], short: LiquidationEvent[] }} buffer
 * @property {{ long: HistoryEntry[], short: HistoryEntry[] }} history
 * @property {{ long: number, short: number }} prevL
 * @property {{ long: boolean, short: boolean }} alertArmed
 */

/**
 * @typedef {object} LiquidationAlert
 * @property {string} symbol
 * @property {'long'|'short'} side
 * @property {number} L_now
 * @property {number} baseline
 * @property {number} ratio
 * @property {number} threshold
 * @property {number} absThreshold
 * @property {number} timestamp
 */

// Singleton
const tracker = new LiquidationTracker();
export default tracker;