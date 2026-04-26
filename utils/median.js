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