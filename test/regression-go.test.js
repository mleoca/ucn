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
const { tmp, rm, idx, FIXTURES_PATH } = require('./helpers');

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
