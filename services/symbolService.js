import bybitClient from './bybitClient.js';
import config from '../config/index.js';
import logger from '../utils/logger.js';

class SymbolService {
  constructor() {
    this._filteredSymbols = [];
    this._lastUpdated = null;
  }

  /**
   * Fetch raw tickers and filter by volume and open interest criteria
   * @returns {Promise<Array>} - Filtered symbols array
   */
  async fetchAndFilterSymbols() {
    try {
      logger.info('Starting symbol filtering process...');

      const tickers = await bybitClient.getTickers();

      const filtered = tickers
        .map((ticker) => ({
          symbol: ticker.symbol,
          volume24h: parseFloat(ticker.turnover24h) || 0,
          openInterestValue: parseFloat(ticker.openInterestValue) || 0,
          lastPrice: parseFloat(ticker.lastPrice) || 0,
        }))
        .filter((ticker) => {
          const passesVolume = ticker.volume24h > config.FILTER_VOLUME_THRESHOLD;
          const passesOI = ticker.openInterestValue > config.FILTER_OI_THRESHOLD;
          return passesVolume && passesOI;
        });

      this._filteredSymbols = filtered;
      this._lastUpdated = new Date();

      logger.info(
        `Symbol filtering complete: ${filtered.length} symbols passed filters (from ${tickers.length} total)`
      );

      return filtered;
    } catch (error) {
      logger.error(`Error in fetchAndFilterSymbols: ${error.message}`, { stack: error.stack });
      return this.getFilteredSymbols();
    }
  }

  /**
   * Get the current filtered symbols from memory
   * @returns {Array} - Filtered symbols array
   */
  getFilteredSymbols() {
    return this._filteredSymbols;
  }

  /**
   * Get just the symbol names as an array of strings
   * @returns {string[]}
   */
  getSymbolNames() {
    return this._filteredSymbols.map((s) => s.symbol);
  }

  /**
   * Get the last update timestamp
   * @returns {Date|null}
   */
  getLastUpdated() {
    return this._lastUpdated;
  }

  /**
   * Refresh the symbol list from REST, detect added symbols.
   * Called periodically (FETCH_INTERVAL_MS) to pick up new listings
   * and symbols whose volume/OI crossed the filter threshold.
   * @returns {Promise<{ added: string[], removed: string[] }>}
   */
  async refreshSymbols() {
    const previousNames = new Set(this.getSymbolNames());

    await this.fetchAndFilterSymbols();

    const currentNames = new Set(this.getSymbolNames());

    const added = [];
    for (const name of currentNames) {
      if (!previousNames.has(name)) {
        added.push(name);
      }
    }

    const removed = [];
    for (const name of previousNames) {
      if (!currentNames.has(name)) {
        removed.push(name);
      }
    }

    if (added.length > 0 || removed.length > 0) {
      logger.info(
        `Symbol refresh: ${added.length} added, ${removed.length} removed. Total: ${currentNames.size}`
      );
    } else {
      logger.debug(`Symbol refresh: no changes. Total: ${currentNames.size}`);
    }

    return { added, removed };
  }
}

const symbolService = new SymbolService();
export default symbolService;