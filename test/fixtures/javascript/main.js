/**
 * Main entry point for the JavaScript test fixtures.
 * Tests various JavaScript constructs.
 */

const { helper, utilFunc } = require('./utils');
const Service = require('./service');

// Constants
const CONFIG = {
  timeout: 5000,
  retries: 3
};

/**
 * Process data using the helper function.
 * @param {Object} data - Input data
 * @returns {Object} Processed data
 */
function processData(data) {
  const validated = validateInput(data);
  const result = helper(validated);
  return transformOutput(result);
}

// Arrow function
const validateInput = (input) => {
  if (!input) {
    throw new Error('Input is required');
  }
  return { ...input, validated: true };
};

/**
 * Transform the output data.
 */
function transformOutput(data) {
  return {
    ...data,
    transformed: true,
    timestamp: Date.now()
  };
}

// Async function
async function fetchAndProcess(url) {
  const service = new Service();
  const response = await service.fetch(url);
  return processData(response);
}

// Higher-order function
function createProcessor(transformer) {
  return function(data) {
    const processed = processData(data);
    return transformer(processed);
  };
}

// Function with callback
function processWithCallback(data, callback) {
  try {
    const result = processData(data);
    callback(null, result);
  } catch (err) {
    callback(err, null);
  }
}

// Generator function
function* dataGenerator(items) {
  for (const item of items) {
    yield processData(item);
  }
}

// Class usage
class DataProcessor {
  constructor(config = CONFIG) {
    this.config = config;
    this.service = new Service();
  }

  async process(data) {
    return fetchAndProcess(data);
  }

  static create(config) {
    return new DataProcessor(config);
  }
}

// Immediately invoked
const initialized = (function() {
  return { ready: true };
})();

// Default export simulation
module.exports = {
  processData,
  validateInput,
  transformOutput,
  fetchAndProcess,
  createProcessor,
  processWithCallback,
  dataGenerator,
  DataProcessor,
  CONFIG
};
