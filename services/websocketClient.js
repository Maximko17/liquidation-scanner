import WebSocket from 'ws';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * Bybit WebSocket client for liquidation streams (v5 public)
 * Handles connection, reconnection, batch subscriptions, and event parsing.
 *
 * Single-connection design — never opens multiple sockets.
 */
class WebsocketClient {
  constructor() {
    this.ws = null;
    this.url = config.BYBIT_WS_URL;
    this.subscribedSymbols = new Set();
    this.blacklist = new Set();
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 20;
    this.maxReconnectDelay = 30_000;
    this.shouldReconnect = true;
    this.isConnected = false;
    this.messageHandlers = [];
    this.currentBatchRequest = null; // Set of symbols awaiting subscribe response
    this.pingInterval = null; // Ping/pong keepalive interval
  }

  /**
   * Connect to Bybit WebSocket.
   * Resolves on open, rejects on error.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      logger.info(`Connecting to Bybit WebSocket: ${this.url}`);

      this.ws = new WebSocket(this.url);

      this.ws.on('open', () => {
        this.isConnected = true;
        logger.info('WebSocket connected');
        this.reconnectAttempts = 0;

        // Start ping/pong keepalive
        this._startPing();

        // Re-subscribe to all previously-subscribed symbols after reconnect
        if (this.subscribedSymbols.size > 0) {
          const symbols = Array.from(this.subscribedSymbols);
          logger.info(`Re-subscribing to ${symbols.length} symbols after reconnect`);
          this._sendSubscribe(symbols);
        }
        resolve();
      });

      this.ws.on('message', (data) => {
        try {
          const message = JSON.parse(data.toString());
          this._handleMessage(message);
        } catch (error) {
          logger.error('Failed to parse WebSocket message', { error });
        }
      });

      // Log pong responses from server
      this.ws.on('pong', (data) => {
        logger.debug('WebSocket pong received');
      });

      this.ws.on('error', (error) => {
        this.isConnected = false;
        logger.error('WebSocket error', { error: error.message });
        reject(error);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        this._stopPing();
        logger.warn('WebSocket closed', { code, reason: reason?.toString() });
        this._handleReconnect();
      });
    });
  }

  /**
   * Start the ping/pong keepalive interval.
   * Sends a WebSocket ping every WS_PING_INTERVAL_MS.
   * The `ws` library automatically handles pong responses.
   */
  _startPing() {
    this._stopPing(); // Clear any existing interval

    const interval = config.WS_PING_INTERVAL_MS || 20_000;
    logger.info(`Starting WebSocket keepalive ping every ${interval}ms`);

    this.pingInterval = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.ping();
        logger.debug('WebSocket ping sent');
      }
    }, interval);
  }

  /**
   * Stop the ping/pong keepalive interval.
   */
  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  /**
   * Handle an incoming message from Bybit.
   * Routes to subscription responses or liquidation events.
   * @param {object} message - Parsed JSON
   */
  _handleMessage(message) {
    // Subscription response
    if (message.op === 'subscribe') {
      this._handleSubscribeResponse(message);
      return;
    }

    // Liquidation event stream
    if (message.topic && message.topic.startsWith('allLiquidation.')) {
      const symbol = message.topic.replace('allLiquidation.', '');
      const events = message.data; // Array of liquidation events

      if (!Array.isArray(events)) {
        logger.warn('Expected array in liquidation data', { data: message.data });
        return;
      }

      logger.debug(`Received ${events.length} liquidation event(s) for ${symbol}`);

      for (const raw of events) {
        this._handleLiquidationEvent(symbol, raw);
      }
    }
  }

  /**
   * Normalize a raw Bybit event into internal representation.
   * Bybit v5 fields: s (symbol), S (Buy|Sell), v (size USD), p(price), T (timestamp ms)
   *
   * Mapping per task spec:
   *   S="Buy"  → side="long"
   *   S="Sell" → side="short"
   *
   * @param {string} symbol - e.g. "BTCUSDT"
   * @param {object} raw - Raw event from Bybit
   */
  _handleLiquidationEvent(symbol, raw) {
    const size = parseFloat(raw.v) || 0;
    const sideRaw = raw.S; // "Buy" or "Sell"
    const eventTime = parseInt(raw.T, 10) || Date.now();

    // Task spec mapping
    const side = sideRaw === 'Buy' ? 'long' : 'short';

    const event = {
      symbol,
      side,
      size,
      time: eventTime,
    };

    logger.debug(
      `Liquidation: ${symbol} ${side.toUpperCase()} size=${size} time=${new Date(eventTime).toISOString()}`
    );

    // Notify all registered handlers
    for (const handler of this.messageHandlers) {
      try {
        handler(event);
      } catch (error) {
        logger.error('Error in message handler', { error });
      }
    }
  }

  /**
   * Handle subscription confirmation response.
   * On success: mark symbols as subscribed.
   * On failure: blacklist the offending symbol, retry the rest.
   * @param {object} message - Subscribe response
   */
  _handleSubscribeResponse(message) {
    if (!this.currentBatchRequest) {
      logger.debug('Received subscribe response but no pending batch request');
      return;
    }

    const symbols = Array.from(this.currentBatchRequest);
    this.currentBatchRequest = null;

    if (message.success) {
      for (const symbol of symbols) {
        this.subscribedSymbols.add(symbol);
        logger.debug(`Subscribed to ${symbol}`);
      }
      logger.info(`Batch subscription OK for ${symbols.length} symbols`);
    } else {
      // Bybit returns error like "topic:allLiquidation.SYMBOL not found"
      const match = message.ret_msg?.match(/topic:allLiquidation\.([A-Z0-9]+)/);
      const failedSymbol = match ? match[1] : null;

      if (failedSymbol) {
        if (!this.blacklist.has(failedSymbol)) {
          this.blacklist.add(failedSymbol);
          logger.warn(`Blacklisted ${failedSymbol}: ${message.ret_msg}`);
        }
        // Retry the rest (excluding the failed one)
        const remaining = symbols.filter((s) => s !== failedSymbol);
        if (remaining.length > 0) {
          logger.info(`Retrying ${remaining.length} symbols after removing ${failedSymbol}`);
          this._sendSubscribe(remaining);
        }
      } else {
        logger.error('Batch subscription failed — retrying all', { ret_msg: message.ret_msg, symbols });
        this._sendSubscribe(symbols);
      }
    }
  }

  /**
   * Subscribe to a batch of symbols via a single subscribe message.
   * Topics: allLiquidation.{symbol}
   * @param {string[]} symbols
   */
  _sendSubscribe(symbols) {
    // Filter: skip blacklisted, already subscribed, or already pending
    const filtered = symbols.filter((s) => {
      if (this.blacklist.has(s)) return false;
      if (this.subscribedSymbols.has(s)) return false;
      if (this.currentBatchRequest && this.currentBatchRequest.has(s)) return false;
      return true;
    });

    if (filtered.length === 0) {
      logger.debug('No new symbols to subscribe');
      return;
    }

    this.currentBatchRequest = new Set(filtered);

    const topics = filtered.map((s) => `allLiquidation.${s}`);
    const message = JSON.stringify({ op: 'subscribe', args: topics });

    logger.info(`Subscribing to ${filtered.length} symbols`);
    this._send(message);
  }

  /**
   * Public API: subscribe to (or update) the set of watched symbols.
   * Adds new symbols; does NOT unsubscribe from existing ones.
   * @param {string[]} symbols
   */
  subscribeMany(symbols) {
    this._sendSubscribe(symbols);
  }

  /**
   * Send a raw JSON string over the WebSocket.
   * @param {string} data
   */
  _send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      logger.warn(`Cannot send — WS state: ${this.ws?.readyState ?? 'null'}`);
    }
  }

  /**
   * Register a handler for normalized liquidation events.
   * @param {(event: {symbol:string, side:'long'|'short', size:number, time:number}) => void} handler
   */
  onMessage(handler) {
    this.messageHandlers.push(handler);
  }

  /**
   * Reconnection with exponential backoff.
   */
  _handleReconnect() {
    if (!this.shouldReconnect) {
      logger.info('Reconnection disabled');
      return;
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error(`Max reconnect attempts (${this.maxReconnectAttempts}) reached — giving up`);
      this.shouldReconnect = false;
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(
      config.WS_RECONNECT_DELAY * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );

    logger.info(`Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect().catch((err) => {
        logger.error('Reconnection failed', { error: err.message });
      });
    }, delay);
  }

  /**
   * Check if a symbol is blacklisted (does not exist on Bybit).
   * @param {string} symbol
   * @returns {boolean}
   */
  isBlacklisted(symbol) {
    return this.blacklist.has(symbol);
  }

  /**
   * Graceful shutdown.
   */
  async shutdown() {
    logger.info('Shutting down WebSocket');
    this.shouldReconnect = false;
    this.isConnected = false;

    this._stopPing();

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.subscribedSymbols.clear();
    this.currentBatchRequest = null;
    this.messageHandlers = [];
    logger.info('WebSocket shutdown complete');
  }

  /**
   * Get current connection status.
   * @returns {object}
   */
  getStatus() {
    return {
      connected: this.isConnected,
      subscribedCount: this.subscribedSymbols.size,
      blacklistedCount: this.blacklist.size,
      reconnectAttempts: this.reconnectAttempts,
    };
  }
}

// Singleton
const wsClient = new WebsocketClient();
export default wsClient;