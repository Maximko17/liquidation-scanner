import logger from './utils/logger.js';
import config from './config/index.js';
import symbolService from './services/symbolService.js';
import wsClient from './services/websocketClient.js';
import tracker from './services/liquidationTracker.js';
import alertService from './services/alertService.js';

/**
 * Bybit Liquidation Monitoring System
 *
 * Flow:
 *   1. Fetch symbols from REST API (symbolService)
 *   2. Connect to Bybit WebSocket (single connection)
 *   3. Subscribe to allLiquidation.* topics for all symbols
 *   4. Ingest events → liquidationTracker
 *   5. Every 500ms: sliding window → baseline → signal detection
 *   6. On alert: dispatch to Telegram + Pushover
 */

// ── Wire callbacks ──────────────────────────────────────────────

// WebSocket events → tracker
wsClient.onMessage((event) => {
  tracker.handleEvent(event);
});

// Tracker alerts → alertService
tracker.onAlert((alert) => {
  alertService.sendAlert(alert);
});

// ── Startup ─────────────────────────────────────────────────────

async function start() {
  logger.info('========================================');
  logger.info('  Liquidation Scanner Starting');
  logger.info('========================================');

  // Send greeting BEFORE fetching symbols
  alertService.sendGreeting();

  // 1. Fetch symbols
  logger.info('Fetching symbols from Bybit REST...');
  await symbolService.fetchAndFilterSymbols();
  const symbolNames = symbolService.getSymbolNames();

  if (symbolNames.length === 0) {
    logger.error('No symbols passed filters! Check FILTER_VOLUME_THRESHOLD and FILTER_OI_THRESHOLD.');
    process.exit(1);
  }

  logger.info(`Monitoring ${symbolNames.length} symbols: ${symbolNames.slice(0, 10).join(', ')}${symbolNames.length > 10 ? '...' : ''}`);

  // 2. Connect WebSocket
  try {
    await wsClient.connect();
  } catch (error) {
  logger.error('Failed to connect WebSocket', { error: error.message });
    process.exit(1);
  }

  // 3. Subscribe to all symbols
  wsClient.subscribeMany(symbolNames);

  // 4. Start the liquidation tracker tick
  tracker.start();

  logger.info('✅ Liquidation Scanner is live');
  logger.info(`   Window: ${config.WINDOW_SIZE_MS}ms | Tick: ${config.WINDOW_TICK_MS}ms | History: ${config.HISTORY_DURATION_MS}ms`);
  logger.info(`   Alert channels: ${[config.TELEGRAM_BOT_TOKEN && 'Telegram', config.PUSHOVER_USER_KEY && 'Pushover'].filter(Boolean).join(', ') || 'NONE CONFIGURED'}`);
}

// ── Shutdown ────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  tracker.stop();
  await wsClient.shutdown();

  logger.info('Shutdown complete');
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Handle unhandled rejections gracefully
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', { reason });
});

// ── Go ──────────────────────────────────────────────────────────

start().catch((error) => {
  logger.error('Fatal startup error', { error: error.message, stack: error.stack });
  process.exit(1);
});