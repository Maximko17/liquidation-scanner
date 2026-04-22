require('dotenv').config();

module.exports = {
  BYBIT_BASE_URL: process.env.BYBIT_BASE_URL || 'https://api.bybit.com',
  FETCH_INTERVAL_MS: parseInt(process.env.FETCH_INTERVAL_MS, 10) || 600000,
  FILTER_VOLUME_THRESHOLD: parseFloat(process.env.FILTER_VOLUME_THRESHOLD) || 30000000,
  FILTER_OI_THRESHOLD: parseFloat(process.env.FILTER_OI_THRESHOLD) || 10000000,
  LOG_LEVEL: process.env.LOG_LEVEL || 'info'
};