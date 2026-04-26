/**
 * Format a number as a human-readable USD string.
 * Examples: formatUSD(1250000) → "$1.25M", formatUSD(300000) → "$300k", formatUSD(500) → "$500"
 * @param {number} value
 * @returns {string}
 */
export function formatUSD(value) {
  if (value == null || isNaN(value)) {
    return '$0';
  }

  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';

  if (abs >= 1_000_000) {
    const millions = abs / 1_000_000;
    // Show 2 decimal places if needed, otherwise 1
    const formatted = millions % 1 === 0
      ? `${millions.toFixed(0)}M`
      : millions >= 10
        ? `${millions.toFixed(1)}M`
        : `${millions.toFixed(2)}M`;
    return `${sign}$${formatted}`;
  }

  if (abs >= 1_000) {
    const thousands = abs / 1_000;
    const formatted = thousands % 1 === 0
      ? `${thousands.toFixed(0)}k`
      : `${thousands.toFixed(1)}k`;
    return `${sign}$${formatted}`;
  }

  return `${sign}$${abs.toFixed(0)}`;
}

export default formatUSD;