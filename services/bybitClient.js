import https from 'node:https';
import logger from '../utils/logger.js';
import config from '../config/index.js';

class BybitClient {
  constructor() {
    this.baseUrl = config.BYBIT_BASE_URL;
  }

  /**
   * Make an HTTP GET request to the Bybit API
   * @param {string} path - API path
   * @param {object} params - Query parameters
   * @returns {Promise<object>} - Parsed JSON response
   */
  _request(path, params = {}) {
    return new Promise((resolve, reject) => {
      const queryString = new URLSearchParams(params).toString();
      const url = `${this.baseUrl}${path}${queryString ? `?${queryString}` : ''}`;

      https.get(url, (res) => {
        let data = '';

        res.on('data', (chunk) => {
          data += chunk;
        });

        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            resolve(parsed);
          } catch (error) {
            reject(new Error(`Failed to parse response: ${error.message}`));
          }
        });
      }).on('error', (error) => {
        reject(new Error(`Request failed: ${error.message}`));
      });
    });
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