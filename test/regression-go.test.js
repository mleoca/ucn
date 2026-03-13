/**
 * UCN Go Regression Tests
 *
 * Go-specific regressions: entry points, methods, receivers, struct fields.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const { parse } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { saveCache, loadCache } = require('../core/cache');
const { parseStackTrace } = require('../core/stacktrace');
const { tmp, rm, idx, FIXTURES_PATH } = require('./helpers');
const { execute } = require('../core/execute');
const { detectEntrypoints } = require('../core/entrypoints');

const os = require('os');

// ============================================================================
// Go entry points not flagged as deadcode
// ============================================================================

describe('Regression: Go entry points not flagged as deadcode', () => {
    it('should NOT report main() as dead code in Go', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-main-'));
        try {
            // Create a Go project with main and init functions
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

func main() {
    run()
}

func init() {
    setup()
}

func run() {
    println("running")
}

func setup() {
    println("setup")
}

func unusedHelper() {
    println("unused")
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // main and init should NOT be reported as dead
            assert.ok(!deadNames.includes('main'), 'main() should not be flagged as dead code');
            assert.ok(!deadNames.includes('init'), 'init() should not be flagged as dead code');

            // run and setup are called, so not dead
            assert.ok(!deadNames.includes('run'), 'run() is called by main, not dead');
            assert.ok(!deadNames.includes('setup'), 'setup() is called by init, not dead');

            // unusedHelper should be flagged as dead
            assert.ok(deadNames.includes('unusedHelper'), 'unusedHelper() should be flagged as dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Go method calls included in findCallers
// ============================================================================

describe('Regression: Go method calls included in findCallers', () => {
    it('should find Go method call sites without --include-methods flag', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-methods-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'server.go'), `package main

type Server struct {
    port int
}

func (s *Server) Start() {
    s.listen()
}

func (s *Server) listen() {
    println("listening on", s.port)
}

func main() {
    srv := &Server{port: 8080}
    srv.Start()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Find callers of Start method - should find the call in main
            const callers = index.findCallers('Start');

            assert.strictEqual(callers.length, 1, 'Should find 1 caller for Start method');
            assert.strictEqual(callers[0].callerName, 'main', 'Caller should be main function');
            assert.ok(callers[0].content.includes('srv.Start()'), 'Should capture the method call');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// context for structs shows methods
// ============================================================================

describe('Regression: context for structs shows methods', () => {
    it('should return methods for Go struct types', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-struct-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'types.go'), `package main

type User struct {
    Name  string
    Email string
}

func (u *User) Validate() bool {
    return u.Name != "" && u.Email != ""
}

func (u *User) String() string {
    return u.Name + " <" + u.Email + ">"
}

func (u User) IsEmpty() bool {
    return u.Name == "" && u.Email == ""
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            const ctx = index.context('User');

            // Should identify as struct type
            assert.strictEqual(ctx.type, 'struct', 'User should be identified as struct');
            assert.strictEqual(ctx.name, 'User', 'Should return correct name');

            // Should have methods
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 3, 'User struct should have 3 methods');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('Validate'), 'Should include Validate method');
            assert.ok(methodNames.includes('String'), 'Should include String method');
            assert.ok(methodNames.includes('IsEmpty'), 'Should include IsEmpty method');

            // Methods should have receiver info
            const validateMethod = ctx.methods.find(m => m.name === 'Validate');
            assert.strictEqual(validateMethod.receiver, '*User', 'Validate has pointer receiver');

            const isEmptyMethod = ctx.methods.find(m => m.name === 'IsEmpty');
            assert.strictEqual(isEmptyMethod.receiver, 'User', 'IsEmpty has value receiver');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should return empty methods for struct with no methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-struct-empty-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'types.go'), `package main

type Config struct {
    Port int
    Host string
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            const ctx = index.context('Config');

            assert.strictEqual(ctx.type, 'struct', 'Config should be identified as struct');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 0, 'Config struct should have 0 methods');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// receiver field preserved in Go method symbols
// ============================================================================

describe('Regression: receiver field preserved in Go method symbols', () => {
    it('should store receiver info for Go methods in symbol index', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-receiver-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'handler.go'), `package main

type Handler struct{}

func (h *Handler) ServeHTTP(w, r) {
    h.handleRequest(w, r)
}

func (h *Handler) handleRequest(w, r) {
    println("handling")
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.go', { quiet: true });

            // Check that receiver is preserved in symbols
            const serveHTTP = index.symbols.get('ServeHTTP');
            assert.ok(serveHTTP, 'ServeHTTP should be indexed');
            assert.strictEqual(serveHTTP.length, 1, 'Should have one definition');
            assert.strictEqual(serveHTTP[0].receiver, '*Handler', 'Receiver should be *Handler');
            assert.strictEqual(serveHTTP[0].isMethod, true, 'Should be marked as method');

            const handleRequest = index.symbols.get('handleRequest');
            assert.ok(handleRequest, 'handleRequest should be indexed');
            assert.strictEqual(handleRequest[0].receiver, '*Handler', 'Receiver should be *Handler');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Bug Report #3: Go type_identifier regressions
// ============================================================================

describe('Bug Report #3: Go type_identifier regressions', () => {

it('Go type_identifier — composite literals and type references detected', (t) => {
    const { getParser } = require('../languages');
    const { findUsagesInCode } = require('../languages/go');

    const code = `package main

type MyService struct {
    Name string
}

func NewMyService() *MyService {
    return &MyService{Name: "test"}
}

func useService(svc MyService) {
    svc.Run()
}

func main() {
    var x MyService
    y := MyService{Name: "hello"}
    _ = x
    _ = y
}
`;
    const parser = getParser('go');
    const usages = findUsagesInCode(code, 'MyService', parser);

    // Composite literals MyService{} should be "call"
    const calls = usages.filter(u => u.usageType === 'call');
    assert.ok(calls.length >= 2, `Should find at least 2 composite literal calls, got ${calls.length}`);

    // Type references (*MyService, param type, var type) should be "reference"
    const refs = usages.filter(u => u.usageType === 'reference');
    assert.ok(refs.length >= 2, `Should find type references, got ${refs.length}`);

    // Definition should exist
    const defs = usages.filter(u => u.usageType === 'definition');
    assert.ok(defs.length >= 1, 'Should find at least 1 definition');

    // Total usages should be 7+: 1 def + 2 calls + 4 references
    assert.ok(usages.length >= 6, `Should find at least 6 usages, got ${usages.length}`);
});

it('Go type_identifier — parameter type not misclassified as definition', (t) => {
    const { getParser } = require('../languages');
    const { findUsagesInCode } = require('../languages/go');

    const code = `package main
type Config struct{}
func use(cfg Config) {}
`;
    const parser = getParser('go');
    const usages = findUsagesInCode(code, 'Config', parser);

    // The parameter type should be "reference", not "definition"
    const paramTypeUsage = usages.find(u => u.line === 3 && u.usageType !== 'definition');
    assert.ok(paramTypeUsage, 'Config in func use(cfg Config) should be reference, not definition');
    assert.strictEqual(paramTypeUsage.usageType, 'reference');
});

}); // end describe('Bug Report #3: Go type_identifier regressions')

// ============================================================================
// Bug Report #4: Go-specific regressions
// ============================================================================

describe('Bug Report #4: Go-specific regressions', () => {

it('Go local closures are not matched as callers of package-level function', (t) => {
    const { getParser } = require('../languages');
    const goMod = require('../languages/go');

    const code = `package main

func globalAtoi(s string) int { return 0 }

func processInput(input string) {
    atoi := func(s string) int { return 0 }
    val := atoi(input)
    _ = val
}

func useGlobal(s string) {
    v := globalAtoi(s)
    _ = v
}
`;
    const parser = getParser('go');
    const calls = goMod.findCallsInCode(code, parser);
    // Calls to local closure 'atoi' inside processInput should be filtered
    const atoiCalls = calls.filter(c => c.name === 'atoi');
    assert.strictEqual(atoiCalls.length, 0, 'calls to local closure atoi should be filtered');
    // Calls to globalAtoi should still be present
    const globalCalls = calls.filter(c => c.name === 'globalAtoi');
    assert.ok(globalCalls.length > 0, 'calls to package-level globalAtoi should be kept');
});

// BUG 5b: Go package-scoped binding resolution
it('Go findCallers resolves sibling file bindings (same package)', (t) => {
    const { ProjectIndex } = require('../core/project');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug5b-'));
    const pkgDir = path.join(tmpDir, 'pkg');
    fs.mkdirSync(pkgDir);
    // pkg/a.go defines helper
    fs.writeFileSync(path.join(pkgDir, 'a.go'), `package pkg
func helper() int { return 1 }
`);
    // pkg/b.go calls helper
    fs.writeFileSync(path.join(pkgDir, 'b.go'), `package pkg
func useHelper() int { return helper() }
`);
    // other/c.go defines its own helper
    const otherDir = path.join(tmpDir, 'other');
    fs.mkdirSync(otherDir);
    fs.writeFileSync(path.join(otherDir, 'c.go'), `package other
func helper() int { return 2 }
func useOther() int { return helper() }
`);
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test');
    try {
        const idx = new ProjectIndex(tmpDir);
        idx.build();
        // When targeting pkg/a.go:helper, callers should include pkg/b.go but NOT other/c.go
        const callers = idx.findCallers('helper', { targetDefinitions: [{ bindingId: 'pkg/a.go:function:2' }] });
        const callerFiles = callers.map(c => c.relativePath);
        assert.ok(callerFiles.some(f => f.includes('b.go')), 'pkg/b.go should call pkg/a.go helper');
        assert.ok(!callerFiles.some(f => f.includes('c.go')), 'other/c.go should NOT be a caller of pkg/a.go helper');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 6: Go built-in functions should not match user-defined functions
it('Go built-in functions (append, len, etc.) are filtered from findCallsInCode', (t) => {
    const { getParser } = require('../languages');
    const goMod = require('../languages/go');

    const code = `package main

func main() {
    s := []int{1, 2, 3}
    s = append(s, 4)
    n := len(s)
    m := make(map[string]int)
    _ = n
    _ = m
    customFunc(s)
}

func customFunc(s []int) {}
`;
    const parser = getParser('go');
    const calls = goMod.findCallsInCode(code, parser);
    const callNames = calls.map(c => c.name);
    assert.ok(!callNames.includes('append'), 'append should be filtered as Go built-in');
    assert.ok(!callNames.includes('len'), 'len should be filtered as Go built-in');
    assert.ok(!callNames.includes('make'), 'make should be filtered as Go built-in');
    assert.ok(callNames.includes('customFunc'), 'user-defined functions should not be filtered');
});

// BUG 6b: Cross-type method calls marked as uncertain
it('Go cross-type method calls with multiple definitions are uncertain when no local binding', (t) => {
    const { ProjectIndex } = require('../core/project');
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug6b-'));
    // Three packages: two define Length(), third calls it without local binding
    const pkgA = path.join(tmpDir, 'a');
    const pkgB = path.join(tmpDir, 'b');
    const pkgC = path.join(tmpDir, 'c');
    fs.mkdirSync(pkgA);
    fs.mkdirSync(pkgB);
    fs.mkdirSync(pkgC);
    fs.writeFileSync(path.join(pkgA, 'a.go'), `package a
type TypeA struct{}
func (t *TypeA) Length() int { return 0 }
`);
    fs.writeFileSync(path.join(pkgB, 'b.go'), `package b
type TypeB struct{}
func (t *TypeB) Length() int { return 0 }
`);
    // c/c.go calls obj.Length() but has NO local Length definition
    fs.writeFileSync(path.join(pkgC, 'c.go'), `package c
func UseC(obj interface{ Length() int }) int { return obj.Length() }
`);
    fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test');
    try {
        const idx = new ProjectIndex(tmpDir);
        idx.build();
        const stats = { uncertain: 0 };
        const callees = idx.findCallees(
            { file: path.join(pkgC, 'c.go'), name: 'UseC', startLine: 2, endLine: 2 },
            { stats }
        );
        // Length() is uncertain because there are 2 definitions and no local binding
        const lengthCallee = callees.find(c => c.name === 'Length');
        assert.ok(!lengthCallee, 'Length should be filtered as uncertain when multiple defs and no local binding');
        assert.ok(stats.uncertain > 0, 'cross-type method call should be counted as uncertain');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

}); // end describe('Bug Report #4: Go-specific regressions')

// ============================================================================
// Go Fix Regressions
// ============================================================================

describe('Go Fix Regressions', () => {

it('FIX 91 — Go multi-var short declaration classifies all vars as definitions', () => {
    const { getParser } = require('../languages');
    const goParser = require('../languages/go');
    const parser = getParser('go');
    const code = `package main
func main() {
    result, err := doSomething()
    _ = result
    _ = err
}
func doSomething() (int, error) { return 0, nil }
`;
    const usages = goParser.findUsagesInCode(code, 'result', parser);
    const defs = usages.filter(u => u.usageType === 'definition');
    assert.ok(defs.length >= 1,
        `"result" in "result, err := ..." should be classified as definition, got ${defs.length} defs`);
});

}); // end describe('Go Fix Regressions')

// ============================================================================
// Fix #116: Go multi-name params and variadic params not parsed
// `a, b int` should count as 2 params, `args ...int` should be rest param
// ============================================================================
describe('fix #116: verify handles Go multi-name and variadic params', () => {
    it('multi-name params a, b int counted as 2 params', () => {
        const tmpDir = tmp('go-multiname');
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\ngo 1.21');
        fs.writeFileSync(path.join(tmpDir, 'main.go'),
            'package main\n\n' +
            'func Add(a, b int) int { return a + b }\n\n' +
            'func main() {\n' +
            '    Add(1, 2)\n' +
            '    Add(1, 2, 3)\n' +
            '}\n'
        );
        const index = idx(tmpDir);
        const result = index.verify('Add');
        assert.ok(result, 'verify should return result');
        // Add has 2 params (a and b), not 1
        assert.equal(result.mismatches, 1,
            'only Add(1, 2, 3) should mismatch (3 args for 2 params)');
        const detail = result.mismatchDetails[0];
        assert.equal(detail.actual, 3, 'mismatched call has 3 args');
        rm(tmpDir);
    });

    it('three-name params a, b, c int counted as 3 params', () => {
        const tmpDir = tmp('go-threename');
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\ngo 1.21');
        fs.writeFileSync(path.join(tmpDir, 'main.go'),
            'package main\n\n' +
            'func Multi(a, b, c int, d string) string { return d }\n\n' +
            'func main() {\n' +
            '    Multi(1, 2, 3, "hello")\n' +
            '    Multi(1, 2)\n' +
            '}\n'
        );
        const index = idx(tmpDir);
        const result = index.verify('Multi');
        assert.ok(result, 'verify should return result');
        // Multi has 4 params (a, b, c, d)
        assert.equal(result.mismatches, 1,
            'Multi(1, 2) should mismatch (2 args for 4 params)');
        rm(tmpDir);
    });

    it('variadic param args ...int recognized as rest param', () => {
        const tmpDir = tmp('go-variadic');
        fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module test\ngo 1.21');
        fs.writeFileSync(path.join(tmpDir, 'main.go'),
            'package main\n\n' +
            'func Printf(format string, args ...interface{}) { }\n\n' +
            'func main() {\n' +
            '    Printf("%s %s", "hello", "world")\n' +
            '    Printf("%d", 42)\n' +
            '    Printf("no args")\n' +
            '}\n'
        );
        const index = idx(tmpDir);
        const result = index.verify('Printf');
        assert.ok(result, 'verify should return result');
        // Printf has 1 required param (format) + variadic (args)
        assert.equal(result.mismatches, 0,
            'all calls should be valid (variadic accepts 0+ extra args)');
        rm(tmpDir);
    });
});

// ============================================================================
// Bug Hunt: Go struct fields extraction
// ============================================================================

describe('Bug Hunt: Go struct fields should be extracted', () => {
    it('should extract struct field members with types', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `type Config struct {
    Name   string
    Port   int
    Debug  bool
}`;
        const classes = goMod.findClasses(code, parser);
        assert.ok(classes.length > 0, 'Config should be found');
        const config = classes[0];
        assert.ok(config.members && config.members.length === 3, `should have 3 members, got ${config.members?.length}`);
        assert.strictEqual(config.members[0].name, 'Name');
        assert.strictEqual(config.members[0].fieldType, 'string');
        assert.strictEqual(config.members[1].name, 'Port');
        assert.strictEqual(config.members[2].name, 'Debug');
    });

    it('should register struct fields as symbols in the index', () => {
        const dir = tmp({
            'main.go': `
package main

type Config struct {
    Name   string
    Port   int
}

func main() {}
`,
            'go.mod': 'module test\ngo 1.21'
        });
        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });
        // Fields are stored as separate symbols with className
        const nameSyms = index.symbols.get('Name');
        assert.ok(nameSyms && nameSyms.length > 0, 'Name field should be indexed');
        assert.strictEqual(nameSyms[0].className, 'Config');
        const portSyms = index.symbols.get('Port');
        assert.ok(portSyms && portSyms.length > 0, 'Port field should be indexed');
        rm(dir);
    });
});

// ============================================================================
// Bug Hunt: Go raw string literal imports
// ============================================================================

describe('Bug Hunt: Go raw string literal imports', () => {
    it('should detect imports using backtick strings', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = 'import `fmt`';
        const imports = goMod.findImportsInCode(code, parser);
        assert.ok(imports.length > 0, 'should detect raw string import');
        assert.strictEqual(imports[0].module, 'fmt');
    });
});

// ============================================================================
// FIX #116: Go extractReceiver wrong for unnamed and generic receivers
// ============================================================================

describe('Bug Hunt: Go unnamed and generic receivers', () => {
    it('should extract correct receiver for unnamed receiver', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main
func (Router) Handle() {}
func (r Router) Get() {}
`;
        const fns = goMod.findFunctions(code, parser);
        const handle = fns.find(f => f.name === 'Handle');
        const get = fns.find(f => f.name === 'Get');
        assert.ok(handle, 'Handle should be found');
        assert.ok(get, 'Get should be found');
        assert.strictEqual(handle.receiver, 'Router', 'unnamed receiver should be Router');
        assert.strictEqual(get.receiver, 'Router', 'named receiver should be Router');
    });

    it('should extract correct receiver for pointer unnamed receiver', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main
func (*Router) Handle() {}
`;
        const fns = goMod.findFunctions(code, parser);
        const handle = fns.find(f => f.name === 'Handle');
        assert.ok(handle, 'Handle should be found');
        assert.strictEqual(handle.receiver, '*Router', 'unnamed pointer receiver should be *Router');
    });

    it('should extract correct receiver for generic receiver', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main
func (r *Router[T]) Post() {}
func (r Cache[K, V]) Get() {}
`;
        const fns = goMod.findFunctions(code, parser);
        const post = fns.find(f => f.name === 'Post');
        const get = fns.find(f => f.name === 'Get');
        assert.ok(post, 'Post should be found');
        assert.ok(get, 'Get should be found');
        assert.ok(post.receiver.includes('Router'), 'generic pointer receiver should include Router');
        assert.ok(get.receiver.includes('Cache'), 'generic receiver should include Cache');
    });

    it('should associate unnamed receiver methods with their struct', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-go-unnamed-recv-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'go.mod'), 'module example.com/test\n\ngo 1.21\n');
            fs.writeFileSync(path.join(tmpDir, 'main.go'), `package main

type Router struct{}

func (Router) Handle() {}
func (r Router) Get() {}
`);
            const index = idx(tmpDir);
            const methods = index.findMethodsForType('Router');
            const names = methods.map(m => m.name);
            assert.ok(names.includes('Handle'), 'Handle should be a method of Router');
            assert.ok(names.includes('Get'), 'Get should be a method of Router');
        } finally {
            rm(tmpDir);
        }
    });
});

// ============================================================================
// FIX #117: Go var-declaration closures not tracked
// ============================================================================

describe('Bug Hunt: Go var-declared closures tracked', () => {
    it('should filter var-declared closure calls from callees', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main

func outer() {
    var handler = func() {
        doWork()
    }
    handler()
}
`;
        const result = goMod.findCallsInCode(code, parser);
        const callNames = result.map(c => c.name);
        assert.ok(callNames.includes('doWork'), 'doWork should be in calls');
        assert.ok(!callNames.includes('handler'), 'handler should be filtered as local closure');
    });

    it('should filter short-var closures the same as var closures', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main

func outer() {
    handler := func() {
        doWork()
    }
    handler()
}
`;
        const result = goMod.findCallsInCode(code, parser);
        const callNames = result.map(c => c.name);
        assert.ok(callNames.includes('doWork'), 'doWork should be in calls');
        assert.ok(!callNames.includes('handler'), 'handler should be filtered as local closure');
    });
});

// Bug Hunt: Go var_declaration closure tracking should be per-spec
describe('Bug Hunt: Go var_declaration per-spec closure tracking', () => {
    it('should not register non-closure vars as closures in grouped var declarations', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `
package main

func main() {
    var (
        count = 5
        handler = func() { doWork() }
    )
    count++
    handler()
    process(count)
}

func doWork() {}
func process(n int) {}
`;
        const result = goMod.findCallsInCode(code, parser);
        const callNames = result.map(c => c.name);
        // handler is a closure, so handler() should be filtered
        assert.ok(!callNames.includes('handler'), 'handler should be filtered as local closure');
        // process(count) should NOT be filtered — count is not a closure
        assert.ok(callNames.includes('process'), 'process should not be filtered (count is not a closure)');
    });
});

// ============================================================================
// fix #160: Go iota constants not indexed
// ============================================================================

describe('fix #160: Go iota constants indexed as state symbols', () => {
    it('finds exported constants in iota blocks', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'status.go': `package framework
type Code int
const (
    Success Code = iota
    Error
    Unschedulable
    Wait
    Skip
    Pending
)
`
        });
        try {
            const index = idx(dir);
            // All exported iota constants should be findable
            for (const name of ['Success', 'Error', 'Unschedulable', 'Wait', 'Skip', 'Pending']) {
                const syms = index.symbols.get(name) || [];
                assert.ok(syms.length > 0, `Should find constant ${name}`);
                assert.strictEqual(syms[0].type, 'state', `${name} should have type "state"`);
            }
        } finally {
            rm(dir);
        }
    });

    it('does not index unexported iota constants', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'internal.go': `package main
type color int
const (
    red color = iota
    green
    blue
)
`
        });
        try {
            const index = idx(dir);
            for (const name of ['red', 'green', 'blue']) {
                const syms = index.symbols.get(name) || [];
                assert.strictEqual(syms.length, 0, `Unexported const ${name} should not be indexed`);
            }
        } finally {
            rm(dir);
        }
    });

    it('indexes exported constants from non-iota blocks', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'consts.go': `package main
const MaxRetries = 3
const Timeout = 30
const internal = 5
`
        });
        try {
            const index = idx(dir);
            // Exported constants should be indexed (fix K8s Bug 11)
            const syms = index.symbols.get('MaxRetries') || [];
            assert.ok(syms.length > 0, 'Exported const MaxRetries should be indexed');
            const timeout = index.symbols.get('Timeout') || [];
            assert.ok(timeout.length > 0, 'Exported const Timeout should be indexed');
            // Unexported constants should NOT be indexed
            const internal = index.symbols.get('internal') || [];
            assert.strictEqual(internal.length, 0, 'Unexported const should not be indexed');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #161: Go receiver type tracking for method disambiguation
// ============================================================================

describe('fix #161: Go receiver type tracking in findCallsInCode', () => {
    const goMod = require('../languages/go');
    const { getParser } = require('../languages');
    const parser = getParser('go');

    it('tracks receiverType from method receiver', () => {
        const code = `package main
type Framework struct{}
func (f *Framework) RunFilter() {
    f.runFilterPlugin()
}
func (f *Framework) runFilterPlugin() {}
`;
        const calls = goMod.findCallsInCode(code, parser);
        const runFilter = calls.find(c => c.name === 'runFilterPlugin');
        assert.ok(runFilter, 'Should find runFilterPlugin call');
        assert.strictEqual(runFilter.receiverType, 'Framework',
            'receiverType should be Framework (from method receiver)');
    });

    it('tracks receiverType from function parameters', () => {
        const code = `package main
type Client struct{}
func processClient(c *Client) {
    c.GetPods()
}
func (c *Client) GetPods() {}
`;
        const calls = goMod.findCallsInCode(code, parser);
        const getPods = calls.find(c => c.name === 'GetPods');
        assert.ok(getPods, 'Should find GetPods call');
        assert.strictEqual(getPods.receiverType, 'Client',
            'receiverType should be Client (from parameter type)');
    });

    it('tracks receiverType from composite literal assignment', () => {
        const code = `package main
type Status struct{ Code int }
func doWork() {
    s := &Status{Code: 1}
    s.String()
}
func (s *Status) String() string { return "" }
`;
        const calls = goMod.findCallsInCode(code, parser);
        const str = calls.find(c => c.name === 'String');
        assert.ok(str, 'Should find String call');
        assert.strictEqual(str.receiverType, 'Status',
            'receiverType should be Status (from composite literal)');
    });

    it('does not set receiverType for unknown receivers', () => {
        const code = `package main
func doWork(x interface{}) {
    x.Method()
}
`;
        const calls = goMod.findCallsInCode(code, parser);
        const method = calls.find(c => c.name === 'Method');
        assert.ok(method, 'Should find Method call');
        assert.strictEqual(method.receiverType, undefined,
            'receiverType should be undefined for unknown type');
    });
});

// ============================================================================
// fix #162: Go callee disambiguation uses receiver type
// ============================================================================

describe('fix #162: Go callee disambiguation with receiver type', () => {
    it('resolves callees to correct type when multiple types have same method', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'types.go': `package main

type FilterPlugin struct{}
func (f *FilterPlugin) Run() string { return "filter" }

type ScorePlugin struct{}
func (s *ScorePlugin) Run() string { return "score" }

func (f *FilterPlugin) Execute() {
    f.Run()
}

func (s *ScorePlugin) Execute() {
    s.Run()
}
`
        });
        try {
            const index = idx(dir);

            // FilterPlugin.Execute should call FilterPlugin.Run, not ScorePlugin.Run
            const filterExec = (index.symbols.get('Execute') || [])
                .find(d => d.receiver === '*FilterPlugin');
            assert.ok(filterExec, 'Should find FilterPlugin.Execute');
            const filterCallees = index.findCallees(filterExec);
            const filterRun = filterCallees.find(c => c.name === 'Run');
            assert.ok(filterRun, 'Should find Run callee');
            assert.ok(filterRun.receiver === '*FilterPlugin',
                'Run callee should be from FilterPlugin, got: ' + filterRun.receiver);

            // ScorePlugin.Execute should call ScorePlugin.Run
            const scoreExec = (index.symbols.get('Execute') || [])
                .find(d => d.receiver === '*ScorePlugin');
            assert.ok(scoreExec, 'Should find ScorePlugin.Execute');
            const scoreCallees = index.findCallees(scoreExec);
            const scoreRun = scoreCallees.find(c => c.name === 'Run');
            assert.ok(scoreRun, 'Should find Run callee');
            assert.ok(scoreRun.receiver === '*ScorePlugin',
                'Run callee should be from ScorePlugin, got: ' + scoreRun.receiver);
        } finally {
            rm(dir);
        }
    });

    it('resolves callers to correct type with targetDefinitions', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'types.go': `package main

type PreFilter struct{}
func (p *PreFilter) Process() string { return "pre" }

type PreScore struct{}
func (p *PreScore) Process() string { return "score" }

type Runner struct{}
func (r *Runner) RunFilters(pf *PreFilter) {
    pf.Process()
}
func (r *Runner) RunScores(ps *PreScore) {
    ps.Process()
}
`
        });
        try {
            const index = idx(dir);

            // Callers of PreFilter.Process should include RunFilters, not RunScores
            const preFilterProcess = (index.symbols.get('Process') || [])
                .find(d => d.receiver === '*PreFilter');
            assert.ok(preFilterProcess, 'Should find PreFilter.Process');

            const callers = index.findCallers('Process', {
                targetDefinitions: [preFilterProcess]
            });
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('RunFilters'),
                'RunFilters should be a caller of PreFilter.Process');
            assert.ok(!callerNames.includes('RunScores'),
                'RunScores should NOT be a caller of PreFilter.Process');
        } finally {
            rm(dir);
        }
    });

    it('resolves method calls via New* constructor pattern', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'factory.go': `package main

type Registry struct{}
func NewRegistry() *Registry { return &Registry{} }
func (r *Registry) Register(name string) {}

type Cache struct{}
func NewCache() *Cache { return &Cache{} }
func (c *Cache) Register(key string) {}

func setup() {
    reg := NewRegistry()
    reg.Register("plugin1")
}
`
        });
        try {
            const index = idx(dir);
            const setupDef = (index.symbols.get('setup') || [])[0];
            assert.ok(setupDef, 'Should find setup function');
            const callees = index.findCallees(setupDef);
            const regCallee = callees.find(c => c.name === 'Register');
            // Should resolve to Registry.Register via NewRegistry constructor
            assert.ok(regCallee, 'Should find Register callee');
            assert.ok(regCallee.receiver === '*Registry',
                'Register should resolve to Registry, got: ' + regCallee.receiver);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 7 — TestFoo auto-include regex
// ============================================================================

describe('K8s fix: Bug 7 — find auto-includes tests for Go TestFoo pattern', () => {
    it('TestFoo pattern should auto-include test files', () => {
        const { execute } = require('../core/execute');
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': 'package main\nfunc Run() {}\n',
            'main_test.go': 'package main\nfunc TestRun() { Run() }\n',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'find', { name: 'TestRun' });
            assert.ok(ok, 'find should succeed');
            assert.ok(result.length > 0, 'TestRun should be found (test files auto-included)');
            assert.strictEqual(result[0].name, 'TestRun');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 3 — Caller false positives for common Go method names
// ============================================================================

describe('K8s fix: Bug 3 — callers filtered by receiverType', () => {
    it('filters callers when receiverType is known and differs from target', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'controller.go': `package main

type DeploymentController struct{}
func (dc *DeploymentController) Run() {}

type TestController struct{}
func (tc *TestController) Run() {}

func startDeployment(dc *DeploymentController) {
    dc.Run()
}

func runTest(t *TestController) {
    t.Run()
}
`,
        });
        try {
            const index = idx(dir);
            const dcRun = (index.symbols.get('Run') || [])
                .find(d => d.receiver === '*DeploymentController');
            assert.ok(dcRun, 'Should find DeploymentController.Run');
            const callers = index.findCallers('Run', { targetDefinitions: [dcRun] });
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('startDeployment'),
                'startDeployment should be a caller');
            assert.ok(!callerNames.includes('runTest'),
                'runTest should NOT be a caller (t has type TestController)');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 8 — Embedded struct fields
// ============================================================================

describe('K8s fix: Bug 8 — embedded struct fields detected', () => {
    it('should detect embedded struct fields', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main

type Base struct {
    ID int
}

type Child struct {
    Base
    Name string
}
`;
        const classes = goMod.findClasses(code, parser);
        const child = classes.find(c => c.name === 'Child');
        assert.ok(child, 'Child should be found');
        assert.ok(child.members.length >= 2, `Should have at least 2 members, got ${child.members.length}`);
        const embedded = child.members.find(m => m.name === 'Base');
        assert.ok(embedded, 'Embedded Base should be detected');
        assert.strictEqual(embedded.embedded, true, 'Should have embedded flag');
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 9 — Embedded interface members
// ============================================================================

describe('K8s fix: Bug 9 — embedded interface members detected', () => {
    it('should detect embedded interfaces', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main

type Reader interface {
    Read(p []byte) (int, error)
}

type ReadWriter interface {
    Reader
    Write(p []byte) (int, error)
}
`;
        const classes = goMod.findClasses(code, parser);
        const rw = classes.find(c => c.name === 'ReadWriter');
        assert.ok(rw, 'ReadWriter should be found');
        assert.ok(rw.members.length >= 2, `Should have at least 2 members, got ${rw.members.length}`);
        const embedded = rw.members.find(m => m.name === 'Reader');
        assert.ok(embedded, 'Embedded Reader should be detected');
        assert.strictEqual(embedded.embedded, true, 'Should have embedded flag');
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 12 — Function reference callbacks as callees
// ============================================================================

describe('K8s fix: Bug 12 — Go function reference callbacks detected as callees', () => {
    it('should detect member expression used as argument as callee', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('go');
        const goMod = getLanguageModule('go');
        const code = `package main

func (dc *Controller) Run() {
    go UntilWithContext(ctx, dc.worker, time.Second)
}

func (dc *Controller) worker() {}
func UntilWithContext(ctx interface{}, f func(), d interface{}) {}
`;
        const calls = goMod.findCallsInCode(code, parser);
        const workerRef = calls.find(c => c.name === 'worker' && c.isPotentialCallback);
        assert.ok(workerRef, 'dc.worker passed as arg should be detected as potential callback');
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 11 — Package-level exported const/var indexed
// ============================================================================

describe('K8s fix: Bug 11 — exported package-level const/var indexed', () => {
    it('should index exported const declarations', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'register.go': `package main
const GroupName = "abac.authorization.kubernetes.io"
const Version = "v1"
var SchemeGroupVersion = GroupName + "/" + Version
`,
        });
        try {
            const index = idx(dir);
            const gn = index.symbols.get('GroupName') || [];
            assert.ok(gn.length > 0, 'GroupName should be indexed');
            const ver = index.symbols.get('Version') || [];
            assert.ok(ver.length > 0, 'Version should be indexed');
        } finally {
            rm(dir);
        }
    });

    it('should NOT index unexported const/var', () => {
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'internal.go': `package main
const maxRetries = 3
var timeout = 30
`,
        });
        try {
            const index = idx(dir);
            assert.strictEqual((index.symbols.get('maxRetries') || []).length, 0,
                'unexported const should not be indexed');
            assert.strictEqual((index.symbols.get('timeout') || []).length, 0,
                'unexported var should not be indexed');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 15 — No warning when --file matches nothing
// ============================================================================

describe('K8s fix: Bug 15 — file pattern match warning', () => {
    it('should return error when --file matches no files', () => {
        const { execute } = require('../core/execute');
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': 'package main\nfunc main() {}\n',
        });
        try {
            const index = idx(dir);
            const { ok, error } = execute(index, 'find', { name: 'main', file: 'nonexistent/path' });
            assert.ok(!ok, 'Should fail when file pattern matches nothing');
            assert.ok(error.includes('No files matched'), `Error should mention no files matched, got: ${error}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 17 — --limit flag
// ============================================================================

describe('K8s fix: Bug 17 — limit flag caps results', () => {
    it('find results limited by --limit', () => {
        const { execute } = require('../core/execute');
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'funcs.go': `package main
func FooA() {}
func FooB() {}
func FooC() {}
func FooD() {}
func FooE() {}
`,
        });
        try {
            const index = idx(dir);
            const { ok, result, note } = execute(index, 'find', { name: 'Foo*', limit: 2 });
            assert.ok(ok, 'find should succeed');
            assert.ok(result.length <= 2, `Should be limited to 2, got ${result.length}`);
            assert.ok(note && note.includes('Showing 2 of'), 'Should have limit note');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// K8s Bug Hunt: Bug 2 — search respects --file
// ============================================================================

describe('K8s fix: Bug 2 — search respects --file', () => {
    it('should filter search results by --file pattern', () => {
        const { execute } = require('../core/execute');
        const dir = tmp({
            'go.mod': 'module test\ngo 1.21',
            'pkg/controller/deploy.go': 'package controller\n// deployment logic\nfunc Deploy() {}\n',
            'cmd/app.go': 'package app\n// deployment config\nfunc Setup() {}\n',
        });
        try {
            const index = idx(dir);
            const { ok, result } = execute(index, 'search', { term: 'deployment', file: 'pkg/controller' });
            assert.ok(ok, 'search should succeed');
            // Should only find results in pkg/controller
            for (const r of result) {
                assert.ok(r.file.includes('pkg/controller'),
                    `Result file ${r.file} should match --file pattern`);
            }
        } finally {
            rm(dir);
        }
    });
});

// Bug fix: Go package imports should link to all files in package directory
describe('fix: Go package import links all files in package directory', () => {
    it('counts usages from symbols defined in non-first package file', () => {
        const dir = tmp({
            'go.mod': 'module example.com/myapp\n\ngo 1.21\n',
            'main.go': `package main

import "example.com/myapp/pkg/util"

func main() {
    util.Helper()
    util.Format("test")
}
`,
            'pkg/util/alpha.go': `package util

func Alpha() string { return "alpha" }
`,
            'pkg/util/helpers.go': `package util

func Helper() int { return 42 }
func Format(s string) string { return s }
`
        });
        try {
            const index = idx(dir);
            // Helper and Format are defined in helpers.go (not alpha.go which comes first alphabetically)
            // Usage count should still work because the import links to all files in the package
            const results = index.find('Helper');
            assert.ok(results.length > 0, 'should find Helper');
            const helper = results[0];
            assert.ok(helper.usageCount >= 1, `Helper should have usages (got ${helper.usageCount})`);

            const formatResults = index.find('Format');
            assert.ok(formatResults.length > 0, 'should find Format');
            const format = formatResults[0];
            assert.ok(format.usageCount >= 1, `Format should have usages (got ${format.usageCount})`);
        } finally {
            rm(dir);
        }
    });
});

// Bug 14: toc --file shows note for files with no detected symbols
describe('fix: toc --file notes empty/generated files', () => {
    it('reports emptyFiles count when --file matches files with no symbols', () => {
        const dir = tmp({
            'go.mod': 'module example.com/app\n\ngo 1.21\n',
            'main.go': `package main

func main() {}
`,
            'generated/zz_generated_types.go': `package generated

// This file has no functions or types detectable by the parser
var _ = "placeholder"
`,
            'generated/zz_generated_data.go': `package generated

// Another generated file with no symbols
var _ = "data"
`
        });
        try {
            const index = idx(dir);
            const toc = index.getToc({ file: 'generated' });
            assert.ok(toc.meta.filteredBy === 'generated', 'should record filteredBy');
            assert.ok(toc.meta.matchedFiles >= 2, 'should match generated files');
            assert.ok(toc.meta.emptyFiles >= 2, 'should report empty files');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #164: Go parameter type disambiguation in callers
// ============================================================================

describe('fix #164: t.Run() should NOT match custom Run() method', () => {
    it('filters out callers where receiverType from function params does not match target', () => {
        const dir = tmp({
            'go.mod': 'module test',
            'controller.go': 'package main\ntype DeploymentController struct{}\nfunc (dc *DeploymentController) Run() {}',
            'main_test.go': 'package main\nimport "testing"\nfunc TestFoo(t *testing.T) {\n  t.Run("sub", nil)\n}',
        });
        try {
            const index = idx(dir);
            const ctx = index.context('Run');
            // t.Run() should NOT appear as a caller of DeploymentController.Run
            const callerNames = ctx.callers.map(c => c.name);
            assert.ok(!callerNames.includes('TestFoo'),
                'TestFoo should NOT be a caller of DeploymentController.Run (t is *testing.T, not DeploymentController)');
        } finally {
            rm(dir);
        }
    });

    it('correctly includes callers where receiverType matches', () => {
        const dir = tmp({
            'go.mod': 'module test',
            'controller.go': 'package main\ntype DeploymentController struct{}\nfunc (dc *DeploymentController) Run() {}',
            'app.go': 'package main\nfunc startController(dc *DeploymentController) {\n  dc.Run()\n}',
        });
        try {
            const index = idx(dir);
            const ctx = index.context('Run');
            const callerNames = ctx.callers.map(c => c.callerName);
            assert.ok(callerNames.includes('startController'),
                'startController should be a caller (dc is *DeploymentController)');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #165: Go directory import links all package files', () => {
    it('counts usages for symbols from all files in imported Go package', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test',
            'pkg/foo/a.go': 'package foo\nfunc FuncA() {}',
            'pkg/foo/b.go': 'package foo\nfunc FuncB() {}',
            'main.go': 'package main\nimport "example.com/test/pkg/foo"\nfunc main() { foo.FuncA(); foo.FuncB() }',
        });
        try {
            const index = idx(dir);
            const a = index.find('FuncA');
            const b = index.find('FuncB');
            assert.ok(a.some(s => s.usageCount > 0), 'FuncA should have usages from main.go');
            assert.ok(b.some(s => s.usageCount > 0), 'FuncB should have usages from main.go');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #167: Go function references detected as callbacks', () => {
    it('detects dc.worker passed as argument as callback reference', () => {
        const dir = tmp({
            'go.mod': 'module test',
            'types.go': 'package main\ntype DC struct{}\nfunc (dc *DC) worker() {}',
            'main.go': 'package main\nfunc UntilWithContext(f func()) {}\nfunc main() {\n  dc := &DC{}\n  UntilWithContext(dc.worker)\n}',
        });
        try {
            const index = idx(dir);
            const mainDef = index.symbols.get('main')?.find(s => s.file.includes('main.go'));
            assert.ok(mainDef, 'main function should exist');
            const callees = index.findCallees(mainDef);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('UntilWithContext'), 'should find UntilWithContext as callee');
            assert.ok(calleeNames.includes('worker'), 'should find worker as callback callee');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #164: callees resolve to correct receiver type (Go)', () => {
    it('resolves callees to correct receiver type via parameter types', () => {
        const dir = tmp({
            'go.mod': 'module test',
            'types.go': 'package main\ntype Server struct{}\nfunc (s *Server) Run() {}\ntype Client struct{}\nfunc (c *Client) Run() {}',
            'main.go': 'package main\nfunc main() {\n  s := &Server{}\n  s.Run()\n}',
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('main')?.find(s => s.file.includes('main.go'));
            assert.ok(def, 'main function should exist');
            const callees = index.findCallees(def);
            // Go methods have receiver (e.g., "*Server") rather than className
            assert.ok(callees.some(c => c.receiver && c.receiver.includes('Server')),
                'Should resolve to Server.Run');
            assert.ok(!callees.some(c => c.receiver && c.receiver.includes('Client')),
                'Should NOT resolve to Client.Run');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #164: countSymbolUsages misses Go same-package usages
// Go files in the same package reference each other without imports.
// countSymbolUsages must include same-directory .go files in relevantFiles.
// ============================================================================
describe('fix #164: countSymbolUsages includes Go same-package files', () => {
    it('counts usages from sibling files in same Go package', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/controller.go': [
                'package pkg',
                'func helper() int { return 1 }',
                'func Main() { helper() }',
            ].join('\n'),
            'pkg/worker.go': [
                'package pkg',
                'func Worker() { helper() }',
            ].join('\n'),
            'pkg/utils.go': [
                'package pkg',
                'func Utils() { helper() }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const results = index.find('helper');
            const helperResult = results.find(r => r.name === 'helper');
            assert.ok(helperResult, 'Should find helper');
            // helper is defined once and called 3 times (Main, Worker, Utils)
            assert.ok(helperResult.usageCount >= 4,
                `Expected at least 4 usages (1 def + 3 calls), got ${helperResult.usageCount}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #165: about usages count inconsistent with usages command
// about() was calling usages() without test exclusions, while the usages
// command applies them by default.
// ============================================================================
describe('fix #165: about and usages command agree on counts', () => {
    it('about excludes test file usages by default', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/lib.go': [
                'package pkg',
                'func Process() int { return 1 }',
            ].join('\n'),
            'pkg/lib_test.go': [
                'package pkg',
                'import "testing"',
                'func TestProcess(t *testing.T) { Process() }',
            ].join('\n'),
            'cmd/main.go': [
                'package main',
                'import "example.com/test/pkg"',
                'func main() { pkg.Process() }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const aboutResult = index.about('Process', { file: 'pkg/lib.go' });
            const usagesExcludeTests = index.usages('Process', {
                codeOnly: true,
                exclude: ['test', 'spec', '__tests__', '__mocks__', 'fixture', 'mock'],
            });
            // about should match usages-with-test-exclusions
            const aboutCalls = aboutResult.usages.calls;
            const usagesWithExcl = usagesExcludeTests.filter(u => u.usageType === 'call').length;
            assert.strictEqual(aboutCalls, usagesWithExcl,
                `about calls (${aboutCalls}) should match usages with test exclusion (${usagesWithExcl})`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #166: deadcode false positives for Go methods called via receiver
// buildUsageIndex() was skipping all field_identifier nodes on the right side
// of selector_expression, including method calls like dc.syncDeployment().
// ============================================================================
describe('fix #166: deadcode does not report Go methods called via receiver', () => {
    it('receiver.method() calls are counted as usages', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/controller.go': [
                'package pkg',
                '',
                'type Controller struct{}',
                '',
                'func (c *Controller) syncDeployment() {',
                '    c.getReplicaSets()',
                '}',
                '',
                'func (c *Controller) getReplicaSets() int {',
                '    return 0',
                '}',
                '',
                'func (c *Controller) Run() {',
                '    c.syncDeployment()',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);
            assert.ok(!deadNames.includes('syncDeployment'),
                'syncDeployment should NOT be dead — called via c.syncDeployment()');
            assert.ok(!deadNames.includes('getReplicaSets'),
                'getReplicaSets should NOT be dead — called via c.getReplicaSets()');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #167: verify drops Go qualified function calls (package.Func)
// verify.js was comparing receiver to target filename, but Go package aliases
// come from the directory name (last segment of import path), not the filename.
// ============================================================================
describe('fix #167: verify keeps Go package-qualified function calls', () => {
    it('controller.FilterActive() not dropped when file is controller_utils.go', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/controller/controller_utils.go': [
                'package controller',
                'func FilterActive(items []int) []int {',
                '    return items',
                '}',
            ].join('\n'),
            'cmd/app.go': [
                'package main',
                'import "example.com/test/pkg/controller"',
                'func run() {',
                '    controller.FilterActive(nil)',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.verify('FilterActive', { file: 'controller_utils' });
            assert.ok(result.valid >= 1,
                `Expected at least 1 valid call site, got ${result.valid}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #168: graph command shows Go test files as source dependencies
// When building importGraph for Go, _test.go files should not be linked
// as dependencies of non-test source files.
// ============================================================================
describe('fix #168: graph excludes Go test files from non-test dependencies', () => {
    it('non-test file does not depend on _test.go files', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/lib.go': [
                'package pkg',
                'func Helper() int { return 1 }',
            ].join('\n'),
            'pkg/lib_test.go': [
                'package pkg',
                'import "testing"',
                'func TestHelper(t *testing.T) { Helper() }',
            ].join('\n'),
            'cmd/main.go': [
                'package main',
                'import "example.com/test/pkg"',
                'func main() { pkg.Helper() }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const graph = index.graph('cmd/main.go', { direction: 'imports' });
            const depFiles = graph.nodes.map(n => n.relativePath);
            const hasTestFile = depFiles.some(f => f.endsWith('_test.go'));
            assert.ok(!hasTestFile,
                `Non-test file should not depend on test files, got: ${depFiles.filter(f => f.endsWith('_test.go'))}`);
        } finally {
            rm(dir);
        }
    });

    it('test file CAN depend on _test.go siblings', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/lib.go': [
                'package pkg',
                'func Helper() int { return 1 }',
            ].join('\n'),
            'pkg/lib_test.go': [
                'package pkg',
                'import "testing"',
                'func TestHelper(t *testing.T) { Helper() }',
            ].join('\n'),
            'pkg/helpers_test.go': [
                'package pkg',
                'import "example.com/test/pkg"',
                'func testUtil() { pkg.Helper() }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // Test files importing the same package can see sibling test files
            const graph = index.graph('pkg/helpers_test.go', { direction: 'imports' });
            // Should include pkg/lib.go at minimum
            const depFiles = graph.nodes.map(n => n.relativePath);
            assert.ok(depFiles.some(f => f === 'pkg/lib.go'),
                'Test file should see lib.go as dependency');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #169: callee resolution uses importGraph for better disambiguation
// When multiple packages export the same name, prefer the one imported
// by the caller's file.
// ============================================================================
describe('fix #169: callee resolution prefers imported package definitions', () => {
    it('resolves callee to imported package rather than random match', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/a/register.go': [
                'package a',
                'func Register() {}',
            ].join('\n'),
            'pkg/b/register.go': [
                'package b',
                'func Register() {}',
            ].join('\n'),
            'cmd/main.go': [
                'package main',
                'import "example.com/test/pkg/a"',
                'func main() {',
                '    a.Register()',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const callees = index.findCallees(
                index.find('main').find(s => s.file.includes('cmd/main.go')),
                {}
            );
            const registerCallee = callees.find(c => c.name === 'Register');
            if (registerCallee) {
                assert.ok(registerCallee.relativePath.includes('pkg/a/'),
                    `Should resolve to pkg/a/register.go, got ${registerCallee.relativePath}`);
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #170: Go unexported function visibility enforcement
// Unexported (lowercase) Go functions are package-private. Callers from other
// packages should be filtered out to prevent cross-package name collisions.
// ============================================================================
describe('fix #170: Go unexported visibility in findCallers', () => {
    it('filters cross-package callers for unexported functions', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/a/handler.go': [
                'package a',
                'func handleErr(err error) {}',
                'func Process() { handleErr(nil) }',
            ].join('\n'),
            'pkg/b/handler.go': [
                'package b',
                'func handleErr(err error) {}',
                'func Run() { handleErr(nil) }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const defs = index.find('handleErr').filter(d => d.file.includes('pkg/a/'));
            assert.ok(defs.length > 0, 'Should find handleErr in pkg/a');
            const callers = index.findCallers('handleErr', {
                targetDefinitions: defs,
            });
            const callerFiles = callers.map(c => c.relativePath);
            assert.ok(callerFiles.every(f => f.startsWith('pkg/a/')),
                `All callers should be from pkg/a, got: ${callerFiles}`);
            assert.ok(!callerFiles.some(f => f.startsWith('pkg/b/')),
                'Should NOT include callers from pkg/b');
        } finally {
            rm(dir);
        }
    });

    it('allows same-package callers for unexported functions', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/helper.go': [
                'package pkg',
                'func helper() int { return 1 }',
            ].join('\n'),
            'pkg/main.go': [
                'package pkg',
                'func Main() int { return helper() }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('helper', {});
            assert.ok(callers.length >= 1, 'Should find same-package caller');
            assert.ok(callers.some(c => c.relativePath.includes('main.go')),
                'Should include pkg/main.go as caller');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #171: impact() Go package-qualified call filtering
// impact() was filtering out Go pkg.Func() calls because it compared receiver
// to filename instead of directory name. Same fix as verify (#167) but for impact.
// ============================================================================
describe('fix #171: impact keeps Go package-qualified calls', () => {
    it('impact includes controller.FilterActive() when file is controller_utils.go', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/controller/controller_utils.go': [
                'package controller',
                'func FilterActive(items []int) []int {',
                '    return items',
                '}',
            ].join('\n'),
            'cmd/app.go': [
                'package main',
                'import "example.com/test/pkg/controller"',
                'func run() {',
                '    controller.FilterActive(nil)',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const result = index.impact('FilterActive', { file: 'controller_utils' });
            assert.ok(result, 'impact should return result');
            assert.ok(result.totalCallSites >= 1,
                `Expected at least 1 call site, got ${result.totalCallSites}`);
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #172: findCallees should not resolve non-callable types as callees
// When a local variable name matches a global interface/struct, the callee
// resolution should skip non-callable types without binding evidence.
// ============================================================================
describe('fix #172: callees skip non-callable types (interface/struct)', () => {
    it('local variable call does not resolve to interface definition', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/handler.go': [
                'package pkg',
                'type Handler interface {',
                '    Handle()',
                '}',
            ].join('\n'),
            'pkg/crash.go': [
                'package pkg',
                'func HandleCrash(handlers []func()) {',
                '    for _, handler := range handlers {',
                '        handler()',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const crashDef = index.find('HandleCrash')[0];
            assert.ok(crashDef, 'Should find HandleCrash');
            const callees = index.findCallees(crashDef, {});
            // 'handler' should NOT appear as a callee (it's a local variable, and
            // the only symbol named 'handler' is an interface, which is non-callable)
            const handlerCallee = callees.find(c => c.name === 'Handler' || c.type === 'interface');
            assert.ok(!handlerCallee,
                'Should not resolve local variable to interface definition');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #174: Add 'field' to NON_CALLABLE_TYPES
// ============================================================================
describe('fix #174: field type excluded from callees', () => {
    it('field_identifier as field (not method) should not appear as callee', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'types.go': `package main
type PodAction struct {
    KillPod bool
    Name    string
}
func (p PodAction) String() string {
    return fmt.Sprintf("kill=%v name=%s", p.KillPod, p.Name)
}
`,
            'methods.go': `package main
func KillPod(pod *Pod) error {
    return nil
}
`
        });
        try {
            const index = idx(dir);
            const callees = index.findCallees(
                index.find('String').find(d => d.className === 'PodAction'), {}
            );
            // KillPod and Name as field accesses should not show as callees
            const killPodCallee = callees.find(c => c.name === 'KillPod');
            assert.ok(!killPodCallee || killPodCallee.type === 'field',
                'Field access KillPod should not appear as callable callee');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #175: Go stack traces carry forward function name
// ============================================================================
describe('fix #175: Go stack trace function names', () => {
    it('links function name from previous line to file:line frame', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main
func syncDeployment() {
    panic("test")
}
func processNextWorkItem() {
    syncDeployment()
}
`
        });
        try {
            const index = idx(dir);
            const stack = `goroutine 1 [running]:
example.com/test.syncDeployment()
\tmain.go:3
example.com/test.processNextWorkItem()
\tmain.go:6`;
            const result = parseStackTrace(index, stack);
            assert.ok(result.frames.length >= 2, 'Should parse at least 2 frames');
            assert.strictEqual(result.frames[0].function, 'syncDeployment');
            assert.strictEqual(result.frames[1].function, 'processNextWorkItem');
        } finally {
            rm(dir);
        }
    });

    it('handles Go method receiver syntax (*Type).Method', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main
type Server struct{}
func (s *Server) Run() { panic("test") }
`
        });
        try {
            const index = idx(dir);
            const stack = `goroutine 1 [running]:
example.com/test.(*Server).Run()
\tmain.go:3`;
            const result = parseStackTrace(index, stack);
            assert.ok(result.frames.length >= 1);
            assert.strictEqual(result.frames[0].function, 'Run');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #176: Cache deduplication (symbols not stored twice)
// ============================================================================
describe('fix #176: cache strips symbols from file entries', () => {
    it('cache file entries do not contain symbols/bindings arrays', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main
func Hello() string { return "hello" }
func World() string { return "world" }
`
        });
        try {
            const index = idx(dir);
            const cachePath = path.join(dir, '.ucn-cache', 'index.json');
            saveCache(index, cachePath);
            const cacheData = JSON.parse(fs.readFileSync(cachePath, 'utf-8'));
            // File entries should NOT contain symbols or bindings
            for (const [, entry] of cacheData.files) {
                assert.ok(!entry.symbols, 'File entry should not contain symbols');
                assert.ok(!entry.bindings, 'File entry should not contain bindings');
            }
            assert.strictEqual(cacheData.version, 7, 'Cache version should be 7');
        } finally {
            rm(dir);
        }
    });

    it('loadCache reconstructs symbols and bindings in file entries', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main
func Hello() string { return "hello" }
func World() string { return "world" }
`
        });
        try {
            const index = idx(dir);
            const cachePath = path.join(dir, '.ucn-cache', 'index.json');
            saveCache(index, cachePath);

            // Create a fresh index and load from cache
            const index2 = new ProjectIndex(dir, { quiet: true });
            const loaded = loadCache(index2, cachePath);
            assert.ok(loaded, 'Cache should load successfully');

            // File entries should have reconstructed symbols and bindings
            for (const [, entry] of index2.files) {
                assert.ok(Array.isArray(entry.symbols), 'symbols should be reconstructed');
                assert.ok(Array.isArray(entry.bindings), 'bindings should be reconstructed');
            }

            // Verify symbols are correct
            const helloDefs = index2.symbols.get('Hello');
            assert.ok(helloDefs && helloDefs.length > 0, 'Hello should be in symbols');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #177: Go unexported callback visibility
// ============================================================================
describe('fix #177: Go unexported callback visibility filtering', () => {
    it('unexported method passed as callback should only show callers from same package', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/deploy/controller.go': `package deploy

type DeployController struct{}

func (dc *DeployController) worker() { }

func (dc *DeployController) Start() {
    run(dc.worker)
}
`,
            'pkg/replica/controller.go': `package replica

type ReplicaController struct{}

func (rc *ReplicaController) worker() { }

func (rc *ReplicaController) Start() {
    run(rc.worker)
}
`,
            'pkg/run/run.go': `package run
func run(fn func()) { fn() }
`
        });
        try {
            const index = idx(dir);
            // Find the deploy worker definition
            const workerDefs = index.find('worker');
            const deployWorker = workerDefs.find(d => d.relativePath?.includes('deploy'));
            assert.ok(deployWorker, 'Should find deploy worker');

            const callers = index.findCallers('worker', {
                targetDefinitions: [deployWorker]
            });
            // Only deploy's Start should be a caller, not replica's Start
            const callerFiles = callers.map(c => c.relativePath || '');
            const hasDeployCaller = callerFiles.some(f => f.includes('deploy'));
            const hasReplicaCaller = callerFiles.some(f => f.includes('replica'));
            assert.ok(hasDeployCaller,
                'Deploy controller should be a caller');
            assert.ok(!hasReplicaCaller,
                'Replica controller should NOT be a caller of deploy worker');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #178: diff-impact receiver filtering for common method names
// ============================================================================
describe('fix #178: diff-impact receiver filtering', () => {
    it('findCallers propagates receiverType in results', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'cache.go': `package main
type Cache struct{}
func (c *Cache) Get(key string) string { return "" }
func NewCache() *Cache { return &Cache{} }
`,
            'handler.go': `package main
func handleRequest(c *Cache) {
    c.Get("key")
}
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('Get', {});
            // With typed param `c *Cache`, receiverType should be propagated
            const withType = callers.filter(c => c.receiverType === 'Cache');
            assert.ok(withType.length > 0,
                'receiverType should be propagated in caller results');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #179: Go method receiver filtering in impact() uses receiver, not className
// ============================================================================
describe('fix #179: Go impact() uses receiver for method disambiguation', () => {
    it('impact() filters callers for Go methods using receiver type', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'cache.go': `package main
type RealCache struct{}
func (c *RealCache) Get(key string) string { return "" }

type FakeCache struct{}
func (c *FakeCache) Get(key string) string { return "" }
`,
            'handler.go': `package main
func handleRequest(c *RealCache) {
    c.Get("key")
}
`,
            'test_handler.go': `package main
func testHandler(c *FakeCache) {
    c.Get("test")
}
`
        });
        try {
            const index = idx(dir);
            // Impact for FakeCache.Get should NOT include handleRequest's caller
            const fakeDefs = index.find('Get').filter(d =>
                d.receiver && d.receiver.includes('FakeCache'));
            assert.ok(fakeDefs.length > 0, 'Should find FakeCache.Get');
            const impact = index.impact('Get', {
                className: 'FakeCache',
                file: fakeDefs[0].relativePath
            });
            // handleRequest calls c.Get with RealCache receiver — should be filtered
            const callerNames = (impact?.callSites || []).map(c => c.callerName);
            assert.ok(!callerNames.includes('handleRequest'),
                'handleRequest (RealCache) should not appear in FakeCache.Get impact');
        } finally {
            rm(dir);
        }
    });

    it('impact() works for Go methods without className', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'server.go': `package main
type Server struct{}
func (s *Server) Run() { }
`,
            'main.go': `package main
func main() {
    s := &Server{}
    s.Run()
}
`
        });
        try {
            const index = idx(dir);
            const impact = index.impact('Run');
            assert.ok(impact, 'impact() should return results for Go method');
            assert.ok(impact.totalCallSites >= 1, 'Should find at least 1 caller');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #180: findCallees filters non-callable types on receiverType path
// ============================================================================
describe('fix #180: findCallees filters non-callable types', () => {
    it('struct fields should not appear as callees via receiverType path', () => {
        const { NON_CALLABLE_TYPES } = require('../core/shared');
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'types.go': `package main
type OwnerReference struct {
    Name string
    Kind string
}
func NewOwnerRef() *OwnerReference { return &OwnerReference{} }
`,
            'resolver.go': `package main
func resolveControllerRef(ref *OwnerReference) string {
    return ref.Name + ref.Kind
}
`
        });
        try {
            const index = idx(dir);
            const resolverDef = index.find('resolveControllerRef')[0];
            assert.ok(resolverDef, 'Should find resolveControllerRef');
            const callees = index.findCallees(resolverDef, {});
            // Name and Kind are struct fields — should not appear as callable callees
            const fieldCallees = callees.filter(c =>
                (c.name === 'Name' || c.name === 'Kind') &&
                NON_CALLABLE_TYPES.has(c.type));
            assert.strictEqual(fieldCallees.length, 0,
                'Struct fields should not appear as callees');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #181: className set from receiver for Go/Rust methods
// ============================================================================
describe('fix #181: Go/Rust methods get className from receiver', () => {
    it('Go methods have className set from receiver', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'server.go': `package main
type Server struct{}
func (s *Server) Run() { }
func (s *Server) Stop() { }
`
        });
        try {
            const index = idx(dir);
            const runDefs = index.find('Run');
            const serverRun = runDefs.find(d => d.receiver?.includes('Server'));
            assert.ok(serverRun, 'Should find Server.Run');
            assert.strictEqual(serverRun.className, 'Server',
                'Go method should have className set from receiver');
        } finally {
            rm(dir);
        }
    });

    it('impact() works with className for Go methods', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'types.go': `package main
type RealCache struct{}
func (c *RealCache) Get(key string) string { return "" }

type FakeCache struct{}
func (c *FakeCache) Get(key string) string { return "" }
`,
            'handler.go': `package main
func handleReal(c *RealCache) { c.Get("k") }
func handleFake(c *FakeCache) { c.Get("k") }
`
        });
        try {
            const index = idx(dir);
            const impact = index.impact('Get', { className: 'FakeCache' });
            assert.ok(impact, 'impact should work with className for Go methods');
            const callerNames = (impact.callSites || []).map(c => c.callerName);
            assert.ok(!callerNames.includes('handleReal'),
                'handleReal (RealCache) should NOT appear in FakeCache.Get impact');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #182: Go package-qualified calls not marked as method calls
// ============================================================================
describe('fix #182: Go package-qualified calls marked isMethod: false', () => {
    it('pkg.Func() should not be isMethod when receiver is import alias', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'util.go': `package util
func Get() string { return "ok" }
`,
            'main.go': `package main
import "example.com/test/util"
func handler() { util.Get() }
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('Get', {});
            const caller = callers.find(c => c.callerName === 'handler');
            assert.ok(caller, 'Should find handler as caller');
            // The call should be isMethod: false since util is an import alias
            assert.ok(!caller.isMethod || caller.isMethod === false,
                'Package-qualified call should not be isMethod');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #183: Function-typed struct fields are callable
// ============================================================================
describe('fix #183: Go function-typed struct fields as callees', () => {
    it('function-typed field should appear as callee', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'controller.go': `package main
type Controller struct {
    syncHandler  func(key string) error
    Name         string
}
func (c *Controller) processNextWorkItem() {
    c.syncHandler("default/my-deployment")
    _ = c.Name
}
`
        });
        try {
            const index = idx(dir);
            const procDef = index.find('processNextWorkItem')[0];
            assert.ok(procDef, 'Should find processNextWorkItem');
            const callees = index.findCallees(procDef, {});
            const syncHandler = callees.find(c => c.name === 'syncHandler');
            assert.ok(syncHandler, 'syncHandler (function-typed field) should appear as callee');
            // Name (string field) should NOT appear
            const nameCallee = callees.find(c => c.name === 'Name');
            assert.ok(!nameCallee, 'Name (string field) should not appear as callee');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #184: Go renamed imports detected as package calls
// ============================================================================
describe('fix #184: Go renamed import aliases', () => {
    it('renamed import alias recognized as package call (isMethod: false)', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/version/version.go': `package version
func Get() string { return "1.0" }
`,
            'main.go': `package main
import utilversion "example.com/test/pkg/version"
func handler() string { return utilversion.Get() }
`
        });
        try {
            const index = idx(dir);
            // utilversion.Get() should resolve correctly
            const callers = index.findCallers('Get', {});
            const caller = callers.find(c => c.callerName === 'handler');
            assert.ok(caller, 'Should find handler as caller of Get');
            // Should not be marked as method call
            assert.ok(!caller.isMethod,
                'Renamed import call should not be isMethod');
        } finally {
            rm(dir);
        }
    });

    it('importNames stored in fileEntry includes renamed aliases', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main
import (
    "fmt"
    utilversion "example.com/test/version"
)
func main() { fmt.Println(utilversion.Get()) }
`
        });
        try {
            const index = idx(dir);
            const mainFile = Array.from(index.files.values()).find(f =>
                f.relativePath === 'main.go');
            assert.ok(mainFile, 'Should find main.go');
            assert.ok(mainFile.importNames, 'Should have importNames');
            assert.ok(mainFile.importNames.includes('fmt'), 'Should include fmt');
            assert.ok(mainFile.importNames.includes('utilversion'),
                'Should include renamed alias utilversion');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #185: Method vs non-method cross-matching filter
// ============================================================================
describe('fix #185: method/non-method cross-matching', () => {
    it('method call should not match standalone function', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'errorf.go': `package main
func Errorf(format string, args ...interface{}) { }
`,
            'test.go': `package main
import "testing"
func TestSomething(t *testing.T) {
    t.Errorf("failed: %v", err)
}
`
        });
        try {
            const index = idx(dir);
            // t.Errorf() is a method call — should NOT match standalone Errorf
            const callers = index.findCallers('Errorf', {});
            const testCaller = callers.find(c => c.callerName === 'TestSomething');
            assert.ok(!testCaller,
                't.Errorf() should not match standalone func Errorf');
        } finally {
            rm(dir);
        }
    });

    it('non-method call should not match class method', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'controller.go': `package main
type DeploymentController struct{}
func (dc *DeploymentController) Run(workers int) { }
`,
            'cli/cli.go': `package cli
func Run() { }
`,
            'main.go': `package main
import "example.com/test/cli"
func main() {
    cli.Run()
}
`
        });
        try {
            const index = idx(dir);
            // cli.Run() is a package call — should NOT match DeploymentController.Run
            const runDefs = index.find('Run');
            const dcRun = runDefs.find(d => d.className === 'DeploymentController');
            assert.ok(dcRun, 'Should find DeploymentController.Run');
            const callers = index.findCallers('Run', {
                targetDefinitions: [dcRun]
            });
            const mainCaller = callers.find(c => c.callerName === 'main');
            assert.ok(!mainCaller,
                'cli.Run() should not match DeploymentController.Run');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #186: _buildTypedLocalTypeMap handles multi-value returns and pkg prefix
// ============================================================================
describe('fix #186: Go New* multi-value returns', () => {
    it('x, err := pkg.NewFoo() maps x to Foo type', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/controller.go': `package pkg
type DeploymentController struct{}
func (dc *DeploymentController) Run() { }
func NewDeploymentController() (*DeploymentController, error) {
    return &DeploymentController{}, nil
}
`,
            'main.go': `package main
import "example.com/test/pkg"
func startController() {
    dsc, err := pkg.NewDeploymentController()
    if err != nil { return }
    dsc.Run()
}
`
        });
        try {
            const index = idx(dir);
            const startDef = index.find('startController')[0];
            assert.ok(startDef, 'Should find startController');
            const callees = index.findCallees(startDef, {});
            const runCallee = callees.find(c => c.name === 'Run');
            assert.ok(runCallee, 'Run should be resolved as callee via NewDeploymentController type');
            // Should resolve to DeploymentController.Run specifically
            if (runCallee.className) {
                assert.strictEqual(runCallee.className, 'DeploymentController',
                    'Should resolve to DeploymentController.Run');
            }
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// Fix #188: resolveSymbol prefers definitions from more-imported packages
// ============================================================================
describe('fix #188: resolveSymbol import popularity tiebreaker', () => {
    it('prefers definition from more-imported package', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/common/scheme.go': `package common
func Scheme() string { return "https" }
`,
            'pkg/rare/scheme.go': `package rare
func Scheme() string { return "ftp" }
`,
            'handler1.go': `package main
import "example.com/test/pkg/common"
func h1() { common.Scheme() }
`,
            'handler2.go': `package main
import "example.com/test/pkg/common"
func h2() { common.Scheme() }
`,
            'handler3.go': `package main
import "example.com/test/pkg/common"
func h3() { common.Scheme() }
`,
            'rare_user.go': `package main
import "example.com/test/pkg/rare"
func r1() { rare.Scheme() }
`
        });
        try {
            const index = idx(dir);
            const { def } = index.resolveSymbol('Scheme');
            assert.ok(def, 'Should resolve Scheme');
            // common/scheme.go is imported by 3 files, rare/scheme.go by 1
            assert.ok(def.relativePath.includes('common'),
                'Should prefer definition from more-imported package');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// fix #189: Function-typed parameter calls should not match global functions
// ============================================================================

describe('fix #189: func-typed param calls excluded from callers', () => {
    it('calls to function-typed parameters should not appear as callers of global functions', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'match.go': `package webhook
func match(obj interface{}) bool {
    return obj != nil
}
`,
            'claim.go': `package claim
import "example.com/test/webhook"
func ClaimObject(match func(interface{}) bool, release func(interface{}) error) {
    if match(nil) {
        release(nil)
    }
}
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('match');
            // match() inside ClaimObject is calling the parameter, not webhook.match
            const fromClaim = callers.filter(c => c.relativePath === 'claim.go');
            assert.strictEqual(fromClaim.length, 0,
                'Function-typed parameter call should not be reported as caller of global match');
        } finally {
            rm(dir);
        }
    });

    it('function-typed params are tracked in Go findCallsInCode', () => {
        const { getParser } = require('../languages');
        const goParser = getParser('go');
        const goModule = require('../languages/go');
        const code = `package test
func Process(filter func(string) bool, handler func(string) error) {
    if filter("test") {
        handler("test")
    }
    fmt.Println("done")
}
`;
        const calls = goModule.findCallsInCode(code, goParser);
        // filter() and handler() should NOT appear — they're func-typed params
        const filterCalls = calls.filter(c => c.name === 'filter');
        const handlerCalls = calls.filter(c => c.name === 'handler');
        assert.strictEqual(filterCalls.length, 0, 'filter() is a func-typed param, should be skipped');
        assert.strictEqual(handlerCalls.length, 0, 'handler() is a func-typed param, should be skipped');
        // Println should still be detected
        const printlnCalls = calls.filter(c => c.name === 'Println');
        assert.ok(printlnCalls.length > 0, 'Println should still be detected');
    });

    it('shared-type func params: adopt, release func(...) both skipped', () => {
        const { getParser } = require('../languages');
        const goParser = getParser('go');
        const goModule = require('../languages/go');
        const code = `package test
func ClaimObject(adopt, release func(interface{}) error) {
    adopt(obj)
    release(obj)
    fmt.Println("done")
}
`;
        const calls = goModule.findCallsInCode(code, goParser);
        const adoptCalls = calls.filter(c => c.name === 'adopt');
        const releaseCalls = calls.filter(c => c.name === 'release');
        assert.strictEqual(adoptCalls.length, 0, 'adopt is a func-typed param, should be skipped');
        assert.strictEqual(releaseCalls.length, 0, 'release is a func-typed param, should be skipped');
    });
});

// ============================================================================
// fix #190: New*() constructor inference for receiverType in Go parser
// ============================================================================

describe('fix #190: New*() receiver type inference in Go parser', () => {
    it('infers receiverType from NewFoo() assignments', () => {
        const { getParser } = require('../languages');
        const goParser = getParser('go');
        const goModule = require('../languages/go');
        const code = `package test
import "pkg"
func main() {
    dsc := NewDeploymentController(ctx)
    dsc.Run(ctx)
    c, err := pkg.NewCache(opts)
    c.Get("key")
}
`;
        const calls = goModule.findCallsInCode(code, goParser, { imports: ['pkg'] });
        const runCall = calls.find(c => c.name === 'Run' && c.receiver === 'dsc');
        assert.ok(runCall, 'Should find dsc.Run() call');
        assert.strictEqual(runCall.receiverType, 'DeploymentController',
            'Should infer DeploymentController from NewDeploymentController()');
        const getCall = calls.find(c => c.name === 'Get' && c.receiver === 'c');
        assert.ok(getCall, 'Should find c.Get() call');
        assert.strictEqual(getCall.receiverType, 'Cache',
            'Should infer Cache from pkg.NewCache()');
    });

    it('New*() inference improves findCallers receiver disambiguation', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'controller.go': `package controller
type DeploymentController struct{}
func (dc *DeploymentController) Run(ctx interface{}) {}
type StatefulSetController struct{}
func (sc *StatefulSetController) Run(ctx interface{}) {}
`,
            'main.go': `package controller
func startDeploy() {
    dsc := NewDeploymentController()
    dsc.Run(ctx)
}
func startStateful() {
    ssc := NewStatefulSetController()
    ssc.Run(ctx)
}
`
        });
        try {
            const index = idx(dir);
            // When asking about DeploymentController.Run specifically
            const defs = index.symbols.get('Run') || [];
            const dcDef = defs.find(d => d.className === 'DeploymentController');
            assert.ok(dcDef, 'Should find DeploymentController.Run def');
            const callers = index.findCallers('Run', { targetDefinitions: [dcDef] });
            const dcCallers = callers.filter(c => c.callerName === 'startDeploy');
            const scCallers = callers.filter(c => c.callerName === 'startStateful');
            assert.ok(dcCallers.length > 0, 'Should find startDeploy as caller');
            assert.strictEqual(scCallers.length, 0,
                'startStateful calls StatefulSetController.Run, not DeploymentController.Run');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// ENTRYPOINTS: Go framework detection (Gin, net/http)
// ============================================================================

describe('Entrypoints: Gin/net-http detection', () => {
    const { detectEntrypoints } = require('../core/entrypoints');

    it('detects Gin router.GET/POST handlers', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `
package main

import "github.com/gin-gonic/gin"

func listUsers(c *gin.Context) {
    c.JSON(200, []string{})
}

func createUser(c *gin.Context) {
    c.JSON(201, nil)
}

func main() {
    r := gin.Default()
    r.GET("/users", listUsers)
    r.POST("/users", createUser)
    r.Run()
}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('listUsers'), 'should detect listUsers as Gin handler');
            assert.ok(names.includes('createUser'), 'should detect createUser as Gin handler');
            const ep = eps.find(e => e.name === 'listUsers');
            assert.strictEqual(ep.framework, 'gin');
            assert.strictEqual(ep.type, 'http');
        } finally { rm(dir); }
    });

    it('detects http.HandleFunc handlers', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'server.go': `
package main

import "net/http"

func healthHandler(w http.ResponseWriter, r *http.Request) {
    w.Write([]byte("ok"))
}

func main() {
    http.HandleFunc("/health", healthHandler)
    http.ListenAndServe(":8080", nil)
}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('healthHandler'), 'should detect http.HandleFunc handler');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Go callback detection (isPotentialCallback for plain identifiers in argument_list)
// Verifies that the Go parser's plain-identifier callback detection (e.g.,
// r.GET("/users", listUsers)) does not introduce false positives in
// findCallers/findCallees when variables appear in argument_list.
// ============================================================================

describe('Regression: Go callback detection noise (isPotentialCallback)', () => {
    it('detects function references passed as callbacks', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'main.go': `package main

import "fmt"

func process(data string) string {
    return fmt.Sprintf("processed: %s", data)
}

func transform(fn func(string) string, input string) string {
    return fn(input)
}

func main() {
    result := transform(process, "hello")
    fmt.Println(result)
}
`
        });
        try {
            const index = idx(dir);

            // process is passed as callback to transform — main should be a caller
            const processCallers = index.findCallers('process');
            assert.ok(processCallers.length > 0, 'process should have callers');
            assert.ok(processCallers.some(c => (c.name || c.callerName) === 'main'),
                'main should be a caller of process (callback)');
            assert.ok(processCallers.some(c => c.isFunctionReference),
                'caller should be marked as isFunctionReference');

            // transform is called directly — main should be a caller
            const transformCallers = index.findCallers('transform');
            assert.ok(transformCallers.length > 0, 'transform should have callers');
            assert.ok(transformCallers.some(c => (c.name || c.callerName) === 'main'),
                'main should be a caller of transform');
        } finally {
            rm(dir);
        }
    });

    it('does not create phantom callers from variables in argument_list', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'main.go': `package main

import "fmt"

func process(data string) string {
    return fmt.Sprintf("processed: %s", data)
}

func transform(fn func(string) string, input string) string {
    return fn(input)
}

func main() {
    result := transform(process, "hello")
    fmt.Println(result)
}
`
        });
        try {
            const index = idx(dir);

            // Variables like data, input, result appear in argument_list but are NOT
            // functions — they should not appear as callers or callees
            for (const varName of ['data', 'input', 'result']) {
                const callers = index.findCallers(varName);
                assert.strictEqual(callers.length, 0,
                    `variable "${varName}" should not have callers (not in symbol table)`);
            }
        } finally {
            rm(dir);
        }
    });

    it('findCallees includes callbacks alongside direct calls', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'main.go': `package main

import "fmt"

func process(data string) string {
    return fmt.Sprintf("processed: %s", data)
}

func transform(fn func(string) string, input string) string {
    return fn(input)
}

func main() {
    result := transform(process, "hello")
    fmt.Println(result)
}
`
        });
        try {
            const index = idx(dir);
            const mainDef = index.symbols.get('main')?.[0];
            assert.ok(mainDef, 'main definition should exist');

            const callees = index.findCallees(mainDef, { includeUncertain: true });
            const calleeNames = callees.map(c => c.name);

            assert.ok(calleeNames.includes('transform'),
                'findCallees(main) should include transform (direct call)');
            assert.ok(calleeNames.includes('process'),
                'findCallees(main) should include process (callback reference)');

            // Variables should NOT be callees
            for (const varName of ['data', 'input', 'result', 'hello']) {
                assert.ok(!calleeNames.includes(varName),
                    `variable "${varName}" should not be a callee`);
            }
        } finally {
            rm(dir);
        }
    });

    it('Gin-style route handler detection via callback', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'router.go': `package main

import (
    "fmt"
    "net/http"
)

func listUsers(w http.ResponseWriter, r *http.Request) {
    users := getUsers()
    fmt.Fprintf(w, "%v", users)
}

func getUsers() []string {
    return []string{"alice", "bob"}
}

func createUser(w http.ResponseWriter, r *http.Request) {
    name := r.URL.Query().Get("name")
    fmt.Fprintf(w, "created: %s", name)
}

func setupRoutes(mux *http.ServeMux) {
    mux.HandleFunc("/users", listUsers)
    mux.HandleFunc("/users/create", createUser)
}

func main() {
    mux := http.NewServeMux()
    setupRoutes(mux)
    http.ListenAndServe(":8080", mux)
}
`
        });
        try {
            const index = idx(dir);

            // Route handlers should be detected as callees of setupRoutes
            const setupDef = index.symbols.get('setupRoutes')?.[0];
            assert.ok(setupDef, 'setupRoutes definition should exist');

            const callees = index.findCallees(setupDef, { includeUncertain: true });
            const calleeNames = callees.map(c => c.name);

            assert.ok(calleeNames.includes('listUsers'),
                'setupRoutes should have listUsers as callee (route callback)');
            assert.ok(calleeNames.includes('createUser'),
                'setupRoutes should have createUser as callee (route callback)');

            // Route handlers should list setupRoutes as caller
            const listUsersCallers = index.findCallers('listUsers');
            assert.ok(listUsersCallers.some(c => (c.name || c.callerName) === 'setupRoutes'),
                'listUsers should have setupRoutes as caller');
            assert.ok(listUsersCallers.some(c => c.isFunctionReference),
                'listUsers caller should be marked as isFunctionReference');

            const createUserCallers = index.findCallers('createUser');
            assert.ok(createUserCallers.some(c => (c.name || c.callerName) === 'setupRoutes'),
                'createUser should have setupRoutes as caller');

            // Variables should NOT be phantom callers/callees
            for (const varName of ['users', 'name', 'mux', 'w', 'r']) {
                const callers = index.findCallers(varName);
                assert.strictEqual(callers.length, 0,
                    `variable "${varName}" should not have callers`);
            }
        } finally {
            rm(dir);
        }
    });

    it('context() correctly reports callback relationships', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'main.go': `package main

func process(x int) int {
    return x * 2
}

func apply(fn func(int) int, val int) int {
    return fn(val)
}

func helper() int {
    result := apply(process, 42)
    return result
}
`
        });
        try {
            const index = idx(dir);

            // context('process') should show helper as a caller
            const ctx = index.context('process');
            assert.ok(ctx.callers.length > 0, 'process should have callers');
            assert.ok(ctx.callers.some(c => c.callerName === 'helper'),
                'helper should be a caller of process (callback)');

            // context('helper') should show both apply and process as callees
            const ctxHelper = index.context('helper');
            const calleeNames = ctxHelper.callees.map(c => c.name);
            assert.ok(calleeNames.includes('apply'),
                'helper callees should include apply (direct call)');
            assert.ok(calleeNames.includes('process'),
                'helper callees should include process (callback reference)');

            // Variables should NOT appear as callees
            assert.ok(!calleeNames.includes('result'),
                'variable "result" should not be a callee');
        } finally {
            rm(dir);
        }
    });

    it('GO_SKIP_IDENTS filters common non-function identifiers', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\n\ngo 1.21\n',
            'main.go': `package main

import "context"

func doWork(ctx context.Context) error {
    if err := process(ctx, nil, true, false); err != nil {
        return err
    }
    return nil
}

func process(ctx context.Context, data interface{}, flag1 bool, flag2 bool) error {
    return nil
}
`
        });
        try {
            const index = idx(dir);

            // nil, true, false, err, ctx are in GO_SKIP_IDENTS — should not be detected
            for (const skipName of ['nil', 'true', 'false', 'err', 'ctx']) {
                const callers = index.findCallers(skipName);
                assert.strictEqual(callers.length, 0,
                    `GO_SKIP_IDENT "${skipName}" should not have callers`);
            }

            // process should still be detected as a callee of doWork (direct call, not callback)
            const doWorkDef = index.symbols.get('doWork')?.[0];
            const callees = index.findCallees(doWorkDef, { includeUncertain: true });
            assert.ok(callees.some(c => c.name === 'process'),
                'doWork should have process as callee');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// K8s MCP Issue Fixes (2026-03-13)
// ============================================================================

describe('K8s fix: Issue 2 — function-value assignments tracked in call graph', () => {
    it('detects struct field assignment: sched.SchedulePod = sched.schedulePod', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'scheduler.go': `package scheduler

type Scheduler struct {
    SchedulePod func()
}

func (s *Scheduler) schedulePod() {
    // implementation
}

func New() *Scheduler {
    sched := &Scheduler{}
    sched.SchedulePod = sched.schedulePod
    return sched
}
`,
        });
        try {
            const index = idx(dir);
            const ctx = index.context('schedulePod');
            // The assignment should create a caller edge
            assert.ok(ctx.callers.length > 0, 'schedulePod should have callers from field assignment');
            assert.ok(ctx.callers.some(c => c.callerName === 'New'), 'caller should be New()');
        } finally {
            rm(dir);
        }
    });

    it('detects composite literal field: addNodeToCache as value', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'handler.go': `package controller

func addNodeToCache(obj interface{}) {
    // handle add
}

func updateNode(obj interface{}) {
    // handle update
}

func registerHandlers() {
    handlers := map[string]func(interface{}){
        "add": addNodeToCache,
    }
    _ = handlers
}
`,
        });
        try {
            const index = idx(dir);
            const ctx = index.context('addNodeToCache');
            assert.ok(ctx.callers.length > 0, 'addNodeToCache should have callers from composite literal');
        } finally {
            rm(dir);
        }
    });
});

describe('K8s fix: Issue 4 — diff_impact filters chained method calls without receiver', () => {
    it('filters out callers with no receiver when method is on many types', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'cache.go': `package cache

type FakeCache struct{}
func (c *FakeCache) Get(key string) string { return "" }

type RealCache struct{}
func (c *RealCache) Get(key string) string { return "" }

type HttpClient struct{}
func (c *HttpClient) Get(url string) string { return "" }

type Store struct{}
func (s *Store) Get(id int) string { return "" }
`,
            'user.go': `package cache

func useFakeCache() {
    c := &FakeCache{}
    c.Get("key")
}

func useRealCache() {
    c := &RealCache{}
    c.Get("key")
}
`,
        });
        try {
            const index = idx(dir);
            // Get callers of FakeCache.Get specifically
            const callers = index.findCallers('Get', {
                targetDefinitions: [{ file: dir + '/cache.go', startLine: 4, className: 'FakeCache', receiver: '*FakeCache' }],
                includeMethods: true,
                includeUncertain: false,
            });
            // Should find useFakeCache (has receiverType evidence) but not useRealCache
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('useFakeCache'), 'should find useFakeCache as caller');
        } finally {
            rm(dir);
        }
    });
});

describe('K8s fix: Issue 5 — entrypoints detects Go main/init/Test functions', () => {
    it('detects main() and init() as entry points', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'main.go': `package main

func init() {
    // register something
}

func main() {
    run()
}

func run() {}
`,
            'helper_test.go': `package main

import "testing"

func TestRun(t *testing.T) {}
func BenchmarkRun(b *testing.B) {}
`,
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('main'), 'should detect main()');
            assert.ok(names.includes('init'), 'should detect init()');
            assert.ok(names.includes('TestRun'), 'should detect TestRun()');
            assert.ok(names.includes('BenchmarkRun'), 'should detect BenchmarkRun()');
        } finally {
            rm(dir);
        }
    });
});

describe('K8s fix: Issue 6 — toc respects in= filter', () => {
    it('scopes toc output to matching directory', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/scheduler/scheduler.go': `package scheduler
func Schedule() {}
func Run() {}
`,
            'pkg/api/types.go': `package api
type CronJob struct{}
func NewCronJob() *CronJob { return nil }
`,
            'pkg/controller/main.go': `package controller
func Start() {}
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'toc', { in: 'pkg/scheduler' });
            assert.ok(result.ok, 'toc should succeed');
            // Should only include files from pkg/scheduler
            assert.strictEqual(result.result.totals.files, 1, 'should only have 1 file from pkg/scheduler');
            assert.ok(result.result.files[0].file.includes('scheduler'), 'file should be in scheduler dir');
            assert.ok(result.result.meta.scopedTo === 'pkg/scheduler', 'meta should show scopedTo');
        } finally {
            rm(dir);
        }
    });
});

describe('K8s fix: Issue 3 — file= shows all alternatives on mismatch', () => {
    it('lists all definitions when file= filter matches none', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/api/schedule.go': `package api
type Schedule struct{}
`,
            'pkg/batch/types.go': `package batch
type Schedule struct{}
`,
        });
        try {
            const index = idx(dir);
            const result = execute(index, 'about', { name: 'Schedule', file: 'pkg/scheduler' });
            // Should fail with a helpful error listing alternatives
            assert.ok(!result.ok, 'should indicate Schedule not found in pkg/scheduler');
            assert.ok(result.error.includes('definition'), 'error should mention definitions');
            assert.ok(result.error.includes('pkg/api'), 'error should list pkg/api as alternative');
            assert.ok(result.error.includes('pkg/batch'), 'error should list pkg/batch as alternative');
        } finally {
            rm(dir);
        }
    });
});

describe('K8s fix: Issue 7 — resolveSymbol prefers shallower paths', () => {
    it('prefers definition with shorter path over deeper one', () => {
        const dir = tmp({
            'go.mod': 'module example.com/test\ngo 1.21',
            'pkg/core.go': `package pkg
func Process() {}
`,
            'pkg/internal/v2/compat/process.go': `package compat
func Process() {}
`,
        });
        try {
            const index = idx(dir);
            const { def } = index.resolveSymbol('Process');
            assert.ok(def, 'should resolve Process');
            // Shallower path should win
            assert.ok(def.relativePath.includes('core.go'), 'should prefer shallower path pkg/core.go over deeply nested one');
        } finally {
            rm(dir);
        }
    });
});

