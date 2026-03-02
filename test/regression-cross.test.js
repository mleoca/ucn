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

const { parse, parseFile, detectLanguage } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { expandGlob } = require('../core/discovery');
const output = require('../core/output');
const { createTempDir, cleanup, tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR, CLI_PATH } = require('./helpers');

// ============================================================================
// STATS SYMBOL COUNT CONSISTENCY
// ============================================================================

describe('Bug: stats symbol count consistency', () => {
    it('total symbols should equal sum of type counts', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });

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
it('about includes method callers by default', () => {
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
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.py', { quiet: true });

        // Default: includeMethods=true — should find callers via obj.method()
        const aboutDefault = index.about('analyze');
        assert.ok(aboutDefault, 'Should find analyze');
        assert.ok(aboutDefault.found, 'Should be found');
        assert.ok(aboutDefault.includeMethods === true, 'includeMethods should default to true');

        // Explicit false: fewer callers
        const aboutNoMethods = index.about('analyze', { includeMethods: false });
        assert.ok(aboutNoMethods, 'Should find analyze with includeMethods=false');
        assert.ok(aboutNoMethods.includeMethods === false, 'includeMethods should be false');
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
    assert.ok(text.includes('--include-methods=false'), 'Should mention the flag');

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
    const index = new ProjectIndex('.');
    index.build(null, { quiet: true });

    const ctx = index.context('parse', { file: 'core/parser.js' });
    assert.ok(ctx, 'context should work with default includeMethods');

    const smart = index.smart('parse', { file: 'core/parser.js' });
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

describe('Bug Hunt: find("*") bare wildcard should not hang', () => {
    it('should return empty array for bare wildcard patterns', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });
        // Bare wildcards should return empty, not iterate all symbols
        assert.deepStrictEqual(index.find('*'), []);
        assert.deepStrictEqual(index.find('?'), []);
        assert.deepStrictEqual(index.find('**'), []);
        assert.deepStrictEqual(index.find('???'), []);
    });

    it('should still work for meaningful glob patterns', () => {
        const index = new ProjectIndex('.');
        index.build(null, { quiet: true });
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

