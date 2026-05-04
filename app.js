import logger from './utils/logger.js';
import config from './config/index.js';
import symbolService from './services/symbolService.js';
import liquidationStreamService from './services/liquidationStreamService.js';
import tracker from './services/liquidationTracker.js';
import alertService from './services/alertService.js';
import reactionTracker from './services/signalReactionTracker.js';
import priceStreamService from './services/priceStreamService.js';

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
liquidationStreamService.onMessage((event) => {
  tracker.handleEvent(event);
});

// Tracker alerts → alertService + reactionTracker
tracker.onAlert((alert) => {
  alertService.sendAlert(alert);
  reactionTracker.startTracking(alert);
});

// Reaction results → alertService (secondary message after 60s)
reactionTracker.onReaction((reaction) => {
  alertService.sendReaction(reaction);
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
    await liquidationStreamService.connect();
  } catch (error) {
  logger.error('Failed to connect liquidation stream', { error: error.message });
    process.exit(1);
  }

  // 3. Subscribe to all symbols (liquidation stream)
  liquidationStreamService.subscribeMany(symbolNames);

  // 4. Start price stream (separate WS for tickers)
  try {
    await priceStreamService.connect();
    priceStreamService.subscribeMany(symbolNames);
  } catch (error) {
    logger.error('Failed to connect price stream', { error: error.message });
  }

  // 5. Start the liquidation tracker tick
  tracker.start();

  // 6. Schedule periodic symbol refresh to pick up new listings
  setInterval(async () => {
    try {
      logger.debug('Running scheduled symbol refresh...');
      const { added, removed } = await symbolService.refreshSymbols();
      if (removed.length > 0) {
        logger.info(`Symbols removed, unsubscribing: ${removed.join(', ')}`);
        liquidationStreamService.unsubscribeMany(removed);
        priceStreamService.unsubscribeMany(removed);
      }
      if (added.length > 0) {
        logger.info(`New symbols detected, subscribing: ${added.join(', ')}`);
        liquidationStreamService.subscribeMany(added);
        priceStreamService.subscribeMany(added);
      }
    } catch (error) {
      logger.error('Scheduled symbol refresh failed', { error: error.message });
    }
  }, config.FETCH_INTERVAL_MS);

  logger.info('✅ Liquidation Scanner is live');
  logger.info(`   Window: ${config.WINDOW_SIZE_MS}ms | Tick: ${config.WINDOW_TICK_MS}ms | History: ${config.HISTORY_DURATION_MS}ms`);
  logger.info(`   Symbol refresh: every ${config.FETCH_INTERVAL_MS / 60000}min`);
  logger.info(`   Alert channels: ${[config.TELEGRAM_BOT_TOKEN && 'Telegram', config.PUSHOVER_USER_KEY && 'Pushover'].filter(Boolean).join(', ') || 'NONE CONFIGURED'}`);
}

// ── Shutdown ────────────────────────────────────────────────────

async function shutdown(signal) {
  logger.info(`Received ${signal}. Shutting down gracefully...`);

  tracker.stop();
  reactionTracker.stop();
  priceStreamService.stop();
  await liquidationStreamService.shutdown();

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