/**
 * Calculate the median of an array of numbers.
 * Returns 0 for an empty array.
 * @param {number[]} values
 * @returns {number}
 */
/**
 * Calculate the p-th percentile of an array of numbers using the nearest-rank method.
 * Returns 0 for an empty array.
 * @param {number[]} values
 * @param {number} percentile - Between 0 and 1 (e.g. 0.75 for 75th percentile)
 * @returns {number}
 */
export function getPercentile(values, percentile) {
  if (!values || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil(sorted.length * percentile) - 1;
  const clamped = Math.max(0, Math.min(index, sorted.length - 1));
  return sorted[clamped];
}

/**
 * Calculate the median of an array of numbers.
 * Returns 0 for an empty array.
 * @param {number[]} values
 * @returns {number}
 */
export function median(values) {
  if (!values || values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
}

export default median;