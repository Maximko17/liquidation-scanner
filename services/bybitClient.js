import https from 'node:https';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class BybitClient {
  constructor() {
    this.baseUrl = config.BYBIT_BASE_URL;
  }

  /**
   * Make an HTTP GET request to the Bybit API with retry logic.
   * Handles non-200 responses, timeouts, and transient failures.
   *
   * @param {string} path - API path
   * @param {object} params - Query parameters
   * @param {number} [retries=3] - Remaining retry attempts
   * @returns {Promise<object>} - Parsed JSON response
   */
  _request(path, params = {}, retries = 3) {
    return new Promise((resolve, reject) => {
      const queryString = new URLSearchParams(params).toString();
      const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;

      const req = https.get(url, { timeout: 10_000 }, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          // Check HTTP status code before attempting JSON parse
          if (res.statusCode < 200 || res.statusCode >= 300) {
            const preview = data.substring(0, 200);
            const err = new Error(`Bybit HTTP ${res.statusCode}: ${preview}`);
            err.statusCode = res.statusCode;

            // Retry on rate limit (429) or server errors (5xx)
            if (retries > 0 && (res.statusCode === 429 || res.statusCode >= 500)) {
              const delay = (4 - retries) * 1000;
              logger.warn(`Bybit HTTP ${res.statusCode} on ${path}, retrying in ${delay}ms (${retries} left)`);
              setTimeout(() => {
                this._request(path, params, retries - 1).then(resolve).catch(reject);
              }, delay);
              return;
            }

            reject(err);
            return;
          }

          // Parse JSON
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (error) {
            logger.error(`JSON parse failed for ${path}. Raw response: ${data.substring(0, 500)}`);
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        });
      });

      req.on('timeout', () => {
        req.destroy();
        const err = new Error(`Request timeout: ${path}`);
        if (retries > 0) {
          const delay = (4 - retries) * 1000;
          logger.warn(`Timeout on ${path}, retrying in ${delay}ms (${retries} left)`);
          setTimeout(() => {
            this._request(path, params, retries - 1).then(resolve).catch(reject);
          }, delay);
          return;
        }
        reject(err);
      });

      req.on('error', (error) => {
        const err = new Error(`Request failed: ${error.message}`);
        if (retries > 0) {
          const delay = (4 - retries) * 1000;
          logger.warn(`Request error on ${path}, retrying in ${delay}ms (${retries} left): ${error.message}`);
          setTimeout(() => {
            this._request(path, params, retries - 1).then(resolve).catch(reject);
          }, delay);
          return;
        }
        reject(err);
      });
    });
  }

  /**
   * Fetch a single linear ticker from Bybit by symbol.
   * Used by signalReactionTracker to capture price & OI snapshots.
   * @param {string} symbol - e.g. "BTCUSDT"
   * @returns {Promise<{ price: number, openInterest: number }>}
   */
  async getTicker(symbol) {
    logger.debug(`Fetching ticker for ${symbol}`);
    const response = await this._request('/v5/market/tickers', { category: 'linear', symbol });

    if (response.retCode !== 0) {
      throw new Error(`Bybit API error for ${symbol}: ${response.retMsg || 'Unknown error'}`);
    }

    const ticker = response.result?.list?.[0];
    if (!ticker) {
      throw new Error(`No ticker data returned for ${symbol}`);
    }

    return {
      price: parseFloat(ticker.lastPrice) || 0,
      openInterest: parseFloat(ticker.openInterestValue) || 0,
    };
  }

  /**
   * Fetch all linear (USDT perpetual) tickers from Bybit
   * Handles pagination if there are more results
   * @returns {Promise<Array>} - Array of ticker objects
   */
  async getTickers() {
    let allTickers = [];
    let cursor = '';
    let hasMore = true;

    while (hasMore) {
      logger.debug(`Fetching tickers from ${this.baseUrl}${cursor ? `, cursor: ${cursor}` : ''}`);

      const params = { category: 'linear' };
      if (cursor) {
        params.cursor = cursor;
      }

      const response = await this._request('/v5/market/tickers', params);

      if (response.retCode !== 0) {
        throw new Error(`Bybit API error: ${response.retMsg || 'Unknown error'}`);
      }

      const tickers = response.result?.list || [];
      allTickers = allTickers.concat(tickers);

      cursor = response.result?.nextPageCursor || '';
      hasMore = !!cursor;
    }

    logger.info(`Fetched ${allTickers.length} tickers from Bybit`);
    return allTickers;
  }
}

const bybitClient = new BybitClient();
export default bybitClient;