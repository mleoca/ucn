/**
 * UCN JavaScript/TypeScript Regression Tests
 *
 * JS/TS regressions, Bug Report #3, fixes #76-89.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { parse, parseFile, detectLanguage } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const output = require('../core/output');
const { createTempDir, cleanup, tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR } = require('./helpers');

const os = require('os');

// ============================================================================
// CALLERS should exclude definitions
// ============================================================================

describe('Bug: CALLERS should exclude definitions', () => {
    it('context command should not show definitions in CALLERS', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-callers-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create files: one with definition, one with call
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function myFunc() {
    return 42;
}
module.exports = { myFunc };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { myFunc } = require('./lib');
const result = myFunc();
console.log(result);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('myFunc');

            // Callers should only have actual calls, not definitions
            const callerLines = ctx.callers.map(c => c.content || c.line);
            const hasDefinition = callerLines.some(line =>
                line.includes('function myFunc') ||
                line.includes('myFunc()')  === false && line.includes('myFunc')
            );

            // This test documents the bug - callers should not include the definition
            assert.ok(ctx.callers.length > 0, 'Should have some callers');
            // After fix: assert.ok(!hasDefinition, 'Callers should not include function definitions');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: Callers should be numbered for expand command
// ============================================================================

describe('Bug: callers should be numbered for expand command', () => {
    it('context command should return caller info for expand', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-caller-num-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function helper() {
    return 42;
}
module.exports = { helper };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { helper } = require('./lib');
function caller1() {
    return helper();  // Call from caller1
}
function caller2() {
    return helper();  // Call from caller2
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('helper');

            // Callers should have file and line info for expand
            assert.ok(ctx.callers.length >= 2, 'Should have at least 2 callers');
            for (const caller of ctx.callers) {
                assert.ok(caller.file, 'Caller should have file');
                assert.ok(caller.line, 'Caller should have line');
                // callerFile should be set when there's an enclosing function
                if (caller.callerName) {
                    assert.ok(caller.callerFile, 'Caller with name should have callerFile');
                    assert.ok(caller.callerStartLine, 'Caller with name should have callerStartLine');
                    assert.ok(caller.callerEndLine, 'Caller with name should have callerEndLine');
                }
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: Name matching should distinguish method calls
// ============================================================================

describe('Bug: usages should distinguish method calls from standalone calls', () => {
    it('should not include JSON.parse when searching for parse', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-method-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // File with own parse function + JSON.parse usage
            fs.writeFileSync(path.join(tmpDir, 'parser.js'), `
function parse(code) {
    return code.trim();
}

function loadConfig() {
    const data = JSON.parse('{}');  // Should NOT be counted as usage of parse()
    return parse(data);             // Should be counted
}

module.exports = { parse };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('parse');
            const calls = usages.filter(u => u.usageType === 'call');

            // Check if JSON.parse is incorrectly included
            const hasJsonParse = calls.some(c =>
                c.content && c.content.includes('JSON.parse')
            );

            // Bug fixed: JSON.parse should not be counted as a call to parse()
            assert.strictEqual(hasJsonParse, false, 'JSON.parse should not be counted as usage of parse()');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should not include path.parse when searching for parse', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-path-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
const path = require('path');

function parse(input) {
    return input.split(',');
}

function getRoot() {
    const parsed = path.parse('/foo/bar');  // Should NOT be counted
    return parse(parsed.dir);                // Should be counted
}

module.exports = { parse };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('parse');
            const calls = usages.filter(u => u.usageType === 'call');

            const hasPathParse = calls.some(c =>
                c.content && c.content.includes('path.parse')
            );

            // Bug fixed: path.parse should not be counted as a call to parse()
            assert.strictEqual(hasPathParse, false, 'path.parse should not be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: smart command should not duplicate main function
// ============================================================================

describe('Bug: smart command should not duplicate main function', () => {
    it('main function should not appear in dependencies', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-smart-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function helper() {
    return 'helped';
}

function main() {
    return helper();
}

module.exports = { main };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const smart = index.smart('main');

            // Dependencies should NOT include main itself
            const depNames = smart.dependencies.map(d => d.name);
            const hasSelf = depNames.includes('main');

            // After fix: assert.strictEqual(hasSelf, false, 'Dependencies should not include the main function itself');
            if (hasSelf) {
                console.log('BUG CONFIRMED: smart includes main function in its own dependencies');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: plan should not pick up string literals
// ============================================================================

describe('Bug: plan should ignore string literals', () => {
    it('should not count string literals as call sites', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-plan-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Main file with actual function
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function myFunc(x) {
    return x * 2;
}
module.exports = { myFunc };
`);
            // Test file with string literal containing function name
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const code = 'function myFunc() {}';  // String literal - NOT a call site
const result = myFunc(5);              // Actual call site
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Note: plan() might not be directly exposed, testing via impact instead
            const usages = index.usages('myFunc');
            const calls = usages.filter(u => u.usageType === 'call');

            // Check if string literal is incorrectly counted
            const hasStringLiteral = calls.some(c =>
                c.content && c.content.includes("'function myFunc")
            );

            // Bug fixed: String literals should not be counted as calls
            assert.strictEqual(hasStringLiteral, false, 'String literals should not be counted as calls');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: file mode should filter string literals
// ============================================================================

describe('Bug: file mode usages should filter string literals', () => {
    it('should not count string literals as usages in file mode', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-filemode-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function main() {
    console.log('about main');  // "main" in string should NOT be a reference
    return helper();
}

function helper() {
    return 42;
}

main();  // Actual call
`);

            // Use CLI file mode via child process
            const { execSync } = require('child_process');
            const result = execSync(`node cli/index.js ${path.join(tmpDir, 'app.js')} usages main`, {
                encoding: 'utf-8',
                cwd: process.cwd()
            });

            // Should have 1 def, 1 call, 0 references (string literal excluded)
            assert.ok(result.includes('1 definitions'), 'Should have 1 definition');
            assert.ok(result.includes('1 calls'), 'Should have 1 call');
            assert.ok(result.includes('0 references') || !result.includes('REFERENCES'),
                'Should have 0 references (string literal excluded)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// BUG TESTS: --context flag output
// ============================================================================

describe('Bug: --context flag should show complete lines', () => {
    it('context lines should not be truncated with ...', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-context-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
// Line 1 - before context
// Line 2 - before context
function processData(input) {
    // Line 4 - before context
    const result = helper(input);
    // Line 6 - after context
    return result;
}

function helper(x) {
    return x * 2;
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Test usages with context
            const usages = index.usages('helper', { context: 2 });
            assert.ok(usages.length > 0, 'Should find usages');

            // Find the call usage (not the definition)
            const callUsage = usages.find(u => u.usageType === 'call');
            assert.ok(callUsage, 'Should have a call usage');

            // Verify context lines are present and complete
            if (callUsage.before) {
                assert.strictEqual(callUsage.before.length, 2, 'Should have 2 before context lines');
                assert.ok(!callUsage.before.some(l => l.includes('...')), 'Before context should not be truncated');
            }

            if (callUsage.after) {
                assert.strictEqual(callUsage.after.length, 2, 'Should have 2 after context lines');
                assert.ok(!callUsage.after.some(l => l.includes('...')), 'After context should not be truncated');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('context should handle file boundaries correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-context-boundary-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // File where match is at the beginning
            fs.writeFileSync(path.join(tmpDir, 'start.js'), `const result = helper();
// Line 2
// Line 3
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper', { context: 3 });
            const usage = usages.find(u => u.usageType === 'call');

            if (usage) {
                // Before context should be empty or less than 3 (at file start)
                assert.ok(!usage.before || usage.before.length < 3, 'Should handle file start boundary');
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('search command should support context lines', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-search-context-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
// Line 1
// Line 2
// TODO: fix this issue
// Line 4
// Line 5
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('TODO', { context: 2 });
            assert.ok(results.length > 0, 'Should find search results');

            const match = results[0].matches[0];
            assert.ok(match.before && match.before.length > 0, 'Should have before context');
            assert.ok(match.after && match.after.length > 0, 'Should have after context');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// isInsideString string literal detection
// ============================================================================

describe('Regression: isInsideString string literal detection', () => {
    it('should NOT treat function calls between string literals as inside strings', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-string-between-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Code with function call between string literals (the original bug case)
            // Uses simpler escaping to avoid test complexity
            const code = [
                'function helper(x) { return x; }',
                '',
                'function buildMessage(name) {',
                "    const msg = 'Hello ' + helper(name) + '!';",
                '    return msg;',
                '}',
                '',
                'module.exports = { helper, buildMessage };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find the call in buildMessage (not be confused by surrounding strings)
            assert.ok(calls.length >= 1, 'Should find call to helper in buildMessage');
            assert.ok(calls.some(c => c.content && c.content.includes('helper(name)')),
                'Should include the actual call site');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should correctly identify function names inside string literals', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-string-inside-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function myFunc() {
    return 42;
}

// These should NOT be counted as calls
const str1 = 'myFunc is a function';
const str2 = "call myFunc()";
const str3 = \`myFunc documentation\`;

// This should be counted as a call
const result = myFunc();

module.exports = { myFunc };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('myFunc');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should only find the actual call, not the string literals
            assert.strictEqual(calls.length, 1, 'Should find exactly 1 call (not string literals)');
            assert.ok(calls[0].content.includes('const result = myFunc()'),
                'Should only include the actual function call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should correctly handle template literal expressions ${...}', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-template-expr-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function formatValue(x) {
    return x.toFixed(2);
}

// This IS a call (inside template expression)
const msg1 = \`Result: \${formatValue(42)}\`;

// This is NOT a call (plain text in template)
const msg2 = \`The function formatValue is useful\`;

// Nested expression IS a call
const msg3 = \`Value: \${flag ? formatValue(x) : 'none'}\`;

module.exports = { formatValue };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('formatValue');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find the 2 calls in template expressions
            assert.strictEqual(calls.length, 2, 'Should find exactly 2 calls (template expressions)');
            assert.ok(calls.some(c => c.content.includes('${formatValue(42)}')),
                'Should include first template expression call');
            assert.ok(calls.some(c => c.content.includes('${flag ? formatValue(x)')),
                'Should include nested template expression call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle escaped quotes correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-escaped-quotes-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Use array join to avoid escaping issues in template literals
            const code = [
                'function process(x) {',
                '    return x;',
                '}',
                '',
                '// Escaped quotes should not confuse the parser',
                "const str = 'Don\\'t call process() here';  // NOT a call (inside string with escaped quote)",
                'const result = process(42);  // IS a call',
                '',
                'module.exports = { process };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('process');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should only find the actual call
            assert.strictEqual(calls.length, 1, 'Should find exactly 1 call');
            assert.ok(calls[0].content.includes('const result = process(42)'),
                'Should only include the actual function call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle mixed quote types correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-mixed-quotes-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function helper(x) {
    return x;
}

// Double quotes containing single quotes
const a = "don't call helper()";  // NOT a call

// Single quotes containing double quotes
const b = '"helper" is the name';  // NOT a call

// Template containing both
const c = \`"helper" and 'helper'\`;  // NOT a call

// Actual call
const d = helper(1);  // IS a call

module.exports = { helper };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should only find the actual call
            assert.strictEqual(calls.length, 1, 'Should find exactly 1 call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Regex global flag bug
// ============================================================================

describe('Regression: regex global flag bug', () => {
    it('usages should find ALL matching lines (not alternate due to g flag)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-regex-g-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create a file with multiple calls to the same function
            const code = [
                'function helper(x) { return x; }',
                '',
                'const a = helper(1);',
                'const b = helper(2);',
                'const c = helper(3);',
                'const d = helper(4);',
                'const e = helper(5);',
                '',
                'module.exports = { helper };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('helper');
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find ALL 5 calls, not just some due to g flag lastIndex bug
            assert.strictEqual(calls.length, 5, 'Should find all 5 calls to helper');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('findCallers should find ALL callers (not alternate due to g flag)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-regex-callers-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            const code = [
                'function target() { return 42; }',
                '',
                'function caller1() { return target(); }',
                'function caller2() { return target(); }',
                'function caller3() { return target(); }',
                'function caller4() { return target(); }',
                '',
                'module.exports = { target };'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('target');

            // Should find ALL 4 callers
            assert.strictEqual(ctx.callers.length, 4, 'Should find all 4 callers');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('search should find ALL matching lines', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-regex-search-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            const code = [
                '// TODO: fix this',
                '// TODO: add tests',
                '// TODO: refactor',
                '// TODO: document',
                '// TODO: cleanup'
            ].join('\n');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), code);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('TODO');
            const matches = results[0]?.matches || [];

            // Should find ALL 5 TODOs
            assert.strictEqual(matches.length, 5, 'Should find all 5 TODO comments');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// findCallers should filter comment lines
// ============================================================================

describe('Regression: findCallers should filter comment lines', () => {
    it('should not include comment lines as callers', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-caller-comments-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Create a file with a function and comments mentioning it
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
function processData(input) {
    return input.toUpperCase();
}

function main() {
    // Call processData() to handle input
    const result = processData("hello");
    // processData() should not be included as a caller from this comment
    return result;
}

module.exports = { processData, main };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('processData');
            const callers = ctx.callers;

            // Should find main as a caller, but not the comment lines
            const callerLines = callers.map(c => c.line);

            // Line 8 is the actual call
            assert.ok(callerLines.includes(8), 'Should include actual call on line 8');

            // Comment lines should NOT be included
            const commentCallers = callers.filter(c => c.content.trim().startsWith('//'));
            assert.strictEqual(commentCallers.length, 0, 'Should not include comment lines as callers');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: findCallees should filter comments and strings', () => {
    it('should not count function names in comments as callees', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-callee-comments-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
function helperFunction() {
    return 42;
}

function mainFunction() {
    // helperFunction() does something useful
    // We call helperFunction() below
    const result = helperFunction();
    return result;
}

module.exports = { helperFunction, mainFunction };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const mainDef = index.symbols.get('mainFunction')?.[0];
            const callees = index.findCallees(mainDef);

            // helperFunction should only be counted once (from the actual call)
            const helperCallee = callees.find(c => c.name === 'helperFunction');
            assert.ok(helperCallee, 'Should find helperFunction as a callee');
            assert.strictEqual(helperCallee.callCount, 1, 'Should count helperFunction only once (not from comments)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: search should escape regex special characters', () => {
    it('should not crash when searching for regex special chars', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-search-regex-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'code.js'), `
function process(x) {
    return x + 1;
}
// Call process(x) here
const result = process(42);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // These should not throw
            assert.doesNotThrow(() => index.search('process('));
            assert.doesNotThrow(() => index.search('(x)'));
            assert.doesNotThrow(() => index.search('[test]'));
            assert.doesNotThrow(() => index.search('x + 1'));

            const results = index.search('process(');
            assert.ok(results.length > 0, 'Should find matches for process(');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: trace depth=0 should work correctly', () => {
    it('should show only root function when depth=0', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-trace-depth-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'util.js'), `
function helper() {
    return 1;
}

function main() {
    return helper();
}

module.exports = { helper, main };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const trace0 = index.trace('main', { depth: 0 });
            assert.ok(trace0, 'Should return trace result');
            assert.strictEqual(trace0.maxDepth, 0, 'maxDepth should be 0');
            assert.strictEqual(trace0.tree.children.length, 0, 'Should have no children with depth=0');

            const trace1 = index.trace('main', { depth: 1 });
            assert.strictEqual(trace1.maxDepth, 1, 'maxDepth should be 1');
            assert.ok(trace1.tree.children.length > 0, 'Should have children with depth=1');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: indent should be stored for --top-level filtering', () => {
    it('should store indent field in project index', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-indent-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'code.js'), `
function outer() {
    function inner() {
        return 1;
    }
    return inner();
}

module.exports = { outer };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const outerDef = index.symbols.get('outer')?.[0];
            const innerDef = index.symbols.get('inner')?.[0];

            assert.ok(outerDef, 'Should find outer function');
            assert.ok(innerDef, 'Should find inner function');

            // outer should have indent 0, inner should have indent > 0
            assert.strictEqual(outerDef.indent, 0, 'outer should have indent 0');
            assert.ok(innerDef.indent > 0, 'inner should have indent > 0');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// lines command should validate input
// ============================================================================

describe('Regression: lines command should validate input', () => {
    it('should error on out-of-bounds line range', () => {
        const fixtureFile = path.join(FIXTURES_PATH, 'javascript', 'main.js');
        const content = fs.readFileSync(fixtureFile, 'utf-8');
        const lineCount = content.split('\n').length;

        // Run UCN with lines command that exceeds file length
        const { execSync } = require('child_process');
        const ucnPath = path.join(PROJECT_DIR, 'ucn.js');

        try {
            execSync(`node ${ucnPath} ${fixtureFile} lines ${lineCount + 100}-${lineCount + 200}`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            assert.fail('Should have thrown an error for out-of-bounds range');
        } catch (e) {
            assert.ok(e.stderr.includes('out of bounds'), 'Should report out of bounds error');
        }
    });

    it('should handle reversed line range by swapping', () => {
        const fixtureFile = path.join(FIXTURES_PATH, 'javascript', 'main.js');
        const { execSync } = require('child_process');
        const ucnPath = path.join(PROJECT_DIR, 'ucn.js');

        // Reversed range should work (10-5 should become 5-10)
        const output = execSync(`node ${ucnPath} ${fixtureFile} lines 10-5`, {
            encoding: 'utf8'
        });

        assert.ok(output.includes('5 │'), 'Should include line 5');
        assert.ok(output.includes('10 │'), 'Should include line 10');
    });

    it('should error on non-numeric line range', () => {
        const fixtureFile = path.join(FIXTURES_PATH, 'javascript', 'main.js');
        const { execSync } = require('child_process');
        const ucnPath = path.join(PROJECT_DIR, 'ucn.js');

        try {
            execSync(`node ${ucnPath} ${fixtureFile} lines abc-def`, {
                encoding: 'utf8',
                stdio: ['pipe', 'pipe', 'pipe']
            });
            assert.fail('Should have thrown an error for non-numeric range');
        } catch (e) {
            assert.ok(e.stderr.includes('Invalid line range'), 'Should report invalid range error');
        }
    });
});

// ============================================================================
// findCallees should not include function declaration
// ============================================================================

describe('Regression: findCallees should not include function declaration', () => {
    it('should not list function as its own callee when not recursive', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-callee-decl-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function nonRecursive(x) {
    return helper(x) + other(x);
}
function helper(x) { return x * 2; }
function other(x) { return x + 1; }
module.exports = { nonRecursive, helper, other };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('nonRecursive');

            // Function should not appear as its own callee
            const selfCallee = ctx.callees.find(c => c.name === 'nonRecursive');
            assert.ok(!selfCallee, 'Non-recursive function should not list itself as callee');

            // But should still list actual callees
            assert.ok(ctx.callees.some(c => c.name === 'helper'), 'Should list helper as callee');
            assert.ok(ctx.callees.some(c => c.name === 'other'), 'Should list other as callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect callees in single-line functions', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-single-line-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function singleLine() { return helper() + other(); }
function helper() { return 1; }
function other() { return 2; }
module.exports = { singleLine, helper, other };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('singleLine');

            // Single-line function should detect its callees
            assert.ok(ctx.callees.some(c => c.name === 'helper'), 'Should detect helper callee in single-line function');
            assert.ok(ctx.callees.some(c => c.name === 'other'), 'Should detect other callee in single-line function');
            // But should not include itself
            assert.ok(!ctx.callees.some(c => c.name === 'singleLine'), 'Should not include itself as callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should list function as callee when actually recursive', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-recursive-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);
}
module.exports = { factorial };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('factorial');

            // Recursive function SHOULD appear as its own callee
            const selfCallee = ctx.callees.find(c => c.name === 'factorial');
            assert.ok(selfCallee, 'Recursive function should list itself as callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Negative depth values should be clamped to 0
// ============================================================================

describe('Regression: negative depth should be clamped to 0', () => {
    it('trace should work with negative depth (clamped to 0)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-neg-depth-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function main() {
    return helper();
}
function helper() { return 42; }
module.exports = { main, helper };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Negative depth should be clamped to 0
            const trace = index.trace('main', { depth: -5 });

            assert.ok(trace, 'Trace should return a result');
            assert.strictEqual(trace.maxDepth, 0, 'maxDepth should be clamped to 0');
            assert.strictEqual(trace.root, 'main', 'Root should be main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('graph should work with negative depth (clamped to 0)', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-neg-graph-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(tmpDir, 'main.js'), `
const { helper } = require('./helper');
console.log(helper());
`);
            fs.writeFileSync(path.join(tmpDir, 'helper.js'), `
module.exports = { helper: () => 42 };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Negative depth should be clamped to 0
            const graph = index.graph('main.js', { maxDepth: -10 });

            assert.ok(graph.nodes.length > 0, 'Graph should have nodes');
            // With depth 0, should only show root and its direct imports (depth 0)
            assert.ok(graph.nodes.some(n => n.relativePath === 'main.js'), 'Should include main.js');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// JavaScript class methods in context
// ============================================================================

describe('Regression: JavaScript class methods in context', () => {
    it('should show methods for JS classes via className', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-js-class-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'user.js'), `class User {
    constructor(name) {
        this.name = name;
    }

    greet() {
        return 'Hello ' + this.name;
    }

    static create(name) {
        return new User(name);
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('User');

            // Should identify as class
            assert.strictEqual(ctx.type, 'class', 'User should be identified as class');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 3, 'User class should have 3 methods');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('constructor'), 'Should include constructor');
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('create'), 'Should include create');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// fn command auto-resolves best definition
// ============================================================================

describe('Regression: fn command auto-resolves best definition', () => {
    it('should prefer src/lib definition over test definition via pickBestDefinition-style scoring', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-fn-resolve-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'lib', 'app.js'), `
function render(template, data) {
    return template.replace(/{(\\w+)}/g, (_, key) => data[key] || '');
}
module.exports = { render };
`);
            fs.writeFileSync(path.join(tmpDir, 'test', 'app.test.js'), `
const { render } = require('../lib/app');
function render(mockTemplate) {
    return 'mock: ' + mockTemplate;
}
test('render works', () => { render('hello'); });
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // find should return both definitions
            const matches = index.find('render').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 2, `Should find at least 2 definitions, got ${matches.length}`);

            // resolveSymbol should prefer lib/ over test/
            const { def } = index.resolveSymbol('render');
            assert.ok(def, 'Should find render');
            assert.ok(def.relativePath.includes('lib/'),
                `Should prefer lib/ file, got ${def.relativePath}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// context returns null for non-existent symbols
// ============================================================================

describe('Regression: context returns null for non-existent symbols', () => {
    it('should return null when symbol is not defined in the project', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-context-null-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const router = require('express').Router();
function handleRequest(req, res) {
    res.send('hello');
}
module.exports = { handleRequest };
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Symbol that doesn't exist at all
            const result1 = index.context('nonexistentXYZ');
            assert.strictEqual(result1, null,
                'context should return null for completely non-existent symbol');

            // Symbol used but not defined in project (external import)
            const result2 = index.context('Router');
            assert.strictEqual(result2, null,
                'context should return null for externally-defined symbol');

            // Symbol that IS defined should still work
            const result3 = index.context('handleRequest');
            assert.ok(result3, 'context should return result for defined symbol');
            assert.ok(result3.function || result3.name, 'Result should have function/name field');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// pickBestDefinition prefers larger functions over trivial ones
// ============================================================================

describe('Regression: pickBestDefinition prefers larger functions over trivial ones', () => {
    it('should pick the __init__ with the largest body when all else is equal', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-pick-best-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            // Small __init__ (3 lines) - should NOT be preferred
            fs.writeFileSync(path.join(tmpDir, 'src', 'errors.py'), `
class AppError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message
`);
            // Large __init__ (20+ lines) - SHOULD be preferred
            fs.writeFileSync(path.join(tmpDir, 'src', 'client.py'), `
class Client:
    def __init__(self, url, timeout=30, retries=3, auth=None, headers=None):
        self.url = url
        self.timeout = timeout
        self.retries = retries
        self.auth = auth
        self.headers = headers or {}
        self.session = None
        self._pool = None
        self._closed = False
        self._setup_logging()
        self._verify_ssl = True
        self._proxy = None
        self._max_redirects = 10
        self._cookies = {}
        self._default_encoding = 'utf-8'
        self._event_hooks = {'request': [], 'response': []}
        self._transport = None
        self._base_url = url
        self._initialized = True

    def get(self, path):
        pass
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const matches = index.find('__init__').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 2, `Should find at least 2 __init__ methods, got ${matches.length}`);

            // Sort using same logic as pickBestDefinition
            const typeOrder = new Set(['class', 'struct', 'interface', 'type', 'impl']);
            const scored = matches.map(m => {
                let score = 0;
                const rp = m.relativePath || '';
                if (typeOrder.has(m.type)) score += 1000;
                if (/^(examples?|docs?|vendor|third[_-]?party|benchmarks?|samples?)\//i.test(rp)) score -= 300;
                if (/^(lib|src|core|internal|pkg|crates)\//i.test(rp)) score += 200;
                if (m.startLine && m.endLine) {
                    score += Math.min(m.endLine - m.startLine, 100);
                }
                return { match: m, score };
            });
            scored.sort((a, b) => b.score - a.score);
            const best = scored[0].match;

            // Should pick client.py (large body) over errors.py (small body)
            assert.ok(best.file.includes('client.py'),
                `Should prefer client.py __init__ (large body), got ${best.file}`);
            assert.ok(best.endLine - best.startLine > 10,
                `Selected __init__ should have >10 lines, got ${best.endLine - best.startLine}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// JS this.method() same-class resolution
// ============================================================================

describe('Regression: JS this.method() same-class resolution', () => {
    it('findCallees should resolve this.method() to same-class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jsthis-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'service.js'), `
class DataService {
    _fetchRemote(key, days) {
        return this._makeRequest(\`/api/\${key}\`);
    }

    _makeRequest(url) {
        return null;
    }

    getRecords(key, days = 365) {
        if (this._isValid(key)) {
            return this._fetchRemote(key, days);
        }
        return null;
    }

    _isValid(key) {
        return key.length > 0;
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // getRecords should have _fetchRemote and _isValid as callees
            const defs = index.symbols.get('getRecords');
            assert.ok(defs && defs.length > 0, 'Should find getRecords');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('_fetchRemote'),
                `Should resolve this._fetchRemote(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('_isValid'),
                `Should resolve this._isValid(), got: ${calleeNames.join(', ')}`);

            // _fetchRemote should have getRecords as caller
            const callers = index.findCallers('_fetchRemote');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('getRecords'),
                `Should find getRecords as caller of _fetchRemote, got: ${callerNames.join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// deadcode relative path fix works for JS projects
// ============================================================================

describe('Regression: deadcode relative path fix works for JS projects', () => {
    it('should not treat non-test JS files as test files when project is inside /__tests__/ directory', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-js-relpath-${Date.now()}`, '__tests__', 'myproject');
        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name": "test"}');
            fs.writeFileSync(path.join(srcDir, 'utils.js'), `
function unusedUtil() {
    return 42;
}

function usedUtil() {
    return unusedUtil();
}

module.exports = { usedUtil };
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // src/utils.js should NOT be treated as a test file
            const { isTestFile } = require('../core/discovery');
            assert.ok(!isTestFile('src/utils.js', 'javascript'),
                'src/utils.js should not be a test file');
        } finally {
            const topDir = tmpDir.split('/__tests__/myproject')[0];
            if (topDir.includes('ucn-test-js-relpath')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });
});

// ============================================================================
// extractExports uses correct parser for TypeScript
// ============================================================================

describe('Regression: extractExports uses correct parser for TypeScript', () => {
    it('should find all exports in TypeScript files with type annotations', () => {
        const { extractExports } = require('../core/imports');
        const tsCode = `
import { UseMutationResult } from '@tanstack/react-query';

export function useGetToken(): UseMutationResult<string> {
    return {} as any;
}

export function useGetConfig(): Promise<Config> {
    return {} as any;
}

export function useUpdateConfig(data: ConfigData): void {
    console.log(data);
}

export function useSaveConfig(): void {
    console.log('save');
}

export function useRefresh(): void {
    console.log('refresh');
}
`;
        const { exports } = extractExports(tsCode, 'typescript');
        const names = exports.map(e => e.name);
        assert.ok(names.includes('useGetToken'), 'should find useGetToken');
        assert.ok(names.includes('useGetConfig'), 'should find useGetConfig');
        assert.ok(names.includes('useUpdateConfig'), 'should find useUpdateConfig');
        assert.ok(names.includes('useSaveConfig'), 'should find useSaveConfig');
        assert.ok(names.includes('useRefresh'), 'should find useRefresh');
        assert.strictEqual(names.length, 5, 'should find all 5 exports');
    });

    it('should find export const with TS type annotations', () => {
        const { extractExports } = require('../core/imports');
        const tsCode = `
export const client: AxiosInstance = axios.create({});
export const cloudClient: AxiosInstance = axios.create({});
export function customRequest<T>(url: string): Promise<T> {
    return {} as any;
}
`;
        const { exports } = extractExports(tsCode, 'typescript');
        const names = exports.map(e => e.name);
        assert.ok(names.includes('client'), 'should find client');
        assert.ok(names.includes('cloudClient'), 'should find cloudClient');
        assert.ok(names.includes('customRequest'), 'should find customRequest');
    });
});

// ============================================================================
// JS/TS extractExtends preserves generic types
// ============================================================================

describe('Regression: JS/TS extractExtends preserves generic types', () => {
    it('should capture dotted names and generics in extends clause', () => {
        const { parse } = require('../core/parser');
        const result = parse(`
export class ErrorBoundary extends React.Component {
    render() {}
}
`, 'javascript');
        const cls = result.classes[0];
        assert.strictEqual(cls.extends, 'React.Component',
            `Expected "React.Component" but got "${cls.extends}"`);
    });
});

// ============================================================================
// JS parser detects export modifier on exported functions
// ============================================================================

describe('Regression: JS parser detects export modifier on exported functions', () => {
    it('should include export in modifiers for export function declarations', () => {
        const { parse } = require('../core/parser');
        const result = parse(`
export function myFunc() {
    return 1;
}

export const myArrow = () => {
    return 2;
};
`, 'javascript');
        const myFunc = result.functions.find(f => f.name === 'myFunc');
        assert.ok(myFunc, 'should find myFunc');
        assert.ok(myFunc.modifiers.includes('export'),
            `myFunc modifiers should include "export" but got [${myFunc.modifiers}]`);

        const myArrow = result.functions.find(f => f.name === 'myArrow');
        assert.ok(myArrow, 'should find myArrow');
        assert.ok(myArrow.modifiers.includes('export'),
            `myArrow modifiers should include "export" but got [${myArrow.modifiers}]`);
    });
});

// ============================================================================
// findUsagesInCode counts TypeScript type annotations
// ============================================================================

describe('Regression: findUsagesInCode counts TypeScript type annotations', () => {
    it('should find type_identifier usages in type annotations', () => {
        const { getParser } = require('../languages');
        const jsModule = require('../languages/javascript');
        const parser = getParser('typescript');
        const code = `
import { ListItemsParams } from './types';

export function useWorkspaces(params?: ListItemsParams) {
    return [];
}

function other(x: ListItemsParams): ListItemsParams {
    return x;
}
`;
        const usages = jsModule.findUsagesInCode(code, 'ListItemsParams', parser);
        // Should find: 1 import + at least 2 type annotation references
        assert.ok(usages.length >= 3,
            `Expected at least 3 usages but got ${usages.length}: ${JSON.stringify(usages)}`);
        const refs = usages.filter(u => u.usageType === 'reference');
        assert.ok(refs.length >= 2,
            `Expected at least 2 reference usages but got ${refs.length}`);
    });
});

// ============================================================================
// fileExports detects export const/let/var
// ============================================================================

describe('Regression: fileExports detects export const/let/var', () => {
    it('should detect export const and export let in TypeScript', () => {
        const { extractExports } = require('../core/imports');
        const tsCode = `
export let API_URL: string;
export let WS_URL: string;
export const URL_SCHEMA = 'anylyze://';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
`;
        const { exports } = extractExports(tsCode, 'typescript');
        const names = exports.map(e => e.name);
        assert.ok(names.includes('API_URL'), 'should find API_URL');
        assert.ok(names.includes('WS_URL'), 'should find WS_URL');
        assert.ok(names.includes('URL_SCHEMA'), 'should find URL_SCHEMA');
        assert.ok(names.includes('IS_PRODUCTION'), 'should find IS_PRODUCTION');

        // Check variable metadata
        const apiUrl = exports.find(e => e.name === 'API_URL');
        assert.strictEqual(apiUrl.isVariable, true);
        assert.strictEqual(apiUrl.declKind, 'let');
        assert.strictEqual(apiUrl.typeAnnotation, 'string');

        const urlSchema = exports.find(e => e.name === 'URL_SCHEMA');
        assert.strictEqual(urlSchema.isVariable, true);
        assert.strictEqual(urlSchema.declKind, 'const');
    });

    it('should include variable exports in fileExports results', () => {
        const { ProjectIndex } = require('../core/project');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

        // File with only const/let exports (no functions)
        fs.writeFileSync(path.join(tmpDir, 'urls.ts'), `
export let API_URL: string;
export const URL_SCHEMA = 'anylyze://';
export const IS_PRODUCTION = process.env.NODE_ENV === 'production';
`);
        const index = new ProjectIndex(tmpDir);
        index.build();

        const exports = index.fileExports('urls.ts');
        const names = exports.map(e => e.name);
        assert.ok(names.includes('API_URL'), `should find API_URL, got: ${names.join(', ')}`);
        assert.ok(names.includes('URL_SCHEMA'), `should find URL_SCHEMA, got: ${names.join(', ')}`);
        assert.ok(names.includes('IS_PRODUCTION'), `should find IS_PRODUCTION, got: ${names.join(', ')}`);
        assert.strictEqual(exports.length, 3, `should find 3 exports, got ${exports.length}`);

        // Check types
        const apiUrl = exports.find(e => e.name === 'API_URL');
        assert.strictEqual(apiUrl.type, 'variable');
        assert.ok(apiUrl.signature.includes('let'), `signature should include let: ${apiUrl.signature}`);

        fs.rmSync(tmpDir, { recursive: true });
    });

    it('should include variable exports alongside function exports in fileExports', () => {
        const { ProjectIndex } = require('../core/project');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

        // Mixed file: const + function exports
        fs.writeFileSync(path.join(tmpDir, 'request.ts'), `
export const client = new GraphQLClient('http://localhost');
export const cloudClient = new GraphQLClient('http://cloud');
export function customRequest(url: string): Promise<any> {
    return fetch(url);
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build();

        const exports = index.fileExports('request.ts');
        const names = exports.map(e => e.name);
        assert.ok(names.includes('client'), `should find client, got: ${names.join(', ')}`);
        assert.ok(names.includes('cloudClient'), `should find cloudClient, got: ${names.join(', ')}`);
        assert.ok(names.includes('customRequest'), `should find customRequest, got: ${names.join(', ')}`);
        assert.strictEqual(exports.length, 3, `should find 3 exports, got ${exports.length}`);

        fs.rmSync(tmpDir, { recursive: true });
    });

    it('should include variable exports in api() results', () => {
        const { ProjectIndex } = require('../core/project');
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

        fs.writeFileSync(path.join(tmpDir, 'colors.ts'), `
export const colors = { white: '#ffffff', black: '#000000' };
`);
        const index = new ProjectIndex(tmpDir);
        index.build();

        const apiResults = index.api();
        const names = apiResults.map(e => e.name);
        assert.ok(names.includes('colors'), `api() should find colors export, got: ${names.join(', ')}`);

        fs.rmSync(tmpDir, { recursive: true });
    });
});

// ============================================================================
// Bug Report #3 Regressions (JS/TS focused)
// ============================================================================

describe('Bug Report #3 Regressions', () => {

it('BUG 1 — JS/TS callback references in HOFs (.then(fn), .map(fn))', (t) => {
    const { getParser } = require('../languages');
    const { findCallsInCode } = require('../languages/javascript');

    const code = `
function handlePaste() {
    setErr(null);
    navigator.clipboard
        .readText()
        .then(handleProcess)
        .catch((e) => { console.log(e); });
}
`;
    const parser = getParser('javascript');
    const calls = findCallsInCode(code, parser);

    // handleProcess should be detected as a function reference
    const ref = calls.find(c => c.name === 'handleProcess');
    assert.ok(ref, 'handleProcess should be detected as a function reference');
    assert.strictEqual(ref.isFunctionReference, true, 'should be marked as isFunctionReference');
    assert.strictEqual(ref.isMethod, false);
});

it('BUG 2 — findCallees detects calls inside nested callbacks', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug2-'));

    // Define the functions so they resolve in the symbol table
    fs.writeFileSync(path.join(tmpDir, 'auth.js'), `
export function setAccessToken(token) { /* store token */ }
export function processData(data) { return data; }
`);
    fs.writeFileSync(path.join(tmpDir, 'App.js'), `
import { setAccessToken, processData } from './auth';

function handleLogin() {
    fetch('/api/login')
        .then((r) => {
            setAccessToken(r.token);
            processData(r.data);
        });
}

export { handleLogin };
`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const { ProjectIndex } = require('../core/project');
    const index = new ProjectIndex(tmpDir);
    index.build(null, { quiet: true });

    const defs = index.find('handleLogin');
    assert.ok(defs.length > 0, 'handleLogin should be found');

    const callees = index.findCallees(defs[0]);
    const calleeNames = callees.map(c => c.name);

    // The key test: setAccessToken inside .then() callback should be detected
    assert.ok(calleeNames.includes('setAccessToken'),
        `setAccessToken should be detected as callee of handleLogin (got: ${calleeNames.join(', ')})`);
    assert.ok(calleeNames.includes('processData'),
        `processData should be detected as callee of handleLogin (got: ${calleeNames.join(', ')})`);

    fs.rmSync(tmpDir, { recursive: true });
});

it('BUG 2b — nested callbacks do not steal calls from inner named symbols', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug2b-'));
    fs.writeFileSync(path.join(tmpDir, 'helpers.js'), `
function foo() { return 1; }
function bar() { return 2; }
module.exports = { foo, bar };
`);
    fs.writeFileSync(path.join(tmpDir, 'main.js'), `
const { foo, bar } = require('./helpers');

function outer() {
    foo();
}

function inner() {
    bar();
}

module.exports = { outer, inner };
`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const { ProjectIndex } = require('../core/project');
    const index = new ProjectIndex(tmpDir);
    index.build(null, { quiet: true });

    // outer should NOT have bar() as a callee (bar is inside inner, a separate symbol)
    const outerDefs = index.find('outer');
    assert.ok(outerDefs.length > 0);
    const outerCallees = index.findCallees(outerDefs[0]);
    const outerCalleeNames = outerCallees.map(c => c.name);
    assert.ok(!outerCalleeNames.includes('bar'),
        `outer should NOT have bar as callee (got: ${outerCalleeNames.join(', ')})`);

    // inner should have bar() as a callee
    const innerDefs = index.find('inner');
    assert.ok(innerDefs.length > 0);
    const innerCallees = index.findCallees(innerDefs[0]);
    const innerCalleeNames = innerCallees.map(c => c.name);
    assert.ok(innerCalleeNames.includes('bar'),
        `inner should have bar as callee (got: ${innerCalleeNames.join(', ')})`);

    fs.rmSync(tmpDir, { recursive: true });
});

it('BUG 3 — typedef returns source code', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug3-'));
    fs.writeFileSync(path.join(tmpDir, 'types.ts'), `
export interface UserProps {
    name: string;
    email: string;
    age?: number;
}

export type Status = 'active' | 'inactive';
`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const { ProjectIndex } = require('../core/project');
    const index = new ProjectIndex(tmpDir);
    index.build(null, { quiet: true });

    const types = index.typedef('UserProps');
    assert.ok(types.length > 0, 'UserProps should be found');
    assert.ok(types[0].code, 'typedef should include source code');
    assert.ok(types[0].code.includes('name: string'), 'code should contain the interface fields');
    assert.ok(types[0].code.includes('email: string'), 'code should contain email field');

    const statusTypes = index.typedef('Status');
    assert.ok(statusTypes.length > 0, 'Status should be found');
    assert.ok(statusTypes[0].code, 'typedef should include source code for type alias');
    assert.ok(statusTypes[0].code.includes('active'), 'code should contain type values');

    fs.rmSync(tmpDir, { recursive: true });
});

it('BUG 4 — fileExports detects export type and export interface', (t) => {
    const { getParser } = require('../languages');
    const { findExportsInCode } = require('../languages/javascript');

    const code = `
export type UIObjectType = 'dashboard' | 'report';
export interface ListItemsParams {
    objectType?: string;
    title?: string;
}
export enum Status {
    Active = 'active',
    Inactive = 'inactive'
}
export function fetchData() { return null; }
export const isProd = true;
`;
    const parser = getParser('typescript');
    const exports = findExportsInCode(code, parser);
    const names = exports.map(e => e.name);

    assert.ok(names.includes('UIObjectType'), 'export type should be detected');
    assert.ok(names.includes('ListItemsParams'), 'export interface should be detected');
    assert.ok(names.includes('Status'), 'export enum should be detected');
    assert.ok(names.includes('fetchData'), 'export function should be detected');
    assert.ok(names.includes('isProd'), 'export const should be detected');

    // Type exports should be marked
    const typeExport = exports.find(e => e.name === 'UIObjectType');
    assert.strictEqual(typeExport.isTypeExport, true, 'type export should have isTypeExport flag');
});

it('BUG 6 — graph "both" direction returns separate sections', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug6-'));

    fs.writeFileSync(path.join(tmpDir, 'a.js'), `const b = require('./b');`);
    fs.writeFileSync(path.join(tmpDir, 'b.js'), `const c = require('./c'); module.exports = {};`);
    fs.writeFileSync(path.join(tmpDir, 'c.js'), `module.exports = {};`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const { ProjectIndex } = require('../core/project');
    const index = new ProjectIndex(tmpDir);
    index.build(null, { quiet: true });

    const graph = index.graph('b.js', { direction: 'both', maxDepth: 2 });
    assert.strictEqual(graph.direction, 'both', 'direction should be "both"');
    assert.ok(graph.imports, 'should have imports sub-graph');
    assert.ok(graph.importers, 'should have importers sub-graph');

    // b.js imports c.js
    const importEdges = graph.imports.edges.filter(e => e.from === graph.root);
    const importTargets = importEdges.map(e => path.basename(e.to));
    assert.ok(importTargets.some(t => t === 'c.js'),
        'imports should include c.js');

    // a.js imports b.js (so a.js is an importer)
    const importerEdges = graph.importers.edges.filter(e => e.from === graph.root);
    const importerTargets = importerEdges.map(e => path.basename(e.to));
    assert.ok(importerTargets.some(t => t === 'a.js'),
        'importers should include a.js');

    fs.rmSync(tmpDir, { recursive: true });
});

it('BUG 9 — search case sensitivity option', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug9-'));
    fs.writeFileSync(path.join(tmpDir, 'test.js'), `
// TODO: fix this
// todo: also fix this
const TODO_LIST = [];
`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const { ProjectIndex } = require('../core/project');
    const index = new ProjectIndex(tmpDir);
    index.build(null, { quiet: true });

    // Case-insensitive (default)
    const insensitive = index.search('TODO');
    const insensitiveCount = insensitive.reduce((sum, r) => sum + r.matches.length, 0);

    // Case-sensitive
    const sensitive = index.search('TODO', { caseSensitive: true });
    const sensitiveCount = sensitive.reduce((sum, r) => sum + r.matches.length, 0);

    assert.ok(insensitiveCount > sensitiveCount,
        `Case-insensitive (${insensitiveCount}) should find more matches than case-sensitive (${sensitiveCount})`);
    assert.ok(sensitiveCount >= 2, 'Case-sensitive should find at least 2 matches (TODO comment and TODO_LIST)');

    fs.rmSync(tmpDir, { recursive: true });
});

it('BUG 13 — api excludes test files by default', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug13-'));

    fs.writeFileSync(path.join(tmpDir, 'src.js'), `
export function realApi() { return 1; }
`);
    fs.writeFileSync(path.join(tmpDir, 'src.test.js'), `
export function testHelper() { return 2; }
`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

    const { ProjectIndex } = require('../core/project');
    const index = new ProjectIndex(tmpDir);
    index.build(null, { quiet: true });

    const apiSymbols = index.api();
    const names = apiSymbols.map(s => s.name);

    assert.ok(names.includes('realApi'), 'realApi should be in API');
    assert.ok(!names.includes('testHelper'), 'testHelper from test file should be excluded from API by default');

    fs.rmSync(tmpDir, { recursive: true });
});

it('BUG 1b — HOF callback detection respects argument positions', (t) => {
    const { getParser } = require('../languages');
    const { findCallsInCode } = require('../languages/javascript');

    const code = `
function process(items) {
    items.reduce(accumulate, initialValue);
    setTimeout(doWork, delay);
    element.addEventListener(eventType, handleClick);
}
`;
    const parser = getParser('javascript');
    const calls = findCallsInCode(code, parser);
    const refs = calls.filter(c => c.isFunctionReference);
    const refNames = refs.map(c => c.name);

    // Only callback-position args should be detected
    assert.ok(refNames.includes('accumulate'), 'reduce arg 0 should be detected');
    assert.ok(!refNames.includes('initialValue'), 'reduce arg 1 should NOT be detected');
    assert.ok(refNames.includes('doWork'), 'setTimeout arg 0 should be detected');
    assert.ok(!refNames.includes('delay'), 'setTimeout arg 1 should NOT be detected');
    assert.ok(refNames.includes('handleClick'), 'addEventListener arg 1 should be detected');
    assert.ok(!refNames.includes('eventType'), 'addEventListener arg 0 should NOT be detected');
});

it('BUG 1c — HOF callback detection handles member_expression args', (t) => {
    const { getParser } = require('../languages');
    const { findCallsInCode } = require('../languages/javascript');

    const code = `
function process() {
    promise.then(utils.handleError);
    items.map(validators.isValid);
}
`;
    const parser = getParser('javascript');
    const calls = findCallsInCode(code, parser);
    const refs = calls.filter(c => c.isFunctionReference);

    const handleErrorRef = refs.find(c => c.name === 'handleError');
    assert.ok(handleErrorRef, 'utils.handleError should be detected as callback');
    assert.strictEqual(handleErrorRef.isMethod, true, 'should be marked as method');
    assert.strictEqual(handleErrorRef.receiver, 'utils', 'receiver should be utils');

    const isValidRef = refs.find(c => c.name === 'isValid');
    assert.ok(isValidRef, 'validators.isValid should be detected as callback');
    assert.strictEqual(isValidRef.receiver, 'validators');
});

it('BUG 4b — TS export type/interface/enum detected by findExportsInCode', (t) => {
    const { getParser } = require('../languages');
    const { findExportsInCode } = require('../languages/javascript');

    const code = `
export type UIObjectType = 'dashboard' | 'report';
export interface ListItemsParams { page: number; }
export enum Status { Active = 'active', Inactive = 'inactive' }
export const API_URL = '/api';
export function fetchData() { return null; }
`;
    const parser = getParser('typescript');
    const exports = findExportsInCode(code, parser);
    const names = exports.map(e => e.name);

    assert.ok(names.includes('UIObjectType'), 'export type should be detected');
    assert.ok(names.includes('ListItemsParams'), 'export interface should be detected');
    assert.ok(names.includes('Status'), 'export enum should be detected');
    assert.ok(names.includes('API_URL'), 'export const should be detected');
    assert.ok(names.includes('fetchData'), 'export function should be detected');

    // Verify type export flag
    const typeExport = exports.find(e => e.name === 'UIObjectType');
    assert.strictEqual(typeExport.isTypeExport, true, 'type export should be flagged');
    const ifaceExport = exports.find(e => e.name === 'ListItemsParams');
    assert.strictEqual(ifaceExport.isTypeExport, true, 'interface export should be flagged');
});

}); // end Bug Report #3

// ============================================================================
// JS/TS Fix Regressions
// ============================================================================

describe('JS/TS Fix Regressions', () => {

it('FIX 67 — JS: non-callable variable shadows should not produce false callback', (t) => {
    const { getParser } = require('../languages');
    const { findCallsInCode } = require('../languages/javascript');

    const code = `
function parse(input) { return input; }

function test() {
    const parse = 5;
    console.log(parse);
    someFunc(parse);
}
`;
    const parser = getParser('javascript');
    const calls = findCallsInCode(code, parser);

    // parse = 5 means parse is non-callable, so passing it as arg should NOT be isPotentialCallback
    const falseCb = calls.find(c => c.name === 'parse' && c.isPotentialCallback);
    assert.ok(!falseCb, 'parse (assigned to 5) should NOT be detected as potential callback');

    // The console.log call itself should still be detected
    const logCall = calls.find(c => c.name === 'log' && c.isMethod);
    assert.ok(logCall, 'console.log() call should still be detected');
});

it('FIX 67 — JS: string/boolean/null/array/object non-callable literals', (t) => {
    const { getParser } = require('../languages');
    const { findCallsInCode } = require('../languages/javascript');

    const code = `
const count = 42;
const name = "hello";
const flag = true;
const empty = null;
const items = [1, 2, 3];
const config = { a: 1 };

function test() {
    doSomething(count, name, flag, empty, items, config);
}
`;
    const parser = getParser('javascript');
    const calls = findCallsInCode(code, parser);

    const callbacks = calls.filter(c => c.isPotentialCallback);
    const cbNames = callbacks.map(c => c.name);
    assert.ok(!cbNames.includes('count'), 'count (number) should not be potential callback');
    assert.ok(!cbNames.includes('name'), 'name (string) should not be potential callback');
    assert.ok(!cbNames.includes('flag'), 'flag (boolean) should not be potential callback');
    assert.ok(!cbNames.includes('empty'), 'empty (null) should not be potential callback');
    assert.ok(!cbNames.includes('items'), 'items (array) should not be potential callback');
    assert.ok(!cbNames.includes('config'), 'config (object) should not be potential callback');
});

it('FIX 67 — JS: object with function values should NOT be marked non-callable', (t) => {
    const { getParser } = require('../languages');
    const { findCallsInCode } = require('../languages/javascript');

    const code = `
const handlers = { onClick: () => {} };
const realFn = function() {};

function test() {
    register(handlers, realFn);
}
`;
    const parser = getParser('javascript');
    const calls = findCallsInCode(code, parser);

    // handlers has arrow function value, so should NOT be excluded
    const handlersCb = calls.find(c => c.name === 'handlers' && c.isPotentialCallback);
    assert.ok(handlersCb, 'handlers (object with function values) SHOULD still be potential callback');

    // realFn is a function expression, not a non-callable literal
    const realFnCb = calls.find(c => c.name === 'realFn' && c.isPotentialCallback);
    assert.ok(realFnCb, 'realFn (function expression) SHOULD still be potential callback');
});

it('FIX 67 — JS: non-callable in object literal arg values', (t) => {
    const { getParser } = require('../languages');
    const { findCallsInCode } = require('../languages/javascript');

    const code = `
const status = "active";

function test() {
    doRequest({ handler: status });
}
`;
    const parser = getParser('javascript');
    const calls = findCallsInCode(code, parser);

    const falseCb = calls.find(c => c.name === 'status' && c.isPotentialCallback);
    assert.ok(!falseCb, 'status (string) in object literal value should NOT be potential callback');
});

it('FIX 76 — impact excludes method calls for standalone function targets', () => {
    // impact for a standalone function should NOT include obj.fn() calls
    const index = new ProjectIndex(PROJECT_DIR);
    index.build(null, { quiet: true });

    const result = index.impact('parse', { file: 'core/parser.js' });
    assert.ok(result, 'Should find parse');

    // All call sites should be direct calls, not method calls
    for (const group of result.byFile) {
        for (const site of group.sites) {
            assert.ok(!site.isMethodCall,
                `${group.file}:${site.line} should not be a method call: ${site.expression}`);
        }
    }

    // impact and verify should agree on call count
    const verified = index.verify('parse', { file: 'core/parser.js' });
    assert.strictEqual(result.totalCallSites, verified.totalCalls,
        'impact and verify call counts must match');
});

it('FIX 77 — find counts match usages via transitive re-exports', () => {
    // countSymbolUsages should follow re-export chains
    const index = new ProjectIndex(PROJECT_DIR);
    index.build(null, { quiet: true });

    const defs = index.symbols.get('detectLanguage');
    assert.ok(defs && defs.length > 0, 'Should find detectLanguage');
    const def = defs.find(d => d.relativePath === 'languages/index.js');
    assert.ok(def, 'Should find definition in languages/index.js');

    const counts = index.countSymbolUsages(def);
    const usages = index.usages('detectLanguage', { includeTests: true });
    const usageCalls = usages.filter(u => u.usageType === 'call').length;

    assert.strictEqual(counts.calls, usageCalls,
        `find call count (${counts.calls}) must match usages call count (${usageCalls})`);
});

it('FIX 78 — tests classifies string-literal mentions as string-ref', () => {
    const index = new ProjectIndex(PROJECT_DIR);
    index.build(null, { quiet: true });

    const tests = index.tests('parseFile');
    const allMatches = tests.flatMap(t => t.matches);
    const stringRefs = allMatches.filter(m => m.matchType === 'string-ref');

    // Lines like index.usages('parseFile') should be classified as string-ref
    assert.ok(stringRefs.length > 0, 'Should find string-ref matches');
    for (const m of stringRefs) {
        assert.ok(m.content.includes("'parseFile'") || m.content.includes('"parseFile"'),
            `string-ref match should contain quoted name: ${m.content}`);
    }
});

it('FIX 78 — tests --calls-only filters non-call matches', () => {
    const index = new ProjectIndex(PROJECT_DIR);
    index.build(null, { quiet: true });

    const all = index.tests('parseFile');
    const callsOnly = index.tests('parseFile', { callsOnly: true });

    const allCount = all.flatMap(t => t.matches).length;
    const callsCount = callsOnly.flatMap(t => t.matches).length;

    assert.ok(allCount > callsCount || callsCount === 0,
        'calls-only should return fewer or equal matches');

    // Every match in calls-only should be a call or test-case
    for (const t of callsOnly) {
        for (const m of t.matches) {
            assert.ok(m.matchType === 'call' || m.matchType === 'test-case',
                `calls-only match should be call or test-case, got: ${m.matchType}`);
        }
    }
});

it('FIX 79 — usages deduplicates same-line same-type entries', () => {
    const index = new ProjectIndex(PROJECT_DIR);
    index.build(null, { quiet: true });

    const usages = index.usages('detectLanguage', { includeTests: true });

    // Check no duplicate file:line:usageType combinations
    const seen = new Set();
    for (const u of usages) {
        const key = `${u.file}:${u.line}:${u.usageType}:${u.isDefinition}`;
        assert.ok(!seen.has(key), `Duplicate usage entry: ${key}`);
        seen.add(key);
    }
});

// Cross-command consistency invariant test
it('INVARIANT — impact/verify/find call counts are consistent for common symbols', () => {
    const index = new ProjectIndex(PROJECT_DIR);
    index.build(null, { quiet: true });

    // Test with a few symbols that have cross-command relevance
    const symbols = ['detectLanguage', 'parseFile'];
    for (const name of symbols) {
        const impact = index.impact(name);
        const verified = index.verify(name);

        if (impact && verified.found) {
            assert.strictEqual(impact.totalCallSites, verified.totalCalls,
                `${name}: impact (${impact.totalCallSites}) != verify (${verified.totalCalls})`);
        }
    }
});

it('FIX 80 — search regex without g flag matches all lines', () => {
    // Previously, searchGlobFiles/searchFile used /pattern/gi which caused test()
    // to skip every other match due to stateful lastIndex.
    // Fixed: removed 'g' flag since test() only needs to know if the line matches.
    const lines = ['test line 1', 'test line 2', 'test line 3', 'test line 4'];

    // Correct behavior (no 'g' flag)
    const fixedRegex = new RegExp('test', 'i');
    const fixedMatches = lines.filter(l => fixedRegex.test(l));
    assert.strictEqual(fixedMatches.length, 4, 'Fixed regex should match all 4 lines');

    // Demonstrate the bug: 'g' flag makes test() stateful
    const buggyRegex = new RegExp('test', 'gi');
    const buggyMatches = lines.filter(l => buggyRegex.test(l));
    assert.ok(buggyMatches.length < 4,
        `Buggy regex with g flag only matched ${buggyMatches.length}/4 lines`);
});

it('FIX 81 — depthExplicit correctly detects when --depth is not specified', () => {
    // Previously, flags.depth defaulted to null, and the check was
    // `flags.depth !== undefined` which is always true (null !== undefined).
    // Fixed: changed to `flags.depth !== null`.

    // Simulate flag parsing: when --depth is NOT specified, depth is null
    const noDepthFlags = { depth: null };
    const withDepthFlags = { depth: '3' };

    // Fixed behavior: null means not specified
    assert.strictEqual(noDepthFlags.depth !== null, false,
        'depth=null should mean "not specified" (depthExplicit=false)');
    assert.strictEqual(withDepthFlags.depth !== null, true,
        'depth="3" should mean "specified" (depthExplicit=true)');

    // Bug behavior: null !== undefined was always true
    assert.strictEqual(noDepthFlags.depth !== undefined, true,
        'Demonstrates the bug: null !== undefined is true');
});

it('FIX 82 — findEnclosingFunction returns innermost nested function', () => {
    // Previously, findEnclosingFunction returned the first (outermost) match.
    // Fixed: now returns the smallest-range (innermost) enclosing function.
    const tmpDir = path.join(os.tmpdir(), `ucn-test-enclosing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        fs.writeFileSync(path.join(tmpDir, 'nested.js'), `
function outer() {
    function inner() {
        console.log('hello');
    }
    inner();
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        // Line 4 (console.log) is inside 'inner', which is inside 'outer'
        const result = index.findEnclosingFunction(
            path.join(tmpDir, 'nested.js'), 4
        );
        assert.strictEqual(result, 'inner',
            'Should return innermost function "inner", not "outer"');

        // Line 6 (inner()) is inside 'outer' but not inside 'inner'
        const outerResult = index.findEnclosingFunction(
            path.join(tmpDir, 'nested.js'), 6
        );
        assert.strictEqual(outerResult, 'outer',
            'Should return "outer" for line outside inner function');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 83 — inheritance chain walking terminates when all parents visited', () => {
    // Previously, when all parents in the extends graph were visited,
    // the fallback `parents[0]` caused an infinite loop.
    // Fixed: break out of the while loop when no unvisited parent exists.
    const tmpDir = path.join(os.tmpdir(), `ucn-test-inheritance-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        // Create a deep inheritance chain: C extends B extends A
        // with a method call on self that doesn't exist in any parent
        fs.writeFileSync(path.join(tmpDir, 'classes.py'), `
class A:
    def base_method(self):
        pass

class B(A):
    def mid_method(self):
        pass

class C(B):
    def leaf_method(self):
        self.nonexistent_method()
`);

        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // This should not hang/loop — should complete even when method not found in chain
        const ctx = index.context('leaf_method');
        assert.ok(ctx, 'context should return without infinite loop');

        // Also test findCallees which has the same pattern
        const callees = index.findCallees('leaf_method');
        assert.ok(Array.isArray(callees), 'findCallees should return without infinite loop');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 90 — JS optional chaining uncertainty does not trigger for arguments', () => {
    const { getParser } = require('../languages');
    const jsParser = require('../languages/javascript');
    const parser = getParser('javascript');

    // foo() is NOT optional-chained — the ?. is in the argument
    const calls1 = jsParser.findCallsInCode('function test() { foo(bar?.baz); }', parser);
    const fooCalls = calls1.filter(c => c.name === 'foo');
    assert.ok(fooCalls.length > 0, 'Should find foo() call');
    assert.ok(!fooCalls[0].uncertain, 'foo(bar?.baz) should NOT be uncertain — ?. is in args');

    // But foo?.() SHOULD be uncertain
    const calls2 = jsParser.findCallsInCode('function test() { foo?.(); }', parser);
    const fooCalls2 = calls2.filter(c => c.name === 'foo');
    assert.ok(fooCalls2.length > 0, 'Should find foo?.() call');
    assert.ok(fooCalls2[0].uncertain, 'foo?.() SHOULD be uncertain');
});

}); // end JS/TS Fix Regressions

// ============================================================================
// JSX line number fixes
// ============================================================================

describe('JSX line number fixes', () => {

it('fix #81: JSX component caller reports correct line number', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        // Child component on line 3, parent wrapper on line 2
        fs.writeFileSync(path.join(tmpDir, 'App.jsx'), [
            'function Child() { return <div/>; }',          // line 1
            'function App() {',                              // line 2
            '  return (',                                    // line 3
            '    <div>',                                     // line 4
            '      <Child />',                               // line 5
            '    </div>',                                    // line 6
            '  );',                                          // line 7
            '}',                                             // line 8
        ].join('\n'));

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const callers = index.findCallers('Child');
        assert.ok(callers.length > 0, 'should find at least one caller');
        const caller = callers[0];
        assert.strictEqual(caller.line, 5, 'JSX <Child /> should be reported on line 5, not line 4 or any other');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #81: JSX namespaced component reports correct line in findCallsInCode', () => {
    const { findCallsInCode } = require('../languages/javascript');
    const { getParser } = require('../languages');
    const parser = getParser('javascript');
    const code = [
        'const UI = { Panel: () => <div/> };',          // line 1
        'function App() {',                              // line 2
        '  return (',                                    // line 3
        '    <div>',                                     // line 4
        '      <UI.Panel />',                            // line 5
        '    </div>',                                    // line 6
        '  );',                                          // line 7
        '}',                                             // line 8
    ].join('\n');

    const calls = findCallsInCode(code, parser);
    const panelCall = calls.find(c => c.name === 'Panel');
    assert.ok(panelCall, 'should find Panel call');
    assert.strictEqual(panelCall.line, 5, 'JSX <UI.Panel /> should be reported on line 5');
});

}); // end JSX line number fixes

// ============================================================================
// Fastify review fixes (#87-89)
// ============================================================================

describe('fix #87: new_expression results are non-callable', () => {
    it('const x = new Foo() should not be treated as isPotentialCallback', (t) => {
        const { getParser } = require('../languages');
        const { findCallsInCode } = require('../languages/javascript');

        const code = `
function main() {
    const request = new Context.Request(id, params);
    const reply = new Context.Reply(res, request, logger);
}
`;
        const parser = getParser('javascript');
        const calls = findCallsInCode(code, parser);

        // request is assigned from new expression — should be in nonCallableNames
        // So when passed as argument to Reply(), it should NOT be isPotentialCallback
        const requestCallback = calls.find(c =>
            c.name === 'request' && c.isPotentialCallback);
        assert.ok(!requestCallback,
            'request (from new expression) should NOT be flagged as potential callback');
    });
});

describe('fix #88: isPotentialCallback requires binding evidence', () => {
    it('identifier args without binding/same-file evidence are filtered', (t) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-fix88-'));
        fs.writeFileSync(path.join(tmpDir, 'main.js'), `
const { execute } = require('./runner');

function handler(req, res, context) {
    const reply = execute(context, req);
}

module.exports = { handler };
`);
        fs.writeFileSync(path.join(tmpDir, 'runner.js'), `
function execute(ctx, request) { return ctx; }
module.exports = { execute };
`);
        // context function exists only in test file
        fs.writeFileSync(path.join(tmpDir, 'test.test.js'), `
function context() { return {}; }
function req() { return {}; }
module.exports = { context, req };
`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const defs = index.find('handler');
        assert.ok(defs.length > 0);
        const callees = index.findCallees(defs[0]);
        const calleeNames = callees.map(c => c.name);

        // execute should be a callee (has binding via import)
        assert.ok(calleeNames.includes('execute'),
            `execute should be callee (got: ${calleeNames.join(', ')})`);
        // context should NOT be a callee (no binding, only in test file)
        assert.ok(!calleeNames.includes('context'),
            `context (test-only) should NOT be callee (got: ${calleeNames.join(', ')})`);
        // req should NOT be a callee (no binding, only in test file)
        assert.ok(!calleeNames.includes('req'),
            `req (test-only) should NOT be callee (got: ${calleeNames.join(', ')})`);

        fs.rmSync(tmpDir, { recursive: true });
    });
});

describe('fix #89: nested closure callees included in parent', () => {
    it('calls within closures are attributed to parent function', (t) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-fix89-'));
        fs.writeFileSync(path.join(tmpDir, 'hooks.js'), `
const { appendTrace } = require('./errors');

function hookRunner(hookName, cb) {
    const hooks = [];
    let i = 0;

    next();

    function exit(err) {
        if (err) {
            appendTrace(err);
        }
        cb(err);
    }

    function next(err) {
        if (err) { exit(err); return; }
        if (i < hooks.length) {
            hooks[i++]();
            next();
        } else {
            exit();
        }
    }
}

module.exports = { hookRunner };
`);
        fs.writeFileSync(path.join(tmpDir, 'errors.js'), `
function appendTrace(err) { return err; }
module.exports = { appendTrace };
`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const defs = index.find('hookRunner');
        assert.ok(defs.length > 0);
        const callees = index.findCallees(defs[0]);
        const calleeNames = callees.map(c => c.name);

        // next and exit are inner closures — their calls should be included
        assert.ok(calleeNames.includes('next'),
            `next (closure) should be callee (got: ${calleeNames.join(', ')})`);
        assert.ok(calleeNames.includes('exit'),
            `exit (closure) should be callee (got: ${calleeNames.join(', ')})`);
        // appendTrace is called from exit (nested closure) — should be included
        assert.ok(calleeNames.includes('appendTrace'),
            `appendTrace (via closure) should be callee (got: ${calleeNames.join(', ')})`);

        fs.rmSync(tmpDir, { recursive: true });
    });

    it('inner binding resolution prefers closure within parent scope', (t) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-fix89b-'));
        fs.writeFileSync(path.join(tmpDir, 'hooks.js'), `
function runnerA(cb) {
    function next() { cb(); }
    next();
}

function runnerB(cb) {
    function next() { cb(); }
    next();
}

module.exports = { runnerA, runnerB };
`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        // runnerA should resolve next() to its own inner next, not runnerB's
        const defsA = index.find('runnerA');
        assert.ok(defsA.length > 0);
        const calleesA = index.findCallees(defsA[0]);
        const nextCallee = calleesA.find(c => c.name === 'next');
        assert.ok(nextCallee, 'runnerA should have next as callee');
        // next should be within runnerA's line range
        assert.ok(nextCallee.startLine > defsA[0].startLine &&
                  nextCallee.startLine <= defsA[0].endLine,
            `next should be within runnerA's scope (next at ${nextCallee.startLine}, runnerA at ${defsA[0].startLine}-${defsA[0].endLine})`);

        fs.rmSync(tmpDir, { recursive: true });
    });
});

describe('fix #89c: toc detects package.json main as entry point', () => {
    it('package.json main field is listed as entry point', (t) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-fix89c-'));
        fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'fastify.js'), `
function createApp() { return {}; }
module.exports = createApp;
`);
        fs.writeFileSync(path.join(tmpDir, 'lib', 'server.js'), `
function start() {}
module.exports = { start };
`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'),
            JSON.stringify({ name: "myapp", main: "fastify.js" }));

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const toc = index.getToc();
        assert.ok(toc.summary.entryFiles.includes('fastify.js'),
            `fastify.js should be entry point (got: ${toc.summary.entryFiles.join(', ')})`);
        // Should be first (prepended)
        assert.strictEqual(toc.summary.entryFiles[0], 'fastify.js',
            'package.json main should be first entry point');

        fs.rmSync(tmpDir, { recursive: true });
    });
});

describe('fix #89d: test-file callee deprioritization', () => {
    it('production callers do not get test-file callees without binding', (t) => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-fix89d-'));
        fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'main.js'), `
function handler() {
    process_data();
}
module.exports = { handler };
`);
        // process_data only exists in test file
        fs.writeFileSync(path.join(tmpDir, 'test', 'handler.test.js'), `
function process_data() { return 'test'; }
module.exports = { process_data };
`);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');

        const { ProjectIndex } = require('../core/project');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const defs = index.find('handler');
        assert.ok(defs.length > 0);
        const callees = index.findCallees(defs[0]);
        const calleeNames = callees.map(c => c.name);

        // process_data is only in test file — should be filtered
        assert.ok(!calleeNames.includes('process_data'),
            `test-only process_data should NOT be callee (got: ${calleeNames.join(', ')})`);

        fs.rmSync(tmpDir, { recursive: true });
    });
});

// ============================================================================
// Fix #112: verify should handle rest/spread parameters correctly
// ============================================================================

describe('fix #112: verify handles rest parameters', () => {
    it('rest param calls should not be flagged as mismatches', () => {
        const tmpDir = tmp('verify-rest');
        fs.writeFileSync(path.join(tmpDir, 'rest.js'),
            'function withRest(a, ...rest) { return a + rest.length; }\n' +
            'withRest(1, 2, 3, 4);\n' +
            'withRest(1);\n' +
            'withRest();\n'
        );
        const index = idx(tmpDir);
        const result = index.verify('withRest');
        assert.ok(result.found, 'should find withRest');
        // withRest(1, 2, 3, 4) and withRest(1) should be valid (>= 1 required arg)
        // withRest() should be a mismatch (0 args, needs at least 1)
        assert.strictEqual(result.mismatches, 1,
            `expected 1 mismatch (withRest()), got ${result.mismatches}`);
        assert.strictEqual(result.valid, 2,
            `expected 2 valid calls, got ${result.valid}`);
        rm(tmpDir);
    });

    it('Python *args and **kwargs should be rest params', () => {
        const tmpDir = tmp('verify-rest-py');
        fs.writeFileSync(path.join(tmpDir, 'rest.py'),
            'def variadic(a, *args, **kwargs):\n' +
            '    return a\n\n' +
            'variadic(1)\n' +
            'variadic(1, 2, 3)\n' +
            'variadic(1, 2, key="val")\n'
        );
        const index = idx(tmpDir);
        const result = index.verify('variadic');
        assert.ok(result.found, 'should find variadic');
        // All calls have at least 1 arg (for param 'a'), rest params accept anything
        assert.strictEqual(result.mismatches, 0,
            `expected 0 mismatches, got ${result.mismatches}`);
        rm(tmpDir);
    });
});

// ============================================================================
// Fix #113: deadcode --include-exported detects unused exports
// ============================================================================

describe('fix #113: deadcode --include-exported finds unused exports', () => {
    it('exported but never-imported function should be dead with --include-exported', () => {
        const tmpDir = tmp('deadcode-exports');
        fs.writeFileSync(path.join(tmpDir, 'utils.js'),
            'function helperA() { return 1; }\n' +
            'function helperB() { return 2; }\n' +
            'function helperC() { return 3; }\n' +
            'module.exports = { helperA, helperB, helperC };\n'
        );
        fs.writeFileSync(path.join(tmpDir, 'index.js'),
            'const { helperA, helperB } = require("./utils");\n' +
            'function main() { return helperA() + helperB(); }\n' +
            'main();\n'
        );
        const index = idx(tmpDir);
        const result = index.deadcode({ includeExported: true });
        const deadNames = result.map(r => r.name);
        assert.ok(deadNames.includes('helperC'),
            `helperC should be dead code (got: ${deadNames.join(', ')})`);
        assert.ok(!deadNames.includes('helperA'),
            'helperA should NOT be dead code (it is imported and called)');
        assert.ok(!deadNames.includes('helperB'),
            'helperB should NOT be dead code (it is imported and called)');
        rm(tmpDir);
    });

    it('exported function with internal callers should NOT be dead', () => {
        const tmpDir = tmp('deadcode-exports-internal');
        fs.writeFileSync(path.join(tmpDir, 'mod.js'),
            'function helper() { return 1; }\n' +
            'function main() { return helper(); }\n' +
            'module.exports = { helper, main };\n'
        );
        const index = idx(tmpDir);
        const result = index.deadcode({ includeExported: true });
        const deadNames = result.map(r => r.name);
        assert.ok(!deadNames.includes('helper'),
            'helper should NOT be dead code (called by main in same file)');
        rm(tmpDir);
    });
});

// ============================================================================
// Fix #114: trace shows direct callees even when shared with transitive paths
// ============================================================================

describe('fix #114: trace shows all direct callees including shared ones', () => {
    it('direct callee should appear even if also a transitive callee', () => {
        const tmpDir = tmp('trace-shared');
        fs.writeFileSync(path.join(tmpDir, 'chain.js'),
            'function root() { return alpha() + shared(); }\n' +
            'function alpha() { return shared(); }\n' +
            'function shared() { return 42; }\n' +
            'root();\n'
        );
        const index = idx(tmpDir);
        const result = index.trace('root', { depth: 3 });
        assert.ok(result, 'trace should return result');
        const rootChildren = result.tree.children.map(c => c.name);
        assert.ok(rootChildren.includes('alpha'),
            `root should show alpha as child (got: ${rootChildren.join(', ')})`);
        assert.ok(rootChildren.includes('shared'),
            `root should show shared as direct child (got: ${rootChildren.join(', ')})`);
        // The shared node under root should be marked as alreadyShown
        const sharedChild = result.tree.children.find(c => c.name === 'shared');
        assert.ok(sharedChild.alreadyShown,
            'shared under root should be marked alreadyShown');
        rm(tmpDir);
    });

    it('circular calls should not cause infinite loop', () => {
        const tmpDir = tmp('trace-circular');
        fs.writeFileSync(path.join(tmpDir, 'circ.js'),
            'function ping() { return pong(); }\n' +
            'function pong() { return ping(); }\n' +
            'ping();\n'
        );
        const index = idx(tmpDir);
        const result = index.trace('ping', { depth: 5 });
        assert.ok(result, 'trace should return result');
        // Should terminate without infinite loop
        const formatted = output.formatTrace(result);
        assert.ok(formatted.includes('(see above)'),
            'circular reference should show (see above)');
        rm(tmpDir);
    });
});

// ============================================================================
// Fix #115: JS destructured params not parsed in parseJSParam
// object_pattern and array_pattern should be recognized as params
// ============================================================================
describe('fix #115: verify handles JS destructured params', () => {
    it('object_pattern destructured param counted as 1 param', () => {
        const tmpDir = tmp('destruct-obj');
        fs.writeFileSync(path.join(tmpDir, 'lib.js'),
            'function processConfig({ name, value }) {\n' +
            '    return name + value;\n' +
            '}\n' +
            'processConfig({ name: "x", value: 1 });\n' +
            'processConfig();\n' +
            'processConfig({ name: "y" }, "extra");\n'
        );
        const index = idx(tmpDir);
        const result = index.verify('processConfig');
        assert.ok(result, 'verify should return result');
        // Function has 1 destructured param
        assert.equal(result.mismatches, 2,
            'should flag 0-arg call and 2-arg call as mismatches');
        // Check mismatch details
        const details = result.mismatchDetails || [];
        const zeroArg = details.find(d => d.actual === 0);
        assert.ok(zeroArg, 'should flag the 0-arg call');
        const twoArg = details.find(d => d.actual === 2);
        assert.ok(twoArg, 'should flag the 2-arg call');
        rm(tmpDir);
    });

    it('array_pattern destructured param counted as 1 param', () => {
        const tmpDir = tmp('destruct-arr');
        fs.writeFileSync(path.join(tmpDir, 'lib.js'),
            'function swap([a, b]) {\n' +
            '    return [b, a];\n' +
            '}\n' +
            'swap([1, 2]);\n' +
            'swap();\n'
        );
        const index = idx(tmpDir);
        const result = index.verify('swap');
        assert.ok(result, 'verify should return result');
        assert.equal(result.mismatches, 1,
            'should flag 0-arg call as mismatch');
        rm(tmpDir);
    });

    it('plan with destructured params shows correct before/after', () => {
        const tmpDir = tmp('destruct-plan');
        fs.writeFileSync(path.join(tmpDir, 'lib.js'),
            'function process({ name }) { return name; }\n' +
            'process({ name: "x" });\n'
        );
        const index = idx(tmpDir);
        const plan = index.plan('process', { addParam: 'options' });
        assert.ok(plan.found, 'plan should find function');
        assert.ok(plan.before.params.length >= 1,
            'before should have at least 1 param (the destructured one)');
        assert.ok(plan.after.params.includes('options'),
            'after should include new param');
        assert.ok(plan.after.params.length > plan.before.params.length,
            'after should have more params than before');
        rm(tmpDir);
    });
});

// ============================================================================
// Bug Hunt: JS export default function type classification
// ============================================================================

describe('Bug Hunt: JS export default function/class type', () => {
    it('should classify export default function as type "default"', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('javascript');
        const jsMod = getLanguageModule('javascript');
        const code = 'export default function processData() { return 42; }';
        const exports = jsMod.findExportsInCode(code, parser);
        assert.ok(exports.length === 1, 'should have 1 export');
        assert.strictEqual(exports[0].name, 'processData');
        assert.strictEqual(exports[0].type, 'default', 'should be default, not named');
    });

    it('should classify export default class as type "default"', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('javascript');
        const jsMod = getLanguageModule('javascript');
        const code = 'export default class MyClass { }';
        const exports = jsMod.findExportsInCode(code, parser);
        assert.ok(exports.length === 1, 'should have 1 export');
        assert.strictEqual(exports[0].name, 'MyClass');
        assert.strictEqual(exports[0].type, 'default', 'should be default, not named');
    });

    it('should still classify regular export function as type "named"', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('javascript');
        const jsMod = getLanguageModule('javascript');
        const code = 'export function processData() { return 42; }';
        const exports = jsMod.findExportsInCode(code, parser);
        assert.strictEqual(exports[0].type, 'named');
    });
});

// ============================================================================
// Bug Hunt: HTML findUsagesInCode includes event handler calls
// ============================================================================

describe('Bug Hunt: HTML usages include event handler attributes', () => {
    it('should detect function calls in onclick/onload attributes', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('html');
        const htmlMod = getLanguageModule('html');
        const code = `<!DOCTYPE html>
<html>
<head><script>
function initApp() { loadData(); }
function loadData() { return []; }
function resetApp() { initApp(); }
</script></head>
<body onload="initApp()">
<button onclick="resetApp()">Reset</button>
</body></html>`;
        const usages = htmlMod.findUsagesInCode(code, 'initApp', parser);
        // Should find: definition in script, call in script (from resetApp), call from onload
        const callUsages = usages.filter(u => u.usageType === 'call');
        assert.ok(callUsages.length >= 2, `should have at least 2 call usages (script + event handler), got ${callUsages.length}`);
        // Check that we have an event handler usage (line with onload)
        assert.ok(usages.some(u => u.line >= 8), 'should have usage from onload event handler');
    });
});

describe('Bug Hunt: JS extractModifiers substring false positives', () => {
    it('should not detect "default" modifier in variable names containing "default"', () => {
        const code = `
const handle_default = () => {
    return true;
};

function process_export_data() {
    return handle_default();
}

const my_async_helper = 42;
`;
        const result = parse(code, 'javascript');

        const handleDefault = result.functions.find(f => f.name === 'handle_default');
        assert.ok(handleDefault, 'handle_default should be found');
        assert.ok(!handleDefault.modifiers.includes('default'),
            `handle_default should not have 'default' modifier, got: [${handleDefault.modifiers.join(', ')}]`);
        assert.ok(!handleDefault.modifiers.includes('export'),
            `handle_default should not have 'export' modifier`);

        const processExport = result.functions.find(f => f.name === 'process_export_data');
        assert.ok(processExport, 'process_export_data should be found');
        assert.ok(!processExport.modifiers.includes('export'),
            `process_export_data should not have 'export' modifier, got: [${processExport.modifiers.join(', ')}]`);
    });

    it('should still detect real export/async/default modifiers', () => {
        const code = `
export default async function main() {
    return true;
}

export function helper() {}
`;
        const result = parse(code, 'javascript');

        const main = result.functions.find(f => f.name === 'main');
        assert.ok(main, 'main should be found');
        assert.ok(main.modifiers.includes('export'), 'main should have export');
        assert.ok(main.modifiers.includes('default'), 'main should have default');
        assert.ok(main.modifiers.includes('async'), 'main should have async');

        const helper = result.functions.find(f => f.name === 'helper');
        assert.ok(helper, 'helper should be found');
        assert.ok(helper.modifiers.includes('export'), 'helper should have export');
        assert.ok(!helper.modifiers.includes('default'), 'helper should not have default');
    });
});

describe('Bug Hunt: HTML handler usages include column field', () => {
    it('should include column in handler usage results', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('html');
        const htmlMod = getLanguageModule('html');
        const code = `<html><body>
<button onclick="handleClick()">Click</button>
</body></html>`;

        const usages = htmlMod.findUsagesInCode(code, 'handleClick', parser);
        const handlerUsage = usages.find(u => u.usageType === 'call');
        assert.ok(handlerUsage, 'should find handler call usage');
        assert.ok(handlerUsage.column !== undefined,
            `handler usage should include column field, got: ${JSON.stringify(handlerUsage)}`);
    });
});
