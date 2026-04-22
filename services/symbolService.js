const bybitClient = require('./bybitClient');
const config = require('../config');
const logger = require('../utils/logger');

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
          lastPrice: parseFloat(ticker.lastPrice) || 0
        }))
        .filter((ticker) => {
          const passesVolume = ticker.volume24h > config.FILTER_VOLUME_THRESHOLD;
          const passesOI = ticker.openInterestValue > config.FILTER_OI_THRESHOLD;
          return passesVolume && passesOI;
        });

      this._filteredSymbols = filtered;
      this._lastUpdated = new Date();

      logger.info(`Symbol filtering complete: ${filtered.length} symbols passed filters (from ${tickers.length} total)`);

      return filtered;
    } catch (error) {
      logger.error(`Error in fetchAndFilterSymbols: ${error.message}`, { stack: error.stack });
      // Return cached data if available, otherwise empty array
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
   * Get the last update timestamp
   * @returns {Date|null}
   */
  getLastUpdated() {
    return this._lastUpdated;
  }
}

module.exports = new SymbolService();