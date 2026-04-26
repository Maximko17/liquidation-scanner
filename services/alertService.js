import https from 'node:https';
import config from '../config/index.js';
import { formatUSD } from '../utils/formatters.js';
import logger from '../utils/logger.js';
import TelegramBot from 'node-telegram-bot-api';

/**
 * Alert Dispatcher
 *
 * Sends liquidation spike alerts to:
 *   - Telegram Bot API (if credentials configured)
 *   - Pushover API (if credentials configured)
 *
 * Throttling: cooldown per symbol+side (ALERT_COOLDOWN_MS, default 10s)
 * to prevent rapid repeated alerts for the same signal.
 */
class AlertService {
  constructor() {
    /** @type {Map<string, number>} symbol+side → last alert sent timestamp */
    this.cooldowns = new Map();
    /** @type {TelegramBot|null} lazy-initialized Telegram bot instance */
    this.telegramBot = null;
  }

  /**
   * Send an alert for a liquidation spike.
   * @param {import('./liquidationTracker.js').LiquidationAlert} alert
   */
  async sendAlert(alert) {
    const { symbol, side, L_now, baseline, ratio } = alert;

    // ── Throttling check ─────────────────────────────────
    const key = `${symbol}:${side}`;
    const lastSent = this.cooldowns.get(key) || 0;
    const now = Date.now();

    if (now - lastSent < config.ALERT_COOLDOWN_MS) {
      logger.debug(`Throttled alert for ${key} (cooldown remaining: ${config.ALERT_COOLDOWN_MS - (now - lastSent)}ms)`);
      return;
    }
    this.cooldowns.set(key, now);

    // ── Build message ────────────────────────────────────
    const typeLabel = side === 'long' ? 'LONG LIQUIDATIONS 🟢' : 'SHORT LIQUIDATIONS 🔴';

    const message = [
      `📊 Symbol: ${symbol}`,
      `📉 Type: ${typeLabel}`,
      `💰 Size (3s): ${formatUSD(L_now)}`,
      `📏 Baseline: ${formatUSD(baseline)}`,
      `📈 Ratio: ${ratio.toFixed(1)}x`,
      ``,
      `🔗 Bybit: https://www.bybit.com/trade/usdt/${symbol}`,
      `🔗 Coinglass: https://www.coinglass.com/tv/${symbol}`,
    ].join('\n');

    logger.info(`Dispatching alert: ${key}`);

    // ── Send to Telegram ─────────────────────────────────
    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
      this._sendTelegram(message).catch((err) => {
        logger.error('Telegram send failed', { error: err.message });
      });
    } else {
      logger.debug('Telegram not configured — skipping');
    }

    // ── Send to Pushover ─────────────────────────────────
    if (config.PUSHOVER_USER_KEY && config.PUSHOVER_APP_TOKEN) {
      this._sendPushover(message).catch((err) => {
        logger.error('Pushover send failed', { error: err.message });
      });
    } else {
      logger.debug('Pushover not configured — skipping');
    }

    // ── If nothing is configured, log the alert ──────────
    if (!config.TELEGRAM_BOT_TOKEN && !config.PUSHOVER_USER_KEY) {
      logger.warn('No alert channels configured! Alert would have been:');
      console.log(message);
    }
  }

  /**
   * Send a startup greeting to all configured alert channels.
   * Called once when the scanner starts, before symbol fetching.
   */
  async sendGreeting() {
    const message = [
      '🤖 Liquidation Scanner Started',
      '',
      `⏱️ Window: ${config.WINDOW_SIZE_MS}ms | Tick: ${config.WINDOW_TICK_MS}ms`,
      `📊 History: ${config.HISTORY_DURATION_MS / 60000}min`,
      `📋 Thresholds: loaded from config`,
      '',
      `⚡ Monitoring will begin after symbol fetch...`,
    ].join('\n');

    logger.info('Sending startup greeting...');

    // ── Send to Telegram ────────────────────────────────
    if (config.TELEGRAM_BOT_TOKEN && config.TELEGRAM_CHAT_ID) {
      try {
        if (!this.telegramBot) {
          this.telegramBot = new TelegramBot(config.TELEGRAM_BOT_TOKEN);
        }
        await this.telegramBot.sendMessage(config.TELEGRAM_CHAT_ID, message, {
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        });
        logger.info('✅ Telegram greeting sent');
      } catch (err) {
        logger.error('Telegram greeting failed', { error: err.message });
      }
    } else {
      logger.debug('Telegram not configured — skipping greeting');
    }

    // ── Send to Pushover ─────────────────────────────────
    if (config.PUSHOVER_USER_KEY && config.PUSHOVER_APP_TOKEN) {
      const params = new URLSearchParams({
        token: config.PUSHOVER_APP_TOKEN,
        user: config.PUSHOVER_USER_KEY,
        message,
        title: '🤖 Liquidation Scanner Started',
        priority: '0',
        sound: 'pushover',
      });

      const options = {
        hostname: 'api.pushover.net',
        path: '/1/messages.json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params.toString()),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.status === 1) {
              logger.info('✅ Pushover greeting sent');
            } else {
              logger.error('Pushover greeting failed', { response: JSON.stringify(parsed) });
            }
          } catch (err) {
            logger.error('Pushover greeting parse error', { error: err.message });
          }
        });
      });

      req.on('error', (err) => {
        logger.error('Pushover greeting request error', { error: err.message });
      });

      req.write(params.toString());
      req.end();
    } else {
      logger.debug('Pushover not configured — skipping greeting');
    }
  }

  /**
   * Send a message via Telegram Bot API using node-telegram-bot-api.
   * @param {string} text
   * @returns {Promise<void>}
   */
  _sendTelegram(text) {
    return new Promise((resolve, reject) => {
      try {
        if (!this.telegramBot) {
          this.telegramBot = new TelegramBot(config.TELEGRAM_BOT_TOKEN);
        }

        this.telegramBot.sendMessage(config.TELEGRAM_CHAT_ID, text, {
          parse_mode: 'Markdown',
          disable_web_page_preview: false,
        })
          .then(() => {
            logger.info('✅ Telegram alert sent');
            resolve();
          })
          .catch((err) => {
            reject(new Error(`Telegram send failed: ${err.message}`));
          });
      } catch (err) {
        reject(new Error(`Telegram init error: ${err.message}`));
      }
    });
  }

  /**
   * Send a notification via Pushover API.
   * @param {string} message
   * @returns {Promise<void>}
   */
  _sendPushover(message) {
    return new Promise((resolve, reject) => {
      const params = new URLSearchParams({
        token: config.PUSHOVER_APP_TOKEN,
        user: config.PUSHOVER_USER_KEY,
        message,
        title: '🚨 Liquidation Spike Alert',
        priority: '1', // High priority
        sound: 'siren',
      });

      const options = {
        hostname: 'api.pushover.net',
        path: '/1/messages.json',
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(params.toString()),
        },
      };

      const req = https.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data);
            if (parsed.status === 1) {
              logger.info('✅ Pushover alert sent');
              resolve();
            } else {
              reject(new Error(`Pushover API error: ${JSON.stringify(parsed)}`));
            }
          } catch (err) {
            reject(new Error(`Pushover response parse error: ${err.message}`));
          }
        });
      });

      req.on('error', (err) => {
        reject(new Error(`Pushover request error: ${err.message}`));
      });

      req.write(params.toString());
      req.end();
    });
  }
}

// Singleton
const alertService = new AlertService();
export default alertService;