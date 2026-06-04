import WebSocket from 'ws';
import config from '../config/index.js';
import logger from '../utils/logger.js';
import { getPercentile } from '../utils/median.js';

/**
 * Trade Flow Stream Service (CVD)
 *
 * Maintains a real-time trade buffer per symbol using a dedicated
 * WebSocket connection subscribed to Bybit v5 publicTrade.{symbol} topics.
 *
 * Key properties:
 *   - Rolling window of 120s per symbol (TRADE_BUFFER_MAX_AGE_MS)
 *   - CVD (Cumulative Volume Delta): buy volume - sell volume
 *   - Large trade detection via rolling p90 of recent sizes
 *   - While+shift cleanup — O(1) amortized
 *
 * Design: structurally parallel to priceStreamService.
 */

/** @typedef {{ symbol: string, time: number, side: 'buy'|'sell', size: number, price: number, isLarge: boolean }} NormalizedTrade */

/** @typedef {{ cvd: number, buyVolume: number, sellVolume: number, totalVolume: number, tradeCount: number, aggressorBuyRatio: number|null, largeBuyVolume: number, largeSellVolume: number, largeCvd: number, tradeIntensity: number }} FlowMetrics */

class TradeStreamService {
  constructor() {
    this.ws = null;
    this.url = config.TRADE_WS_URL || 'wss://stream.bybit.com/v5/public/linear';

    /** @type {Map<string, Array<NormalizedTrade>>} symbol → trade buffer */
    this.tradeBuffer = new Map();

    /** @type {Map<string, {value:number, at:number}>} symbol → cached large-trade threshold */
    this._largeThreshold = new Map();

    /** @type {Set<string>} */
    this.subscribedSymbols = new Set();

    /** @type {Set<string>} */
    this.blacklist = new Set();

    /** @type {Set<string>|null} */
    this.currentBatchRequest = null;

    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.maxReconnectDelay = 30_000;
    this.shouldReconnect = true;
    this.isConnected = false;
    this.pingInterval = null;
    this.watchdogInterval = null;
    this._lastDataAt = 0; // ms timestamp of the last received trade frame (any symbol); 0 = none yet
    this._pendingResubscribe = null;
    this._serverTimeOffset = 0; // Clock drift correction (ms), aligns exchange T to local clock

    /** @type {Array<Function>} */
    this.tradeCallbacks = [];
  }

  // ═══════════════════════════════════════════════════════════
  // Connection
  // ═══════════════════════════════════════════════════════════

  connect() {
    return new Promise((resolve, reject) => {
      logger.info(`[tradeStream] Connecting to ${this.url}`);

      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.isConnected = true;
        this.reconnectAttempts = 0;
        this._lastDataAt = Date.now(); // don't judge a fresh socket stale before first data
        logger.info('[tradeStream] WebSocket connected');

        this._startPing();
        this._startWatchdog();

        if (this._pendingResubscribe && this._pendingResubscribe.length > 0) {
          const symbols = this._pendingResubscribe;
          this._pendingResubscribe = null;
          logger.info(`[tradeStream] Re-subscribing to ${symbols.length} symbols`);
          this._sendSubscribe(symbols);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (error) {
          logger.error('[tradeStream] Failed to parse message', { error });
        }
      });

      this.ws.on('pong', () => {
        logger.debug('[tradeStream] pong');
      });

      this.ws.on('error', (error) => {
        this.isConnected = false;
        logger.error('[tradeStream] WebSocket error', { error: error.message });
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this._stopPing();
        this._stopWatchdog();

        this._pendingResubscribe = Array.from(this.subscribedSymbols);
        this.subscribedSymbols.clear();

        logger.warn('[tradeStream] WebSocket closed', { code, reason: reason?.toString() });
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

  /**
   * Data-liveness watchdog: the keepalive ping keeps the control channel alive but cannot
   * detect a data-only stall (Bybit silently stops pushing trade frames while the socket stays
   * open). If no trade frame has arrived across ALL symbols within TRADE_STALL_TIMEOUT_MS, force
   * a hard close → the existing close→reconnect→resubscribe path revives the feed.
   */
  _startWatchdog() {
    this._stopWatchdog();
    const timeout = config.TRADE_STALL_TIMEOUT_MS || 30_000;
    // Check at ~1/3 of the timeout so detection latency stays well under the timeout itself.
    const checkEvery = Math.max(5_000, Math.floor(timeout / 3));
    logger.info(`[tradeStream] watchdog armed (stall timeout=${timeout}ms, check every ${checkEvery}ms)`);
    this.watchdogInterval = setInterval(() => this._checkDataLiveness(), checkEvery);
  }

  /**
   * One liveness check: force-reconnect if the trade feed has been silent past the timeout.
   * Extracted from the interval so it can be driven directly in tests.
   */
  _checkDataLiveness() {
    if (!this.isConnected || !this._lastDataAt) return;
    const timeout = config.TRADE_STALL_TIMEOUT_MS || 30_000;
    const stallMs = Date.now() - this._lastDataAt;
    if (stallMs > timeout) {
      logger.warn(`[tradeStream] Data stall: no trades for ${stallMs}ms (> ${timeout}ms) — forcing reconnect`);
      this._lastDataAt = 0; // avoid repeated terminates before the socket actually closes
      if (this.ws) this.ws.terminate();
    }
  }

  _stopWatchdog() {
    if (this.watchdogInterval) {
      clearInterval(this.watchdogInterval);
      this.watchdogInterval = null;
    }
  }

  _handleReconnect() {
    if (!this.shouldReconnect) return;
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[tradeStream] Max reconnect attempts reached');
      this.shouldReconnect = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      config.WS_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    logger.info(`[tradeStream] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((err) => {
        logger.error('[tradeStream] Reconnect failed', { error: err.message });
      });
    }, delay);
  }

  // ═══════════════════════════════════════════════════════════
  // Subscription
  // ═══════════════════════════════════════════════════════════

  subscribeMany(symbols) {
    this._sendSubscribe(symbols);
  }

  unsubscribeMany(symbols) {
    const toRemove = [];
    for (const s of symbols) {
      if (this.subscribedSymbols.has(s)) {
        toRemove.push(s);
      }
    }

    if (toRemove.length === 0) return;

    const topics = [];
    for (const s of toRemove) {
      topics.push(`publicTrade.${s}`);
    }
    const message = JSON.stringify({ op: 'unsubscribe', args: topics });

    logger.info(`[tradeStream] Unsubscribing from ${toRemove.length} trade topic(s)`);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(message);
    }

    for (const s of toRemove) {
      this.subscribedSymbols.delete(s);
      this.tradeBuffer.delete(s);
      this._largeThreshold.delete(s);
    }
  }

  _sendSubscribe(symbols) {
    const filtered = [];
    for (const s of symbols) {
      if (this.blacklist.has(s)) continue;
      if (this.subscribedSymbols.has(s)) continue;
      if (this.currentBatchRequest && this.currentBatchRequest.has(s)) continue;
      filtered.push(s);
    }

    if (filtered.length === 0) {
      return;
    }

    this.currentBatchRequest = new Set(filtered);

    const topics = [];
    for (const s of filtered) {
      topics.push(`publicTrade.${s}`);
    }

    logger.info(`[tradeStream] Subscribing to ${filtered.length} trade topic(s)`);
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

  _handleMessage(message) {
    if (message.op === 'subscribe') {
      this._handleSubscribeResponse(message);
      return;
    }

    // publicTrade data stream
    if (message.topic && message.topic.startsWith('publicTrade.')) {
      const symbol = message.topic.replace('publicTrade.', '');
      const trades = message.data;

      if (!Array.isArray(trades)) return;

      // Data-liveness mark: one cheap timestamp write per frame (not per trade) — feeds the watchdog.
      this._lastDataAt = Date.now();

      for (const trade of trades) {
        this._ingestTrade(symbol, trade);
      }
    }
  }

  _handleSubscribeResponse(message) {
    if (!this.currentBatchRequest) return;

    const symbols = Array.from(this.currentBatchRequest);
    this.currentBatchRequest = null;

    if (message.success) {
      for (const s of symbols) {
        this.subscribedSymbols.add(s);
      }
      logger.info(`[tradeStream] Batch subscription OK for ${symbols.length} symbol(s)`);
    } else {
      const match = message.ret_msg?.match(/topic:publicTrade\.([A-Z0-9]+)/);
      const failedSymbol = match ? match[1] : null;

      if (failedSymbol) {
        if (!this.blacklist.has(failedSymbol)) {
          this.blacklist.add(failedSymbol);
          logger.warn(`[tradeStream] Blacklisted ${failedSymbol}: ${message.ret_msg}`);
        }
        const remaining = [];
        for (const s of symbols) {
          if (s !== failedSymbol) remaining.push(s);
        }
        if (remaining.length > 0) {
          this._sendSubscribe(remaining);
        }
      } else {
        logger.error('[tradeStream] Batch subscription failed — retrying', { ret_msg: message.ret_msg });
        this._sendSubscribe(symbols);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════
  // Trade ingestion & buffer management
  // ═══════════════════════════════════════════════════════════

  /**
   * Normalize and store a single trade.
   * @param {string} symbol
   * @param {object} rawTrade - Raw Bybit trade object
   */
  _ingestTrade(symbol, rawTrade) {
    const rawT = typeof rawTrade.T === 'number' ? rawTrade.T : Date.now();
    // Clock-drift correction: align Bybit's exchange timestamp to the LOCAL clock, so the
    // reaction tracker's flow windows (built from local-clock alert timestamps + the local-clock
    // price buffer) line up with this trade buffer. Without it, a drifted machine clock shifts
    // the [startTime, startTime+window] query off the trades → participation silently reads 0.
    // Mirrors liquidationStreamService's correction; computed once on the first trade.
    if (this._serverTimeOffset === 0) {
      this._serverTimeOffset = Date.now() - rawT;
      if (Math.abs(this._serverTimeOffset) > 5000) {
        logger.warn(`[tradeStream] Clock drift detected: ${this._serverTimeOffset}ms offset from Bybit server`);
      }
    }
    const time = rawT + this._serverTimeOffset;
    const side = rawTrade.S === 'Buy' ? 'buy' : 'sell';
    const volume = parseFloat(rawTrade.v) || 0;
    const price = parseFloat(rawTrade.p) || 0;
    const size = volume * price; // USD value

    if (size <= 0) return;

    // Get or create buffer
    let buffer = this.tradeBuffer.get(symbol);
    if (!buffer) {
      buffer = [];
      this.tradeBuffer.set(symbol, buffer);
    }

    /** @type {NormalizedTrade} */
    const trade = { symbol, time, side, size, price, isLarge: false };

    // Push then detect large trades on the full buffer
    buffer.push(trade);

    // Clean old entries
    this._cleanBuffer(symbol, time);

    // Detect large trades — runs after buffer is populated
    this._detectLargeTrades(symbol, trade, buffer, time);

    // Notify listeners
    for (const cb of this.tradeCallbacks) {
      try { cb(symbol, trade); } catch { /* ignore */ }
    }
  }

  /**
   * Clean buffer: remove entries older than TRADE_BUFFER_MAX_AGE_MS.
   * @param {string} symbol
   * @param {number} now
   */
  _cleanBuffer(symbol, now) {
    const buffer = this.tradeBuffer.get(symbol);
    if (!buffer || buffer.length === 0) return;

    const maxAge = config.TRADE_BUFFER_MAX_AGE_MS || 120_000;
    const cutoff = now - maxAge;

    while (buffer.length > 0 && buffer[0].time < cutoff) {
      buffer.shift();
    }
  }

  /**
   * Detect whether the given trade is "large" relative to recent history.
   * Uses rolling p90 over the last 5 minutes of trade sizes for this symbol.
   * @param {string} symbol
   * @param {NormalizedTrade} trade
   * @param {Array<NormalizedTrade>} buffer
   * @param {number} now
   */
  _detectLargeTrades(symbol, trade, buffer, now) {
    const minTrades = 50;
    const lookbackMs = 300_000; // 5 minutes
    const multiplier = config.LARGE_TRADE_P90_MULTIPLIER || 2;
    const minLargeUsd = config.MIN_LARGE_TRADE_USD || 10_000;
    const recalcMs = config.LARGE_TRADE_RECALC_MS || 5_000;

    // Warmup: not enough history yet
    if (buffer.length < minTrades) {
      trade.isLarge = false;
      return;
    }

    // The threshold is the EXPENSIVE part (a p90 sort over the buffer). Recompute it at most once
    // per recalcMs PER SYMBOL and cache it; every trade is still compared against the cached value
    // below. p90 over ~5 min of sizes barely moves within a few seconds, so isLarge accuracy is
    // unchanged while per-trade CPU drops by orders of magnitude (fixes the event-loop backlog that
    // pushed buffered trade timestamps minutes behind real time → empty flow windows).
    let cached = this._largeThreshold.get(symbol);
    if (!cached || now - cached.at >= recalcMs) {
      const sizes = [];
      const cutoff = now - lookbackMs;
      for (let i = buffer.length - 1; i >= 0; i--) {
        if (buffer[i].time < cutoff) break;
        sizes.push(buffer[i].size);
      }

      if (sizes.length < minTrades) {
        trade.isLarge = false;
        return; // not enough in-window history yet — don't cache a bad threshold
      }

      const p90 = getPercentile(sizes, 0.90);
      cached = { value: Math.max(p90 * multiplier, minLargeUsd), at: now };
      this._largeThreshold.set(symbol, cached);
    }

    trade.isLarge = trade.size > cached.value;
  }

  // ═══════════════════════════════════════════════════════════
  // Public Query API
  // ═══════════════════════════════════════════════════════════

  /**
   * Get all trades for a symbol within a time window.
   * @param {string} symbol
   * @param {number} fromTime - ms timestamp (inclusive)
   * @param {number} toTime - ms timestamp (inclusive)
   * @returns {Array<NormalizedTrade>}
   */
  getTradesInWindow(symbol, fromTime, toTime) {
    const buffer = this.tradeBuffer.get(symbol);
    if (!buffer || buffer.length === 0) return [];

    const result = [];
    for (let i = 0, len = buffer.length; i < len; i++) {
      const t = buffer[i];
      if (t.time >= fromTime && t.time <= toTime) {
        result.push(t);
      }
    }
    return result;
  }

  /**
   * Compute aggregated flow metrics over a time window.
   *
   * @param {string} symbol
   * @param {number} fromTime - ms timestamp (inclusive)
   * @param {number} toTime - ms timestamp (inclusive)
   * @returns {FlowMetrics}
   */
  getFlowMetrics(symbol, fromTime, toTime) {
    const trades = this.getTradesInWindow(symbol, fromTime, toTime);
    const tradeCount = trades.length;
    const windowDurationSec = (toTime - fromTime) / 1000;

    if (tradeCount === 0) {
      return {
        cvd: 0,
        buyVolume: 0,
        sellVolume: 0,
        totalVolume: 0,
        tradeCount: 0,
        aggressorBuyRatio: null,
        largeBuyVolume: 0,
        largeSellVolume: 0,
        largeCvd: 0,
        tradeIntensity: 0,
      };
    }

    let buyVolume = 0;
    let sellVolume = 0;
    let largeBuyVolume = 0;
    let largeSellVolume = 0;

    for (let i = 0, len = trades.length; i < len; i++) {
      const t = trades[i];
      if (t.side === 'buy') {
        buyVolume += t.size;
        if (t.isLarge) largeBuyVolume += t.size;
      } else {
        sellVolume += t.size;
        if (t.isLarge) largeSellVolume += t.size;
      }
    }

    const totalVolume = buyVolume + sellVolume;
    const cvd = buyVolume - sellVolume;
    const largeCvd = largeBuyVolume - largeSellVolume;
    const aggressorBuyRatio = totalVolume > 0 ? buyVolume / totalVolume : null;
    const tradeIntensity = windowDurationSec > 0 ? tradeCount / windowDurationSec : 0;

    return {
      cvd,
      buyVolume,
      sellVolume,
      totalVolume,
      tradeCount,
      aggressorBuyRatio,
      largeBuyVolume,
      largeSellVolume,
      largeCvd,
      tradeIntensity,
    };
  }

  // ═══════════════════════════════════════════════════════════
  // Lifecycle
  // ═══════════════════════════════════════════════════════════

  onTrade(callback) {
    this.tradeCallbacks.push(callback);
  }

  stop() {
    logger.info('[tradeStream] Shutting down');
    this.shouldReconnect = false;
    this.isConnected = false;

    this._stopPing();
    this._stopWatchdog();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.subscribedSymbols.clear();
    this.tradeBuffer.clear();
    this._largeThreshold.clear();
    this.blacklist.clear();
    this.tradeCallbacks = [];
    this.currentBatchRequest = null;
    logger.info('[tradeStream] Shutdown complete');
  }

  isBlacklisted(symbol) {
    return this.blacklist.has(symbol);
  }
}

const tradeStreamService = new TradeStreamService();
export default tradeStreamService;