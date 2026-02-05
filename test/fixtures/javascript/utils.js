/**
 * Utility functions for data manipulation.
 */

/**
 * Helper function that processes input.
 * @param {any} input - The input to process
 * @returns {any} The processed output
 */
function helper(input) {
  return formatData(input);
}

/**
 * Format data for output.
 */
function formatData(data) {
  if (Array.isArray(data)) {
    return data.map(item => formatItem(item));
  }
  return formatItem(data);
}

/**
 * Format a single item.
 */
function formatItem(item) {
  return {
    ...item,
    formatted: true
  };
}

/**
 * Utility function for string operations.
 */
const utilFunc = (str) => {
  return str.trim().toLowerCase();
};

/**
 * Deep clone an object.
 */
function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

/**
 * Merge multiple objects.
 */
function mergeObjects(...objects) {
  return objects.reduce((acc, obj) => ({ ...acc, ...obj }), {});
}

// Unused function (for deadcode detection)
function unusedHelper() {
  return 'never called';
}

module.exports = {
  helper,
  formatData,
  formatItem,
  utilFunc,
  deepClone,
  mergeObjects
};
