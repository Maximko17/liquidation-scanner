const logger = require('./utils/logger');
const config = require('./config');
const symbolService = require('./services/symbolService');

/**
 * Main scheduler function that periodically fetches and filters symbols
 */
async function startScheduler() {
  logger.info(`Symbol scanner started with interval: ${config.FETCH_INTERVAL_MS / 1000}s`);

  // Run initial fetch immediately
  await runFetchCycle();

  // Set up recurring fetch interval
  setInterval(runFetchCycle, config.FETCH_INTERVAL_MS);
}

/**
 * Execute one fetch and filter cycle
 */
async function runFetchCycle() {
  try {
    await symbolService.fetchAndFilterSymbols();

    const symbols = symbolService.getFilteredSymbols();
    const lastUpdated = symbolService.getLastUpdated();

    if (symbols.length > 0) {
      logger.debug(`Current filtered symbols: ${JSON.stringify(symbols.map((s) => s.symbol))}`);
    }
  } catch (error) {
    logger.error(`Unexpected error during fetch cycle: ${error.message}`, { stack: error.stack });
  }
}

// Handle graceful shutdown
const shutdownSignals = ['SIGINT', 'SIGTERM'];
shutdownSignals.forEach((signal) => {
  process.on(signal, () => {
    logger.info(`Received ${signal}. Shutting down gracefully...`);
    process.exit(0);
  });
});

// Start the application
startScheduler().catch((error) => {
  logger.error(`Failed to start scheduler: ${error.message}`, { stack: error.stack });
  process.exit(1);
});

module.exports = { getFilteredSymbols: () => symbolService.getFilteredSymbols() };