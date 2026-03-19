/**
 * core/output.js - Re-export facade
 *
 * All formatters are split into domain files under core/output/.
 * This file re-exports everything so consumers don't need to change.
 *
 * KEY PRINCIPLE: Never truncate critical information.
 * Full expressions, full signatures, full context.
 */

module.exports = {
    ...require('./output/shared'),
    ...require('./output/tracing'),
    ...require('./output/analysis'),
    ...require('./output/analysis-ext'),
    ...require('./output/find'),
    ...require('./output/search'),
    ...require('./output/graph'),
    ...require('./output/extraction'),
    ...require('./output/reporting'),
    ...require('./output/refactoring'),
};
