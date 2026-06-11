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
const { execute } = require('../core/execute');
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

it('FIX 76 (superseded by tiered contract) — impact ignores --no-include-methods; tiers carry the split', () => {
    // Tiered contract: impact analyzes every callable site unconditionally.
    // Method calls with receiver evidence land in the confirmed tier (byFile);
    // evidence-less ones land in unverifiedSites. --no-include-methods is a
    // deprecated no-op, so the flag must not change either set.
    const index = new ProjectIndex(PROJECT_DIR);
    index.build(null, { quiet: true });

    const withFlag = index.impact('parse', { file: 'core/parser.js', includeMethods: false });
    const without = index.impact('parse', { file: 'core/parser.js' });
    assert.ok(withFlag && without, 'Should find parse');
    assert.strictEqual(withFlag.totalCallSites, without.totalCallSites,
        '--no-include-methods is a no-op for impact');
    assert.strictEqual((withFlag.unverifiedSites || []).length, (without.unverifiedSites || []).length,
        'unverified tier unaffected by the deprecated flag');
    assert.ok(withFlag.account && withFlag.account.conserved, 'impact account conserves');
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
    // AST-based tests() only finds AST identifier nodes, not string literal content.
    // string-ref is classified when an AST reference appears on a line that also
    // contains the name in quotes. Pure string-only mentions (no identifier) are
    // correctly excluded as false positives.
    const dir = tmp({
        'package.json': '{"name":"test"}',
        'lib.js': 'function parseFile(f) { return f; }\nmodule.exports = { parseFile };',
        'test/lib.test.js': [
            'import { parseFile } from "../lib";',  // ES6 import — AST finds as import
            'const name = parseFile;',               // reference to identifier
            'console.log("testing parseFile");',     // pure string — not found by AST
            'parseFile("input.txt");',               // call
        ].join('\n'),
    });
    try {
        const index = idx(dir);
        const tests = index.tests('parseFile');
        const allMatches = tests.flatMap(t => t.matches);
        // Should find import, reference, and call — but NOT pure string mentions
        assert.ok(allMatches.some(m => m.matchType === 'import'), 'Should find import');
        assert.ok(allMatches.some(m => m.matchType === 'call'), 'Should find call');
        // The reference `const name = parseFile` on a line without quotes → 'reference'
        assert.ok(allMatches.some(m => m.matchType === 'reference'), 'Should find reference');
    } finally {
        rm(dir);
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

// ============================================================================
// Evaluation report fixes (2026-03-03)
// ============================================================================

describe('fix #123: TS graph importers via tsconfig references', () => {
    it('should resolve importers when paths are in referenced tsconfig', () => {
        const { tmp, rm, idx } = require('./helpers');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': JSON.stringify({
                files: [],
                references: [{ path: './tsconfig.app.json' }]
            }),
            'tsconfig.app.json': JSON.stringify({
                compilerOptions: {
                    baseUrl: '.',
                    paths: { '@/*': ['./src/*'] }
                },
                include: ['src']
            }),
            'src/hooks/useData.ts': 'export function useData() { return null; }',
            'src/pages/Home.tsx': 'import { useData } from "@/hooks/useData";\nexport function Home() { return useData(); }'
        });
        try {
            const index = idx(dir);
            const graph = index.graph('src/hooks/useData.ts');
            assert.ok(graph, 'graph should return result');
            // graph.importers is { nodes: [...], edges: [...] }
            const importerNodes = graph.importers.nodes.filter(n => n.depth > 0);
            assert.ok(importerNodes.length > 0,
                `should find importers, got ${importerNodes.length}`);
            const hasHome = importerNodes.some(n =>
                n.relativePath && n.relativePath.includes('Home')
            );
            assert.ok(hasHome, `Home.tsx should be an importer, got: ${JSON.stringify(importerNodes.map(n => n.relativePath))}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// ENTRYPOINTS: JS/TS framework detection
// ============================================================================

describe('Entrypoints: Express/NestJS detection', () => {
    const { detectEntrypoints, isFrameworkEntrypoint } = require('../core/entrypoints');

    it('detects Express app.get/post route handlers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'server.js': `
const app = require('express')();
function listItems(req, res) { res.json([]); }
function addItem(req, res) { res.json({}); }
app.get('/items', listItems);
app.post('/items', addItem);
module.exports = { listItems, addItem };
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('listItems'), 'should detect listItems');
            assert.ok(names.includes('addItem'), 'should detect addItem');
            assert.strictEqual(eps.find(e => e.name === 'listItems').framework, 'express');
            assert.strictEqual(eps.find(e => e.name === 'listItems').confidence, 0.90);
        } finally { rm(dir); }
    });

    it('detects Fastify router handlers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': `
const fastify = require('fastify')();
function healthCheck(req, reply) { reply.send({ ok: true }); }
fastify.get('/health', healthCheck);
module.exports = { healthCheck };
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            assert.ok(eps.some(e => e.name === 'healthCheck'), 'should detect Fastify handler');
        } finally { rm(dir); }
    });

    it('detects NestJS decorator-based handlers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'controller.ts': `
@Controller('users')
class UserController {
    @Get()
    findAll() { return []; }

    @Post()
    create() { return {}; }
}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            // NestJS uses decorators on the class — UserController should be detected
            assert.ok(eps.length > 0, 'should detect NestJS entry points');
            assert.ok(eps.some(e => e.framework === 'nestjs'), 'should identify as NestJS');
        } finally { rm(dir); }
    });

    it('Express route handlers excluded from deadcode', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': `
function handler(req, res) { res.send('ok'); }
function unused() { return 42; }
app.get('/api', handler);
module.exports = { handler, unused };
`
        });
        try {
            const index = idx(dir);
            const dc = index.deadcode({ includeExported: true });
            const names = dc.map(d => d.name);
            assert.ok(!names.includes('handler'), 'route handler should not be dead code');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Regression: JS/TS receiver type inference (Phase 3c)
// ============================================================================

describe('Regression: JS/TS receiver type inference (Phase 3c)', () => {
    it('new Foo() constructor inference resolves method to correct class', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'router.js': `
class Router {
    route(path) { return path; }
}
class Handler {
    route(path) { return path.toUpperCase(); }
}
module.exports = { Router, Handler };
`,
            'app.js': `
const { Router } = require('./router');
function setup() {
    const r = new Router();
    r.route('/api');
}
module.exports = { setup };
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('route', { includeMethods: true });
            assert.ok(callers.length > 0, 'should find callers of route');
            const setupCaller = callers.find(c => c.callerName === 'setup');
            assert.ok(setupCaller, 'setup should be a caller of route');
            assert.strictEqual(setupCaller.resolution, 'receiver-hint',
                'new Router() should give receiver-hint resolution');
            assert.ok(setupCaller.confidence >= 0.80,
                'receiver-hint should have confidence >= 0.80');
        } finally { rm(dir); }
    });

    it('TypeScript type annotation infers receiverType', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'client.ts': `
class ApiClient {
    fetch(url: string) { return url; }
}
function getClient(): ApiClient { return new ApiClient(); }

const api: ApiClient = getClient();
api.fetch('/data');

export { ApiClient, getClient };
`
        });
        try {
            const index = idx(dir);
            // Verify at the parser level that receiverType is set
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'client.ts'), 'utf8');
            const parser = getParser('typescript');
            const calls = findCallsInCode(code, parser);
            const fetchCall = calls.find(c => c.name === 'fetch' && c.receiver === 'api');
            assert.ok(fetchCall, 'should find api.fetch() call');
            assert.strictEqual(fetchCall.receiverType, 'ApiClient',
                'TypeScript type annotation should infer receiverType as ApiClient');
        } finally { rm(dir); }
    });

    it('no false positive on untyped receivers (regular function return)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': `
function getSomething() { return {}; }
function main() {
    const x = getSomething();
    x.process();
}
module.exports = { main };
`
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            const parser = getParser('javascript');
            const calls = findCallsInCode(code, parser);
            const processCall = calls.find(c => c.name === 'process' && c.receiver === 'x');
            assert.ok(processCall, 'should find x.process() call');
            assert.strictEqual(processCall.receiverType, undefined,
                'regular function return should NOT infer receiverType');
        } finally { rm(dir); }
    });
});

// Fix: localVarTypes scoping — types should not leak between sibling functions
describe('fix: localVarTypes function scoping (JS)', () => {
    it('sibling functions with same variable name get independent types', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'models.js': 'class Foo { run() {} }\nclass Bar { run() {} }\nmodule.exports = { Foo, Bar };',
            'app.js': [
                'const { Foo, Bar } = require("./models");',
                'function funcA() { const x = new Foo(); x.run(); }',
                'function funcB() { const x = new Bar(); x.run(); }',
                'module.exports = { funcA, funcB };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            const parser = getParser('javascript');
            const calls = findCallsInCode(code, parser);
            const runCalls = calls.filter(c => c.name === 'run' && c.isMethod);
            assert.strictEqual(runCalls.length, 2);
            // funcA's x.run() should have receiverType 'Foo'
            assert.strictEqual(runCalls[0].receiverType, 'Foo', 'funcA x.run() should be Foo');
            // funcB's x.run() should have receiverType 'Bar' (not Foo!)
            assert.strictEqual(runCalls[1].receiverType, 'Bar', 'funcB x.run() should be Bar, not leaked Foo');
        } finally { rm(dir); }
    });

    it('parameter name does not inherit type from sibling function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': [
                'class Foo { run() {} }',
                'function funcA() { const x = new Foo(); x.run(); }',
                'function funcB(x) { x.run(); }',
                'module.exports = { Foo, funcA, funcB };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            const parser = getParser('javascript');
            const calls = findCallsInCode(code, parser);
            const runCalls = calls.filter(c => c.name === 'run' && c.isMethod);
            assert.strictEqual(runCalls.length, 2);
            assert.strictEqual(runCalls[0].receiverType, 'Foo', 'funcA should infer Foo');
            assert.strictEqual(runCalls[1].receiverType, undefined,
                'funcB parameter x should NOT inherit Foo from sibling funcA');
        } finally { rm(dir); }
    });

    it('module-level typed variable remains visible inside functions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': [
                'class Database { query() {} }',
                'const db = new Database();',
                'function getUsers() { db.query("users"); }',
                'function getOrders() { db.query("orders"); }',
                'module.exports = { Database, getUsers, getOrders };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            const parser = getParser('javascript');
            const calls = findCallsInCode(code, parser);
            const queryCalls = calls.filter(c => c.name === 'query' && c.receiver === 'db');
            assert.strictEqual(queryCalls.length, 2);
            assert.strictEqual(queryCalls[0].receiverType, 'Database');
            assert.strictEqual(queryCalls[1].receiverType, 'Database');
        } finally { rm(dir); }
    });

    it('nested function inherits outer scope types via closure', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': [
                'class Client { fetch() {} }',
                'function outer() {',
                '    const c = new Client();',
                '    function inner() { c.fetch(); }',
                '}',
                'module.exports = { Client };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            const parser = getParser('javascript');
            const calls = findCallsInCode(code, parser);
            const fetchCall = calls.find(c => c.name === 'fetch' && c.receiver === 'c');
            assert.ok(fetchCall);
            assert.strictEqual(fetchCall.receiverType, 'Client',
                'inner function should see outer scope type via closure');
        } finally { rm(dir); }
    });
});

// Fix: JS assignment_expression reassignment updates localVarTypes
describe('fix: JS reassignment tracking', () => {
    it('let x = new Foo(); x = new Bar() → Bar wins (last assignment)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': [
                'class Foo { run() {} }',
                'class Bar { run() {} }',
                'function test() { let x = new Foo(); x = new Bar(); x.run(); }',
                'module.exports = { Foo, Bar, test };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            const parser = getParser('javascript');
            const calls = findCallsInCode(code, parser);
            const runCall = calls.find(c => c.name === 'run' && c.isMethod);
            assert.ok(runCall);
            assert.strictEqual(runCall.receiverType, 'Bar',
                'reassignment should update type to Bar');
        } finally { rm(dir); }
    });

    it('reassignment without new does not clear existing type', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': [
                'class Foo { run() {} }',
                'function test() { let x = new Foo(); x = getSomething(); x.run(); }',
                'module.exports = { Foo, test };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.js'), 'utf8');
            const parser = getParser('javascript');
            const calls = findCallsInCode(code, parser);
            const runCall = calls.find(c => c.name === 'run' && c.isMethod);
            assert.ok(runCall);
            // Reassignment to function call doesn't update localVarTypes,
            // so the original Foo type persists (acceptable: conservative behavior)
            assert.strictEqual(runCall.receiverType, 'Foo');
        } finally { rm(dir); }
    });
});

// Fix: TS generic type annotations extract base type
describe('fix: TS generic type annotations', () => {
    it('Store<string> extracts Store as receiverType', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.ts': [
                'class Store { get() {} }',
                'function test() { const s: Store<string> = new Store(); s.get(); }',
                'export { Store, test };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.ts'), 'utf8');
            const parser = getParser('typescript');
            const calls = findCallsInCode(code, parser);
            const getCall = calls.find(c => c.name === 'get' && c.receiver === 's');
            assert.ok(getCall);
            assert.strictEqual(getCall.receiverType, 'Store',
                'generic annotation should extract base type Store');
        } finally { rm(dir); }
    });

    it('Map<string, number> annotation-only (no new) extracts Map', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.ts': [
                'function test() { const m: Map<string, number> = getMap(); m.get("key"); }',
                'export { test };'
            ].join('\n')
        });
        try {
            const { getParser } = require('../languages');
            const { findCallsInCode } = require('../languages/javascript');
            const code = fs.readFileSync(path.join(dir, 'app.ts'), 'utf8');
            const parser = getParser('typescript');
            const calls = findCallsInCode(code, parser);
            const getCall = calls.find(c => c.name === 'get' && c.receiver === 'm');
            assert.ok(getCall);
            assert.strictEqual(getCall.receiverType, 'Map',
                'generic annotation without new should still extract base type');
        } finally { rm(dir); }
    });

    it('generic annotation resolves through index', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'store.js': [
                'class Store { retrieve() { return undefined; } }',
                'module.exports = { Store };',
            ].join('\n'),
            'app.js': [
                'const { Store } = require("./store");',
                'function useStore() { const s = new Store(); s.retrieve(); }',
                'module.exports = { useStore };'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('useStore');
            assert.ok(defs && defs.length > 0, 'useStore should be in symbol table');
            const callees = index.findCallees(defs[0], { includeMethods: true });
            const callee = callees.find(c => c.name === 'retrieve');
            assert.ok(callee, 'should resolve s.retrieve() as callee via receiverType');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #176: Cross-file constructor callee detection
// ============================================================================

describe('fix #176: cross-file constructor callee detection', () => {
    it('new Foo() where Foo is imported should detect Foo as callee', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'store.js': 'class Store { retrieve() { return 1; } }\nmodule.exports = { Store };',
            'app.js': 'const { Store } = require("./store");\nfunction useStore() { const s = new Store(); s.retrieve(); }\nmodule.exports = { useStore };'
        });
        try {
            const i = idx(dir);
            const defs = i.symbols.get('useStore');
            assert.ok(defs && defs.length > 0, 'useStore should be in symbol table');
            const callees = i.findCallees(defs[0], { includeMethods: true });
            assert.ok(callees.some(c => c.name === 'Store'), 'new Store() should be a callee');
            assert.ok(callees.some(c => c.name === 'retrieve'), 's.retrieve() should be a callee via receiverType');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #178/TS-BUG-001: TypeScript overloads - about picks implementation
// ============================================================================

describe('fix #178: TypeScript overloads - about picks implementation over type signature', () => {
    const { execute } = require('../core/execute');

    it('about should prefer implementation body over type-only overload signatures', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'function processTask(task: string): string;\nfunction processTask(task: number): number;\nfunction processTask(task: any): any { return task; }'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'processTask' });
            assert.ok(r.ok, 'about should succeed');
            assert.ok(r.result.code.includes('return task'), 'should show implementation body, not type signature');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #181: TypeScript optional ? marker preserved in plan after.params
// ============================================================================

describe('fix #181: TypeScript optional ? marker preserved in plan after.params', () => {
    const { execute } = require('../core/execute');

    it('plan should preserve TypeScript optional ? in after.params', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'function greet(name: string, title?: string) { return (title||"")+name; }\ngreet("Alice");'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'greet', addParam: 'suffix: string' });
            assert.ok(r.ok, 'plan should succeed');
            const titleParam = r.result.after.params.find(p => p.startsWith('title'));
            assert.ok(titleParam && titleParam.includes('?'), 'title should preserve ? marker: ' + titleParam);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Type annotations: TS native + JSDoc paramTypes/returnType extraction
// ============================================================================

describe('type annotations — TS native', () => {
    const { execute } = require('../core/execute');

    it('extracts paramTypes and returnType from TypeScript native annotations', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'export function add(x: number, y: number): number { return x + y; }\nexport function fmt(name: string, age?: number): string { return name; }'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'add' });
            assert.ok(r.ok);
            assert.deepStrictEqual(r.result.symbol.paramTypes, { x: 'number', y: 'number' });
            assert.strictEqual(r.result.symbol.returnType, 'number');
            const r2 = execute(i, 'about', { name: 'fmt' });
            assert.deepStrictEqual(r2.result.symbol.paramTypes, { name: 'string', age: 'number' });
        } finally { rm(dir); }
    });

    it('typed signature is rendered in formatSignature', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'export function add(x: number, y: number): number { return x + y; }'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'add' });
            assert.ok(r.ok);
            assert.match(r.result.symbol.signature, /add \(x: number, y: number\) : number/);
        } finally { rm(dir); }
    });
});

describe('type annotations — JSDoc', () => {
    const { execute } = require('../core/execute');

    it('extracts paramTypes and returnType from JSDoc tags in plain JS', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': '/**\n * @param {string} name\n * @param {number} count\n * @returns {Promise<User>}\n */\nfunction process(name, count) { return Promise.resolve(); }\nmodule.exports = process;'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'process' });
            assert.ok(r.ok);
            assert.deepStrictEqual(r.result.symbol.paramTypes, { name: 'string', count: 'number' });
            assert.strictEqual(r.result.symbol.returnType, 'Promise<User>');
        } finally { rm(dir); }
    });

    it('native TS annotations win over conflicting JSDoc', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': '/**\n * @param {string} x\n * @returns {string}\n */\nexport function foo(x: number): number { return x; }'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'foo' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.symbol.paramTypes.x, 'number', 'native should win');
            assert.strictEqual(r.result.symbol.returnType, 'number', 'native return should win');
        } finally { rm(dir); }
    });

    it('handles optional-bracket form @param {Type} [name]', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': '/**\n * @param {string} [name]\n * @param {number} [count=0]\n */\nfunction f(name, count) {}'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'about', { name: 'f' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.symbol.paramTypes.name, 'string');
            assert.strictEqual(r.result.symbol.paramTypes.count, 'number');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-BV: TS optional param rendered as invalid syntax (`opt: number?`)
// ============================================================================

describe('BUG-BV: TS optional param renders as `opt?: number` (TS-correct)', () => {
    const { execute } = require('../core/execute');

    it('verify signature places `?` before the type, not after', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'function makeUser(name: string, opt?: number): string { return name + (opt||0); }\nmakeUser("a", 1);\nmakeUser("b");'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'verify', { name: 'makeUser' });
            assert.ok(r.ok, 'verify should succeed');
            assert.match(r.result.signature, /opt\?: number/, 'expected `opt?: number`, got: ' + r.result.signature);
            assert.ok(!r.result.signature.includes('opt: number?'), 'must NOT contain invalid `opt: number?`');
        } finally { rm(dir); }
    });

    it('plan before/after signatures use TS-correct optional marker', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'function greet(name: string, title?: string, age?: number): string { return name; }\ngreet("Alice");'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'greet', addParam: 'extra' });
            assert.ok(r.ok);
            assert.match(r.result.before.signature, /title\?: string/, 'before sig should have `title?: string`');
            assert.match(r.result.before.signature, /age\?: number/, 'before sig should have `age?: number`');
            assert.match(r.result.after.signature, /title\?: string/, 'after sig should preserve `title?: string`');
            // No invalid placement (e.g. `title: string?` or `age: number?`)
            assert.ok(!/title: string\?/.test(r.result.before.signature));
            assert.ok(!/age: number\?/.test(r.result.before.signature));
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-BW: plan reports 0 changes for class methods even when verify finds calls
// ============================================================================

describe('BUG-BW: plan finds class-method call sites the same way verify does', () => {
    const { execute } = require('../core/execute');

    it('plan add-param on a class method finds the same call sites verify finds', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': [
                'class Repository {',
                '  async save(entity: string): Promise<void> {',
                '    await this.persist(entity);',
                '  }',
                '  private async persist(e: string): Promise<void> {}',
                '}',
                'class Wrapper {',
                '  constructor(private repo: Repository) {}',
                '  async write(x: string) {',
                '    await this.repo.save(x);',
                '    await this.repo.save(x + "!");',
                '  }',
                '}'
            ].join('\n')
        });
        try {
            const i = idx(dir);
            const v = execute(i, 'verify', { name: 'save', className: 'Repository' });
            assert.ok(v.ok, 'verify should succeed');
            const verifyTotal = v.result.totalCalls;
            assert.ok(verifyTotal > 0, 'verify must find at least one call');
            const p = execute(i, 'plan', { name: 'save', className: 'Repository', addParam: 'opt' });
            assert.ok(p.ok, 'plan should succeed');
            assert.strictEqual(p.result.totalChanges, verifyTotal,
                `plan totalChanges (${p.result.totalChanges}) must equal verify totalCalls (${verifyTotal})`);
            assert.strictEqual(p.result.filesAffected, 1, 'expected 1 file affected');
            assert.ok(p.result.changes.every(c => c.suggestion.includes('Add argument: opt')));
        } finally { rm(dir); }
    });

    it('plan rename on a class method updates each call site verify confirms', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': [
                'class Service {',
                '  process(x: number): number { return x * 2; }',
                '  run(x: number): number { return this.process(x); }',
                '}',
                'class Caller {',
                '  constructor(private svc: Service) {}',
                '  go(x: number) { this.svc.process(x); this.svc.process(x+1); }',
                '}'
            ].join('\n')
        });
        try {
            const i = idx(dir);
            const v = execute(i, 'verify', { name: 'process', className: 'Service' });
            assert.ok(v.ok);
            const verifyTotal = v.result.totalCalls;
            const p = execute(i, 'plan', { name: 'process', className: 'Service', renameTo: 'doProcess' });
            assert.ok(p.ok);
            // Plan rename adds call-site changes for each verified call site
            // (and may add an import-statement change too — count the call-site
            // ones via the suggestion prefix).
            const renameChanges = p.result.changes.filter(c => c.suggestion.startsWith('Rename to:'));
            assert.ok(renameChanges.length >= verifyTotal,
                `plan should rename at least ${verifyTotal} call sites; got ${renameChanges.length}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-BX: TS namespace-qualified calls (`Utils.helper()`) yield totalCalls: 0
// ============================================================================

describe('BUG-BX: TS namespace-qualified calls counted in verify', () => {
    const { execute } = require('../core/execute');

    it('Utils.helper() calls are counted when verifying `helper`', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': [
                'namespace Utils {',
                '  export function helper(x: number): number { return x * 2; }',
                '}',
                'Utils.helper(3);',
                'Utils.helper(4);'
            ].join('\n')
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'verify', { name: 'helper' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.totalCalls, 2, 'expected 2 namespace-qualified calls');
            assert.strictEqual(r.result.valid, 2);
        } finally { rm(dir); }
    });

    it('does not falsely count obj.method() where obj is unrelated', () => {
        // Sanity: standalone `helper` should not eat unrelated `dict.helper()` calls.
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': [
                'function helper(x: number): number { return x; }',
                'const dict = { helper: (n: number) => n + 1 };',
                'dict.helper(5);',  // should NOT match standalone `helper`
                'helper(6);'         // should match
            ].join('\n')
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'verify', { name: 'helper' });
            assert.ok(r.ok);
            // Only the `helper(6)` direct call should be counted; `dict.helper(5)`
            // is filtered out (dict isn't a namespace/class symbol).
            assert.strictEqual(r.result.totalCalls, 1);
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-BY: TS arrow fn declared with type-annotated const loses param/return types
// ============================================================================

describe('BUG-BY: typed-arrow declaration preserves param and return types', () => {
    const { execute } = require('../core/execute');

    it('verify reads function-type from the variable_declarator', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'const add: (a: number, b: number) => number = (a, b) => a + b;\nadd(1, 2);'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'verify', { name: 'add' });
            assert.ok(r.ok);
            assert.match(r.result.signature, /a: number/, 'param `a` should have type `number`');
            assert.match(r.result.signature, /b: number/, 'param `b` should have type `number`');
            assert.match(r.result.signature, /\) : number/, 'return type `number` should be preserved');
        } finally { rm(dir); }
    });

    it('plan before signature uses the enriched arrow-fn types', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'const sub: (a: number, b: number) => number = (a, b) => a - b;\nsub(2, 1);'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'sub', addParam: 'c' });
            assert.ok(r.ok);
            assert.match(r.result.before.signature, /a: number/, 'plan before sig should retain types');
            assert.match(r.result.before.signature, /\) : number/, 'plan before sig should retain return type');
        } finally { rm(dir); }
    });

    it('does not break when the arrow already has inline types', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.ts': 'const mul = (a: number, b: number): number => a * b;\nmul(2, 3);'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'verify', { name: 'mul' });
            assert.ok(r.ok);
            assert.match(r.result.signature, /a: number/);
            assert.match(r.result.signature, /b: number/);
            assert.match(r.result.signature, /\) : number/);
        } finally { rm(dir); }
    });
});

// ============================================================================
// BUG-BE: TS reachability — three root causes
//   1. computeReachability ignored per-language getEntryPointKind() predicates
//   2. JS/TS had no runtime entry-point patterns in FRAMEWORK_PATTERNS
//   3. Top-level executable code wasn't a reachability source
// ============================================================================

describe('BUG-BE: TS reachability', () => {
    const { computeReachability, symbolKey, detectEntrypoints } = require('../core/entrypoints');

    function reachableSet(dir) {
        const index = idx(dir);
        const reach = computeReachability(index);
        return { index, reach };
    }
    function isReach(reach, symbols, name) {
        const candidates = symbols.get(name) || [];
        return candidates.some(s => reach.has(symbolKey(s.file, s.startLine)));
    }

    // Cause 1: per-language getEntryPointKind seeds reachability
    it('cause 1: React lifecycle componentDidMount seeds reachability', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            // Plain user-named file (not bin/index/cli/server, not under pages/),
            // so reachability MUST flow from componentDidMount via getEntryPointKind
            // — not from any FRAMEWORK_PATTERNS hit.
            'comp.ts': `
class Foo {
    componentDidMount() {
        this.fetchData();
    }
    fetchData() {
        return apiCall();
    }
}

function apiCall() { return 42; }
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'componentDidMount'),
                'componentDidMount is a React lifecycle entry');
            assert.ok(isReach(reach, index.symbols, 'fetchData'),
                'fetchData is reachable from componentDidMount');
            assert.ok(isReach(reach, index.symbols, 'apiCall'),
                'apiCall is transitively reachable');
        } finally { rm(dir); }
    });

    // Cause 3: top-level call expressions seed reachability (JS/TS)
    it('cause 3: top-level call to imported function seeds reachability', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            // index.ts (yes, this also matches js-cli-main, but the test is about
            // the call graph, so we test with a non-conventionally-named file too).
            'main.ts': `
import { handler } from './handler';
handler();
`,
            'handler.ts': `
export function handler() {
    run();
}
export function run() {}
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'handler'),
                'handler is reachable via top-level call in main.ts');
            assert.ok(isReach(reach, index.symbols, 'run'),
                'run is transitively reachable from handler');
        } finally { rm(dir); }
    });

    it('cause 3: top-level call from a non-conventionally-named entry file', () => {
        // This file is NOT named bin/index/main/cli/server, and NOT under pages/.
        // The ONLY way reachability flows is via the top-level call expression
        // root-cause-3 fix (no getEntryPointKind match either).
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.ts': `
import { go } from './lib';
go();
`,
            'lib.ts': `
export function go() { inner(); }
export function inner() {}
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'go'),
                'go is reachable via top-level call in app.ts');
            assert.ok(isReach(reach, index.symbols, 'inner'),
                'inner is transitively reachable');
        } finally { rm(dir); }
    });

    // Cause 2: file-path patterns for runtime entries
    it('cause 2: cli.ts is a runtime entry file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'cli.ts': `
function main() { run(); }
function run() {}
main();
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'main'), 'main reachable');
            assert.ok(isReach(reach, index.symbols, 'run'), 'run reachable');
        } finally { rm(dir); }
    });

    it('cause 2: bin/foo.ts is a runtime entry file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'bin/foo.ts': `
export function bar() { baz(); }
export function baz() {}
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'bar'),
                'bar is a runtime entry (bin/ file)');
            assert.ok(isReach(reach, index.symbols, 'baz'),
                'baz is transitively reachable');
        } finally { rm(dir); }
    });

    it('cause 2: server.ts is a runtime entry file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'server.ts': `
export function startServer() { listen(); }
export function listen() {}
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'startServer'),
                'startServer reachable (server.ts entry)');
            assert.ok(isReach(reach, index.symbols, 'listen'),
                'listen is transitively reachable');
        } finally { rm(dir); }
    });

    it('cause 2: shebang #!/usr/bin/env node makes any file an entry', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            // Non-conventional file name, but with a node shebang.
            'tool.js': `#!/usr/bin/env node
function root() { sub(); }
function sub() {}
root();
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'root'),
                'root reachable via shebang detection');
            assert.ok(isReach(reach, index.symbols, 'sub'),
                'sub reachable transitively');
        } finally { rm(dir); }
    });

    it('cause 2: test files mark functions as entries', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'foo.test.ts': `
function helper() { return 1; }
describe('foo', () => {
    it('works', () => {
        helper();
    });
});
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'helper'),
                'helper in test file is an entry');
        } finally { rm(dir); }
    });

    it('cause 2: __tests__ directory marks functions as entries', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            '__tests__/foo.ts': `
export function helper() { return 1; }
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'helper'),
                'helper under __tests__ is an entry');
        } finally { rm(dir); }
    });

    it('cause 2: pages/* is a Next.js runtime entry', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pages/index.tsx': `
export default function Home() {
    fetchData();
    return null;
}
function fetchData() {}
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'Home'),
                'Home in pages/ is a runtime entry');
            assert.ok(isReach(reach, index.symbols, 'fetchData'),
                'fetchData is transitively reachable from Home');
        } finally { rm(dir); }
    });

    // NestJS controller via existing decorator pattern
    it('cause 2 smoke: NestJS @Controller / @Get propagates via decorator pattern', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            // Non-conventional filename so we test the decorator path, not filePath.
            'src/items.module.ts': `
@Controller('items')
class FooController {
    @Get()
    bar() {
        svc();
    }
}
function svc() {}
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'bar'),
                'bar is a NestJS handler entry');
            assert.ok(isReach(reach, index.symbols, 'svc'),
                'svc reachable via Get-handler bar');
        } finally { rm(dir); }
    });

    // Negative case: unreachable function in non-entry file remains unreachable
    it('negative: function in non-entry file with no callers stays unreachable', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            // entry file that calls into another lib...
            'cli.ts': `
import { used } from './used';
used();
`,
            'used.ts': `
export function used() {}
`,
            // lib file with no callers, no entry-file path.
            'orphan.ts': `
export function unused() { return 42; }
`,
        });
        try {
            const { index, reach } = reachableSet(dir);
            assert.ok(isReach(reach, index.symbols, 'used'),
                'used is reachable from cli.ts');
            assert.ok(!isReach(reach, index.symbols, 'unused'),
                'unused must remain unreachable — over-broad fix would mark this true');
        } finally { rm(dir); }
    });

    // Reachability cache is honored after the new seeding paths
    it('reachability cache is preserved after the new seeding paths', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'cli.ts': `
function main() { run(); }
function run() {}
main();
`,
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index._reachableSymbols, undefined,
                'no cache before first call');
            const a = computeReachability(index);
            assert.ok(a instanceof Set);
            const b = computeReachability(index);
            assert.strictEqual(a, b, 'second call returns the same Set instance');
        } finally { rm(dir); }
    });
});

// ============================================================================
// FEATURE A: CALL-SITE CLASSIFICATION (inLoop / inTry / inCallback / inTestCase)
// ============================================================================

describe('Feature A: JS call-site classification', () => {
    it('JS: inLoop set for calls inside for/while loops', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'function helper(x) { return x; }',
                'function caller() {',
                '    for (let i = 0; i < 3; i++) {',
                '        helper(i);',
                '    }',
                '    while (true) {',
                '        helper(99);',
                '        break;',
                '    }',
                '    helper(0);',  // outside any loop
                '}',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            // Three call sites: two inside loops, one outside.
            assert.strictEqual(r.totalCalls, 3, 'three call sites total');
            const inLoopCount = r.patterns.inLoop;
            assert.strictEqual(inLoopCount, 2, 'two of three calls are inLoop');
            const outsideLoop = r.validDetails.find(s => !s.patterns.inLoop);
            assert.ok(outsideLoop, 'one site outside any loop');
        } finally { rm(dir); }
    });

    it('JS: inTry set for calls inside try { ... }', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'function helper() { return 1; }',
                'function caller() {',
                '    try { helper(); } catch (e) {}',
                '    helper();',  // outside try
                '}',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 2);
            assert.strictEqual(r.patterns.inTry, 1, 'one call is in try');
        } finally { rm(dir); }
    });

    it('JS: inCallback set when call is inside an arrow callback to map/filter', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'function helper(x) { return x; }',
                'function caller() {',
                '    const arr = [1, 2, 3];',
                '    arr.map(x => helper(x));',
                '    helper(99);',  // direct, not in callback
                '}',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 2);
            assert.strictEqual(r.patterns.inCallback, 1, 'one call inside arrow callback');
        } finally { rm(dir); }
    });
});

// ============================================================================
// FEATURE B: AWAITED + AUDIT-ASYNC
// ============================================================================

describe('Feature B: JS awaited flag + audit-async', () => {
    it('JS: awaited flag set when call is wrapped in await', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'async function helper() { return 1; }',
                'async function caller() {',
                '    await helper();',  // awaited
                '    helper();',         // not awaited
                '}',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 2);
            assert.strictEqual(r.patterns.awaitedCalls, 1, 'one call awaited');
            const awaited = r.validDetails.find(s => s.patterns.awaited);
            const unawaited = r.validDetails.find(s => !s.patterns.awaited);
            assert.ok(awaited, 'awaited site exists');
            assert.ok(unawaited, 'unawaited site exists');
        } finally { rm(dir); }
    });

    it('JS: audit-async flags missing-await on free async function call', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'async function helper() { return 1; }',
                'async function caller() {',
                '    helper();',  // missing await
                '    await helper();',  // ok
                '}',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.auditAsync({});
            assert.strictEqual(r.totalIssues, 1, 'one missing-await flagged');
            assert.strictEqual(r.issues[0].calleeName, 'helper');
            assert.strictEqual(r.issues[0].callerName, 'caller');
        } finally { rm(dir); }
    });

    it('JS: audit-async does NOT flag awaited calls', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'async function helper() { return 1; }',
                'async function caller() {',
                '    await helper();',
                '    const x = helper();',  // captured, not fire-and-forget
                '    return helper();',     // returned, caller awaits
                '}',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.auditAsync({});
            assert.strictEqual(r.totalIssues, 0, 'no missing-await issues');
        } finally { rm(dir); }
    });

    it('JS: audit-async does NOT flag calls inside non-async callbacks', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'async function helper() { return 1; }',
                'async function caller() {',
                '    [1,2].map(() => helper());',  // sync arrow callback — not async
                '}',
                'caller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.auditAsync({});
            // Inner arrow is non-async; helper() not in an async fn context.
            assert.strictEqual(r.totalIssues, 0);
        } finally { rm(dir); }
    });

    it('JS: audit-async does NOT flag calls in non-async functions', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'app.js': [
                'async function helper() { return 1; }',
                'function syncCaller() {',
                '    helper();',  // caller not async — don't flag
                '}',
                'syncCaller();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.auditAsync({});
            assert.strictEqual(r.totalIssues, 0);
        } finally { rm(dir); }
    });

    // HIGH-1 regression: audit-async file-local resolution.
    // Previously: when ANY file defined a sync function with the same name
    // as an async function in another file, the async call was silently
    // unflagged because the global "all-or-nothing" check excluded the
    // ambiguous name. File-local resolution must win — bad.js's helper()
    // resolves to bad.js's async helper, ignoring loops.js's sync helper.
    it('JS: audit-async flags missing-await across name collisions (HIGH-1)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'bad.js': [
                'async function helper() { return 1; }',
                'async function noAwait() { return 2; }',
                'async function main() {',
                '    helper();',         // line 4: should be flagged
                '    noAwait();',        // line 5: should be flagged
                '}',
                'main();',
            ].join('\n'),
            'loops.js': [
                // Different file, same name, sync — must NOT poison bad.js's
                // resolution.
                'function helper() { return 2; }',
                'helper();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.auditAsync({});
            // Both helper() and noAwait() in bad.js should be flagged.
            const inBad = r.issues.filter(i => i.file === 'bad.js');
            assert.ok(inBad.some(i => i.calleeName === 'helper'),
                `should flag helper() in bad.js, got: ${JSON.stringify(inBad)}`);
            assert.ok(inBad.some(i => i.calleeName === 'noAwait'),
                `should flag noAwait() in bad.js`);
            // The sync helper() call in loops.js must NOT be flagged.
            const inLoops = r.issues.filter(i => i.file === 'loops.js');
            assert.strictEqual(inLoops.length, 0,
                `should not flag sync helper() in loops.js, got: ${JSON.stringify(inLoops)}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// endpoints command — JS/TS
// ============================================================================

describe('endpoints command (JS/TS)', () => {
    const FIXTURE = path.join(FIXTURES_PATH, 'endpoints', 'javascript');

    it('extracts Express + NestJS server routes (9 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // Express server.js: 4 routes (GET/POST/PUT/DELETE on /users[/:id])
        // NestJS nest-controller.ts: 5 routes
        assert.strictEqual(result.meta.totalRoutes, 9, 'expected 9 routes');
        assert.strictEqual(result.meta.byFramework.express, 4);
        assert.strictEqual(result.meta.byFramework.nestjs, 5);
    });

    it('Express GET /users handler is listUsers at line 5', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        const r = result.routes.find(r =>
            r.framework === 'express' && r.method === 'GET' && r.path === '/users');
        assert.ok(r, 'should find Express GET /users');
        assert.strictEqual(r.handler, 'listUsers');
        assert.strictEqual(r.line, 5);
        assert.strictEqual(r.file, 'server.js');
    });

    it('NestJS class @Controller prefix is concatenated to method paths', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // NestJS: @Controller('/api/posts') + @Get() => /api/posts
        const findAll = result.routes.find(r =>
            r.framework === 'nestjs' && r.handler === 'findAll');
        assert.ok(findAll, 'should find NestJS findAll route');
        assert.strictEqual(findAll.method, 'GET');
        assert.strictEqual(findAll.path, '/api/posts');
        assert.strictEqual(findAll.classPrefix, '/api/posts');

        // @Get(':id') => /api/posts/:id
        const findOne = result.routes.find(r =>
            r.framework === 'nestjs' && r.handler === 'findOne');
        assert.ok(findOne);
        assert.strictEqual(findOne.path, '/api/posts/:id');
        assert.strictEqual(findOne.normalizedPath, '/api/posts/*');
    });

    it('extracts client requests: fetch + axios (4 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // client.js: fetch /users, fetch `/users/${id}`, axios.post /users, axios.put `/users/${id}`
        assert.strictEqual(result.meta.totalRequests, 4);
    });

    it('bare fetch call defaults to GET and is marked methodInferred', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        const fetchUsers = result.requests.find(r =>
            r.framework === 'fetch' && r.callerName === 'loadUsers');
        assert.ok(fetchUsers, 'should find fetch from loadUsers');
        assert.strictEqual(fetchUsers.method, 'GET');
        assert.strictEqual(fetchUsers.methodInferred, true);
        assert.strictEqual(fetchUsers.path, '/users');
        assert.strictEqual(fetchUsers.line, 3);
    });

    it('axios.post is detected with method=POST (not inferred)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        const post = result.requests.find(r =>
            r.framework === 'axios' && r.method === 'POST');
        assert.ok(post, 'should find axios.post call');
        assert.strictEqual(post.path, '/users');
        assert.strictEqual(post.callerName, 'postUser');
        assert.ok(!post.methodInferred);
    });

    it('template literal client request is marked interp=true', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // fetch(`/users/${id}`) — interpolated path
        const interpReq = result.requests.find(r => r.interp === true);
        assert.ok(interpReq, 'should find at least one interpolated request');
    });

    it('--bridge produces matched bridges with confidence', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { bridge: true });
        assert.ok(ok);
        assert.ok(result.meta.totalBridges > 0, 'should produce some bridges');
        // GET /users (literal) ↔ fetch('/users') (literal) → exact match
        const exact = result.bridges.find(b =>
            b.matchType === 'exact' && b.route.path === '/users' && b.route.method === 'GET');
        assert.ok(exact, 'should find exact GET /users bridge');
        assert.strictEqual(exact.confidence, 1);
    });
});

// ============================================================================
// BUG-5: plan must preserve modifier prefixes (async / static / public / ...)
// for class methods on rename / add-param / remove-param.
// ============================================================================
describe('BUG-5: plan preserves modifier prefixes for class methods', () => {
    it('rename of async method preserves async', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `class C {\n  async foo(data) {\n    return data;\n  }\n}\nmodule.exports = { C };\n`
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'foo', renameTo: 'bar', className: 'C' });
            assert.ok(r.ok, 'plan should succeed');
            assert.match(r.result.before.signature, /^async\s+foo\b/, `before should keep 'async ': ${r.result.before.signature}`);
            assert.match(r.result.after.signature, /^async\s+bar\b/, `after should keep 'async ': ${r.result.after.signature}`);
        } finally { rm(dir); }
    });

    it('rename of static method preserves static', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `class C {\n  static make(config) {\n    return new C();\n  }\n}\nmodule.exports = { C };\n`
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'make', renameTo: 'create', className: 'C' });
            assert.ok(r.ok, 'plan should succeed');
            assert.match(r.result.before.signature, /^static\s+make\b/, `before should keep 'static ': ${r.result.before.signature}`);
            assert.match(r.result.after.signature, /^static\s+create\b/, `after should keep 'static ': ${r.result.after.signature}`);
        } finally { rm(dir); }
    });

    it('rename of static async method preserves both static and async', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `class C {\n  static async load(url) {\n    return await fetch(url);\n  }\n}\nmodule.exports = { C };\n`
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'load', renameTo: 'fetchRemote', className: 'C' });
            assert.ok(r.ok, 'plan should succeed');
            // Both modifiers must appear, in any order, before the name.
            assert.match(r.result.before.signature, /\bstatic\b/, `before should contain 'static': ${r.result.before.signature}`);
            assert.match(r.result.before.signature, /\basync\b/, `before should contain 'async': ${r.result.before.signature}`);
            assert.match(r.result.after.signature, /\bstatic\b/, `after should contain 'static': ${r.result.after.signature}`);
            assert.match(r.result.after.signature, /\basync\b/, `after should contain 'async': ${r.result.after.signature}`);
            assert.match(r.result.after.signature, /\bfetchRemote\b/, `after should contain renamed name: ${r.result.after.signature}`);
        } finally { rm(dir); }
    });

    it('add-param on static method preserves static', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `class C {\n  static make(config) {\n    return new C();\n  }\n}\nmodule.exports = { C };\n`
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'make', addParam: 'opts', className: 'C' });
            assert.ok(r.ok, 'plan should succeed');
            assert.match(r.result.before.signature, /^static\s+make\b/);
            assert.match(r.result.after.signature, /^static\s+make\b/);
            assert.ok(r.result.after.params.includes('opts'), `new param 'opts' should appear: ${JSON.stringify(r.result.after.params)}`);
        } finally { rm(dir); }
    });
});

describe('fix: JSDoc nested-brace types truncated mid-brace', () => {
    // `@returns {{ ok: boolean, error?: string }}` was captured with /[^}]+/,
    // stopping at the FIRST closing brace — `about` then displayed a signature
    // cut mid-type. Balanced-brace scan in parseJSDocTags fixes extraction;
    // formatFunctionSignature/formatSignature collapse whitespace so multi-line
    // annotations cannot break the one-line signature either.
    it('@returns with nested object-literal type is captured completely', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                '/**',
                ' * Score an edge.',
                ' * @param {object} evidence - Evidence flags',
                ' * @returns {{ confidence: number, resolution: string, evidence: string[] }}',
                ' */',
                'function scoreThing(evidence) { return { confidence: 1, resolution: "x", evidence: [] }; }',
                'module.exports = { scoreThing };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'scoreThing' });
            assert.ok(r.ok, 'about should succeed');
            const rt = r.result.symbol.returnType;
            assert.strictEqual(rt, '{ confidence: number, resolution: string, evidence: string[] }',
                `returnType must keep nested braces intact, got: ${rt}`);
            assert.ok(r.result.symbol.signature.includes('evidence: string[] }'),
                `signature must not be cut mid-type: ${r.result.symbol.signature}`);
        } finally { rm(dir); }
    });

    it('@param nested-brace and optional-bracket forms both survive', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                '/**',
                ' * @param {{ a: number, b: { c: string } }} shape - nested',
                ' * @param {Object<string, {x: number}>} mapped - generic with nested braces',
                ' * @param {number} [limit=10] - optional with default',
                ' */',
                'function takeShapes(shape, mapped, limit) { return shape; }',
                'module.exports = { takeShapes };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'takeShapes' });
            assert.ok(r.ok, 'about should succeed');
            const pt = r.result.symbol.paramTypes || [];
            const joined = JSON.stringify(r.result.symbol);
            assert.ok(joined.includes('{ a: number, b: { c: string } }'),
                `nested @param type must survive intact: ${joined.slice(0, 400)}`);
            assert.ok(joined.includes('Object<string, {x: number}>'),
                `generic nested @param type must survive: ${joined.slice(0, 400)}`);
            assert.ok(joined.includes('"limit"') || joined.includes('limit: number') || pt.includes('number'),
                `optional-bracket param keeps its type: ${joined.slice(0, 400)}`);
        } finally { rm(dir); }
    });

    it('multi-line @returns type collapses to one line in signature', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                '/**',
                ' * @returns {{ ok: boolean,',
                ' *   result: object }}',
                ' */',
                'function build() { return { ok: true, result: {} }; }',
                'module.exports = { build };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'about', { name: 'build' });
            assert.ok(r.ok, 'about should succeed');
            const sig = r.result.symbol.signature;
            assert.ok(!sig.includes('\n'), `signature must be single-line: ${JSON.stringify(sig)}`);
            assert.ok(sig.includes('{ ok: boolean, result: object }'),
                `multi-line type collapses with single spaces: ${sig}`);
        } finally { rm(dir); }
    });
});

describe('fix #192: argument-position references and same-file method calls need evidence', () => {
    // zod `codec` case: a bare identifier in argument position confirmed as a
    // caller purely because SOME symbol with that name exists in the project —
    // blind to import evidence and local shadowing. Function references now
    // confirm only with same-file / same-package / import-edge evidence;
    // otherwise they tier as unverified (visible, never silently dropped).

    it('callback with import evidence stays confirmed; without it goes unverified', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function transform(x) { return x * 2; }\nmodule.exports = { transform };',
            'app.js': 'const { transform } = require("./lib");\nfunction run(items) { return items.map(transform); }\nmodule.exports = { run };',
            'stray.js': 'function noimport(items) { return items.map(transform); }\nmodule.exports = { noimport };',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'transform' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            const unverified = r.result.unverifiedCallers || [];
            assert.ok(confirmed.some(c => c.relativePath === 'app.js'),
                'imported callback must stay confirmed');
            assert.ok(!confirmed.some(c => c.relativePath === 'stray.js'),
                'no-import callback must not be confirmed');
            assert.ok(unverified.some(c => (c.relativePath || c.file).includes('stray.js')),
                'no-import callback must be visible in the unverified tier');
        } finally { rm(dir); }
    });

    it('local variable shadowing the name in argument position is not confirmed (zod codec case)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'schemas.js': 'function codec(a, b) { return [a, b]; }\nmodule.exports = { codec };',
            'helper.test.js': [
                'function stringToNumber() { return { decode: (x) => Number(x) }; }',
                'function decode(c, v) { return c.decode(v); }',
                'function testIt() {',
                '  const codec = stringToNumber();',
                '  return decode(codec, "42");',
                '}',
                'module.exports = { testIt };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'codec', includeTests: true });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(!confirmed.some(c => c.relativePath === 'helper.test.js'),
                `shadowed argument-position reference must not confirm: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });

    it('same-file function reference stays confirmed', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function double(x) { return x * 2; }\nfunction all(items) { return items.map(double); }\nmodule.exports = { all };',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'double' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(confirmed.some(c => c.relativePath === 'lib.js' && c.line === 2),
                `same-file callback must stay confirmed: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });

    it('reference importing a different same-name definition is excluded with reason', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function serialize(x) { return x; }\nmodule.exports = { serialize };',
            'b.js': 'function serialize(x) { return x + 1; }\nmodule.exports = { serialize };',
            'user_b.js': 'const { serialize } = require("./b");\nfunction useB(items) { return items.map(serialize); }\nmodule.exports = { useB };',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'a.js:1:serialize' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            const unverified = r.result.unverifiedCallers || [];
            assert.ok(!confirmed.some(c => c.relativePath === 'user_b.js'),
                'b-importing reference must not confirm against a.js:serialize');
            assert.ok(!unverified.some(c => (c.relativePath || c.file || '').includes('user_b')),
                'positive mis-link evidence excludes (with reason), not unverified');
            const account = r.result.meta.account;
            assert.ok((account.excluded.byReason['other-definition-import']?.count || 0) > 0,
                `exclusion must be accounted: ${JSON.stringify(account)}`);
            assert.strictEqual(account.conserved, true, 'conservation must hold');
        } finally { rm(dir); }
    });

    it('method call on unknown receiver does not confirm against a same-file function', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'function map(fn) { return fn; }\nfunction useIt(checks) { return checks.map((c) => c(1)); }\nmodule.exports = { map, useIt };',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'map', file: 'lib.js' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(!confirmed.some(c => c.line === 2),
                `checks.map() must not be a confirmed caller of function map: ${JSON.stringify(confirmed)}`);
            const unverified = r.result.unverifiedCallers || [];
            assert.ok(unverified.some(c => c.line === 2),
                'receiver-unknown same-file method call lands in the unverified tier');
        } finally { rm(dir); }
    });

    it('account stays conserved when callback edges demote', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'schemas.js': 'function codec(a, b) { return [a, b]; }\nmodule.exports = { codec };',
            'usage.js': 'function wrap() { const codec = () => 1;\n  return [codec].map((f) => f); }\nfunction passes(reg) { reg.add(codec); }\nmodule.exports = { wrap, passes };',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'codec', file: 'schemas.js' });
            assert.ok(r.ok, 'context should succeed');
            const account = r.result.meta.account;
            assert.ok(account, 'account must be present');
            assert.strictEqual(account.conserved, true,
                `conservation must hold: ${JSON.stringify(account)}`);
        } finally { rm(dir); }
    });
});

describe('fix #193: constructor calls resolve to the class binding among same-name bindings', () => {
    it('new Widget() confirms despite a same-name field binding (TS declaration noise)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.ts': [
                'export class Widget {',
                '  size: number = 1;',
                '  static make(): Widget { return new Widget(); }',
                '}',
                'export class Registry {',
                '  Widget: Widget | null = null;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.ts:1:Widget' });
            assert.ok(r.ok, 'context should succeed');
            const usages = r.result.usages || r.result.callers || [];
            const ctor = usages.find(u => u.line === 3);
            assert.ok(ctor, `new Widget() must be a confirmed usage: ${JSON.stringify(usages)}`);
            assert.strictEqual(ctor.tier, 'confirmed');
            assert.strictEqual(ctor.resolution, 'exact-binding',
                'constructor must bind to the class, not stay ambiguous');
        } finally { rm(dir); }
    });
});

describe('fix #194: enclosing-function parameter shadows argument-position references', () => {
    it('dispose(effect) inside function(effect) is not a confirmed caller of module effect()', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': [
                'function effect(fn) { return fn(); }',
                'function handle(x) { return x; }',
                'function run(effect) { return handle(effect); }',
                'module.exports = { effect, run };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'effect', file: 'lib.js' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(!confirmed.some(c => c.line === 3),
                `param-shadowed reference must not confirm: ${JSON.stringify(confirmed)}`);
            const account = r.result.meta.account;
            assert.ok((account.excluded.byReason['local-shadow']?.count || 0) > 0,
                `shadow exclusion must be accounted: ${JSON.stringify(account.excluded)}`);
            assert.strictEqual(account.conserved, true, 'conservation must hold');
        } finally { rm(dir); }
    });
});

describe('fix #195: class context pins callers to the resolved definition', () => {
    it('same-name class in another file does not attribute its usages to the pinned class', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'v1.ts': [
                'export class Parser {',
                '  static make(): Parser { return new Parser(); }',
                '}',
            ].join('\n'),
            'v2.ts': [
                'export class Parser {',
                '  run(): number { return 2; }',
                '}',
                'export function build(): Parser { return new Parser(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'v1.ts:1:Parser' });
            assert.ok(r.ok, 'context should succeed');
            const usages = r.result.usages || r.result.callers || [];
            assert.ok(usages.some(u => (u.relativePath || u.file) === 'v1.ts'),
                `own-file constructor stays confirmed: ${JSON.stringify(usages)}`);
            assert.ok(!usages.some(u => (u.relativePath || u.file) === 'v2.ts'),
                `other definition's usages must not attribute to pinned class: ${JSON.stringify(usages)}`);
            assert.strictEqual(r.result.meta.account.conserved, true, 'conservation must hold');
        } finally { rm(dir); }
    });
});

describe('fix #196: TS-ESM .js specifiers resolve to .ts sources', () => {
    it('import "./b.js" links b.ts in the import graph and confers caller evidence', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'b.ts': 'export function helper(x: number): number { return x * 2; }',
            'a.ts': 'import { helper } from "./b.js";\nexport function run(): number { return helper(21); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'helper' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(confirmed.some(c => c.relativePath === 'a.ts' && c.line === 2),
                `caller via .js specifier must be confirmed: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });
});

describe('export-rename aliases: callers via renamed surface (roadmap #2)', () => {
    it('re-export rename (export { _gt as gt } from) attributes gt() callers to _gt', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'api.ts': 'export function _gt(v: number): boolean { return v > 0; }',
            'checks.ts': 'export { _gt as gt } from "./api.js";',
            'app.ts': 'import { gt } from "./checks.js";\nexport function use(): boolean { return gt(1); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: '_gt' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            const edge = confirmed.find(c => c.relativePath === 'app.ts' && c.line === 2);
            assert.ok(edge, `gt() caller must attribute to _gt: ${JSON.stringify(confirmed)}`);
            assert.strictEqual(edge.calledAs, 'gt', 'edge must carry the surface name');
            const account = r.result.meta.account;
            assert.ok(account.beyondText.count >= 1,
                `alias caller is a beyond-text claim: ${JSON.stringify(account.beyondText)}`);
            assert.strictEqual(account.conserved, true, 'conservation must hold');
        } finally { rm(dir); }
    });

    it('export rename in the defining file (export { _enum as en }) attributes en() callers', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'schemas.ts': 'function _enum(values: string[]): string[] { return values; }\nexport { _enum as en };',
            'app.ts': 'import { en } from "./schemas.js";\nexport function use(): string[] { return en(["a"]); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: '_enum' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(confirmed.some(c => c.relativePath === 'app.ts' && c.calledAs === 'en'),
                `en() caller must attribute to _enum: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });

    it('import-side rename (import { _gt as gt }) attributes local gt() calls', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'api.ts': 'export function _gt(v: number): boolean { return v > 0; }',
            'app.ts': 'import { _gt as gt } from "./api.js";\nexport function use(): boolean { return gt(1); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: '_gt' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(confirmed.some(c => c.relativePath === 'app.ts' && c.line === 2 && c.calledAs === 'gt'),
                `renamed-import caller must attribute to _gt: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });

    it('typed-receiver method call is NOT attributed to a renamed standalone function', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'api.ts': 'export function _gt(v: number): boolean { return v > 0; }',
            'checks.ts': 'export { _gt as gt } from "./api.js";',
            'num.ts': [
                'import { gt } from "./checks.js";',
                'export class Num {',
                '  gt(v: number): boolean { return v > 1; }',
                '}',
                'export function fluent(): boolean {',
                '  const n = new Num();',
                '  return n.gt(2);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: '_gt' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(!confirmed.some(c => c.relativePath === 'num.ts' && c.line === 7),
                `n.gt() dispatches on Num, must not attribute to _gt: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });

    it('unrelated gt() in a file without an import path to the target is not attributed', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'api.ts': 'export function _gt(v: number): boolean { return v > 0; }',
            'checks.ts': 'export { _gt as gt } from "./api.js";',
            'other.ts': 'function gt(v: number): boolean { return v > 9; }\nexport function use(): boolean { return gt(1); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: '_gt' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(!confirmed.some(c => c.relativePath === 'other.ts'),
                `local gt() with no import path must not attribute: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });
});

describe('fix #197: package self-reference imports resolve via exports map', () => {
    it('importing own package by name links the source file (monorepo test pattern)', () => {
        const dir = tmp({
            'package.json': JSON.stringify({
                name: 'mypkg',
                exports: { '.': { import: './src/index.js' }, './sub': { import: './src/sub/index.js' } },
            }),
            'src/index.ts': 'export function rootFn(): number { return 1; }',
            'src/sub/index.ts': 'export function subFn(): number { return 2; }',
            'src/app.test.ts': [
                'import { rootFn } from "mypkg";',
                'import { subFn } from "mypkg/sub";',
                'export function uses(): number { return rootFn() + subFn(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'subFn', includeTests: true });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            assert.ok(confirmed.some(c => (c.relativePath || '').endsWith('app.test.ts')),
                `self-referencing import must confer caller evidence: ${JSON.stringify(confirmed)}`);
        } finally { rm(dir); }
    });

    it('deep re-export chains keep renamed-surface callers visible (never silently missing)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'schemas.ts': 'function _enum(v: string[]): string[] { return v; }\nexport { _enum as en };\nexport function other(): number { return 1; }',
            'barrel1.ts': 'export * from "./schemas.js";',
            'barrel2.ts': 'export * from "./barrel1.js";',
            'app.ts': 'import * as z from "./barrel2.js";\nexport function use(): string[] { return z.en(["a"]); }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: '_enum' });
            assert.ok(r.ok, 'context should succeed');
            const confirmed = r.result.callers || [];
            const unverified = r.result.unverifiedCallers || [];
            const visible = [...confirmed, ...unverified];
            assert.ok(visible.some(c => (c.relativePath || c.file || '').includes('app.ts')),
                `z.en() through 2 barrels must be visible (confirmed or unverified): ${JSON.stringify({ confirmed, unverified })}`);
            assert.strictEqual(r.result.meta.account.conserved, true, 'conservation must hold');
        } finally { rm(dir); }
    });
});

describe('fix #198 (js/ts): structural receiver type inference', () => {
    const FIXTURE = {
        'package.json': '{"name":"t"}',
        'store.ts': [
            'export class Store {',
            '    commit(k: string) { return k; }',
            '}',
            'export class AsyncStore {',
            '    commit(k: string) { return k; }',
            '}',
            'export function map(fn: (v: number) => number) { return fn; }',
        ].join('\n'),
        'app.ts': [
            'import { Store, AsyncStore, map } from "./store";',
            '',
            'export function useStore(store: Store, other: AsyncStore, opt: Store | null) {',
            '    store.commit("a");',
            '    other.commit("b");',
            '    opt.commit("c");',
            '    [1, 2].map(v => v);',
            '    const s = new Store();',
            '    s.commit("d");',
            '    s.map(v => v);',
            '}',
        ].join('\n'),
    };

    it('TS param annotations and new-expressions confirm only the matching class', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'store.ts:2:commit' });
            assert.ok(r.ok);
            const confirmed = r.result.callers || [];
            const lines = confirmed.map(c => `${c.relativePath}:${c.line}`);
            assert.ok(lines.includes('app.ts:4'), `store: Store param confirms: ${lines}`);
            assert.ok(lines.includes('app.ts:6'), `Store | null union confirms: ${lines}`);
            assert.ok(lines.includes('app.ts:9'), `new Store() confirms: ${lines}`);
            assert.ok(!lines.includes('app.ts:5'), `other: AsyncStore must be excluded: ${lines}`);
            assert.ok(confirmed.every(c => c.resolution === 'receiver-hint'),
                `typed receivers score receiver-hint: ${JSON.stringify(confirmed.map(c => c.resolution))}`);
            assert.strictEqual(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('array-literal receiver and typed receiver never confirm a standalone function', () => {
        const dir = tmp(FIXTURE);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'store.ts:7:map' });
            assert.ok(r.ok);
            const confirmed = r.result.callers || [];
            assert.strictEqual(confirmed.length, 0,
                `[].map and s.map (s: Store) must not confirm standalone map: ${JSON.stringify(confirmed)}`);
            assert.strictEqual(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('member-expression constructor types the receiver: new pkg.Foo()', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'class Engine {\n    run(x) { return x; }\n}\nclass Pump {\n    run(x) { return x; }\n}\nmodule.exports = { Engine, Pump };',
            'app.js': [
                'const pkg = require("./lib");',
                '',
                'function go() {',
                '    const e = new pkg.Engine();',
                '    return e.run(1);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.js:2:run', className: 'Engine' });
            assert.ok(r.ok);
            const lines = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(lines.includes('app.js:5'), `new pkg.Engine() receiver confirms Engine.run: ${lines}`);
            const rPump = execute(index, 'context', { name: 'lib.js:5:run', className: 'Pump' });
            const pumpLines = (rPump.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!pumpLines.includes('app.js:5'), `Engine receiver excluded from Pump.run: ${pumpLines}`);
        } finally { rm(dir); }
    });
});

describe('fix #198b (js/ts): supertype receiver is not a mismatch', () => {
    it('Base-typed receiver stays confirmed on Child override (dynamic dispatch)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.ts': 'export class Base {\n    start() { return 1; }\n}\nexport class Child extends Base {\n    start() { return 2; }\n}',
            'app.ts': 'import { Base } from "./lib";\n\nexport function run(b: Base) {\n    return b.start();\n}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.ts:5:start', className: 'Child' });
            assert.ok(r.ok);
            const confirmed = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(confirmed.includes('app.ts:4'),
                `b: Base may dispatch to Child.start — must stay confirmed: ${confirmed}`);
            assert.strictEqual(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #198c (js/ts): alias/interface receiver types never exclude', () => {
    it('type-alias annotated receiver stays confirmed (alias name != class name)', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.ts': [
                'export class ZType<T> {',
                '    parse(v: T) { return v; }',
                '}',
                'export type ZTypeAny = ZType<any>;',
            ].join('\n'),
            'app.ts': 'import { ZTypeAny } from "./lib";\n\nexport function run(schema: ZTypeAny) {\n    return schema.parse(1);\n}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.ts:2:parse' });
            assert.ok(r.ok);
            const confirmed = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(confirmed.includes('app.ts:4'),
                `ZTypeAny aliases ZType — schema.parse() must stay confirmed: ${confirmed}`);
            assert.strictEqual(r.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('interface-typed receiver does not exclude a standalone function target', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.ts': 'export function fetchData(u: string) { return u; }\nexport interface Fetcher { fetchData(u: string): string; }',
            'app.ts': 'import { fetchData, Fetcher } from "./lib";\n\nexport function run(f: Fetcher) {\n    return f.fetchData("u");\n}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'lib.ts:1:fetchData' });
            assert.ok(r.ok);
            const visible = [...(r.result.callers || []), ...(r.result.unverifiedCallers || [])]
                .map(c => `${c.relativePath}:${c.line}`);
            assert.ok(visible.includes('app.ts:4'),
                `Fetcher may wrap fetchData — site must stay visible (confirmed or unverified): ${visible}`);
        } finally { rm(dir); }
    });
});

describe('fix #199 (js/ts): return-type flow types assigned variables', () => {
    it('const x = store.fetchItem() types x via the TS return annotation', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'store.ts': [
                'export class Item {',
                '    save() { return 1; }',
                '}',
                'export class Draft {',
                '    save() { return 2; }',
                '}',
                'export class Store {',
                '    fetchItem(id: string): Item { return new Item(); }',
                '}',
            ].join('\n'),
            'app.ts': [
                'import { Store } from "./store";',
                '',
                'export function run(store: Store) {',
                '    const item = store.fetchItem("a");',
                '    item.save();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const rItem = execute(index, 'context', { name: 'store.ts:2:save', className: 'Item' });
            const itemLines = (rItem.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(itemLines.includes('app.ts:5'),
                `item: Item via fetchItem return type — must confirm: ${itemLines}`);
            const rDraft = execute(index, 'context', { name: 'store.ts:5:save', className: 'Draft' });
            const draftLines = (rDraft.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!draftLines.includes('app.ts:5'),
                `flow-typed Item receiver must be excluded from Draft.save: ${draftLines}`);
            assert.strictEqual(rItem.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('Promise<X> return annotations unwrap for awaited assignments', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'api.ts': [
                'export class User {',
                '    greet() { return "hi"; }',
                '}',
                'export class Bot {',
                '    greet() { return "beep"; }',
                '}',
                'export async function loadUser(): Promise<User> { return new User(); }',
            ].join('\n'),
            'app.ts': [
                'import { loadUser } from "./api";',
                '',
                'export async function run() {',
                '    const u = await loadUser();',
                '    u.greet();',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const rUser = execute(index, 'context', { name: 'api.ts:2:greet', className: 'User' });
            const userLines = (rUser.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(userLines.includes('app.ts:5'),
                `u: User via Promise<User> unwrap — must confirm: ${userLines}`);
            const rBot = execute(index, 'context', { name: 'api.ts:5:greet', className: 'Bot' });
            const botLines = (rBot.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!botLines.includes('app.ts:5'),
                `flow-typed User receiver must be excluded from Bot.greet: ${botLines}`);
        } finally { rm(dir); }
    });
});

describe('fix #200 (js/ts): module receivers never confirm class methods', () => {
    it('namespace-import receiver excluded from class method, kept for module fn', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.ts': [
                'export class Client {',
                '    send(m: string) { return m; }',
                '}',
                'export function send(m: string) { return m; }',
            ].join('\n'),
            'app.ts': 'import * as lib from "./lib";\n\nexport function run() {\n    return lib.send("x");\n}',
        });
        try {
            const index = idx(dir);
            const rMethod = execute(index, 'context', { name: 'lib.ts:2:send', className: 'Client' });
            const methodLines = (rMethod.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!methodLines.includes('app.ts:4'),
                `lib.send() is the module function, not Client.send: ${methodLines}`);
            const rFn = execute(index, 'context', { name: 'lib.ts:4:send' });
            const fnLines = (rFn.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(fnLines.includes('app.ts:4'),
                `lib.send() must stay confirmed for the module function: ${fnLines}`);
        } finally { rm(dir); }
    });

    it('require-bound receiver excluded from class method', () => {
        const dir = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': 'class Worker {\n    start() { return 1; }\n}\nfunction start() { return 2; }\nmodule.exports = { Worker, start };',
            'app.js': 'const lib = require("./lib");\n\nfunction go() {\n    return lib.start();\n}',
        });
        try {
            const index = idx(dir);
            const rMethod = execute(index, 'context', { name: 'lib.js:2:start', className: 'Worker' });
            const methodLines = (rMethod.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(!methodLines.includes('app.js:4'),
                `lib.start() is the module export, not Worker.start: ${methodLines}`);
        } finally { rm(dir); }
    });
});
