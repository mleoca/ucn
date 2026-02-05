/**
 * Service class for external operations.
 */

const { deepClone, mergeObjects } = require('./utils');

class Service {
  constructor(options = {}) {
    this.baseUrl = options.baseUrl || 'https://api.example.com';
    this.timeout = options.timeout || 5000;
    this.headers = mergeObjects({ 'Content-Type': 'application/json' }, options.headers || {});
  }

  /**
   * Fetch data from a URL.
   * @param {string} url - The URL to fetch
   * @returns {Promise<Object>} The response data
   */
  async fetch(url) {
    const fullUrl = this.buildUrl(url);
    const response = await this.makeRequest(fullUrl);
    return this.parseResponse(response);
  }

  /**
   * Build the full URL.
   */
  buildUrl(path) {
    if (path.startsWith('http')) {
      return path;
    }
    return `${this.baseUrl}${path}`;
  }

  /**
   * Make the HTTP request.
   */
  async makeRequest(url) {
    // Simulated request
    return {
      status: 200,
      data: { url, timestamp: Date.now() }
    };
  }

  /**
   * Parse the response data.
   */
  parseResponse(response) {
    if (response.status !== 200) {
      throw new Error(`Request failed: ${response.status}`);
    }
    return deepClone(response.data);
  }

  /**
   * Post data to a URL.
   */
  async post(url, data) {
    const fullUrl = this.buildUrl(url);
    const response = await this.makeRequest(fullUrl, 'POST', data);
    return this.parseResponse(response);
  }
}

// Singleton instance
let instance = null;

/**
 * Get the singleton service instance.
 */
function getService(options) {
  if (!instance) {
    instance = new Service(options);
  }
  return instance;
}

/**
 * Reset the singleton (for testing).
 */
function resetService() {
  instance = null;
}

module.exports = Service;
module.exports.getService = getService;
module.exports.resetService = resetService;
