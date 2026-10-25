'use strict';

/** Whether the written call lies inside the declaration's AST extent. */
function containsCall(definition, call) {
    const span = definition?.sourceSpan;
    if (!span || call?.macroExpansion || definition.macroExpansion || definition.generatedByMacro) return null;
    const line = call.line, column = call.column ?? call.callSite?.column;
    if (!Number.isInteger(line) || !Number.isInteger(span.startLine) || !Number.isInteger(span.endLine)) return null;
    if (line < span.startLine || line > span.endLine) return false;
    if (Number.isInteger(column)) {
        return (line > span.startLine || column >= span.startColumn) &&
            (line < span.endLine || column < span.endColumn);
    }
    const start = call.callStart ?? call.callSite?.start;
    if (Number.isInteger(start) && Number.isInteger(span.start) && Number.isInteger(span.end)) {
        return start >= span.start && start < span.end;
    }
    return null;
}

module.exports = { containsCall };
