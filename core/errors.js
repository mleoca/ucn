/**
 * core/errors.js - Refusals versus internal errors.
 *
 * A refusal is an answer about the request: bad input, a missing git
 * repository, an invalid regular expression, an unreadable file. An internal
 * error is an exception inside UCN (a TypeError in the engine, a broken
 * invariant): a defect, never an answer about the code. Every surface marks
 * the second kind so a caller can tell "UCN declined" from "UCN failed".
 */

'use strict';

/** A deliberate refusal raised as an exception deep inside the engine. */
class UcnError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = 'UcnError';
    }
}

const INTERNAL_ERROR_PREFIX = 'Internal error:';

/**
 * True when `error` is a defect inside UCN rather than a refusal or an
 * operating-system failure (unreadable file, permission, missing binary).
 */
function isInternalError(error) {
    if (!error || typeof error !== 'object') return true;
    if (error instanceof UcnError || error.name === 'UcnError') return false;
    if (typeof error.code === 'string' && typeof error.syscall === 'string') return false;
    return true;
}

/** The message every surface prints for an internal error. */
function internalErrorMessage(error) {
    const detail = error && typeof error === 'object' && error.message ? error.message : String(error);
    return `${INTERNAL_ERROR_PREFIX} ${detail} (a defect in UCN, not an answer about the code; the command did not complete)`;
}

/** `{ error, internalError? }` for an exception caught at a surface. */
function describeError(error) {
    if (isInternalError(error)) return { error: internalErrorMessage(error), internalError: true };
    return { error: error.message };
}

module.exports = {
    UcnError,
    INTERNAL_ERROR_PREFIX,
    isInternalError,
    internalErrorMessage,
    describeError,
};
