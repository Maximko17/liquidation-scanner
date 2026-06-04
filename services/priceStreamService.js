import WebSocket from 'ws';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Price Stream Service
 *
 * Maintains a real-time price buffer per symbol using a dedicated
 * WebSocket connection subscribed to Bybit v5 tickers.{symbol} topics.
 *
 * Key properties:
 *   - Throttled writes: max 1 entry/symbol/second
 *   - O(1) amortized cleanup via while+shift (no filter/map/find)
 *   - Plain for-loop search with early exit in getClosestSnapshot
 *
 * Replaces REST-based price fetching in signalReactionTracker.
 */
class PriceStreamService {
  constructor() {
    this.ws = null;
    this.url = config.PRICE_WS_URL;

    /** @type {Map<string, Array<{ price: number, oi: number, time: number }>>} */
    this.priceBuffer = new Map();

    /** @type {Map<string, number>} symbol → last write timestamp (ms) */
    this.lastWrite = new Map();

    /** @type {Map<string, number>} symbol → last known open interest value */
    this.lastKnownOI = new Map();

    /** @type {Set<string>} */
    this.subscribedSymbols = new Set();

    /** @type {Set<string>} */
    this.blacklist = new Set();

    /** @type {Set<string>|null} symbols awaiting subscribe response */
    this.currentBatchRequest = null;

    /** @type {Array<(symbol: string, price: number) => void>} */
    this.priceCallbacks = [];

    this._lastDataAt = 0; // TEMP DIAG: last ticker frame (ms)
    this._lastPongAt = 0; // TEMP DIAG: last Bybit {op:'pong'} (ms)

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.maxReconnectDelay = 30_000;
    this.shouldReconnect = true;
    this.isConnected = false;
    this.pingInterval = null;
    this._pendingResubscribe = null;
  }

  // ═══════════════════════════════════════════════════════════
  // Connection
  // ═══════════════════════════════════════════════════════════

  /**
   * Connect to Bybit WebSocket for price tickers.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      logger.info(`[priceStream] Connecting to ${this.url}`);

      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        logger.info('[priceStream] WebSocket connected');

        this._startPing();

        // Re-subscribe after reconnect
        if (this._pendingResubscribe && this._pendingResubscribe.length > 0) {
          const symbols = this._pendingResubscribe;
          this._pendingResubscribe = null;
          logger.info(`[priceStream] Re-subscribing to ${symbols.length} symbols`);
          this._sendSubscribe(symbols);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (error) {
          logger.error('[priceStream] Failed to parse message', { error });
        }
      });

      this.ws.on('pong', () => {
        logger.debug('[priceStream] pong');
      });

      this.ws.on('error', (error) => {
        this.isConnected = false;
        logger.error('[priceStream] WebSocket error', { error: error.message });
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this._stopPing();

        this._pendingResubscribe = Array.from(this.subscribedSymbols);
        this.subscribedSymbols.clear();

        logger.warn('[priceStream] WebSocket closed', { code, reason: reason?.toString() });
        this._handleReconnect();
      });
    });
  }

  _startPing() {
    this._stopPing();
    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        // Bybit v5 keepalive: application-level JSON ping (not a WS protocol ping frame).
        this.ws.send(JSON.stringify({ op: 'ping' }));
      }
    }, 20_000);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  _handleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[priceStream] Max reconnect attempts reached');
      this.shouldReconnect = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      config.WS_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    logger.info(`[priceStream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((err) => {
        logger.error('[priceStream] Reconnect failed', { error: err.message });
      });
    }, delay);
  }

  // ═══════════════════════════════════════════════════════════
  // Subscription
  // ═══════════════════════════════════════════════════════════

  /**
   * Subscribe to tickers.{symbol} for a batch of symbols.
   * @param {string[]} symbols
   */
  subscribeMany(symbols) {
    this._sendSubscribe(symbols);
  }

  /**
   * Unsubscribe from a batch of symbols.
   * Clears price buffer and lastWrite throttle for removed symbols.
   * @param {string[]} symbols
   */
  unsubscribeMany(symbols) {
    const toRemove = [];
    for (const s of symbols) {
      if (this.subscribedSymbols.has(s)) {
        toRemove.push(s);
      }
    }

    if (toRemove.length === 0) {
      logger.debug('[priceStream] No symbols to unsubscribe');
      return;
    }

    const topics = [];
    for (const s of toRemove) {
      topics.push(`tickers.${s}`);
    }
    const message = JSON.stringify({ op: 'unsubscribe', args: topics });

    logger.info(`[priceStream] Unsubscribing from ${toRemove.length} ticker(s)`);
    this._send(message);

    // Remove from tracking & clean up buffer to prevent memory leaks
    for (const s of toRemove) {
      this.subscribedSymbols.delete(s);
      this.priceBuffer.delete(s);
      this.lastWrite.delete(s);
      this.lastKnownOI.delete(s);
    }
  }

  /**
   * @param {string[]} symbols
   */
  _sendSubscribe(symbols) {
    const filtered = [];
    for (const s of symbols) {
      if (this.blacklist.has(s)) continue;
      if (this.subscribedSymbols.has(s)) continue;
      if (this.currentBatchRequest && this.currentBatchRequest.has(s)) continue;
      filtered.push(s);
    }

    if (filtered.length === 0) {
      logger.debug('[priceStream] No new symbols to subscribe');
      return;
    }

    this.currentBatchRequest = new Set(filtered);

    const topics = [];
    for (const s of filtered) {
      topics.push(`tickers.${s}`);
    }

    logger.info(`[priceStream] Subscribing to ${filtered.length} ticker(s)`);
    this._send(JSON.stringify({ op: 'subscribe', args: topics }));
  }

  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Message handling
  // ═══════════════════════════════════════════════════════════

  /**
   * Route incoming message.
   * @param {object} message
   */
  _handleMessage(message) {
    // Subscription response
    if (message.op === 'subscribe') {
      this._handleSubscribeResponse(message);
      return;
    }

    // TEMP DIAG: Bybit JSON keepalive reply — control-channel liveness.
    // Bybit v5 replies to {op:'ping'} with {op:'ping', ret_msg:'pong'} — pong is in ret_msg.
    if (message.ret_msg === 'pong' || message.op === 'pong') {
      this._lastPongAt = Date.now();
      return;
    }

    // Ticker data stream
    if (message.topic && message.topic.startsWith('tickers.')) {
      this._lastDataAt = Date.now(); // TEMP DIAG: data-channel liveness
      const symbol = message.topic.replace('tickers.', '');
      const tickerData = message.data;

      // Bybit sends partial ticker updates — only changed fields are present.
      // Missing openInterestValue means "unchanged", NOT zero/missing.
      if (tickerData && typeof tickerData.lastPrice !== 'undefined') {
        // Update OI only if field is actually present in this message
        if (tickerData.openInterestValue !== undefined) {
          this.lastKnownOI.set(symbol, parseFloat(tickerData.openInterestValue));
        }

        this._onTickerData(
          symbol,
          parseFloat(tickerData.lastPrice) || 0,
          this.lastKnownOI.get(symbol)
        );
      }
    }
  }

  /**
   * Handle subscribe confirmation.
   * @param {object} message
   */
  _handleSubscribeResponse(message) {
    if (!this.currentBatchRequest) return;

    const symbols = Array.from(this.currentBatchRequest);
    this.currentBatchRequest = null;

    if (message.success) {
      for (const s of symbols) {
        this.subscribedSymbols.add(s);
      }
      logger.info(`[priceStream] Batch subscription OK for ${symbols.length} symbol(s)`);
    } else {
      const match = message.ret_msg?.match(/topic:tickers\.([A-Z0-9]+)/);
      const failedSymbol = match ? match[1] : null;

      if (failedSymbol) {
        if (!this.blacklist.has(failedSymbol)) {
          this.blacklist.add(failedSymbol);
          logger.warn(`[priceStream] Blacklisted ${failedSymbol}: ${message.ret_msg}`);
        }
        const remaining = [];
        for (const s of symbols) {
          if (s !== failedSymbol) remaining.push(s);
        }
        if (remaining.length > 0) {
          this._sendSubscribe(remaining);
        }
      } else {
        logger.error('[priceStream] Batch subscription failed — retrying', { ret_msg: message.ret_msg });
        this._sendSubscribe(symbols);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Buffer management (no filter/map/find — only for/while)
  // ═══════════════════════════════════════════════════════════

  /**
   * Process incoming ticker data. Throttled to max 1 write/symbol/second.
   * @param {string} symbol
   * @param {number} price
   * @param {number} oi
   */
  _onTickerData(symbol, price, oi) {
    const now = Date.now();

    // Notify listeners on EVERY tick (before the throttle gate below).
    // Live MFE/MAE extreme tracking needs full tick resolution to catch sub-second
    // wicks. This is cheap — it only does a few comparisons for currently tracked
    // signals. Buffer writes stay throttled to 1 Hz (storage needs no sub-second).
    for (const cb of this.priceCallbacks) {
      try { cb(symbol, price); } catch { /* ignore */ }
    }

    const last = this.lastWrite.get(symbol) || 0;

    // Throttle: skip the BUFFER WRITE if written within PRICE_THROTTLE_MS
    if (now - last < config.PRICE_THROTTLE_MS) {
      return;
    }
    this.lastWrite.set(symbol, now);

    // Get or create buffer array
    let buffer = this.priceBuffer.get(symbol);
    if (!buffer) {
      buffer = [];
      this.priceBuffer.set(symbol, buffer);
    }

    // Push new entry — fallback to lastKnownOI if oi is undefined (partial update without OI field)
    const storedOI = oi !== undefined ? oi : (this.lastKnownOI.get(symbol) || 0);
    buffer.push({ price, oi: storedOI, time: now });

    // Clean old entries: while+shift — O(1) amortized
    this._cleanBuffer(symbol, now);
  }

  /**
   * Remove entries older than PRICE_BUFFER_MAX_AGE_MS.
   * Uses while+shift — no filter(), no map().
   * Buffer is chronologically ordered (push-only at tail).
   * @param {string} symbol
   * @param {number} now
   */
  _cleanBuffer(symbol, now) {
    const buffer = this.priceBuffer.get(symbol);
    if (!buffer || buffer.length === 0) return;

    const cutoff = now - config.PRICE_BUFFER_MAX_AGE_MS;

    while (buffer.length > 0 && buffer[0].time < cutoff) {
      buffer.shift();
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Public API
  // ═══════════════════════════════════════════════════════════

  /**
   * Compute high/low range for a symbol over a given time window.
   * Single for-loop — no filter/map chains, no allocations beyond primitives.
   *
   * @param {string} symbol
   * @param {number} durationMs - Window duration in ms (e.g. 300_000 for 5min)
   * @param {number} now - Current timestamp (Date.now())
   * @returns {{ high: number, low: number, coverage: number } | null}
   *   coverage = actual time span / durationMs (0..1). < 0.5 means low reliability.
   */
  getRange(symbol, durationMs, now) {
    const buffer = this.priceBuffer.get(symbol);
    if (!buffer || buffer.length === 0) return null;

    const cutoff = now - durationMs;

    let high = -Infinity;
    let low = Infinity;
    let oldestInWindow = Infinity;
    let newestInWindow = -Infinity;
    let count = 0;

    // Plain for-loop — no .filter(), no .map()
    for (let i = 0, len = buffer.length; i < len; i++) {
      const entry = buffer[i];
      if (entry.time < cutoff) continue;

      if (entry.price > high) high = entry.price;
      if (entry.price < low) low = entry.price;
      if (entry.time < oldestInWindow) oldestInWindow = entry.time;
      if (entry.time > newestInWindow) newestInWindow = entry.time;
      count++;
    }

    if (count === 0 || !isFinite(high) || !isFinite(low)) return null;

    const actualSpan = newestInWindow - oldestInWindow;
    const coverage = durationMs > 0 ? Math.min(actualSpan / durationMs, 1) : 1;

    return { high, low, coverage };
  }

  /**
   * Realized per-second volatility (σ of log returns) over a window ending at `endTime`.
   *
   * Each return is normalized by its actual dt so the throttled (≥1s, occasionally gapped)
   * sampling does not bias the estimate: variance contribution = r² / dt_seconds.
   * Single for-loop — no .filter()/.map(). Buffer is chronologically ordered.
   *
   * @param {string} symbol
   * @param {number} durationMs - lookback window length
   * @param {number} endTime - window end (exclusive of later entries); measure pre-event
   * @returns {{ sigma1s: number, samples: number, coverage: number } | null}
   *   sigma1s is a fraction (e.g. 0.0004 = 0.04%/s). null if too few samples or σ ≤ 0.
   */
  getReturnVolatility(symbol, durationMs, endTime) {
    const buffer = this.priceBuffer.get(symbol);
    if (!buffer || buffer.length < 2) return null;

    const startCutoff = endTime - durationMs;

    let sumSqPerSec = 0;
    let n = 0;
    let prevPrice = 0;
    let prevTime = 0;
    let firstTime = 0;
    let lastTime = 0;
    let havePrev = false;

    for (let i = 0, len = buffer.length; i < len; i++) {
      const entry = buffer[i];
      if (entry.time < startCutoff) continue;
      if (entry.time > endTime) break;        // chronological — rest is past the window
      if (entry.price <= 0) continue;

      if (havePrev) {
        const dtSec = (entry.time - prevTime) / 1000;
        if (dtSec > 0) {
          const r = Math.log(entry.price / prevPrice);
          sumSqPerSec += (r * r) / dtSec;     // per-second variance contribution
          n++;
          lastTime = entry.time;
        }
      } else {
        firstTime = entry.time;
        lastTime = entry.time;
      }

      prevPrice = entry.price;
      prevTime = entry.time;
      havePrev = true;
    }

    if (n < (config.VOL_MIN_SAMPLES || 30)) return null;

    const sigma1s = Math.sqrt(sumSqPerSec / n);
    if (!isFinite(sigma1s) || sigma1s <= 0) return null;

    const coverage = durationMs > 0 ? Math.min((lastTime - firstTime) / durationMs, 1) : 1;
    return { sigma1s, samples: n, coverage };
  }

  /**
   * Find the price+OI entry closest to a target timestamp.
   * Plain for-loop with early exit — no .find(), no .map(), no allocations.
   *
   * @param {string} symbol
   * @param {number} targetTime - Timestamp (ms) to search near
   * @returns {{ price: number, openInterest: number }|null}
   */
  getClosestSnapshot(symbol, targetTime) {
    const buffer = this.priceBuffer.get(symbol);
    if (!buffer || buffer.length === 0) return null;

    let closest = buffer[0];
    let minDiff = Math.abs(closest.time - targetTime);

    // Plain for-loop — no .find()
    for (let i = 1, len = buffer.length; i < len; i++) {
      const entry = buffer[i];
      const diff = Math.abs(entry.time - targetTime);

      if (diff < minDiff) {
        minDiff = diff;
        closest = entry;
      }

      // Early exit: buffer is chronologically ordered.
      // Once past target AND diff is increasing, further entries are worse.
      if (entry.time > targetTime && diff > minDiff) {
        break;
      }
    }

    return { price: closest.price, openInterest: closest.oi };
  }

  /**
   * Register a callback for real-time price updates.
   * Called on every ticker update with (symbol, price).
   * @param {(symbol: string, price: number) => void} callback
   */
  onPriceUpdate(callback) {
    this.priceCallbacks.push(callback);
  }

  /**
   * TEMP DIAG: liveness snapshot for the stream-stall investigation. Remove after diagnosis.
   * @returns {object}
   */
  getLiveness() {
    const now = Date.now();
    return {
      connected: this.isConnected,
      readyState: this.ws ? this.ws.readyState : -1,
      dataAge: this._lastDataAt ? now - this._lastDataAt : null,
      pongAge: this._lastPongAt ? now - this._lastPongAt : null,
      recon: this.reconnectAttempts,
    };
  }

  /**
   * Graceful shutdown.
   */
  stop() {
    logger.info('[priceStream] Shutting down');
    this.shouldReconnect = false;
    this.isConnected = false;

    this._stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.subscribedSymbols.clear();
    this.priceBuffer.clear();
    this.lastWrite.clear();
    this.blacklist.clear();
    this.priceCallbacks = [];
    this.currentBatchRequest = null;
    logger.info('[priceStream] Shutdown complete');
  }

  /**
   * Check if a symbol is blacklisted.
   * @param {string} symbol
   * @returns {boolean}
   */
  isBlacklisted(symbol) {
    return this.blacklist.has(symbol);
  }
}

// Singleton
const priceStreamService = new PriceStreamService();
export default priceStreamService;