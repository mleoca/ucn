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
