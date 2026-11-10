/**
 * eval/outcome-mutations.js - Seeded source mutations for the task-outcome
 * eval's precommit-check tasks and seeded delete tasks.
 *
 * Every builder is pure: source text in, edited text plus the edit's own
 * line ranges out. Placement comes from the syntax tree (the callable's
 * `parameters` and `body` fields), never from line-shape guesses, so a
 * mutation lands where the grammar says the header and the body are. The
 * inserted text is a per-language template; that table is the only place a
 * language name selects behavior, and a language without a template simply
 * has no mutation of that kind.
 *
 * A builder returns null when the mutation cannot be placed cleanly on that
 * definition (single-line body, non-ASCII header line, no return to edit).
 * The runner then tries the next sampled definition.
 */

'use strict';

const path = require('path');
const { getParser, safeParse } = require('../languages');

const TEMPLATES = Object.freeze({
    python: {
        inert: 'pass',
        generator: 'yield None',
        nullReturn: 'None',
        param: 'ucnq_required',
        receiverNames: ['self', 'cls'],
    },
    go: { inert: '_ = 0', param: 'ucnqRequired int' },
    rust: { inert: 'let _ = 0;', param: 'ucnq_required: i32' },
    java: { inert: ';', param: 'int ucnqRequired' },
    javascript: { inert: ';', nullReturn: 'null', param: 'ucnqRequired' },
    typescript: { inert: ';', nullReturn: 'null', param: 'ucnqRequired: number' },
});

/** Columns are addressed only on lines where a column is a character. */
function isAscii(text) {
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) > 0x7f) return false;
    }
    return true;
}

function parse(language, content) {
    return safeParse(getParser(language), content);
}

/** The callable node that declares `def`: the nearest ancestor of the name
 *  token that owns a parameter list. */
function locateCallable(tree, lines, def) {
    const lineText = lines[def.nameLine - 1];
    if (lineText == null) return null;
    const pattern = new RegExp(`(?<![A-Za-z0-9_$])${def.name}(?![A-Za-z0-9_$])`);
    const match = pattern.exec(lineText);
    if (!match || !isAscii(lineText)) return null;
    const position = { row: def.nameLine - 1, column: match.index };
    let node = tree.rootNode.descendantForPosition(position);
    while (node) {
        if (node.childForFieldName('parameters')) {
            const name = node.childForFieldName('name');
            if (name && name.startPosition.row === position.row &&
                name.startPosition.column === position.column) return node;
        }
        node = node.parent;
    }
    return null;
}

function statements(body) {
    return body.namedChildren.filter(child => !/comment/.test(child.type));
}

function indentOf(line) {
    return line.match(/^[ \t]*/)[0];
}

function singleFile(relativePath, lines, changed) {
    return {
        files: [{ path: relativePath, content: lines.join('\n') }],
        changedRanges: [{ file: relativePath, ...changed }],
    };
}

/** Insert one statement line before the first statement of the body. */
function insertFirstStatement(input, statement) {
    const { language, relativePath, content, def } = input;
    if (!statement) return null;
    const lines = content.split('\n');
    const callable = locateCallable(parse(language, content), lines, def);
    const body = callable && callable.childForFieldName('body');
    if (!body) return null;
    const first = statements(body)[0];
    if (!first) return null;
    // A body that opens on the first statement's own line has no line of its
    // own to insert before.
    if (first.startPosition.row <= callable.startPosition.row ||
        first.startPosition.row === body.startPosition.row &&
            body.startPosition.column !== first.startPosition.column) return null;
    const row = first.startPosition.row;
    lines.splice(row, 0, indentOf(lines[row]) + statement);
    return singleFile(relativePath, lines, { startLine: row + 1, endLine: row + 1 });
}

/** A statement that cannot change any type: the clean body edit. */
function inertBodyEdit(input) {
    const template = TEMPLATES[input.language];
    return template ? insertFirstStatement(input, template.inert) : null;
}

function hasReturnAnnotation(callable) {
    return !!(callable.childForFieldName('return_type') || callable.childForFieldName('result'));
}

/** A body statement that changes the callable's kind with no header change.
 *  Only an unannotated callable is mutated: an annotated one would report
 *  the mismatch on its own header, which is not a dependent. */
function generatorTransition(input) {
    const template = TEMPLATES[input.language];
    if (!template || !template.generator) return null;
    const lines = input.content.split('\n');
    const callable = locateCallable(parse(input.language, input.content), lines, input.def);
    if (!callable || hasReturnAnnotation(callable)) return null;
    return insertFirstStatement(input, template.generator);
}

function ownReturns(body) {
    const found = [];
    const visit = node => {
        for (const child of node.namedChildren) {
            // A nested callable or class owns its own returns.
            if (child.childForFieldName('parameters') || /class/.test(child.type)) continue;
            if (child.type === 'return_statement') found.push(child);
            visit(child);
        }
    };
    visit(body);
    return found;
}

/** Replace the single returned expression of an unannotated callable with
 *  the language's null value: the header is untouched and the inferred
 *  return contract changes. */
function returnContractEdit(input) {
    const { language, relativePath, content, def } = input;
    const template = TEMPLATES[language];
    if (!template || !template.nullReturn) return null;
    const lines = content.split('\n');
    const callable = locateCallable(parse(language, content), lines, def);
    const body = callable && callable.childForFieldName('body');
    if (!body || hasReturnAnnotation(callable)) return null;
    const returns = ownReturns(body);
    if (returns.length !== 1) return null;
    const expression = returns[0].namedChildren[0];
    if (!expression || expression.startPosition.row !== expression.endPosition.row) return null;
    const row = expression.startPosition.row;
    const line = lines[row];
    if (!isAscii(line)) return null;
    const from = expression.startPosition.column;
    const to = expression.endPosition.column;
    if (line.slice(from, to) === template.nullReturn) return null;
    lines[row] = line.slice(0, from) + template.nullReturn + line.slice(to);
    return singleFile(relativePath, lines, { startLine: row + 1, endLine: row + 1 });
}

/** Add one required parameter without touching any call site. */
function requiredParam(input) {
    const { language, relativePath, content, def } = input;
    const template = TEMPLATES[language];
    if (!template || !template.param) return null;
    const lines = content.split('\n');
    const callable = locateCallable(parse(language, content), lines, def);
    const parameters = callable && callable.childForFieldName('parameters');
    if (!parameters) return null;
    const params = statements(parameters);
    const first = params[0];
    const receiverFirst = !!first && (first.type === 'self_parameter' ||
        (def.className && (template.receiverNames || []).some(name =>
            new RegExp(`^${name}\\b`).test(first.text))));
    let row;
    let column;
    let text;
    if (receiverFirst) {
        ({ row, column } = first.endPosition);
        text = `, ${template.param}`;
    } else if (first) {
        ({ row, column } = first.startPosition);
        text = `${template.param}, `;
    } else {
        row = parameters.startPosition.row;
        column = parameters.startPosition.column + 1;
        text = template.param;
        if (lines[row][column - 1] !== '(') return null;
    }
    if (!isAscii(lines[row])) return null;
    lines[row] = lines[row].slice(0, column) + text + lines[row].slice(column);
    return singleFile(relativePath, lines, {
        startLine: parameters.startPosition.row + 1,
        endLine: parameters.endPosition.row + 1,
    });
}

function appended(relativePath, content, snippetLines) {
    const base = content.endsWith('\n') ? content : `${content}\n`;
    const startLine = base.split('\n').length; // first appended line (1-based)
    return {
        content: `${base}${snippetLines.join('\n')}\n`,
        startLine,
        endLine: startLine + snippetLines.length - 1,
    };
}

function firstNodeOfType(tree, type) {
    return tree.rootNode.namedChildren.find(child => child.type === type) || null;
}

/** A novel-named callable nothing refers to: a new file where the language
 *  compiles every file of a directory, an appended item where files must be
 *  declared. */
function additiveSymbol(input, serial) {
    const { language, relativePath, content } = input;
    const dir = path.posix.dirname(relativePath);
    const inDir = name => (dir === '.' ? name : `${dir}/${name}`);
    const created = (file, text) => ({
        files: [{ path: file, content: text, created: true }],
        changedRanges: [{ file, startLine: 1, endLine: text.split('\n').length }],
    });
    switch (language) {
        case 'python':
            return created(inDir(`ucnq_added_${serial}.py`),
                `def ucnq_added_fn_${serial}(value):\n    return value\n`);
        case 'go': {
            const clause = firstNodeOfType(parse(language, content), 'package_clause');
            const name = clause && clause.namedChildren[0];
            if (!name) return null;
            return created(inDir(`ucnq_added_${serial}.go`),
                `package ${name.text}\n\nfunc ucnqAddedFn${serial}(value int) int {\n\treturn value\n}\n`);
        }
        case 'java': {
            const declaration = firstNodeOfType(parse(language, content), 'package_declaration');
            const header = declaration ? `${declaration.text}\n\n` : '';
            return created(inDir(`UcnqAdded${serial}.java`),
                `${header}final class UcnqAdded${serial} {\n` +
                `    static int ucnqAddedFn${serial}(int value) {\n        return value;\n    }\n}\n`);
        }
        case 'rust': {
            const result = appended(relativePath, content, [
                '',
                `fn ucnq_added_fn_${serial}(value: i32) -> i32 {`,
                '    value',
                '}',
            ]);
            return {
                files: [{ path: relativePath, content: result.content }],
                changedRanges: [{ file: relativePath,
                    startLine: result.startLine, endLine: result.endLine }],
            };
        }
        default:
            return null;
    }
}

function seeded(relativePath, content, snippetLines, target) {
    const result = appended(relativePath, content, snippetLines);
    const offset = result.startLine - 1;
    return {
        files: [{ path: relativePath, content: result.content }],
        changedRanges: [{ file: relativePath,
            startLine: result.startLine, endLine: result.endLine }],
        target: {
            name: target.name,
            relativePath,
            startLine: offset + target.startLine,
            endLine: offset + target.endLine,
            nameLine: offset + target.startLine,
            type: target.type,
            className: target.className || null,
            sameNameDefs: 1,
        },
    };
}

/** A private callable nothing refers to, appended to an existing file:
 *  deletable by construction. `allowDead` adds the language's own
 *  "unused is intended" marker for crates that deny warnings. */
function seededDeadAddition(input, serial, { allowDead = false } = {}) {
    const { language, relativePath, content } = input;
    switch (language) {
        case 'python':
            return seeded(relativePath, content, [
                '', '',
                `def _ucnq_seeded_dead_${serial}(value):`,
                '    return value',
            ], { name: `_ucnq_seeded_dead_${serial}`, startLine: 3, endLine: 4, type: 'function' });
        case 'go':
            return seeded(relativePath, content, [
                '',
                `func ucnqSeededDead${serial}(value int) int {`,
                '\treturn value',
                '}',
            ], { name: `ucnqSeededDead${serial}`, startLine: 2, endLine: 4, type: 'function' });
        case 'rust': {
            const attribute = allowDead ? ['#[allow(dead_code)]'] : [];
            return seeded(relativePath, content, [
                '',
                ...attribute,
                `fn ucnq_seeded_dead_${serial}(value: i32) -> i32 {`,
                '    value',
                '}',
            ], { name: `ucnq_seeded_dead_${serial}`,
                startLine: 2 + attribute.length, endLine: 4 + attribute.length, type: 'function' });
        }
        case 'java':
            return seeded(relativePath, content, [
                '',
                `final class UcnqSeededDead${serial} {`,
                `    private static int ucnqSeededDead${serial}(int value) {`,
                '        return value;',
                '    }',
                '}',
            ], { name: `ucnqSeededDead${serial}`, startLine: 3, endLine: 5,
                type: 'method', className: `UcnqSeededDead${serial}` });
        default:
            return null;
    }
}

/** The only implementation of a contract member, with no call by name: text
 *  evidence is zero and deleting it breaks the type. */
function seededContractBound(input, serial) {
    const { language, relativePath, content } = input;
    switch (language) {
        case 'python':
            return seeded(relativePath, content, [
                '', '',
                `import abc as _ucnq_abc_${serial}`,
                '', '',
                `class _UcnqContract${serial}(_ucnq_abc_${serial}.ABC):`,
                `    @_ucnq_abc_${serial}.abstractmethod`,
                `    def ucnq_slot_${serial}(self):`,
                '        raise NotImplementedError',
                '', '',
                `class _UcnqImpl${serial}(_UcnqContract${serial}):`,
                '    ucnq_marker = 1',
                '',
                `    def ucnq_slot_${serial}(self):`,
                '        return 1',
                '', '',
                `_UCNQ_INSTANCE_${serial} = _UcnqImpl${serial}()`,
            ], { name: `ucnq_slot_${serial}`, startLine: 15, endLine: 16,
                type: 'method', className: `_UcnqImpl${serial}` });
        case 'go':
            return seeded(relativePath, content, [
                '',
                `type ucnqContract${serial} interface {`,
                `\tucnqSlot${serial}() int`,
                '}',
                '',
                `type ucnqImpl${serial} struct{}`,
                '',
                `func (ucnqImpl${serial}) ucnqSlot${serial}() int {`,
                '\treturn 1',
                '}',
                '',
                `var _ ucnqContract${serial} = ucnqImpl${serial}{}`,
            ], { name: `ucnqSlot${serial}`, startLine: 8, endLine: 10,
                type: 'method', className: `ucnqImpl${serial}` });
        case 'rust':
            return seeded(relativePath, content, [
                '',
                '#[allow(dead_code)]',
                `trait UcnqContract${serial} {`,
                `    fn ucnq_slot_${serial}(&self) -> i32;`,
                '}',
                '',
                '#[allow(dead_code)]',
                `struct UcnqImpl${serial};`,
                '',
                `impl UcnqContract${serial} for UcnqImpl${serial} {`,
                `    fn ucnq_slot_${serial}(&self) -> i32 {`,
                '        1',
                '    }',
                '}',
            ], { name: `ucnq_slot_${serial}`, startLine: 11, endLine: 13,
                type: 'method', className: `UcnqImpl${serial}` });
        case 'java':
            return seeded(relativePath, content, [
                '',
                `interface UcnqContract${serial} {`,
                `    int ucnqSlot${serial}();`,
                '}',
                '',
                `final class UcnqImpl${serial} implements UcnqContract${serial} {`,
                `    public int ucnqSlot${serial}() {`,
                '        return 1;',
                '    }',
                '}',
            ], { name: `ucnqSlot${serial}`, startLine: 7, endLine: 9,
                type: 'method', className: `UcnqImpl${serial}` });
        default:
            return null;
    }
}

/** Builders for the body and header kinds, keyed by check-task kind. The
 *  additive and delete kinds are driven by the runner. */
const DEFINITION_MUTATIONS = Object.freeze({
    'inert-body-edit': inertBodyEdit,
    'return-contract-edit': returnContractEdit,
    'generator-transition': generatorTransition,
    'required-param': requiredParam,
});

module.exports = {
    TEMPLATES,
    DEFINITION_MUTATIONS,
    inertBodyEdit,
    generatorTransition,
    returnContractEdit,
    requiredParam,
    additiveSymbol,
    seededDeadAddition,
    seededContractBound,
};
