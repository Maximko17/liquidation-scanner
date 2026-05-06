import { EMA } from 'technicalindicators';
import config from '../config/index.js';
import logger from '../utils/logger.js';

/**
 * EMA Market Regime Service
 *
 * EMA is NOT a signal trigger — it's ONLY contextual interpretation.
 * Calculated ONLY during final 60s analysis (never on every tick).
 *
 * Determines market regime from EMA60 and EMA300,
 * provides a contextual label and ±1 confidence adjustment.
 */

/** @enum {string} */
const REGIME = {
  BULLISH: 'BULLISH',
  BEARISH: 'BEARISH',
  RANGE: 'RANGE',
  TRANSITION: 'TRANSITION',
};

/**
 * Extract prices from the price buffer using a plain for-loop.
 * @param {Array<{ price: number, time: number }>} buffer
 * @returns {number[]}
 */
function extractPrices(buffer) {
  const prices = [];
  for (let i = 0, len = buffer.length; i < len; i++) {
    prices.push(buffer[i].price);
  }
  return prices;
}

/**
 * Determine market regime from price, EMA60 and EMA300.
 *
 * @param {number} priceNow - Current price (p60)
 * @param {number} ema60 - Latest EMA60 value
 * @param {number} ema300 - Latest EMA300 value
 * @returns {string} REGIME constant
 */
function determineRegime(priceNow, ema60, ema300) {
  // Bullish: price > EMA60 > EMA300
  if (priceNow > ema60 && ema60 > ema300) {
    return REGIME.BULLISH;
  }

  // Bearish: price < EMA60 < EMA300
  if (priceNow < ema60 && ema60 < ema300) {
    return REGIME.BEARISH;
  }

  // Range: EMA60 and EMA300 are very close (< threshold%)
  const distance = Math.abs(ema60 - ema300) / ema300 * 100;
  if (distance < config.EMA_RANGE_THRESHOLD) {
    return REGIME.RANGE;
  }

  // All other cases → transition / mixed
  return REGIME.TRANSITION;
}

/**
 * Compute EMA confidence adjustment based on regime, classification and side.
 *
 * Max impact: ±1. Never dominates the score.
 *
 * @param {string} regime - REGIME constant
 * @param {string} classification - 'STRONG_CONTINUATION' | 'REVERSAL' | 'ABSORPTION' | 'IGNORE'
 * @param {string} side - 'long' | 'short'
 * @returns {number} -1, 0, or +1
 */
function getConfidenceAdjustment(regime, classification, side) {
  // TRANSITION: no adjustment
  if (regime === REGIME.TRANSITION) return 0;

  // RANGE: reversal gets +1, continuation 0
  if (regime === REGIME.RANGE) {
    if (classification === 'REVERSAL') return 1;
    return 0;
  }

  // Determine price direction from classification + side
  // LONG squeeze → price goes UP   | SHORT cascade → price goes DOWN
  // CONTINUATION = price continues in squeeze direction
  // REVERSAL = price goes opposite to squeeze direction
  const isUpward = (classification === 'STRONG_CONTINUATION' && side === 'long')
    || (classification === 'REVERSAL' && side === 'short');
  const isDownward = (classification === 'REVERSAL' && side === 'long')
    || (classification === 'STRONG_CONTINUATION' && side === 'short');

  // BULLISH: trend is UP
  if (regime === REGIME.BULLISH) {
    if (isUpward && classification === 'STRONG_CONTINUATION') return 1;   // continuation upward
    if (isDownward && classification === 'REVERSAL') return -1;           // reversal downward
    return 0;
  }

  // BEARISH: trend is DOWN
  if (regime === REGIME.BEARISH) {
    if (isDownward && classification === 'REVERSAL') return 1;            // reversal downward
    if (isUpward && classification === 'STRONG_CONTINUATION') return -1;  // continuation upward
    return 0;
  }

  return 0;
}

/**
 * Build the Trend output lines for the alert message.
 *
 * @param {number} priceNow
 * @param {number} ema60
 * @param {number} ema300
 * @param {string} regime
 * @param {number} confidenceAdjustment
 * @returns {string[]} Lines to append to alert message (without leading/trailing newlines)
 */
function buildTrendLines(priceNow, ema60, ema300, regime, confidenceAdjustment) {
  const lines = [];

  // Trend comparison line
  if (regime === REGIME.BULLISH) {
    lines.push('price > EMA60 > EMA300');
  } else if (regime === REGIME.BEARISH) {
    lines.push('price < EMA60 < EMA300');
  } else if (regime === REGIME.RANGE) {
    lines.push('EMA60 ≈ EMA300 (ranging)');
  } else {
    // TRANSITION — show actual relationship
    const priceVsEma60 = priceNow >= ema60 ? '>' : '<';
    const emaVsEma = ema60 >= ema300 ? '>' : '<';
    lines.push(`price ${priceVsEma60} EMA60, EMA60 ${emaVsEma} EMA300 (transition)`);
  }

  // Regime label
  const regimeLabels = {
    [REGIME.BULLISH]: '→ bullish regime',
    [REGIME.BEARISH]: '→ bearish regime',
    [REGIME.RANGE]: '→ ranging market',
    [REGIME.TRANSITION]: '→ mixed / transition regime',
  };
  lines.push(regimeLabels[regime]);

  // EMA context (how regime affects this signal)
  let context;
  if (confidenceAdjustment > 0) {
    context = '→ EMA context: supports continuation';
  } else if (confidenceAdjustment < 0) {
    context = '→ EMA context: against current squeeze';
  } else {
    context = '→ EMA context: neutral';
  }
  lines.push(context);

  return lines;
}

/**
 * Analyze market regime for a symbol at signal finalization time.
 *
 * Uses existing priceBuffer — no new buffer allocation.
 * Called ONLY in _finalize() (once per signal, every ~60s).
 *
 * @param {Map<string, Array<{ price: number, time: number }>>} priceBuffer
 * @param {string} symbol
 * @param {string} classification - 'STRONG_CONTINUATION' | 'REVERSAL' | 'ABSORPTION' | 'IGNORE'
 * @param {string} side - 'long' | 'short'
 * @param {number} priceNow - Price at t+60s (p60)
 * @returns {{
 *   regime: string,
 *   ema60: number|null,
 *   ema300: number|null,
 *   emaContext: string,
 *   confidenceAdjustment: number,
 *   trendLines: string[]
 * } | null} null if insufficient data for EMA calculation
 */
export function analyzeRegime(priceBuffer, symbol, classification, side, priceNow) {
  const buffer = priceBuffer.get(symbol);
  if (!buffer || buffer.length < 300) {
    logger.debug(`EMA: insufficient data for ${symbol} (buffer length=${buffer?.length || 0}, need ≥300)`);
    return null;
  }

  // Extract prices via plain for-loop
  const prices = extractPrices(buffer);

  // Calculate EMA60 and EMA300
  const ema60Values = EMA.calculate({ period: 60, values: prices });
  const ema300Values = EMA.calculate({ period: 300, values: prices });

  if (!ema60Values.length || !ema300Values.length) {
    logger.debug(`EMA: calculation failed for ${symbol}`);
    return null;
  }

  const ema60 = ema60Values[ema60Values.length - 1];
  const ema300 = ema300Values[ema300Values.length - 1];

  // Determine regime
  const regime = determineRegime(priceNow, ema60, ema300);

  // Confidence adjustment
  const confidenceAdjustment = getConfidenceAdjustment(regime, classification, side);

  // Build output lines
  const trendLines = buildTrendLines(priceNow, ema60, ema300, regime, confidenceAdjustment);

  const emaContext = trendLines[trendLines.length - 1]; // last line is the context

  logger.debug(
    `EMA ${symbol}: regime=${regime} ema60=${ema60.toFixed(4)} ema300=${ema300.toFixed(4)} adjustment=${confidenceAdjustment}`
  );

  return {
    regime,
    ema60,
    ema300,
    emaContext,
    confidenceAdjustment,
    trendLines,
  };
}

export { REGIME };