import dotenv from 'dotenv';
dotenv.config();

/**
 * Parse threshold configuration from environment variable
 * Returns per-symbol thresholds with fallback to "default"
 */
function parseThresholdConfig() {
  try {
    const raw = process.env.THRESHOLD_CONFIG;
    if (!raw) {
      throw new Error('THRESHOLD_CONFIG not set in environment');
    }
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('THRESHOLD_CONFIG is not a valid JSON object');
    }
    return parsed;
  } catch (error) {
    console.error(`Failed to parse THRESHOLD_CONFIG: ${error.message}`);
    return {
      default: { minBaseline: 50_000, absThreshold: 200_000, ratio: 4 },
    };
  }
}

const thresholdConfig = parseThresholdConfig();

/**
 * Get threshold configuration for a specific symbol
 * Falls back to the "default" entry if symbol not found
 * @param {string} symbol
 * @returns {{ minBaseline: number, absThreshold: number, ratio: number }}
 */
export function getThresholdConfig(symbol) {
  if (thresholdConfig[symbol]) {
    return thresholdConfig[symbol];
  }
  if (thresholdConfig.default) {
    return thresholdConfig.default;
  }
  // Ultimate fallback
  return { minBaseline: 50_000, absThreshold: 200_000, ratio: 4 };
}

export default {
  // ── REST API ──────────────────────────────────────
  BYBIT_BASE_URL: process.env.BYBIT_BASE_URL || 'https://api.bybit.com',
  FETCH_INTERVAL_MS: parseInt(process.env.FETCH_INTERVAL_MS, 10) || 600_000,
  FILTER_VOLUME_THRESHOLD: parseFloat(process.env.FILTER_VOLUME_THRESHOLD) || 30_000_000,
  FILTER_OI_THRESHOLD: parseFloat(process.env.FILTER_OI_THRESHOLD) || 10_000_000,

  // ── WebSocket ─────────────────────────────────────
  BYBIT_WS_URL: process.env.BYBIT_WS_URL || 'wss://stream.bybit.com/v5/public/linear',
  WS_RECONNECT_DELAY: parseInt(process.env.WS_RECONNECT_DELAY, 10) || 5_000,
  WS_PING_INTERVAL_MS: parseInt(process.env.WS_PING_INTERVAL_MS, 10) || 20_000,

  // ── Price Stream (WS-based price buffer) ──────────
  PRICE_WS_URL: process.env.PRICE_WS_URL || 'wss://stream.bybit.com/v5/public/linear',
  PRICE_BUFFER_MAX_AGE_MS: parseInt(process.env.PRICE_BUFFER_MAX_AGE_MS, 10) || 1_800_000,
  PRICE_THROTTLE_MS: parseInt(process.env.PRICE_THROTTLE_MS, 10) || 1_000,

  // ── Market Context (price ranges) ───────────────
  CONTEXT_SHORT_RANGE_MS: parseInt(process.env.CONTEXT_SHORT_RANGE_MS, 10) || 300_000,
  CONTEXT_MID_RANGE_MS: parseInt(process.env.CONTEXT_MID_RANGE_MS, 10) || 1_800_000,
  CONTEXT_MIN_COVERAGE: parseFloat(process.env.CONTEXT_MIN_COVERAGE) || 0.5,

  // ── Windows & Timing ──────────────────────────────────
  BUFFER_DURATION_MS: parseInt(process.env.BUFFER_DURATION_MS, 10) || 20_000,
  WINDOW_SIZE_MS: parseInt(process.env.WINDOW_SIZE_MS, 10) || 3_000,
  WINDOW_TICK_MS: parseInt(process.env.WINDOW_TICK_MS, 10) || 500,
  HISTORY_DURATION_MS: parseInt(process.env.HISTORY_DURATION_MS, 10) || 300_000,

  // ── Alerting ──────────────────────────────────────
  ALERT_COOLDOWN_MS: parseInt(process.env.ALERT_COOLDOWN_MS, 10) || 10_000,
  TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN || '',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '',
  PUSHOVER_USER_KEY: process.env.PUSHOVER_USER_KEY || '',
  PUSHOVER_APP_TOKEN: process.env.PUSHOVER_APP_TOKEN || '',

  // ── Logging ───────────────────────────────────────
  LOG_LEVEL: process.env.LOG_LEVEL || 'info',

  // ── Thresholds ────────────────────────────────────
  THRESHOLD_CONFIG: thresholdConfig,
  getThresholdConfig,

  // ── Reaction Classification ────────────────────
  // Price delta thresholds for post-signal analysis (in %)
  REACTION_DP5_STRONG: parseFloat(process.env.REACTION_DP5_STRONG) || 0.25,
  REACTION_DP15_CONTINUATION: parseFloat(process.env.REACTION_DP15_CONTINUATION) || 0.15,
  REACTION_DP15_REVERSAL: parseFloat(process.env.REACTION_DP15_REVERSAL) || -0.15,
  REACTION_DP60_CONTINUATION: parseFloat(process.env.REACTION_DP60_CONTINUATION) || 0.3,
  REACTION_DP60_REVERSAL: parseFloat(process.env.REACTION_DP60_REVERSAL) || -0.2,
  REACTION_ABSORPTION_MAX: parseFloat(process.env.REACTION_ABSORPTION_MAX) || 0.1,
  REACTION_MERGE_WINDOW_MS: parseInt(process.env.REACTION_MERGE_WINDOW_MS, 10) || 10_000,
  REACTION_MAX_ACTIVE_SIGNALS: parseInt(process.env.REACTION_MAX_ACTIVE_SIGNALS, 10) || 3,

  // ── EMA Regime ────────────────────────────────────
  EMA_RANGE_THRESHOLD: parseFloat(process.env.EMA_RANGE_THRESHOLD) || 0.1,

  // ── Adaptive Baseline ─────────────────────────────
  EVENT_HISTORY_SIZE: parseInt(process.env.EVENT_HISTORY_SIZE, 10) || 50,
  EVENT_HISTORY_WARMUP_COUNT: parseInt(process.env.EVENT_HISTORY_WARMUP_COUNT, 10) || 30,
  MIN_SIZE_EVENT_HISTORY_FILTER: parseInt(process.env.MIN_SIZE_EVENT_HISTORY_FILTER, 10) || 1000,
};
