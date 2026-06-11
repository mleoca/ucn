// Legacy module — the benchmark runner injects this file into
// index.failedFiles to simulate a parse failure. Its call sites are invisible
// to UCN's index; the ucn-contract arm must discover them via the unparsed
// WARNING escalation (grep fallback for unparsed files).
const { dispatchNote } = require("../src/notifications/dispatcher");

function notifyLegacyOrder(order) {
    dispatchNote("legacy", order);
}

module.exports = { notifyLegacyOrder };
