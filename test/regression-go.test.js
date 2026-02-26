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
