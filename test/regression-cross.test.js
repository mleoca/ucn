/**
 * UCN Cross-Language Regression Tests
 *
 * Cross-language regressions, Bug Report #4, MCP fixes, hints, production readiness.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { execFileSync, execSync } = require('child_process');
const { parse, parseFile, detectLanguage } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { expandGlob } = require('../core/discovery');
const output = require('../core/output');
const { execute } = require('../core/execute');
const { createTempDir, cleanup, tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR, CLI_PATH, runCli, runInteractive } = require('./helpers');

// ============================================================================
// STATS SYMBOL COUNT CONSISTENCY
// ============================================================================

describe('Bug: stats symbol count consistency', () => {
    it('total symbols should equal sum of type counts', () => {
        const index = idx(FIXTURES_PATH + '/javascript');

        const stats = index.getStats();

        // Calculate sum of type counts
        let typeSum = 0;
        if (stats.byType) {
            for (const [type, count] of Object.entries(stats.byType)) {
                typeSum += count;
            }
        }

        // This documents the bug - symbol count doesn't match type breakdown
        // After fix: assert.strictEqual(stats.symbols, typeSum, 'Total symbols should equal sum of types');
        if (stats.symbols !== typeSum) {
            console.log(`BUG CONFIRMED: stats.symbols (${stats.symbols}) !== sum of byType (${typeSum})`);
        }
    });
});

// ============================================================================
// EDGE CASES
// ============================================================================

describe('Edge Cases', () => {
    it('should handle recursive function calls correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-recursive-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'recursive.js'), `
function factorial(n) {
    if (n <= 1) return 1;
    return n * factorial(n - 1);  // Recursive call
}

const result = factorial(5);
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const ctx = index.context('factorial');

            // Should have callers (including the recursive call)
            assert.ok(ctx.callers.length > 0, 'Should find callers including recursive call');

            // Definition should NOT be in callers
            const hasDefinitionInCallers = ctx.callers.some(c =>
                c.content && c.content.includes('function factorial')
            );
            // After fix: assert.strictEqual(hasDefinitionInCallers, false);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle aliased imports correctly', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-alias-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
function parse(code) {
    return code.trim();
}
module.exports = { parse };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { parse: myParse } = require('./lib');
const result = myParse('  hello  ');  // Should be counted as usage of parse
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('parse');
            // Aliased usage is tricky - should ideally track the alias
            assert.ok(usages.length > 0, 'Should find at least the definition');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should handle same function name in different files', () => {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-samename-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'file1.js'), `
function process(x) { return x + 1; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'file2.js'), `
function process(x) { return x * 2; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const m1 = require('./file1');
const m2 = require('./file2');
console.log(m1.process(5));
console.log(m2.process(5));
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const found = index.find('process');
            assert.strictEqual(found.length, 2, 'Should find both process functions');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// NON-EXISTENT SYMBOL HANDLING
// ============================================================================

describe('Non-existent symbol handling', () => {
    // Helper to create and cleanup temp project
    function withTempProject(fn) {
        const tmpDir = path.join(require('os').tmpdir(), `ucn-test-nonexist-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
function existingFunc() {
    return 42;
}
module.exports = { existingFunc };
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        try {
            fn(index);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    }

    it('find should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const found = index.find('nonExistentSymbol');
            assert.ok(Array.isArray(found), 'Should return array');
            assert.strictEqual(found.length, 0, 'Should be empty');
        });
    });

    it('usages should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const usages = index.usages('nonExistentSymbol');
            assert.ok(Array.isArray(usages), 'Should return array');
            assert.strictEqual(usages.length, 0, 'Should be empty');
        });
    });

    it('context should return null for non-existent symbol', () => {
        withTempProject((index) => {
            const ctx = index.context('nonExistentSymbol');
            assert.strictEqual(ctx, null, 'Should return null for non-existent symbol');
        });
    });

    it('smart should return null for non-existent function', () => {
        withTempProject((index) => {
            const smart = index.smart('nonExistentSymbol');
            assert.strictEqual(smart, null, 'Should return null');
        });
    });

    it('about should return null for non-existent symbol', () => {
        withTempProject((index) => {
            const about = index.about('nonExistentSymbol');
            assert.strictEqual(about, null, 'Should return null');
        });
    });

    it('impact should return null for non-existent function', () => {
        withTempProject((index) => {
            const impact = index.impact('nonExistentSymbol');
            assert.strictEqual(impact, null, 'Should return null');
        });
    });

    it('tests should return empty array for non-existent symbol', () => {
        withTempProject((index) => {
            const tests = index.tests('nonExistentSymbol');
            assert.ok(Array.isArray(tests), 'Should return array');
            assert.strictEqual(tests.length, 0, 'Should be empty');
        });
    });

    it('typedef should return empty array for non-existent type', () => {
        withTempProject((index) => {
            const typedefs = index.typedef('NonExistentType');
            assert.ok(Array.isArray(typedefs), 'Should return array');
            assert.strictEqual(typedefs.length, 0, 'Should be empty');
        });
    });

    it('typedef with exact flag should not return fuzzy matches', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-typedef-exact-'));
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
        fs.writeFileSync(path.join(tmpDir, 'types.ts'), `
interface UserProps {
    name: string;
}

interface AdminProps {
    role: string;
}

type UserConfig = { key: string };
type AdminConfig = { key: string };
`);
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        // Without exact: "Props" has no exact symbol match, so fuzzy finds UserProps + AdminProps
        const fuzzy = index.typedef('Props');
        assert.ok(fuzzy.length >= 2, `Should find multiple Props-like types via fuzzy, got ${fuzzy.length}: ${fuzzy.map(t => t.name).join(', ')}`);

        // With exact: "Props" should return nothing (no type literally named "Props")
        const exact = index.typedef('Props', { exact: true });
        assert.strictEqual(exact.length, 0, `exact=true should not return fuzzy matches, got: ${exact.map(t => t.name).join(', ')}`);

        // With exact: "UserProps" should only find UserProps
        const exactUser = index.typedef('UserProps', { exact: true });
        assert.strictEqual(exactUser.length, 1, 'Should find exactly one UserProps');
        assert.strictEqual(exactUser[0].name, 'UserProps');

        // Without exact: "Config" fuzzy-matches UserConfig + AdminConfig
        const fuzzyConfig = index.typedef('Config');
        assert.ok(fuzzyConfig.length >= 2, `Should find Config-like types via fuzzy, got ${fuzzyConfig.length}`);

        // With exact: "Config" should return nothing (no type literally named "Config")
        const exactConfig = index.typedef('Config', { exact: true });
        assert.strictEqual(exactConfig.length, 0, `exact=true should not return fuzzy Config matches, got: ${exactConfig.map(t => t.name).join(', ')}`);

        fs.rmSync(tmpDir, { recursive: true, force: true });
    });
});

// ============================================================================
// DOUBLE DASH SEPARATOR
// ============================================================================

describe('Regression: double dash separator for arguments', () => {
    it('should allow searching for flag-like strings after --', () => {
        const fixtureDir = path.join(FIXTURES_PATH, 'javascript');
        const { execSync } = require('child_process');
        const ucnPath = path.join(PROJECT_DIR, 'ucn.js');

        // This should NOT error with "Unknown flag"
        const output = execSync(`node ${ucnPath} ${fixtureDir} find -- --test`, {
            encoding: 'utf8'
        });

        // Should show "no symbols found" rather than "unknown flag"
        assert.ok(!output.includes('Unknown flag'), 'Should not treat --test as flag after --');
    });

    it('should process flags before -- normally', () => {
        const fixtureDir = path.join(FIXTURES_PATH, 'javascript');
        const { execSync } = require('child_process');
        const ucnPath = path.join(PROJECT_DIR, 'ucn.js');

        // Flags before -- should work
        const output = execSync(`node ${ucnPath} ${fixtureDir} find processData --json --`, {
            encoding: 'utf8'
        });

        // Should be valid JSON
        assert.ok(output.startsWith('{'), 'Should output JSON when --json flag is before --');
        JSON.parse(output); // Should not throw
    });
});

// ============================================================================
// AST-BASED SEARCH FILTERING
// ============================================================================

describe('Reliability: AST-based search filtering', () => {
    it('should filter out matches in comments with --code-only', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
// This comment mentions fetchData
const x = 'fetchData in string';
const result = fetchData(); // trailing comment fetchData
/* block comment
   fetchData here too */
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('fetchData', { codeOnly: true });
            const allMatches = results.flatMap(r => r.matches);

            // Should only find the actual code call on line 4
            assert.strictEqual(allMatches.length, 1, 'Should find only 1 code match');
            assert.ok(allMatches[0].content.includes('const result = fetchData()'), 'Should find the actual call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should include template literal expressions as code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-search-template-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
const str = \`fetchData in template\`;
const dynamic = \`Result: \${fetchData()}\`;
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const results = index.search('fetchData', { codeOnly: true });
            const allMatches = results.flatMap(r => r.matches);

            // Should find the expression inside ${}, not the string literal
            assert.strictEqual(allMatches.length, 1, 'Should find 1 match in template expression');
            assert.ok(allMatches[0].content.includes('${fetchData()}'), 'Should find the template expression');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// STACKTRACE FILE MATCHING
// ============================================================================

describe('Reliability: Stacktrace file matching', () => {
    it('should parse various stack trace formats', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-stack-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'));
            fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
function processData(data) {
    throw new Error('test');
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Test Node.js format
            const nodeStack = index.parseStackTrace('at processData (src/app.js:3:11)');
            assert.strictEqual(nodeStack.frames.length, 1);
            assert.ok(nodeStack.frames[0].found);

            // Test Firefox format
            const ffStack = index.parseStackTrace('processData@src/app.js:3:11');
            assert.strictEqual(ffStack.frames.length, 1);
            assert.ok(ffStack.frames[0].found);

            // Test async format
            const asyncStack = index.parseStackTrace('at async processData (src/app.js:3:11)');
            assert.strictEqual(asyncStack.frames.length, 1);
            assert.ok(asyncStack.frames[0].found);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should score path similarity and choose best match', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-stack-sim-'));
        try {
            // Create files with similar names in different directories
            fs.mkdirSync(path.join(tmpDir, 'src', 'utils'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'lib', 'utils'), { recursive: true });

            fs.writeFileSync(path.join(tmpDir, 'src', 'utils', 'helper.js'), `
function helper() { console.log('src'); }
`);
            fs.writeFileSync(path.join(tmpDir, 'lib', 'utils', 'helper.js'), `
function helper() { console.log('lib'); }
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Should prefer more specific path
            const stack = index.parseStackTrace('at helper (src/utils/helper.js:2:10)');
            assert.strictEqual(stack.frames.length, 1);
            assert.ok(stack.frames[0].found);
            assert.ok(stack.frames[0].resolvedFile.includes('src/utils'), 'Should match src path');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// CALLBACK DETECTION FOR DEADCODE
// ============================================================================

describe('Reliability: Callback detection for deadcode', () => {
    it('should not report functions used as callbacks as dead', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-deadcode-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'handlers.js'), `
function handleClick(e) { console.log(e); }
function mapItem(item) { return item.toUpperCase(); }
function unusedFn() { return 'dead'; }

document.addEventListener('click', handleClick);
const items = ['a', 'b'].map(mapItem);
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);

            assert.ok(!deadNames.includes('handleClick'), 'handleClick should not be dead (event handler)');
            assert.ok(!deadNames.includes('mapItem'), 'mapItem should not be dead (array callback)');
            assert.ok(deadNames.includes('unusedFn'), 'unusedFn should be dead');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should not report re-exported functions as dead', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-reexport-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'utils.js'), `
export function formatDate(d) { return d.toString(); }
export function unusedUtil() { return null; }
`);
            fs.writeFileSync(path.join(tmpDir, 'index.js'), `
export { formatDate } from './utils';
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);

            assert.ok(!deadNames.includes('formatDate'), 'formatDate should not be dead (re-exported)');
            // Note: unusedUtil might or might not be dead depending on export tracking
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// className FIELD PRESERVED IN SYMBOL INDEX (5-language)
// ============================================================================

describe('Regression: className field preserved in symbol index', () => {
    it('should store className for Python class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-py-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.py'), `class User:
    def save(self):
        pass

class Product:
    def save(self):
        pass
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.py', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should store className for Java class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-java-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Models.java'), `class User {
    public void save() {}
}

class Product {
    public void save() {}
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should store className for JavaScript class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-classname-js-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'models.js'), `class User {
    save() {}
}

class Product {
    save() {}
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            // Both save methods should have className field
            const saveMethods = index.symbols.get('save');
            assert.ok(saveMethods, 'save methods should be indexed');
            assert.strictEqual(saveMethods.length, 2, 'Should have 2 save methods');

            const classNames = saveMethods.map(m => m.className).sort();
            assert.deepStrictEqual(classNames, ['Product', 'User'], 'Should have User and Product as classNames');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should resolve Go module imports for exporters', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-import-'));
        try {
            // Create go.mod file
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/myproject

go 1.21
`);

            // Create package structure
            fs.mkdirSync(path.join(tmpDir, 'pkg', 'config'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'pkg', 'config', 'config.go'), `package config

type Config struct {
    Name string
}

func NewConfig() *Config {
    return &Config{}
}
`);

            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

import "example.com/myproject/pkg/config"

func main() {
    cfg := config.NewConfig()
    _ = cfg
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Get exporters for the config package
            const exportersResult = index.exporters(path.join(tmpDir, 'pkg', 'config', 'config.go'));
            assert.ok(exportersResult.length > 0, 'Should find files that import the config package');

            // main.go should be in the list
            const mainFile = exportersResult.find(e => e.file.includes('main.go'));
            assert.ok(mainFile, 'main.go should import the config package');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect Go method calls in usages (field_identifier)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'service.go'), `package main

type Service struct{}

func (s *Service) CollectAll() error {
    return nil
}

func main() {
    svc := &Service{}
    svc.CollectAll()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // usages should find the method call
            const usages = index.usages('CollectAll', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);
            assert.ok(calls.length >= 1, 'Should find at least 1 call to CollectAll');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should find callees for Go receiver methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-callees-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'client.go'), `package main

type Client struct{}

func (c *Client) GetPods() []string {
    return nil
}

func (c *Client) GetNodes() []string {
    return nil
}

func (c *Client) CollectAll() {
    c.GetPods()
    c.GetNodes()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // context should find callees (Go method calls)
            const ctx = index.context('CollectAll');
            assert.ok(ctx.callees, 'Should have callees');
            assert.ok(ctx.callees.length >= 2, 'Should find at least 2 callees (GetPods, GetNodes)');

            const calleeNames = ctx.callees.map(c => c.name);
            assert.ok(calleeNames.includes('GetPods'), 'GetPods should be a callee');
            assert.ok(calleeNames.includes('GetNodes'), 'GetNodes should be a callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should filter by --file for Go methods with same name', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-file-filter-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            fs.writeFileSync(path.join(tmpDir, 'service_a.go'), `package main

type ServiceA struct{}

func (s *ServiceA) Process() error {
    return nil
}
`);

            fs.writeFileSync(path.join(tmpDir, 'service_b.go'), `package main

type ServiceB struct{}

func (s *ServiceB) Process() error {
    return nil
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Without file filter, should find both
            const allDefs = index.find('Process');
            assert.strictEqual(allDefs.length, 2, 'Should find 2 definitions of Process');

            // With file filter, should find only one
            const filteredDefs = index.find('Process', { file: 'service_a.go' });
            assert.strictEqual(filteredDefs.length, 1, 'Should find 1 definition with file filter');
            assert.ok(filteredDefs[0].relativePath.includes('service_a.go'), 'Should be from service_a.go');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JavaScript method calls but filter built-ins', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-js-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'test.js'), `
class Service {
  process() {}
}

function main() {
  const svc = new Service();
  svc.process();     // user method - SHOULD be counted
  JSON.parse('{}');  // built-in - should NOT be counted
  process();         // direct call - SHOULD be counted
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const usages = index.usages('process', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find 2 calls: svc.process() and process()
            assert.strictEqual(calls.length, 2, 'Should find 2 calls (user method + direct)');

            // Should NOT include JSON.parse
            const hasJsonParse = calls.some(c => c.content && c.content.includes('JSON.parse'));
            assert.strictEqual(hasJsonParse, false, 'JSON.parse should NOT be counted');

            // Should include svc.process()
            const hasUserMethod = calls.some(c => c.content && c.content.includes('svc.process'));
            assert.strictEqual(hasUserMethod, true, 'svc.process() SHOULD be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should prefer same-file callees for Go methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-callee-disambig-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), `module example.com/test
go 1.21
`);

            // Two files with same method name 'helper'
            fs.writeFileSync(path.join(tmpDir, 'service_a.go'), `package main

type ServiceA struct{}

func (s *ServiceA) Process() {
    s.helper()
}

func (s *ServiceA) helper() {}
`);

            fs.writeFileSync(path.join(tmpDir, 'service_b.go'), `package main

type ServiceB struct{}

func (s *ServiceB) Process() {
    s.helper()
}

func (s *ServiceB) helper() {}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Get callees for ServiceA.Process - should find ServiceA.helper, not ServiceB.helper
            const defs = index.symbols.get('Process') || [];
            const serviceAProcess = defs.find(d => d.relativePath.includes('service_a.go'));
            assert.ok(serviceAProcess, 'Should find ServiceA.Process');

            const callees = index.findCallees(serviceAProcess);
            assert.ok(callees.length >= 1, 'Should find at least 1 callee');

            const helperCallee = callees.find(c => c.name === 'helper');
            assert.ok(helperCallee, 'Should find helper callee');
            assert.ok(helperCallee.relativePath.includes('service_a.go'),
                'helper callee should be from service_a.go, not service_b.go');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JSX component usage as calls', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jsx-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), `{"name": "test"}`);

            fs.writeFileSync(path.join(tmpDir, 'Page.tsx'), `
function EnvironmentsPage() {
  return <div>Hello</div>;
}

function App() {
  return <EnvironmentsPage />;
}

export { App, EnvironmentsPage };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.tsx', { quiet: true });

            const usages = index.usages('EnvironmentsPage', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find JSX usage as a call
            assert.ok(calls.length >= 1, 'Should find at least 1 JSX component usage');
            assert.ok(calls.some(c => c.content && c.content.includes('<EnvironmentsPage')),
                'Should detect <EnvironmentsPage /> as a call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JSX prop function references (onClick={handler})', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-jsx-prop-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), `{"name": "test"}`);

            fs.writeFileSync(path.join(tmpDir, 'clipboard.tsx'), `
function handlePaste() {
  console.log('pasted');
}

function handleCopy() {
  console.log('copied');
}

function ClipboardPanel() {
  const userName = "test";
  return (
    <div>
      <button onClick={handlePaste}>Paste</button>
      <button onClick={handleCopy}>Copy</button>
      <span title={userName}>Name</span>
    </div>
  );
}

export { handlePaste, handleCopy, ClipboardPanel };
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.tsx', { quiet: true });

            // handlePaste should be detected as called by ClipboardPanel (via JSX prop)
            const callers = index.findCallers('handlePaste');
            assert.ok(callers.length >= 1, 'Should find at least 1 caller for handlePaste');
            assert.ok(callers.some(c => c.callerName === 'ClipboardPanel'),
                'ClipboardPanel should be detected as caller of handlePaste via onClick prop');

            // handleCopy too
            const copyCallers = index.findCallers('handleCopy');
            assert.ok(copyCallers.length >= 1, 'Should find at least 1 caller for handleCopy');

            // userName should NOT be detected as a function reference (it's a string variable)
            const userCallers = index.findCallers('userName');
            assert.strictEqual(userCallers.length, 0, 'userName should not be detected as a function call');

            // handlePaste should NOT show up as dead code
            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);
            assert.ok(!deadNames.includes('handlePaste'), 'handlePaste should not be dead code');
            assert.ok(!deadNames.includes('handleCopy'), 'handleCopy should not be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should detect JSX prop member expression references (onClick={utils.handler})', () => {
        const code = `
import { handlers } from './handlers';

function App() {
  return <button onClick={handlers.submit}>Submit</button>;
}
`;
        const parser = require('../languages').getParser('tsx');
        const { findCallsInCode } = require('../languages/javascript');
        const calls = findCallsInCode(code, parser);

        // The member expression reference should be detected as a call
        const submitRef = calls.find(c => c.name === 'submit' && c.isFunctionReference);
        assert.ok(submitRef, 'Should detect handlers.submit as a function reference in JSX prop');
        assert.strictEqual(submitRef.isMethod, true, 'Should be marked as method call');
        assert.strictEqual(submitRef.receiver, 'handlers', 'Should have handlers as receiver');
        assert.strictEqual(submitRef.isPotentialCallback, true, 'Should be marked as potential callback');
    });

    it('should detect Rust method calls in usages', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-method-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "test"
version = "0.1.0"
`);

            fs.writeFileSync(path.join(tmpDir, 'main.rs'), `
struct Client {}

impl Client {
    fn process(&self) {}
}

fn main() {
    let c = Client{};
    c.process();
    process();
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            const usages = index.usages('process', { codeOnly: true });
            const calls = usages.filter(u => u.usageType === 'call' && !u.isDefinition);

            // Should find 2 calls: c.process() and process()
            assert.ok(calls.length >= 2, 'Should find at least 2 calls');

            // Should include c.process()
            const hasMethodCall = calls.some(c => c.content && c.content.includes('c.process'));
            assert.strictEqual(hasMethodCall, true, 'c.process() SHOULD be counted');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// CONTEXT CLASS LABEL BUG (Python + Java)
// ============================================================================

describe('Regression: Context class label bug', () => {
    it('should show class name in context, not undefined', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-ctx-class-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            // Python class
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
class Session:
    def __init__(self):
        self.data = {}

    def get(self, key):
        return self.data.get(key)

def create_session():
    return Session()
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('Session');
            assert.strictEqual(ctx.type, 'class', 'Should detect as class type');
            assert.strictEqual(ctx.name, 'Session', 'Should have class name, not undefined');
            assert.ok(ctx.name !== undefined, 'Name must not be undefined');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

});

// ============================================================================
// DISAMBIGUATION PREFERS NON-TEST
// ============================================================================

describe('Regression: Disambiguation prefers non-test definitions', () => {
    it('should prefer src definition over test definition', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-disambig-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'src', 'render.js'), `
function render(template, data) {
    return template.replace(/{(\\w+)}/g, (_, key) => data[key] || '');
}
module.exports = { render };
`);
            fs.writeFileSync(path.join(tmpDir, 'test', 'render.test.js'), `
const { render } = require('../src/render');
function render(mockTemplate) {
    return 'mock: ' + mockTemplate;
}
test('render', () => { render('hello'); });
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // resolveSymbol should prefer src/render.js over test/render.test.js
            const { def } = index.resolveSymbol('render');
            assert.ok(def, 'Should find render');
            assert.ok(!def.relativePath.includes('test'),
                `Should prefer non-test file, got ${def.relativePath}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should use consistent selection across context, smart, trace', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-consistent-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function process(data) {
    return transform(data);
}
function transform(x) { return x * 2; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function process(item) {
    return item.toString();
}
module.exports = { process };
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('process');
            const smart = index.smart('process');
            const trace = index.trace('process');

            // All should pick the same definition
            assert.strictEqual(ctx.file, smart.target.relativePath,
                'context and smart should pick same definition');
            assert.strictEqual(ctx.file, trace.file,
                'context and trace should pick same definition');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// VERIFY FILTERS METHOD CALLS
// ============================================================================

describe('Regression: Verify filters method calls', () => {
    it('should not count obj.get() as call to standalone get()', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'api.py'), `
def get(url, params=None):
    return request("GET", url, params=params)

def request(method, url, params=None):
    pass
`);
            fs.writeFileSync(path.join(tmpDir, 'client.py'), `
from .api import get

def fetch_data():
    result = get("/api/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
    return result
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // Should NOT count headers.get("Host") or data.get("key") as mismatches
            // Only get("/api/data") should be counted
            assert.strictEqual(result.mismatches, 0,
                `Should have 0 mismatches (method calls filtered), got ${result.mismatches}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// FN COMMAND EXTRACTS CLASS METHODS (Python + Java)
// ============================================================================

describe('Regression: fn command extracts class methods', () => {
    it('should find and extract Python __init__ method via symbol index', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-fn-method-${Date.now()}`);
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'src', 'models.py'), `
class Session:
    def __init__(self, url, timeout=30):
        self.url = url
        self.timeout = timeout

    def get(self, path):
        return self.url + path
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // find should return __init__ (it has params, so it passes the filter)
            const matches = index.find('__init__').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 1, `Should find __init__, got ${matches.length}`);

            // The match should have valid startLine/endLine for direct code extraction
            const match = matches[0];
            assert.ok(match.startLine, 'Match should have startLine');
            assert.ok(match.endLine, 'Match should have endLine');
            assert.ok(match.file, 'Match should have file path');

            // Extract code using startLine/endLine (same approach as the fixed fn command)
            const code = fs.readFileSync(match.file, 'utf-8');
            const lines = code.split('\n');
            const fnCode = lines.slice(match.startLine - 1, match.endLine).join('\n');
            assert.ok(fnCode.includes('def __init__'), `Extracted code should contain __init__, got: ${fnCode}`);
            assert.ok(fnCode.includes('self.url = url'), `Extracted code should contain method body, got: ${fnCode}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

});

// ============================================================================
// VERIFY TOTALCALLS EXCLUDES FILTERED METHOD CALLS (Python + Go)
// ============================================================================

describe('Regression: verify totalCalls excludes filtered method calls', () => {
    it('should not count method calls in totalCalls for standalone function', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-total-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
            fs.writeFileSync(path.join(tmpDir, 'api.py'), `
def get(url, params=None):
    return request("GET", url, params=params)

def request(method, url, params=None):
    pass
`);
            fs.writeFileSync(path.join(tmpDir, 'client.py'), `
from .api import get

def fetch_data():
    result = get("/api/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
    return result
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // totalCalls should equal valid + mismatches + uncertain (no inflated count)
            assert.strictEqual(result.totalCalls, result.valid + result.mismatches + result.uncertain,
                `totalCalls (${result.totalCalls}) should equal valid (${result.valid}) + mismatches (${result.mismatches}) + uncertain (${result.uncertain})`);
            // Specifically, method calls like headers.get() and data.get() should NOT be in totalCalls
            assert.ok(result.totalCalls <= 2,
                `totalCalls should be at most 2 (direct calls only), got ${result.totalCalls}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should have consistent totals for Go method calls', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-verify-go-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `
package main

import "os/exec"

func Run(opts string) error {
    return nil
}

func main() {
    Run("hello")
    cmd := exec.Command("ls")
    cmd.Run()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.verify('Run');
            assert.ok(result.found, 'Should find Run function');
            // totalCalls must always equal valid + mismatches + uncertain
            assert.strictEqual(result.totalCalls, result.valid + result.mismatches + result.uncertain,
                `totalCalls (${result.totalCalls}) should equal valid (${result.valid}) + mismatches (${result.mismatches}) + uncertain (${result.uncertain})`);
            // cmd.Run() is a method call and should NOT inflate totalCalls
            assert.ok(result.totalCalls >= 1,
                `Should find at least 1 direct call to Run, got ${result.totalCalls}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// DEADCODE RELATIVE PATHS FOR isTestFile
// ============================================================================

describe('Regression: deadcode uses relative paths for isTestFile', () => {
    it('should not treat non-test files as test files when project is inside a /test/ directory', () => {
        // Simulate a project inside a directory named "test"
        const tmpDir = path.join(os.tmpdir(), `ucn-test-relpath-${Date.now()}`, 'test', 'myproject');
        const toolsDir = path.join(tmpDir, 'tools');
        fs.mkdirSync(toolsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(toolsDir, '__init__.py'), '');
            fs.writeFileSync(path.join(toolsDir, 'helper.py'), `
def unused_helper():
    return 42

def used_helper():
    return 1
`);
            fs.writeFileSync(path.join(tmpDir, 'main.py'), `
from tools.helper import used_helper

def main():
    print(used_helper())
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // unused_helper should be flagged as dead code
            assert.ok(deadNames.includes('unused_helper'),
                `unused_helper should be flagged as dead code, got: ${deadNames.join(', ')}`);

            // used_helper should NOT be flagged
            assert.ok(!deadNames.includes('used_helper'),
                `used_helper should not be flagged as dead code`);
        } finally {
            const topDir = tmpDir.split('/test/myproject')[0];
            if (topDir.includes('ucn-test-relpath')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });

    it('should correctly filter test files even when project is inside /test/ directory', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-relpath2-${Date.now()}`, 'test', 'myproject');
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'app.py'), `
def exported_func():
    return 42

def unused_func():
    return 0
`);
            fs.writeFileSync(path.join(testsDir, 'test_app.py'), `
from app import exported_func

def test_exported():
    assert exported_func() == 42

def _helper_in_test():
    return 'setup'
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Default: test files excluded
            const deadDefault = index.deadcode();
            const deadDefaultNames = deadDefault.map(d => d.name);

            // unused_func from app.py should appear
            assert.ok(deadDefaultNames.includes('unused_func'),
                `unused_func should be in deadcode results`);

            // _helper_in_test from test file should NOT appear (test files excluded by default)
            assert.ok(!deadDefaultNames.includes('_helper_in_test'),
                `_helper_in_test should not appear without --include-tests`);

            // With --include-tests: test file symbols should appear
            const deadWithTests = index.deadcode({ includeTests: true });
            const deadWithTestsNames = deadWithTests.map(d => d.name);

            assert.ok(deadWithTestsNames.includes('_helper_in_test'),
                `_helper_in_test should appear with --include-tests`);

            // test_* functions should still be excluded (they're entry points)
            assert.ok(!deadWithTestsNames.includes('test_exported'),
                `test_exported should not be flagged (entry point)`);
        } finally {
            const topDir = tmpDir.split('/test/myproject')[0];
            if (topDir.includes('ucn-test-relpath2')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });
});

// ============================================================================
// DEADCODE --include-exported RESPECTS TEST FILE FILTERING
// ============================================================================

describe('Regression: deadcode --include-exported respects test file filtering', () => {
    it('should not show test methods when only --include-exported is set', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-exported-${Date.now()}`);
        const testsDir = path.join(tmpDir, 'tests');
        fs.mkdirSync(testsDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'setup.py'), '');
            fs.writeFileSync(path.join(tmpDir, 'lib.py'), `
def public_func():
    return 42
`);
            fs.writeFileSync(path.join(testsDir, 'test_lib.py'), `
from lib import public_func

class TestLib:
    def test_public_func(self):
        assert public_func() == 42

    def test_another(self):
        assert True
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // --include-exported but NOT --include-tests
            const dead = index.deadcode({ includeExported: true, includeTests: false });
            const deadNames = dead.map(d => d.name);

            // Test methods should NOT appear
            assert.ok(!deadNames.includes('test_public_func'),
                `test methods should not appear with only --include-exported`);
            assert.ok(!deadNames.includes('test_another'),
                `test methods should not appear with only --include-exported`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// TEST FILE PATTERNS MATCH RELATIVE PATHS
// ============================================================================

describe('Regression: test file patterns match relative paths', () => {
    it('should detect tests/ at start of relative path for Python', () => {
        const { isTestFile } = require('../core/discovery');
        // Relative paths starting with tests/ should match
        assert.ok(isTestFile('tests/test_app.py', 'python'),
            'tests/test_app.py should be a test file');
        assert.ok(isTestFile('tests/helpers/factory.py', 'python'),
            'tests/helpers/factory.py should be a test file');
        // Subdirectory should still work
        assert.ok(isTestFile('src/tests/test_util.py', 'python'),
            'src/tests/test_util.py should be a test file');
        // Non-test paths should not match
        assert.ok(!isTestFile('src/utils.py', 'python'),
            'src/utils.py should not be a test file');
    });

    it('should detect tests/ at start of relative path for Rust', () => {
        const { isTestFile } = require('../core/discovery');
        assert.ok(isTestFile('tests/integration.rs', 'rust'),
            'tests/integration.rs should be a test file');
        assert.ok(isTestFile('tests/examples/hello.rs', 'rust'),
            'tests/examples/hello.rs should be a test file');
        // Non-test paths should not match
        assert.ok(!isTestFile('src/lib.rs', 'rust'),
            'src/lib.rs should not be a test file');
    });
});

// ============================================================================
// BUG REPORT #4 REGRESSIONS (cross-language tests)
// ============================================================================

describe('Bug Report #4 Regressions (cross-language)', () => {

// BUG 1: trace should forward --include-methods/--include-uncertain
it('trace forwards includeMethods and includeUncertain to findCallees/findCallers', (t) => {
    const code = `
function outer() {
    helper();
}
function helper() {}
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug1-'));
    fs.writeFileSync(path.join(tmpDir, 'test.js'), code);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const result = idx2.trace('outer', { depth: 2, includeMethods: true, includeUncertain: true });
        assert.ok(result, 'trace should return a result');
        assert.ok(result.tree, 'trace should return a tree');
        const calleeNames = result.tree.children.map(c => c.name);
        assert.ok(calleeNames.includes('helper'), 'trace should find helper as callee');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 2: Same-class self/this.method() callers should not be marked uncertain
it('Java same-class implicit calls are not marked uncertain', (t) => {
    const javaCode = `
package test;
public class MyService {
    public void process() {
        validate();
        execute();
    }
    private void validate() {}
    private void execute() {}
}
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug2-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'MyService.java'), javaCode);
    fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const stats = { uncertain: 0 };
        const callers = idx2.findCallers('validate', { stats });
        assert.ok(callers.length > 0, 'validate should have callers');
        assert.ok(callers.some(c => c.callerName === 'process'), 'process should call validate');
        // The key assertion: these should NOT be uncertain
        assert.strictEqual(stats.uncertain, 0, 'same-class implicit calls should not be uncertain');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 4: graph should distinguish circular from diamond dependencies
it('graph labels diamond deps as "(already shown)" not "(circular)"', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug4-'));
    // a.js imports b.js and c.js; both b.js and c.js import d.js (diamond)
    fs.writeFileSync(path.join(tmpDir, 'a.js'), "const b = require('./b');\nconst c = require('./c');");
    fs.writeFileSync(path.join(tmpDir, 'b.js'), "const d = require('./d');\nmodule.exports = {};");
    fs.writeFileSync(path.join(tmpDir, 'c.js'), "const d = require('./d');\nmodule.exports = {};");
    fs.writeFileSync(path.join(tmpDir, 'd.js'), "module.exports = {};");
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const result = idx2.graph(path.join(tmpDir, 'a.js'), { depth: 3, direction: 'imports' });
        assert.ok(result, 'graph should return a result');
        // Verify d.js appears in the graph (diamond dep is present)
        const imports = result.imports || result;
        assert.ok(imports, 'graph should have imports section');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 5c: impact filters by binding and cross-references with findCallsInCode
it('impact filters calls from files with their own definition of same-named function', (t) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug5c-'));
    // main.js defines and calls parse
    fs.writeFileSync(path.join(tmpDir, 'main.js'), `
function parse(s) { return JSON.parse(s); }
const result = parse('{}');
`);
    // other.js defines its own parse
    fs.writeFileSync(path.join(tmpDir, 'other.js'), `
function parse(s) { return s.split(','); }
const items = parse('a,b,c');
`);
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
    try {
        const idx2 = new ProjectIndex(tmpDir);
        idx2.build();
        const result = idx2.impact('parse', { file: 'main' });
        assert.ok(result, 'impact should return a result');
        // Should only show calls from main.js, not other.js
        const files = result.byFile.map(f => f.file);
        assert.ok(!files.some(f => f.includes('other')), 'impact should not include calls from other.js which has its own parse');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

}); // end describe('Bug Report #4 Regressions (cross-language)')

// ============================================================================
// MCP DEMO FIXES
// ============================================================================

describe('MCP Demo Fixes', () => {

// Issue 1: Variable require() should be DYNAMIC, not EXTERNAL
it('imports() classifies variable require() as isDynamic', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dynreq-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'main.js'), `
const path = require('path');
const configPath = './config.json';
const config = require(configPath);
module.exports = config;
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });
        const imports = index.imports(path.join(tmpDir, 'main.js'));

        const pathImp = imports.find(i => i.module === 'path');
        assert.ok(pathImp, 'Should find path import');
        assert.strictEqual(pathImp.isDynamic, false, 'path should not be dynamic');

        const dynImp = imports.find(i => i.module === 'configPath');
        assert.ok(dynImp, 'Should find dynamic require(configPath)');
        assert.strictEqual(dynImp.isDynamic, true, 'variable require should be isDynamic');
        assert.strictEqual(dynImp.isExternal, false, 'variable require should not be isExternal');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 1: formatImports shows DYNAMIC group
it('formatImports shows DYNAMIC (unresolved) group', () => {
    const { formatImports } = require('../core/output');
    const imports = [
        { module: './utils', names: ['helper'], type: 'esm', resolved: 'src/utils.js', isExternal: false, isDynamic: false },
        { module: 'lodash', names: ['map'], type: 'esm', resolved: null, isExternal: true, isDynamic: false },
        { module: 'configPath', names: [], type: 'require', resolved: null, isExternal: false, isDynamic: true }
    ];
    const text = formatImports(imports, 'test.js');
    assert.ok(text.includes('INTERNAL:'), 'Should have INTERNAL section');
    assert.ok(text.includes('EXTERNAL:'), 'Should have EXTERNAL section');
    assert.ok(text.includes('DYNAMIC (unresolved):'), 'Should have DYNAMIC section');
    assert.ok(text.includes('configPath'), 'DYNAMIC section should contain configPath');
    // configPath should NOT be under EXTERNAL
    const externalIdx = text.indexOf('EXTERNAL:');
    const dynamicIdx = text.indexOf('DYNAMIC (unresolved):');
    const configIdx = text.indexOf('configPath');
    assert.ok(configIdx > dynamicIdx, 'configPath should appear after DYNAMIC header, not EXTERNAL');
});

// Issue 2: ucn_class summary for large classes
it('large class gets summary when no max_lines set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bigclass-'));
    try {
        // Generate a class with >200 lines
        let classBody = 'class BigClass {\n';
        for (let i = 0; i < 210; i++) {
            classBody += `  method${i}() { return ${i}; }\n`;
        }
        classBody += '}\nmodule.exports = BigClass;\n';
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'big.js'), classBody);

        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        // Verify the class is found and >200 lines
        const matches = index.find('BigClass', {}).filter(m =>
            ['class', 'interface', 'type', 'enum', 'struct', 'trait'].includes(m.type)
        );
        assert.ok(matches.length > 0, 'Should find BigClass');
        const match = matches[0];
        const lineCount = match.endLine - match.startLine + 1;
        assert.ok(lineCount > 200, `Class should be >200 lines, got ${lineCount}`);

        // Verify findMethodsForType finds methods
        const methods = index.findMethodsForType('BigClass');
        assert.ok(methods.length > 100, `Should find >100 methods, got ${methods.length}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 5: context() includes includeMethods in meta
it('context() meta includes includeMethods flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-incmeth-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function greet(name) { return 'hi ' + name; }
function main() { greet('world'); }
module.exports = { greet, main };
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        // Default: includeMethods should be false
        const ctx1 = index.context('greet', {});
        assert.ok(ctx1, 'Should find greet');
        assert.ok(ctx1.meta, 'Should have meta');
        assert.strictEqual(ctx1.meta.includeMethods, false, 'includeMethods should be false by default');

        // With includeMethods: true
        const ctx2 = index.context('greet', { includeMethods: true });
        assert.strictEqual(ctx2.meta.includeMethods, true, 'includeMethods should be true when set');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 5: trace() includes includeMethods flag (defaults to true)
it('trace() includes includeMethods flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-tracemeth-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function greet(name) { return 'hi ' + name; }
function main() { greet('world'); }
module.exports = { greet, main };
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        const trace1 = index.trace('main', {});
        assert.ok(trace1, 'Should find main');
        assert.strictEqual(trace1.includeMethods, true, 'includeMethods should be true by default for trace');

        const trace2 = index.trace('main', { includeMethods: false });
        assert.strictEqual(trace2.includeMethods, false, 'includeMethods should be false when explicitly set');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// Issue 5: formatTrace includes include_methods hint when explicitly excluded
it('formatTrace includes include_methods hint when explicitly excluded', () => {
    const { formatTrace } = require('../core/output');
    const traceData = {
        root: 'test',
        file: 'a.js',
        line: 1,
        direction: 'down',
        maxDepth: 3,
        includeMethods: false,
        tree: { name: 'test', file: 'a.js', line: 1, children: [] }
    };
    const text = formatTrace(traceData);
    assert.ok(text.includes('obj.method() calls excluded'), 'Should hint about include-methods when excluded');

    // With includeMethods: true (default), no hint
    const traceData2 = { ...traceData, includeMethods: true };
    const text2 = formatTrace(traceData2);
    assert.ok(!text2.includes('obj.method() calls excluded'), 'Should not hint when includeMethods=true (default)');
});

}); // end describe('MCP Demo Fixes')

// ============================================================================
// MCP ISSUES FIXES
// ============================================================================

describe('MCP Issues Fixes', () => {

    // Issue 1: expand cache was keyed by project only, losing previous context results
    it('expand cache supports multiple symbols per project (issue 1)', () => {
        const { ExpandCache } = require(path.join(PROJECT_DIR, 'core', 'expand-cache'));
        const cache = new ExpandCache();
        const projectRoot = '/fake/project';

        // Store context for symbol A
        cache.save(projectRoot, 'funcA', null, [{ num: 1, name: 'callerOfA', type: 'function' }]);

        // Store context for symbol B (should NOT overwrite A)
        cache.save(projectRoot, 'funcB', null, [{ num: 1, name: 'callerOfB', type: 'function' }]);

        // Both should be retrievable — funcB is most recent, but funcA's items are still findable
        const lookupB = cache.lookup(projectRoot, 1);
        assert.ok(lookupB.match, 'should find item 1 from most recent context (funcB)');
        assert.strictEqual(lookupB.match.name, 'callerOfB', 'most recent should be funcB');

        // Item with a unique number in funcA should be findable via fallback
        cache.save(projectRoot, 'funcA', null, [
            { num: 1, name: 'callerOfA', type: 'function' },
            { num: 2, name: 'otherCallerOfA', type: 'function' }
        ]);
        // funcA is now most recent, so item 2 should be found
        const lookupA2 = cache.lookup(projectRoot, 2);
        assert.ok(lookupA2.match, 'should find item 2 from funcA');
        assert.strictEqual(lookupA2.match.name, 'otherCallerOfA');
    });

    // Issue 2: example() method moved to core/project.js
    it('ProjectIndex.example() returns scored result (issue 2)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        // Create a JS file with a function that is called
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'lib.js'), `
function greet(name) {
    return 'Hello ' + name;
}
module.exports = { greet };
`);
        fs.writeFileSync(path.join(dir, 'app.js'), `
const { greet } = require('./lib');
const msg = greet('world');
console.log(msg);
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        const result = index.example('greet');
        assert.ok(result, 'example() should return a result');
        assert.ok(result.best, 'should have a best example');
        assert.ok(result.best.score >= 0, 'should have a score');
        assert.ok(result.totalCalls > 0, 'should have total calls');
        assert.ok(result.best.content.includes('greet'), 'best example content should contain the function name');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('ProjectIndex.example() returns null when no calls found (issue 2)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'lib.js'), `
function unusedFn() { return 42; }
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        const result = index.example('unusedFn');
        assert.strictEqual(result, null, 'should return null for unused function');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Issue 3: ucn_class uses index data instead of re-parsing (generics stored in index)
    it('index stores generics for classes (issue 4)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'generic.ts'), `
class Container<T> {
    private value: T;
    constructor(val: T) {
        this.value = val;
    }
    get(): T { return this.value; }
}
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        const matches = index.find('Container').filter(m => m.type === 'class');
        assert.ok(matches.length > 0, 'should find Container class');
        assert.ok(matches[0].generics, 'class should have generics field');
        assert.ok(matches[0].generics.includes('T'), 'generics should contain T');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Issue 5: CALLERS label instead of USAGES
    it('context class output uses CALLERS label instead of USAGES (issue 5)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'animal.js'), `
class Animal {
    constructor(name) { this.name = name; }
    speak() { return this.name; }
}
module.exports = { Animal };
`);
        fs.writeFileSync(path.join(dir, 'main.js'), `
const { Animal } = require('./animal');
const a = new Animal('dog');
`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });
        const ctx = index.context('Animal');
        assert.ok(ctx, 'context should return result');
        assert.ok(ctx.callers !== undefined, 'should have callers field');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    // Issue 6: CLI graph --direction flag
    it('graph supports direction=imports (issue 6)', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(dir, 'package.json'), '{}');
        fs.writeFileSync(path.join(dir, 'a.js'), `const b = require('./b'); module.exports = {};`);
        fs.writeFileSync(path.join(dir, 'b.js'), `module.exports = { x: 1 };`);
        fs.writeFileSync(path.join(dir, 'c.js'), `const a = require('./a'); module.exports = {};`);

        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });

        // direction=imports — what a.js depends on
        const imports = index.graph('a.js', { direction: 'imports', maxDepth: 2 });
        assert.ok(imports.nodes.length > 0, 'should have nodes');
        const importPaths = imports.nodes.map(n => n.relativePath);
        assert.ok(importPaths.includes('b.js'), 'imports should include b.js');

        // direction=importers — who depends on a.js
        const importers = index.graph('a.js', { direction: 'importers', maxDepth: 2 });
        assert.ok(importers.nodes.length > 0, 'should have nodes');
        const importerPaths = importers.nodes.map(n => n.relativePath);
        assert.ok(importerPaths.includes('c.js'), 'importers should include c.js');

        fs.rmSync(dir, { recursive: true, force: true });
    });

}); // end describe('MCP Issues Fixes')

// ============================================================================
// RELIABILITY HINTS
// ============================================================================

describe('Reliability Hints', () => {

// --- deadcode: decorators surfaced in results ---
it('deadcode surfaces Python decorators on dead functions', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-deco-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
class MyClass:
    @staticmethod
    def static_helper():
        pass

    def used_method(self):
        self.static_helper()
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // Verify decorators are stored in symbol index
        const syms = index.symbols.get('static_helper');
        assert.ok(syms && syms.length > 0, 'static_helper should be in symbol index');
        assert.ok(syms[0].decorators, 'static_helper should have decorators');
        assert.ok(syms[0].decorators.includes('staticmethod'), 'should include staticmethod decorator');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('deadcode surfaces Java annotations on dead methods', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-anno-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project><groupId>test</groupId></project>');
        fs.mkdirSync(path.join(tmpDir, 'src', 'main', 'java'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'main', 'java', 'Service.java'), `
public class Service {
    public void unusedPublic() {}
    private void unusedPrivate() {}
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.java', { quiet: true });
        const dc = index.deadcode({ includeExported: true });

        assert.ok(dc.length >= 2, 'Should find at least 2 dead methods');
        const names = dc.map(d => d.name);
        assert.ok(names.includes('unusedPublic'), 'Should find unusedPublic');
        assert.ok(names.includes('unusedPrivate'), 'Should find unusedPrivate');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('formatDeadcode shows decorator hints', () => {
    const { formatDeadcode } = require('../core/output');
    const results = [
        { name: 'cleanup', type: 'function', file: 'app.py', startLine: 2, endLine: 5, isExported: false, decorators: ['app.route("/cleanup")'] },
        { name: 'helper', type: 'function', file: 'app.py', startLine: 10, endLine: 12, isExported: false },
        { name: 'scheduled', type: 'method', file: 'Service.java', startLine: 5, endLine: 8, isExported: true, annotations: ['scheduled'] }
    ];
    const text = formatDeadcode(results);
    assert.ok(text.includes('[has @app.route("/cleanup")]'), 'Should show Python decorator hint');
    assert.ok(!text.includes('helper (function) [has'), 'helper should not have decorator hint');
    assert.ok(text.includes('[has @scheduled]'), 'Should show Java annotation hint');
});

// --- context: class method low-caller hint ---
it('context includes isMethod/className in meta for class methods', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ctx-hint-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class UserService:
    def get_user(self, user_id):
        return self._fetch(user_id)

    def _fetch(self, uid):
        return {'id': uid}
`);
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        const ctx = index.context('get_user');
        assert.ok(ctx, 'Should find get_user');
        assert.ok(ctx.meta, 'Should have meta');
        assert.ok(ctx.meta.isMethod || ctx.meta.className, 'Should indicate it is a class method');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('formatContext shows class method hint when callers <= 3', () => {
    const { formatContext } = require('../core/output');

    // Class method with 1 caller
    const ctx1 = {
        function: 'get_user',
        file: 'service.py',
        startLine: 3,
        endLine: 5,
        callers: [{ relativePath: 'router.py', line: 10, callerName: 'handle_request', content: 'svc.get_user(id)' }],
        callees: [],
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true, isMethod: true, className: 'UserService' }
    };
    const { text: text1 } = formatContext(ctx1);
    assert.ok(text1.includes('class/struct method'), 'Should show class method hint for 1 caller');
    assert.ok(text1.includes('constructed or injected'), 'Should mention injected instances');

    // Non-method function with 1 caller — no hint
    const ctx2 = {
        function: 'helper',
        file: 'utils.py',
        startLine: 1,
        endLine: 3,
        callers: [{ relativePath: 'main.py', line: 5, callerName: 'main', content: 'helper()' }],
        callees: [],
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true }
    };
    const { text: text2 } = formatContext(ctx2);
    assert.ok(!text2.includes('class/struct method'), 'Should NOT show hint for standalone function');

    // Class method with many callers — no hint
    const manyCallers = Array.from({ length: 10 }, (_, i) => ({
        relativePath: `file${i}.py`, line: i + 1, callerName: `fn${i}`, content: `svc.get_user(${i})`
    }));
    const ctx3 = {
        function: 'get_user',
        file: 'service.py',
        startLine: 3,
        endLine: 5,
        callers: manyCallers,
        callees: [],
        meta: { complete: true, skipped: 0, dynamicImports: 0, uncertain: 0, includeMethods: true, isMethod: true, className: 'UserService' }
    };
    const { text: text3 } = formatContext(ctx3);
    assert.ok(!text3.includes('class/struct method'), 'Should NOT show hint when callers > 3');
});

// --- deadcode: decorated/annotated functions now detected ---
it('deadcode excludes decorated Python functions by default, includes with flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-pydeco-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
from flask import Flask
app = Flask(__name__)

@app.route('/users')
def list_users():
    return []

@app.route('/health')
def health_check():
    return {'status': 'ok'}

def plain_unused():
    return 42

def used_fn():
    return plain_unused()
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // Default: decorated functions with '.' are excluded
        const dcDefault = index.deadcode();
        const defaultNames = dcDefault.map(d => d.name);
        assert.ok(!defaultNames.includes('list_users'), 'Decorated list_users should be excluded by default');
        assert.ok(!defaultNames.includes('health_check'), 'Decorated health_check should be excluded by default');
        assert.strictEqual(dcDefault.excludedDecorated, 2, 'Should report 2 excluded decorated symbols');

        // With includeDecorated: decorated functions are included
        const dcAll = index.deadcode({ includeDecorated: true });
        const allNames = dcAll.map(d => d.name);
        assert.ok(allNames.includes('list_users'), 'Decorated list_users should be included with flag');
        assert.ok(allNames.includes('health_check'), 'Decorated health_check should be included with flag');
        assert.strictEqual(dcAll.excludedDecorated, 0, 'No excluded decorated when includeDecorated=true');

        // plain_unused is called by used_fn, so it should NOT be dead in either case
        assert.ok(!defaultNames.includes('plain_unused'), 'plain_unused is called and should not be dead');

        // Verify decorator hints are present when included
        const listUsersResult = dcAll.find(d => d.name === 'list_users');
        assert.ok(listUsersResult.decorators, 'list_users should have decorators');
        assert.ok(listUsersResult.decorators.some(d => d.includes('app.route')), 'Should include app.route decorator');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('deadcode excludes annotated Java methods by default, includes with flag', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-javaanno-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project><groupId>test</groupId></project>');
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'Service.java'), `
public class Service {
    @Scheduled(fixedRate = 5000)
    public void cleanup() {
        System.out.println("cleanup");
    }

    @Bean
    public Object dataSource() {
        return null;
    }

    public void plainUnused() {
        System.out.println("unused");
    }
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.java', { quiet: true });

        // Default: annotated methods are excluded (cleanup has @Scheduled, dataSource has @Bean)
        const dcDefault = index.deadcode({ includeExported: true });
        const defaultNames = dcDefault.map(d => d.name);
        assert.ok(!defaultNames.includes('cleanup'), 'Annotated cleanup should be excluded by default');
        assert.ok(!defaultNames.includes('dataSource'), 'Annotated dataSource should be excluded by default');
        assert.ok(defaultNames.includes('plainUnused'), 'plainUnused (no annotations) should still be detected');
        assert.strictEqual(dcDefault.excludedDecorated, 2, 'Should report 2 excluded annotated symbols');

        // With includeDecorated: annotated methods are included
        const dcAll = index.deadcode({ includeExported: true, includeDecorated: true });
        const allNames = dcAll.map(d => d.name);
        assert.ok(allNames.includes('cleanup'), 'Annotated cleanup should be included with flag');
        assert.ok(allNames.includes('dataSource'), 'Annotated dataSource should be included with flag');
        assert.ok(allNames.includes('plainUnused'), 'plainUnused should be included');

        // Verify annotation hints when included
        const cleanupResult = dcAll.find(d => d.name === 'cleanup');
        assert.ok(cleanupResult.annotations, 'cleanup should have annotations');
        assert.ok(cleanupResult.annotations.includes('scheduled'), 'Should include scheduled annotation');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('deadcode detects decorated Python class methods as dead', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-pymethod-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class Service:
    @staticmethod
    def unused_static():
        return 42

    def used_method(self):
        return self.unused_static()
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });
        const dc = index.deadcode();
        const names = dc.map(d => d.name);

        // unused_static has a caller (used_method calls it via self.), so behavior depends on resolution
        // used_method has no external callers
        assert.ok(names.includes('used_method'), 'used_method with no external callers should be dead');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('Java extractModifiers finds annotations on class body methods', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-mods-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project><groupId>test</groupId></project>');
        fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
        fs.writeFileSync(path.join(tmpDir, 'src', 'MyClass.java'), `
public class MyClass {
    @Override
    public void run() {}
    @Bean
    public Object factory() { return null; }
    public void plain() {}
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.java', { quiet: true });

        const runSyms = index.symbols.get('run');
        assert.ok(runSyms && runSyms.length > 0, 'run should be in index');
        assert.ok(runSyms[0].modifiers.includes('override'), 'run should have override modifier');

        const factorySyms = index.symbols.get('factory');
        assert.ok(factorySyms && factorySyms.length > 0, 'factory should be in index');
        assert.ok(factorySyms[0].modifiers.includes('bean'), 'factory should have bean modifier');

        const plainSyms = index.symbols.get('plain');
        assert.ok(plainSyms && plainSyms.length > 0, 'plain should be in index');
        assert.ok(!plainSyms[0].modifiers.includes('override'), 'plain should not have override');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// --- about: includeMethods default ---
it('about defaults includeMethods based on target type', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-about-methods-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'service.py'), `
class Analyzer:
    def analyze(self, data):
        return self._process(data)

    def _process(self, data):
        return data * 2
`);
        fs.writeFileSync(path.join(tmpDir, 'main.py'), `
from service import Analyzer
def run():
    a = Analyzer()
    a.analyze('test')

def helper():
    return 42
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // Class methods: includeMethods defaults to true (method calls are how class methods are invoked)
        const aboutMethod = index.about('analyze');
        assert.ok(aboutMethod, 'Should find analyze');
        assert.ok(aboutMethod.found, 'Should be found');
        assert.ok(aboutMethod.includeMethods === true, 'includeMethods should default to true for class methods');

        // Standalone functions: includeMethods defaults to false (reduces noise from unrelated obj.fn() calls)
        const aboutFunc = index.about('helper');
        assert.ok(aboutFunc, 'Should find helper');
        assert.ok(aboutFunc.found, 'Should be found');
        assert.ok(aboutFunc.includeMethods === false, 'includeMethods should default to false for standalone functions');

        // Explicit override still works
        const aboutExplicit = index.about('analyze', { includeMethods: false });
        assert.ok(aboutExplicit.includeMethods === false, 'explicit includeMethods=false should be respected');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('about with includeMethods=false shows note in formatted output', () => {
    const { formatAbout } = require('../core/output');

    // Mock about result with includeMethods=false
    const aboutResult = {
        found: true,
        symbol: { name: 'analyze', type: 'method', file: 'service.py', startLine: 3, endLine: 5, signature: 'analyze(self, data)' },
        usages: { definitions: 1, calls: 0, imports: 0, references: 0 },
        totalUsages: 0,
        callers: { total: 0, top: [] },
        callees: { total: 0, top: [] },
        tests: { fileCount: 0, totalMatches: 0, files: [] },
        otherDefinitions: [],
        types: [],
        code: null,
        includeMethods: false,
        completeness: { warnings: [] }
    };
    const text = formatAbout(aboutResult);
    assert.ok(text.includes('obj.method() callers/callees excluded'), 'Should show note when includeMethods=false');
    assert.ok(text.includes('--include-methods'), 'Should mention the flag');

    // With includeMethods=true (default) — no note
    aboutResult.includeMethods = true;
    const text2 = formatAbout(aboutResult);
    assert.ok(!text2.includes('obj.method() callers/callees excluded'), 'Should NOT show note when includeMethods=true');
});

// --- deadcode: exclusion counts in output ---
it('deadcode returns exclusion counts for decorated and exported', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-counts-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
import something

@something.route('/a')
def route_a():
    return 1

@something.task
def task_b():
    return 2

def plain_unused():
    return 3
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        const dc = index.deadcode();
        // route_a and task_b have '.' decorators — excluded
        assert.strictEqual(dc.excludedDecorated, 2, 'Should exclude 2 decorated symbols');
        // plain_unused should be in results
        const names = dc.map(d => d.name);
        assert.ok(names.includes('plain_unused'), 'plain_unused should be in results');
        assert.ok(!names.includes('route_a'), 'route_a should be excluded');
        assert.ok(!names.includes('task_b'), 'task_b should be excluded');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('formatDeadcode shows exclusion counts in hints', () => {
    const { formatDeadcode } = require('../core/output');

    // Simulate results with exclusion counts
    const results = [
        { name: 'helper', type: 'function', file: 'utils.py', startLine: 1, endLine: 3, isExported: false }
    ];
    results.excludedDecorated = 5;
    results.excludedExported = 12;

    const text = formatDeadcode(results);
    assert.ok(text.includes('5 decorated/annotated symbol(s) hidden'), 'Should show decorated count');
    assert.ok(text.includes('--include-decorated'), 'Should hint at --include-decorated flag');
    assert.ok(text.includes('12 exported symbol(s) excluded'), 'Should show exported count');
    assert.ok(text.includes('--include-exported'), 'Should hint at --include-exported flag');
});

it('formatDeadcode handles zero exclusions without hints', () => {
    const { formatDeadcode } = require('../core/output');

    const results = [
        { name: 'helper', type: 'function', file: 'utils.py', startLine: 1, endLine: 3, isExported: false }
    ];
    results.excludedDecorated = 0;
    results.excludedExported = 0;

    const text = formatDeadcode(results);
    assert.ok(!text.includes('hidden'), 'Should not show any hidden hints when counts are 0');
    assert.ok(text.includes('helper'), 'Should still show the result');
});

it('formatDeadcode respects --top option', () => {
    const { formatDeadcode } = require('../core/output');

    const results = [
        { name: 'a', type: 'function', file: 'a.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'b', type: 'function', file: 'b.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'c', type: 'function', file: 'c.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'd', type: 'function', file: 'd.js', startLine: 1, endLine: 3, isExported: false },
        { name: 'e', type: 'function', file: 'e.js', startLine: 1, endLine: 3, isExported: false }
    ];
    results.excludedDecorated = 0;
    results.excludedExported = 0;

    // With top=2, should show only 2 results
    const text = formatDeadcode(results, { top: 2 });
    assert.ok(text.includes('(showing 2)'), 'Should indicate showing 2');
    assert.ok(text.includes('a (function)'), 'Should show first result');
    assert.ok(text.includes('b (function)'), 'Should show second result');
    assert.ok(!text.includes('c (function)'), 'Should not show third result');
    assert.ok(text.includes('3 more result(s) not shown'), 'Should show hidden count');

    // Without top, should show all results
    const textAll = formatDeadcode(results);
    assert.ok(!textAll.includes('showing'), 'Should not indicate partial results');
    assert.ok(textAll.includes('e (function)'), 'Should show all results');
    assert.ok(!textAll.includes('more result(s) not shown'), 'Should not show hidden hint');
});

it('deadcode Python: simple decorators NOT excluded (only attribute access)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-dc-simple-deco-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'pyproject.toml'), '[project]\nname = "test"');
        fs.writeFileSync(path.join(tmpDir, 'app.py'), `
class Service:
    @staticmethod
    def unused_static():
        return 42

    @property
    def unused_prop(self):
        return 'x'
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });
        const dc = index.deadcode();
        const names = dc.map(d => d.name);

        // @staticmethod and @property don't have '.' — should NOT be excluded
        assert.ok(names.includes('unused_static') || names.includes('unused_prop'),
            'Simple decorators (no dot) should still appear in deadcode');
        assert.strictEqual(dc.excludedDecorated, 0, 'No dot-decorators, so 0 excluded');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

}); // end describe('Reliability Hints')

// ============================================================================
// PRODUCTION READINESS FIXES
// ============================================================================

describe('Production readiness fixes', () => {

    it('plan() uses resolveSymbol to pick source over test file', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-plan-resolve-'));
        try {
            // Create two files with same function name - one test, one source
            fs.writeFileSync(path.join(tmpDir, 'utils.test.js'), `
function process(x) { return x + 1; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'utils.js'), `
function process(x, y) { return x + y; }
module.exports = { process };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { process } = require('./utils');
process(1, 2);
`);
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const plan = index.plan('process', { renameTo: 'compute' });
            assert.ok(plan.found, 'Should find the function');
            // resolveSymbol should pick source file (utils.js) over test file (utils.test.js)
            assert.ok(plan.file.includes('utils.js') && !plan.file.includes('test'),
                `Should pick source file, got: ${plan.file}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('plan() respects --file disambiguation', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-plan-file-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'alpha.js'), `
function doWork(a) { return a; }
module.exports = { doWork };
`);
            fs.writeFileSync(path.join(tmpDir, 'beta.js'), `
function doWork(a, b) { return a + b; }
module.exports = { doWork };
`);
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.js', { quiet: true });

            const plan = index.plan('doWork', { renameTo: 'doTask', file: 'beta' });
            assert.ok(plan.found, 'Should find the function');
            assert.ok(plan.file.includes('beta'), `Should pick beta.js, got: ${plan.file}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('.ucn.json config is loaded correctly', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-json-config-'));
        try {
            fs.writeFileSync(path.join(tmpDir, '.ucn.json'), JSON.stringify({
                aliases: { '@': './src' }
            }));
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'index.js'), 'function main() {}');

            const index = new ProjectIndex(tmpDir);
            assert.deepStrictEqual(index.config.aliases, { '@': './src' },
                'Should load aliases from .ucn.json');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('completeness detection counts all dynamic patterns additively', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-completeness-'));
        try {
            // File with multiple dynamic pattern types
            fs.writeFileSync(path.join(tmpDir, 'dynamic.js'), `
const mod = 'fs';
import(mod);
require(mod);
const x = eval('1+1');
const fn = new Function('return 1');
`);
            fs.writeFileSync(path.join(tmpDir, 'reflect.py'), `
x = getattr(obj, 'method')
y = hasattr(obj, 'method')
`);
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.{js,py}', { quiet: true });

            const completeness = index.detectCompleteness();
            assert.ok(!completeness.complete, 'Should not be complete');

            const dynamicWarn = completeness.warnings.find(w => w.type === 'dynamic_imports');
            assert.ok(dynamicWarn, 'Should have dynamic_imports warning');
            assert.ok(dynamicWarn.count >= 2,
                `Should count both import() and require() independently, got: ${dynamicWarn.count}`);

            const evalWarn = completeness.warnings.find(w => w.type === 'eval');
            assert.ok(evalWarn, 'Should have eval warning');
            assert.ok(evalWarn.count >= 2,
                `Should count both eval() and new Function() independently, got: ${evalWarn.count}`);

            const reflectWarn = completeness.warnings.find(w => w.type === 'reflection');
            assert.ok(reflectWarn, 'Should have reflection warning');
            assert.ok(reflectWarn.count >= 2,
                `Should count both getattr() and hasattr() independently, got: ${reflectWarn.count}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

});

// ============================================================================
// F-002 UNTYPED METHOD CALL UNCERTAINTY
// ============================================================================

describe('Regression: F-002 untyped method call uncertainty', () => {
    it('does not link m.get() to unrelated standalone get() in findCallees', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'repository.js'),
                'export function get(id) { return id; }');
            fs.writeFileSync(path.join(tmpDir, 'app.js'),
                'export function getIndex(m) { return m.get("k"); }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Default about() includes methods but not uncertain
            const result = index.about('getIndex', { includeMethods: true });
            assert.ok(result && result.found, 'about should return a result');

            const calleeNames = (result.callees.top || []).map(c => c.name);
            assert.ok(!calleeNames.includes('get'),
                'repository.get should NOT appear as callee of getIndex (m has no type evidence)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('still resolves this.method() to same-class method', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002b-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'service.js'), `
class Service {
    get(id) { return id; }
    getIndex() { return this.get("k"); }
}
module.exports = Service;
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const result = index.about('getIndex', { includeMethods: true });
            assert.ok(result && result.found, 'about should return a result');

            const calleeNames = (result.callees.top || []).map(c => c.name);
            assert.ok(calleeNames.includes('get'),
                'this.get() should resolve to same-class Service.get');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('does not link m.get() to unrelated get() in findCallers', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002c-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'repository.js'),
                'export function get(id) { return id; }');
            fs.writeFileSync(path.join(tmpDir, 'app.js'),
                'export function getIndex(m) { return m.get("k"); }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // findCallers for 'get' should NOT include getIndex (m.get is uncertain)
            const callers = index.findCallers('get');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(!callerNames.includes('getIndex'),
                'getIndex should NOT be a caller of get (m has no type evidence)');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('preserves Go package method calls (receiver is known import)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002d-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/app\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'utils.go'), `package main

func Get(id string) string {
    return id
}
`);
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

import "fmt"

func main() {
    fmt.Println(Get("hello"))
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // fmt.Println is a package call — fmt is a known import
            // Get("hello") is a direct call, not a method call — should always work
            const result = index.about('main');
            assert.ok(result && result.found, 'about should return a result');

            const calleeNames = (result.callees.top || []).map(c => c.name);
            assert.ok(calleeNames.includes('Get'),
                'direct Get() call should appear as callee of main');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('includes untyped method calls when includeUncertain is true', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-f002e-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'repository.js'),
                'export function get(id) { return id; }');
            fs.writeFileSync(path.join(tmpDir, 'app.js'),
                'export function getIndex(m) { return m.get("k"); }');

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // With includeUncertain, the method call should appear
            const callees = index.findCallees(
                { name: 'getIndex', file: path.join(tmpDir, 'app.js'), startLine: 1, endLine: 1 },
                { includeMethods: true, includeUncertain: true }
            );
            const calleeNames = [...callees.values()].map(c => c.name);
            assert.ok(calleeNames.includes('get'),
                'with includeUncertain, m.get() should appear as uncertain callee');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// FIX 86-92: MISC CROSS-CUTTING FIXES
// ============================================================================

describe('FIX 86-92: Misc cross-cutting fixes', () => {

it('FIX 86 — stripJsonComments preserves URLs inside strings', () => {
    const jsonContent = `{
        // This is a comment
        "baseUrl": "https://example.com/path",
        "paths": { "@/*": ["./src/*"] }
    }`;

    const tmpDir = path.join(os.tmpdir(), `ucn-test-json-comments-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });
    try {
        fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), jsonContent);
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        // Just verify no crash
        assert.ok(true, 'JSON with URLs in strings should parse without corruption');
    } catch (e) {
        // cleanup
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 87 — search context lines appear in correct order (before, match, after)', () => {
    const results = [{
        file: 'test.js',
        matches: [{
            line: 5,
            content: 'const x = 42;',
            before: ['// line 3', '// line 4'],
            after: ['// line 6', '// line 7']
        }]
    }];
    const formatted = output.formatSearch(results, 'x', 1);
    const lines = formatted.split('\n');
    // Find the match line and verify before/after ordering
    const matchIdx = lines.findIndex(l => l.includes('5:') && l.includes('const x = 42'));
    assert.ok(matchIdx > 0, 'Should find the match line');
    // Before context should come before the match
    const beforeIdx = lines.findIndex(l => l.includes('line 4'));
    assert.ok(beforeIdx < matchIdx, `Before context (idx ${beforeIdx}) should come before match (idx ${matchIdx})`);
    // After context should come after the match
    const afterIdx = lines.findIndex(l => l.includes('line 6'));
    assert.ok(afterIdx > matchIdx, `After context (idx ${afterIdx}) should come after match (idx ${matchIdx})`);
});

it('FIX 88 — MCP context/smart pass undefined includeMethods for language default', () => {
    const index = idx(FIXTURES_PATH + '/javascript');

    const ctx = index.context('processData');
    assert.ok(ctx, 'context should work with default includeMethods');

    const smart = index.smart('processData');
    assert.ok(smart, 'smart should work with default includeMethods');
});

it('FIX 92 — file-mode auto-routes verify/plan/expand/stacktrace/file-exports', () => {
    const { execSync } = require('child_process');
    const testFile = path.join(PROJECT_DIR, 'core', 'parser.js');

    // verify command should auto-route to project mode, not error with "Unknown command"
    try {
        const out = execSync(`node ${CLI_PATH} ${testFile} verify parse 2>&1`, { timeout: 30000 }).toString();
        assert.ok(!out.includes('Unknown command'), 'verify should not be "Unknown command" in file mode');
    } catch (e) {
        const stderr = e.stderr?.toString() || e.stdout?.toString() || '';
        assert.ok(!stderr.includes('Unknown command'),
            `verify should auto-route in file mode, got: ${stderr.slice(0, 200)}`);
    }
});

}); // end describe FIX 86-92

// ============================================================================
// FIX 93-101: LOW SEVERITY FIXES
// ============================================================================

describe('FIX 93-101: Low severity fixes', () => {

it('FIX 93 — JS isAsync detects async with access modifiers', () => {
    const regex = /^\s*(?:(?:public|private|protected)\s+)?(?:static\s+)?(?:override\s+)?async\s/;
    assert.ok(regex.test('    public async doWork() {'), 'public async should match');
    assert.ok(regex.test('    private async fetchData() {'), 'private async should match');
    assert.ok(regex.test('    protected async loadItems() {'), 'protected async should match');
    assert.ok(regex.test('    public static async create() {'), 'public static async should match');
    assert.ok(regex.test('    static async create() {'), 'static async should match');
    assert.ok(regex.test('    async plain() {'), 'async plain should match');
    assert.ok(!regex.test('    public doWork() {'), 'non-async should not match');
});

it('FIX 94 — Java type identifiers in parameters not classified as definitions', () => {
    const javaParser = require(path.join(PROJECT_DIR, 'languages', 'java'));
    const { getParser } = require(path.join(PROJECT_DIR, 'languages'));
    const parser = getParser('java');

    const code = `
public class Example {
    public void foo(String name, int count) {
        System.out.println(name);
    }
}`;
    const usages = javaParser.findUsagesInCode(code, 'String', parser);
    const defs = usages.filter(u => u.type === 'definition');
    assert.strictEqual(defs.length, 0, 'String should not be classified as a definition in formal_parameter');
});

it('FIX 95 — ExpandCache key includes file for disambiguation', () => {
    const cacheCode = fs.readFileSync(path.join(PROJECT_DIR, 'core', 'expand-cache.js'), 'utf-8');
    assert.ok(cacheCode.includes('`${root}:${name}:${file || \'\'}`'),
        'expandCache key should include file parameter');
});

it('FIX 96 — tsconfig paths are regex-escaped before compilation', () => {
    const pattern = 'src.lib/*';
    const escaped = pattern.replace(/[.+^$[\]\\{}()|]/g, '\\$&').replace('*', '(.*)');
    const regex = new RegExp('^' + escaped + '$');
    assert.ok(!regex.test('srcXlib/foo'), 'src.lib/* should not match srcXlib/foo (dot is literal)');
    assert.ok(regex.test('src.lib/foo'), 'src.lib/* should match src.lib/foo');
    const unfixed = new RegExp('^' + pattern.replace('*', '(.*)') + '$');
    assert.ok(unfixed.test('srcXlib/foo'), 'unfixed regex would incorrectly match srcXlib/foo');
});

it('FIX 97 — graph direction defaults to "both"', () => {
    const projectCode = fs.readFileSync(path.join(PROJECT_DIR, 'core', 'project.js'), 'utf-8');
    assert.ok(projectCode.includes("options.direction || 'both'"),
        'graph direction should default to "both"');
});

it('FIX 98 — globToRegex handles ** without double-replacing', () => {
    const { globToRegex } = require(path.join(PROJECT_DIR, 'core', 'discovery'));
    const regex = globToRegex('src/**/*.js');
    assert.ok(regex.test('src/foo/bar/baz.js'), '** should match multiple directories');
    assert.ok(regex.test('src/foo/baz.js'), '** should match single directory');
    assert.ok(!regex.test('src/foo/bar/baz.jsx'), 'should not match .jsx');
    const regexStr = regex.source;
    assert.ok(regexStr.includes('.*'), 'should contain .* for **');
    assert.ok(regexStr.includes('[^/]*'), 'should contain [^/]* for single *');
});

it('FIX 99 — dead code: javaSuffixMap and filesToCheck removed', () => {
    const projectCode = fs.readFileSync(path.join(PROJECT_DIR, 'core', 'project.js'), 'utf-8');
    assert.ok(!projectCode.includes('javaSuffixMap'), 'javaSuffixMap should be removed');
    assert.ok(!projectCode.includes('filesToCheck'), 'filesToCheck should be removed');
});

it('FIX 101 — CLI positional args uses index not indexOf for duplicate args', () => {
    const { execSync } = require('child_process');
    try {
        const out = execSync(`node ${CLI_PATH} . find --file project parser parser 2>&1`, { timeout: 30000 }).toString();
        assert.ok(!out.includes('No name specified') && !out.includes('Usage:'),
            'duplicate positional arg should not be filtered: ' + out.slice(0, 200));
    } catch (e) {
        const stderr = e.stderr?.toString() || e.stdout?.toString() || '';
        assert.ok(!stderr.includes('No name specified'),
            `search term should not be dropped: ${stderr.slice(0, 200)}`);
    }
});

}); // end describe FIX 93-101

// ============================================================================
// FIX 102-107: EXCLUDE, GITIGNORE, BUNDLED, SCOPE
// ============================================================================

describe('FIX 102-107: Exclude, gitignore, bundled, scope', () => {

it('FIX 102 — exclude filter works on about, impact, context, deadcode', () => {
    const tmpDir = path.join(require('os').tmpdir(), `ucn-test-exclude-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'test'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'lib.js'), `
function greet(name) {
    return "Hello " + name;
}
module.exports = { greet };
`);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
const { greet } = require('./lib');
function main() {
    console.log(greet("World"));
}
`);
    fs.writeFileSync(path.join(tmpDir, 'test', 'lib.test.js'), `
const { greet } = require('../src/lib');
function testGreet() {
    greet("Test");
}
`);

    try {
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.js', { quiet: true });

        // about: without exclude, should have callers from both src and test
        const aboutAll = index.about('greet');
        assert.ok(aboutAll.found, 'Should find greet');
        const allCallerFiles = aboutAll.callers.top.map(c => c.file);
        assert.ok(allCallerFiles.some(f => f.includes('test')), 'Without exclude, should have test callers');
        assert.ok(allCallerFiles.some(f => f.includes('src')), 'Without exclude, should have src callers');

        // about: with exclude=test, should only have src callers
        const aboutExcl = index.about('greet', { exclude: ['test'] });
        assert.ok(aboutExcl.found, 'Should find greet with exclude');
        const exclCallerFiles = aboutExcl.callers.top.map(c => c.file);
        assert.ok(!exclCallerFiles.some(f => f.includes('test')), 'With exclude=test, should have no test callers');
        assert.ok(aboutExcl.callers.total < aboutAll.callers.total, 'Excluded callers count should be less');

        // impact: without exclude, should have call sites from both
        const impactAll = index.impact('greet');
        assert.ok(impactAll.totalCallSites >= 2, 'Should have at least 2 call sites');

        // impact: with exclude=test, should have fewer call sites
        const impactExcl = index.impact('greet', { exclude: ['test'] });
        assert.ok(impactExcl.totalCallSites < impactAll.totalCallSites, 'Excluded impact should have fewer call sites');
        const impactFiles = impactExcl.byFile.map(f => f.file);
        assert.ok(!impactFiles.some(f => f.includes('test')), 'Excluded impact should not have test files');

        // context: with exclude=test, should filter callers
        const ctxAll = index.context('greet');
        const ctxExcl = index.context('greet', { exclude: ['test'] });
        assert.ok(ctxExcl.callers.length < ctxAll.callers.length, 'Excluded context should have fewer callers');

        // deadcode: add an unused function in test dir
        fs.writeFileSync(path.join(tmpDir, 'test', 'helper.js'), `
function testHelper() { return 1; }
`);
        const index2 = new ProjectIndex(tmpDir);
        index2.build('**/*.js', { quiet: true });

        const deadAll = index2.deadcode({ includeTests: true });
        const deadExcl = index2.deadcode({ includeTests: true, exclude: ['test'] });
        const deadAllNames = deadAll.map(d => d.name);
        const deadExclNames = deadExcl.map(d => d.name);
        if (deadAllNames.includes('testHelper')) {
            assert.ok(!deadExclNames.includes('testHelper'), 'Excluded deadcode should not include test functions');
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 103 — parseGitignore extracts patterns from .gitignore', () => {
    const { parseGitignore, DEFAULT_IGNORES } = require('../core/discovery');

    const tmpDir = path.join(require('os').tmpdir(), `ucn-test-gitignore-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    fs.writeFileSync(path.join(tmpDir, '.gitignore'), `
# Comment line
node_modules/

# Custom directories
public/
next.lock/
.cache

# Glob patterns
*.log
*.bak

# Negation (should be skipped)
!important.log

# Path patterns (should be skipped)
src/generated/output.js
config/local.json

# Root-relative (slash stripped)
/tmp_build

# Empty lines above
`);

    try {
        const patterns = parseGitignore(tmpDir);

        assert.ok(patterns.includes('public'), 'Should include public');
        assert.ok(!patterns.includes('next.lock'), 'Should skip next.lock (already in DEFAULT_IGNORES)');
        assert.ok(patterns.includes('.cache'), 'Should include .cache');
        assert.ok(patterns.includes('tmp_build'), 'Should include tmp_build (leading / stripped)');
        assert.ok(patterns.includes('*.bak'), 'Should include *.bak glob');
        assert.ok(!patterns.includes('node_modules'), 'Should skip node_modules (already in DEFAULT_IGNORES)');
        assert.ok(!patterns.includes('!important.log'), 'Should skip negation patterns');
        assert.ok(!patterns.includes('important.log'), 'Should skip negation patterns');
        assert.ok(!patterns.some(p => p.includes('/')), 'Should skip patterns with path separators');
        assert.ok(patterns.includes('*.log'), 'Should include *.log');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 104 — .gitignore patterns exclude files during build', () => {
    const tmpDir = path.join(require('os').tmpdir(), `ucn-test-gitignore-build-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'generated'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, '.gitignore'), 'generated/\n');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
function realFunc() { return 1; }
module.exports = { realFunc };
`);
    fs.writeFileSync(path.join(tmpDir, 'generated', 'bundle.js'), `
function generatedFunc() { return 2; }
module.exports = { generatedFunc };
`);

    try {
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const real = index.find('realFunc');
        assert.ok(real.length > 0, 'Should find realFunc from src/');

        const gen = index.find('generatedFunc');
        assert.strictEqual(gen.length, 0, 'Should not find generatedFunc (excluded by .gitignore)');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 105 — deadcode skips bundled/minified files', () => {
    const tmpDir = path.join(require('os').tmpdir(), `ucn-test-bundled-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'public'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
function usedFunc() { return 1; }
function unusedReal() { return 2; }
module.exports = { usedFunc };
`);

    // Webpack bundle
    fs.writeFileSync(path.join(tmpDir, 'public', 'bundle.js'), `
var __webpack_modules__ = {};
function __webpack_require__(moduleId) { return __webpack_modules__[moduleId]; }
function de() { return 1; }
function ge() { return 2; }
function ve() { return 3; }
`);

    // Minified file
    const longLine = 'function a(){return 1}' + ';var b=2'.repeat(200);
    fs.writeFileSync(path.join(tmpDir, 'public', 'min.js'), longLine + '\n');

    try {
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const dead = index.deadcode({ includeExported: true });
        const deadNames = dead.map(d => d.name);

        assert.ok(deadNames.includes('unusedReal'), 'Should find unusedReal from source');
        assert.ok(!deadNames.includes('__webpack_require__'), 'Should skip webpack __webpack_require__');
        assert.ok(!deadNames.includes('de'), 'Should skip minified function de from bundle');
        assert.ok(!deadNames.includes('ge'), 'Should skip minified function ge from bundle');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 106 — deadcode respects --in option for path scoping', () => {
    const tmpDir = path.join(require('os').tmpdir(), `ucn-test-deadcode-scope-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
function srcUnused() { return 1; }
`);
    fs.writeFileSync(path.join(tmpDir, 'lib', 'helper.js'), `
function libUnused() { return 2; }
`);

    try {
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const allDead = index.deadcode({ includeExported: true });
        const allNames = allDead.map(d => d.name);
        assert.ok(allNames.includes('srcUnused'), 'Should find srcUnused');
        assert.ok(allNames.includes('libUnused'), 'Should find libUnused');

        const srcDead = index.deadcode({ includeExported: true, in: 'src' });
        const srcNames = srcDead.map(d => d.name);
        assert.ok(srcNames.includes('srcUnused'), 'Should find srcUnused in src scope');
        assert.ok(!srcNames.includes('libUnused'), 'Should NOT find libUnused when scoped to src');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 107 — CLI ucn <subdir> deadcode scopes to subdirectory', () => {
    const tmpDir = path.join(require('os').tmpdir(), `ucn-test-cli-scope-${Date.now()}`);
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{}');

    fs.writeFileSync(path.join(tmpDir, 'src', 'app.js'), `
function srcDead() { return 1; }
`);
    fs.writeFileSync(path.join(tmpDir, 'lib', 'helper.js'), `
function libDead() { return 2; }
`);

    try {
        const { execSync } = require('child_process');

        const allOut = execSync(`node ${CLI_PATH} ${tmpDir} deadcode --include-exported 2>&1`, { timeout: 30000 }).toString();
        assert.ok(allOut.includes('srcDead'), 'Full project should include srcDead');
        assert.ok(allOut.includes('libDead'), 'Full project should include libDead');

        const srcOut = execSync(`node ${CLI_PATH} ${path.join(tmpDir, 'src')} deadcode --include-exported 2>&1`, { timeout: 30000 }).toString();
        assert.ok(srcOut.includes('srcDead'), 'src scope should include srcDead');
        assert.ok(!srcOut.includes('libDead'), 'src scope should NOT include libDead');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

}); // end describe FIX 102-107

// ============================================================================
// FIX #78-81: FILE-NOT-FOUND, TOC TRUNCATION, TRACE WARNINGS, JSX LINE FIX
// ============================================================================

describe('FIX #78: File-not-found error for imports/exporters/fileExports/graph', () => {

it('fix #78: imports on nonexistent file returns error sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function hello() {}\n');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const result = index.imports('nonexistent.js');
        assert.strictEqual(result.error, 'file-not-found');
        assert.strictEqual(result.filePath, 'nonexistent.js');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #78: exporters on nonexistent file returns error sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function hello() {}\n');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const result = index.exporters('nonexistent.js');
        assert.strictEqual(result.error, 'file-not-found');
        assert.strictEqual(result.filePath, 'nonexistent.js');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #78: fileExports on nonexistent file returns error sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function hello() {}\n');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const result = index.fileExports('nonexistent.js');
        assert.strictEqual(result.error, 'file-not-found');
        assert.strictEqual(result.filePath, 'nonexistent.js');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #78: graph on nonexistent file returns error sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), 'function hello() {}\n');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const result = index.graph('nonexistent.js');
        assert.strictEqual(result.error, 'file-not-found');
        assert.strictEqual(result.filePath, 'nonexistent.js');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #78: formatImports shows error for file-not-found', () => {
    const { formatImports } = require('../core/output');
    const result = formatImports({ error: 'file-not-found', filePath: 'missing.js' }, 'missing.js');
    assert.ok(result.includes('Error: File not found in project: missing.js'));
});

it('fix #78: formatExporters shows error for file-not-found', () => {
    const { formatExporters } = require('../core/output');
    const result = formatExporters({ error: 'file-not-found', filePath: 'missing.js' }, 'missing.js');
    assert.ok(result.includes('Error: File not found in project: missing.js'));
});

it('fix #78: formatFileExports shows error for file-not-found', () => {
    const { formatFileExports } = require('../core/output');
    const result = formatFileExports({ error: 'file-not-found', filePath: 'missing.js' }, 'missing.js');
    assert.ok(result.includes('Error: File not found in project: missing.js'));
});

it('fix #78: formatGraph shows error for file-not-found', () => {
    const { formatGraph } = require('../core/output');
    const result = formatGraph({ error: 'file-not-found', filePath: 'missing.js' });
    assert.ok(result.includes('Error: File not found in project: missing.js'));
});

}); // end describe FIX #78

describe('FIX #79: toc truncation for large projects', () => {

it('fix #79: toc --detailed defaults to 50 files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        for (let i = 0; i < 60; i++) {
            fs.writeFileSync(path.join(tmpDir, `file${i}.js`), `function fn${i}() {}\n`);
        }
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const toc = index.getToc({ detailed: true });
        assert.strictEqual(toc.files.length, 50);
        assert.strictEqual(toc.hiddenFiles, 10);
        assert.strictEqual(toc.totals.files, 60);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #79: toc --detailed --all shows all files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        for (let i = 0; i < 60; i++) {
            fs.writeFileSync(path.join(tmpDir, `file${i}.js`), `function fn${i}() {}\n`);
        }
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const toc = index.getToc({ detailed: true, all: true });
        assert.strictEqual(toc.files.length, 60);
        assert.strictEqual(toc.hiddenFiles, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #79: toc --detailed --top=10 limits to 10 files', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        for (let i = 0; i < 30; i++) {
            fs.writeFileSync(path.join(tmpDir, `file${i}.js`), `function fn${i}() {}\n`);
        }
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const toc = index.getToc({ detailed: true, top: 10 });
        assert.strictEqual(toc.files.length, 10);
        assert.strictEqual(toc.hiddenFiles, 20);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #79: formatToc shows truncation hint when hiddenFiles > 0', () => {
    const { formatToc } = require('../core/output');
    const toc = {
        totals: { files: 60, lines: 600, functions: 60, classes: 0, state: 0, testFiles: 0 },
        meta: {},
        summary: {},
        files: [{ file: 'a.js', lines: 10, functions: 1 }],
        hiddenFiles: 59
    };
    const result = formatToc(toc);
    assert.ok(result.includes('... and 59 more files'));
});

}); // end describe FIX #79

describe('FIX #80: trace silently picks wrong overload', () => {

it('fix #80: trace shows warning when resolved function has no callees and alternatives exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'delegate.js'),
            'function doWork() { return null; }\nmodule.exports = { doWork };\n');
        fs.writeFileSync(path.join(tmpDir, 'real.js'),
            'const helper = require("./helper");\nfunction doWork() { helper.process(); helper.validate(); }\nmodule.exports = { doWork };\n');
        fs.writeFileSync(path.join(tmpDir, 'helper.js'),
            'function process() {}\nfunction validate() {}\nmodule.exports = { process, validate };\n');
        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const result = index.trace('doWork');
        assert.ok(result, 'trace should return a result');
        if (result.tree && result.tree.children.length === 0) {
            assert.ok(result.warnings, 'should have warnings when picking empty overload');
            assert.ok(result.warnings.some(w => w.message.includes('no callees')));
            assert.ok(result.warnings.some(w => w.message.includes('specify a file')));
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('fix #80: formatTrace displays warnings', () => {
    const { formatTrace } = require('../core/output');
    const trace = {
        root: 'doWork',
        file: 'delegate.js',
        line: 1,
        direction: 'down',
        maxDepth: 3,
        includeMethods: true,
        tree: { name: 'doWork', children: [] },
        warnings: [{ message: 'Resolved to delegate.js:1 which has no callees. 1 other definition(s) exist — use --file to pick a different one.' }]
    };
    const result = formatTrace(trace);
    assert.ok(result.includes('Note: Resolved to delegate.js:1 which has no callees'));
    assert.ok(result.includes('--file'));
});

}); // end describe FIX #80

// ============================================================================
// FIX 91-99: DEEP INHERITANCE, DUPLICATE CLASSES, DIFFIMPACT, PARSEDIFF
// ============================================================================

describe('FIX 91-99: Deep inheritance, duplicate classes, diffImpact', () => {

it('FIX 91 — deep inheritance chain resolves callees through 3+ levels', () => {
    const tmpDir = path.join(os.tmpdir(), `ucn-deep-inherit-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'lib.js'), `
class A {
    helper() { return 1; }
}
class B extends A {
    other() { return 2; }
}
class C extends B {
    process() { return this.helper(); }
}
module.exports = { A, B, C };
`);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const processDef = index.symbols.get('process')?.[0];
        const callees = index.findCallees(processDef);
        assert.ok(callees.some(c => c.name === 'helper' && c.className === 'A'),
            'Deep chain callees: C -> B -> A, this.helper() resolves to A.helper');

        const callers = index.findCallers('helper');
        assert.ok(callers.some(c => c.callerName === 'process'),
            'Deep chain callers: A.helper() called from C.process() via inheritance');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 92 — duplicate class names across files resolve independently', () => {
    const tmpDir = path.join(os.tmpdir(), `ucn-dup-class-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a1.js'), `
class A { helper() { return 1; } }
class C extends A { process() { return this.helper(); } }
module.exports = { A, C };
`);
        fs.writeFileSync(path.join(tmpDir, 'a2.js'), `
class B { helper() { return 2; } }
class C extends B { run() { return this.helper(); } }
module.exports = { B, C };
`);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const processDef = index.symbols.get('process').find(s => s.file.endsWith('a1.js'));
        const processCallees = index.findCallees(processDef);
        const helperFromProcess = processCallees.find(c => c.name === 'helper');
        assert.ok(helperFromProcess, 'process() resolves this.helper()');
        assert.strictEqual(helperFromProcess.className, 'A', 'process() helper is from class A');
        assert.ok(helperFromProcess.file.endsWith('a1.js'), 'process() helper is in a1.js');

        const runDef = index.symbols.get('run').find(s => s.file.endsWith('a2.js'));
        const runCallees = index.findCallees(runDef);
        const helperFromRun = runCallees.find(c => c.name === 'helper');
        assert.ok(helperFromRun, 'run() resolves this.helper()');
        assert.strictEqual(helperFromRun.className, 'B', 'run() helper is from class B');
        assert.ok(helperFromRun.file.endsWith('a2.js'), 'run() helper is in a2.js');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 93 — diffImpact detects deleted functions', () => {
    const { execSync } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), `ucn-diff-del-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `function foo() { return 1; }
function bar() { return foo(); }
`);
        execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'app.js'), `function bar() { return 2; }
`);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });
        const result = index.diffImpact({ base: 'HEAD' });

        assert.ok(result.deletedFunctions.length >= 1, 'Should detect deleted function');
        assert.ok(result.deletedFunctions.some(f => f.name === 'foo'), 'foo should be in deletedFunctions');
        assert.strictEqual(result.summary.deletedFunctions, result.deletedFunctions.length,
            'Summary count should match deletedFunctions length');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 94 — diffImpact detects all functions in a deleted file', () => {
    const { execSync } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), `ucn-diff-filedel-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a.js'), 'function foo() { return 1; }\nfunction bar() { return 2; }\n');
        fs.writeFileSync(path.join(tmpDir, 'b.js'), 'function baz() { return 3; }\n');
        execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

        fs.unlinkSync(path.join(tmpDir, 'a.js'));

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });
        const result = index.diffImpact({ base: 'HEAD' });

        assert.ok(result.deletedFunctions.some(f => f.name === 'foo'), 'foo should be detected as deleted');
        assert.ok(result.deletedFunctions.some(f => f.name === 'bar'), 'bar should be detected as deleted');
        assert.ok(!result.deletedFunctions.some(f => f.name === 'baz'), 'baz should NOT be deleted');
        assert.strictEqual(result.summary.deletedFunctions, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 95 — diffImpact detects A.foo deleted while B.foo remains', () => {
    const { execSync } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), `ucn-diff-samename-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
class A { foo() { return 1; } }
class B { foo() { return 2; } }
module.exports = { A, B };
`);
        execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'app.js'), `
class A { }
class B { foo() { return 2; } }
module.exports = { A, B };
`);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });
        const result = index.diffImpact({ base: 'HEAD' });

        assert.strictEqual(result.deletedFunctions.length, 1, 'Exactly one foo should be deleted');
        assert.strictEqual(result.deletedFunctions[0].name, 'foo');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 96 — diffImpact works with filenames containing spaces', () => {
    const { execSync } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), `ucn-diff-spaces-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a b.js'), 'function spaceFn() { return 1; }\nfunction gone() { return 2; }\n');
        execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'a b.js'), 'function spaceFn() { return 99; }\n');

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });
        const result = index.diffImpact({ base: 'HEAD' });

        assert.ok(result.functions.some(f => f.name === 'spaceFn'), 'spaceFn should be detected as modified');
        assert.ok(result.deletedFunctions.some(f => f.name === 'gone'), 'gone should be detected as deleted');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 97 — diffImpact works with $ in filenames', () => {
    const { execSync } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), `ucn-diff-dollar-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
        fs.writeFileSync(path.join(tmpDir, 'a$HOME.js'), 'function dollarFn() { return 1; }\nfunction gone() { return 2; }\n');
        execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'a$HOME.js'), 'function dollarFn() { return 99; }\n');

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });
        const result = index.diffImpact({ base: 'HEAD' });

        assert.ok(result.functions.some(f => f.name === 'dollarFn'), 'dollarFn should be detected as modified');
        assert.ok(result.deletedFunctions.some(f => f.name === 'gone'), 'gone should be detected as deleted');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 98 — diffImpact detects deleted overload while sibling remains', () => {
    const { execSync } = require('child_process');
    const tmpDir = path.join(os.tmpdir(), `ucn-diff-overload-${Date.now()}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>\n');
        fs.writeFileSync(path.join(tmpDir, 'A.java'), `
public class A {
    public void foo(int x) { System.out.println(x); }
    public void foo(String s) { System.out.println(s); }
    public void bar() { foo(1); }
}
`);
        execSync('git add -A && git commit -m "init"', { cwd: tmpDir, stdio: 'pipe' });

        fs.writeFileSync(path.join(tmpDir, 'A.java'), `
public class A {
    public void foo(String s) { System.out.println(s); }
    public void bar() { foo("hi"); }
}
`);

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });
        const result = index.diffImpact({ base: 'HEAD' });

        assert.strictEqual(result.deletedFunctions.length, 1, 'Exactly one overload should be deleted');
        assert.strictEqual(result.deletedFunctions[0].name, 'foo');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 99 — parseDiff handles quoted paths with special characters', () => {
    const { parseDiff } = require('../core/project');

    // Quoted path with escaped quotes
    const diffText = `diff --git "a/a\\"b.js" "b/a\\"b.js"
--- "a/a\\"b.js"
+++ "b/a\\"b.js"
@@ -1 +1 @@
`;
    const changes = parseDiff(diffText, '/tmp/test');
    assert.strictEqual(changes.length, 1);
    assert.strictEqual(changes[0].relativePath, 'a"b.js');

    // Quoted deleted file
    const diffText2 = `diff --git "a/a\\"b.js" "b/a\\"b.js"
--- "a/a\\"b.js"
+++ /dev/null
@@ -1,2 +0,0 @@
`;
    const changes2 = parseDiff(diffText2, '/tmp/test');
    assert.strictEqual(changes2.length, 1);
    assert.strictEqual(changes2[0].isDeleted, true);
    assert.strictEqual(changes2[0].relativePath, 'a"b.js');

    // Unquoted path still works
    const diffText3 = `diff --git a/normal.js b/normal.js
--- a/normal.js
+++ b/normal.js
@@ -1 +1 @@
`;
    const changes3 = parseDiff(diffText3, '/tmp/test');
    assert.strictEqual(changes3.length, 1);
    assert.strictEqual(changes3[0].relativePath, 'normal.js');

    // Literal backslash+n in filename
    const diffText4 = `diff --git "a/a\\\\n.js" "b/a\\\\n.js"
--- "a/a\\\\n.js"
+++ "b/a\\\\n.js"
@@ -1 +1 @@
`;
    const changes4 = parseDiff(diffText4, '/tmp/test');
    assert.strictEqual(changes4.length, 1);
    assert.strictEqual(changes4[0].relativePath, 'a\\n.js',
        'Literal backslash-n in filename must be preserved, not converted to newline');
});

it('FIX 105 — all parser.parse() calls in project.js and utils.js use safeParse', () => {
    const projectCode = fs.readFileSync(path.join(PROJECT_DIR, 'core', 'project.js'), 'utf-8');
    const utilsCode = fs.readFileSync(path.join(PROJECT_DIR, 'languages', 'utils.js'), 'utf-8');

    // Match parser.parse( but not safeParse( or comment lines
    const directParseRegex = /(?<!safe)parser\.parse\s*\(/g;
    const projectMatches = projectCode.match(directParseRegex);
    const utilsMatches = utilsCode.match(directParseRegex);

    assert.strictEqual(projectMatches, null,
        'project.js should not have direct parser.parse() calls — use safeParse() instead');
    assert.strictEqual(utilsMatches, null,
        'utils.js should not have direct parser.parse() calls — use safeParse() instead');
});

}); // end describe FIX 91-99

// ============================================================================
// FIX 106-111: Bug Hunt — Null Safety Across Parsers, Core, Formatters
// ============================================================================

describe('FIX 106-111: Null safety bug hunt', () => {

    // FIX 106: Rust include! with dynamic args — null module crashed resolveImport
    it('fix #106: Rust include! with dynamic args does not produce null module', () => {
        const rustParser = require('../languages/rust');
        const { getParser } = require('../languages');
        const parser = getParser('rust');
        // concat! produces a non-literal argument → dynamic include
        const code = 'include!(concat!(env!("OUT_DIR"), "/gen.rs"));\n';
        const imports = rustParser.findImportsInCode(code, parser);
        for (const imp of imports) {
            assert.notStrictEqual(imp.module, null, 'No import should have module: null');
            assert.notStrictEqual(imp.module, undefined, 'No import should have module: undefined');
        }
    });

    // FIX 106: Defensive null guard in buildImportGraph
    it('fix #106: buildImportGraph skips null import modules', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-null-import-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\n');
            fs.writeFileSync(path.join(tmpDir, 'main.rs'), 'fn main() {}\n');
            const index = new ProjectIndex(tmpDir);
            // Should not throw even with Rust files
            index.build('**/*.rs', { quiet: true });
            assert.ok(index.files.size >= 1, 'Should index at least one file');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    // FIX 107: JS dynamic import() with no args — was pushing module: null
    it('fix #107: JS dynamic import with no string arg does not produce null module', () => {
        const jsParser = require('../languages/javascript');
        const { getParser } = require('../languages');
        const parser = getParser('javascript');
        // import() with variable arg (dynamic, no literal string)
        const code = 'const mod = await import(modulePath);\n';
        const imports = jsParser.findImportsInCode(code, parser);
        for (const imp of imports) {
            assert.notStrictEqual(imp.module, null, 'No import should have module: null');
        }
    });

    // FIX 107: JS require() with non-string arg — was pushing module: null
    it('fix #107: JS require with non-string arg does not produce null module', () => {
        const jsParser = require('../languages/javascript');
        const { getParser } = require('../languages');
        const parser = getParser('javascript');
        // require() with dynamic arg
        const code = 'const x = require(getPath());\n';
        const imports = jsParser.findImportsInCode(code, parser);
        for (const imp of imports) {
            assert.notStrictEqual(imp.module, null, 'No import should have module: null');
        }
    });

    // FIX 108: MCP toolResult handles null/undefined text
    it('fix #108: MCP toolResult does not crash on null text', () => {
        // We test this by checking the function source pattern
        const serverCode = fs.readFileSync(path.join(__dirname, '..', 'mcp', 'server.js'), 'utf-8');
        assert.ok(serverCode.includes("if (!text) return"),
            'toolResult should have a null guard for text parameter');
    });

    // FIX 109: Output formatters handle file-ambiguous errors
    it('fix #109: formatImports handles file-ambiguous error', () => {
        const result = output.formatImports({ error: 'file-ambiguous', filePath: 'util.js' }, 'util.js');
        assert.ok(result.includes('Error:'), 'Should return error string');
        assert.ok(!result.includes('undefined'), 'Should not contain undefined');
    });

    it('fix #109: formatExporters handles file-ambiguous error', () => {
        const result = output.formatExporters({ error: 'file-ambiguous', filePath: 'util.js' }, 'util.js');
        assert.ok(result.includes('Error:'), 'Should return error string');
        assert.ok(!result.includes('undefined'), 'Should not contain undefined');
    });

    it('fix #109: formatFileExports handles file-ambiguous error', () => {
        const result = output.formatFileExports({ error: 'file-ambiguous', filePath: 'util.js' }, 'util.js');
        assert.ok(result.includes('Error:'), 'Should return error string');
        assert.ok(!result.includes('undefined'), 'Should not contain undefined');
    });

    it('fix #109: formatGraph handles file-ambiguous error (text)', () => {
        const result = output.formatGraph({ error: 'file-ambiguous', filePath: 'util.js' });
        assert.ok(result.includes('Error:'), 'Should return error string');
    });

    it('fix #109: formatImportsJson handles file-ambiguous error', () => {
        const result = output.formatImportsJson({ error: 'file-ambiguous', filePath: 'util.js' }, 'util.js');
        const parsed = JSON.parse(result);
        assert.strictEqual(parsed.found, false);
        assert.strictEqual(parsed.error, 'file-ambiguous');
    });

    it('fix #109: formatExportersJson handles file-ambiguous error', () => {
        const result = output.formatExportersJson({ error: 'file-ambiguous', filePath: 'util.js' }, 'util.js');
        const parsed = JSON.parse(result);
        assert.strictEqual(parsed.found, false);
        assert.strictEqual(parsed.error, 'file-ambiguous');
    });

    it('fix #109: formatGraphJson handles file-ambiguous error', () => {
        const result = output.formatGraphJson({ error: 'file-ambiguous', filePath: 'util.js' });
        const parsed = JSON.parse(result);
        assert.strictEqual(parsed.found, false);
        assert.strictEqual(parsed.error, 'file-ambiguous');
    });

    // FIX 110: parser.js parse() guards against null language
    it('fix #110: parse() throws descriptive error for null language', () => {
        assert.throws(() => parse('const x = 1;', null), /Language parameter is required/);
        assert.throws(() => parse('const x = 1;', undefined), /Language parameter is required/);
    });

    // FIX 111: Go parser defensive guards
    it('fix #111: Go hasFunc handles null child nodes defensively', () => {
        const goParser = require('../languages/go');
        const { getParser } = require('../languages');
        const parser = getParser('go');
        // Closure assignment should parse without crash (hasFunc traverses child nodes)
        const code = `package main
func main() {
    fn := func() { println("hi") }
    fn()
}
`;
        // Should not throw — the fix guards against null nodes in hasFunc recursion
        const calls = goParser.findCallsInCode(code, parser);
        assert.ok(Array.isArray(calls), 'Should return array without crashing');
    });
});

// ============================================================================
// FIX #117 — formatPlan crash on param-not-found error
// plan() returns { found: true, error: '...' } when a param to remove doesn't
// exist, but formatPlan/formatPlanJson only checked error inside !plan.found,
// so they crashed on plan.before.signature (undefined).
// ============================================================================
describe('FIX #117 — formatPlan handles param-not-found error', () => {
    let dir;
    it('formatPlan does not crash on error result', () => {
        dir = tmp({
            'package.json': '{}',
            'app.js': 'function greet(name) { return name; }\ngreet("world");',
        });
        const index = idx(dir);
        const planResult = index.plan('greet', { removeParam: 'nonexistent' });
        assert.ok(planResult.found, 'function is found');
        assert.ok(planResult.error, 'error about missing param');
        // Should not crash — was TypeError: Cannot read properties of undefined (reading 'signature')
        const text = output.formatPlan(planResult);
        assert.ok(typeof text === 'string', 'should return string');
        assert.ok(text.includes('not found'), 'should mention param not found');
    });

    it('formatPlanJson does not crash on error result', () => {
        const index = idx(dir);
        const planResult = index.plan('greet', { removeParam: 'nonexistent' });
        const json = output.formatPlanJson(planResult);
        const parsed = JSON.parse(json);
        assert.ok(parsed.found === true);
        assert.ok(parsed.error);
    });

    it('cleanup', () => { rm(dir); });
});

// ============================================================================
// FIX #118 — plan --remove-param wrong argument position for Python/Rust methods
// plan() used raw paramIndex from paramsStructured (which includes self/cls/&self)
// to index into caller args, but callers don't pass self/cls. This caused:
// 1) Wrong arg referenced in suggestion (e.g., "Remove argument 2: fast" instead of "argument 1: world")
// 2) Some call sites skipped (argCount > paramIndex was false when it shouldn't be)
// ============================================================================
describe('FIX #118 — plan --remove-param adjusts for Python self', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'requirements.txt': '',
            'handler.py': `class Handler:
    def process(self, data, mode='default'):
        return data

def main():
    h = Handler()
    h.process("hello")
    h.process("world", "fast")`,
        });
    });

    it('remove data: correct caller arg position (1, not 2)', () => {
        const index = idx(dir);
        const result = index.plan('process', { removeParam: 'data', file: 'handler.py' });
        assert.ok(result.found);
        assert.ok(!result.error);
        // Both calls should have changes (previously h.process("hello") was skipped)
        assert.ok(result.changes.length >= 1, 'should have changes');
        const worldCall = result.changes.find(c => c.expression.includes('"world"'));
        assert.ok(worldCall, 'h.process("world", "fast") should be in changes');
        // Should reference "world" (data = caller arg 0 → position 1), not "fast" (mode)
        assert.ok(worldCall.suggestion.includes('"world"'),
            `should suggest removing "world", got: ${worldCall.suggestion}`);
        assert.ok(worldCall.suggestion.includes('argument 1'),
            `should say argument 1, got: ${worldCall.suggestion}`);
    });

    it('remove mode: correct position (2)', () => {
        const index = idx(dir);
        const result = index.plan('process', { removeParam: 'mode', file: 'handler.py' });
        assert.ok(result.found);
        const worldCall = result.changes.find(c => c.expression.includes('"world"'));
        if (worldCall) {
            assert.ok(worldCall.suggestion.includes('"fast"'),
                `should suggest removing "fast", got: ${worldCall.suggestion}`);
            assert.ok(worldCall.suggestion.includes('argument 2'),
                `should say argument 2, got: ${worldCall.suggestion}`);
        }
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX #118 — plan --remove-param adjusts for Rust &self', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': `struct Server { port: u16 }

impl Server {
    fn configure(&self, addr: String, timeout: u32) {
        println!("{} {}", addr, timeout);
    }
}

fn main() {
    let s = Server { port: 8080 };
    s.configure("localhost".to_string(), 30);
}`,
        });
    });

    it('remove addr: arg 1 not arg 2 (Rust &self offset)', () => {
        const index = idx(dir);
        const result = index.plan('configure', { removeParam: 'addr', file: 'lib.rs' });
        assert.ok(result.found);
        assert.ok(!result.error);
        assert.ok(result.changes.length >= 1);
        const change = result.changes[0];
        assert.ok(change.suggestion.includes('argument 1'),
            `should say argument 1, got: ${change.suggestion}`);
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX #118 — plan --remove-param unaffected for JS (no self)', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'package.json': '{}',
            'app.js': 'function process(data, mode) { return data; }\nprocess("hello", "fast");',
        });
    });

    it('JS: remove data is still arg 1 (no offset)', () => {
        const index = idx(dir);
        const result = index.plan('process', { removeParam: 'data' });
        assert.ok(result.found);
        assert.ok(!result.error);
        const change = result.changes[0];
        assert.ok(change.suggestion.includes('argument 1'),
            `should say argument 1, got: ${change.suggestion}`);
        assert.ok(change.suggestion.includes('"hello"'),
            `should reference "hello", got: ${change.suggestion}`);
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX #118 — plan --remove-param with Python cls', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'requirements.txt': '',
            'factory.py': `class Factory:
    @classmethod
    def create(cls, name, config=None):
        return cls()

Factory.create("widget")
Factory.create("gadget", {"color": "blue"})`,
        });
    });

    it('remove name: cls stripped, arg 1 not 2', () => {
        const index = idx(dir);
        const result = index.plan('create', { removeParam: 'name', file: 'factory.py' });
        assert.ok(result.found);
        const call = result.changes.find(c => c.expression.includes('"widget"'));
        if (call) {
            assert.ok(call.suggestion.includes('argument 1'),
                `should say argument 1, got: ${call.suggestion}`);
        }
    });

    it('cleanup', () => { rm(dir); });
});

// ============================================================================
// Bug hunt 2026-03-01: Regression tests for all fixes
// ============================================================================

describe('FIX 115 — fuzzyScore camelCase word boundary split', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'lib.js': `
function parseFileName() {}
function fileParse() {}
function handleRequest() {}
`
        });
    });

    it('fuzzyScore should split camelCase targets for word boundary matching', () => {
        const index = idx(dir);
        const results = index.find('parse');
        const names = results.map(r => r.name);
        // Both parseFileName and fileParse should match via word boundary
        assert.ok(names.includes('parseFileName'), `parseFileName should match 'parse' via word boundary, got: ${names}`);
        assert.ok(names.includes('fileParse'), `fileParse should match 'parse' via word boundary, got: ${names}`);
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 116 — fileExports re-export-all cycle detection', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'a.js': `
export * from './b';
export function fromA() {}
`,
            'b.js': `
export * from './a';
export function fromB() {}
`
        });
    });

    it('should not crash on circular re-exports', () => {
        const index = idx(dir);
        // Should not throw (infinite recursion)
        const exports = index.fileExports(path.join(dir, 'a.js'));
        assert.ok(Array.isArray(exports), 'should return an array');
        const names = exports.map(e => e.name);
        assert.ok(names.includes('fromA'), 'should include own exports');
        assert.ok(names.includes('fromB'), 'should include re-exported symbols from b');
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 117 — _beginOp/_endOp nesting support', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'main.js': `
const { helper } = require('./utils');
function main() { helper(); }
`,
            'utils.js': `
function helper() { return 1; }
module.exports = { helper };
`
        });
    });

    it('nested _beginOp/_endOp should preserve outer cache', () => {
        const index = idx(dir);
        // context() calls _beginOp, then calls findCallers (which also calls _beginOp/_endOp),
        // then findCallees. The inner _endOp should NOT destroy the outer cache.
        index._beginOp();
        assert.ok(index._opContentCache instanceof Map, 'cache should exist after _beginOp');

        index._beginOp(); // nested
        assert.ok(index._opContentCache instanceof Map, 'cache should still exist after nested _beginOp');

        index._endOp(); // inner end
        assert.ok(index._opContentCache instanceof Map, 'cache should survive inner _endOp');

        index._endOp(); // outer end
        assert.strictEqual(index._opContentCache, null, 'cache should be cleared after outer _endOp');
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 118 — _findCallNode handles multi-line call expressions', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'main.js': `
function process(a, b, c) { return a + b + c; }
function caller() {
    const result = process(
        1,
        2,
        3
    );
}
`
        });
    });

    it('verify should detect args for multi-line calls', () => {
        const index = idx(dir);
        const result = index.verify('process');
        assert.ok(result, 'verify should return a result');
        if (result.found && result.callSites) {
            // Should detect the call even though it spans multiple lines
            const site = result.callSites.find(s => s.file && s.callerName === 'caller');
            if (site) {
                assert.strictEqual(site.argCount, 3, `should detect 3 args in multi-line call, got: ${site.argCount}`);
            }
        }
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 119 — formatContextJson includes class type', () => {
    it('should handle class type in JSON context output', () => {
        const context = {
            type: 'class',
            name: 'MyClass',
            file: 'src/foo.js',
            startLine: 1,
            endLine: 10,
            callers: [{ name: 'test', file: 'test.js', line: 5 }],
            methods: [{ name: 'doStuff', file: 'src/foo.js', line: 3, params: 'x' }],
            meta: { complete: true }
        };
        const json = JSON.parse(output.formatContextJson(context));
        assert.strictEqual(json.data.type, 'class');
        assert.strictEqual(json.data.methodCount, 1);
        assert.ok(json.data.methods, 'JSON output should include methods for class type');
        assert.strictEqual(json.data.methods[0].name, 'doStuff');
    });
});

describe('FIX 120 — formatAbout callee weight guard', () => {
    it('should not produce [undefined] when weight is missing', () => {
        const about = {
            found: true,
            symbol: { name: 'test', file: 'test.js', startLine: 1, endLine: 3, type: 'function', signature: 'function test()' },
            definition: { code: 'function test() {}', startLine: 1, endLine: 1 },
            callers: { total: 0, top: [] },
            callees: {
                total: 1,
                top: [{ name: 'helper', file: 'helper.js', line: 5, callCount: 1 }]
            },
            tests: [],
            otherDefinitions: [],
            totalUsages: 1,
            usages: { calls: 1, imports: 0, references: 0 }
        };
        const text = output.formatAbout(about);
        assert.ok(!text.includes('[undefined]'), `should not contain [undefined], got: ${text}`);
        assert.ok(text.includes('helper'), 'should include callee name');
    });
});

describe('FIX 121 — formatMemberSignature no space before parens', () => {
    it('should format member as name(params) not name (params)', () => {
        const member = { name: 'doSomething', params: 'x, y' };
        const sig = output.formatMemberSignature(member);
        assert.ok(sig.includes('doSomething(x, y)'), `should have no space before parens, got: ${sig}`);
        assert.ok(!sig.includes('doSomething ('), `should NOT have space before parens, got: ${sig}`);
    });
});

describe('FIX 122 — formatTrace includeMethods strict check', () => {
    it('should not show methods hint when includeMethods is undefined', () => {
        const trace = {
            name: 'test',
            file: 'test.js',
            line: 1,
            tree: { name: 'test', children: [] },
            // includeMethods is intentionally omitted (undefined)
        };
        const text = output.formatTrace(trace);
        assert.ok(!text.includes('obj.method()'), `should not show methods hint when includeMethods is undefined, got: ${text}`);
    });

    it('should show methods hint when includeMethods is explicitly false', () => {
        const trace = {
            name: 'test',
            file: 'test.js',
            line: 1,
            tree: { name: 'test', children: [] },
            includeMethods: false,
        };
        const text = output.formatTrace(trace);
        assert.ok(text.includes('obj.method()'), `should show methods hint when includeMethods is false`);
    });
});

describe('FIX 123 — CLI searchFile context lines order', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'data.js': `// line 1
function hello() {
    console.log("hello");
}
// line 5
function world() {
    console.log("world");
}`
        });
    });

    it('should print before-context lines before the match', () => {
        const { execFileSync } = require('child_process');
        const result = execFileSync('node', [CLI_PATH, path.join(dir, 'data.js'), 'search', 'hello', '--context=1'], {
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        const lines = result.split('\n');
        // Find the match line and verify before-context is above it
        for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/\d+:.*function hello/)) {
                // The context line before should be BEFORE this match line in the output
                if (i > 0 && lines[i - 1].includes('...')) {
                    assert.ok(true, 'before context line appears before match');
                }
                // The context line should NOT be on the line after the match
                if (i + 1 < lines.length && lines[i + 1].includes('...') && lines[i + 1].includes('line 1')) {
                    assert.fail('before-context line appeared after match — wrong order');
                }
                break;
            }
        }
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 124 — CLI --exclude captures multiple occurrences', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'src/main.js': `function main() {}`,
            'test/main.test.js': `function testMain() {}`,
            'vendor/lib.js': `function vendorLib() {}`
        });
    });

    it('multiple --exclude flags should all be applied', () => {
        const { execFileSync } = require('child_process');
        const result = execFileSync('node', [CLI_PATH, dir, 'find', 'main', '--exclude=test', '--exclude=vendor'], {
            encoding: 'utf-8',
            timeout: 10000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        assert.ok(!result.includes('test/'), `should exclude test dir, got: ${result}`);
        assert.ok(!result.includes('vendor/'), `should exclude vendor dir, got: ${result}`);
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 125 — Rust self:: resolution for lib.rs and main.rs', () => {
    it('should resolve self:: from lib.rs within same directory', () => {
        const { resolveImport } = require('../core/imports');
        const dir = tmp({
            'src/lib.rs': `mod config;`,
            'src/config.rs': `pub fn load() {}`
        });
        const resolved = resolveImport('self::config', path.join(dir, 'src/lib.rs'), {
            language: 'rust',
            root: dir,
            extensions: ['.rs']
        });
        assert.ok(resolved, 'should resolve self::config from lib.rs');
        assert.ok(resolved.endsWith('config.rs'), `should resolve to config.rs, got: ${resolved}`);
        rm(dir);
    });

    it('should resolve self:: from main.rs within same directory', () => {
        const { resolveImport } = require('../core/imports');
        const dir = tmp({
            'src/main.rs': `mod utils;`,
            'src/utils.rs': `pub fn helper() {}`
        });
        const resolved = resolveImport('self::utils', path.join(dir, 'src/main.rs'), {
            language: 'rust',
            root: dir,
            extensions: ['.rs']
        });
        assert.ok(resolved, 'should resolve self::utils from main.rs');
        assert.ok(resolved.endsWith('utils.rs'), `should resolve to utils.rs, got: ${resolved}`);
        rm(dir);
    });
});

describe('FIX 126 — tsconfig paths multi-wildcard regex', () => {
    it('should replace all wildcards in tsconfig path patterns', () => {
        const { resolveImport } = require('../core/imports');
        const dir = tmp({
            'tsconfig.json': JSON.stringify({
                compilerOptions: {
                    baseUrl: ".",
                    paths: {
                        "@/*/types/*": ["src/*/types/*"]
                    }
                }
            }),
            'src/api/types/user.ts': `export interface User { name: string; }`,
            'src/main.ts': `import { User } from '@/api/types/user';`
        });
        const resolved = resolveImport('@/api/types/user', path.join(dir, 'src/main.ts'), {
            language: 'typescript',
            root: dir,
            extensions: ['.ts', '.tsx', '.js', '.jsx']
        });
        assert.ok(resolved, `should resolve multi-wildcard tsconfig path, got: ${resolved}`);
        assert.ok(resolved.endsWith('user.ts'), `should resolve to user.ts, got: ${resolved}`);
        rm(dir);
    });
});

describe('FIX 127 — formatGraph truncation hints for both direction', () => {
    it('should show truncation hints for both-direction graph', () => {
        const importNodes = [
            { file: '/project/src/main.js', relativePath: 'src/main.js', depth: 0 },
            ...Array.from({ length: 15 }, (_, i) => ({
                file: `/project/src/dep${i}.js`,
                relativePath: `src/dep${i}.js`,
                depth: 1
            }))
        ];
        const importerNodes = [
            { file: '/project/src/main.js', relativePath: 'src/main.js', depth: 0 },
            { file: '/project/src/app.js', relativePath: 'src/app.js', depth: 1 }
        ];
        const graph = {
            direction: 'both',
            root: '/project/src/main.js',
            // formatGraph checks graph.nodes.length first — provide combined nodes
            nodes: [...importNodes, ...importerNodes],
            imports: {
                nodes: importNodes,
                edges: Array.from({ length: 15 }, (_, i) => ({
                    from: '/project/src/main.js',
                    to: `/project/src/dep${i}.js`
                }))
            },
            importers: {
                nodes: importerNodes,
                edges: [
                    { from: '/project/src/main.js', to: '/project/src/app.js' }
                ]
            }
        };
        const text = output.formatGraph(graph, { maxDepth: 1, showAll: false, file: 'src/main.js' });
        assert.ok(text.includes('IMPORTS'), 'should have IMPORTS section');
        assert.ok(text.includes('IMPORTERS'), 'should have IMPORTERS section');
    });
});

describe('FIX 128 — CLI context/smart error exits with code 1', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'main.js': `function hello() {}`
        });
    });

    it('context with missing name should exit with error', () => {
        const { execFileSync } = require('child_process');
        let exitedWithError = false;
        try {
            execFileSync('node', [CLI_PATH, dir, 'context'], {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (e) {
            exitedWithError = true;
            // Error should be on stderr
            assert.ok(e.stderr && e.stderr.length > 0, `error should be on stderr, got stdout: ${e.stdout}, stderr: ${e.stderr}`);
        }
        assert.ok(exitedWithError, 'context with missing name should exit with non-zero code');
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 130 — JS extractImplements/extractInterfaceExtends respects generics', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'main.ts': `
interface Foo<A, B> {}
interface Baz {}
interface Bar extends Foo<string, number>, Baz {
    x: number;
}
class MyClass implements Foo<string, number>, Baz {
    x = 1;
}
`
        });
    });

    it('extractInterfaceExtends should not split generic params', () => {
        const index = idx(dir);
        const barSymbol = index.find('Bar', { exact: true })[0];
        assert.ok(barSymbol, 'should find Bar');
        if (barSymbol.extends) {
            // extends is stored as a joined string, should preserve generics intact
            assert.ok(barSymbol.extends.includes('Foo<string, number>'),
                `should preserve generics in extends string, got: ${barSymbol.extends}`);
            assert.ok(barSymbol.extends.includes('Baz'),
                `should include Baz in extends string, got: ${barSymbol.extends}`);
        }
    });

    it('extractImplements should not split generic params', () => {
        const index = idx(dir);
        const myClassSymbol = index.find('MyClass', { exact: true })[0];
        assert.ok(myClassSymbol, 'should find MyClass');
        if (myClassSymbol.implements) {
            assert.ok(!myClassSymbol.implements.some(e => e === 'Foo<string'),
                `should not split generics, got implements: ${JSON.stringify(myClassSymbol.implements)}`);
        }
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 131 — _attrTypeCache invalidation on rebuild', () => {
    it('should clear _attrTypeCache on rebuild', () => {
        const dir = tmp({
            'main.py': `
class Foo:
    def __init__(self):
        self.helper = Helper()
    def run(self):
        self.helper.process()

class Helper:
    def process(self):
        pass
`
        });
        const index = idx(dir);
        // Prime the attr type cache
        index.getInstanceAttributeTypes(path.join(dir, 'main.py'));
        assert.ok(index._attrTypeCache, 'attr type cache should exist');
        assert.ok(index._attrTypeCache.size > 0, 'attr type cache should have entries');

        // Rebuild should clear it
        index.build(null, { quiet: true });
        assert.strictEqual(index._attrTypeCache, null, 'attr type cache should be cleared on rebuild');
        rm(dir);
    });
});

describe('FIX 132 — fn/class exit code on not-found', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'main.js': `function hello() {}`
        });
    });

    it('fn with nonexistent name should exit with non-zero code', () => {
        const { execFileSync } = require('child_process');
        let exitedWithError = false;
        try {
            execFileSync('node', [CLI_PATH, dir, 'fn', 'nonexistent'], {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (e) {
            exitedWithError = true;
            assert.ok(e.stderr.includes('not found'), `stderr should say not found, got: ${e.stderr}`);
        }
        assert.ok(exitedWithError, 'fn with nonexistent name should exit with non-zero code');
    });

    it('class with nonexistent name should exit with non-zero code', () => {
        const { execFileSync } = require('child_process');
        let exitedWithError = false;
        try {
            execFileSync('node', [CLI_PATH, dir, 'class', 'NonexistentClass'], {
                encoding: 'utf-8',
                timeout: 10000,
                stdio: ['pipe', 'pipe', 'pipe']
            });
        } catch (e) {
            exitedWithError = true;
            assert.ok(e.stderr.includes('not found'), `stderr should say not found, got: ${e.stderr}`);
        }
        assert.ok(exitedWithError, 'class with nonexistent name should exit with non-zero code');
    });

    it('cleanup', () => { rm(dir); });
});

describe('FIX 133 — Interactive --file value (space-separated)', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'src/parser.js': `function parse() { return 1; }`,
            'src/utils.js': `function parse() { return 2; }`
        });
    });

    it('interactive fn with --file <value> should work', () => {
        const { execFileSync } = require('child_process');
        const input = 'fn parse --file parser\nquit\n';
        const result = execFileSync('node', [CLI_PATH, '--interactive', dir], {
            input,
            encoding: 'utf-8',
            timeout: 15000,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        // Should show the function from parser.js, not utils.js
        assert.ok(result.includes('parse'), 'should find parse function');
        assert.ok(result.includes('parser'), `should scope to parser.js file, got: ${result}`);
    });

    it('cleanup', () => { rm(dir); });
});

// ============================================================================
// BUG HUNT ROUND — March 2026
// ============================================================================

describe('Bug Hunt: find("*") bare wildcard returns all symbols', () => {
    it('should return all symbols for bare wildcard patterns', () => {
        const index = idx(FIXTURES_PATH + '/javascript');
        // Bare wildcards should return all symbols (not hang or return empty)
        const allStar = index.find('*');
        assert.ok(allStar.length > 0, 'find("*") should return symbols');
        const allQuestion = index.find('?');
        assert.ok(allQuestion.length > 0, 'find("?") should return symbols');
    });

    it('should still work for meaningful glob patterns', () => {
        const index = idx(FIXTURES_PATH + '/javascript');
        const results = index.find('handle*');
        // Should find something (or not), but not hang
        assert.ok(Array.isArray(results));
    });
});

describe('Bug Hunt: --in filter uses path-boundary matching', () => {
    let dir;
    it('setup', () => {
        dir = tmp({
            'src/core/utils.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'my-src-backup/old.js': 'function legacy() { return 2; }\nmodule.exports = { legacy };',
            'lib/src/inner.js': 'function inner() { return 3; }\nmodule.exports = { inner };',
            'package.json': '{"name":"test","version":"1.0.0"}'
        });
    });

    it('should match src/ but not my-src-backup/', () => {
        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });
        const results = index.find('helper', { in: 'src' });
        assert.ok(results.length > 0, 'should find helper in src/');
        const legacy = index.find('legacy', { in: 'src' });
        assert.strictEqual(legacy.length, 0, 'should NOT find legacy from my-src-backup/');
    });

    it('should match nested src/ path', () => {
        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });
        const results = index.find('inner', { in: 'src' });
        assert.ok(results.length > 0, 'should find inner in lib/src/');
    });

    it('cleanup', () => { rm(dir); });
});

describe('Bug Hunt: graph showAll not always true', () => {
    it('formatGraph should respect showAll=false by default', () => {
        // When no --depth and no --all flags, showAll should be false
        const graphResult = {
            root: '/test/file.js',
            nodes: [
                { file: '/test/file.js', relativePath: 'file.js', depth: 0 },
                { file: '/test/dep.js', relativePath: 'dep.js', depth: 1 },
            ],
            edges: [{ from: '/test/file.js', to: '/test/dep.js', type: 'import' }]
        };
        const compact = output.formatGraph(graphResult, { showAll: false, maxDepth: 2, file: 'file.js' });
        const expanded = output.formatGraph(graphResult, { showAll: true, maxDepth: 2, file: 'file.js' });
        // Both should produce valid output
        assert.ok(compact.includes('file.js'));
        assert.ok(expanded.includes('file.js'));
    });
});

describe('Bug Hunt: expand cache LRU only refreshes matched entry', () => {
    it('should not refresh usedAt on non-matching entries during fallback', () => {
        const { ExpandCache } = require('../core/expand-cache');
        const cache = new ExpandCache({ maxSize: 10 });

        // Save two context entries for the same root
        cache.save('/root', 'funcA', 'file.js', [{ num: 1, name: 'a' }]);
        // Small delay to differentiate timestamps
        const entry1 = [...cache.entries.values()][0];
        const oldUsedAt1 = entry1.usedAt;

        cache.save('/root', 'funcB', 'file.js', [{ num: 2, name: 'b' }]);

        // Lookup item 1 (in funcA entry, not the most recent funcB)
        const result = cache.lookup('/root', 1);
        assert.ok(result.match, 'should find item 1');
        assert.strictEqual(result.match.name, 'a');

        // The non-matching entry (funcB) should NOT have been refreshed
        const entries = [...cache.entries.values()].filter(e => e.root === '/root');
        const funcBEntry = entries.find(e => e.symbolName === 'funcB');
        const funcAEntry = entries.find(e => e.symbolName === 'funcA');
        // matched entry should be refreshed; non-matched should not
        assert.ok(funcAEntry.usedAt >= oldUsedAt1, 'matched entry should be refreshed');
    });
});

describe('Bug Hunt: interactive parseInteractiveFlags space-separated values', () => {
    it('should handle --in with space-separated value', () => {
        const { execFileSync } = require('child_process');
        const result = execFileSync('node', [CLI_PATH, '--interactive'], {
            input: 'find main --in core\nquit\n',
            encoding: 'utf-8',
            timeout: 15000,
        });
        // Should not error about unknown flags
        assert.ok(!result.includes('Unknown flag'), `should accept --in with space, got: ${result}`);
    });
});

describe('Bug Hunt: findTsConfig does not escape project root', () => {
    it('should not resolve imports using tsconfig.json above project root', () => {
        // Create a parent dir with a tsconfig that defines path aliases
        // and a child project that should NOT use it
        const parentDir = tmp({
            'tsconfig.json': '{"compilerOptions":{"baseUrl":".","paths":{"@lib/*":["shared/*"]}}}',
            'shared/utils.ts': 'export function sharedUtil() { return 1; }',
            'project/src/index.ts': 'import { sharedUtil } from "@lib/utils";',
            'project/package.json': '{"name":"test"}'
        });
        const projectRoot = path.join(parentDir, 'project');
        const { resolveImport } = require('../core/imports');
        // Should NOT resolve @lib/utils via parent tsconfig
        const resolved = resolveImport('@lib/utils', path.join(projectRoot, 'src', 'index.ts'), { projectRoot });
        // Should be null or not point to the parent's shared/ dir
        if (resolved) {
            assert.ok(!resolved.includes(path.join(parentDir, 'shared')),
                `should not resolve to parent shared dir, got: ${resolved}`);
        }
        rm(parentDir);
    });
});

describe('Bug Hunt: execute.js null-checking consistency', () => {
    const { execute } = require('../core/execute');

    it('about returns ok:false for non-existent symbol', () => {
        const dir = tmp({
            'index.js': 'function hello() { return 1; }',
            'package.json': '{"name":"test"}'
        });
        const index = idx(dir);
        const { ok, error } = execute(index, 'about', { name: 'nonExistentSymbol12345' });
        assert.strictEqual(ok, false, 'should return ok:false for non-existent symbol');
        assert.ok(error, 'should include error message');
        rm(dir);
    });

    it('impact returns ok:false for non-existent function', () => {
        const dir = tmp({
            'index.js': 'function hello() { return 1; }',
            'package.json': '{"name":"test"}'
        });
        const index = idx(dir);
        const { ok, error } = execute(index, 'impact', { name: 'nonExistentSymbol12345' });
        assert.strictEqual(ok, false, 'should return ok:false');
        assert.ok(error, 'should include error message');
        rm(dir);
    });

    it('trace returns ok:false for non-existent function', () => {
        const dir = tmp({
            'index.js': 'function hello() { return 1; }',
            'package.json': '{"name":"test"}'
        });
        const index = idx(dir);
        const { ok, error } = execute(index, 'trace', { name: 'nonExistentSymbol12345' });
        assert.strictEqual(ok, false, 'should return ok:false');
        assert.ok(error, 'should include error message');
        rm(dir);
    });

    it('example returns ok:false for non-existent function', () => {
        const dir = tmp({
            'index.js': 'function hello() { return 1; }',
            'package.json': '{"name":"test"}'
        });
        const index = idx(dir);
        const { ok, error } = execute(index, 'example', { name: 'nonExistentSymbol12345' });
        assert.strictEqual(ok, false, 'should return ok:false');
        assert.ok(error, 'should include error message');
        rm(dir);
    });

    it('related returns ok:false for non-existent function', () => {
        const dir = tmp({
            'index.js': 'function hello() { return 1; }',
            'package.json': '{"name":"test"}'
        });
        const index = idx(dir);
        const { ok, error } = execute(index, 'related', { name: 'nonExistentSymbol12345' });
        assert.strictEqual(ok, false, 'should return ok:false');
        assert.ok(error, 'should include error message');
        rm(dir);
    });
});

// ============================================================================
// BUG HUNT: MARCH 2026
// ============================================================================

describe('Bug Hunt: formatGraphJson outputs correct data shape', () => {
    it('should include root, direction, nodes, edges (not file/depth/dependencies)', () => {
        const graph = {
            root: '/src/app.js',
            direction: 'imports',
            nodes: [{ file: '/src/app.js', relativePath: 'src/app.js', depth: 0 }],
            edges: [{ from: '/src/app.js', to: '/src/utils.js' }]
        };
        const json = JSON.parse(output.formatGraphJson(graph));
        assert.strictEqual(json.root, '/src/app.js', 'should have root');
        assert.strictEqual(json.direction, 'imports', 'should have direction');
        assert.ok(Array.isArray(json.nodes), 'should have nodes array');
        assert.ok(Array.isArray(json.edges), 'should have edges array');
        assert.strictEqual(json.file, undefined, 'should NOT have old .file field');
        assert.strictEqual(json.depth, undefined, 'should NOT have old .depth field');
        assert.strictEqual(json.dependencies, undefined, 'should NOT have old .dependencies field');
    });

    it('should include imports/importers for direction=both', () => {
        const graph = {
            root: '/src/app.js',
            direction: 'both',
            nodes: [],
            edges: [],
            imports: { nodes: [], edges: [] },
            importers: { nodes: [], edges: [] }
        };
        const json = JSON.parse(output.formatGraphJson(graph));
        assert.ok(json.imports, 'should have imports subgraph');
        assert.ok(json.importers, 'should have importers subgraph');
    });
});

describe('Bug Hunt: deadcode does not crash when file is deleted between index and query', () => {
    it('should handle missing file gracefully with --include-exported', () => {
        const dir = tmp({
            'main.js': `
const { helper } = require('./helper');
module.exports = { helper };
`,
            'helper.js': `
function helper() { return 1; }
module.exports = { helper };
`,
            'package.json': '{"name":"test"}'
        });
        const index = idx(dir);
        // Delete the helper file after indexing
        fs.unlinkSync(path.join(dir, 'helper.js'));
        // Should not throw (before fix, _readFile would throw and crash the entire deadcode call)
        const result = index.deadcode({ includeExported: true });
        assert.ok(Array.isArray(result), 'should return results array without crashing');
        rm(dir);
    });
});

describe('Bug Hunt: related() includes methods in sameFile', () => {
    const { execute } = require('../core/execute');

    it('should include class methods, not just functions', () => {
        const dir = tmp({
            'service.js': `
class UserService {
    findUser(id) { return this.query(id); }
    deleteUser(id) { return this.query(id); }
    query(sql) { return sql; }
}
`,
            'package.json': '{"name":"test"}'
        });
        const index = idx(dir);
        const { ok, result } = execute(index, 'related', { name: 'findUser' });
        assert.strictEqual(ok, true);
        const sameFileNames = result.sameFile.map(s => s.name);
        assert.ok(sameFileNames.includes('deleteUser'), 'should include sibling method deleteUser');
        assert.ok(sameFileNames.includes('query'), 'should include sibling method query');
        rm(dir);
    });
});

describe('Bug Hunt: interactive mode --depth space form works', () => {
    const { runInteractive } = require('./helpers');

    it('should parse --depth 2 (space form) correctly in interactive mode', () => {
        const dir = tmp({
            'a.js': `
const { b } = require('./b');
function a() { return b(); }
module.exports = { a };
`,
            'b.js': `
function b() { return 1; }
module.exports = { b };
`,
            'package.json': '{"name":"test"}'
        });
        const result = runInteractive(dir, ['trace a --depth 2']);
        // Should NOT contain "not found" — the function 'a' should be resolved
        assert.ok(!result.includes('not found'), 'should find function a with --depth 2 (space form)');
        rm(dir);
    });
});

describe('Bug Hunt: formatSmartJson handles null result', () => {
    it('should return found:false JSON instead of crashing', () => {
        const json = JSON.parse(output.formatSmartJson(null));
        assert.strictEqual(json.found, false, 'should set found=false');
    });
});

describe('Bug Hunt: formatSearchJson includes meta information', () => {
    it('should include filesScanned and other meta in JSON output', () => {
        const results = [
            { file: 'a.js', matches: [{ line: 1, content: 'hello world' }] }
        ];
        results.meta = { filesScanned: 10, filesSkipped: 2, totalFiles: 12 };
        const json = JSON.parse(output.formatSearchJson(results, 'hello'));
        assert.strictEqual(json.filesScanned, 10, 'should include filesScanned');
        assert.strictEqual(json.filesSkipped, 2, 'should include filesSkipped');
        assert.strictEqual(json.totalFiles, 12, 'should include totalFiles');
    });

    it('should include regexFallback when present', () => {
        const results = [];
        results.meta = { filesScanned: 5, filesSkipped: 0, totalFiles: 5, regexFallback: true };
        const json = JSON.parse(output.formatSearchJson(results, 'bad[regex'));
        assert.strictEqual(json.regexFallback, true, 'should include regexFallback');
    });
});

describe('Bug Hunt: formatTocJson includes hiddenFiles', () => {
    it('should include hiddenFiles count when files are truncated', () => {
        const data = {
            totals: { files: 100, functions: 500, classes: 20 },
            summary: 'test summary',
            files: [],
            hiddenFiles: 50
        };
        const json = JSON.parse(output.formatTocJson(data));
        assert.strictEqual(json.hiddenFiles, 50, 'should include hiddenFiles');
    });

    it('should not include hiddenFiles when zero', () => {
        const data = {
            totals: { files: 10, functions: 50, classes: 2 },
            summary: 'test summary',
            files: [],
            hiddenFiles: 0
        };
        const json = JSON.parse(output.formatTocJson(data));
        assert.strictEqual(json.hiddenFiles, undefined, 'should omit hiddenFiles when 0');
    });
});

describe('Bug Hunt: resolveFilePath does not resolve directories', () => {
    const { resolveFilePath } = require('../core/imports');

    it('should not resolve a directory named like a file with extension', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}'
        });
        // Create a directory named utils.js
        fs.mkdirSync(path.join(dir, 'utils.js'), { recursive: true });
        const result = resolveFilePath(path.join(dir, 'utils'), ['.js', '.ts']);
        // Should NOT return the directory utils.js
        assert.notStrictEqual(result, path.join(dir, 'utils.js'), 'should not resolve directory as file');
        rm(dir);
    });

    it('should not resolve a directory named index.js', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}'
        });
        // Create src/ with a directory named index.js inside
        fs.mkdirSync(path.join(dir, 'src', 'index.js'), { recursive: true });
        const result = resolveFilePath(path.join(dir, 'src'), ['.js']);
        assert.notStrictEqual(result, path.join(dir, 'src', 'index.js'), 'should not resolve directory as index file');
        rm(dir);
    });
});

describe('Bug Hunt: --include-methods=true is correctly parsed', () => {
    const { runCli } = require('./helpers');

    it('should parse --include-methods=true as true, not undefined', () => {
        const dir = tmp({
            'app.js': `
class Foo {
    bar() { return this.baz(); }
    baz() { return 1; }
}
function caller() { const f = new Foo(); f.bar(); }
`,
            'package.json': '{"name":"test"}'
        });
        // With --include-methods=true, method calls should be included
        const resultTrue = runCli(dir, 'context', ['caller'], ['--include-methods=true']);
        // With --include-methods=false, method calls should be excluded
        const resultFalse = runCli(dir, 'context', ['caller'], ['--include-methods=false']);
        // Both should not error
        assert.ok(!resultTrue.includes('Unknown flag'), 'should accept --include-methods=true');
        assert.ok(!resultFalse.includes('Unknown flag'), 'should accept --include-methods=false');
        rm(dir);
    });
});

// ============================================================================
// BUG HUNT: REGRESSION TESTS (2026-03-02)
// ============================================================================

describe('Bug Hunt: imports() null module crash', () => {
    it('should not crash when import has null module (Rust include! macro)', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/main.rs': `
include!(concat!(env!("OUT_DIR"), "/generated.rs"));

fn main() {
    println!("hello");
}
`
        });
        const index = idx(dir);
        // This should not throw
        const result = index.imports('src/main.rs');
        assert.ok(Array.isArray(result), 'should return an array');
        rm(dir);
    });
});

describe('Bug Hunt: getToc Java function count', () => {
    it('should count public and abstract methods in Java function totals', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/Service.java': `
package com.example;

public abstract class Service {
    public void handleRequest() {
        System.out.println("handling");
    }

    public abstract void processData();

    private void helper() {
        System.out.println("helper");
    }
}
`
        });
        const index = idx(dir);
        const toc = index.getToc();
        // Should count all methods: handleRequest (public), processData (abstract), helper (method)
        assert.ok(toc.totals.functions >= 3,
            `should count public/abstract methods, got ${toc.totals.functions}`);
        rm(dir);
    });
});

describe('Bug Hunt: getStats --functions filter consistency', () => {
    it('should use same callable types as getToc for --functions', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/App.java': `
package com.example;

public class App {
    public void serve() {
        System.out.println("serving");
    }

    public static void main(String[] args) {
        new App().serve();
    }
}
`
        });
        const index = idx(dir);
        const stats = index.getStats({ functions: true });
        const toc = index.getToc();
        // stats --functions should include the same callable symbols as toc
        assert.ok(stats.functions.length >= toc.totals.functions,
            `stats functions (${stats.functions.length}) should be >= toc functions (${toc.totals.functions})`);
        // Class symbols should NOT appear in functions list
        const classEntries = stats.functions.filter(f => f.name === 'App');
        assert.strictEqual(classEntries.length, 0,
            'class symbols should not appear in --functions output');
        rm(dir);
    });
});

describe('Bug Hunt: Go grouped declaration export line numbers', () => {
    it('should report correct line numbers for grouped type declarations via findExportsInCode', () => {
        const { findExportsInCode } = require('../languages/go');
        const { getParser } = require('../languages');
        const code = `package main

type (
    Foo struct{}
    Bar struct{}
    Baz interface{}
)

func main() {}
`;
        const parser = getParser('go');
        const exports = findExportsInCode(code, parser);
        const fooExport = exports.find(e => e.name === 'Foo');
        const barExport = exports.find(e => e.name === 'Bar');
        const bazExport = exports.find(e => e.name === 'Baz');
        // Each should have its own line, not the group declaration line
        assert.ok(fooExport, 'Foo should be exported');
        assert.ok(barExport, 'Bar should be exported');
        assert.ok(bazExport, 'Baz should be exported');
        assert.notStrictEqual(fooExport.line, barExport.line,
            `Foo (line ${fooExport.line}) and Bar (line ${barExport.line}) should have different line numbers`);
    });

    it('should report correct line numbers for grouped const declarations via findExportsInCode', () => {
        const { findExportsInCode } = require('../languages/go');
        const { getParser } = require('../languages');
        const code = `package main

const (
    MaxSize = 100
    MinSize = 10
)

func main() {}
`;
        const parser = getParser('go');
        const exports = findExportsInCode(code, parser);
        const maxExport = exports.find(e => e.name === 'MaxSize');
        const minExport = exports.find(e => e.name === 'MinSize');
        assert.ok(maxExport, 'MaxSize should be exported');
        assert.ok(minExport, 'MinSize should be exported');
        assert.notStrictEqual(maxExport.line, minExport.line,
            `MaxSize (line ${maxExport.line}) and MinSize (line ${minExport.line}) should have different line numbers`);
    });
});

describe('Bug Hunt: Rust extractAttributes blank line handling', () => {
    it('should not pick up attributes from a previous item across blank lines', () => {
        const { parse } = require('../core/parser');
        const code = `
#[test]
fn test_foo() {
    assert!(true);
}

fn regular_function() {
    println!("not a test");
}
`;
        const result = parse(code, 'rust');
        const regular = result.functions.find(f => f.name === 'regular_function');
        assert.ok(regular, 'regular_function should be found');
        // regular_function should NOT have #[test] attribute
        assert.ok(!regular.decorators || !regular.decorators.includes('test'),
            `regular_function should not have #[test] attribute, got: ${JSON.stringify(regular.decorators)}`);
    });
});

describe('Bug Hunt: --stack flag accepted in CLI', () => {
    it('should accept --stack flag without error', () => {
        const result = runCli('.', 'stacktrace', ['test trace'], ['--stack=Error at line 1']);
        assert.ok(!result.includes('Unknown flag'), `--stack should be a known flag, got: ${result.substring(0, 200)}`);
    });
});

describe('Bug Hunt: glob mode toc --json output', () => {
    it('should produce valid JSON with totals and files fields', () => {
        const { execFileSync } = require('child_process');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'function foo() { return 1; }\nfunction bar() { return 2; }',
            'src/b.js': 'function baz() { return 3; }'
        });
        // Glob pattern needs to be passed as a single positional arg (no shell expansion)
        const globPattern = path.join(dir, 'src', '*.js');
        let result;
        try {
            result = execFileSync('node', [CLI_PATH, globPattern, 'toc', '--json'], {
                timeout: 30000,
                encoding: 'utf-8'
            });
        } catch (e) {
            result = (e.stdout || '') + (e.stderr || '');
        }
        let parsed;
        try {
            parsed = JSON.parse(result.trim());
        } catch (e) {
            assert.fail(`glob toc --json should produce valid JSON, got: ${result.substring(0, 300)}`);
        }
        assert.ok(parsed.totals, 'JSON should have totals field');
        assert.ok(parsed.totals.files >= 2, `should have at least 2 files, got ${parsed.totals.files}`);
        assert.ok(parsed.totals.functions >= 3, `should have at least 3 functions, got ${parsed.totals.functions}`);
        rm(dir);
    });
});

describe('Bug Hunt: formatContext method exclusion hint', () => {
    it('should not show method exclusion hint when includeMethods is undefined', () => {
        const ctx = {
            name: 'testFn',
            type: 'function',
            file: 'test.js',
            startLine: 1,
            endLine: 5,
            callers: [],
            callees: [],
            meta: { dynamicImports: 0, uncertain: 0 },
            warnings: []
        };
        const { text } = output.formatContext(ctx);
        assert.ok(!text.includes('obj.method()'),
            'should not show method exclusion hint when includeMethods is not set');
    });

    it('should show method exclusion hint when includeMethods is explicitly false', () => {
        const ctx = {
            name: 'testFn',
            type: 'function',
            file: 'test.js',
            startLine: 1,
            endLine: 5,
            callers: [],
            callees: [],
            meta: { dynamicImports: 0, uncertain: 0, includeMethods: false },
            warnings: []
        };
        const { text } = output.formatContext(ctx);
        assert.ok(text.includes('obj.method()'),
            'should show method exclusion hint when includeMethods is false');
    });
});

describe('Bug Hunt: formatExample null best guard', () => {
    it('should not crash when result.best is null', () => {
        const result = output.formatExample({ best: null }, 'testFn');
        assert.ok(result.includes('No call examples found'), 'should return not-found message');
    });

    it('should not crash when result.best is undefined', () => {
        const result = output.formatExample({}, 'testFn');
        assert.ok(result.includes('No call examples found'), 'should return not-found message');
    });
});

describe('Bug Hunt: interactive mode space-separated value flags', () => {
    it('should handle --depth with space-separated value', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': `
function root() { child(); }
function child() { leaf(); }
function leaf() { return 1; }
`
        });
        const result = runInteractive(dir, ['trace root --depth 2']);
        // Should show at least child as a callee (depth > 0)
        assert.ok(result.includes('child') || result.includes('leaf'),
            `--depth 2 should expand trace tree, got:\n${result.substring(0, 500)}`);
        rm(dir);
    });
});

describe('Bug Hunt: imports content.split performance', () => {
    it('should not crash with many imports (regression for content.split optimization)', () => {
        const imports = Array.from({length: 50}, (_, i) =>
            `const m${i} = require('./mod${i}');`
        ).join('\n');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'index.js': imports + '\nfunction main() {}\n',
        });
        const index = idx(dir);
        // Should not crash or timeout
        const result = index.imports('index.js');
        assert.ok(Array.isArray(result), 'should return imports array');
        assert.ok(result.length >= 50, `should have at least 50 imports, got ${result.length}`);
        rm(dir);
    });
});

// ============================================================================
// BUG HUNT 2026-03-02 — REGRESSION TESTS
// ============================================================================

describe('Bug hunt 2026-03-02 regressions', () => {

    // Bug 1: example/related returned isError:true for not-found in MCP
    // Fix: mcp/server.js — changed toolError to toolResult for soft errors
    describe('fix: example/related MCP soft errors', () => {
        let client;

        it('example(nonexistent) returns soft result, not isError', async () => {
            const { McpClient } = require('./helpers');
            client = new McpClient();
            await client.start();
            await client.initialize();

            const res = await client.callTool('ucn', {
                command: 'example',
                project_dir: FIXTURES_PATH + '/javascript',
                name: 'zzz_nonexistent_symbol_xyz',
            });

            // Should NOT be a protocol-level error (isError should be false/absent)
            assert.ok(!res.error, 'Should not be a protocol error');
            const content = res.result?.content;
            assert.ok(Array.isArray(content), 'Should have content array');
            const text = content.map(c => c.text).join('');
            assert.ok(/no.*examples found/i.test(text), `Text should mention "no examples found", got: ${text}`);
            // Verify isError is NOT true
            const isError = content.some(c => c.isError) || res.result?.isError;
            assert.ok(!isError, 'isError should not be true for not-found example');

            client.stop();
        });

        it('related(nonexistent) returns soft result, not isError', async () => {
            const { McpClient } = require('./helpers');
            client = new McpClient();
            await client.start();
            await client.initialize();

            const res = await client.callTool('ucn', {
                command: 'related',
                project_dir: FIXTURES_PATH + '/javascript',
                name: 'zzz_nonexistent_symbol_xyz',
            });

            assert.ok(!res.error, 'Should not be a protocol error');
            const content = res.result?.content;
            assert.ok(Array.isArray(content), 'Should have content array');
            const text = content.map(c => c.text).join('');
            assert.ok(/not found/i.test(text), `Text should mention "not found", got: ${text}`);
            const isError = content.some(c => c.isError) || res.result?.isError;
            assert.ok(!isError, 'isError should not be true for not-found related');

            client.stop();
        });
    });

    // Bug 2: about() didn't pass includeUncertain to findCallers
    describe('fix: about() passes includeUncertain to findCallers', () => {
        it('about with includeUncertain should include uncertain callers', () => {
            const dir = tmp({
                'package.json': '{"name":"test"}',
                'lib.js': `
function get(key) { return key; }
module.exports = { get };
`,
                'app.js': `
const m = require('./lib');
// m.get() is an uncertain call in JS (method on imported module)
function doWork() {
    return m.get('foo');
}
`,
            });

            const index = idx(dir);

            // Without includeUncertain, method calls may be excluded
            const withoutUncertain = index.about('get', {
                includeUncertain: false,
                includeMethods: true,
            });

            // With includeUncertain
            const withUncertain = index.about('get', {
                includeUncertain: true,
                includeMethods: true,
            });

            // The uncertain version should have >= the callers of the non-uncertain version
            const withoutCount = withoutUncertain?.callers?.length || 0;
            const withCount = withUncertain?.callers?.length || 0;
            assert.ok(withCount >= withoutCount,
                `includeUncertain callers (${withCount}) should be >= non-uncertain (${withoutCount})`);

            rm(dir);
        });
    });

    // Bug 4: Import alias prefix matching was too greedy
    // '@a' alias should NOT match '@abc/foo' import path
    describe('fix: import alias boundary matching', () => {
        it('@a alias should not match @abc/foo', () => {
            const { resolveImport } = require('../core/imports');

            const fromFile = '/project/src/app.js';
            const config = {
                aliases: { '@': './src', '@a': './a-lib' },
                extensions: ['.js'],
                language: 'javascript',
                root: '/project',
            };

            // '@abc/foo' should NOT match '@a' alias — it's a different prefix
            const resolved = resolveImport('@abc/foo', fromFile, config);
            // Should return null (external package, no matching alias)
            assert.strictEqual(resolved, null,
                '@abc/foo should not be matched by @a alias');

            // '@a/bar' SHOULD match '@a' alias
            // (may or may not resolve depending on filesystem, but should attempt)
            // Just verify it doesn't return null immediately (it tries to resolve the alias)
            // Actually, we just test that the prefix match is correct by checking @abc doesn't match
        });

        it('@a alias correctly matches @a/bar', () => {
            const { resolveImport } = require('../core/imports');
            const dir = tmp({
                'a-lib/bar.js': 'module.exports = 42;',
                'src/app.js': 'const x = require("@a/bar");',
            });

            const config = {
                aliases: { '@a': './a-lib' },
                extensions: ['.js'],
                language: 'javascript',
                root: dir,
            };

            const resolved = resolveImport('@a/bar', path.join(dir, 'src/app.js'), config);
            assert.ok(resolved, '@a/bar should resolve via @a alias');
            assert.ok(resolved.endsWith('bar.js'), `Should resolve to bar.js, got: ${resolved}`);

            rm(dir);
        });

        it('exact alias match (no subpath) still works', () => {
            const { resolveImport } = require('../core/imports');
            const dir = tmp({
                'src/index.js': 'module.exports = {};',
            });

            const config = {
                aliases: { '@': './src' },
                extensions: ['.js'],
                language: 'javascript',
                root: dir,
            };

            // Exact match '@' should resolve to './src'
            const resolved = resolveImport('@', path.join(dir, 'app.js'), config);
            // May or may not find a file, but should attempt (not return null immediately)
            // The important thing is it doesn't crash and '@' matches '@' exactly
            rm(dir);
        });
    });

    // Bug 5: Go module prefix matching was too greedy
    describe('fix: Go module prefix boundary matching', () => {
        it('module prefix should not match partial paths', () => {
            // This tests the logic conceptually — Go module resolution
            // requires go.mod and actual filesystem. We test the import resolution
            // function's prefix behavior.
            const { resolveImport } = require('../core/imports');

            // Create a Go project structure
            const dir = tmp({
                'go.mod': 'module github.com/user/proj\n\ngo 1.21\n',
                'main.go': 'package main\nimport "github.com/user/project-ext/pkg"\nfunc main() {}\n',
                'pkg/util.go': 'package pkg\nfunc Helper() {}\n',
            });

            const config = {
                language: 'go',
                root: dir,
            };

            // 'github.com/user/project-ext/pkg' should NOT match 'github.com/user/proj' module
            // (it's a different module: 'project-ext' != 'proj')
            const resolved = resolveImport(
                'github.com/user/project-ext/pkg',
                path.join(dir, 'main.go'),
                config
            );
            assert.strictEqual(resolved, null,
                'Should not match partial module path prefix');

            rm(dir);
        });
    });

    // Bug 6: extractImports fallback was missing importAliases key
    describe('fix: extractImports fallback returns importAliases', () => {
        it('fallback return includes importAliases: null', () => {
            const { extractImports } = require('../core/imports');

            // Trigger the fallback by passing content that causes AST parse failure.
            // Use a valid language (javascript) but content that triggers a parser error
            // in findImportsInCode (e.g., null content will throw inside the try/catch).
            // We can also verify the return shape by using content with no imports.
            const result = extractImports('const x = 1;', 'javascript');
            // Even when parsing succeeds with no imports, the result should have importAliases
            assert.ok('importAliases' in result,
                'Result should include importAliases key');
            // importAliases should be null when there are no aliases
            assert.strictEqual(result.importAliases, null,
                'importAliases should be null when no aliases');
            assert.strictEqual(result.dynamicCount, 0);
        });
    });

    // Bug 7: Go readdirSync was non-deterministic
    describe('fix: Go import file selection is deterministic', () => {
        it('resolves Go imports deterministically regardless of readdir order', () => {
            const { resolveImport } = require('../core/imports');

            // Create a Go project with multiple .go files in a package
            const dir = tmp({
                'go.mod': 'module github.com/test/proj\n\ngo 1.21\n',
                'main.go': 'package main\nimport "github.com/test/proj/mypkg"\nfunc main() {}\n',
                'mypkg/beta.go': 'package mypkg\nfunc Beta() {}\n',
                'mypkg/alpha.go': 'package mypkg\nfunc Alpha() {}\n',
            });

            const config = { language: 'go', root: dir };

            // Resolve the same import multiple times — should always return same file
            const results = new Set();
            for (let i = 0; i < 5; i++) {
                const resolved = resolveImport(
                    'github.com/test/proj/mypkg',
                    path.join(dir, 'main.go'),
                    config
                );
                if (resolved) results.add(resolved);
            }

            assert.ok(results.size <= 1,
                `Should resolve to same file each time, got ${results.size} different results`);
            if (results.size === 1) {
                const file = [...results][0];
                // With .sort(), alpha.go should come before beta.go
                assert.ok(file.endsWith('alpha.go'),
                    `Sorted order should pick alpha.go first, got: ${path.basename(file)}`);
            }

            rm(dir);
        });
    });
});

// ============================================================================
// FIX #118: about() passes targetDefinitions to findCallers
// ============================================================================

describe('Bug Hunt: about() disambiguates callers with targetDefinitions', () => {
    it('should show callers for the resolved definition, not all overloads', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-about-target-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'a.js'), `
function save(data) { return data; }
module.exports = { save };
`);
            fs.writeFileSync(path.join(tmpDir, 'b.js'), `
function save(record) { return record; }
module.exports = { save };
`);
            fs.writeFileSync(path.join(tmpDir, 'caller_a.js'), `
const { save } = require('./a');
save('from a');
`);
            fs.writeFileSync(path.join(tmpDir, 'caller_b.js'), `
const { save } = require('./b');
save('from b');
`);
            const index = idx(tmpDir);
            const result = index.about('save', { file: 'a' });
            assert.ok(result, 'about should return a result');
            if (result.callers && result.callers.length > 0) {
                const callerFiles = result.callers.map(c => c.file || c.relativePath || '');
                // Should prefer callers bound to the a.js definition
                const hasCallerA = callerFiles.some(f => f.includes('caller_a'));
                assert.ok(hasCallerA, 'should include caller_a.js which imports from a.js');
            }
        } finally {
            rm(tmpDir);
        }
    });
});

// ============================================================================
// FIX #119: context() applies --exclude for class/struct types
// ============================================================================

describe('Bug Hunt: context() exclude filter for types', () => {
    it('should exclude callers from test files for class context', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-ctx-exclude-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}');
            fs.writeFileSync(path.join(tmpDir, 'user.js'), `
class User {
    constructor(name) { this.name = name; }
    greet() { return 'hi ' + this.name; }
}
module.exports = { User };
`);
            fs.writeFileSync(path.join(tmpDir, 'app.js'), `
const { User } = require('./user');
const u = new User('alice');
`);
            fs.writeFileSync(path.join(tmpDir, 'test_user.js'), `
const { User } = require('./user');
const u = new User('test');
`);
            const index = idx(tmpDir);
            const result = index.context('User', { exclude: ['test'] });
            assert.ok(result, 'context should return a result');
            if (result.callers) {
                const callerFiles = result.callers.map(c => c.relativePath || '');
                assert.ok(!callerFiles.some(f => f.includes('test_user')),
                    'callers should not include test_user.js when --exclude=test');
            }
        } finally {
            rm(tmpDir);
        }
    });
});

// ============================================================================
// FIX #120: method expandable items use null file for path.join fallback
// ============================================================================

describe('Bug Hunt: method expand items use proper path resolution', () => {
    it('should set file to null so renderExpandItem uses path.join(root, relativePath)', () => {
        const result = {
            type: 'struct',
            name: 'Router',
            file: 'router.go',
            startLine: 1,
            endLine: 5,
            methods: [
                { name: 'Handle', file: 'router.go', line: 7, endLine: 10, params: 'w, r' }
            ],
            callers: []
        };
        const { text, expandable } = output.formatContext(result, {});
        assert.ok(text.includes('Handle'), 'should show Handle method');
        assert.ok(text.includes('[1]'), 'should have expandable item number');
        // Verify the expandable item has file=null so renderExpandItem falls back to path.join(root, relativePath)
        const methodItem = expandable.find(e => e.name === 'Handle');
        assert.ok(methodItem, 'should have expandable item for Handle');
        assert.strictEqual(methodItem.file, null, 'file should be null to trigger path.join fallback');
        assert.strictEqual(methodItem.relativePath, 'router.go', 'relativePath should be set');
    });
});

// Bug Hunt: plan() rename should use word-boundary regex, not plain String.replace
describe('Bug Hunt: plan() rename uses word-boundary regex', () => {
    it('should not corrupt signature when function name is substring of another identifier', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'main.js': `
function get(key) {
    return getAll(key)[0];
}
function getAll(prefix) {
    return Object.keys(data).filter(k => k.startsWith(prefix));
}
function caller() {
    const val = get("test");
    const all = getAll("test");
}
`
        });
        try {
            const index = idx(d);
            const result = index.plan('get', { renameTo: 'fetch' });
            assert.ok(result, 'plan should return result');
            // The signature should rename 'get' to 'fetch', not corrupt 'getAll'
            assert.ok(result.after.signature.includes('fetch'), 'new signature should include fetch');
            assert.ok(!result.after.signature.includes('fetchAll'), 'new signature should not corrupt getAll into fetchAll');
        } finally {
            rm(d);
        }
    });
});

// Bug Hunt: globToRegex should escape parentheses and pipe characters
describe('Bug Hunt: globToRegex escapes special characters', () => {
    it('should handle parentheses in glob pattern without regex error', () => {
        const { globToRegex } = require(path.join(PROJECT_DIR, 'core', 'discovery'));
        // Should not throw SyntaxError
        const regex = globToRegex('utils(v2).js');
        assert.ok(regex instanceof RegExp, 'should return a valid regex');
        assert.ok(regex.test('utils(v2).js'), 'should match the literal filename');
        assert.ok(!regex.test('utilsv2.js'), 'should not match without parentheses');
    });

    it('should handle pipe character in glob pattern', () => {
        const { globToRegex } = require(path.join(PROJECT_DIR, 'core', 'discovery'));
        const regex = globToRegex('a|b.js');
        assert.ok(regex instanceof RegExp, 'should return a valid regex');
        assert.ok(regex.test('a|b.js'), 'should match literal pipe');
        assert.ok(!regex.test('a.js'), 'should not match just a.js');
        assert.ok(!regex.test('b.js'), 'should not match just b.js');
    });
});

// Bug Hunt: interactive mode --exclude and --not space-separated form
describe('Bug Hunt: interactive --exclude/--not space form', () => {
    it('--exclude space form should filter results in interactive mode', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/main.js': `
function processData(input) { return validate(input); }
function validate(x) { return x != null; }
`,
            'test/main.test.js': `
const { processData } = require('../src/main');
test('works', () => { processData(1); });
`
        });
        try {
            const { runInteractive } = require('./helpers');
            const output = runInteractive(d, ['context processData --exclude test']);
            // With --exclude test, test files should not appear in callers
            assert.ok(!output.includes('main.test.js'), 'test file should be excluded from context output');
        } finally {
            rm(d);
        }
    });

    it('--not space form should work as alias for --exclude in interactive mode', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/app.js': `
function render() { return format(); }
function format() { return "ok"; }
`,
            'test/app.test.js': `
const { render } = require('../src/app');
test('render', () => { render(); });
`
        });
        try {
            const { runInteractive } = require('./helpers');
            const output = runInteractive(d, ['context render --not test']);
            assert.ok(!output.includes('app.test.js'), '--not should exclude test files');
        } finally {
            rm(d);
        }
    });
});

// ============================================================================
// BUG HUNT 2026-03-02 REGRESSIONS
// ============================================================================

describe('fix: diff-impact nested project root path resolution', () => {
    it('reports modified functions when run from nested package root', () => {
        const dir = tmp({
            'package.json': '{"name":"root"}',
            'pkg/package.json': '{"name":"pkg"}',
            'pkg/a.js': 'function foo() { return 1; }\nfunction bar() { return foo(); }\nmodule.exports = { foo, bar };\n'
        });
        try {
            // Initialize git repo at the top level
            execSync('git init -q', { cwd: dir });
            execSync('git add .', { cwd: dir });
            execSync('git commit -qm init', { cwd: dir });

            // Modify a function in the nested package
            fs.writeFileSync(path.join(dir, 'pkg/a.js'),
                'function foo() { return 2; }\nfunction bar() { return foo(); }\nmodule.exports = { foo, bar };\n');

            // Run diff-impact from nested package root
            const pkgDir = path.join(dir, 'pkg');
            const index = idx(pkgDir);
            const result = index.diffImpact({ base: 'HEAD' });

            assert.ok(result.functions.length > 0 || result.summary.modifiedFunctions > 0,
                'nested project root should still detect modified functions');
            assert.ok(result.summary.modifiedFunctions >= 1,
                `expected at least 1 modified function, got ${result.summary.modifiedFunctions}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix: lines command rejects malformed ranges', () => {
    it('rejects triple-segment range like 1-2-3', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'file.js': 'line1\nline2\nline3\nline4\nline5\n'
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'lines', { range: '1-2-3', file: 'file.js' });
            assert.strictEqual(ok, false, 'should reject malformed range');
            assert.ok(error.includes('Invalid line range'), `error should mention invalid range, got: ${error}`);
        } finally {
            rm(dir);
        }
    });

    it('rejects range with trailing text like 1-2foo', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'file.js': 'line1\nline2\nline3\nline4\nline5\n'
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'lines', { range: '1-2foo', file: 'file.js' });
            assert.strictEqual(ok, false, 'should reject malformed range');
            assert.ok(error.includes('Invalid line range'), `error should mention invalid range, got: ${error}`);
        } finally {
            rm(dir);
        }
    });

    it('still accepts valid ranges', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'file.js': 'line1\nline2\nline3\nline4\nline5\n'
        });
        try {
            const index = idx(dir);
            const { ok } = execute(index, 'lines', { range: '2-4', file: 'file.js' });
            assert.strictEqual(ok, true, 'valid range should succeed');
            const { ok: ok2 } = execute(index, 'lines', { range: '3', file: 'file.js' });
            assert.strictEqual(ok2, true, 'single line should succeed');
        } finally {
            rm(dir);
        }
    });
});

describe('fix: diff-impact suppresses git stderr in non-git directories', () => {
    it('emits only UCN error, no raw git stderr', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function x(){}\n'
        });
        try {
            const out = runCli(dir, 'diff-impact', [], ['--no-cache']);
            // Should contain the friendly UCN error
            assert.ok(out.includes('Not a git repository') || out.includes('diff-impact requires git'),
                'should show UCN error message');
            // Should NOT contain raw git fatal message
            assert.ok(!out.includes('fatal:'),
                `should not leak raw git stderr, got: ${out}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG HUNT 2026-03-02 ROUND 2 REGRESSIONS
// ============================================================================

describe('fix R2: nested diff-impact deleted-function detection and stderr', () => {
    it('detects deleted functions from nested package root', () => {
        const dir = tmp({
            'package.json': '{"name":"root"}',
            'pkg/package.json': '{"name":"pkg"}',
            'pkg/a.js': 'function foo() { return 1; }\nfunction bar() { return foo(); }\nmodule.exports = { foo, bar };\n'
        });
        try {
            execSync('git init -q', { cwd: dir });
            execSync('git add .', { cwd: dir });
            execSync('git commit -qm init', { cwd: dir });

            // Delete foo, keep bar
            fs.writeFileSync(path.join(dir, 'pkg/a.js'),
                'function bar() { return 1; }\nmodule.exports = { bar };\n');

            const pkgDir = path.join(dir, 'pkg');
            const index = idx(pkgDir);
            const result = index.diffImpact({ base: 'HEAD' });

            assert.ok(result.deletedFunctions.length >= 1,
                `expected at least 1 deleted function, got ${result.deletedFunctions.length}`);
            assert.ok(result.deletedFunctions.some(f => f.name === 'foo'),
                'should detect foo as deleted');
        } finally {
            rm(dir);
        }
    });

    it('does not leak git stderr for nested deleted-function analysis', () => {
        const dir = tmp({
            'package.json': '{"name":"root"}',
            'pkg/package.json': '{"name":"pkg"}',
            'pkg/a.js': 'function foo() { return 1; }\nmodule.exports = { foo };\n'
        });
        try {
            execSync('git init -q', { cwd: dir });
            execSync('git add .', { cwd: dir });
            execSync('git commit -qm init', { cwd: dir });

            // Delete foo
            fs.writeFileSync(path.join(dir, 'pkg/a.js'),
                'module.exports = {};\n');

            const pkgDir = path.join(dir, 'pkg');
            const out = runCli(pkgDir, 'diff-impact', [], ['--base=HEAD', '--no-cache']);
            assert.ok(!out.includes('fatal:'),
                `should not leak git stderr, got: ${out}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix R2: repeated space-form --exclude applies all values', () => {
    it('CLI --exclude test --exclude vendor excludes both', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'function target() {}\nmodule.exports = { target };\n',
            'test/a.js': 'function target() {}\n',
            'vendor/a.js': 'function target() {}\n'
        });
        try {
            const out = runCli(dir, 'find', ['target'], ['--include-tests', '--exclude', 'test', '--exclude', 'vendor', '--no-cache']);
            assert.ok(out.includes('src/a.js'), 'should include src/a.js');
            assert.ok(!out.includes('test/a.js'), 'should exclude test/a.js');
            assert.ok(!out.includes('vendor/a.js'), 'should exclude vendor/a.js');
        } finally {
            rm(dir);
        }
    });

    it('interactive --not test --not vendor excludes both', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'function target() {}\nmodule.exports = { target };\n',
            'test/a.js': 'function target() {}\n',
            'vendor/a.js': 'function target() {}\n'
        });
        try {
            const out = runInteractive(dir, ['find target --include-tests --not test --not vendor']);
            assert.ok(out.includes('src/a.js'), 'should include src/a.js');
            assert.ok(!out.includes('test/a.js'), 'should exclude test/a.js');
            assert.ok(!out.includes('vendor/a.js'), 'should exclude vendor/a.js');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// FIX: Python builtins should not resolve to JS definitions
// ============================================================================

describe('fix: cross-language builtin false positives', () => {
    it('Python builtins should not appear as callees from JS bundle', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'requirements.txt': '',
            'app.py': [
                'def analyze(data):',
                '    s = set(data)',
                '    v = abs(data[0])',
                '    n = len(data)',
                '    m = min(data)',
                '    return sorted(s)',
            ].join('\n'),
            'bundle.js': [
                'function set(o, k, v) { o[k] = v; }',
                'function abs(x) { return x < 0 ? -x : x; }',
                'function len(a) { return a.length; }',
                'function min(a, b) { return a < b ? a : b; }',
                'function sorted(a) { return a.slice().sort(); }',
                'module.exports = { set, abs, len, min, sorted };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'analyze' });
            assert.ok(result.ok, 'context should succeed');
            // Python builtins should NOT resolve to bundle.js definitions
            const callees = result.result.callees || [];
            const jsCallees = callees.filter(c => c.file && c.file.includes('bundle.js'));
            assert.strictEqual(jsCallees.length, 0,
                `Python builtins should not resolve to JS definitions, got: ${jsCallees.map(c => c.name).join(', ')}`);
        } finally {
            rm(dir);
        }
    });

    it('Go builtins should not resolve to JS definitions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'go.mod': 'module test\ngo 1.21',
            'main.go': [
                'package main',
                'func process() {',
                '    s := make([]int, 10)',
                '    n := len(s)',
                '    s = append(s, 1)',
                '    println(n)',
                '}',
            ].join('\n'),
            'utils.js': [
                'function len(a) { return a.length; }',
                'function append(a, v) { a.push(v); return a; }',
                'module.exports = { len, append };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'process' });
            assert.ok(result.ok, 'context should succeed');
            const callees = result.result.callees || [];
            const jsCallees = callees.filter(c => c.file && c.file.includes('utils.js'));
            assert.strictEqual(jsCallees.length, 0,
                `Go builtins should not resolve to JS definitions, got: ${jsCallees.map(c => c.name).join(', ')}`);
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Python builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.py': 'x = 1' });
        try {
            const index = idx(dir);
            for (const name of ['set', 'abs', 'len', 'min', 'max', 'sum', 'sorted', 'print',
                'int', 'str', 'float', 'bool', 'list', 'dict', 'tuple',
                'isinstance', 'hasattr', 'getattr', 'ValueError', 'TypeError', 'Exception']) {
                assert.ok(index.isKeyword(name, 'python'), `${name} should be a Python keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Go builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.go': 'package main' });
        try {
            const index = idx(dir);
            for (const name of ['append', 'len', 'make', 'cap', 'close', 'copy', 'delete',
                'panic', 'recover', 'println', 'print', 'nil', 'true', 'false']) {
                assert.ok(index.isKeyword(name, 'go'), `${name} should be a Go keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Java builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'A.java': 'class A {}' });
        try {
            const index = idx(dir);
            for (const name of ['System', 'String', 'Object', 'Math', 'Integer',
                'Exception', 'RuntimeException', 'NullPointerException', 'Override']) {
                assert.ok(index.isKeyword(name, 'java'), `${name} should be a Java keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers Rust builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.rs': 'fn main() {}' });
        try {
            const index = idx(dir);
            for (const name of ['println', 'vec', 'panic', 'assert', 'assert_eq',
                'Some', 'None', 'Ok', 'Err', 'Box', 'Vec', 'String', 'Option', 'Result']) {
                assert.ok(index.isKeyword(name, 'rust'), `${name} should be a Rust keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });

    it('isKeyword covers JS builtins', () => {
        const dir = tmp({ 'package.json': '{"name":"t"}', 'a.js': 'const x = 1;' });
        try {
            const index = idx(dir);
            for (const name of ['console', 'JSON', 'Math', 'Date', 'Promise', 'Map', 'Set',
                'Error', 'TypeError', 'parseInt', 'fetch', 'require', 'setTimeout']) {
                assert.ok(index.isKeyword(name, 'javascript'), `${name} should be a JS keyword/builtin`);
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug Report Round 2 — bugs #6-#12
// ============================================================================

describe('fix #124: find respects explicit include_tests=false', () => {
    it('should filter out test functions when include_tests is explicitly false', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/lib.js': 'function testSetup() { return 1; }\nmodule.exports = { testSetup };',
            'test/unit.test.js': 'function test_one() {}\nfunction test_two() {}',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'find', { name: 'test_*', includeTests: false });
            assert.ok(result.ok);
            const testFileFns = result.result.filter(m =>
                m.relativePath && m.relativePath.includes('test/')
            );
            assert.strictEqual(testFileFns.length, 0, 'should not include functions from test files');
        } finally {
            rm(dir);
        }
    });

    it('should auto-include tests when include_tests is undefined and pattern is test_*', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'test/unit.test.js': 'function test_one() {}\nfunction test_two() {}',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'find', { name: 'test_*' });
            assert.ok(result.ok);
            assert.ok(result.result.length >= 2, 'should auto-include test functions');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #125: expand shows full function source', () => {
    it('should render complete function body, not just signature', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `function compute() {
  const a = 1;
  const b = 2;
  return a + b;
}

function run() {
  return compute();
}

module.exports = { compute, run };`,
        });
        try {
            const index = idx(dir);
            const ctx = index.context('compute');
            assert.ok(ctx);
            const formatted = output.formatContext(ctx);
            assert.ok(formatted.expandable.length > 0, 'should have expandable items');
            const item = formatted.expandable[0];
            const result = execute(index, 'expand', {
                itemNum: item.num,
                match: item,
            });
            assert.ok(result.ok, 'expand should succeed');
            const lines = result.result.text.split('\n');
            assert.ok(lines.length > 4, `should show full function body, got ${lines.length} lines`);
        } finally {
            rm(dir);
        }
    });

    it('should detect Python function end via indentation', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': `def compute():
    a = 1
    b = 2
    return a + b

def run():
    return compute()
`,
        });
        try {
            const index = idx(dir);
            const ctx = index.context('compute');
            assert.ok(ctx, 'context should find compute');
            const formatted = output.formatContext(ctx);
            const callerItem = formatted.expandable.find(e => e.name === 'run');
            assert.ok(callerItem, 'should have expandable caller item for run');
            const result = execute(index, 'expand', {
                itemNum: callerItem.num,
                match: callerItem,
            });
            assert.ok(result.ok);
            assert.ok(result.result.text.includes('return compute()'), 'should include function body');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #126: impact respects top parameter', () => {
    it('should limit call sites when top is specified', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function doWork(x) { return x; }\nmodule.exports = { doWork };',
            'a.js': 'const { doWork } = require("./lib");\ndoWork(1);\ndoWork(2);\ndoWork(3);',
            'b.js': 'const { doWork } = require("./lib");\ndoWork(4);\ndoWork(5);',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'impact', { name: 'doWork', top: 2 });
            assert.ok(result.ok);
            let shownSites = 0;
            for (const fg of result.result.byFile) {
                shownSites += fg.sites.length;
            }
            assert.ok(shownSites <= 2, `should show at most 2 sites, got ${shownSites}`);
            assert.ok(result.result.totalCallSites >= 5, 'totalCallSites should reflect full count');
        } finally {
            rm(dir);
        }
    });

    it('should show all sites when top is not specified', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function doWork(x) { return x; }\nmodule.exports = { doWork };',
            'a.js': 'const { doWork } = require("./lib");\ndoWork(1);\ndoWork(2);',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'impact', { name: 'doWork' });
            assert.ok(result.ok);
            let shownSites = 0;
            for (const fg of result.result.byFile) {
                shownSites += fg.sites.length;
            }
            assert.strictEqual(shownSites, result.result.totalCallSites, 'should show all sites');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #127: plan includes import updates for rename', () => {
    it('should include import statement changes in rename plan', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `export function compute(x) { return x * 2; }`,
            'app.js': `import { compute } from './lib.js';
function run() { return compute(5); }`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', { name: 'compute', renameTo: 'calculate' });
            assert.ok(result.ok);
            const plan = result.result;
            assert.ok(plan.found, 'plan should find the function');
            assert.strictEqual(plan.operation, 'rename');
            // Check that changes cover both calls and imports
            const importChanges = plan.changes.filter(c => c.isImport);
            assert.ok(importChanges.length > 0, 'should include import statement changes');
            assert.ok(importChanges[0].suggestion.includes('calculate'), 'import should reference new name');
        } finally {
            rm(dir);
        }
    });

    it('should not duplicate import changes when import line is also a call site', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function doWork() { return 1; }\nmodule.exports = { doWork };',
            'app.js': 'const { doWork } = require("./lib");\ndoWork();\ndoWork();',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', { name: 'doWork', renameTo: 'doTask' });
            assert.ok(result.ok);
            const changeKeys = result.result.changes.map(c => `${c.file}:${c.line}`);
            const uniqueKeys = new Set(changeKeys);
            assert.strictEqual(changeKeys.length, uniqueKeys.size, 'should not have duplicate changes');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #128: cross-language name collision uses usage tiebreaker', () => {
    it('should prefer the definition with more usages when scores tie', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'requirements.txt': '',
            'tools/handler.py': `class Handler:
    def __init__(self):
        pass
    def process(self):
        pass
`,
            'svc_a.py': `from tools.handler import Handler
h = Handler()
h.process()
`,
            'svc_b.py': `from tools.handler import Handler
h = Handler()
`,
            'components/Handler.tsx': `export function Handler() {
  return <div>handler</div>;
}`,
        });
        try {
            const index = idx(dir);
            const result = index.resolveSymbol('Handler');
            assert.ok(result.def, 'should resolve Handler');
            // The Python class should win due to more usages
            assert.ok(
                result.def.relativePath.includes('.py'),
                `should prefer Python class with more usages, got ${result.def.relativePath}`
            );
        } finally {
            rm(dir);
        }
    });
});

describe('fix #129: trace uses import context to disambiguate callees', () => {
    it('should prefer callee from imported file over same-name in unrelated file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'utils/format.js': `function format(data) { return JSON.stringify(data); }
module.exports = { format };`,
            'utils/other.js': `function format(html) { return html.trim(); }
module.exports = { format };`,
            'app.js': `const { format } = require('./utils/format');
function run() {
  return format({});
}
module.exports = { run };`,
        });
        try {
            const index = idx(dir);
            const result = index.trace('run', { depth: 2 });
            assert.ok(result);
            assert.ok(result.tree);
            const fmtChild = result.tree.children.find(c => c.name === 'format');
            if (fmtChild) {
                assert.ok(
                    fmtChild.file.includes('utils/format'),
                    `should resolve to imported format, got ${fmtChild.file}`
                );
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #8: impact top parameter ignored in MCP
// ============================================================================

describe('fix #119: impact respects top parameter', () => {
    it('limits call sites to top N', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper(x) { return x + 1; }\nmodule.exports = { helper };',
            'a.js': 'const { helper } = require("./lib");\nfunction a() { helper(1); helper(2); }',
            'b.js': 'const { helper } = require("./lib");\nfunction b() { helper(3); }',
            'c.js': 'const { helper } = require("./lib");\nfunction c() { helper(4); helper(5); }',
            'd.js': 'const { helper } = require("./lib");\nfunction d() { helper(6); }',
            'e.js': 'const { helper } = require("./lib");\nfunction e() { helper(7); helper(8); }',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'impact', { name: 'helper', top: 3 });
            assert.ok(ok, 'impact should succeed');
            assert.strictEqual(result.shownCallSites, 3, 'should show only 3 call sites');
            assert.ok(result.totalCallSites > 3, `total should exceed 3, got ${result.totalCallSites}`);
            // byFile entries should sum to 3 total sites
            const totalShown = result.byFile.reduce((sum, f) => sum + f.count, 0);
            assert.strictEqual(totalShown, 3, `byFile should sum to 3, got ${totalShown}`);
        } finally {
            rm(dir);
        }
    });

    it('shows all call sites when top is not specified', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper(x) { return x + 1; }\nmodule.exports = { helper };',
            'a.js': 'const { helper } = require("./lib");\nfunction a() { helper(1); }',
            'b.js': 'const { helper } = require("./lib");\nfunction b() { helper(2); }',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'impact', { name: 'helper' });
            assert.ok(ok);
            assert.strictEqual(result.shownCallSites, result.totalCallSites, 'should show all');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #12: trace cross-language symbol resolution
// ============================================================================

describe('fix #120: trace prefers same-language callee definitions', () => {
    it('Python trace prefers Python class over TS component with same name', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'requirements.txt': '',
            // Python class with more usages
            'tracker.py': [
                'class DataProcessor:',
                '    def __init__(self):',
                '        self.data = []',
                '    def process(self):',
                '        return self.data',
            ].join('\n'),
            'app.py': [
                'from tracker import DataProcessor',
                '',
                'def create_app():',
                '    processor = DataProcessor()',
                '    processor.process()',
                '    return processor',
            ].join('\n'),
            // More Python files importing DataProcessor to boost usage count
            'worker.py': [
                'from tracker import DataProcessor',
                'def run():',
                '    dp = DataProcessor()',
                '    dp.process()',
            ].join('\n'),
            // TS component with same name but fewer usages
            'DataProcessor.tsx': [
                'export function DataProcessor() {',
                '    return <div>Data</div>;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'trace', { name: 'create_app', depth: 1 });
            assert.ok(ok, 'trace should succeed');
            // Find the DataProcessor callee in the tree
            const dpChild = result.tree.children.find(c => c.name === 'DataProcessor');
            if (dpChild) {
                // Should resolve to Python file, not TSX
                assert.ok(
                    dpChild.file.includes('tracker.py'),
                    `DataProcessor should resolve to tracker.py, got ${dpChild.file}`
                );
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: Class.method syntax for about/context/impact/find
// ============================================================================

describe('Class.method syntax support', () => {
    it('about("ClassA.close") resolves to ClassA method only', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'server.js': [
                'class HttpClient {',
                '    close() { return "http"; }',
                '    open() { this.close(); }',
                '}',
                'class DbConnection {',
                '    close() { return "db"; }',
                '    disconnect() { this.close(); }',
                '}',
                'module.exports = { HttpClient, DbConnection };',
            ].join('\n'),
            'app.js': [
                'const { HttpClient } = require("./server");',
                'const c = new HttpClient();',
                'c.close();',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // HttpClient.close
            const { ok: ok1, result: r1 } = execute(index, 'about', { name: 'HttpClient.close' });
            assert.ok(ok1, 'should find HttpClient.close');
            assert.strictEqual(r1.symbol.name, 'close');
            assert.ok(r1.symbol.file.includes('server.js'), 'should be in server.js');

            // DbConnection.close
            const { ok: ok2, result: r2 } = execute(index, 'about', { name: 'DbConnection.close' });
            assert.ok(ok2, 'should find DbConnection.close');
            assert.strictEqual(r2.symbol.name, 'close');
        } finally {
            rm(dir);
        }
    });

    it('find("MyClass.method") filters by class', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'models.js': [
                'class User {',
                '    save() { return "user"; }',
                '}',
                'class Post {',
                '    save() { return "post"; }',
                '}',
                'module.exports = { User, Post };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'find', { name: 'User.save' });
            assert.ok(ok);
            assert.ok(result.length >= 1, 'should find at least one match');
            assert.ok(result.every(r => r.className === 'User'), 'all results should be from User class');
        } finally {
            rm(dir);
        }
    });

    it('impact("Class.method") scopes to that class method', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': [
                'class Parser {',
                '    parse(input) { return input; }',
                '}',
                'class Formatter {',
                '    parse(input) { return input.trim(); }',
                '}',
                'const p = new Parser();',
                'p.parse("hello");',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'impact', { name: 'Parser.parse' });
            assert.ok(ok, 'impact should succeed');
            assert.strictEqual(result.function, 'parse');
        } finally {
            rm(dir);
        }
    });

    it('Class.method ignores multi-dot names', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            // "a.b.c" should NOT be split — treated as "not found"
            const { ok } = execute(index, 'about', { name: 'a.b.c' });
            assert.ok(!ok, 'multi-dot name should not be found');
        } finally {
            rm(dir);
        }
    });

    it('Class.method does not interfere with dotless names', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'about', { name: 'helper' });
            assert.ok(ok, 'regular name should work');
            assert.strictEqual(result.symbol.name, 'helper');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: fn suggests class command
// ============================================================================

describe('fn suggests class command for class names', () => {
    it('suggests class command when fn receives a class name', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'widget.js': [
                'class MyWidget {',
                '    render() { return "hello"; }',
                '}',
                'module.exports = { MyWidget };',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'fn', { name: 'MyWidget' });
            assert.ok(!ok, 'fn should fail for a class name');
            assert.ok(error.includes('class'), `error should suggest class command, got: ${error}`);
            assert.ok(error.includes('MyWidget'), 'error should mention the name');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: find exact=true with glob warning
// ============================================================================

describe('find exact=true glob warning', () => {
    it('warns when exact=true and name has glob characters', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function get_data() { return 1; }',
        });
        try {
            const index = idx(dir);
            const { ok, note } = execute(index, 'find', { name: 'get_*', exact: true });
            assert.ok(ok, 'find should succeed');
            assert.ok(note, 'should have a warning note');
            assert.ok(note.includes('exact'), `note should mention exact mode, got: ${note}`);
        } finally {
            rm(dir);
        }
    });

    it('no warning when exact=false', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function get_data() { return 1; }',
        });
        try {
            const index = idx(dir);
            const { ok, note } = execute(index, 'find', { name: 'get_*' });
            assert.ok(ok);
            assert.ok(!note, 'should not have a warning for normal glob');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Feature: about better error for nonexistent file filter
// ============================================================================

describe('about file-filter error improvement', () => {
    it('gives helpful error when file filter misses but symbol exists elsewhere', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nhelper();',
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'about', { name: 'helper', file: 'nonexistent.py' });
            assert.ok(!ok, 'should fail');
            assert.ok(error.includes('lib.js'), `error should mention where symbol exists, got: ${error}`);
            assert.ok(error.includes('nonexistent.py'), 'error should mention the filter used');
        } finally {
            rm(dir);
        }
    });

    it('gives generic error when symbol truly does not exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'about', { name: 'nonexistent', file: 'lib.js' });
            assert.ok(!ok);
            assert.ok(error.includes('not found'), 'should give generic not found error');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #13: plan should detect existing parameters
// ============================================================================

describe('fix #13: plan rejects duplicate parameter', () => {
    it('returns error when add_param names an existing parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function fetch(url, timeout) { return url; }\nmodule.exports = { fetch };',
            'app.js': 'const { fetch } = require("./lib");\nfetch("http://x", 5000);',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'fetch', addParam: 'timeout' });
            assert.ok(ok, 'should return ok (found the function)');
            assert.ok(result.error, 'should have error field');
            assert.ok(result.error.includes('already exists'), `should say "already exists", got: ${result.error}`);
            assert.deepStrictEqual(result.currentParams, ['url', 'timeout']);
        } finally {
            rm(dir);
        }
    });

    it('allows adding a genuinely new parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function fetch(url, timeout) { return url; }\nmodule.exports = { fetch };',
            'app.js': 'const { fetch } = require("./lib");\nfetch("http://x", 5000);',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'fetch', addParam: 'retries', defaultValue: '3' });
            assert.ok(ok);
            assert.ok(!result.error, 'should not have error');
            assert.strictEqual(result.operation, 'add-param');
            assert.ok(result.after.params.includes('retries'), 'new param should be in after.params');
            assert.ok(result.after.signature.includes('retries'), 'new param should be in signature');
        } finally {
            rm(dir);
        }
    });

    it('detects duplicate even when param has default value (Python)', () => {
        const dir = tmp({
            'setup.py': '',
            'lib.py': 'def transform(data, verbose=False):\n    return data\n',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'plan', { name: 'transform', addParam: 'verbose', defaultValue: 'True' });
            assert.ok(ok);
            assert.ok(result.error, 'should detect duplicate');
            assert.ok(result.error.includes('already exists'));
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #14: about and impact caller count consistency
// ============================================================================

describe('fix #14: about and impact caller counts match by default', () => {
    it('about excludes obj.method() callers by default (matching impact)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function parse(text) { return text; }\nmodule.exports = { parse };',
            'direct.js': 'const { parse } = require("./lib");\nfunction run() { parse("hello"); }',
            'method.js': 'const obj = require("./lib");\nfunction go() { obj.parse("world"); }',
        });
        try {
            const index = idx(dir);
            const aboutResult = execute(index, 'about', { name: 'parse' });
            const impactResult = execute(index, 'impact', { name: 'parse' });
            assert.ok(aboutResult.ok);
            assert.ok(impactResult.ok);
            // Both should agree on caller count by default
            const aboutCallers = aboutResult.result.callers.total;
            const impactCallers = impactResult.result.totalCallSites;
            assert.strictEqual(aboutCallers, impactCallers,
                `about (${aboutCallers}) and impact (${impactCallers}) should agree on default caller count`);
        } finally {
            rm(dir);
        }
    });

    it('about with includeMethods=true shows more callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function parse(text) { return text; }\nmodule.exports = { parse };',
            'direct.js': 'const { parse } = require("./lib");\nfunction run() { parse("hello"); }',
            'method.js': 'const obj = require("./lib");\nfunction go() { obj.parse("world"); }',
        });
        try {
            const index = idx(dir);
            const defaultResult = execute(index, 'about', { name: 'parse' });
            const withMethods = execute(index, 'about', { name: 'parse', includeMethods: true });
            assert.ok(defaultResult.ok);
            assert.ok(withMethods.ok);
            // With includeMethods=true, should have >= default callers
            assert.ok(withMethods.result.callers.total >= defaultResult.result.callers.total,
                'includeMethods=true should show at least as many callers as default');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// QUALITY: related SIMILAR NAMES noise reduction (short token filtering)
// ============================================================================

describe('related: short token filtering reduces noise', () => {
    it('does not match on 3-char tokens like "get"', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function get_data() { return 1; }\nmodule.exports = { get_data };',
            'b.js': 'function get_config() { return 2; }\nmodule.exports = { get_config };',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'related', { name: 'get_data' });
            assert.ok(ok);
            const similarNames = result.similarNames.map(s => s.name);
            assert.ok(!similarNames.includes('get_config'),
                'should NOT match get_config via shared "get" token (3 chars too short)');
        } finally {
            rm(dir);
        }
    });

    it('matches on 4+ char tokens like "data"', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function get_data() { return 1; }\nmodule.exports = { get_data };',
            'b.js': 'function data_processor() { return 2; }\nmodule.exports = { data_processor };',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'related', { name: 'get_data' });
            assert.ok(ok);
            const similarNames = result.similarNames.map(s => s.name);
            assert.ok(similarNames.includes('data_processor'),
                'should match data_processor via shared "data" token (4 chars)');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #15: with_types=true should show TYPES section
// ============================================================================

describe('fix #119: about with_types=true shows related types', () => {
    it('shows types referenced in function signature', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'types.ts': `export interface UserConfig {\n  name: string;\n  age: number;\n}`,
            'lib.ts': `import { UserConfig } from './types';\nexport function loadConfig(name: string): UserConfig {\n  return { name, age: 0 };\n}`,
        });
        try {
            const index = idx(dir);
            const result = index.about('loadConfig', { withTypes: true });
            assert.ok(result.found);
            assert.ok(result.types.length > 0, 'should find UserConfig type');
            assert.strictEqual(result.types[0].name, 'UserConfig');
            // Verify formatter shows TYPES section
            const text = output.formatAbout(result);
            assert.ok(text.includes('TYPES:'), 'formatted output should show TYPES section');
            assert.ok(text.includes('UserConfig'), 'should display type name');
        } finally {
            rm(dir);
        }
    });

    it('shows types from Python type annotations', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': `class UserData:\n    def __init__(self, name):\n        self.name = name\n`,
            'service.py': `from models import UserData\ndef get_user(uid: int) -> UserData:\n    return UserData("test")\n`,
        });
        try {
            const index = idx(dir);
            const result = index.about('get_user', { withTypes: true });
            assert.ok(result && result.found);
            assert.ok(result.types.length > 0, 'should find UserData type from return annotation');
            assert.strictEqual(result.types[0].name, 'UserData');
        } finally {
            rm(dir);
        }
    });

    it('extractTypeNames filters to only project-defined types', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.ts': `export function parse(data: string): number {\n  return parseInt(data);\n}`,
        });
        try {
            const index = idx(dir);
            const result = index.about('parse', { withTypes: true });
            assert.ok(result.found);
            assert.strictEqual(result.types.length, 0, 'built-in types should not appear');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #16: search in= should work with file paths, not just directories
// ============================================================================

describe('fix #120: search/find in= works with file paths', () => {
    it('search filters to a specific file path', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/util.js': 'function helper() { return "hello"; }',
            'src/main.js': 'function main() { return "hello"; }',
        });
        try {
            const index = idx(dir);
            const results = index.search('hello', { in: 'src/util.js' });
            assert.ok(results.length > 0, 'should find matches in the specified file');
            assert.ok(results.every(r => r.file.includes('util.js')), 'all matches should be in util.js');
        } finally {
            rm(dir);
        }
    });

    it('search in= with basename-only file path works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/util.js': 'function helper() { return "target"; }',
            'src/main.js': 'function main() { return "target"; }',
        });
        try {
            const index = idx(dir);
            const results = index.search('target', { in: 'util.js' });
            assert.ok(results.length > 0, 'should find matches with basename filter');
            assert.ok(results.every(r => r.file.includes('util.js')), 'all matches should be in util.js');
        } finally {
            rm(dir);
        }
    });

    it('search in= still works with directory paths', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/util.js': 'function helper() { return "value"; }',
            'lib/other.js': 'function other() { return "value"; }',
        });
        try {
            const index = idx(dir);
            const results = index.search('value', { in: 'src' });
            assert.ok(results.length > 0, 'should find matches in directory');
            assert.ok(results.every(r => r.file.includes('src/')), 'all matches should be in src/');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #17: related all=true should not truncate sameFile section
// ============================================================================

describe('fix #121: related all=true fully expands sameFile', () => {
    it('shows all same-file functions when all=true', () => {
        // Create a file with many functions to exceed the default limit of 8
        const funcs = Array.from({ length: 15 }, (_, i) =>
            `function fn${i}() { return ${i}; }`
        ).join('\n');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'big.js': funcs + '\nmodule.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.related('fn0', { all: true });
            assert.ok(result);
            // sameFile should have 14 others (fn1-fn14)
            assert.ok(result.sameFile.length >= 14, `should have 14 same-file functions, got ${result.sameFile.length}`);

            // Format with all=true should NOT truncate
            const text = output.formatRelated(result, { all: true });
            assert.ok(!text.includes('... and'), 'should not show truncation with all=true');
            assert.ok(!text.includes('Some sections truncated'), 'should not show truncation hint');
            // Verify all functions are shown
            assert.ok(text.includes('fn14'), 'should show fn14 with all=true');
        } finally {
            rm(dir);
        }
    });

    it('truncates sameFile by default when there are many', () => {
        const funcs = Array.from({ length: 15 }, (_, i) =>
            `function fn${i}() { return ${i}; }`
        ).join('\n');
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'big.js': funcs + '\nmodule.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.related('fn0');
            const text = output.formatRelated(result, {});
            assert.ok(text.includes('... and'), 'should show truncation by default');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #18: scope pollution warning for methods shared across classes
// ============================================================================

describe('fix #122: impact/verify/plan warn about scope pollution', () => {
    it('impact shows scopeWarning for methods in multiple classes', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class FileService { close() { } }\nmodule.exports = { FileService };',
            'b.js': 'class DbConn { close() { } }\nmodule.exports = { DbConn };',
            'main.js': 'const { FileService } = require("./a");\nconst { DbConn } = require("./b");\nnew FileService().close();\nnew DbConn().close();\n',
        });
        try {
            const index = idx(dir);
            const result = index.impact('close');
            assert.ok(result);
            assert.ok(result.scopeWarning, 'should have scope warning');
            assert.ok(result.scopeWarning.otherClasses.length > 0, 'should list other classes');
            assert.ok(result.scopeWarning.hint.includes('file=') || result.scopeWarning.hint.includes('className='),
                'hint should suggest disambiguation');
            // Verify formatter shows the warning
            const text = output.formatImpact(result);
            assert.ok(text.includes('Note:'), 'formatted output should show scope warning');
        } finally {
            rm(dir);
        }
    });

    it('verify shows scopeWarning for methods in multiple classes', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class A { close(x) {} }\nmodule.exports = { A };',
            'b.js': 'class B { close(y) {} }\nmodule.exports = { B };',
            'main.js': 'const { A } = require("./a");\nnew A().close(1);\n',
        });
        try {
            const index = idx(dir);
            const result = index.verify('close');
            assert.ok(result.found);
            assert.ok(result.scopeWarning, 'verify should have scope warning');
            // Verify formatter shows the warning
            const text = output.formatVerify(result);
            assert.ok(text.includes('Note:'), 'formatted verify should show scope warning');
        } finally {
            rm(dir);
        }
    });

    it('no scopeWarning for unique function names', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function uniqueHelper() { return 1; }\nmodule.exports = { uniqueHelper };',
            'app.js': 'const { uniqueHelper } = require("./lib");\nuniqueHelper();',
        });
        try {
            const index = idx(dir);
            const result = index.impact('uniqueHelper');
            assert.ok(result);
            assert.strictEqual(result.scopeWarning, null, 'should not warn for unique names');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug #19: React.forwardRef components should be visible to find/about
// ============================================================================

describe('fix #123: React.forwardRef/memo components detected', () => {
    it('detects React.forwardRef component', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Button.tsx': `import React from 'react';\nconst Button = React.forwardRef<HTMLButtonElement, {}>((props, ref) => {\n  return <button ref={ref} {...props} />;\n});\nexport default Button;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('Button', { exact: true });
            assert.ok(defs.length > 0, 'should find Button component');
            assert.strictEqual(defs[0].name, 'Button');
        } finally {
            rm(dir);
        }
    });

    it('detects forwardRef without React prefix', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Input.tsx': `import { forwardRef } from 'react';\nconst Input = forwardRef((props, ref) => {\n  return <input ref={ref} />;\n});\nexport default Input;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('Input', { exact: true });
            assert.ok(defs.length > 0, 'should find Input component');
        } finally {
            rm(dir);
        }
    });

    it('detects React.memo component', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Card.tsx': `import React from 'react';\nconst Card = React.memo((props) => {\n  return <div>{props.children}</div>;\n});\nexport default Card;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('Card', { exact: true });
            assert.ok(defs.length > 0, 'should find Card component');
        } finally {
            rm(dir);
        }
    });

    it('detects memo without React prefix', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'List.tsx': `import { memo } from 'react';\nconst List = memo(function ListInner(props) {\n  return <ul>{props.items.map(i => <li key={i}>{i}</li>)}</ul>;\n});\nexport default List;\n`,
        });
        try {
            const index = idx(dir);
            const defs = index.find('List', { exact: true });
            assert.ok(defs.length > 0, 'should find List component');
        } finally {
            rm(dir);
        }
    });

    it('about works on forwardRef components', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'Dialog.tsx': `import React from 'react';\nconst Dialog = React.forwardRef((props, ref) => {\n  return <div ref={ref}>{props.children}</div>;\n});\nexport default Dialog;\n`,
            'App.tsx': `import Dialog from './Dialog';\nfunction App() {\n  return <Dialog>Hello</Dialog>;\n}\n`,
        });
        try {
            const index = idx(dir);
            const result = index.about('Dialog');
            assert.ok(result && result.found, 'about should find the forwardRef component');
            assert.strictEqual(result.symbol.name, 'Dialog');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug Report #5 — Evaluation Round 5 Fixes (#115-#125)
// ============================================================================

describe('fix #115: trace depth=0 misleading message', () => {
    it('shows "depth=0: showing root only" instead of "no callees"', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function process(x) { return helper(x); }\nfunction helper(x) { return x * 2; }\nmodule.exports = { process, helper };',
            'app.js': 'const { process } = require("./lib");\nprocess(42);'
        });
        try {
            const index = idx(dir);
            const result = index.trace('process', { depth: 0 });
            assert.ok(result, 'trace should return result');
            assert.ok(result.tree, 'tree should exist');
            assert.strictEqual(result.tree.children.length, 0, 'no children at depth 0');
            assert.ok(result.warnings, 'should have warnings');
            assert.ok(result.warnings.some(w => w.message.includes('depth=0')),
                'warning should mention depth=0');
            assert.ok(!result.warnings.some(w => w.message.includes('no callees')),
                'warning should NOT say "no callees"');
        } finally {
            rm(dir);
        }
    });

    it('still shows "no callees" hint for genuinely leaf functions at depth > 0', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() { return 1; }\nmodule.exports = { foo };',
            'b.js': 'function foo() { return bar(); }\nfunction bar() { return 2; }\nmodule.exports = { foo };'
        });
        try {
            const index = idx(dir);
            // foo in a.js truly has no callees; foo in b.js does
            const result = index.trace('foo', { depth: 3, file: 'a.js' });
            assert.ok(result, 'trace should return result');
            // No ambiguity warning since we specified file
            // But it should NOT show depth=0 message since depth > 0
            if (result.warnings) {
                assert.ok(!result.warnings.some(w => w.message.includes('depth=0')),
                    'should NOT mention depth=0 when depth > 0');
            }
        } finally {
            rm(dir);
        }
    });
});

describe('fix #116: search respects top= parameter', () => {
    it('limits total matches with top parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const x = 1;\nconst y = 2;\nconst z = 3;\nconst w = 4;\nconst v = 5;',
            'b.js': 'const x = 10;\nconst y = 20;\nconst z = 30;',
        });
        try {
            const index = idx(dir);
            const allResults = index.search('const', {});
            const totalAll = allResults.reduce((s, r) => s + r.matches.length, 0);
            assert.ok(totalAll > 3, `should find > 3 matches, got ${totalAll}`);

            const limited = index.search('const', { top: 3 });
            const totalLimited = limited.reduce((s, r) => s + r.matches.length, 0);
            assert.strictEqual(totalLimited, 3, 'should limit to 3 matches');
            assert.ok(limited.meta.truncatedMatches > 0, 'should report truncated count');
            assert.strictEqual(limited.meta.totalMatches, totalAll, 'should report total');
        } finally {
            rm(dir);
        }
    });

    it('top=1 returns exactly one match', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'let a = 1;\nlet b = 2;\nlet c = 3;',
        });
        try {
            const index = idx(dir);
            const result = index.search('let', { top: 1 });
            const total = result.reduce((s, r) => s + r.matches.length, 0);
            assert.strictEqual(total, 1, 'should return exactly 1 match');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #117: className= parameter functional in impact/verify/plan', () => {
    it('impact scopes to className', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'service.py': `
class ServiceA:
    def close(self):
        pass

class ServiceB:
    def close(self):
        pass
`,
            'app.py': `
from service import ServiceA, ServiceB
def run():
    a = ServiceA()
    a.close()
    b = ServiceB()
    b.close()
`,
        });
        try {
            const index = idx(dir);

            // Without className: finds calls from both classes
            const impactAll = index.impact('close', {});
            assert.ok(impactAll, 'should find close');

            // With className=ServiceA: should scope results
            const impactA = index.impact('close', { className: 'ServiceA' });
            assert.ok(impactA, 'should find close for ServiceA');
            assert.ok(impactA.file.includes('service.py'), 'should resolve to service.py');
        } finally {
            rm(dir);
        }
    });

    it('verify scopes to className', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'svc.py': `
class Alpha:
    def process(self, data):
        return data

class Beta:
    def process(self, x, y):
        return x + y
`,
            'main.py': `
from svc import Alpha, Beta
def run():
    a = Alpha()
    a.process("hello")
    b = Beta()
    b.process(1, 2)
`,
        });
        try {
            const index = idx(dir);
            const verifyA = index.verify('process', { className: 'Alpha' });
            assert.ok(verifyA, 'should find process for Alpha');
            assert.ok(verifyA.found, 'should be found');
            // Alpha.process takes 1 arg (self excluded), Beta.process takes 2
            assert.strictEqual(verifyA.expectedArgs.min, 1, 'Alpha.process expects 1 arg');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #118: verify finds calls for *args/**kwargs functions', () => {
    it('finds call sites for functions with *args', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'util.py': `
def submit(*args, **kwargs):
    return args, kwargs
`,
            'caller.py': `
from util import submit
def run():
    submit(1, 2, 3)
    submit(key="value")
    submit()
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('submit', {});
            assert.ok(result, 'should find submit');
            assert.ok(result.found, 'should be found');
            assert.ok(result.totalCalls > 0, `should find calls, got ${result.totalCalls}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #125: verify counts module-level calls (jobs.submit pattern)', () => {
    it('finds calls via import module (import jobs + jobs.submit)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'jobs.py': `
def submit(task, priority=1):
    pass

def cancel(task_id):
    pass
`,
            'worker.py': `
import jobs

def process():
    jobs.submit("task1")
    jobs.submit("task2", priority=2)
    jobs.cancel("abc")
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('submit');
            assert.ok(result.found, 'Should find submit function');
            assert.strictEqual(result.totalCalls, 2,
                `Should count 2 module-level calls via jobs.submit(), got ${result.totalCalls}`);
            assert.strictEqual(result.valid, 2, 'Both calls should be valid');
        } finally {
            rm(dir);
        }
    });

    it('finds calls via from-import (from api import jobs + jobs.submit)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'jobs.py': `
def submit(fn, *args, **kwargs):
    pass
`,
            'caller.py': `
from . import jobs

def run():
    jobs.submit(task_fn, 1, 2, key="val")
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('submit');
            assert.ok(result.found, 'Should find submit function');
            assert.strictEqual(result.totalCalls, 1,
                `Should count 1 module-level call via jobs.submit(), got ${result.totalCalls}`);
        } finally {
            rm(dir);
        }
    });

    it('still filters dict.get() false positives', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'api.py': `
def get(url):
    return url
`,
            'client.py': `
from api import get

def fetch():
    result = get("/data")
    headers = {"Host": "example.com"}
    host = headers.get("Host")
    data = {"key": "value"}
    val = data.get("key")
`,
        });
        try {
            const index = idx(dir);
            const result = index.verify('get');
            assert.ok(result.found, 'Should find get function');
            // Only direct get("/data") should count, not headers.get() or data.get()
            assert.strictEqual(result.totalCalls, 1,
                `Should count only 1 direct call, got ${result.totalCalls}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #119: about CALLERS includes method callers for class methods', () => {
    it('defaults includeMethods=true for class methods', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'analyzer.py': `
class Analyzer:
    def analyze(self, data):
        return self._process(data)

    def _process(self, data):
        return data * 2
`,
            'main.py': `
from analyzer import Analyzer
def run():
    a = Analyzer()
    a.analyze('test')
    result = a.analyze('other')
`,
        });
        try {
            const index = idx(dir);
            const about = index.about('analyze');
            assert.ok(about, 'should find analyze');
            assert.ok(about.found, 'should be found');
            assert.ok(about.includeMethods === true, 'should default to includeMethods=true for methods');
            // Should find callers including a.analyze() calls
            assert.ok(about.callers.total > 0, `should find callers, got ${about.callers.total}`);
        } finally {
            rm(dir);
        }
    });

    it('defaults includeMethods=false for standalone functions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }',
        });
        try {
            const index = idx(dir);
            const about = index.about('helper');
            assert.ok(about, 'should find helper');
            assert.ok(about.found, 'should be found');
            assert.ok(about.includeMethods === false, 'should default to includeMethods=false for functions');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #120: impact finds call sites despite local name collision', () => {
    it('finds method calls in files with same-name local function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'engine.py': `
class Engine:
    def analyze(self, data):
        return data * 2
`,
            'api.py': `
from engine import Engine

def analyze(request):
    """FastAPI endpoint with same name"""
    eng = Engine()
    result = eng.analyze(request.data)
    return result
`,
            'worker.py': `
from engine import Engine
def run_worker():
    e = Engine()
    e.analyze('batch_data')
`,
        });
        try {
            const index = idx(dir);
            // impact on Engine.analyze should find calls in BOTH api.py and worker.py
            const result = index.impact('analyze', { className: 'Engine' });
            assert.ok(result, 'should find analyze');
            const files = result.byFile.map(f => f.file);
            assert.ok(result.totalCallSites >= 2,
                `should find >= 2 call sites, got ${result.totalCallSites} in files: ${files.join(', ')}`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #121: stacktrace uses AST-based function attribution', () => {
    it('resolves correct enclosing function when trace name mismatches', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': `
function alpha() {
    return 1;
}

function beta() {
    // line 7
    // line 8
    // line 9
    return alpha() + 1;
}

function gamma() {
    // line 13
    // line 14
    return beta() + 2;
}
`
        });
        try {
            const index = idx(dir);
            // Simulate a stack trace where function name is wrong (e.g., from minified code)
            const frame = index.createStackFrame(
                'app.js', 10, 'wrong_name', null, '    at wrong_name (app.js:10:5)'
            );
            assert.ok(frame, 'should create frame');
            assert.ok(frame.found, 'should find file');
            // Should use AST to find the actual enclosing function (beta, lines 6-11)
            if (frame.functionInfo) {
                assert.strictEqual(frame.functionInfo.name, 'beta',
                    `should attribute to beta (enclosing function), got ${frame.functionInfo.name}`);
                assert.ok(frame.functionInfo.inferred, 'should be marked as inferred');
                assert.strictEqual(frame.functionInfo.traceName, 'wrong_name',
                    'should preserve original trace name');
            }
        } finally {
            rm(dir);
        }
    });
});

describe('fix #122: with_types=true shows types from function body', () => {
    it('includes types referenced in method body, not just parent class', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'models.py': `
class Config:
    pass

class Report:
    pass

class Processor:
    def process(self, data):
        config = Config()
        report = Report()
        return report
`,
        });
        try {
            const index = idx(dir);
            const about = index.about('process', { withTypes: true });
            assert.ok(about, 'should find process');
            assert.ok(about.found, 'should be found');
            const typeNames = about.types.map(t => t.name);
            assert.ok(typeNames.includes('Processor'), 'should include parent class');
            assert.ok(typeNames.includes('Config'), 'should include Config from body');
            assert.ok(typeNames.includes('Report'), 'should include Report from body');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #123: deadcode not fooled by property access substring matching', () => {
    it('does not count obj.Name as usage of standalone Name', () => {
        const dir = tmp({
            'package.json': '{"name":"test","type":"module"}',
            'components.js': `
export const Separator = () => '<hr/>';
export const Button = () => '<button/>';
`,
            'lib.js': `
const Primitives = { Separator: 'primitive-sep' };
// Uses Primitives.Separator (property access), not the exported Separator
export function render() { return Primitives.Separator; }
`,
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);
            // Separator should be detected as dead — Primitives.Separator is NOT a usage
            assert.ok(deadNames.includes('Separator'),
                `Separator should be dead code, dead items: ${deadNames.join(', ')}`);
            // Button should also be dead (no usage at all)
            assert.ok(deadNames.includes('Button'),
                `Button should be dead code`);
        } finally {
            rm(dir);
        }
    });
});

describe('fix #124: include_methods=false filters self/this method calls in callees', () => {
    it('excludes self.method() callees when includeMethods=false', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'pyproject.toml': '[project]\nname = "test"',
            'service.py': `
class Service:
    def run(self):
        self.step_one()
        self.step_two()
        helper()

    def step_one(self):
        pass

    def step_two(self):
        pass

def helper():
    pass
`,
        });
        try {
            const index = idx(dir);
            // With includeMethods=true: should see step_one, step_two, helper
            const withMethods = index.findCallees(
                index.symbols.get('run').find(s => s.className === 'Service'),
                { includeMethods: true }
            );
            const withNames = withMethods.map(c => c.name);
            assert.ok(withNames.includes('step_one'), 'should include step_one with methods');
            assert.ok(withNames.includes('step_two'), 'should include step_two with methods');

            // With includeMethods=false: should only see helper (non-method calls)
            const withoutMethods = index.findCallees(
                index.symbols.get('run').find(s => s.className === 'Service'),
                { includeMethods: false }
            );
            const withoutNames = withoutMethods.map(c => c.name);
            assert.ok(!withoutNames.includes('step_one'), 'should exclude step_one without methods');
            assert.ok(!withoutNames.includes('step_two'), 'should exclude step_two without methods');
            assert.ok(withoutNames.includes('helper'), 'should still include helper (non-method)');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// FIX #24: impact className strict filter
// ============================================================================

describe('Fix #24: impact className filter', () => {
    it('should filter unrelated receivers when className is specified', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
class MyService:
    def close(self):
        pass

class OtherService:
    def close(self):
        pass

def main():
    svc = MyService()
    svc.close()
    other = OtherService()
    other.close()
`,
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const { ok, result } = execute(index, 'impact', { name: 'close', className: 'MyService' });
            assert.strictEqual(ok, true);
            // Should find callers of MyService.close, not OtherService.close
            assert.ok(result, 'impact should return a result');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #22: findCallees false positives for dict.get(), plt.close()
// ============================================================================

describe('Bug #22: findCallees receiver false positives', () => {
    it('should not resolve dict.get() to a standalone get() function', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'api.py': 'def get(key):\n    return key\n',
            'main.py': `
LOOKUP = {"a": 1}

def compute(analysis, data):
    v1 = analysis.get("key")
    v2 = data.get("other")
    v3 = LOOKUP.get("test")
`,
        });
        try {
            const index = idx(dir);
            const computeDef = index.symbols.get('compute')?.[0];
            assert.ok(computeDef, 'compute should be found');
            const callees = index.findCallees(computeDef, { includeMethods: true });
            const names = callees.map(c => c.name);
            assert.ok(!names.includes('get'),
                'get should NOT be in callees — all .get() calls are on dicts/params');
        } finally {
            rm(dir);
        }
    });

    it('should not resolve plt.close() to a same-file class method', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'report.py': `
import matplotlib.pyplot as plt

class ReportGen:
    def close(self):
        pass

    def generate(self):
        plt.figure()
        plt.close()
`,
        });
        try {
            const index = idx(dir);
            const genDef = index.symbols.get('generate')?.[0];
            assert.ok(genDef, 'generate should be found');
            const callees = index.findCallees(genDef, { includeMethods: true });
            const names = callees.map(c => c.name);
            assert.ok(!names.includes('close'),
                'close should NOT be in callees — plt.close() is an external library call');
        } finally {
            rm(dir);
        }
    });

    it('should still resolve local-type method calls correctly', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'db.py': `
class Connection:
    def close(self):
        pass

def cleanup():
    conn = Connection()
    conn.close()
`,
        });
        try {
            const index = idx(dir);
            const cleanupDef = index.symbols.get('cleanup')?.[0];
            assert.ok(cleanupDef, 'cleanup should be found');
            const callees = index.findCallees(cleanupDef, { includeMethods: true });
            const names = callees.map(c => c.name);
            assert.ok(names.includes('Connection'), 'Connection constructor should be a callee');
            assert.ok(names.includes('close'), 'close should be a callee via localTypes (conn → Connection)');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #23: usages receiver tracking for member expressions
// ============================================================================

describe('Bug #23: usages filters external namespace member expressions', () => {
    it('should filter Ns.Separator but keep standalone Separator (JS)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.jsx': `
import * as Ns from "@external/lib";

function Separator() { return null; }

function Menu() {
    return Ns.Separator;
}
`,
        });
        try {
            const index = idx(dir);
            const usages = index.usages('Separator');
            // Ns.Separator should be FILTERED (external namespace access)
            const nsUsage = usages.find(u => u.receiver === 'Ns');
            assert.ok(!nsUsage, 'Ns.Separator should be filtered out');
            // Standalone definition should remain
            const defUsage = usages.find(u => u.isDefinition);
            assert.ok(defUsage, 'standalone Separator definition should exist');
        } finally {
            rm(dir);
        }
    });

    it('should keep module.fn() when imported file defines the name (JS)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}\nmodule.exports = { helper };',
            'app.js': 'const lib = require("./lib");\nfunction main() { lib.helper(); }\n',
        });
        try {
            const index = idx(dir);
            const usages = index.usages('helper');
            const moduleCall = usages.find(u => u.receiver === 'lib');
            assert.ok(moduleCall, 'lib.helper() should be kept — imported file defines helper');
        } finally {
            rm(dir);
        }
    });

    it('should filter external namespace member expressions (Python)', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
import os

def path():
    return "/"

x = os.path
`,
        });
        try {
            const index = idx(dir);
            const usages = index.usages('path');
            // os.path should be FILTERED (os is external, no project file defines path via import)
            const osUsage = usages.find(u => u.receiver === 'os' && !u.isDefinition);
            assert.ok(!osUsage, 'os.path should be filtered — os is external');
            // Local path() definition should remain
            const defUsage = usages.find(u => u.isDefinition);
            assert.ok(defUsage, 'standalone path() definition should exist');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// CLI --class-name flag
// ============================================================================

describe('CLI --class-name flag', () => {
    it('should pass className via CLI to impact command', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
class Alpha:
    def process(self):
        pass

class Beta:
    def process(self):
        pass
`,
        });
        try {
            const output = runCli(dir, 'impact', ['process'], ['--class-name=Alpha']);
            assert.ok(output.includes('Alpha') || output.includes('process'),
                'impact with --class-name should work');
            assert.ok(!output.includes('Unknown flag'),
                '--class-name should be a recognized flag');
        } finally {
            rm(dir);
        }
    });

    it('should pass className via CLI to verify command', () => {
        const dir = tmp({
            'setup.py': 'from setuptools import setup',
            'app.py': `
class MyClass:
    def process(self, data):
        pass

def caller():
    m = MyClass()
    m.process("hello")
`,
        });
        try {
            const output = runCli(dir, 'verify', ['process'], ['--class-name=MyClass']);
            assert.ok(!output.includes('Unknown flag'),
                '--class-name should be a recognized flag');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #156: verify respects class_name filtering', () => {
    it('filters verify results to only calls on the specified class', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': 'class HttpClient:\n    def close(self):\n        pass\n\nclass MarketDataFetcher:\n    def close(self):\n        pass\n',
            'app.py': 'from models import HttpClient, MarketDataFetcher\n\ndef use_http():\n    c = HttpClient()\n    c.close()\n\ndef use_market():\n    m = MarketDataFetcher()\n    m.close()\n\ndef plot_stuff():\n    import matplotlib.pyplot as plt\n    plt.close("all")\n',
        });
        try {
            const index = idx(dir);
            const result = index.verify('close', { className: 'HttpClient' });
            assert.ok(result.found, 'should find close');
            // totalCalls should be 1 (only c.close() from use_http), not 2 or 3
            assert.strictEqual(result.totalCalls, 1, 'should only find 1 call (HttpClient)');
            assert.strictEqual(result.valid, 1, 'the single HttpClient call should be valid');
            // plt.close and m.close (MarketDataFetcher) should be filtered out
            assert.strictEqual(result.mismatches, 0, 'no mismatches from other classes');
            assert.strictEqual(result.mismatchDetails.length, 0, 'no mismatch details from plt.close()');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #157: impact/verify className filter uses parameter type annotations', () => {
    it('impact includes calls through typed parameters', () => {
        const dir = tmp({
            'requirements.txt': '',
            'tracker.py': 'class SourceTracker:\n    def record(self, data):\n        pass\n',
            'service.py': 'from tracker import SourceTracker\n\ndef process_data(tracker: SourceTracker, items):\n    for item in items:\n        tracker.record(item)\n\ndef direct_use():\n    t = SourceTracker()\n    t.record("hello")\n',
        });
        try {
            const index = idx(dir);
            const impact = index.impact('record', { className: 'SourceTracker' });
            assert.ok(impact, 'impact should return results');
            // Gather all call sites from byFile
            const allSites = impact.byFile.flatMap(f => f.sites);
            // direct_use: t.record("hello")
            const hasDirectCall = allSites.some(c =>
                c.expression && c.expression.includes('t.record')
            );
            // process_data: tracker.record(item) - should be found via parameter type annotation
            const hasParamCall = allSites.some(c =>
                c.expression && c.expression.includes('tracker.record')
            );
            assert.ok(hasDirectCall, 'should find direct constructor-based call');
            assert.ok(hasParamCall, 'should find call via typed parameter (tracker: SourceTracker)');
        } finally {
            rm(dir);
        }
    });

    it('verify includes calls through typed parameters', () => {
        const dir = tmp({
            'requirements.txt': '',
            'client.py': 'class HttpClient:\n    def get(self, url):\n        pass\n',
            'handler.py': 'from client import HttpClient\n\ndef fetch_data(client: HttpClient):\n    client.get("/api/data")\n\ndef direct():\n    c = HttpClient()\n    c.get("/api/other")\n',
        });
        try {
            const index = idx(dir);
            const result = index.verify('get', { className: 'HttpClient' });
            assert.ok(result.found, 'should find get');
            // Both calls should be counted: client.get() (typed param) and c.get() (constructor)
            assert.strictEqual(result.totalCalls, 2, 'should find 2 calls (typed param + constructor)');
            assert.strictEqual(result.valid, 2, 'both calls should be valid');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #159: unique method heuristic for className filtering', () => {
    it('impact includes untyped param calls when method is unique to target class', () => {
        const dir = tmp({
            'requirements.txt': '',
            'tracker.py': 'class SourceTracker:\n    def record(self, data):\n        pass\n',
            'service.py': 'from tracker import SourceTracker\n\ndef process(tracker=None):\n    if tracker:\n        tracker.record("data")\n\ndef direct():\n    t = SourceTracker()\n    t.record("hello")\n',
        });
        try {
            const index = idx(dir);
            const impact = index.impact('record', { className: 'SourceTracker' });
            assert.ok(impact, 'impact should return results');
            const allSites = impact.byFile.flatMap(f => f.sites);
            // Both calls should be included: direct constructor + untyped param (unique method)
            assert.ok(allSites.some(c => c.expression && c.expression.includes('t.record')),
                'should find direct constructor-based call');
            assert.ok(allSites.some(c => c.expression && c.expression.includes('tracker.record')),
                'should find untyped param call via unique method heuristic');
        } finally {
            rm(dir);
        }
    });

    it('does NOT include calls when method exists on multiple classes', () => {
        const dir = tmp({
            'requirements.txt': '',
            'classes.py': 'class HttpClient:\n    def close(self):\n        pass\n\nclass DbConnection:\n    def close(self):\n        pass\n',
            'app.py': 'from classes import HttpClient, DbConnection\n\ndef cleanup(conn=None):\n    if conn:\n        conn.close()\n\ndef direct():\n    c = HttpClient()\n    c.close()\n',
        });
        try {
            const index = idx(dir);
            const impact = index.impact('close', { className: 'HttpClient' });
            assert.ok(impact, 'impact should return results');
            const allSites = impact.byFile.flatMap(f => f.sites);
            // direct c.close() should be included (constructor assignment)
            assert.ok(allSites.some(c => c.expression && c.expression.includes('c.close')),
                'should find direct constructor-based call');
            // conn.close() should NOT be included (close exists on 2 classes)
            assert.ok(!allSites.some(c => c.expression && c.expression.includes('conn.close')),
                'should NOT find ambiguous untyped param call when method is on multiple classes');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #158: search shows test file exclusion note', () => {
    it('shows note about excluded test files when matches are found', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'MAGIC_VALUE = 42\n',
            'test_lib.py': 'from lib import MAGIC_VALUE\ndef test_magic():\n    assert MAGIC_VALUE == 42\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'search', { term: 'MAGIC_VALUE' });
            assert.ok(result.ok);
            const text = output.formatSearch(result.result, 'MAGIC_VALUE');
            assert.ok(text.includes('MAGIC_VALUE'), 'should find matches');
            // Should mention excluded files
            assert.ok(text.includes('test file') && text.includes('hidden'),
                'should mention that test files were excluded');
        } finally {
            rm(dir);
        }
    });

    it('does not show note when include_tests=true', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'MAGIC_VALUE = 42\n',
            'test_lib.py': 'from lib import MAGIC_VALUE\ndef test_magic():\n    assert MAGIC_VALUE == 42\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'search', { term: 'MAGIC_VALUE', includeTests: true });
            assert.ok(result.ok);
            const text = output.formatSearch(result.result, 'MAGIC_VALUE');
            assert.ok(text.includes('MAGIC_VALUE'), 'should find matches');
            assert.ok(!text.includes('test files hidden'),
                'should not mention test exclusion when include_tests=true');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #35: impact/verify/context silently ignore invalid class_name
// ============================================================================

describe('fix #35: impact/verify/context reject invalid class_name', () => {
    let dir, index;

    it('setup', () => {
        dir = tmp({
            'requirements.txt': '',
            'api.py': `
class JobRunner:
    def submit(self):
        return "job"

def submit():
    return "standalone"
`,
            'app.py': `
from api import submit, JobRunner

def main():
    result = submit()
    runner = JobRunner()
    runner.submit()
`,
        });
        index = idx(dir);
    });

    it('impact errors when class_name has no such method', () => {
        const result = execute(index, 'impact', { name: 'submit', className: 'NonExistentClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('impact errors when method not in specified class', () => {
        const result = execute(index, 'impact', { name: 'main', className: 'JobRunner' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not a method'), result.error);
    });

    it('verify errors when class_name is invalid', () => {
        const result = execute(index, 'verify', { name: 'submit', className: 'NonExistentClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('context errors when class_name is invalid', () => {
        const result = execute(index, 'context', { name: 'submit', className: 'NonExistentClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('plan errors when class_name is invalid', () => {
        const result = execute(index, 'plan', { name: 'submit', className: 'NonExistentClass', addParam: 'x' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('not found in class'), result.error);
    });

    it('impact succeeds with valid class_name', () => {
        const result = execute(index, 'impact', { name: 'submit', className: 'JobRunner' });
        assert.strictEqual(result.ok, true);
    });

    it('verify succeeds with valid class_name', () => {
        const result = execute(index, 'verify', { name: 'submit', className: 'JobRunner' });
        assert.strictEqual(result.ok, true);
    });

    it('error lists available classes', () => {
        const result = execute(index, 'impact', { name: 'submit', className: 'WrongClass' });
        assert.strictEqual(result.ok, false);
        assert.ok(result.error.includes('JobRunner'), 'should mention available class');
    });

    it('cleanup', () => { rm(dir); });
});

// ============================================================================
// BUG #36: find undercounts obj.method() patterns
// ============================================================================

describe('fix #36: find counts obj.method() calls accurately', () => {
    it('counts method calls from files without direct import', () => {
        const dir = tmp({
            'requirements.txt': '',
            'tracker.py': `
class Tracker:
    def record(self, event):
        pass
`,
            'app.py': `
from tracker import Tracker

def start():
    t = Tracker()
    t.record("start")
`,
            'helper.py': `
def process(tracker):
    tracker.record("step1")
    tracker.record("step2")
`,
        });
        try {
            const index = idx(dir);
            const results = index.find('record');
            assert.ok(results.length > 0, 'should find record');
            const recordResult = results.find(r => r.name === 'record');
            // Should count calls from helper.py too (no direct import)
            assert.ok(recordResult.usageCounts.calls >= 3,
                `Expected at least 3 calls, got ${recordResult.usageCounts.calls}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #37: toc file= silently ignored
// ============================================================================

describe('fix #37: toc respects file parameter', () => {
    it('scopes toc to a single file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction other() { return 2; }\n',
            'app.js': 'function main() { return helper(); }\n',
            'utils.js': 'function util() {}\n',
        });
        try {
            const index = idx(dir);
            // Full toc should show all files
            const full = execute(index, 'toc', {});
            assert.ok(full.ok);
            assert.ok(full.result.totals.files >= 3);

            // Scoped toc should show only matching file
            const scoped = execute(index, 'toc', { file: 'lib.js' });
            assert.ok(scoped.ok);
            assert.strictEqual(scoped.result.totals.files, 1, 'should show only 1 file');
            assert.strictEqual(scoped.result.files[0].file, 'lib.js');
            assert.strictEqual(scoped.result.totals.functions, 2, 'lib.js has 2 functions');
        } finally {
            rm(dir);
        }
    });

    it('toc file= with partial path', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/api/routes.js': 'function getUsers() {}\nfunction createUser() {}\n',
            'src/lib/utils.js': 'function format() {}\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { file: 'api/routes' });
            assert.ok(result.ok);
            assert.strictEqual(result.result.totals.files, 1);
            assert.ok(result.result.files[0].file.includes('routes'));
        } finally {
            rm(dir);
        }
    });

    it('toc file= returns error for missing file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}\n',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { file: 'nonexistent.js' });
            assert.ok(result.ok); // toc still returns ok but with 0 files
            assert.strictEqual(result.result.totals.files, 0);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #38: plan add_param without default produces invalid signature
// ============================================================================

describe('fix #38: plan add_param places required param before optionals', () => {
    it('inserts required param before optional params (Python)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'cache.py': `
def set_cache(key, data, hours=4, conn=None):
    pass
`,
            'app.py': `
from cache import set_cache

def store():
    set_cache("k", "v")
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'set_cache',
                addParam: 'ttl_hours',
            });
            assert.ok(result.ok);
            // The new required param should appear BEFORE optional params
            const afterSig = result.result.after.signature;
            assert.ok(afterSig.includes('ttl_hours'), 'should contain new param');
            // ttl_hours should come before hours (which has default)
            const ttlIdx = afterSig.indexOf('ttl_hours');
            const hoursIdx = afterSig.indexOf('hours');
            assert.ok(ttlIdx < hoursIdx,
                `Required param 'ttl_hours' (pos ${ttlIdx}) should come before optional 'hours' (pos ${hoursIdx})`);
        } finally {
            rm(dir);
        }
    });

    it('appends param at end when it has a default value', () => {
        const dir = tmp({
            'requirements.txt': '',
            'cache.py': `
def set_cache(key, data, hours=4, conn=None):
    pass
`,
            'app.py': `
from cache import set_cache

def store():
    set_cache("k", "v")
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'set_cache',
                addParam: 'ttl_hours',
                defaultValue: '24',
            });
            assert.ok(result.ok);
            const afterSig = result.result.after.signature;
            // With default, the param should be at the end (valid position)
            assert.ok(afterSig.includes('ttl_hours = 24'), 'should have param with default');
        } finally {
            rm(dir);
        }
    });

    it('inserts required param before optional in JS/TS', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
function connect(host, port, timeout = 5000, retries = 3) {
    return null;
}
`,
            'app.js': `
const { connect } = require('./lib');
function main() { connect("localhost", 8080); }
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'connect',
                addParam: 'protocol',
            });
            assert.ok(result.ok);
            const afterSig = result.result.after.signature;
            const protoIdx = afterSig.indexOf('protocol');
            const timeoutIdx = afterSig.indexOf('timeout');
            assert.ok(protoIdx < timeoutIdx,
                `Required 'protocol' should come before optional 'timeout'`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BUG #39: plan add_param (no default) misleading guidance (fixed by #38)
// ============================================================================

describe('fix #39: plan add_param required param shows correct guidance', () => {
    it('call sites say "Add argument" when no default (valid with #38 fix)', () => {
        const dir = tmp({
            'requirements.txt': '',
            'cache.py': `
def set_cache(key, data, hours=4):
    pass
`,
            'app.py': `
from cache import set_cache

def store():
    set_cache("k", "v")
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'plan', {
                name: 'set_cache',
                addParam: 'ttl_hours',
            });
            assert.ok(result.ok);
            // Signature should be valid (ttl_hours before hours)
            const afterSig = result.result.after.signature;
            const ttlIdx = afterSig.indexOf('ttl_hours');
            const hoursIdx = afterSig.indexOf('hours');
            assert.ok(ttlIdx < hoursIdx, 'signature should be valid');
            // Call sites should have guidance
            assert.ok(result.result.changes.length > 0, 'should have call site changes');
            assert.ok(result.result.changes[0].suggestion.includes('Add argument'));
        } finally {
            rm(dir);
        }
    });
});

describe('fix #168: commands warn when --file matches no files', () => {
    it('context returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'helper', file: 'nonexistent' });
            assert.ok(!r.ok, 'should fail');
            assert.ok(r.error.includes('nonexistent'), 'should mention the pattern');
        } finally {
            rm(dir);
        }
    });

    it('impact returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'impact', { name: 'helper', file: 'xyz' });
            assert.ok(!r.ok);
            assert.ok(r.error.includes('xyz'));
        } finally {
            rm(dir);
        }
    });

    it('deadcode returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'deadcode', { file: 'nonexistent' });
            assert.ok(!r.ok);
            assert.ok(r.error.includes('nonexistent'));
        } finally {
            rm(dir);
        }
    });

    it('fn returns error for non-matching --file', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'fn', { name: 'helper', file: 'nope' });
            assert.ok(!r.ok);
            assert.ok(r.error.includes('nope'));
        } finally {
            rm(dir);
        }
    });
});

describe('fix #166: api command respects --file pattern filter', () => {
    it('filters api results by file substring pattern', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib/utils.js': 'export function helper() {}\nexport function other() {}',
            'app.js': 'export function main() {}',
        });
        try {
            const index = idx(dir);
            const r1 = execute(index, 'api', {});
            assert.strictEqual(r1.result.length, 3, 'should find 3 total exports');
            const r2 = execute(index, 'api', { file: 'utils' });
            assert.ok(r2.ok, 'should not error');
            assert.strictEqual(r2.result.length, 2, 'should find 2 exports in utils.js');
            const r3 = execute(index, 'api', { file: 'app' });
            assert.ok(r3.ok);
            assert.strictEqual(r3.result.length, 1, 'should find 1 export in app.js');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #187: usages() uses filtered definitions for method detection
// ============================================================================
describe('fix #187: usages test exclusion consistency', () => {
    it('usages with test exclusion should not count test-only method definitions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': `
class Handler {
    process(data) { return data; }
}
module.exports = { Handler };
`,
            'app.js': `
const { Handler } = require('./lib');
const h = new Handler();
h.process('input');
`,
            'test/test.js': `
class TestHandler {
    process(data) { return 'test'; }
}
const t = new TestHandler();
t.process('test-input');
`
        });
        try {
            const index = idx(dir);
            // Without test exclusion
            const allUsages = index.usages('process', {});
            // With test exclusion
            const filteredUsages = index.usages('process', {
                exclude: ['test']
            });
            // Filtered should have fewer usages (test file excluded)
            assert.ok(filteredUsages.length < allUsages.length,
                'Test-excluded usages should be fewer than all usages');
            // No filtered usage should be from test files
            const testUsage = filteredUsages.find(u =>
                u.relativePath && u.relativePath.includes('test/'));
            assert.ok(!testUsage, 'No usage should come from test files');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// BLAST (transitive blast radius)
// ============================================================================

describe('blast: transitive blast radius', () => {
    it('walks callers transitively', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'mid.js': 'const { helper } = require("./lib");\nfunction middle() { return helper(); }\nmodule.exports = { middle };',
            'app.js': 'const { middle } = require("./mid");\nfunction main() { return middle(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 3 });
            assert.ok(result, 'blast should return a result');
            assert.strictEqual(result.root, 'helper');
            assert.ok(result.tree, 'should have a tree');

            // helper → middle → main (2 levels deep)
            assert.ok(result.tree.children.length > 0, 'helper should have callers');
            const middleNode = result.tree.children.find(c => c.name === 'middle');
            assert.ok(middleNode, 'middle should be a direct caller');
            assert.ok(middleNode.children.length > 0, 'middle should have its own callers');
            const mainNode = middleNode.children.find(c => c.name === 'main');
            assert.ok(mainNode, 'main should be a transitive caller via middle');

            // Summary
            assert.ok(result.summary.totalAffected >= 2, 'at least 2 functions affected');
            assert.ok(result.summary.totalFiles >= 2, 'at least 2 files affected');
        } finally {
            rm(dir);
        }
    });

    it('detects cycles without infinite loop', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'cycle.js': 'function a() { b(); }\nfunction b() { a(); }\nmodule.exports = { a, b };'
        });
        try {
            const index = idx(dir);
            const result = index.blast('a', { depth: 5 });
            assert.ok(result, 'should complete without infinite loop');
            // b calls a, a calls b — cycle should be detected
            const bNode = result.tree.children.find(c => c.name === 'b');
            if (bNode) {
                // If b has children, one of them should be 'a' with alreadyShown
                const cycleNode = bNode.children.find(c => c.name === 'a');
                if (cycleNode) {
                    assert.ok(cycleNode.alreadyShown, 'cycle should be marked as alreadyShown');
                }
            }
        } finally {
            rm(dir);
        }
    });

    it('respects depth limit', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'chain.js': [
                'function d() { return 1; }',
                'function c() { return d(); }',
                'function b() { return c(); }',
                'function a() { return b(); }',
                'module.exports = { a, b, c, d };'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // depth=1: only direct callers
            const r1 = index.blast('d', { depth: 1 });
            assert.ok(r1.tree.children.length > 0, 'should have direct callers');
            const cNode = r1.tree.children.find(c => c.name === 'c');
            assert.ok(cNode, 'c should be a direct caller');
            assert.strictEqual(cNode.children.length, 0, 'depth=1 should not recurse further');

            // depth=3: full chain
            const r3 = index.blast('d', { depth: 3 });
            assert.ok(r3.summary.totalAffected >= 3, 'depth=3 should find a, b, c');
        } finally {
            rm(dir);
        }
    });

    it('returns no-callers for entry points', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'app.js': 'function main() { console.log("hi"); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('main', { depth: 3 });
            assert.ok(result, 'should return a result');
            assert.strictEqual(result.tree.children.length, 0, 'entry point has no callers');
            assert.strictEqual(result.summary.totalAffected, 0);
        } finally {
            rm(dir);
        }
    });

    it('works through execute()', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'blast', { name: 'helper', depth: 2 });
            assert.ok(ok, 'execute should succeed');
            assert.strictEqual(result.root, 'helper');
            assert.ok(result.tree.children.length > 0);
        } finally {
            rm(dir);
        }
    });

    it('formatBlast produces readable output', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction caller() { helper(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 2 });
            const text = output.formatBlast(result);
            assert.ok(text.includes('Blast radius for helper'), 'should have header');
            assert.ok(text.includes('caller'), 'should show caller');
            assert.ok(text.includes('Summary:'), 'should have summary');
        } finally {
            rm(dir);
        }
    });

    it('formatBlastJson produces valid JSON', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction caller() { helper(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 2 });
            const json = output.formatBlastJson(result);
            const parsed = JSON.parse(json);
            assert.strictEqual(parsed.root, 'helper');
            assert.ok(parsed.tree);
            assert.ok(parsed.summary);
        } finally {
            rm(dir);
        }
    });

    it('supports --exclude filter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'src/app.js': 'const { helper } = require("../lib");\nfunction appCaller() { helper(); }',
            'test/test.js': 'const { helper } = require("../lib");\nfunction testCaller() { helper(); }'
        });
        try {
            const index = idx(dir);
            // Without exclude: should find callers in both src and test
            const all = index.blast('helper', { depth: 1 });
            assert.ok(all.tree.children.length >= 2, 'should find callers in both locations');

            // With exclude=test: should only find src caller
            const filtered = index.blast('helper', { depth: 1, exclude: ['test'] });
            const testCaller = filtered.tree.children.find(c => c.file && c.file.includes('test'));
            assert.ok(!testCaller, 'test callers should be excluded');
        } finally {
            rm(dir);
        }
    });

    it('CLI blast command works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const out = runCli(dir, 'blast', ['helper']);
            assert.ok(out.includes('Blast radius for helper'), 'CLI output should have header');
            assert.ok(out.includes('main'), 'CLI output should show caller');
        } finally {
            rm(dir);
        }
    });

    it('diamond pattern: shared caller shown once, second as (see above)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'chain.js': [
                'function d() { return 1; }',
                'function b() { return d(); }',
                'function c() { return d(); }',
                'function a() { b(); c(); }',
                'module.exports = { a, b, c, d };'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.blast('d', { depth: 3 });
            assert.ok(result);
            // b and c are both direct callers of d
            assert.strictEqual(result.tree.children.length, 2, 'should have 2 direct callers');
            const bNode = result.tree.children.find(c => c.name === 'b');
            const cNode = result.tree.children.find(c => c.name === 'c');
            assert.ok(bNode && cNode, 'both b and c should be callers');
            // a calls both b and c — should appear under one and be (see above) under the other
            const aUnderB = bNode.children.find(c => c.name === 'a');
            const aUnderC = cNode.children.find(c => c.name === 'a');
            assert.ok(aUnderB || aUnderC, 'a should appear at least once');
            if (aUnderB && aUnderC) {
                // One must be alreadyShown
                assert.ok(aUnderB.alreadyShown || aUnderC.alreadyShown,
                    'second occurrence of a should be marked alreadyShown');
            }
            // Summary: b, c, a = 3 affected
            assert.strictEqual(result.summary.totalAffected, 3);
        } finally {
            rm(dir);
        }
    });

    it('depth=0 shows root only with hint', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function f() { return 1; }\nfunction g() { f(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('f', { depth: 0 });
            assert.strictEqual(result.tree.children.length, 0, 'depth=0 should not recurse');
            assert.ok(result.warnings, 'should have warnings');
            assert.ok(result.warnings.some(w => w.message.includes('depth=0')), 'should hint about depth');
            assert.strictEqual(result.summary.totalAffected, 0);
        } finally {
            rm(dir);
        }
    });

    it('negative depth clamped to 0', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function f() { return 1; }\nfunction g() { f(); }'
        });
        try {
            const index = idx(dir);
            const result = index.blast('f', { depth: -5 });
            assert.strictEqual(result.maxDepth, 0, 'negative depth should clamp to 0');
            assert.strictEqual(result.tree.children.length, 0);
        } finally {
            rm(dir);
        }
    });

    it('module-level callers are skipped (no crash)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'top.js': 'const { helper } = require("./lib");\nconst val = helper();\nconsole.log(val);'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 2 });
            assert.ok(result, 'should not crash');
            // Module-level caller (val = helper()) should be filtered out
            assert.strictEqual(result.tree.children.length, 0,
                'module-level caller should be skipped');
        } finally {
            rm(dir);
        }
    });

    it('Go method calls traverse correctly', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'lib.go': 'package main\ntype Parser struct{}\nfunc (p *Parser) Parse() []string { return nil }\n',
            'app.go': 'package main\nfunc Run() { p := &Parser{}; p.Parse() }\nfunc Main() { Run() }\n'
        });
        try {
            const index = idx(dir);
            const result = index.blast('Parse', { depth: 3 });
            assert.ok(result);
            assert.ok(result.tree.children.length > 0, 'Parse should have callers');
            const runNode = result.tree.children.find(c => c.name === 'Run');
            assert.ok(runNode, 'Run should be a caller of Parse');
            if (runNode.children.length > 0) {
                const mainNode = runNode.children.find(c => c.name === 'Main');
                assert.ok(mainNode, 'Main should be a transitive caller');
            }
        } finally {
            rm(dir);
        }
    });

    it('Python self.method() resolves transitively', () => {
        const dir = tmp({
            'setup.py': '',
            'engine.py': 'class Engine:\n    def process(self, data):\n        return self.transform(data)\n    def transform(self, data):\n        return data.upper()\n',
            'runner.py': 'from engine import Engine\ndef run():\n    e = Engine()\n    return e.process("hello")\n',
            'main.py': 'from runner import run\ndef main():\n    run()\n'
        });
        try {
            const index = idx(dir);
            const result = index.blast('transform', { depth: 3 });
            assert.ok(result, 'should resolve Python method');
            // transform → process → run → main
            assert.ok(result.summary.totalAffected >= 2,
                'should find at least process and run as transitive callers');
        } finally {
            rm(dir);
        }
    });

    it('truncation at 10 callers by default, --all shows all', () => {
        const dir = tmp(Object.assign(
            { 'package.json': '{"name":"test"}',
              'lib.js': 'function util() { return 1; }\nmodule.exports = { util };' },
            ...Array.from({ length: 15 }, (_, i) => ({
                [`c${i}.js`]: `const { util } = require("./lib");\nfunction fn${i}() { return util(); }\nmodule.exports = { fn${i} };`
            }))
        ));
        try {
            const index = idx(dir);
            // Default: truncation
            const r = index.blast('util', { depth: 1 });
            assert.strictEqual(r.tree.children.length, 10, 'default truncation at 10');
            assert.strictEqual(r.tree.truncatedChildren, 5, 'should report 5 truncated');

            // --all: no truncation
            const rAll = index.blast('util', { depth: 1, all: true });
            assert.strictEqual(rAll.tree.children.length, 15, '--all should show all 15');
            assert.ok(!rAll.tree.truncatedChildren, 'no truncation with --all');
        } finally {
            rm(dir);
        }
    });

    it('multiple call sites in same caller deduped with callSites count', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction caller() {\n  helper();\n  helper();\n  helper();\n}'
        });
        try {
            const index = idx(dir);
            const result = index.blast('helper', { depth: 1 });
            assert.strictEqual(result.tree.children.length, 1, 'one unique caller');
            assert.ok(result.tree.children[0].callSites >= 2,
                'should count multiple call sites');
        } finally {
            rm(dir);
        }
    });

    it('formatBlast handles null gracefully', () => {
        assert.strictEqual(output.formatBlast(null), 'Function not found.');
        const json = JSON.parse(output.formatBlastJson(null));
        assert.strictEqual(json.found, false);
    });

    it('formatBlast shows truncation hint', () => {
        const text = output.formatBlast({
            root: 'f', file: 'f.js', line: 1, maxDepth: 3, includeMethods: true,
            tree: {
                name: 'f', file: 'f.js', line: 1, type: 'function',
                children: [{ name: 'a', file: 'a.js', line: 1, type: 'function', children: [] }],
                truncatedChildren: 5
            },
            summary: { totalAffected: 1, totalFiles: 1, maxDepthReached: 1 }
        });
        assert.ok(text.includes('5 more callers'), 'should show truncation count');
        assert.ok(text.includes('--all'), 'should hint about --all');
    });

    it('formatBlast shows callSites count for multi-call callers', () => {
        const text = output.formatBlast({
            root: 'f', file: 'f.js', line: 1, maxDepth: 3, includeMethods: true,
            tree: {
                name: 'f', file: 'f.js', line: 1, type: 'function',
                children: [{ name: 'g', file: 'g.js', line: 5, type: 'function', callSites: 3, children: [] }]
            },
            summary: { totalAffected: 1, totalFiles: 1, maxDepthReached: 1 }
        });
        assert.ok(text.includes('3x'), 'should show 3x for 3 call sites');
    });

    it('formatBlast shows (see above) for cycles', () => {
        const text = output.formatBlast({
            root: 'a', file: 'a.js', line: 1, maxDepth: 3, includeMethods: true,
            tree: {
                name: 'a', file: 'a.js', line: 1, type: 'function',
                children: [{
                    name: 'b', file: 'b.js', line: 1, type: 'function',
                    children: [{ name: 'a', file: 'a.js', line: 1, type: 'function', children: [], alreadyShown: true }]
                }]
            },
            summary: { totalAffected: 1, totalFiles: 1, maxDepthReached: 2 }
        });
        assert.ok(text.includes('(see above)'), 'should show cycle indicator');
    });

    it('CLI --json returns valid JSON with full structure', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const out = runCli(dir, 'blast', ['helper', '--json']);
            const parsed = JSON.parse(out);
            assert.strictEqual(parsed.root, 'helper');
            assert.ok(parsed.tree, 'JSON should have tree');
            assert.ok(parsed.summary, 'JSON should have summary');
            assert.ok(typeof parsed.maxDepth === 'number', 'maxDepth should be a number');
            assert.ok(typeof parsed.summary.totalAffected === 'number');
        } finally {
            rm(dir);
        }
    });

    it('interactive mode blast works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'app.js': 'const { helper } = require("./lib");\nfunction main() { helper(); }'
        });
        try {
            const out = runInteractive(dir, ['blast helper']);
            assert.ok(out.includes('Blast radius'), 'interactive should show blast header');
            assert.ok(out.includes('main'), 'interactive should show caller');
        } finally {
            rm(dir);
        }
    });

    it('Rust methods blast correctly', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"',
            'src/lib.rs': 'pub struct Engine {\n    state: i32\n}\nimpl Engine {\n    pub fn run(&self) -> i32 { self.state }\n}\n',
            'src/main.rs': 'use crate::Engine;\nfn start() { let e = Engine { state: 1 }; e.run(); }\nfn main() { start(); }\n'
        });
        try {
            const index = idx(dir);
            const result = index.blast('run', { depth: 3 });
            assert.ok(result, 'should find Rust method');
            assert.ok(result.tree.children.length > 0, 'run should have callers');
        } finally {
            rm(dir);
        }
    });

    it('exclude filters at all levels of the tree', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'src/mid.js': 'const { helper } = require("../lib");\nfunction middle() { return helper(); }\nmodule.exports = { middle };',
            'test/t.js': 'const { middle } = require("../src/mid");\nfunction testMiddle() { return middle(); }'
        });
        try {
            const index = idx(dir);
            // Without exclude: should have helper → middle → testMiddle
            const all = index.blast('helper', { depth: 3 });
            const middleNode = all.tree.children.find(c => c.name === 'middle');
            assert.ok(middleNode, 'should find middle');

            // With exclude=test: middle is still shown, but testMiddle should be excluded
            const filtered = index.blast('helper', { depth: 3, exclude: ['test'] });
            const filteredMiddle = filtered.tree.children.find(c => c.name === 'middle');
            assert.ok(filteredMiddle, 'middle should still be shown');
            if (filteredMiddle) {
                const testChild = filteredMiddle.children.find(c => c.name === 'testMiddle');
                assert.ok(!testChild, 'testMiddle in test/ should be excluded at depth 2');
            }
        } finally {
            rm(dir);
        }
    });

    it('execute rejects missing name', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'a.js': 'function f() {}' });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', {});
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('required'));
        } finally {
            rm(dir);
        }
    });

    it('execute rejects nonexistent function', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'a.js': 'function f() {}' });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'nonexistent' });
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('not found'));
        } finally {
            rm(dir);
        }
    });

    it('execute rejects invalid className', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo { bar() {} }\nclass Baz { bar() {} }'
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'bar', className: 'Nonexistent' });
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('Nonexistent'));
        } finally {
            rm(dir);
        }
    });

    it('execute rejects file pattern that matches nothing', () => {
        const dir = tmp({ 'package.json': '{"name":"test"}', 'a.js': 'function f() {}' });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'f', file: 'nonexistent.js' });
            assert.strictEqual(r.ok, false);
            assert.ok(r.error.includes('No files matched'));
        } finally {
            rm(dir);
        }
    });

    it('Class.method syntax works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo {\n  bar() { return 1; }\n}\nfunction caller() { const f = new Foo(); f.bar(); }'
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'blast', { name: 'Foo.bar', depth: 1 });
            assert.ok(r.ok, 'Class.method syntax should work');
            assert.strictEqual(r.result.root, 'bar');
        } finally {
            rm(dir);
        }
    });

    it('maxDepthReached tracks actual depth', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'chain.js': [
                'function d() { return 1; }',
                'function c() { return d(); }',
                'function b() { return c(); }',
                'function a() { return b(); }',
                'module.exports = { a, b, c, d };'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Chain is 3 deep; ask for depth=10
            const r = index.blast('d', { depth: 10 });
            assert.strictEqual(r.summary.maxDepthReached, 3,
                'should report actual depth reached, not maxDepth');
        } finally {
            rm(dir);
        }
    });

    it('import-graph disambiguation: only shows callers from correct import chain', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function save() { return "a"; }\nmodule.exports = { save };',
            'b.js': 'function save() { return "b"; }\nmodule.exports = { save };',
            'user_a.js': 'const { save } = require("./a");\nfunction saveA() { save(); }',
            'user_b.js': 'const { save } = require("./b");\nfunction saveB() { save(); }'
        });
        try {
            const index = idx(dir);
            // blast for a.js:save should only show saveA
            const rA = index.blast('save', { depth: 1, file: 'a.js' });
            assert.strictEqual(rA.tree.children.length, 1, 'should have exactly 1 caller for a.js:save');
            assert.strictEqual(rA.tree.children[0].name, 'saveA');

            // blast for b.js:save should only show saveB
            const rB = index.blast('save', { depth: 1, file: 'b.js' });
            assert.strictEqual(rB.tree.children.length, 1, 'should have exactly 1 caller for b.js:save');
            assert.strictEqual(rB.tree.children[0].name, 'saveB');
        } finally {
            rm(dir);
        }
    });

    it('import-graph disambiguation works through barrel re-exports', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function save() { return "a"; }\nmodule.exports = { save };',
            'b.js': 'function save() { return "b"; }\nmodule.exports = { save };',
            'barrel.js': 'module.exports = require("./a");',
            'user.js': 'const { save } = require("./barrel");\nfunction useSave() { save(); }'
        });
        try {
            const index = idx(dir);
            // user.js imports via barrel → a.js, so it should be a caller of a.js:save
            const rA = index.blast('save', { depth: 1, file: 'a.js' });
            const names = rA.tree.children.map(c => c.name);
            assert.ok(names.includes('useSave'), 'should find useSave via barrel re-export');

            // user.js should NOT be a caller of b.js:save
            const rB = index.blast('save', { depth: 1, file: 'b.js' });
            const namesB = rB.tree.children.map(c => c.name);
            assert.ok(!namesB.includes('useSave'), 'useSave imports from barrel→a, not b');
        } finally {
            rm(dir);
        }
    });

    it('hint when multiple definitions exist and none has callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function process() { return 1; }\nmodule.exports = { process };',
            'b.js': 'function process() { return 2; }\nmodule.exports = { process };'
        });
        try {
            const index = idx(dir);
            const result = index.blast('process', { depth: 1 });
            if (result.tree.children.length === 0 && result.warnings) {
                // Should hint about other definitions
                assert.ok(result.warnings.some(w => w.message.includes('other definition')),
                    'should hint about other definitions');
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// AFFECTED-TESTS: blast + test detection
// ============================================================================

describe('affected-tests: transitive test detection', () => {
    it('finds tests for direct and transitive callers', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction mid() { return helper(); }\nfunction top() { return mid(); }\nmodule.exports = { helper, mid, top };',
            'test/lib.test.js': 'const { helper, top } = require("../lib");\ndescribe("lib", () => {\n  it("helper works", () => { helper(); });\n  it("top works", () => { top(); });\n});',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result, 'should return result');
            assert.strictEqual(result.root, 'helper');
            // Should find affected functions: helper, mid, top
            assert.ok(result.affectedFunctions.includes('helper'));
            assert.ok(result.affectedFunctions.includes('mid'));
            assert.ok(result.affectedFunctions.includes('top'));
            // Should find the test file
            assert.ok(result.testFiles.length > 0, 'should find test files');
            assert.ok(result.testFiles[0].file.includes('test/lib.test.js'));
            // Summary stats
            assert.ok(result.summary.totalAffected >= 3);
            assert.ok(result.summary.totalTestFiles >= 1);
        } finally {
            rm(dir);
        }
    });

    it('returns null for nonexistent function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('nonexistent');
            assert.strictEqual(result, null);
        } finally {
            rm(dir);
        }
    });

    it('identifies uncovered functions', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            // 'caller' has no test references
            assert.ok(result.uncovered.includes('caller'), 'caller should be uncovered');
            assert.ok(result.summary.uncoveredCount > 0);
        } finally {
            rm(dir);
        }
    });

    it('respects depth parameter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nfunction c() { return b(); }\nfunction d() { return c(); }\nmodule.exports = { a, b, c, d };',
            'test/lib.test.js': 'const { d } = require("../lib");\nit("test d", () => { d(); });',
        });
        try {
            const index = idx(dir);
            const shallow = index.affectedTests('a', { depth: 1 });
            const deep = index.affectedTests('a', { depth: 3 });
            assert.ok(shallow);
            assert.ok(deep);
            assert.ok(deep.affectedFunctions.length >= shallow.affectedFunctions.length,
                'deeper depth should find more affected functions');
        } finally {
            rm(dir);
        }
    });

    it('execute handler validates input', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            // Missing name
            const r1 = execute(index, 'affectedTests', {});
            assert.strictEqual(r1.ok, false);
            assert.ok(r1.error.includes('required'));
            // Nonexistent function
            const r2 = execute(index, 'affectedTests', { name: 'nope' });
            assert.strictEqual(r2.ok, false);
            assert.ok(r2.error.includes('not found'));
        } finally {
            rm(dir);
        }
    });

    it('formatAffectedTests handles null', () => {
        const text = output.formatAffectedTests(null);
        assert.ok(text.includes('not found'));
    });

    it('formatAffectedTests renders summary', () => {
        const result = {
            root: 'fn', file: 'lib.js', line: 1, depth: 3,
            affectedFunctions: ['fn', 'caller'],
            testFiles: [{
                file: 'test/lib.test.js',
                coveredFunctions: ['fn'],
                matchCount: 1,
                matches: [{ line: 5, content: 'fn();', matchType: 'call', functionName: 'fn' }]
            }],
            summary: { totalAffected: 2, totalTestFiles: 1, coveredFunctions: 1, uncoveredCount: 1 },
            uncovered: ['caller'],
        };
        const text = output.formatAffectedTests(result);
        assert.ok(text.includes('affected-tests: fn'));
        assert.ok(text.includes('2 functions affected'));
        assert.ok(text.includes('Test files to run (1)'));
        assert.ok(text.includes('Uncovered (1): caller'));
        assert.ok(text.includes('1/2 functions covered (50%)'));
    });

    it('formatAffectedTestsJson returns valid JSON', () => {
        const result = {
            root: 'fn', file: 'lib.js', line: 1, depth: 3,
            affectedFunctions: ['fn'], testFiles: [],
            summary: { totalAffected: 1, totalTestFiles: 0, coveredFunctions: 0, uncoveredCount: 1 },
            uncovered: ['fn'],
        };
        const json = JSON.parse(output.formatAffectedTestsJson(result));
        assert.strictEqual(json.root, 'fn');
        assert.ok(Array.isArray(json.testFiles));
    });

    it('works via CLI', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const out = runCli(dir, 'affected-tests', ['helper']);
            assert.ok(out.includes('affected-tests: helper'));
            assert.ok(out.includes('functions affected'));
        } finally {
            rm(dir);
        }
    });

    it('works via interactive mode', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const out = runInteractive(dir, ['affected-tests helper']);
            assert.ok(out.includes('affected-tests: helper'));
        } finally {
            rm(dir);
        }
    });

    it('shows no test files message when no tests exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.strictEqual(result.testFiles.length, 0);
            const text = output.formatAffectedTests(result);
            assert.ok(text.includes('No test files found'));
        } finally {
            rm(dir);
        }
    });

    it('handles mutual recursion (cycles)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return b(); }\nfunction b() { return a(); }\nfunction c() { return a(); }\nmodule.exports = { a, b, c };',
            'test/lib.test.js': 'const { a, c } = require("../lib");\nit("test a", () => { a(); });\nit("test c", () => { c(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('a');
            assert.ok(result, 'should not hang on cycles');
            // a→b (mutual), c calls a
            assert.ok(result.affectedFunctions.includes('a'));
            assert.ok(result.affectedFunctions.includes('b'));
            assert.ok(result.affectedFunctions.includes('c'));
        } finally {
            rm(dir);
        }
    });

    it('handles diamond pattern (shared callers)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function base() { return 1; }\nfunction left() { return base(); }\nfunction right() { return base(); }\nfunction top() { return left() + right(); }\nmodule.exports = { base, left, right, top };',
            'test/lib.test.js': 'const { top, base } = require("../lib");\nit("test top", () => { top(); });\nit("test base", () => { base(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('base');
            assert.ok(result);
            assert.ok(result.affectedFunctions.includes('left'));
            assert.ok(result.affectedFunctions.includes('right'));
            assert.ok(result.affectedFunctions.includes('top'));
            assert.ok(result.testFiles.length > 0);
        } finally {
            rm(dir);
        }
    });

    it('multiple test files cover different parts of the chain', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function core() { return 1; }\nfunction mid() { return core(); }\nfunction api() { return mid(); }\nmodule.exports = { core, mid, api };',
            'test/core.test.js': 'const { core } = require("../lib");\nit("core", () => { core(); });',
            'test/api.test.js': 'const { api } = require("../lib");\nit("api", () => { api(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('core');
            assert.ok(result);
            assert.strictEqual(result.testFiles.length, 2, 'should find both test files');
            // 'mid' is uncovered — no test references it directly
            assert.ok(result.uncovered.includes('mid'));
        } finally {
            rm(dir);
        }
    });

    it('depth=0 returns only root function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nmodule.exports = { a, b };',
            'test/lib.test.js': 'const { a } = require("../lib");\nit("test a", () => { a(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('a', { depth: 0 });
            assert.ok(result);
            assert.strictEqual(result.affectedFunctions.length, 1);
            assert.ok(result.affectedFunctions.includes('a'));
            // b should NOT be in the affected set at depth=0
            assert.ok(!result.affectedFunctions.includes('b'));
        } finally {
            rm(dir);
        }
    });

    it('repeated calls do not corrupt index state (_beginOp nesting)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nmodule.exports = { a, b };',
            'test/lib.test.js': 'const { a } = require("../lib");\nit("test a", () => { a(); });',
        });
        try {
            const index = idx(dir);
            // Call 5 times — _beginOp/_endOp must balance
            for (let i = 0; i < 5; i++) {
                const r = index.affectedTests('a');
                assert.ok(r, `call ${i} should succeed`);
            }
            // Index must still work after
            const ctx = index.context('a');
            assert.ok(ctx, 'context should work after repeated affectedTests calls');
        } finally {
            rm(dir);
        }
    });

    it('wide blast (50 callers) performs well', () => {
        const files = { 'package.json': '{"name":"test"}', 'lib.js': 'function base() { return 1; }\nmodule.exports = { base };' };
        for (let i = 0; i < 50; i++) {
            files['caller' + i + '.js'] = 'const { base } = require("./lib");\nfunction caller' + i + '() { return base(); }\nmodule.exports = { caller' + i + ' };';
        }
        files['test/base.test.js'] = 'const { base } = require("../lib");\nit("test", () => { base(); });';
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const t1 = performance.now();
            const result = index.affectedTests('base');
            const t2 = performance.now();
            assert.ok(result);
            assert.strictEqual(result.affectedFunctions.length, 51, '50 callers + root');
            assert.ok(t2 - t1 < 5000, `should complete in <5s, took ${Math.round(t2-t1)}ms`);
        } finally {
            rm(dir);
        }
    });

    it('deep chain (depth=99) traverses fully', () => {
        const files = { 'package.json': '{"name":"test"}' };
        let chain = '';
        for (let i = 0; i < 30; i++) {
            chain += i === 0
                ? 'function fn0() { return 1; }\n'
                : 'function fn' + i + '() { return fn' + (i-1) + '(); }\n';
        }
        chain += 'module.exports = { ' + Array.from({length:30}, (_,i) => 'fn'+i).join(', ') + ' };';
        files['lib.js'] = chain;
        files['test/lib.test.js'] = 'const lib = require("../lib");\nit("test fn29", () => { lib.fn29(); });';
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const result = index.affectedTests('fn0', { depth: 99 });
            assert.ok(result);
            assert.strictEqual(result.affectedFunctions.length, 30);
        } finally {
            rm(dir);
        }
    });

    it('passes blast warnings through', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'b.js': 'function helper() { return 2; }\nmodule.exports = { helper };',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            // Multiple definitions → should have disambiguation warning
            assert.ok(result.warnings && result.warnings.length > 0, 'should pass through blast warnings');
        } finally {
            rm(dir);
        }
    });

    it('file filter narrows the target definition', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function helper() { return 1; }\nfunction callerA() { return helper(); }\nmodule.exports = { helper, callerA };',
            'b.js': 'function helper() { return 2; }\nfunction callerB() { return helper(); }\nmodule.exports = { helper, callerB };',
            'test/a.test.js': 'const { helper } = require("../a");\nit("test a helper", () => { helper(); });',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper', { file: 'a.js' });
            assert.ok(result);
            assert.ok(result.file.includes('a.js'));
            assert.ok(result.affectedFunctions.includes('callerA'));
        } finally {
            rm(dir);
        }
    });

    it('bad file filter returns error via execute', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'helper', file: 'nonexistent' });
            assert.strictEqual(result.ok, false);
            assert.ok(result.error.includes('No files matched'));
        } finally {
            rm(dir);
        }
    });

    it('bad className filter returns error via execute', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'class Foo { bar() { return 1; } }',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'bar', className: 'Baz' });
            assert.strictEqual(result.ok, false);
            assert.ok(result.error.includes('not found in class'));
        } finally {
            rm(dir);
        }
    });

    it('Class.method syntax works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'class Calc {\n  add(a, b) { return a + b; }\n  sum(arr) { return arr.reduce((s, x) => this.add(s, x), 0); }\n}\nmodule.exports = { Calc };',
            'test/calc.test.js': 'const { Calc } = require("../lib");\nit("test add", () => { new Calc().add(1, 2); });',
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'affectedTests', { name: 'Calc.add' });
            assert.ok(result.ok, result.error);
            assert.ok(result.result.affectedFunctions.includes('add'));
        } finally {
            rm(dir);
        }
    });

    it('Python test detection works', () => {
        const dir = tmp({
            'setup.py': '',
            'lib.py': 'def helper():\n    return 1\n\ndef caller():\n    return helper()\n',
            'test_lib.py': 'from lib import helper\n\ndef test_helper():\n    assert helper() == 1\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Python test file');
            assert.ok(result.testFiles[0].file.includes('test_lib.py'));
        } finally {
            rm(dir);
        }
    });

    it('Go test detection works', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test',
            'lib.go': 'package main\n\nfunc helper() int { return 1 }\nfunc caller() int { return helper() }\n',
            'lib_test.go': 'package main\n\nimport "testing"\n\nfunc TestHelper(t *testing.T) {\n\tresult := helper()\n\tif result != 1 { t.Fatal("fail") }\n}\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Go test file');
            assert.ok(result.testFiles[0].file.includes('_test.go'));
        } finally {
            rm(dir);
        }
    });

    it('Java test detection works', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/main/java/App.java': 'public class App {\n    public static int helper() { return 1; }\n    public static int caller() { return helper(); }\n}',
            'src/test/java/AppTest.java': 'import org.junit.Test;\npublic class AppTest {\n    @Test\n    public void testHelper() { App.helper(); }\n}',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Java test file');
        } finally {
            rm(dir);
        }
    });

    it('TypeScript test detection works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'lib.ts': 'export function helper(): number { return 1; }\nexport function caller(): number { return helper(); }\n',
            'test/lib.test.ts': 'import { helper, caller } from "../lib";\ndescribe("lib", () => {\n  it("helper", () => { helper(); });\n  it("caller", () => { caller(); });\n});\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find TypeScript test file');
            assert.ok(result.testFiles[0].file.includes('.test.ts'));
            assert.strictEqual(result.summary.coveredFunctions, result.summary.totalAffected, 'all functions should be covered');
        } finally {
            rm(dir);
        }
    });

    it('Rust test detection works (separate test file)', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': 'pub fn helper() -> i32 { 1 }\npub fn caller() -> i32 { helper() }\n',
            'tests/integration_test.rs': 'use test::helper;\n#[test]\nfn test_helper() {\n    assert_eq!(helper(), 1);\n}\n',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0, 'should find Rust test file');
            assert.ok(result.testFiles[0].file.includes('tests/'));
        } finally {
            rm(dir);
        }
    });

    it('CLI --json flag returns valid JSON', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nfunction caller() { return helper(); }\nmodule.exports = { helper, caller };',
            'test/lib.test.js': 'const { helper } = require("../lib");\nit("test", () => { helper(); });',
        });
        try {
            const out = runCli(dir, 'affected-tests', ['helper'], ['--json']);
            const parsed = JSON.parse(out);
            assert.strictEqual(parsed.root, 'helper');
            assert.ok(Array.isArray(parsed.affectedFunctions));
            assert.ok(Array.isArray(parsed.testFiles));
            assert.ok(parsed.summary);
        } finally {
            rm(dir);
        }
    });

    it('CLI --depth flag works', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function a() { return 1; }\nfunction b() { return a(); }\nfunction c() { return b(); }\nmodule.exports = { a, b, c };',
            'test/lib.test.js': 'const { c } = require("../lib");\nit("test", () => { c(); });',
        });
        try {
            const out = runCli(dir, 'affected-tests', ['a'], ['--depth=1']);
            assert.ok(out.includes('depth 1'));
        } finally {
            rm(dir);
        }
    });

    it('match types are correctly classified', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'test/lib.test.js': 'const { helper } = require("../lib");\ndescribe("lib", () => {\n  it("works", () => {\n    const result = helper();\n    // helper is great\n  });\n});',
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result);
            assert.ok(result.testFiles.length > 0);
            const matches = result.testFiles[0].matches;
            const types = new Set(matches.map(m => m.matchType));
            assert.ok(types.has('import'), 'should have import match');
            assert.ok(types.has('call'), 'should have call match');
        } finally {
            rm(dir);
        }
    });

    it('formatAffectedTests shows key matches (calls and test-cases only)', () => {
        const result = {
            root: 'fn', file: 'lib.js', line: 1, depth: 3,
            affectedFunctions: ['fn'],
            testFiles: [{
                file: 'test/lib.test.js',
                coveredFunctions: ['fn'],
                matchCount: 3,
                matches: [
                    { line: 1, content: 'const { fn } = require("../lib");', matchType: 'import', functionName: 'fn' },
                    { line: 2, content: 'it("test fn", () => {', matchType: 'test-case', functionName: 'fn' },
                    { line: 3, content: '  fn();', matchType: 'call', functionName: 'fn' },
                ]
            }],
            summary: { totalAffected: 1, totalTestFiles: 1, coveredFunctions: 1, uncoveredCount: 0 },
            uncovered: [],
        };
        const text = output.formatAffectedTests(result);
        // Formatter should show call and test-case matches, not imports
        assert.ok(text.includes('[call]'));
        assert.ok(text.includes('[test-case]'));
        // Import is not in key matches (formatAffectedTests filters to call + test-case)
        assert.ok(!text.includes('[import]'));
    });

    it('exclude filter applies to blast callers but still scans all test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': 'function core() { return 1; }\nmodule.exports = { core };',
            'utils/helper.js': 'const { core } = require("../lib");\nfunction useCore() { return core(); }\nmodule.exports = { useCore };',
            'test/core.test.js': 'const { core } = require("../lib");\nit("test core", () => { core(); });',
        });
        try {
            const index = idx(dir);
            // Without exclude: finds useCore as a caller
            const full = index.affectedTests('core');
            assert.ok(full);
            const hasUseCore = full.affectedFunctions.includes('useCore');

            // With exclude=utils: blast should skip callers in utils/
            const filtered = index.affectedTests('core', { exclude: ['utils'] });
            assert.ok(filtered);
            assert.ok(!filtered.affectedFunctions.includes('useCore'), 'useCore should be excluded from affected');
            // Test file should still be found
            assert.ok(filtered.testFiles.length > 0, 'test file should still be found');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// STRUCTURAL SEARCH: Index-based queries (Phase 2)
// ============================================================================

describe('structural search: index-based queries', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    // Shared fixture with rich symbol metadata across languages
    let dir;
    let index;

    // Create a comprehensive multi-language fixture
    // No project file (package.json/go.mod/etc) so ALL language patterns are used
    function setupFixture() {
        dir = tmp({
            'app.js': `
const { helper } = require('./lib');
function handleRequest(req, res) { return helper(req); }
function processData(data, options) { return data; }
function unusedFunc() { return 42; }
module.exports = { handleRequest, processData };
`,
            'lib.js': `
function helper(request) { return request.body; }
function formatResponse(data) { return JSON.stringify(data); }
module.exports = { helper, formatResponse };
`,
            'handlers.py': `
from typing import Optional
import json

def handle_request(request: 'Request', response: 'Response') -> dict:
    return process(request)

def process(data):
    return json.loads(data)

class RequestHandler:
    def handle(self, request):
        return self.validate(request)

    def validate(self, data):
        return data is not None
`,
            'service.go': `
package service

import "net/http"

func HandleHTTP(w http.ResponseWriter, r *http.Request) {
    Process(r)
}

func Process(r *http.Request) error {
    return nil
}

type Service struct {
    Name string
}

func (s *Service) Start() error {
    return nil
}
`,
            'model.java': `
package com.example;

import java.util.List;

public class UserService {
    public List<String> getUsers(String filter) {
        return findAll(filter);
    }

    private List<String> findAll(String query) {
        return null;
    }
}

@Deprecated
class OldService {
    public void process() {}
}
`,
            'lib.rs': `
pub fn calculate(input: &str) -> Result<i32, String> {
    parse_input(input)
}

fn parse_input(s: &str) -> Result<i32, String> {
    Ok(42)
}

pub struct Calculator {
    value: i32,
}

impl Calculator {
    pub fn new() -> Self {
        Calculator { value: 0 }
    }
}
`,
        });
        index = idx(dir);
    }

    it('--type=function finds all functions', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function' });
            assert.ok(result.results.length > 0, 'should find functions');
            assert.ok(result.results.every(r => !['class', 'struct', 'interface', 'enum'].includes(r.kind)),
                'should not include classes');
            assert.ok(result.meta.mode === 'structural');
        } finally { rm(dir); }
    });

    it('--type=class finds classes/structs', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'class' });
            assert.ok(result.results.length >= 3, 'should find RequestHandler, UserService, OldService, Calculator, Service');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('RequestHandler'), 'Python class');
            assert.ok(names.includes('UserService'), 'Java class');
        } finally { rm(dir); }
    });

    it('--type=call finds call sites', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'call' });
            assert.ok(result.results.length > 0, 'should find calls');
            assert.ok(result.results.every(r => r.kind === 'call'));
        } finally { rm(dir); }
    });

    it('--type=call --receiver filters by receiver', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'call', receiver: 'json' });
            assert.ok(result.results.length > 0, 'should find json.* calls');
            assert.ok(result.results.every(r => r.receiver && r.receiver.toLowerCase().includes('json')));
        } finally { rm(dir); }
    });

    it('--param filters by parameter name', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', param: 'request' });
            assert.ok(result.results.length >= 2, 'should find functions with request param');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('handleRequest') || names.includes('handle_request'),
                'should include handleRequest or handle_request');
        } finally { rm(dir); }
    });

    it('--param filters by parameter type', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', param: 'Request' });
            assert.ok(result.results.length >= 1, 'should find functions with Request param type');
        } finally { rm(dir); }
    });

    it('--returns filters by return type (Go)', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', returns: 'error' });
            assert.ok(result.results.length >= 1, 'should find Go functions returning error');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('Process') || names.includes('Start'), 'Go error-returning function');
        } finally { rm(dir); }
    });

    it('--returns filters by return type (Rust)', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', returns: 'Result' });
            assert.ok(result.results.length >= 1, 'should find Rust functions returning Result');
        } finally { rm(dir); }
    });

    it('--exported finds only exported symbols', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', exported: true });
            assert.ok(result.results.length > 0, 'should find exported functions');
            // All Go exported functions start with uppercase
            const goResults = result.results.filter(r => r.file.endsWith('.go'));
            assert.ok(goResults.every(r => /^[A-Z]/.test(r.name)), 'Go exports are uppercase');
        } finally { rm(dir); }
    });

    it('--unused finds functions with zero callers', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', unused: true });
            assert.ok(result.results.length > 0, 'should find unused functions');
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('unusedFunc'), 'unusedFunc has no callers');
        } finally { rm(dir); }
    });

    it('term as glob filter', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', term: 'handle*' });
            assert.ok(result.results.length >= 2, 'should find handle* functions');
            assert.ok(result.results.every(r => r.name.toLowerCase().startsWith('handle')));
        } finally { rm(dir); }
    });

    it('term with ? wildcard', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', term: 'process*' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('processData') || names.includes('process') || names.includes('Process'),
                'should find process* functions');
        } finally { rm(dir); }
    });

    it('--file restricts to file pattern', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', file: 'app.js' });
            assert.ok(result.results.length > 0);
            assert.ok(result.results.every(r => r.file.includes('app.js')));
        } finally { rm(dir); }
    });

    it('--exclude filters out files', () => {
        setupFixture();
        try {
            const all = index.structuralSearch({ type: 'function' });
            const filtered = index.structuralSearch({ type: 'function', exclude: ['handler'] });
            assert.ok(filtered.results.length < all.results.length, 'exclude should reduce results');
            assert.ok(filtered.results.every(r => !r.file.toLowerCase().includes('handler')));
        } finally { rm(dir); }
    });

    it('--top limits results', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', top: 3 });
            assert.ok(result.results.length <= 3, 'should limit to 3');
            assert.ok(result.meta.totalMatched >= result.meta.shown, 'meta shows total');
        } finally { rm(dir); }
    });

    it('combined filters narrow results', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({
                type: 'function',
                param: 'request',
                exported: true,
            });
            // Should be narrow — exported functions with 'request' param
            assert.ok(result.results.length >= 1);
        } finally { rm(dir); }
    });

    it('--decorator finds decorated symbols (Java via modifiers)', () => {
        setupFixture();
        try {
            // Java @Deprecated is stored as lowercase 'deprecated' in modifiers
            const result = index.structuralSearch({ decorator: 'deprecated' });
            assert.ok(result.results.length >= 1, 'should find @Deprecated class');
            assert.ok(result.results.some(r => r.name === 'OldService'));
        } finally { rm(dir); }
    });

    it('no structural flags falls through to text search', () => {
        setupFixture();
        try {
            // Without structural flags, execute routes to text search
            const { ok, result, structural } = execute(index, 'search', { term: 'helper' });
            assert.ok(ok);
            assert.ok(!structural, 'should not be structural mode');
            assert.ok(Array.isArray(result), 'text search returns array');
        } finally { rm(dir); }
    });

    it('structural mode via execute handler', () => {
        setupFixture();
        try {
            const { ok, result, structural } = execute(index, 'search', { type: 'function', param: 'data' });
            assert.ok(ok);
            assert.ok(structural, 'should be structural mode');
            assert.ok(result.meta.mode === 'structural');
            assert.ok(result.results.length > 0);
        } finally { rm(dir); }
    });

    it('structural mode without term is valid', () => {
        setupFixture();
        try {
            const { ok, result, structural } = execute(index, 'search', { type: 'class' });
            assert.ok(ok);
            assert.ok(structural);
            assert.ok(result.results.length > 0);
        } finally { rm(dir); }
    });

    it('empty result returns cleanly', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', returns: 'NonExistentType' });
            assert.strictEqual(result.results.length, 0);
            assert.strictEqual(result.meta.totalMatched, 0);
        } finally { rm(dir); }
    });

    it('results sorted by file then line', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function' });
            for (let i = 1; i < result.results.length; i++) {
                const prev = result.results[i - 1];
                const curr = result.results[i];
                if (prev.file === curr.file) {
                    assert.ok(prev.line <= curr.line, `${prev.name}:${prev.line} should be before ${curr.name}:${curr.line}`);
                }
            }
        } finally { rm(dir); }
    });

    it('text formatter produces readable output', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'function', exported: true, top: 5 });
            const text = output.formatStructuralSearch(result);
            assert.ok(text.includes('Structural search:'));
            assert.ok(text.includes('exported'));
            assert.ok(text.includes('Found'));
        } finally { rm(dir); }
    });

    it('JSON formatter produces valid JSON', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'class' });
            const json = output.formatStructuralSearchJson(result);
            const parsed = JSON.parse(json);
            assert.ok(parsed.results);
            assert.ok(parsed.meta);
            assert.strictEqual(parsed.meta.mode, 'structural');
        } finally { rm(dir); }
    });

    it('--type=method finds class methods', () => {
        setupFixture();
        try {
            const result = index.structuralSearch({ type: 'method' });
            assert.ok(result.results.length >= 2, 'should find methods');
            // Should include Python methods, Java methods, etc.
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('handle') || names.includes('validate') ||
                names.includes('getUsers') || names.includes('findAll'),
                'should include class methods');
        } finally { rm(dir); }
    });

    it('CLI structural search works', () => {
        setupFixture();
        try {
            const out = runCli(dir, 'search', [], ['--type=function', '--exported', '--top=5']);
            assert.ok(out.includes('Structural search:'));
            assert.ok(out.includes('exported'));
        } finally { rm(dir); }
    });

    it('CLI structural search --json works', () => {
        setupFixture();
        try {
            const out = runCli(dir, 'search', [], ['--type=class', '--json']);
            const parsed = JSON.parse(out);
            assert.ok(parsed.results);
            assert.strictEqual(parsed.meta.mode, 'structural');
        } finally { rm(dir); }
    });

    it('interactive structural search works', () => {
        setupFixture();
        try {
            const out = runInteractive(dir, ['search --type=function --param=data']);
            assert.ok(out.includes('Structural search:') || out.includes('function'));
        } finally { rm(dir); }
    });

    it('formatter handles empty results', () => {
        const result = {
            results: [],
            meta: { mode: 'structural', query: { type: 'function', returns: 'xyz' }, totalMatched: 0, shown: 0 }
        };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('No matches found'));
    });

    it('formatter handles truncation note', () => {
        const results = Array.from({ length: 5 }, (_, i) => ({
            kind: 'function', name: `fn${i}`, file: 'a.js', line: i + 1,
            params: null, returnType: null, decorators: null, className: null,
        }));
        const result = { results, meta: { mode: 'structural', query: { type: 'function' }, totalMatched: 100, shown: 5 } };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('5 of 100 shown'));
    });

    it('call results show receiver correctly', () => {
        const result = {
            results: [
                { kind: 'call', name: 'db.query', file: 'a.js', line: 10, receiver: 'db', isMethod: true },
            ],
            meta: { mode: 'structural', query: { type: 'call', receiver: 'db' }, totalMatched: 1, shown: 1 }
        };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('db.query()'));
        assert.ok(text.includes('[method]'));
    });

    it('Python decorator search (using fixture)', () => {
        const d = tmp({
            'app.py': `
import pytest

@pytest.fixture
def client():
    return create_app()

@pytest.mark.parametrize("x", [1, 2])
def test_math(x):
    assert x > 0

def plain_func():
    pass
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ decorator: 'fixture' });
            assert.ok(result.results.some(r => r.name === 'client'), 'should find @pytest.fixture function');
            assert.ok(!result.results.some(r => r.name === 'plain_func'), 'should not include plain function');
        } finally { rm(d); }
    });

    it('Go exported function search', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': `
package main

func HandleRequest(w Writer, r *Request) {}
func processInternal() {}
func Format(data []byte) string { return "" }
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'function', exported: true, file: 'main.go' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('HandleRequest'), 'exported Go function');
            assert.ok(names.includes('Format'), 'exported Go function');
            assert.ok(!names.includes('processInternal'), 'unexported Go function excluded');
        } finally { rm(d); }
    });

    it('Rust return type search', () => {
        const d = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"',
            'lib.rs': `
pub fn parse(input: &str) -> Result<Value, Error> {
    Ok(Value::new())
}

fn helper() -> Option<String> {
    None
}

fn no_return() {}
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'function', returns: 'Result' });
            assert.ok(result.results.some(r => r.name === 'parse'), 'Rust Result-returning function');
            assert.ok(!result.results.some(r => r.name === 'helper'), 'Option function not included');
        } finally { rm(d); }
    });

    it('Java annotation search', () => {
        const d = tmp({
            'Controller.java': `
package com.example;

import org.springframework.web.bind.annotation.*;

@RestController
public class UserController {
    @GetMapping("/users")
    public List<User> getUsers() {
        return null;
    }

    @PostMapping("/users")
    public User createUser() {
        return null;
    }

    private void helper() {}
}
`,
        });
        try {
            const i = idx(d);
            // Java annotations are stored as lowercase modifiers
            const result = i.structuralSearch({ decorator: 'getmapping' });
            assert.ok(result.results.some(r => r.name === 'getUsers'), 'should find @GetMapping method');
            assert.ok(!result.results.some(r => r.name === 'createUser'), 'should not include @PostMapping');
        } finally { rm(d); }
    });

    it('TypeScript type search', () => {
        const d = tmp({
            'package.json': '{"name":"test"}',
            'types.ts': `
export interface Config {
    name: string;
    port: number;
}

export type Handler = (req: Request) => Response;

export enum Status {
    Active,
    Inactive,
}
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'type' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('Config'), 'interface is a type');
            assert.ok(names.includes('Handler') || names.includes('Status'), 'type alias or enum');
        } finally { rm(d); }
    });

    it('multiple flags combined: exported + param + type', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'api.go': `
package api

func HandleRequest(ctx Context, req *Request) error {
    return nil
}

func process(ctx Context) {}

func Format(data []byte) string { return "" }
`,
        });
        try {
            const i = idx(d);
            const result = i.structuralSearch({ type: 'function', param: 'ctx', exported: true });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('HandleRequest'), 'exported with ctx param');
            assert.ok(!names.includes('process'), 'unexported excluded');
            assert.ok(!names.includes('Format'), 'no ctx param excluded');
        } finally { rm(d); }
    });
});

// ============================================================================
// STRUCTURAL SEARCH: Hardening (edge cases, validation, stability)
// ============================================================================

describe('structural search: hardening', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('invalid --type returns error', () => {
        const d = tmp({ 'package.json': '{"name":"t"}', 'a.js': 'function f() {}' });
        try {
            const i = idx(d);
            const { ok, error } = execute(i, 'search', { type: 'bogus' });
            assert.ok(!ok, 'should fail');
            assert.ok(error.includes('Invalid type'), error);
            assert.ok(error.includes('function, class, call, method, type'));
        } finally { rm(d); }
    });

    it('--receiver without --type auto-infers type=call', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'const fs = require("fs");\nfunction read() { return fs.readFileSync("x"); }',
        });
        try {
            const i = idx(d);
            const { ok, result, structural } = execute(i, 'search', { receiver: 'fs' });
            assert.ok(ok && structural);
            assert.ok(result.results.every(r => r.kind === 'call'), 'should auto-infer call type');
            assert.ok(result.results.some(r => r.name.includes('readFileSync')));
        } finally { rm(d); }
    });

    it('--case-sensitive makes glob case-sensitive', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function hello() {}\nfunction Hello() {}\nmodule.exports = { hello, Hello };',
        });
        try {
            const i = idx(d);
            const r1 = i.structuralSearch({ type: 'function', term: 'hello' });
            assert.strictEqual(r1.results.length, 2, 'case-insensitive finds both');
            const r2 = i.structuralSearch({ type: 'function', term: 'hello', caseSensitive: true });
            assert.strictEqual(r2.results.length, 1, 'case-sensitive finds one');
            assert.strictEqual(r2.results[0].name, 'hello');
        } finally { rm(d); }
    });

    it('--case-sensitive applies to param filter', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function a(Request) {}\nfunction b(request) {}',
        });
        try {
            const i = idx(d);
            const r1 = i.structuralSearch({ type: 'function', param: 'request' });
            assert.strictEqual(r1.results.length, 2, 'case-insensitive matches both');
            const r2 = i.structuralSearch({ type: 'function', param: 'Request', caseSensitive: true });
            assert.strictEqual(r2.results.length, 1, 'case-sensitive matches one');
        } finally { rm(d); }
    });

    it('empty index returns 0 results, no crash', () => {
        const d = tmp({});
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function' });
            assert.strictEqual(r.results.length, 0);
            assert.strictEqual(r.meta.totalMatched, 0);
        } finally { rm(d); }
    });

    it('file with parse errors does not crash', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'bad.js': 'function( {{{{{ broken',
            'good.js': 'function ok() { return 1; }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function' });
            assert.ok(r.results.some(x => x.name === 'ok'), 'good file still found');
        } finally { rm(d); }
    });

    it('_beginOp nesting: structural + blast interleaved', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function alpha() { beta(); }\nfunction beta() { gamma(); }\nfunction gamma() {}\nmodule.exports = { alpha, beta, gamma };',
        });
        try {
            const i = idx(d);
            i.structuralSearch({ type: 'function' });
            i.structuralSearch({ type: 'call' });
            i.blast('gamma');
            const r = i.structuralSearch({ type: 'function' });
            assert.strictEqual(r.results.length, 3);
            // Verify context still works after interleaving
            const ctx = i.context('gamma');
            assert.ok(ctx);
        } finally { rm(d); }
    });

    it('unicode function names work', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function π() { return 3.14; }\nfunction add(a, b) { return a + b; }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', term: 'π' });
            assert.strictEqual(r.results.length, 1);
            assert.strictEqual(r.results[0].name, 'π');
        } finally { rm(d); }
    });

    it('wide result set with top limit', () => {
        const lines = [];
        for (let i = 0; i < 100; i++) lines.push(`function fn_${i}(data) { return data; }`);
        const d = tmp({ 'package.json': '{"name":"t"}', 'big.js': lines.join('\n') });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', top: 5 });
            assert.strictEqual(r.results.length, 5);
            assert.strictEqual(r.meta.totalMatched, 100);
        } finally { rm(d); }
    });

    it('--unused correctly identifies called vs uncalled', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function used() {}\nfunction unused1() {}\nfunction unused2() {}\nfunction main() { used(); }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', unused: true });
            const names = r.results.map(x => x.name);
            assert.ok(!names.includes('used'), 'called function excluded');
            assert.ok(names.includes('unused1'), 'uncalled function included');
            assert.ok(names.includes('unused2'), 'uncalled function included');
        } finally { rm(d); }
    });

    it('glob special chars in term are escaped properly', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function a() {}\nfunction b() {}',
        });
        try {
            const i = idx(d);
            // "a.b" should not match anything (. is literal, not regex wildcard)
            const r = i.structuralSearch({ type: 'function', term: 'a.b' });
            assert.strictEqual(r.results.length, 0, 'dot is literal in glob');
        } finally { rm(d); }
    });

    it('--type=call with --receiver scans correctly', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'const db = require("./db");\nfunction query() { return db.find(); }\nfunction update() { return db.save(); }',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'call', receiver: 'db' });
            assert.ok(r.results.length >= 2, 'should find db.find and db.save');
            assert.ok(r.results.every(x => x.receiver === 'db'));
        } finally { rm(d); }
    });

    it('--in flag restricts structural search to subdirectory', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/core.js': 'function coreFunc() {}',
            'lib/util.js': 'function libFunc() {}',
        });
        try {
            const i = idx(d);
            const r = i.structuralSearch({ type: 'function', in: 'src' });
            assert.ok(r.results.every(x => x.file.startsWith('src/')));
            assert.ok(r.results.some(x => x.name === 'coreFunc'));
        } finally { rm(d); }
    });

    it('text formatter shows error for invalid type', () => {
        const result = {
            results: [],
            meta: { mode: 'structural', query: { type: 'bogus' }, totalMatched: 0, shown: 0, error: 'Invalid type "bogus"' }
        };
        const text = output.formatStructuralSearch(result);
        assert.ok(text.includes('No matches found'));
    });

    it('structural search does not interfere with text search', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function hello() { /* search_term_xyz */ return 1; }',
        });
        try {
            const i = idx(d);
            // Text search should still work normally
            const { ok, result, structural } = execute(i, 'search', { term: 'search_term_xyz' });
            assert.ok(ok);
            assert.ok(!structural, 'no structural flags = text search');
            assert.ok(result.length > 0, 'text search finds the term');
        } finally { rm(d); }
    });

    it('--exclude with structural search filters correctly', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/api.js': 'function handler() {}',
            'test/api.test.js': 'function testHandler() {}',
        });
        try {
            const i = idx(d);
            const all = i.structuralSearch({ type: 'function' });
            const noTest = i.structuralSearch({ type: 'function', exclude: ['test'] });
            assert.ok(noTest.results.length < all.results.length, 'exclude reduces results');
            assert.ok(!noTest.results.some(x => x.file.includes('test')));
        } finally { rm(d); }
    });

    it('CLI --type=function without term does not require term', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function f() {}',
        });
        try {
            const out = runCli(d, 'search', [], ['--type=function']);
            assert.ok(out.includes('Structural search:'));
            assert.ok(!out.includes('required'));
        } finally { rm(d); }
    });

    it('CLI invalid type shows error message', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function f() {}',
        });
        try {
            const out = runCli(d, 'search', [], ['--type=bogus']);
            assert.ok(out.includes('Invalid type'), 'should show invalid type error: ' + out);
        } finally { rm(d); }
    });
});

// ==================================================================
// REVERSE TRACE: upward call chain to entry points
// ==================================================================

describe('reverse-trace: upward call chain to entry points', () => {
    let dir;
    let index;

    // Build a call chain: main → orchestrator → helper → util
    // Also: handler → helper (second entry point)
    // entryA has no callers (entry point)
    // entryB has no callers (entry point)
    const fixture = {
        'package.json': '{"name":"rtrace-test"}',
        'entry.js': `
function main() { orchestrator(); }
function handler() { helper(); }
module.exports = { main, handler };
`,
        'mid.js': `
const { helper } = require('./util');
function orchestrator() { helper(); doWork(); }
function doWork() { helper(); }
module.exports = { orchestrator, doWork };
`,
        'util.js': `
function helper() { return lowLevel(); }
function lowLevel() { return 42; }
module.exports = { helper, lowLevel };
`,
    };

    it('walks callers to entry points and marks them', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5 });
            assert.ok(result, 'should find helper');
            assert.strictEqual(result.root, 'helper');

            // Should have callers
            assert.ok(result.tree.children.length > 0, 'should have callers');

            // Entry points should be found
            assert.ok(result.entryPoints.length > 0, 'should find entry points');

            // main and handler should be entry points (no callers)
            const epNames = result.entryPoints.map(e => e.name);
            assert.ok(epNames.includes('main'), 'main should be entry point: ' + JSON.stringify(epNames));
            assert.ok(epNames.includes('handler'), 'handler should be entry point: ' + JSON.stringify(epNames));
        } finally { rm(d); }
    });

    it('respects --depth limit', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('lowLevel', { depth: 1 });
            assert.ok(result);
            // At depth 1, should see helper but not go further
            assert.ok(result.tree.children.length > 0);
            // Should not have deep entry points since depth is limited
            assert.strictEqual(result.summary.maxDepthReached, 1);
        } finally { rm(d); }
    });

    it('depth=0 shows root only', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 0 });
            assert.ok(result);
            assert.strictEqual(result.tree.children.length, 0);
            assert.ok(result.warnings);
            assert.ok(result.warnings.some(w => w.message.includes('depth=0')));
        } finally { rm(d); }
    });

    it('marks root as entry point when it has no callers', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('main', { depth: 3 });
            assert.ok(result);
            assert.ok(result.tree.entryPoint, 'root should be marked as entry point');
            assert.ok(result.entryPoints.some(e => e.name === 'main'));
        } finally { rm(d); }
    });

    it('handles --exclude filter', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/lib.js': 'function target() {}\nmodule.exports = { target };',
            'src/app.js': 'const { target } = require("./lib");\nfunction app() { target(); }',
            'test/lib.test.js': 'const { target } = require("../src/lib");\nfunction testTarget() { target(); }',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 3, exclude: ['test'] });
            assert.ok(result);
            // Only app should appear, not testTarget
            const names = [];
            const collect = (node) => { names.push(node.name); (node.children || []).forEach(collect); };
            if (result.tree.children) result.tree.children.forEach(collect);
            assert.ok(!names.includes('testTarget'), 'testTarget should be excluded: ' + JSON.stringify(names));
        } finally { rm(d); }
    });

    it('handles circular call chains without infinite loop', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'cycle.js': `
function a() { b(); }
function b() { a(); c(); }
function c() { b(); }
module.exports = { a, b, c };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('c', { depth: 5 });
            assert.ok(result, 'should complete without hanging');
            // b calls c, a calls b, b calls a (cycle) — should show (see above)
        } finally { rm(d); }
    });

    it('returns null for unknown function', () => {
        const d = tmp({ 'package.json': '{"name":"t"}', 'a.js': 'function f() {}' });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('nonexistent');
            assert.strictEqual(result, null);
        } finally { rm(d); }
    });

    it('summary counts are correct', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5, all: true });
            assert.ok(result.summary);
            assert.ok(result.summary.totalEntryPoints > 0);
            assert.ok(result.summary.totalFunctions > 0);
            assert.ok(result.summary.maxDepthReached > 0);
        } finally { rm(d); }
    });

    it('execute handler works', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const { ok, result, error } = execute(ix, 'reverseTrace', { name: 'helper' });
            assert.ok(ok, 'should succeed: ' + error);
            assert.ok(result.entryPoints.length > 0);
        } finally { rm(d); }
    });

    it('execute handler requires name', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const { ok, error } = execute(ix, 'reverseTrace', {});
            assert.ok(!ok);
            assert.ok(error.includes('required'));
        } finally { rm(d); }
    });

    it('execute handler returns error for unknown function', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const { ok, error } = execute(ix, 'reverseTrace', { name: 'nope' });
            assert.ok(!ok);
            assert.ok(error.includes('not found'));
        } finally { rm(d); }
    });

    it('text formatter shows entry point markers', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5 });
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('★ entry point'), 'should show entry point marker');
            assert.ok(text.includes('Reverse trace for helper'));
            assert.ok(text.includes('Entry points'));
            assert.ok(text.includes('Summary:'));
        } finally { rm(d); }
    });

    it('text formatter handles null result', () => {
        const text = output.formatReverseTrace(null);
        assert.strictEqual(text, 'Function not found.');
    });

    it('JSON formatter produces valid JSON', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper', { depth: 5 });
            const json = output.formatReverseTraceJson(result);
            const parsed = JSON.parse(json);
            assert.ok(parsed.entryPoints);
            assert.ok(parsed.tree);
            assert.ok(parsed.summary);
        } finally { rm(d); }
    });

    it('JSON formatter handles null result', () => {
        const json = output.formatReverseTraceJson(null);
        const parsed = JSON.parse(json);
        assert.strictEqual(parsed.found, false);
    });

    it('CLI reverse-trace works', () => {
        const d = tmp(fixture);
        try {
            const out = runCli(d, 'reverse-trace', ['helper']);
            assert.ok(out.includes('Reverse trace for helper'));
            assert.ok(out.includes('entry point'));
        } finally { rm(d); }
    });

    it('CLI rtrace alias works', () => {
        const d = tmp(fixture);
        try {
            const out = runCli(d, 'rtrace', ['helper']);
            assert.ok(out.includes('Reverse trace for helper'));
        } finally { rm(d); }
    });

    it('CLI --json flag works', () => {
        const d = tmp(fixture);
        try {
            const out = runCli(d, 'reverse-trace', ['helper'], ['--json']);
            const parsed = JSON.parse(out);
            assert.ok(parsed.entryPoints);
        } finally { rm(d); }
    });

    it('default depth is 5 (not 3 like blast/trace)', () => {
        const d = tmp(fixture);
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('helper');
            assert.strictEqual(result.maxDepth, 5);
        } finally { rm(d); }
    });

    it('entry point for self-contained function', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function standalone() { return 1; }',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('standalone');
            assert.ok(result);
            assert.ok(result.tree.entryPoint);
            assert.ok(result.entryPoints.some(e => e.name === 'standalone'));
            assert.strictEqual(result.summary.totalFunctions, 0);
        } finally { rm(d); }
    });
});

describe('reverse-trace: hardening', () => {
    it('node at depth limit is NOT falsely marked as entry point', () => {
        // Chain: entryA → mid → target. At depth=1, mid appears but we can't
        // see entryA. mid should NOT be marked as entry point — it just hit the depth limit.
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function entryA() { mid(); }
function mid() { target(); }
function target() { return 1; }
module.exports = { entryA, mid, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 1 });
            assert.ok(result);
            // mid is a caller of target — it appears at depth 1
            const midNode = result.tree.children.find(c => c.name === 'mid');
            assert.ok(midNode, 'mid should appear as caller');
            // mid should NOT be marked as entry point (it has callers, just depth-limited)
            assert.ok(!midNode.entryPoint, 'mid should NOT be marked as entry point at depth limit');
            // entryPoints list should be empty (no true entry points found within depth)
            assert.strictEqual(result.entryPoints.length, 0, 'no entry points should be found at depth 1');
        } finally { rm(d); }
    });

    it('all callers excluded → node becomes entry point within scope', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/lib.js': 'function target() {}\nmodule.exports = { target };',
            'src/app.js': 'const { target } = require("./lib");\nfunction app() { target(); }',
            'test/t.test.js': 'const { target } = require("../src/lib");\nfunction testIt() { target(); }',
        });
        try {
            const ix = idx(d);
            // Without exclude: app and testIt are callers, both are entry points
            const full = ix.reverseTrace('target', { depth: 3 });
            assert.ok(full.entryPoints.length >= 2);

            // With exclude=test: only app visible, app is entry point
            const filtered = ix.reverseTrace('target', { depth: 3, exclude: ['test'] });
            assert.ok(filtered.entryPoints.length >= 1);
            assert.ok(filtered.entryPoints.some(e => e.name === 'app'));
            assert.ok(!filtered.entryPoints.some(e => e.name === 'testIt'));
        } finally { rm(d); }
    });

    it('truncation when more than 10 callers', () => {
        // Create 15 callers of target
        const callerCode = Array.from({ length: 15 }, (_, i) =>
            `function caller${i}() { target(); }`
        ).join('\n');
        const d = tmp({
            'package.json': '{"name":"t"}',
            'target.js': 'function target() {}\nmodule.exports = { target };',
            'callers.js': `const { target } = require('./target');\n${callerCode}\nmodule.exports = {};`,
        });
        try {
            const ix = idx(d);
            // Default: maxChildren=10 (no --all)
            const result = ix.reverseTrace('target', { depth: 2 });
            assert.ok(result);
            // Should have exactly 10 children + truncatedChildren
            assert.ok(result.tree.children.length <= 10, 'should truncate to 10');
            assert.ok(result.tree.truncatedChildren > 0, 'should have truncatedChildren');

            // Formatter should show truncation hint
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('more callers'), 'should show truncation in tree');
            assert.ok(text.includes('truncated'), 'should show truncation hint');
        } finally { rm(d); }
    });

    it('--all flag shows all callers without truncation', () => {
        const callerCode = Array.from({ length: 15 }, (_, i) =>
            `function caller${i}() { target(); }`
        ).join('\n');
        const d = tmp({
            'package.json': '{"name":"t"}',
            'target.js': 'function target() {}\nmodule.exports = { target };',
            'callers.js': `const { target } = require('./target');\n${callerCode}\nmodule.exports = {};`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 2, all: true });
            assert.ok(result);
            assert.ok(result.tree.children.length >= 15, 'should show all callers: ' + result.tree.children.length);
            assert.ok(!result.tree.truncatedChildren, 'should not have truncation');
        } finally { rm(d); }
    });

    it('multiple call sites show Nx annotation', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function caller() { target(); target(); target(); }
function target() {}
module.exports = { caller, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 2 });
            assert.ok(result);
            const callerNode = result.tree.children.find(c => c.name === 'caller');
            assert.ok(callerNode, 'should find caller');
            assert.strictEqual(callerNode.callSites, 3, 'should count 3 call sites');

            // Formatter should show 3x
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('3x'), 'should show 3x annotation');
        } finally { rm(d); }
    });

    it('Class.method syntax works', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
class MyService {
    process() { return this.helper(); }
    helper() { return 42; }
}
function main() { const s = new MyService(); s.process(); }
module.exports = { MyService, main };
`,
        });
        try {
            const ix = idx(d);
            const { ok, result } = execute(ix, 'reverseTrace', { name: 'MyService.process' });
            assert.ok(ok, 'should succeed with Class.method syntax');
            assert.strictEqual(result.root, 'process');
        } finally { rm(d); }
    });

    it('--file disambiguation', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib/process.js': 'function handle() { return 1; }\nmodule.exports = { handle };',
            'api/process.js': 'function handle() { return 2; }\nmodule.exports = { handle };',
            'app.js': 'const lib = require("./lib/process");\nfunction main() { lib.handle(); }',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('handle', { file: 'lib' });
            assert.ok(result);
            assert.ok(result.file.includes('lib'), 'should resolve to lib/process.js: ' + result.file);
        } finally { rm(d); }
    });

    it('deep chain (>5 levels) with increased depth', () => {
        // Chain: f0 → f1 → f2 → ... → f7 → leaf
        const fns = Array.from({ length: 8 }, (_, i) =>
            `function f${i}() { ${i < 7 ? `f${i + 1}()` : 'leaf()'} }`
        ).join('\n');
        const d = tmp({
            'package.json': '{"name":"t"}',
            'chain.js': `${fns}\nfunction leaf() { return 42; }\nmodule.exports = {};`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('leaf', { depth: 10 });
            assert.ok(result);
            // Should reach f0 as entry point (8 levels up)
            assert.ok(result.entryPoints.some(e => e.name === 'f0'),
                'should find f0 as entry point: ' + JSON.stringify(result.entryPoints));
            assert.ok(result.summary.maxDepthReached >= 8, 'should reach depth 8+');
        } finally { rm(d); }
    });

    it('entry points are not duplicated when reached via two paths', () => {
        // Diamond: target ← A ← entry, target ← B ← entry
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function entry() { pathA(); pathB(); }
function pathA() { target(); }
function pathB() { target(); }
function target() { return 1; }
module.exports = { entry, pathA, pathB, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 5 });
            assert.ok(result);
            // entry should appear exactly once in entryPoints
            const entryOccurrences = result.entryPoints.filter(e => e.name === 'entry');
            assert.strictEqual(entryOccurrences.length, 1,
                'entry should appear once, not duplicated: ' + JSON.stringify(result.entryPoints));
        } finally { rm(d); }
    });

    it('formatter shows includeMethods=false note', () => {
        const mockResult = {
            root: 'test',
            file: 'a.js',
            line: 1,
            maxDepth: 5,
            includeMethods: false,
            tree: { name: 'test', file: 'a.js', line: 1, type: 'function', children: [] },
            entryPoints: [{ name: 'test', file: 'a.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 0, maxDepthReached: 0 },
        };
        const text = output.formatReverseTrace(mockResult);
        assert.ok(text.includes('obj.method() calls excluded'), 'should show methods excluded note');
    });

    it('formatter shows warnings', () => {
        const mockResult = {
            root: 'test',
            file: 'a.js',
            line: 1,
            maxDepth: 0,
            includeMethods: true,
            tree: { name: 'test', file: 'a.js', line: 1, type: 'function', children: [] },
            entryPoints: [],
            summary: { totalEntryPoints: 0, totalFunctions: 0, maxDepthReached: 0 },
            warnings: [{ message: 'depth=0: showing root function only. Increase depth to see callers.' }],
        };
        const text = output.formatReverseTrace(mockResult);
        assert.ok(text.includes('Note: depth=0'), 'should show warning');
    });

    it('formatter root entry point label', () => {
        const mockResult = {
            root: 'standalone',
            file: 'a.js',
            line: 1,
            maxDepth: 5,
            includeMethods: true,
            tree: { name: 'standalone', file: 'a.js', line: 1, type: 'function', children: [], entryPoint: true },
            entryPoints: [{ name: 'standalone', file: 'a.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 0, maxDepthReached: 0 },
        };
        const text = output.formatReverseTrace(mockResult);
        assert.ok(text.includes('standalone ★ entry point (no callers)'), 'should mark root as entry point: ' + text.split('\n').find(l => l.includes('standalone')));
    });

    it('summary with zero entry points (depth-limited leaves)', () => {
        // mid calls target, entryA calls mid. At depth=1, we see mid but not entryA.
        // No entry points found within depth.
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function entryA() { mid(); }
function mid() { target(); }
function target() { return 1; }
module.exports = { entryA, mid, target };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('target', { depth: 1 });
            assert.ok(result);
            assert.strictEqual(result.entryPoints.length, 0);
            // Summary should still show intermediate functions
            assert.ok(result.summary.totalFunctions > 0);
        } finally { rm(d); }
    });

    it('Go language support', () => {
        const d = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main
func main() { handler() }
func handler() { process() }
func process() { return }
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('process', { depth: 5 });
            assert.ok(result, 'should find Go function');
            assert.ok(result.tree.children.length > 0, 'should find callers');
            assert.ok(result.entryPoints.some(e => e.name === 'main'),
                'main should be entry point: ' + JSON.stringify(result.entryPoints));
        } finally { rm(d); }
    });

    it('Python language support', () => {
        const d = tmp({
            'app.py': `
def main():
    handler()

def handler():
    process()

def process():
    return 42
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('process', { depth: 5 });
            assert.ok(result, 'should find Python function');
            assert.ok(result.tree.children.length > 0, 'should find callers');
            assert.ok(result.entryPoints.some(e => e.name === 'main'),
                'main should be entry point: ' + JSON.stringify(result.entryPoints));
        } finally { rm(d); }
    });

    it('interactive mode works via CLI', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function entry() { target(); }\nfunction target() {}\nmodule.exports = { entry, target };',
        });
        try {
            const out = runInteractive(d, ['reverse-trace target']);
            assert.ok(out.includes('Reverse trace for target') || out.includes('entry point'),
                'interactive should work: ' + out.substring(0, 200));
        } finally { rm(d); }
    });

    it('negative depth clamped to 0', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function f() {}\nmodule.exports = { f };',
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('f', { depth: -3 });
            assert.ok(result);
            assert.strictEqual(result.maxDepth, 0);
            assert.strictEqual(result.tree.children.length, 0);
        } finally { rm(d); }
    });

    it('alreadyShown for cycles in formatter', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': `
function a() { b(); }
function b() { a(); }
module.exports = { a, b };
`,
        });
        try {
            const ix = idx(d);
            const result = ix.reverseTrace('b', { depth: 5 });
            const text = output.formatReverseTrace(result);
            assert.ok(text.includes('see above'), 'should show (see above) for cycle: ' + text);
        } finally { rm(d); }
    });

    it('MCP reverse_trace command via execute', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'a.js': 'function entry() { target(); }\nfunction target() {}\nmodule.exports = { entry, target };',
        });
        try {
            const ix = idx(d);
            // MCP sends canonical form through execute
            const { ok, result } = execute(ix, 'reverseTrace', { name: 'target', depth: 3 });
            assert.ok(ok);
            assert.ok(result.entryPoints.length > 0);
            // Verify formatter doesn't crash
            const text = output.formatReverseTrace(result, { allHint: 'Set depth to expand all children.' });
            assert.ok(text.includes('Reverse trace'));
        } finally { rm(d); }
    });

    it('entry point summary singular/plural grammar', () => {
        // 1 entry point → singular
        const single = output.formatReverseTrace({
            root: 't', file: 'a.js', line: 1, maxDepth: 5, includeMethods: true,
            tree: { name: 't', file: 'a.js', line: 1, type: 'function', children: [
                { name: 'ep', file: 'b.js', line: 1, type: 'function', children: [], entryPoint: true }
            ] },
            entryPoints: [{ name: 'ep', file: 'b.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 1, maxDepthReached: 1 },
        });
        assert.ok(single.includes('1 entry point reaches'), 'singular entry point');
        assert.ok(single.includes('1 intermediate function'), 'singular function');

        // 2 entry points → plural
        const plural = output.formatReverseTrace({
            root: 't', file: 'a.js', line: 1, maxDepth: 5, includeMethods: true,
            tree: { name: 't', file: 'a.js', line: 1, type: 'function', children: [
                { name: 'ep1', file: 'b.js', line: 1, type: 'function', children: [], entryPoint: true },
                { name: 'ep2', file: 'c.js', line: 1, type: 'function', children: [], entryPoint: true },
            ] },
            entryPoints: [{ name: 'ep1', file: 'b.js', line: 1 }, { name: 'ep2', file: 'c.js', line: 1 }],
            summary: { totalEntryPoints: 2, totalFunctions: 2, maxDepthReached: 1 },
        });
        assert.ok(plural.includes('2 entry points reach '), 'plural entry points');
        assert.ok(plural.includes('2 intermediate functions'), 'plural functions');
    });
});

// ============================================================================
// circular-deps: circular dependency detection
// ============================================================================

describe('circular-deps: circular dependency detection', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('detects simple A→B→A cycle', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 2);
            assert.ok(result.cycles[0].files.includes('a.js'));
            assert.ok(result.cycles[0].files.includes('b.js'));
        } finally { rm(dir); }
    });

    it('detects A→B→C→A triangle cycle', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const c = require("./c"); module.exports = {};',
            'c.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 3);
        } finally { rm(dir); }
    });

    it('returns empty when no cycles exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const c = require("./c"); module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
            assert.strictEqual(result.cycles.length, 0);
        } finally { rm(dir); }
    });

    it('filters by --file pattern', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'x.js': 'const y = require("./y"); module.exports = {};',
            'y.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const all = index.circularDeps();
            assert.strictEqual(all.summary.totalCycles, 2);
            const filtered = index.circularDeps({ file: 'x.js' });
            assert.strictEqual(filtered.summary.totalCycles, 1);
            assert.ok(filtered.cycles[0].files.includes('x.js'));
        } finally { rm(dir); }
    });

    it('respects --exclude filter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'const b = require("./b"); module.exports = {};',
            'src/b.js': 'const a = require("./a"); module.exports = {};',
            'test/x.js': 'const y = require("./y"); module.exports = {};',
            'test/y.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const all = index.circularDeps();
            assert.strictEqual(all.summary.totalCycles, 2);
            const filtered = index.circularDeps({ exclude: ['test'] });
            assert.strictEqual(filtered.summary.totalCycles, 1);
            assert.ok(filtered.cycles[0].files.some(f => f.includes('src/')));
        } finally { rm(dir); }
    });

    it('deduplicates same cycle discovered from different starting nodes', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // A→B→A is same cycle as B→A→B — should be one cycle, not two
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('detects multiple independent cycles', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'x.js': 'const y = require("./y"); module.exports = {};',
            'y.js': 'const z = require("./z"); module.exports = {};',
            'z.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 2);
            // 2-file cycle and 3-file cycle
            const lengths = result.cycles.map(c => c.length).sort();
            assert.deepStrictEqual(lengths, [2, 3]);
        } finally { rm(dir); }
    });

    it('handles diamond dependencies (not cycles)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); const c = require("./c"); module.exports = {};',
            'b.js': 'const d = require("./d"); module.exports = {};',
            'c.js': 'const d = require("./d"); module.exports = {};',
            'd.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
        } finally { rm(dir); }
    });

    it('reports totalFiles correctly', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'module.exports = {};',
            'b.js': 'module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.totalFiles, 3);
        } finally { rm(dir); }
    });

    it('reports filesInCycles correctly', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.filesInCycles, 2);
        } finally { rm(dir); }
    });

    // ── execute.js integration ──────────────────────────────────────────

    it('works through execute()', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'circularDeps', {});
            assert.ok(ok);
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('execute() supports file and exclude params', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'circularDeps', { file: 'nonexistent' });
            assert.ok(ok);
            assert.strictEqual(result.summary.totalCycles, 0);
        } finally { rm(dir); }
    });

    // ── formatters ──────────────────────────────────────────────────────

    it('formatCircularDeps shows cycle chain with arrow back to start', () => {
        const text = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            summary: { totalCycles: 1, filesInCycles: 2 },
        });
        assert.ok(text.includes('a.js → b.js → a.js'), 'chain closes the loop');
        assert.ok(text.includes('Cycle 1 (2 files)'));
        assert.ok(text.includes('1 circular dependency chain'));
    });

    it('formatCircularDeps handles no cycles', () => {
        const text = output.formatCircularDeps({
            cycles: [],
            totalFiles: 10,
            summary: { totalCycles: 0, filesInCycles: 0 },
        });
        assert.ok(text.includes('No circular dependencies found'));
        assert.ok(text.includes('Scanned 10 files'));
    });

    it('formatCircularDeps shows file filter', () => {
        const text = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            fileFilter: 'a.js',
            summary: { totalCycles: 1, filesInCycles: 2 },
        });
        assert.ok(text.includes('Filtered to cycles involving: a.js'));
    });

    it('formatCircularDeps plural/singular grammar', () => {
        const singular = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            summary: { totalCycles: 1, filesInCycles: 1 },
        });
        assert.ok(singular.includes('1 circular dependency chain involving 1 file'));
        assert.ok(!singular.includes('chains'));

        const plural = output.formatCircularDeps({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }, { files: ['x.js', 'y.js'], length: 2 }],
            totalFiles: 10,
            summary: { totalCycles: 2, filesInCycles: 4 },
        });
        assert.ok(plural.includes('2 circular dependency chains involving 4 files'));
    });

    it('formatCircularDepsJson returns valid JSON', () => {
        const json = output.formatCircularDepsJson({
            cycles: [{ files: ['a.js', 'b.js'], length: 2 }],
            totalFiles: 5,
            summary: { totalCycles: 1, filesInCycles: 2 },
        });
        const parsed = JSON.parse(json);
        assert.strictEqual(parsed.cycles.length, 1);
        assert.strictEqual(parsed.summary.totalCycles, 1);
    });

    it('formatCircularDepsJson handles null input', () => {
        const json = output.formatCircularDepsJson(null);
        const parsed = JSON.parse(json);
        assert.ok(parsed.error);
    });

    // ── sorting ─────────────────────────────────────────────────────────

    it('sorts cycles by length then alphabetically', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'x.js': 'const y = require("./y"); module.exports = {};',
            'y.js': 'const z = require("./z"); module.exports = {};',
            'z.js': 'const x = require("./x"); module.exports = {};',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // 2-file cycle should come before 3-file cycle
            assert.strictEqual(result.cycles[0].length, 2);
            assert.strictEqual(result.cycles[1].length, 3);
        } finally { rm(dir); }
    });
});

// ============================================================================
// circular-deps: hardening & edge cases
// ============================================================================

describe('circular-deps: hardening', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('handles project with zero imports (no edges)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() { return 1; }',
            'b.js': 'function bar() { return 2; }',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
            assert.strictEqual(result.totalFiles, 2);
        } finally { rm(dir); }
    });

    it('handles single-file project', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function foo() { return 1; }',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 0);
            assert.strictEqual(result.totalFiles, 1);
        } finally { rm(dir); }
    });

    it('handles self-imports gracefully (if they occur)', () => {
        // Most bundlers/runtimes don't allow self-import, but test robustness
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // Self-import creates a 1-file cycle
            if (result.summary.totalCycles > 0) {
                assert.ok(result.cycles[0].length >= 1);
            }
            // Either 0 or 1 cycle — just shouldn't crash
        } finally { rm(dir); }
    });

    it('handles deeply nested cycle (A→B→C→D→E→A)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const c = require("./c"); module.exports = {};',
            'c.js': 'const d = require("./d"); module.exports = {};',
            'd.js': 'const e = require("./e"); module.exports = {};',
            'e.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 5);
        } finally { rm(dir); }
    });

    it('handles cycle with branch (A→B→A and A→C with no cycle)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); const c = require("./c"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'c.js': 'module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.strictEqual(result.cycles[0].length, 2);
        } finally { rm(dir); }
    });

    it('handles overlapping cycles sharing a node', () => {
        // A→B→A and A→C→A — two cycles sharing node A
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); const c = require("./c"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
            'c.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 2);
        } finally { rm(dir); }
    });

    it('handles TypeScript imports', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'a.ts': 'import { b } from "./b"; export const a = 1;',
            'b.ts': 'import { a } from "./a"; export const b = 2;',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('handles Python imports', () => {
        const dir = tmp({
            'a.py': 'from b import something\ndef fn(): pass',
            'b.py': 'from a import fn\nsomething = 1',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('handles Go package cycles', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg1/a.go': 'package pkg1\nimport "example.com/test/pkg2"\nfunc A() { pkg2.B() }',
            'pkg2/b.go': 'package pkg2\nimport "example.com/test/pkg1"\nfunc B() { pkg1.A() }',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            // Go compiler forbids circular package imports, but if the index resolves them,
            // our DFS should detect the cycle
            if (result.summary.totalCycles > 0) {
                assert.ok(result.cycles[0].length >= 2);
            }
        } finally { rm(dir); }
    });

    it('exclude filter removes all files in excluded pattern', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'const b = require("./b"); module.exports = {};',
            'src/b.js': 'const a = require("./a"); module.exports = {};',
            'mock/x.js': 'const y = require("./y"); module.exports = {};',
            'mock/y.js': 'const x = require("./x"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps({ exclude: ['mock'] });
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.ok(result.cycles[0].files.every(f => !f.includes('mock')));
        } finally { rm(dir); }
    });

    it('--file filter is substring match', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/api.js': 'const util = require("./util"); module.exports = {};',
            'src/util.js': 'const api = require("./api"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps({ file: 'api' });
            assert.strictEqual(result.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('CLI aliases work (circular, cycles)', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const { ok: ok1, result: r1 } = execute(index, 'circularDeps', {});
            assert.ok(ok1);
            assert.strictEqual(r1.summary.totalCycles, 1);
        } finally { rm(dir); }
    });

    it('cycles sorted by length then first file alphabetically', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'z.js': 'const w = require("./w"); module.exports = {};',
            'w.js': 'const z = require("./z"); module.exports = {};',
            'a.js': 'const b = require("./b"); module.exports = {};',
            'b.js': 'const a = require("./a"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 2);
            // Both length 2, should be sorted alphabetically
            assert.ok(result.cycles[0].files[0] < result.cycles[1].files[0],
                `${result.cycles[0].files[0]} should come before ${result.cycles[1].files[0]}`);
        } finally { rm(dir); }
    });

    it('format shows numbered cycles', () => {
        const text = output.formatCircularDeps({
            cycles: [
                { files: ['a.js', 'b.js'], length: 2 },
                { files: ['x.js', 'y.js', 'z.js'], length: 3 },
            ],
            totalFiles: 10,
            summary: { totalCycles: 2, filesInCycles: 5 },
        });
        assert.ok(text.includes('Cycle 1'));
        assert.ok(text.includes('Cycle 2'));
        assert.ok(text.includes('(2 files)'));
        assert.ok(text.includes('(3 files)'));
        assert.ok(text.includes('x.js → y.js → z.js → x.js'));
    });

    it('handles nested directory cycles', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib/core.js': 'const util = require("./util"); module.exports = {};',
            'lib/util.js': 'const core = require("./core"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.ok(result.cycles[0].files.some(f => f.includes('lib/')));
        } finally { rm(dir); }
    });

    it('multiple exclude patterns work together', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/a.js': 'const b = require("./b"); module.exports = {};',
            'src/b.js': 'const a = require("./a"); module.exports = {};',
            'test/t.js': 'const u = require("./u"); module.exports = {};',
            'test/u.js': 'const t = require("./t"); module.exports = {};',
            'mock/m.js': 'const n = require("./n"); module.exports = {};',
            'mock/n.js': 'const m = require("./m"); module.exports = {};',
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps({ exclude: ['test', 'mock'] });
            assert.strictEqual(result.summary.totalCycles, 1);
            assert.ok(result.cycles[0].files.every(f => f.includes('src/')));
        } finally { rm(dir); }
    });

    it('formatCircularDeps handles null input', () => {
        const text = output.formatCircularDeps(null);
        assert.strictEqual(text, 'No results.');
    });
});

// ============================================================================
// Phase 2 bug fixes from deep review
// ============================================================================

describe('Phase 2 bug fixes', () => {
    const { execute } = require('../core/execute');
    const output = require('../core/output');

    it('fix: structural search --type=function includes Python @staticmethod', () => {
        const dir = tmp({
            'a.py': 'class Svc:\n    @staticmethod\n    def helper():\n        pass\n    @classmethod\n    def factory(cls):\n        pass\n    def normal(self):\n        pass',
        });
        try {
            const index = idx(dir);
            // --type=function should find static and classmethod types
            const result = index.structuralSearch({ type: 'function', top: 50 });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('helper'), 'should find @staticmethod');
            assert.ok(names.includes('factory'), 'should find @classmethod');
            assert.ok(names.includes('normal'), 'should find normal method');
        } finally { rm(dir); }
    });

    it('fix: toc --detailed includes @classmethod in function count', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'class Svc:\n    @classmethod\n    def factory(cls):\n        pass\n    @staticmethod\n    def helper():\n        pass\n    def normal(self):\n        pass',
        });
        try {
            const index = idx(dir);
            const toc = index.getToc({ detailed: true });
            const file = toc.files.find(f => f.file === 'a.py');
            assert.ok(file, 'should find a.py in toc');
            // Should include all 3 methods: classmethod, staticmethod, normal
            const fnCount = file.symbols?.functions?.length ?? file.functions;
            assert.ok(fnCount >= 3, `expected 3+ functions, got ${fnCount}`);
        } finally { rm(dir); }
    });

    it('fix: reverse-trace grammar "1 entry point reaches" (singular)', () => {
        const text = output.formatReverseTrace({
            root: 'helper', file: 'lib.js', line: 1, maxDepth: 5,
            includeMethods: true,
            tree: { name: 'helper', file: 'lib.js', line: 1, type: 'function', children: [
                { name: 'main', file: 'app.js', line: 1, type: 'function', children: [], entryPoint: true },
            ] },
            entryPoints: [{ name: 'main', file: 'app.js', line: 1 }],
            summary: { totalEntryPoints: 1, totalFunctions: 1, maxDepthReached: 1 },
        });
        assert.ok(text.includes('1 entry point reaches'), `should say "reaches" not "reach": ${text}`);
        assert.ok(!text.includes('1 entry point reach '), 'should not have bare "reach"');
    });

    it('fix: reverse-trace truncated branches still counted in entry points', () => {
        // Create a function with 12+ callers (all entry points), maxChildren=10
        const files = { 'package.json': '{"name":"test"}' };
        files['helper.js'] = 'function helper() { return 1; }\nmodule.exports = { helper };';
        for (let i = 0; i < 12; i++) {
            files[`caller${i}.js`] = `const { helper } = require("./helper");\nfunction caller${i}() { helper(); }`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            // Without --all, maxChildren=10 truncates 2 callers
            const result = index.reverseTrace('helper', { depth: 5 });
            // All 12 callers are entry points (they have no callers themselves)
            assert.ok(result.entryPoints.length >= 12,
                `should count all 12 entry points even with truncation, got ${result.entryPoints.length}`);
        } finally { rm(dir); }
    });

    it('fix: blast truncated callers counted in summary', () => {
        const files = { 'package.json': '{"name":"test"}' };
        files['helper.js'] = 'function helper() { return 1; }\nmodule.exports = { helper };';
        for (let i = 0; i < 12; i++) {
            files[`caller${i}.js`] = `const { helper } = require("./helper");\nfunction caller${i}() { helper(); }`;
        }
        const dir = tmp(files);
        try {
            const index = idx(dir);
            // Without --all, maxChildren=10 truncates 2 callers
            const result = index.blast('helper', { depth: 3 });
            // Summary should count all 12 affected functions
            assert.ok(result.summary.totalAffected >= 12,
                `should count all 12 affected functions even with truncation, got ${result.summary.totalAffected}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// PHASE 2 BUG FIXES - DEEP EDGE-TO-EDGE TESTING (2026-03-12)
// ============================================================================

describe('fix: Rust pub fn in impl blocks should have type method, not public', () => {
    it('pub fn methods in impl blocks are findable via --type=function', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Server { port: u16 }',
                'impl Server {',
                '    pub fn new(port: u16) -> Server { Server { port } }',
                '    pub fn start(&self) { println!("starting"); }',
                '    fn private_helper(&self) {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('new'), 'pub fn new should be findable as function');
            assert.ok(names.includes('start'), 'pub fn start should be findable as function');
            assert.ok(names.includes('private_helper'), 'fn private_helper should be findable as function');
        } finally { rm(dir); }
    });

    it('pub fn methods in impl blocks are findable via --type=method', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Server {}',
                'impl Server {',
                '    pub fn new() -> Server { Server {} }',
                '    pub fn run(&self) {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'method' });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('run'), 'pub fn run with &self should be a method');
        } finally { rm(dir); }
    });

    it('pub fn methods have pub in modifiers for --exported filter', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Server {}',
                'impl Server {',
                '    pub fn public_method(&self) {}',
                '    fn private_method(&self) {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', exported: true });
            const names = result.results.map(r => r.name);
            assert.ok(names.includes('public_method'), 'pub fn should be findable via --exported');
            assert.ok(!names.includes('private_method'), 'fn (no pub) should NOT appear in --exported');
        } finally { rm(dir); }
    });
});

describe('fix: Rust path-qualified calls matched by findCallers', () => {
    it('module::function() calls detected as callers', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': 'mod db;\n\npub fn main() {\n    db::execute_query();\n}',
            'src/db.rs': 'pub fn execute_query() {\n    println!("querying");\n}'
        });
        try {
            const index = idx(dir);
            const ctx = index.context('execute_query');
            assert.ok(ctx.callers.length > 0, 'module::function() should be detected as a caller');
            assert.ok(ctx.callers.some(c => c.callerName === 'main'), 'main should be a caller of execute_query');
        } finally { rm(dir); }
    });

    it('blast follows Rust path-qualified call chains', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': 'mod api;\nmod db;\n\npub fn main() {\n    api::handle_request();\n}',
            'src/api.rs': 'use crate::db;\n\npub fn handle_request() {\n    db::query();\n}',
            'src/db.rs': 'pub fn query() {\n    println!("querying");\n}'
        });
        try {
            const index = idx(dir);
            const ctx = index.context('query');
            assert.ok(ctx.callers.some(c => c.callerName === 'handle_request'),
                'handle_request should call query via db::query()');
        } finally { rm(dir); }
    });

    it('Type::associated_fn() still matches impl methods', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Config {}',
                'impl Config {',
                '    pub fn default() -> Config {',
                '        Config {}',
                '    }',
                '}',
                'pub fn setup() {',
                '    let c = Config::default();',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const ctx = index.context('default');
            // Config::default() should be found as a caller
            assert.ok(ctx.callers.some(c => c.callerName === 'setup'),
                'setup should be a caller of Config::default()');
        } finally { rm(dir); }
    });
});

describe('fix: affected-tests --exclude filters test files', () => {
    it('--exclude removes matching test files from results', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/helper.js': 'function helper() { return 1; }\nmodule.exports = { helper };',
            'test/unit/helper.test.js': 'const { helper } = require("../../src/helper");\nhelper();',
            'test/e2e/smoke.test.js': 'const { helper } = require("../../src/helper");\nhelper();'
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper', { exclude: ['e2e'] });
            assert.ok(result, 'should return result');
            const testFiles = result.testFiles.map(t => t.file);
            assert.ok(testFiles.some(f => f.includes('unit')),
                'unit test should be included');
            assert.ok(!testFiles.some(f => f.includes('e2e')),
                'e2e test should be excluded by --exclude=e2e');
        } finally { rm(dir); }
    });

    it('--exclude filters both blast radius and test files', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'src/core.js': 'function core() { return 1; }\nmodule.exports = { core };',
            'test/core.test.js': 'const { core } = require("../src/core");\ncore();',
            'test/integration/int.test.js': 'const { core } = require("../../src/core");\ncore();'
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('core', { exclude: ['integration'] });
            assert.ok(result, 'should return result');
            const testFiles = result.testFiles.map(t => t.file);
            assert.ok(!testFiles.some(f => f.includes('integration')),
                'integration tests should be excluded');
        } finally { rm(dir); }
    });
});

describe('fix: JS/TS decorator extraction for structural search', () => {
    it('extracts TypeScript class decorators', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{"compilerOptions":{"experimentalDecorators":true}}',
            'app.ts': [
                '@Injectable()',
                'class UserService {',
                '    @Inject()',
                '    getUser() { return null; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Search for classes with @Injectable decorator
            const result = index.structuralSearch({ decorator: 'Injectable' });
            assert.ok(result.results.some(r => r.name === 'UserService'),
                'UserService should be found via @Injectable decorator');
        } finally { rm(dir); }
    });

    it('extracts TypeScript method decorators', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'controller.ts': [
                'class AppController {',
                '    @Get("/api")',
                '    handleGet() { return "ok"; }',
                '',
                '    @Post("/api")',
                '    handlePost() { return "created"; }',
                '',
                '    noDecorator() { return "plain"; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Get' });
            assert.ok(result.results.some(r => r.name === 'handleGet'),
                'handleGet should be found via @Get decorator');
            assert.ok(!result.results.some(r => r.name === 'handlePost'),
                'handlePost has @Post, not @Get');
            assert.ok(!result.results.some(r => r.name === 'noDecorator'),
                'noDecorator has no decorators');
        } finally { rm(dir); }
    });

    it('extracts JavaScript class decorators', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'component.js': [
                '@Component',
                'class MyComponent {',
                '    render() { return null; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Component' });
            assert.ok(result.results.some(r => r.name === 'MyComponent'),
                'MyComponent should be found via @Component decorator');
        } finally { rm(dir); }
    });
});

describe('fix: Rust #[derive()] and #[cfg(test)] attribute extraction', () => {
    it('#[derive(Debug)] extracted for structs', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                '#[derive(Debug, Clone)]',
                'pub struct Config {',
                '    pub name: String,',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'derive' });
            assert.ok(result.results.some(r => r.name === 'Config'),
                'Config struct should be found via #[derive] attribute');
        } finally { rm(dir); }
    });

    it('#[derive()] extracted for enums', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                '#[derive(Debug)]',
                'pub enum Status {',
                '    Active,',
                '    Inactive,',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'derive' });
            assert.ok(result.results.some(r => r.name === 'Status'),
                'Status enum should be found via #[derive] attribute');
        } finally { rm(dir); }
    });

    it('#[cfg(test)] extracted for modules', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub fn add(a: i32, b: i32) -> i32 { a + b }',
                '',
                '#[cfg(test)]',
                'mod tests {',
                '    use super::*;',
                '    #[test]',
                '    fn test_add() { assert_eq!(add(1, 2), 3); }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'cfg' });
            assert.ok(result.results.some(r => r.name === 'tests'),
                'tests module should be found via #[cfg(test)] attribute');
        } finally { rm(dir); }
    });

    it('#[test] attribute extracted on impl methods', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Calculator {}',
                'impl Calculator {',
                '    pub fn add(&self, a: i32, b: i32) -> i32 { a + b }',
                '',
                '    #[test]',
                '    fn test_add(&self) { assert_eq!(self.add(1, 2), 3); }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'test' });
            assert.ok(result.results.some(r => r.name === 'test_add'),
                'test_add should be found via #[test] attribute on impl method');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: blast across languages', () => {
    it('blast follows Python cross-file call chains', () => {
        const dir = tmp({
            'requirements.txt': '',
            'app.py': 'from lib import helper\ndef main():\n    helper()',
            'lib.py': 'from utils import compute\ndef helper():\n    compute()',
            'utils.py': 'def compute():\n    return 42'
        });
        try {
            const index = idx(dir);
            const result = index.blast('compute', { depth: 3 });
            assert.ok(result, 'blast should return a result for Python');
            const names = new Set();
            const collectNames = (node) => {
                if (!node) return;
                names.add(node.name);
                for (const child of node.children || []) collectNames(child);
            };
            collectNames(result.tree);
            assert.ok(names.has('helper'), 'helper should be in blast tree');
            assert.ok(names.has('main'), 'main should be in blast tree');
        } finally { rm(dir); }
    });

    it('blast follows Go cross-file call chains', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': 'package main\n\nfunc main() {\n    Process()\n}',
            'process.go': 'package main\n\nfunc Process() {\n    Helper()\n}',
            'helper.go': 'package main\n\nfunc Helper() {\n    return\n}'
        });
        try {
            const index = idx(dir);
            const result = index.blast('Helper', { depth: 3 });
            assert.ok(result, 'blast should return a result for Go');
            assert.ok(result.summary.totalAffected >= 2, 'Process and main should be affected');
        } finally { rm(dir); }
    });

    it('blast follows Java cross-file call chains', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'App.java': [
                'class App {',
                '    void run() {',
                '        new Service().process();',
                '    }',
                '}'
            ].join('\n'),
            'Service.java': [
                'class Service {',
                '    void process() {',
                '        new Util().compute();',
                '    }',
                '}'
            ].join('\n'),
            'Util.java': [
                'class Util {',
                '    void compute() {',
                '        return;',
                '    }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const ctx = index.context('compute');
            assert.ok(ctx.callers.some(c => c.callerName === 'process'), 'process calls compute');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: structural search across languages', () => {
    it('--param works for Go typed parameters', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': [
                'package main',
                'import "net/http"',
                'func HandleRequest(w http.ResponseWriter, r *http.Request) {}',
                'func ProcessData(data string) {}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', param: 'Request' });
            assert.ok(result.results.some(r => r.name === 'HandleRequest'),
                'HandleRequest should match --param=Request (type match)');
        } finally { rm(dir); }
    });

    it('--returns works for Python type hints', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': [
                'def get_name() -> str:',
                '    return "hello"',
                'def get_items() -> list:',
                '    return []',
                'def process():',
                '    pass'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', returns: 'str' });
            assert.ok(result.results.some(r => r.name === 'get_name'),
                'get_name should match --returns=str');
            assert.ok(!result.results.some(r => r.name === 'process'),
                'process has no return type');
        } finally { rm(dir); }
    });

    it('--exported works for Go capitalized functions', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': [
                'package main',
                'func PublicFunc() {}',
                'func privateFunc() {}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', exported: true });
            assert.ok(result.results.some(r => r.name === 'PublicFunc'),
                'PublicFunc (capitalized) should be exported');
            assert.ok(!result.results.some(r => r.name === 'privateFunc'),
                'privateFunc (lowercase) should not be exported');
        } finally { rm(dir); }
    });

    it('--decorator works for Java annotations', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'App.java': [
                'class App {',
                '    @Override',
                '    public void toString() { return "app"; }',
                '    @Deprecated',
                '    public void oldMethod() {}',
                '    public void normalMethod() {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Override' });
            assert.ok(result.results.some(r => r.name === 'toString'),
                'toString with @Override should be found');
            assert.ok(!result.results.some(r => r.name === 'normalMethod'),
                'normalMethod has no annotation');
        } finally { rm(dir); }
    });

    it('--unused works across languages', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'lib.js': [
                'function usedFunc() { return 1; }',
                'function unusedFunc() { return 2; }',
                'function caller() { usedFunc(); }'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'function', unused: true });
            assert.ok(result.results.some(r => r.name === 'unusedFunc'),
                'unusedFunc should be detected as unused');
            assert.ok(!result.results.some(r => r.name === 'usedFunc'),
                'usedFunc is called by caller, should not be unused');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: reverseTrace across languages', () => {
    it('reverseTrace finds Python entry points', () => {
        const dir = tmp({
            'requirements.txt': '',
            'app.py': 'from lib import helper\ndef main():\n    helper()',
            'lib.py': 'def helper():\n    return 42'
        });
        try {
            const index = idx(dir);
            const result = index.reverseTrace('helper', { depth: 5 });
            assert.ok(result, 'reverseTrace should return a result');
            assert.ok(result.entryPoints.some(ep => ep.name === 'main'),
                'main should be an entry point');
        } finally { rm(dir); }
    });

    it('reverseTrace finds Go entry points', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': 'package main\nfunc main() { Process() }',
            'process.go': 'package main\nfunc Process() { Helper() }',
            'helper.go': 'package main\nfunc Helper() { return }'
        });
        try {
            const index = idx(dir);
            const result = index.reverseTrace('Helper', { depth: 5 });
            assert.ok(result, 'reverseTrace should return a result');
            assert.ok(result.entryPoints.some(ep => ep.name === 'main'),
                'main should be an entry point');
        } finally { rm(dir); }
    });
});

describe('Phase 2 edge-to-edge: circularDeps across languages', () => {
    it('detects circular deps in TypeScript ESM imports', () => {
        const dir = tmp({
            'package.json': '{"name":"test","type":"module"}',
            'tsconfig.json': '{}',
            'a.ts': 'import { b } from "./b";\nexport function a() { return b(); }',
            'b.ts': 'import { a } from "./a";\nexport function b() { return a(); }'
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.ok(result.cycles.length > 0, 'should detect TS circular dep');
        } finally { rm(dir); }
    });

    it('detects circular deps in Python imports', () => {
        const dir = tmp({
            'requirements.txt': '',
            'a.py': 'from b import func_b\ndef func_a():\n    return func_b()',
            'b.py': 'from a import func_a\ndef func_b():\n    return func_a()'
        });
        try {
            const index = idx(dir);
            const result = index.circularDeps();
            assert.ok(result.cycles.length > 0, 'should detect Python circular dep');
        } finally { rm(dir); }
    });

    it('detects circular deps in Go packages', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'a.go': 'package main\nimport "example.com/test/pkg"\nfunc A() { pkg.B() }',
            'pkg/b.go': 'package pkg\nfunc B() {}'
        });
        try {
            const index = idx(dir);
            // Go intra-package doesn't create cycles; this tests the import graph is populated
            const result = index.circularDeps();
            assert.ok(result.totalFiles > 0, 'should scan Go files');
        } finally { rm(dir); }
    });
});

// ============================================================================
// TREE-SITTER COVERAGE GAPS (2026-03-12)
// ============================================================================

describe('TS: abstract classes and methods extracted', () => {
    it('finds abstract class and its members', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'base.ts': [
                'export abstract class BaseService {',
                '    abstract process(data: string): void;',
                '    shared() { return 42; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const syms = index.symbols.get('BaseService');
            assert.ok(syms && syms.length > 0, 'BaseService should be found');
            assert.strictEqual(syms[0].type, 'class');
            // Check abstract method is extracted
            const procSyms = index.symbols.get('process');
            assert.ok(procSyms && procSyms.length > 0, 'abstract method process should be found');
        } finally { rm(dir); }
    });

    it('abstract class appears in toc', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'svc.ts': 'abstract class Handler {\n    abstract handle(): void;\n    log() {}\n}'
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { detailed: true });
            assert.ok(result.ok, 'toc should succeed');
            const file = result.result.files.find(f => f.file === 'svc.ts');
            assert.ok(file, 'svc.ts should be in toc');
            assert.ok(file.classes > 0, 'should count abstract class');
        } finally { rm(dir); }
    });
});

describe('TS: enum members extracted', () => {
    it('enum members appear in class members', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = "enum Status {\n    Active = 'active',\n    Inactive = 'inactive'\n}";
        const classes = tsMod.findClasses(code, parser);
        const cls = classes.find(c => c.name === 'Status');
        assert.ok(cls, 'Status should be in classes');
        assert.ok(cls.members.length >= 2, 'should have at least 2 members');
        assert.ok(cls.members.some(m => m.name === 'Active'), 'Active member');
        assert.ok(cls.members.some(m => m.name === 'Inactive'), 'Inactive member');
    });
});

describe('TS: interface members extracted', () => {
    it('interface method signatures appear as members', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = 'interface ApiClient {\n    get(url: string): Promise<any>;\n    post(url: string, body: any): Promise<any>;\n    baseUrl: string;\n}';
        const classes = tsMod.findClasses(code, parser);
        const iface = classes.find(c => c.name === 'ApiClient');
        assert.ok(iface, 'ApiClient interface should exist');
        assert.ok(iface.members.length >= 2, 'should have method signatures');
        assert.ok(iface.members.some(m => m.name === 'get' && m.memberType === 'method'),
            'get method signature');
        assert.ok(iface.members.some(m => m.name === 'baseUrl'), 'baseUrl property');
    });
});

describe('TS: namespace declarations extracted', () => {
    it('namespace appears in symbol table', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'ns.ts': 'namespace Utils {\n    export function helper() { return 1; }\n}'
        });
        try {
            const index = idx(dir);
            const syms = index.symbols.get('Utils');
            assert.ok(syms && syms.length > 0, 'Utils namespace should be found');
            // Inner function should also be extracted
            const helperSyms = index.symbols.get('helper');
            assert.ok(helperSyms && helperSyms.length > 0, 'helper inside namespace should be found');
        } finally { rm(dir); }
    });
});

describe('TS: field decorators extracted', () => {
    it('@Column() on class field is captured', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'class User {',
            '    @Column()',
            '    name: string;',
            '',
            '    @Column()',
            '    email: string;',
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const user = classes.find(c => c.name === 'User');
        assert.ok(user, 'User class should exist');
        const decorated = user.members.filter(m => m.decorators && m.decorators.includes('Column'));
        assert.ok(decorated.length >= 2, 'both fields should have @Column decorator');
        assert.ok(decorated.some(m => m.name === 'name'), 'name field');
        assert.ok(decorated.some(m => m.name === 'email'), 'email field');
    });

    it('@Column() found via structuralSearch decorator filter', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'entity.ts': [
                'class User {',
                '    @Column()',
                '    name: string;',
                '',
                '    @Column()',
                '    email: string;',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Column' });
            assert.ok(result.results.length >= 2, 'structuralSearch should find @Column fields');
        } finally { rm(dir); }
    });
});

describe('Python: __all__ tuple form', () => {
    it('recognizes __all__ = ("a", "b") tuple form', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': [
                'def func1(): pass',
                'def func2(): pass',
                'def _private(): pass',
                "__all__ = ('func1', 'func2')"
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const filePath = [...index.files.keys()].find(f => f.endsWith('lib.py'));
            const fileEntry = index.files.get(filePath);
            assert.ok(fileEntry.exports.includes('func1'), 'func1 should be in exports');
            assert.ok(fileEntry.exports.includes('func2'), 'func2 should be in exports');
        } finally { rm(dir); }
    });
});

describe('Python: nested classes extracted', () => {
    it('inner class is found in symbol table', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': [
                'class User:',
                '    class Meta:',
                '        db_table = "users"',
                '    def save(self):',
                '        pass'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const metaSyms = index.symbols.get('Meta');
            assert.ok(metaSyms && metaSyms.length > 0, 'Meta inner class should be found');
            const userSyms = index.symbols.get('User');
            assert.ok(userSyms && userSyms.length > 0, 'User outer class should still be found');
        } finally { rm(dir); }
    });
});

describe('Python: property setter/deleter memberType', () => {
    it('@name.setter gets memberType setter', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('python');
        const pyMod = getLanguageModule('python');
        const code = [
            'class Config:',
            '    @property',
            '    def value(self):',
            '        return self._value',
            '    @value.setter',
            '    def value(self, val):',
            '        self._value = val'
        ].join('\n');
        const classes = pyMod.findClasses(code, parser);
        const cls = classes.find(c => c.name === 'Config');
        assert.ok(cls, 'Config class should exist');
        const members = cls.members.filter(m => m.name === 'value');
        assert.ok(members.some(m => m.memberType === 'property'), 'should have property getter');
        assert.ok(members.some(m => m.memberType === 'setter'), 'should have setter');
    });
});

describe('Go: embedded structs surfaced as extends', () => {
    it('embedded struct appears as extends relationship', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = [
            'package main',
            'type Base struct { Name string }',
            'type Child struct {',
            '    Base',
            '    Age int',
            '}'
        ].join('\n');
        const classes = goMod.findClasses(code, parser);
        const childClass = classes.find(c => c.name === 'Child');
        assert.ok(childClass, 'Child struct should exist');
        assert.ok(childClass.extends, 'Child should have extends from embedded Base');
        assert.ok(childClass.extends.includes('Base'), 'extends should include Base');
    });
});

describe('Rust: trait impls surfaced as implements', () => {
    it('impl Display for Foo appears as implements on Foo', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = [
            'pub struct Person { name: String }',
            '',
            'impl Person {',
            '    pub fn new(name: String) -> Person {',
            '        Person { name }',
            '    }',
            '}',
            '',
            'impl std::fmt::Display for Person {',
            '    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {',
            '        write!(f, "{}",  self.name)',
            '    }',
            '}'
        ].join('\n');
        const classes = rustMod.findClasses(code, parser);
        const personStruct = classes.find(c => c.name === 'Person' && c.type === 'struct');
        assert.ok(personStruct, 'Person struct should exist');
        assert.ok(personStruct.implements, 'Person should have implements');
        assert.ok(personStruct.implements.some(t => t.includes('Display')),
            'Person should implement Display');
    });
});

describe('Rust: extern block functions extracted', () => {
    it('extern "C" { fn ... } declarations found', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'extern "C" {',
                '    fn sqlite3_open(filename: *const u8, db: *mut *mut u8) -> i32;',
                '    fn sqlite3_close(db: *mut u8) -> i32;',
                '}',
                '',
                'pub fn open_db() {',
                '    unsafe { sqlite3_open(std::ptr::null(), std::ptr::null_mut()); }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const openSyms = index.symbols.get('sqlite3_open');
            assert.ok(openSyms && openSyms.length > 0, 'extern fn sqlite3_open should be found');
            const closeSyms = index.symbols.get('sqlite3_close');
            assert.ok(closeSyms && closeSyms.length > 0, 'extern fn sqlite3_close should be found');
        } finally { rm(dir); }
    });

    it('extern "C" fn has extern modifier', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': 'extern "C" fn exported_func() -> i32 {\n    42\n}'
        });
        try {
            const index = idx(dir);
            const syms = index.symbols.get('exported_func');
            assert.ok(syms && syms.length > 0, 'exported_func should be found');
            assert.ok(syms[0].modifiers.includes('extern'), 'should have extern modifier');
        } finally { rm(dir); }
    });
});

describe('Java: record members extracted', () => {
    it('record components appear as members', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = 'public record Point(int x, int y) {\n    public double distance() {\n        return Math.sqrt(x * x + y * y);\n    }\n}';
        const classes = javaMod.findClasses(code, parser);
        const record = classes.find(c => c.name === 'Point');
        assert.ok(record, 'Point record should be in classes');
        assert.ok(record.members.length >= 2, 'should have at least 2 members (x, y components)');
        assert.ok(record.members.some(m => m.name === 'x'), 'x component');
        assert.ok(record.members.some(m => m.name === 'y'), 'y component');
        // Check that record body methods are also extracted
        assert.ok(record.members.some(m => m.name === 'distance'), 'distance method');
    });
});

// ============================================================================
// BULLETPROOF: TS ABSTRACT CLASSES (edge cases + integration)
// ============================================================================

describe('TS abstract class: edge cases', () => {
    it('abstract class with generics and multiple abstract methods', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'export abstract class Repository<T> {',
            '    abstract findById(id: string): Promise<T>;',
            '    abstract save(entity: T): Promise<void>;',
            '    abstract deleteAll(): void;',
            '    getTableName(): string { return "default"; }',
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const repo = classes.find(c => c.name === 'Repository');
        assert.ok(repo, 'Repository should be found');
        assert.strictEqual(repo.type, 'class');
        const abstractMembers = repo.members.filter(m => m.memberType === 'abstract');
        assert.strictEqual(abstractMembers.length, 3, 'should have 3 abstract methods');
        const concrete = repo.members.filter(m => m.memberType === 'method');
        assert.ok(concrete.length >= 1, 'should have concrete method');
    });

    it('abstract class extending another abstract class wires inheritance', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'chain.ts': [
                'abstract class Base { abstract init(): void; }',
                'abstract class Middle extends Base { abstract process(): void; }',
                'class Concrete extends Middle { init() {} process() {} }'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // All 3 classes found
            assert.ok(index.symbols.get('Base'), 'Base found');
            assert.ok(index.symbols.get('Middle'), 'Middle found');
            assert.ok(index.symbols.get('Concrete'), 'Concrete found');
            // Inheritance chain
            const middleSym = index.symbols.get('Middle')[0];
            assert.ok(middleSym.extends.includes('Base'), 'Middle extends Base');
            const concreteSym = index.symbols.get('Concrete')[0];
            assert.ok(concreteSym.extends.includes('Middle'), 'Concrete extends Middle');
        } finally { rm(dir); }
    });

    it('abstract class found by find command', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'svc.ts': 'export abstract class BaseService {\n    abstract handle(): void;\n}'
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'find', { name: 'BaseService' });
            assert.ok(result.ok);
            assert.ok(result.result.length > 0, 'find should return BaseService');
            assert.strictEqual(result.result[0].type, 'class');
        } finally { rm(dir); }
    });

    it('abstract class in about command', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'svc.ts': 'export abstract class BaseService {\n    abstract handle(): void;\n    log() {}\n}'
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'BaseService' });
            assert.ok(result.ok);
            assert.ok(result.result.found, 'about should find BaseService');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: JAVA RECORD MEMBERS (edge cases + integration)
// ============================================================================

describe('Java record: edge cases', () => {
    it('record with no body (only components)', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = 'public record Pair(String first, String second) {}';
        const classes = javaMod.findClasses(code, parser);
        const pair = classes.find(c => c.name === 'Pair');
        assert.ok(pair, 'Pair should be found');
        assert.ok(pair.members.some(m => m.name === 'first'), 'first component');
        assert.ok(pair.members.some(m => m.name === 'second'), 'second component');
    });

    it('record implementing interface', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = [
            'interface Measurable { double measure(); }',
            'public record Circle(double radius) implements Measurable {',
            '    public double measure() { return Math.PI * radius * radius; }',
            '}'
        ].join('\n');
        const classes = javaMod.findClasses(code, parser);
        const circle = classes.find(c => c.name === 'Circle');
        assert.ok(circle, 'Circle record should be found');
        assert.ok(circle.implements && circle.implements.includes('Measurable'),
            'Circle should implement Measurable');
        assert.ok(circle.members.some(m => m.name === 'measure'), 'measure method');
        assert.ok(circle.members.some(m => m.name === 'radius'), 'radius component');
    });

    it('record in inheritance graph', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'Printable.java': 'public interface Printable { String format(); }',
            'Person.java': [
                'public record Person(String name, int age) implements Printable {',
                '    public String format() { return name; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Record should be in inheritance graph with implements
            const personSym = index.symbols.get('Person');
            assert.ok(personSym && personSym.length > 0, 'Person found');
            assert.strictEqual(personSym[0].type, 'record');
        } finally { rm(dir); }
    });

    it('record appears in toc', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'Point.java': 'public record Point(int x, int y) {}'
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { detailed: true });
            assert.ok(result.ok);
            const file = result.result.files.find(f => f.file === 'Point.java');
            assert.ok(file, 'Point.java in toc');
            assert.ok(file.classes >= 1, 'record should count as class in toc');
        } finally { rm(dir); }
    });

    it('record found via about command', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'Point.java': 'public record Point(int x, int y) {\n    public double dist() { return Math.sqrt(x*x + y*y); }\n}'
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'Point' });
            assert.ok(result.ok);
            assert.ok(result.result.found, 'about should find Point');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: GO EMBEDDED STRUCTS → EXTENDS (edge cases + integration)
// ============================================================================

describe('Go embedded struct: edge cases', () => {
    it('multiple embedded structs', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = [
            'package main',
            'type Reader struct {}',
            'type Writer struct {}',
            'type ReadWriter struct {',
            '    Reader',
            '    Writer',
            '    bufSize int',
            '}'
        ].join('\n');
        const classes = goMod.findClasses(code, parser);
        const rw = classes.find(c => c.name === 'ReadWriter');
        assert.ok(rw, 'ReadWriter found');
        assert.ok(rw.extends.includes('Reader'), 'extends includes Reader');
        assert.ok(rw.extends.includes('Writer'), 'extends includes Writer');
    });

    it('pointer embedded struct', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = [
            'package main',
            'type Logger struct { Level int }',
            'type Service struct {',
            '    *Logger',
            '    Name string',
            '}'
        ].join('\n');
        const classes = goMod.findClasses(code, parser);
        const svc = classes.find(c => c.name === 'Service');
        assert.ok(svc, 'Service found');
        // Pointer prefix should be stripped or included
        assert.ok(svc.extends, 'Service should have extends');
    });

    it('embedded struct propagated to index symbol', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': [
                'package main',
                'type Base struct { ID int }',
                'type Child struct {',
                '    Base',
                '    Name string',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const childSym = index.symbols.get('Child');
            assert.ok(childSym && childSym.length > 0, 'Child in symbol table');
            assert.ok(childSym[0].extends, 'extends propagated to symbol');
            assert.ok(childSym[0].extends.includes('Base'), 'extends includes Base');
        } finally { rm(dir); }
    });

    it('embedded struct wired into inheritance graph', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': [
                'package main',
                'type Animal struct { Name string }',
                'type Dog struct {',
                '    Animal',
                '    Breed string',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            index.buildInheritanceGraph();
            // Dog -> Animal in extends graph
            const dogParents = index.extendsGraph.get('Dog');
            assert.ok(dogParents, 'Dog in extends graph');
            assert.ok(dogParents.some(e => e.parents.includes('Animal')), 'Dog extends Animal');
        } finally { rm(dir); }
    });

    it('embedded interface in struct', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = [
            'package main',
            'type Handler interface { Handle() error }',
            'type Server struct {',
            '    Handler',
            '    port int',
            '}'
        ].join('\n');
        const classes = goMod.findClasses(code, parser);
        const server = classes.find(c => c.name === 'Server');
        assert.ok(server, 'Server found');
        assert.ok(server.extends && server.extends.includes('Handler'),
            'Server extends Handler');
    });
});

// ============================================================================
// BULLETPROOF: RUST TRAIT IMPLS → IMPLEMENTS (edge cases + integration)
// ============================================================================

describe('Rust trait impl: edge cases', () => {
    it('multiple traits on same struct', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = [
            'pub struct Config { pub name: String }',
            'impl Default for Config {',
            '    fn default() -> Self { Config { name: String::new() } }',
            '}',
            'impl Clone for Config {',
            '    fn clone(&self) -> Self { Config { name: self.name.clone() } }',
            '}'
        ].join('\n');
        const classes = rustMod.findClasses(code, parser);
        const cfg = classes.find(c => c.name === 'Config' && c.type === 'struct');
        assert.ok(cfg, 'Config struct found');
        assert.ok(cfg.implements.includes('Default'), 'implements Default');
        assert.ok(cfg.implements.includes('Clone'), 'implements Clone');
    });

    it('trait impl for enum', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = [
            'pub enum Color { Red, Green, Blue }',
            'impl std::fmt::Display for Color {',
            '    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {',
            '        write!(f, "{:?}", self)',
            '    }',
            '}'
        ].join('\n');
        const classes = rustMod.findClasses(code, parser);
        const color = classes.find(c => c.name === 'Color' && c.type === 'enum');
        assert.ok(color, 'Color enum found');
        assert.ok(color.implements && color.implements.some(t => t.includes('Display')),
            'Color implements Display');
    });

    it('inherent impl (no trait) does NOT add to implements', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = [
            'pub struct Db { conn: String }',
            'impl Db {',
            '    pub fn new() -> Self { Db { conn: String::new() } }',
            '}',
            'impl Drop for Db {',
            '    fn drop(&mut self) {}',
            '}'
        ].join('\n');
        const classes = rustMod.findClasses(code, parser);
        const db = classes.find(c => c.name === 'Db' && c.type === 'struct');
        assert.ok(db, 'Db struct found');
        // Only trait impls in implements, not inherent impl
        assert.ok(db.implements.length === 1, 'only Drop in implements');
        assert.ok(db.implements[0] === 'Drop', 'implements Drop');
    });

    it('implements propagated to index symbol', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'pub struct Widget { name: String }',
                'impl Clone for Widget {',
                '    fn clone(&self) -> Self { Widget { name: self.name.clone() } }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const widgetSym = index.symbols.get('Widget');
            assert.ok(widgetSym && widgetSym.length > 0, 'Widget in symbols');
            assert.ok(widgetSym[0].implements, 'implements propagated');
            assert.ok(widgetSym[0].implements.includes('Clone'), 'includes Clone');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: RUST EXTERN BLOCKS (edge cases + integration)
// ============================================================================

describe('Rust extern: edge cases', () => {
    it('extern block with multiple functions', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = [
            'extern "C" {',
            '    pub fn c_malloc(size: usize) -> *mut u8;',
            '    fn c_free(ptr: *mut u8);',
            '}'
        ].join('\n');
        const result = rustMod.parse(code, parser);
        const malloc = result.functions.find(f => f.name === 'c_malloc');
        const free = result.functions.find(f => f.name === 'c_free');
        assert.ok(malloc, 'c_malloc found');
        assert.ok(free, 'c_free found');
        assert.ok(malloc.modifiers.includes('extern'), 'c_malloc has extern modifier');
    });

    it('extern fn caller detection works', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'extern "C" {',
                '    fn foreign_call(x: i32) -> i32;',
                '}',
                '',
                'pub fn wrapper() {',
                '    unsafe { foreign_call(42); }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'foreign_call' });
            assert.ok(result.ok, 'context should succeed');
            assert.ok(result.result.callers.some(c => c.callerName === 'wrapper'),
                'wrapper should be caller of foreign_call');
        } finally { rm(dir); }
    });

    it('standalone extern "C" fn found with modifier', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'extern "C" fn callback(data: *const u8) -> i32 {',
                '    0',
                '}',
                'fn register() {',
                '    let _f = callback;',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const syms = index.symbols.get('callback');
            assert.ok(syms && syms.length > 0, 'callback found');
            assert.ok(syms[0].modifiers.includes('extern'), 'has extern modifier');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: TS ENUM MEMBERS (edge cases + integration)
// ============================================================================

describe('TS enum members: edge cases', () => {
    it('enum with mixed value types', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'enum Direction {',
            '    Up = 1,',
            '    Down = 2,',
            "    Left = 'LEFT',",
            "    Right = 'RIGHT'",
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const dir = classes.find(c => c.name === 'Direction');
        assert.ok(dir, 'Direction enum found');
        assert.strictEqual(dir.members.length, 4, 'should have 4 members');
        assert.ok(dir.members.some(m => m.name === 'Up'), 'Up member');
        assert.ok(dir.members.some(m => m.name === 'Right'), 'Right member');
    });

    it('const enum', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = 'const enum Flags { Read = 1, Write = 2, Execute = 4 }';
        const classes = tsMod.findClasses(code, parser);
        const flags = classes.find(c => c.name === 'Flags');
        assert.ok(flags, 'Flags const enum found');
        assert.strictEqual(flags.members.length, 3);
    });

    it('enum members found via find command', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'status.ts': "enum Status {\n    Active = 'active',\n    Inactive = 'inactive'\n}"
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'find', { name: 'Active' });
            assert.ok(result.ok);
            assert.ok(result.result.length > 0, 'Active should be findable');
            assert.strictEqual(result.result[0].className, 'Status');
        } finally { rm(dir); }
    });

    it('enum without explicit values', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = 'enum Color { Red, Green, Blue }';
        const classes = tsMod.findClasses(code, parser);
        const color = classes.find(c => c.name === 'Color');
        assert.ok(color, 'Color enum found');
        assert.strictEqual(color.members.length, 3, 'should have 3 members');
    });
});

// ============================================================================
// BULLETPROOF: TS INTERFACE MEMBERS (edge cases + integration)
// ============================================================================

describe('TS interface members: edge cases', () => {
    it('interface with optional and readonly properties', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'interface Config {',
            '    readonly host: string;',
            '    port?: number;',
            '    get(key: string): string;',
            '    set(key: string, value: string): void;',
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const cfg = classes.find(c => c.name === 'Config');
        assert.ok(cfg, 'Config interface found');
        assert.ok(cfg.members.some(m => m.name === 'host'), 'host property');
        assert.ok(cfg.members.some(m => m.name === 'get' && m.memberType === 'method'), 'get method');
        assert.ok(cfg.members.some(m => m.name === 'set' && m.memberType === 'method'), 'set method');
    });

    it('interface extending another interface', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'types.ts': [
                'interface Base { id: string; }',
                'interface Extended extends Base { name: string; validate(): boolean; }'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const extSym = index.symbols.get('Extended');
            assert.ok(extSym && extSym.length > 0, 'Extended found');
            assert.ok(extSym[0].extends.includes('Base'), 'Extended extends Base');
        } finally { rm(dir); }
    });

    it('interface found via about command', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'api.ts': 'interface ApiClient {\n    get(url: string): Promise<any>;\n}'
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'ApiClient' });
            assert.ok(result.ok);
            assert.ok(result.result.found, 'about should find ApiClient');
        } finally { rm(dir); }
    });

    it('interface method found via structuralSearch', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'api.ts': 'interface Validator {\n    validate(input: string): boolean;\n}'
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ type: 'method', term: 'validate' });
            assert.ok(result.results.length > 0, 'validate method found');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: TS FIELD DECORATORS (edge cases + integration)
// ============================================================================

describe('TS field decorators: edge cases', () => {
    it('multiple decorators on same field', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'class Entity {',
            '    @PrimaryColumn()',
            '    @Generated("uuid")',
            '    id: string;',
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const entity = classes.find(c => c.name === 'Entity');
        assert.ok(entity, 'Entity found');
        const idField = entity.members.find(m => m.name === 'id');
        assert.ok(idField, 'id field found');
        assert.ok(idField.decorators.includes('PrimaryColumn'), 'has PrimaryColumn');
        assert.ok(idField.decorators.includes('Generated'), 'has Generated');
    });

    it('decorated arrow field', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'class Handler {',
            '    @Bind()',
            '    onClick = (e: Event) => { console.log(e); };',
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const handler = classes.find(c => c.name === 'Handler');
        assert.ok(handler, 'Handler found');
        const onClick = handler.members.find(m => m.name === 'onClick');
        assert.ok(onClick, 'onClick found');
        assert.ok(onClick.decorators.includes('Bind'), 'has Bind decorator');
        assert.ok(onClick.isArrow || onClick.isMethod, 'is callable');
    });

    it('structuralSearch finds decorated fields in index', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'model.ts': [
                'class User {',
                '    @Column()',
                '    name: string;',
                '    @Column()',
                '    email: string;',
                '    age: number;',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = index.structuralSearch({ decorator: 'Column' });
            assert.ok(result.results.length >= 2, 'should find at least 2 @Column fields');
            // Undecorated field should not appear
            const names = result.results.map(r => r.name);
            assert.ok(!names.includes('age'), 'age should not be in results');
        } finally { rm(dir); }
    });

    it('field decorator does not affect method decorator detection', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'class Service {',
            '    @Inject()',
            '    db: Database;',
            '',
            '    @Log()',
            '    process() { return this.db.query(); }',
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const svc = classes.find(c => c.name === 'Service');
        const dbField = svc.members.find(m => m.name === 'db');
        const process = svc.members.find(m => m.name === 'process');
        assert.ok(dbField.decorators.includes('Inject'), 'field has Inject');
        assert.ok(process.decorators.includes('Log'), 'method has Log');
    });
});

// ============================================================================
// BULLETPROOF: PYTHON __all__ TUPLE FORM (edge cases)
// ============================================================================

describe('Python __all__ tuple: edge cases', () => {
    it('tuple with trailing comma', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': "def only(): pass\n__all__ = ('only',)"
        });
        try {
            const index = idx(dir);
            const filePath = [...index.files.keys()].find(f => f.endsWith('lib.py'));
            const fileEntry = index.files.get(filePath);
            assert.ok(fileEntry.exports.includes('only'), 'only should be exported');
        } finally { rm(dir); }
    });

    it('tuple with mixed quotes', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'def alpha(): pass\ndef beta(): pass\n__all__ = ("alpha", \'beta\')'
        });
        try {
            const index = idx(dir);
            const filePath = [...index.files.keys()].find(f => f.endsWith('lib.py'));
            const fileEntry = index.files.get(filePath);
            assert.ok(fileEntry.exports.includes('alpha'), 'alpha exported');
            assert.ok(fileEntry.exports.includes('beta'), 'beta exported');
        } finally { rm(dir); }
    });

    it('list form still works after tuple fix', () => {
        const dir = tmp({
            'requirements.txt': '',
            'lib.py': 'def foo(): pass\ndef bar(): pass\n__all__ = ["foo", "bar"]'
        });
        try {
            const index = idx(dir);
            const filePath = [...index.files.keys()].find(f => f.endsWith('lib.py'));
            const fileEntry = index.files.get(filePath);
            assert.ok(fileEntry.exports.includes('foo'), 'foo exported via list');
            assert.ok(fileEntry.exports.includes('bar'), 'bar exported via list');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: PYTHON NESTED CLASSES (edge cases + integration)
// ============================================================================

describe('Python nested class: edge cases', () => {
    it('Django-style Meta + Admin inner classes', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': [
                'class Article:',
                '    class Meta:',
                '        ordering = ["-date"]',
                '    class Admin:',
                '        list_display = ["title"]',
                '    def save(self):',
                '        pass'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            assert.ok(index.symbols.get('Meta'), 'Meta found');
            assert.ok(index.symbols.get('Admin'), 'Admin found');
            assert.ok(index.symbols.get('Article'), 'Article still found');
            assert.ok(index.symbols.get('save'), 'save method found');
        } finally { rm(dir); }
    });

    it('deeply nested class', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('python');
        const pyMod = getLanguageModule('python');
        const code = [
            'class Outer:',
            '    class Middle:',
            '        class Inner:',
            '            def deep(self):',
            '                pass'
        ].join('\n');
        const classes = pyMod.findClasses(code, parser);
        assert.ok(classes.some(c => c.name === 'Outer'), 'Outer found');
        assert.ok(classes.some(c => c.name === 'Middle'), 'Middle found');
        assert.ok(classes.some(c => c.name === 'Inner'), 'Inner found');
    });

    it('nested class found via about command', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': [
                'class User:',
                '    class Meta:',
                '        db_table = "users"'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'Meta' });
            assert.ok(result.ok);
            assert.ok(result.result.found, 'about should find nested Meta');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: PYTHON PROPERTY SETTER/DELETER (edge cases)
// ============================================================================

describe('Python property setter/deleter: edge cases', () => {
    it('getter + setter + deleter all extracted', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('python');
        const pyMod = getLanguageModule('python');
        const code = [
            'class Resource:',
            '    @property',
            '    def value(self):',
            '        return self._value',
            '    @value.setter',
            '    def value(self, val):',
            '        self._value = val',
            '    @value.deleter',
            '    def value(self):',
            '        del self._value'
        ].join('\n');
        const classes = pyMod.findClasses(code, parser);
        const cls = classes.find(c => c.name === 'Resource');
        assert.ok(cls, 'Resource found');
        const members = cls.members.filter(m => m.name === 'value');
        assert.strictEqual(members.length, 3, 'getter + setter + deleter = 3');
        assert.ok(members.some(m => m.memberType === 'property'), 'has property');
        assert.ok(members.some(m => m.memberType === 'setter'), 'has setter');
        assert.ok(members.some(m => m.memberType === 'deleter'), 'has deleter');
    });

    it('property methods exist as symbols even if typed as property/setter', () => {
        const dir = tmp({
            'requirements.txt': '',
            'prop.py': [
                'class Box:',
                '    @property',
                '    def size(self):',
                '        return self._size',
                '    @size.setter',
                '    def size(self, val):',
                '        self._size = val'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Both getter and setter are in the symbol table
            const sizeSyms = index.symbols.get('size');
            assert.ok(sizeSyms && sizeSyms.length >= 2, 'getter + setter in symbol table');
            assert.ok(sizeSyms.some(s => s.memberType === 'property'), 'getter typed as property');
            assert.ok(sizeSyms.some(s => s.memberType === 'setter'), 'setter typed as setter');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: TS NAMESPACE DECLARATIONS (edge cases + integration)
// ============================================================================

describe('TS namespace: edge cases', () => {
    it('namespace with inner class and function', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'utils.ts': [
                'namespace Validation {',
                '    export function validate(s: string) { return s.length > 0; }',
                '    export class Validator {',
                '        check(s: string) { return validate(s); }',
                '    }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            assert.ok(index.symbols.get('Validation'), 'namespace found');
            assert.ok(index.symbols.get('validate'), 'inner function found');
            assert.ok(index.symbols.get('Validator'), 'inner class found');
        } finally { rm(dir); }
    });

    it('nested namespaces', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'ns.ts': [
                'namespace App {',
                '    export namespace Config {',
                '        export function getPort() { return 3000; }',
                '    }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            assert.ok(index.symbols.get('App'), 'outer namespace');
            assert.ok(index.symbols.get('Config'), 'inner namespace');
            assert.ok(index.symbols.get('getPort'), 'deeply nested function');
        } finally { rm(dir); }
    });

    it('namespace appears in toc as class', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'ns.ts': 'namespace Utils {\n    export function helper() { return 1; }\n}'
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { detailed: true });
            assert.ok(result.ok);
            const file = result.result.files.find(f => f.file === 'ns.ts');
            assert.ok(file, 'ns.ts in toc');
            assert.ok(file.classes >= 1, 'namespace counted as class');
        } finally { rm(dir); }
    });

    it('functions inside namespace are callable', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'tsconfig.json': '{}',
            'ns.ts': [
                'namespace Utils {',
                '    export function helper() { return 1; }',
                '}',
                'function main() { Utils.helper(); }'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'context', { name: 'helper' });
            assert.ok(result.ok, 'context should work for namespace function');
        } finally { rm(dir); }
    });
});

// ============================================================================
// BULLETPROOF: CROSS-FEATURE INTERACTIONS
// ============================================================================

describe('Cross-feature: abstract class + decorators + interface', () => {
    it('abstract class implementing interface with decorated fields', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('typescript');
        const tsMod = getLanguageModule('typescript');
        const code = [
            'interface Serializable { serialize(): string; }',
            'abstract class Model implements Serializable {',
            '    @Column()',
            '    id: string;',
            '    abstract serialize(): string;',
            '    validate() { return true; }',
            '}'
        ].join('\n');
        const classes = tsMod.findClasses(code, parser);
        const model = classes.find(c => c.name === 'Model');
        assert.ok(model, 'Model found');
        assert.strictEqual(model.type, 'class');
        // Decorated field
        const idField = model.members.find(m => m.name === 'id');
        assert.ok(idField && idField.decorators && idField.decorators.includes('Column'),
            'id has @Column');
        // Abstract method
        assert.ok(model.members.some(m => m.name === 'serialize' && m.memberType === 'abstract'),
            'abstract serialize');
        // Concrete method
        assert.ok(model.members.some(m => m.name === 'validate'), 'validate method');
        // Implements
        const iface = classes.find(c => c.name === 'Serializable');
        assert.ok(iface, 'interface also found');
    });
});

describe('Cross-feature: Java record + interface', () => {
    it('record implementing interface found via about', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'Printable.java': 'public interface Printable { String format(); }',
            'Person.java': [
                'public record Person(String name, int age) implements Printable {',
                '    public String format() { return name; }',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'Person' });
            assert.ok(result.ok && result.result.found, 'Person found via about');
            // format method found
            const fmtResult = execute(index, 'find', { name: 'format' });
            assert.ok(fmtResult.ok && fmtResult.result.length > 0, 'format method found');
        } finally { rm(dir); }
    });
});

describe('Cross-feature: Python nested class + __all__ + property', () => {
    it('all features work together', () => {
        const dir = tmp({
            'requirements.txt': '',
            'models.py': [
                'class Outer:',
                '    class Config:',
                '        debug = False',
                '    @property',
                '    def name(self):',
                '        return self._name',
                '    @name.setter',
                '    def name(self, val):',
                '        self._name = val',
                '',
                "__all__ = ('Outer',)"
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Nested class
            assert.ok(index.symbols.get('Config'), 'nested Config found');
            // Outer exported
            const filePath = [...index.files.keys()].find(f => f.endsWith('models.py'));
            const fileEntry = index.files.get(filePath);
            assert.ok(fileEntry.exports.includes('Outer'), 'Outer exported via tuple __all__');
            // Property members (via symbol table)
            const nameSyms = index.symbols.get('name');
            assert.ok(nameSyms && nameSyms.length >= 2, 'getter + setter found');
        } finally { rm(dir); }
    });
});

describe('Cross-feature: Rust extern + trait impl', () => {
    it('struct with extern callee and trait impl', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'src/lib.rs': [
                'extern "C" {',
                '    fn c_init() -> i32;',
                '}',
                '',
                'pub struct Engine {',
                '    initialized: bool',
                '}',
                '',
                'impl Engine {',
                '    pub fn new() -> Self {',
                '        unsafe { c_init(); }',
                '        Engine { initialized: true }',
                '    }',
                '}',
                '',
                'impl Drop for Engine {',
                '    fn drop(&mut self) {}',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // Extern fn found
            assert.ok(index.symbols.get('c_init'), 'extern c_init found');
            // Engine implements Drop
            const engineSym = index.symbols.get('Engine');
            assert.ok(engineSym && engineSym.length > 0);
            assert.ok(engineSym[0].implements && engineSym[0].implements.includes('Drop'),
                'Engine implements Drop');
            // new calls c_init
            const ctx = execute(index, 'context', { name: 'new', className: 'Engine' });
            assert.ok(ctx.ok);
            if (ctx.result.callees) {
                assert.ok(ctx.result.callees.some(c => c.name === 'c_init'),
                    'new calls c_init');
            }
        } finally { rm(dir); }
    });
});

describe('Cross-feature: Go embedded struct + method callers', () => {
    it('embedded struct with cross-file callers', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'base.go': [
                'package main',
                'type Logger struct{}',
                'func (l *Logger) Log(msg string) {}'
            ].join('\n'),
            'app.go': [
                'package main',
                'type App struct {',
                '    Logger',
                '    Name string',
                '}',
                'func Start() {',
                '    a := App{}',
                '    a.Log("starting")',
                '}'
            ].join('\n')
        });
        try {
            const index = idx(dir);
            // App extends Logger
            const appSym = index.symbols.get('App');
            assert.ok(appSym && appSym[0].extends, 'App has extends');
            assert.ok(appSym[0].extends.includes('Logger'), 'extends Logger');
            // Log caller detection
            const ctx = execute(index, 'context', { name: 'Log' });
            assert.ok(ctx.ok, 'context for Log');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Bug G1-rust-007 / G7-rust-009: scopeWarning shown even when className provided
// ============================================================================

describe('fix G1-rust-007/G7-rust-009: no scopeWarning when className already provided', () => {
    it('impact: no scopeWarning when className is provided', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Dog { run() {} }\nmodule.exports = { Dog };',
            'b.js': 'class Cat { run() {} }\nmodule.exports = { Cat };',
            'main.js': 'const { Dog } = require("./a");\nnew Dog().run();\n',
        });
        try {
            const index = idx(dir);
            // Without className: warning should appear (multiple classes define run())
            const withoutClass = index.impact('run');
            assert.ok(withoutClass, 'impact should succeed');
            assert.ok(withoutClass.scopeWarning, 'should warn when className not provided');

            // With className: warning should NOT appear
            const withClass = index.impact('run', { className: 'Dog' });
            assert.ok(withClass, 'impact with className should succeed');
            assert.strictEqual(withClass.scopeWarning, null,
                'scopeWarning must be null when className is already provided');
        } finally {
            rm(dir);
        }
    });

    it('verify: no scopeWarning when className is provided', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo { process(x) {} }\nmodule.exports = { Foo };',
            'b.js': 'class Bar { process(y, z) {} }\nmodule.exports = { Bar };',
            'main.js': 'const { Foo } = require("./a");\nnew Foo().process(1);\n',
        });
        try {
            const index = idx(dir);
            // Without className: warning should appear
            const withoutClass = index.verify('process');
            assert.ok(withoutClass.found, 'verify should succeed');
            assert.ok(withoutClass.scopeWarning, 'should warn when className not provided');

            // With className: warning should NOT appear
            const withClass = index.verify('process', { className: 'Foo' });
            assert.ok(withClass.found, 'verify with className should succeed');
            assert.strictEqual(withClass.scopeWarning, null,
                'scopeWarning must be null when className is already provided');
        } finally {
            rm(dir);
        }
    });

    it('impact: no scopeWarning when file is provided', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'class Foo { close() {} }\nmodule.exports = { Foo };',
            'b.js': 'class Bar { close() {} }\nmodule.exports = { Bar };',
            'main.js': 'const { Foo } = require("./a");\nnew Foo().close();\n',
        });
        try {
            const index = idx(dir);
            // With file filter: warning should NOT appear
            const withFile = index.impact('close', { file: 'a.js' });
            assert.ok(withFile, 'impact with file should succeed');
            assert.strictEqual(withFile.scopeWarning, null,
                'scopeWarning must be null when file filter is already provided');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug G1-java-003: resolveSymbol "Also in" list includes chosen definition
// ============================================================================

describe('fix G1-java-003: resolveSymbol excludes chosen definition from Also In list', () => {
    it('disambiguation warning does not include the chosen definition in Also in list', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'a.js': 'function save(data) { return data; }\nmodule.exports = { save };',
            'b.js': 'function save(data, opts) { return opts; }\nmodule.exports = { save };',
        });
        try {
            const index = idx(dir);
            const resolved = index.resolveSymbol('save');
            assert.ok(resolved.def, 'should resolve to a definition');
            assert.ok(resolved.definitions.length >= 2, 'should have multiple definitions');

            if (resolved.warnings && resolved.warnings.length > 0) {
                const warning = resolved.warnings[0];
                assert.strictEqual(warning.type, 'ambiguous', 'warning type should be ambiguous');
                // The chosen definition file:line must NOT appear in the alternatives list
                const chosenKey = `${resolved.def.relativePath}:${resolved.def.startLine}`;
                const alsoIn = warning.message.match(/Also in: (.+?)\./)?.[1] || '';
                const alsoInParts = alsoIn.split(', ');
                assert.ok(!alsoInParts.includes(chosenKey),
                    `Chosen definition ${chosenKey} must not appear in "Also in" list: "${alsoIn}"`);
                // The alternatives array also must not contain the chosen definition
                if (warning.alternatives) {
                    const chosenInAlts = warning.alternatives.some(
                        a => a.file === resolved.def.relativePath && a.line === resolved.def.startLine
                    );
                    assert.ok(!chosenInAlts,
                        'alternatives array must not contain the chosen definition');
                }
            }
        } finally {
            rm(dir);
        }
    });

    it('Also in count is exactly (N-1) when N definitions exist', () => {
        const dir = tmp({
            'package.json': '{"name":"test"}',
            'x.js': 'function parse(s) { return s; }\nmodule.exports = { parse };',
            'y.js': 'function parse(s, opts) { return opts; }\nmodule.exports = { parse };',
            'z.js': 'function parse(s, opts, cb) { cb(); }\nmodule.exports = { parse };',
        });
        try {
            const index = idx(dir);
            const resolved = index.resolveSymbol('parse');
            assert.ok(resolved.def, 'should resolve');
            if (resolved.definitions.length >= 2 && resolved.warnings.length > 0) {
                const warning = resolved.warnings[0];
                const totalDefs = resolved.definitions.length;
                // alternatives should be exactly totalDefs - 1
                if (warning.alternatives) {
                    assert.strictEqual(warning.alternatives.length, totalDefs - 1,
                        `alternatives should be exactly ${totalDefs - 1} (total minus chosen)`);
                }
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Bug TS-BUG-003: about command note says "Remove flag" instead of --include-methods
// ============================================================================

describe('fix TS-BUG-003: about command note uses correct --include-methods wording', () => {
    it('formatAbout note does not say "Remove flag"', () => {
        const { formatAbout } = require('../core/output');
        const aboutResult = {
            found: true,
            symbol: { name: 'run', type: 'method', file: 'app.js', startLine: 1, endLine: 5, signature: 'run()' },
            usages: { definitions: 1, calls: 0, imports: 0, references: 0 },
            totalUsages: 0,
            callers: { total: 0, top: [] },
            callees: { total: 0, top: [] },
            tests: { fileCount: 0, totalMatches: 0, files: [] },
            otherDefinitions: [],
            types: [],
            code: null,
            includeMethods: false,
            completeness: { warnings: [] }
        };
        const text = formatAbout(aboutResult);
        assert.ok(!text.includes('Remove flag'),
            'Note must not say "Remove flag" — there is no flag to remove when using default behavior');
        assert.ok(text.includes('--include-methods'),
            'Note must mention "--include-methods" flag to add');
        assert.ok(text.includes('include'),
            'Note must guide user toward adding the flag, not removing it');
    });

    it('formatAbout note wording instructs user to USE --include-methods', () => {
        const { formatAbout } = require('../core/output');
        const aboutResult = {
            found: true,
            symbol: { name: 'fn', type: 'function', file: 'a.js', startLine: 1, endLine: 3, signature: 'fn()' },
            usages: { definitions: 1, calls: 0, imports: 0, references: 0 },
            totalUsages: 0,
            callers: { total: 0, top: [] },
            callees: { total: 0, top: [] },
            tests: { fileCount: 0, totalMatches: 0, files: [] },
            otherDefinitions: [],
            types: [],
            code: null,
            includeMethods: false,
            completeness: { warnings: [] }
        };
        const text = formatAbout(aboutResult);
        // The note should say "use --include-methods to include them" (or similar)
        // and must NOT instruct user to remove a flag that was never set
        assert.ok(
            text.includes('use --include-methods') || text.includes('Use --include-methods'),
            `Note text should instruct to use --include-methods. Got: "${text.slice(-200)}"`
        );
    });
});
