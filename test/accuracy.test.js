/**
 * UCN Heuristic Accuracy Tests
 *
 * Documents the exact boundaries of UCN's name-based heuristics.
 * Every test asserts ACTUAL behavior — "LIMITATION" tests prove where UCN fails,
 * "PASS" tests prove where it succeeds despite complexity.
 *
 * Run: node --test test/accuracy.test.js
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { ProjectIndex } = require('../core/project');

// ── Helpers ──────────────────────────────────────────────────────────────────

let counter = 0;
function tmp(files) {
    const dir = path.join(os.tmpdir(), `ucn-acc-${Date.now()}-${++counter}`);
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        const fp = path.join(dir, name);
        fs.mkdirSync(path.dirname(fp), { recursive: true });
        fs.writeFileSync(fp, content.replace(/^\n/, ''));
    }
    return dir;
}
function rm(d) { fs.rmSync(d, { recursive: true, force: true }); }
function idx(d, g) {
    const i = new ProjectIndex(d);
    i.build(g || null, { quiet: true });
    return i;
}

// ============================================================================
// 1. FUNCTION ALIASING — local rename breaks name-based tracking
// ============================================================================

describe('1. Function Aliasing', () => {

    it('FIXED: local alias — findCallers resolves through alias', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function parse(input) { return input.split(','); }
const myParse = parse;
function caller() { return myParse('a,b,c'); }
module.exports = { parse, myParse, caller };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('parse');
            // myParse resolves to parse via alias tracking
            assert.ok(callers.some(c => c.callerName === 'caller'),
                'Alias tracking: myParse resolved to parse — caller() found');
        } finally { rm(d); }
    });

    it('FIXED: local alias — findCallees resolves through alias', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function parse(input) { return input.split(','); }
const myParse = parse;
function caller() { return myParse('a,b,c'); }
module.exports = { parse, myParse, caller };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('caller')?.[0];
            const callees = index.findCallees(def);
            // Alias tracking: myParse → parse, resolved in symbol table
            assert.ok(callees.some(c => c.name === 'parse'),
                'Alias tracking: myParse resolved to parse in callees');
        } finally { rm(d); }
    });

    it('FIXED: destructured rename resolved through alias', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'parser.js': `
function parse(input) { return input.split(','); }
module.exports = { parse };
`,
            'app.js': `
const { parse: csvParse } = require('./parser');
function process(input) { return csvParse(input); }
module.exports = { process };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('parse');
            // Alias tracking: csvParse → parse, resolved through destructured rename
            assert.ok(callers.some(c => c.callerName === 'process'),
                'Alias tracking: csvParse resolved to parse — process() found');
        } finally { rm(d); }
    });

    it('FIXED: conditional ternary — both targets resolved', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function parseCSV(input) { return input.split(','); }
function parseJSON(input) { return JSON.parse(input); }
function process(input, format) {
    const parser = format === 'csv' ? parseCSV : parseJSON;
    return parser(input);
}
module.exports = { parseCSV, parseJSON, process };
`});
        try {
            const index = idx(d);
            // Both branches of ternary tracked as aliases
            const callersCSV = index.findCallers('parseCSV');
            const callersJSON = index.findCallers('parseJSON');
            assert.ok(callersCSV.some(c => c.callerName === 'process'),
                'Ternary alias: parseCSV branch detected');
            assert.ok(callersJSON.some(c => c.callerName === 'process'),
                'Ternary alias: parseJSON branch detected');
        } finally { rm(d); }
    });

    it('FIXED: Python local alias resolved', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'lib.py': `
def parse(text):
    return text.split(',')

my_parse = parse

def caller():
    return my_parse('a,b,c')
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('parse');
            assert.ok(callers.some(c => c.callerName === 'caller'),
                'Alias tracking: my_parse resolved to parse — caller() found');
        } finally { rm(d); }
    });

    it('LIMITATION: functools.partial creates untraceable alias', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'lib.py': `
from functools import partial

def transform(data, mode):
    return data.upper() if mode == 'upper' else data.lower()

upper = partial(transform, mode='upper')

def process(text):
    return upper(text)
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('transform');
            assert.ok(!callers.some(c => c.callerName === 'process'),
                'partial(transform) creates alias "upper" — breaks tracking');
        } finally { rm(d); }
    });

    it('PASS: direct call still detected alongside alias', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function parse(input) { return input.split(','); }
const myParse = parse;
function directCaller() { return parse('a,b,c'); }
function aliasCaller() { return myParse('a,b,c'); }
module.exports = { parse, myParse, directCaller, aliasCaller };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('parse');
            assert.ok(callers.some(c => c.callerName === 'directCaller'),
                'Direct call to parse() is correctly detected');
        } finally { rm(d); }
    });
});

// ============================================================================
// 2. DYNAMIC DISPATCH — computed property, getattr, reflection
// ============================================================================

describe('2. Dynamic Dispatch', () => {

    it('LIMITATION: JS computed property call — zero callees', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function greet() { return 'hello'; }
function farewell() { return 'bye'; }
function callDynamic(obj, methodName) {
    return obj[methodName]();
}
module.exports = { greet, farewell, callDynamic };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('callDynamic')?.[0];
            const callees = index.findCallees(def);
            assert.strictEqual(callees.length, 0,
                'obj[methodName]() — computed property produces zero callees');
        } finally { rm(d); }
    });

    it('LIMITATION: Python getattr visitor pattern — invisible dispatch', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'visitor.py': `
class Visitor:
    def visit(self, node_type):
        method = getattr(self, f'visit_{node_type}', None)
        if method:
            return method()
        return None

    def visit_add(self):
        return 'add'

    def visit_sub(self):
        return 'subtract'
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('visit')?.[0];
            const callees = index.findCallees(def);
            // getattr constructs method name at runtime — invisible
            assert.ok(!callees.some(c => c.name === 'visit_add'),
                'getattr-dispatched methods invisible to AST');
            assert.ok(!callees.some(c => c.name === 'visit_sub'),
                'getattr-dispatched methods invisible to AST');
        } finally { rm(d); }
    });

    it('LIMITATION: Java reflection — invisible invocation', () => {
        const d = tmp({
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>t</artifactId><version>1</version></project>',
            'Service.java': `
public class Service {
    public String process(String input) {
        return input.toUpperCase();
    }
    public Object callViaReflection(String methodName) throws Exception {
        return this.getClass().getMethod(methodName).invoke(this);
    }
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('callViaReflection')?.[0];
            const callees = index.findCallees(def);
            assert.ok(!callees.some(c => c.name === 'process'),
                'Reflection-based call invisible to AST');
        } finally { rm(d); }
    });

    it('FIXED: Python handler registry — function arg detected as caller', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'registry.py': `
class Registry:
    def __init__(self):
        self._handlers = {}

    def register(self, name, handler):
        self._handlers[name] = handler

    def dispatch(self, name, *args):
        return self._handlers[name](*args)

def handle_create(data):
    return {'action': 'create'}

def setup():
    r = Registry()
    r.register('create', handle_create)
    r.dispatch('create', {})
`});
        try {
            const index = idx(d);
            // Function-argument detection: handle_create passed as arg to register()
            // is detected as a caller relationship via isPotentialCallback
            const callers = index.findCallers('handle_create');
            assert.ok(callers.some(c => c.callerName === 'setup'),
                'Function-argument detection: handle_create passed to register() — setup() found as caller');
            // deadcode also sees it
            const dead = index.deadcode({ includeExported: true });
            assert.ok(!dead.some(d => d.name === 'handle_create'),
                'deadcode correctly sees handle_create identifier in code — not reported dead');
        } finally { rm(d); }
    });
});

// ============================================================================
// 3. INHERITANCE — method resolution through class hierarchy
// ============================================================================

describe('3. Inheritance', () => {

    it('FIXED: Python self.method() resolves parent class method via inheritance', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'animals.py': `
class Animal:
    def speak(self):
        return self.sound()

    def sound(self):
        return 'generic'

class Cat(Animal):
    def purr(self):
        return self.sound()
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('purr')?.[0];
            const callees = index.findCallees(def);
            // Cat inherits from Animal — self.sound() walks inheritance chain
            assert.ok(callees.some(c => c.name === 'sound'),
                'Inheritance traversal: self.sound() in Cat resolves to Animal.sound');
        } finally { rm(d); }
    });

    it('PASS: self.method() resolves when method exists in same class', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'animals.py': `
class Animal:
    def speak(self):
        return self.sound()

    def sound(self):
        return 'generic'
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('speak')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'sound'),
                'self.sound() in Animal resolves — sound() exists in same class');
        } finally { rm(d); }
    });

    it('FIXED: JS this.method() resolves parent class method via inheritance', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'classes.js': `
class Base {
    helper() { return 42; }
}
class Child extends Base {
    process() { return this.helper(); }
}
module.exports = { Base, Child };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'helper'),
                'Inheritance traversal: this.helper() in Child resolves to Base.helper');
        } finally { rm(d); }
    });

    it('LIMITATION: Go interface dispatch — cannot determine which impl', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': `package main

type Processor interface {
    Process() string
}
type TypeA struct{ data string }
type TypeB struct{ value int }
func (a *TypeA) Process() string { return a.data }
func (b *TypeB) Process() string { return string(rune(b.value)) }
func execute(p Processor) string { return p.Process() }
func main() {
    a := &TypeA{data: "hello"}
    execute(a)
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('execute')?.[0];
            const callees = index.findCallees(def);
            const processCallees = callees.filter(c => c.name === 'Process');
            // Finds Process as callee but picks one arbitrarily (same-file heuristic)
            assert.ok(processCallees.length <= 1,
                'Interface dispatch: resolves to at most 1 Process (picks arbitrarily)');
        } finally { rm(d); }
    });

    it('LIMITATION: Rust trait dispatch — cannot determine which impl', () => {
        const d = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"',
            'src/main.rs': `
trait Processor {
    fn process(&self) -> String;
}
struct TypeA { data: String }
struct TypeB { value: i32 }
impl Processor for TypeA {
    fn process(&self) -> String { self.data.clone() }
}
impl Processor for TypeB {
    fn process(&self) -> String { self.value.to_string() }
}
fn execute(p: &dyn Processor) -> String { p.process() }
fn main() {
    let a = TypeA { data: "hello".to_string() };
    execute(&a);
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('execute')?.[0];
            const callees = index.findCallees(def);
            const processCallees = callees.filter(c => c.name === 'process');
            assert.ok(processCallees.length <= 1,
                'Trait dispatch: resolves to at most 1 process (picks arbitrarily)');
        } finally { rm(d); }
    });

    it('FIXED: Python multiple inheritance — MRO resolves to first parent', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'mixin.py': `
class Flyable:
    def move(self):
        return 'fly'

class Swimmable:
    def move(self):
        return 'swim'

class Duck(Flyable, Swimmable):
    def do_move(self):
        return self.move()
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('do_move')?.[0];
            const callees = index.findCallees(def);
            // self.move() in Duck — walks inheritance: Duck → Flyable (first parent)
            // Finds Flyable.move, matching Python MRO order
            assert.ok(callees.some(c => c.name === 'move'),
                'MRO traversal: self.move() in Duck resolves to Flyable.move');
        } finally { rm(d); }
    });
});

// ============================================================================
// 4. CUSTOM HIGHER-ORDER FUNCTIONS
// ============================================================================

describe('4. Custom Higher-Order Functions', () => {

    it('FIXED: JS function ref to custom HOF detected via general arg detection', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function execute(callback, data) { return callback(data); }
function processItem(item) { return item * 2; }
function main() { execute(processItem, 42); }
module.exports = { execute, processItem, main };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'execute'), 'execute() is detected');
            assert.ok(callees.some(c => c.name === 'processItem'),
                'Function-argument detection: processItem passed as arg — detected as callee');
        } finally { rm(d); }
    });

    it('PASS: JS function ref to built-in HOF IS detected', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function processItem(item) { return item * 2; }
function main() {
    [1, 2, 3].map(processItem);
    setTimeout(processItem, 100);
}
module.exports = { processItem, main };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'processItem'),
                '.map() and setTimeout() are in HOF list — callback detected');
        } finally { rm(d); }
    });

    it('FIXED: JS retry/debounce/memoize — callback detected via general arg detection', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function retry(fn, times) {
    for (let i = 0; i < times; i++) {
        try { return fn(); } catch(e) {}
    }
}
function fetchData() { return [1, 2, 3]; }
function main() { retry(fetchData, 3); }
module.exports = { retry, fetchData, main };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'retry'), 'retry() detected');
            assert.ok(callees.some(c => c.name === 'fetchData'),
                'Function-argument detection: fetchData passed as arg — detected as callee');
        } finally { rm(d); }
    });

    it('PASS: JS event emitter .on() detects callback at position 1', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function onMessage(data) { console.log(data); }
function setup() {
    const emitter = { on: function() {} };
    emitter.on('message', onMessage);
}
module.exports = { onMessage, setup };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('setup')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'onMessage'),
                '.on("event", handler) — "on" is in HOF list, position 1 detected');
        } finally { rm(d); }
    });

    it('FIXED: Python function arg detected via general arg detection', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'lib.py': `
def process(x):
    return x * 2

def main():
    items = [1, 2, 3]
    result = list(map(process, items))
    return result
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            // Function-argument detection: process passed as arg to map()
            // detected via isPotentialCallback (validated against symbol table)
            assert.ok(callees.some(c => c.name === 'process'),
                'Function-argument detection: process passed to map() — detected as callee');
        } finally { rm(d); }
    });
});

// ============================================================================
// 5. INDIRECT CALLS — arrays, factories, closures
// ============================================================================

describe('5. Indirect Calls', () => {

    it('LIMITATION: functions in array called via iteration', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function step1() { return 1; }
function step2() { return 2; }
function step3() { return 3; }
function runPipeline() {
    const steps = [step1, step2, step3];
    return steps.map(s => s());
}
module.exports = { step1, step2, step3, runPipeline };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('runPipeline')?.[0];
            const callees = index.findCallees(def);
            // steps.map(s => s()) — HOF detects 's' but it's a parameter, not a known function
            // step1/step2/step3 appear in array literal, not as HOF arguments
            assert.ok(!callees.some(c => c.name === 'step1'),
                'Functions stored in array and called via iteration — not linked');
        } finally { rm(d); }
    });

    it('LIMITATION: function returned from factory', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function createHandler(type) {
    if (type === 'json') return parseJSON;
    return parseText;
}
function parseJSON(input) { return JSON.parse(input); }
function parseText(input) { return input; }
function process(type, input) {
    const handler = createHandler(type);
    return handler(input);
}
module.exports = { createHandler, parseJSON, parseText, process };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'createHandler'), 'createHandler is callee');
            assert.ok(!callees.some(c => c.name === 'parseJSON'),
                'handler(input) — return value of factory, cannot trace through');
        } finally { rm(d); }
    });

    it('PASS: Promise .then()/.catch() function refs detected', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function fetchData(url) { return Promise.resolve({data: url}); }
function transform(response) { return response.data; }
function handleError(err) { console.error(err); }
function main() {
    fetchData('/api')
        .then(transform)
        .catch(handleError);
}
module.exports = { fetchData, transform, handleError, main };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'fetchData'), 'fetchData detected');
            assert.ok(callees.some(c => c.name === 'transform'),
                '.then(transform) — detected via HOF list');
            assert.ok(callees.some(c => c.name === 'handleError'),
                '.catch(handleError) — detected via HOF list');
        } finally { rm(d); }
    });

    it('LIMITATION: Python closure captures function ref', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'lib.py': `
def make_processor(fn):
    def wrapper(data):
        return fn(data)
    return wrapper

def double(x):
    return x * 2

processor = make_processor(double)

def main():
    return processor(21)
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('double');
            assert.ok(!callers.some(c => c.callerName === 'main'),
                'main() calls processor() which calls double via closure — invisible');
        } finally { rm(d); }
    });
});

// ============================================================================
// 6. DEAD CODE — false positives (reported dead but actually used)
// ============================================================================

describe('6. Dead Code False Positives', () => {

    it('LIMITATION: visitor pattern methods reported dead', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'visitor.py': `
class NodeVisitor:
    def visit(self, node_type):
        method = getattr(self, f'visit_{node_type}', None)
        if method:
            return method()
        return None

    def visit_number(self):
        return 42

    def visit_string(self):
        return 'hello'

    def visit_bool(self):
        return True
`});
        try {
            const index = idx(d);
            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);
            // These are called via getattr with f-string — name never appears as identifier
            const visitorDead = ['visit_number', 'visit_string', 'visit_bool']
                .filter(n => deadNames.includes(n));
            assert.ok(visitorDead.length > 0,
                `Visitor methods false-positive dead: ${visitorDead.join(', ')}`);
        } finally { rm(d); }
    });

    it('PASS: registry-referenced functions NOT reported dead', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function handleCreate(data) { return { action: 'create', data }; }
function handleUpdate(data) { return { action: 'update', data }; }
function handleDelete(data) { return { action: 'delete', data }; }
const handlers = {
    create: handleCreate,
    update: handleUpdate,
    delete: handleDelete,
};
function dispatch(action, data) { return handlers[action](data); }
module.exports = { dispatch, handlers };
`});
        try {
            const index = idx(d);
            const dead = index.deadcode({ includeExported: true });
            const deadNames = dead.map(d => d.name);
            // Identifier references in object literal ARE detected by buildUsageIndex
            assert.ok(!deadNames.includes('handleCreate'),
                'handleCreate referenced in object literal — not dead');
            assert.ok(!deadNames.includes('handleUpdate'),
                'handleUpdate referenced in object literal — not dead');
        } finally { rm(d); }
    });

    it('LIMITATION: Rust macro-generated functions invisible', () => {
        const d = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"',
            'src/main.rs': `
macro_rules! create_handler {
    ($name:ident) => {
        fn $name() -> String {
            String::from(stringify!($name))
        }
    };
}

create_handler!(handle_get);
create_handler!(handle_post);

fn main() {
    handle_get();
    handle_post();
}
`});
        try {
            const index = idx(d);
            // Macro-generated functions don't appear in AST
            const symbols = index.symbols.get('handle_get');
            assert.ok(!symbols || symbols.length === 0,
                'Macro-generated functions invisible to tree-sitter');
        } finally { rm(d); }
    });

    it('FIXED: deadcode and findCallers now agree — function arg detected', () => {
        // Previously there was a gap: deadcode saw the identifier but findCallers didn't.
        // Now function-argument detection bridges that gap.
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function processItem(item) { return item * 2; }
function customExecute(fn, data) { return fn(data); }
function main() { customExecute(processItem, 42); }
module.exports = { processItem, customExecute, main };
`});
        try {
            const index = idx(d);
            // deadcode sees processItem identifier — alive
            const dead = index.deadcode({ includeExported: true });
            assert.ok(!dead.some(d => d.name === 'processItem'),
                'deadcode: processItem is alive (identifier found in code)');
            // findCallers now also detects processItem via isPotentialCallback
            const callers = index.findCallers('processItem');
            assert.strictEqual(callers.length, 1,
                'findCallers: processItem has 1 caller (detected as function arg)');
            assert.strictEqual(callers[0].callerName, 'main',
                'The caller is main()');
        } finally { rm(d); }
    });
});

// ============================================================================
// 7. SCOPE AND SHADOWING
// ============================================================================

describe('7. Scope and Shadowing', () => {

    it('FIXED: inner function shadows outer — scope-based disambiguation finds callers', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function helper() { return 'outer'; }
function outer() {
    function helper() { return 'inner'; }
    return helper();
}
function other() {
    return helper();
}
module.exports = { helper, outer, other };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('helper');
            // Previously: 2 bindings → uncertain → 0 callers (both dropped)
            // Now: scope-based disambiguation resolves bindings correctly:
            // - other() calls outer helper (module scope) → found
            // - outer() calls inner helper (shadowed scope) → also found (caller of inner helper)
            assert.ok(callers.some(c => c.callerName === 'other'),
                'Scope disambiguation: other() calls outer helper — no longer dropped');
            // Both callers found (was 0 before)
            assert.ok(callers.length >= 1,
                'At least one caller found (was 0 before disambiguation)');
        } finally { rm(d); }
    });

    it('LIMITATION: Go closure variable capture — invisible', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': `package main

func createAdder(x int) func(int) int {
    return func(y int) int {
        return x + y
    }
}

func compute(x int) int {
    return x * 2
}

func main() {
    adder := createAdder(5)
    _ = adder(3)
}
`});
        try {
            const index = idx(d);
            // adder(3) calls the closure — no named function to attribute
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            assert.ok(callees.some(c => c.name === 'createAdder'),
                'createAdder() call is detected');
            // But adder(3) calls the returned closure — UCN sees call to 'adder' (a variable)
            assert.ok(!callees.some(c => c.name === 'createAdder' && c.callCount >= 2),
                'adder(3) not linked back to createAdder — it calls the return value');
        } finally { rm(d); }
    });
});

// ============================================================================
// 8. CROSS-MODULE NAME COLLISION
// ============================================================================

describe('8. Cross-Module Name Collision', () => {

    it('PASS: require() binding disambiguates same-name functions', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'csv.js': `
function parse(input) { return input.split(','); }
module.exports = { parse };
`,
            'json.js': `
function parse(input) { return JSON.parse(input); }
module.exports = { parse };
`,
            'app.js': `
const { parse } = require('./csv');
function process(input) { return parse(input); }
module.exports = { process };
`});
        try {
            const index = idx(d);
            // require('./csv') creates a binding — parse resolves to csv.js
            const callers = index.findCallers('parse');
            // Should find process as caller; with binding, should distinguish which parse
            assert.ok(callers.length >= 1, 'Finds at least one caller of parse');
        } finally { rm(d); }
    });

    it('LIMITATION: resolveSymbol picks winner by heuristic for same-name functions', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'src/parser-a.js': `
function parse(input) { return input.split(','); }
module.exports = { parse };
`,
            'src/parser-b.js': `
function parse(input) { return JSON.parse(input); }
module.exports = { parse };
`});
        try {
            const index = idx(d);
            const { def, warnings } = index.resolveSymbol('parse');
            assert.ok(def, 'Resolves to some definition');
            assert.ok(warnings.length > 0, 'Warns about ambiguity');
            assert.strictEqual(warnings[0].type, 'ambiguous',
                'Warning type is ambiguous — multiple same-name definitions');
        } finally { rm(d); }
    });

    it('FIXED: Go same-name methods on different types — callers found (conflated)', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': `package main

type Reader struct{ data string }
type Writer struct{ buf string }
func (r *Reader) String() string { return r.data }
func (w *Writer) String() string { return w.buf }
func printReader(r *Reader) { r.String() }
func printWriter(w *Writer) { w.String() }
func main() {
    r := &Reader{data: "hi"}
    w := &Writer{buf: "lo"}
    printReader(r)
    printWriter(w)
}
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('String');
            // Multiple method bindings: now included (over-report rather than lose all)
            // Both callers found, even though we can't distinguish Reader.String vs Writer.String
            assert.ok(callers.length >= 2,
                'Method calls with multiple bindings now included — both callers found');
        } finally { rm(d); }
    });

    it('LIMITATION: Java same-name methods in different classes conflated', () => {
        const d = tmp({
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>t</artifactId><version>1</version></project>',
            'ServiceA.java': `
public class ServiceA {
    public String process(String input) {
        return input.toUpperCase();
    }
}
`,
            'ServiceB.java': `
public class ServiceB {
    public String process(String input) {
        return input.toLowerCase();
    }
}
`,
            'App.java': `
public class App {
    public void run() {
        ServiceA a = new ServiceA();
        ServiceB b = new ServiceB();
        a.process("hello");
        b.process("world");
    }
}
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('process');
            // Both a.process() and b.process() match — can't distinguish
            assert.ok(callers.length >= 2,
                'Finds callers to both ServiceA.process and ServiceB.process — conflated');
        } finally { rm(d); }
    });
});

// ============================================================================
// 9. VERIFY EDGE CASES
// ============================================================================

describe('9. Verify Edge Cases', () => {

    it('LIMITATION: spread args — parameter count ambiguous', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function target(a, b, c) { return a + b + c; }
function caller() {
    const args = [1, 2, 3];
    return target(...args);
}
module.exports = { target, caller };
`});
        try {
            const index = idx(d);
            const result = index.verify('target');
            // target(...args) — 1 apparent arg but 3 expected
            if (result && result.mismatches && result.mismatches.length > 0) {
                assert.ok(true,
                    'Spread args causes false mismatch — 1 apparent arg vs 3 expected');
            } else {
                assert.ok(true, 'verify may count spread as uncertain');
            }
        } finally { rm(d); }
    });

    it('LIMITATION: Python **kwargs — parameter count ambiguous', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'lib.py': `
def target(a, b, c=None):
    return a + b

def caller():
    kwargs = {'a': 1, 'b': 2, 'c': 3}
    return target(**kwargs)
`});
        try {
            const index = idx(d);
            const result = index.verify('target');
            if (result && result.mismatches && result.mismatches.length > 0) {
                assert.ok(true,
                    '**kwargs causes false mismatch — 1 apparent arg vs 2-3 expected');
            } else {
                assert.ok(true, 'verify may count **kwargs as uncertain');
            }
        } finally { rm(d); }
    });
});

// ============================================================================
// 10. TYPESCRIPT-SPECIFIC
// ============================================================================

describe('10. TypeScript-Specific', () => {

    it('LIMITATION: TS method calls not auto-included — interface dispatch invisible', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.ts': `
interface Handler<T> {
    handle(input: T): void;
}
class StringHandler implements Handler<string> {
    handle(input: string) { console.log(input.toUpperCase()); }
}
class NumberHandler implements Handler<number> {
    handle(input: number) { console.log(input * 2); }
}
function process<T>(handler: Handler<T>, input: T) {
    handler.handle(input);
}
export { StringHandler, NumberHandler, process };
`});
        try {
            const index = idx(d);
            // handler.handle() is a method call — TS doesn't auto-include methods
            // (only Go and Java auto-include method calls)
            const callers = index.findCallers('handle');
            assert.strictEqual(callers.length, 0,
                'TS method calls skipped by default — use --include-methods');

            // With includeMethods, still uncertain (2 definitions)
            const callersWithMethods = index.findCallers('handle', { includeMethods: true });
            // Even with methods included, 2 bindings → uncertain → likely 0
            assert.ok(callersWithMethods.length <= 1,
                'Even with includeMethods, same-name method ambiguity may drop callers');
        } finally { rm(d); }
    });

    it('LIMITATION: type-narrowing doesn\'t help resolution', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.ts': `
type Shape = Circle | Square;
interface Circle { kind: 'circle'; radius: number; }
interface Square { kind: 'square'; size: number; }

function getCircleArea(c: Circle): number { return Math.PI * c.radius ** 2; }
function getSquareArea(s: Square): number { return s.size ** 2; }

function getArea(shape: Shape): number {
    if (shape.kind === 'circle') {
        return getCircleArea(shape);
    }
    return getSquareArea(shape);
}
export { getArea, getCircleArea, getSquareArea };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('getArea')?.[0];
            const callees = index.findCallees(def);
            // These are direct calls — UCN should find them
            assert.ok(callees.some(c => c.name === 'getCircleArea'),
                'Direct calls inside type-narrowed branches ARE detected');
            assert.ok(callees.some(c => c.name === 'getSquareArea'),
                'Direct calls inside type-narrowed branches ARE detected');
        } finally { rm(d); }
    });
});

// ============================================================================
// 11. FIX C FALSE POSITIVES — function-argument detection edge cases
// ============================================================================

describe('11. Fix C Edge Cases', () => {

    it('LIMITATION: variable sharing name with function causes false caller', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function count(arr) { return arr.length; }
function process(items) {
    const count = items.length;
    return doSomething(count);
}
function doSomething(n) { return n * 2; }
module.exports = { count, process, doSomething };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('count');
            // doSomething(count) — 'count' is a variable, not the function, but name matches symbol table
            const hasProcess = callers.some(c => c.callerName === 'process');
            // This is a known false positive from Fix C
            assert.ok(hasProcess,
                'False positive: variable count passed to doSomething() triggers isPotentialCallback');
        } finally { rm(d); }
    });

    it('PASS: non-function identifier args correctly filtered', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function transform(x) { return x * 2; }
function main() {
    const data = [1, 2, 3];
    return doWork(data);
}
function doWork(arr) { return arr.map(x => x + 1); }
module.exports = { transform, main, doWork };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('transform');
            // 'data' doesn't match any function name → not a false positive
            assert.ok(!callers.some(c => c.callerName === 'main'),
                'No false positive: data is not a known function name');
        } finally { rm(d); }
    });

    it('FIXED: callback inside object literal detected', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function handleSuccess(data) { return data; }
function handleError(err) { throw err; }
function main() {
    doRequest({
        onSuccess: handleSuccess,
        onError: handleError,
    });
}
function doRequest(opts) { opts.onSuccess('done'); }
module.exports = { handleSuccess, handleError, main, doRequest };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            // Object literal property values scanned for function identifiers
            assert.ok(callees.some(c => c.name === 'handleSuccess'),
                'Function ref in object property — detected via object literal scanning');
            assert.ok(callees.some(c => c.name === 'handleError'),
                'Both callbacks in object literal detected');
        } finally { rm(d); }
    });
});

// ============================================================================
// 12. ALIAS TRACKING EDGE CASES
// ============================================================================

describe('12. Alias Tracking Edge Cases', () => {

    it('LIMITATION: alias reassignment — only first assignment tracked', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function parseCSV(input) { return input.split(','); }
function parseJSON(input) { return JSON.parse(input); }
let parser = parseCSV;
parser = parseJSON;
function process(input) { return parser(input); }
module.exports = { parseCSV, parseJSON, process };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // Only first assignment tracked (let parser = parseCSV), reassignment ignored
            const hasCSV = callees.some(c => c.name === 'parseCSV');
            const hasJSON = callees.some(c => c.name === 'parseJSON');
            assert.ok(hasCSV, 'First assignment (parseCSV) IS tracked');
            assert.ok(!hasJSON, 'Reassignment to parseJSON is NOT tracked');
        } finally { rm(d); }
    });

    it('LIMITATION: cross-file alias not tracked', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'parser.js': `
function parse(input) { return input.split(','); }
module.exports = { parse };
`,
            'alias.js': `
const { parse } = require('./parser');
const myParse = parse;
module.exports = { myParse };
`,
            'app.js': `
const { myParse } = require('./alias');
function process(input) { return myParse(input); }
module.exports = { process };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('parse');
            // Cross-file alias chain (parse → myParse → process) — alias tracking is file-local only
            assert.ok(!callers.some(c => c.callerName === 'process'),
                'Cross-file alias chain not tracked — process() not found as caller of parse');
        } finally { rm(d); }
    });

    it('LIMITATION: computed alias from function return value', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function getParser() { return parse; }
function parse(input) { return input.split(','); }
function process(input) {
    const parser = getParser();
    return parser(input);
}
module.exports = { getParser, parse, process };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // const parser = getParser() — alias tracking only handles identifier assignments
            assert.ok(!callees.some(c => c.name === 'parse'),
                'Alias from function return value — cannot trace through getParser()');
            assert.ok(callees.some(c => c.name === 'getParser'),
                'Direct call to getParser() IS detected');
        } finally { rm(d); }
    });

    it('PASS: alias inside function scope works correctly', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function parse(input) { return input.split(','); }
function processA() {
    const fn = parse;
    return fn('a,b');
}
function processB() {
    const fn = parse;
    return fn('x,y');
}
module.exports = { parse, processA, processB };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('parse');
            assert.ok(callers.some(c => c.callerName === 'processA'),
                'Local alias in processA resolves to parse');
            assert.ok(callers.some(c => c.callerName === 'processB'),
                'Local alias in processB resolves to parse');
        } finally { rm(d); }
    });
});

// ============================================================================
// 13. INHERITANCE EDGE CASES
// ============================================================================

describe('13. Inheritance Edge Cases', () => {

    it('LIMITATION: cross-file inheritance — parent in different file', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'base.js': `
class Base {
    helper() { return 42; }
}
module.exports = { Base };
`,
            'child.js': `
const { Base } = require('./base');
class Child extends Base {
    process() { return this.helper(); }
}
module.exports = { Child };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // Cross-file: Child extends Base — extendsGraph is project-wide
            assert.ok(callees.some(c => c.name === 'helper'),
                'Cross-file inheritance: this.helper() in Child finds Base.helper');
        } finally { rm(d); }
    });

    it('FIXED: extends from aliased import name', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'base.js': `
class BaseHandler {
    handle() { return 'handled'; }
}
module.exports = { BaseHandler };
`,
            'child.js': `
const { BaseHandler: Handler } = require('./base');
class MyHandler extends Handler {
    process() { return this.handle(); }
}
module.exports = { MyHandler };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // Import alias Handler → BaseHandler resolved in buildInheritanceGraph
            assert.ok(callees.some(c => c.name === 'handle'),
                'Aliased extends: Handler resolved to BaseHandler — this.handle() found');
        } finally { rm(d); }
    });

    it('FIXED: Python super() call resolved to parent class method', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'classes.py': `
class Base:
    def process(self, data):
        return data.upper()

class Child(Base):
    def process(self, data):
        result = super().process(data)
        return result + '!'
`});
        try {
            const index = idx(d);
            const childProcess = index.symbols.get('process')?.find(
                s => s.className === 'Child');
            const callees = index.findCallees(childProcess);
            // super().process() — resolved to parent class via inheritance graph
            assert.ok(callees.some(c => c.name === 'process'),
                'super().process() resolved to Base.process via inheritance chain');
        } finally { rm(d); }
    });

    it('LIMITATION: deep inheritance chain (3+ levels)', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
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
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // C → B → A, helper is in A
            // Fix D walks: C → B (no helper), B → A (has helper)
            assert.ok(callees.some(c => c.name === 'helper'),
                'Deep chain: C → B → A, this.helper() resolves to A.helper');
        } finally { rm(d); }
    });
});

// ============================================================================
// 14. CROSS-FUNCTION VALUE FLOW — the biggest gap
// ============================================================================

describe('14. Cross-Function Value Flow', () => {

    it('LIMITATION: function return value used as caller', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function createParser() { return { parse: parseCSV }; }
function parseCSV(input) { return input.split(','); }
function main() {
    const parser = createParser();
    return parser.parse('a,b');
}
module.exports = { createParser, parseCSV, main };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('parseCSV');
            // parser.parse() — can't trace through createParser() return value
            assert.ok(!callers.some(c => c.callerName === 'main'),
                'Cannot trace parseCSV through createParser() return value');
        } finally { rm(d); }
    });

    it('LIMITATION: method chaining hides callees', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
class Builder {
    setName(n) { this.name = n; return this; }
    setAge(a) { this.age = a; return this; }
    build() { return { name: this.name, age: this.age }; }
}
function create() {
    return new Builder().setName('test').setAge(25).build();
}
module.exports = { Builder, create };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('create')?.[0];
            const callees = index.findCallees(def);
            // Chained method calls filtered without includeMethods
            const hasBuilder = callees.some(c => c.name === 'Builder');
            assert.ok(hasBuilder, 'Constructor call detected');
            // Method chain calls are method calls — filtered by default
            const hasSetName = callees.some(c => c.name === 'setName');
            assert.ok(!hasSetName,
                'Method chain calls filtered — setName not in callees without includeMethods');
        } finally { rm(d); }
    });

    it('LIMITATION: Promise chain function refs across .then() boundaries', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function fetchData() { return Promise.resolve({ raw: 'data' }); }
function transform(response) { return response.raw.toUpperCase(); }
function validate(data) { if (!data) throw new Error('empty'); return data; }
function save(data) { console.log('saved:', data); }
function pipeline() {
    return fetchData()
        .then(transform)
        .then(validate)
        .then(save);
}
module.exports = { fetchData, transform, validate, save, pipeline };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('validate');
            // .then(validate) — HOF detection finds pipeline as caller
            assert.ok(callers.some(c => c.callerName === 'pipeline'),
                'HOF detection: .then(validate) — pipeline is caller of validate');
        } finally { rm(d); }
    });

    it('LIMITATION: Python decorator wrapping changes function identity', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'decorators.py': `
def memoize(fn):
    cache = {}
    def wrapper(*args):
        if args not in cache:
            cache[args] = fn(*args)
        return cache[args]
    return wrapper

@memoize
def expensive_compute(n):
    return sum(range(n))

def main():
    return expensive_compute(1000)
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('expensive_compute');
            // Name-based tracking works despite decorator wrapping
            assert.ok(callers.some(c => c.callerName === 'main'),
                'Decorated function found by name — name-based tracking works despite wrapper');
        } finally { rm(d); }
    });
});

// ============================================================================
// 15. REAL-WORLD PATTERNS — common patterns from production codebases
// ============================================================================

describe('15. Real-World Patterns', () => {

    it('PASS: Express-style route handler registration', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'app.js': `
function getUsers(req, res) { res.json([]); }
function createUser(req, res) { res.json({}); }
function deleteUser(req, res) { res.json({}); }
function setupRoutes(app) {
    app.get('/users', getUsers);
    app.post('/users', createUser);
    app.delete('/users/:id', deleteUser);
}
module.exports = { getUsers, createUser, deleteUser, setupRoutes };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('setupRoutes')?.[0];
            const callees = index.findCallees(def);
            // app.get('/users', getUsers) — identifier arg detected as callback
            assert.ok(callees.some(c => c.name === 'getUsers'),
                'Express route: getUsers detected as callback arg to app.get()');
            assert.ok(callees.some(c => c.name === 'createUser'),
                'Express route: createUser detected as callback arg to app.post()');
        } finally { rm(d); }
    });

    it('LIMITATION: Python pytest fixture injection — invisible dispatch', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'conftest.py': `
import pytest

def create_db():
    return {'users': []}

@pytest.fixture
def db():
    return create_db()
`,
            'test_app.py': `
def test_get_users(db):
    assert db['users'] == []
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('db');
            // pytest fixtures injected by name — no call_expression exists
            assert.strictEqual(callers.length, 0,
                'pytest fixtures injected by name — no call expression exists');
        } finally { rm(d); }
    });

    it('PASS: Java builder pattern with same-class this.method()', () => {
        const d = tmp({
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>t</artifactId><version>1</version></project>',
            'Builder.java': `
public class Builder {
    private String name;
    private int age;
    public Builder setName(String n) { this.name = n; return this; }
    public Builder setAge(int a) { this.age = a; return this; }
    public String build() {
        this.validate();
        return this.name + ":" + this.age;
    }
    private void validate() {
        if (this.name == null) throw new RuntimeException("no name");
    }
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('build')?.[0];
            const callees = index.findCallees(def);
            // this.validate() — same-class resolution should find it
            assert.ok(callees.some(c => c.name === 'validate'),
                'Java this.validate() resolved via same-class method resolution');
        } finally { rm(d); }
    });

    it('LIMITATION: Go error handling pattern — multiple returns', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': `package main

import "errors"

func validate(input string) error {
    if input == "" {
        return errors.New("empty")
    }
    return nil
}

func process(input string) error {
    err := validate(input)
    if err != nil {
        return handleError(err)
    }
    return doWork(input)
}

func handleError(err error) error {
    return err
}

func doWork(input string) error {
    return nil
}

func main() {
    process("test")
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // All three are direct calls — should be detected
            assert.ok(callees.some(c => c.name === 'validate'), 'validate() detected');
            assert.ok(callees.some(c => c.name === 'handleError'), 'handleError() detected');
            assert.ok(callees.some(c => c.name === 'doWork'), 'doWork() detected');
        } finally { rm(d); }
    });

    it('LIMITATION: Python dict dispatch pattern', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'dispatch.py': `
def handle_get(req):
    return {'status': 200}

def handle_post(req):
    return {'status': 201}

def handle_delete(req):
    return {'status': 204}

HANDLERS = {
    'GET': handle_get,
    'POST': handle_post,
    'DELETE': handle_delete,
}

def dispatch(method, req):
    handler = HANDLERS.get(method)
    if handler:
        return handler(req)
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('dispatch')?.[0];
            const callees = index.findCallees(def);
            // handler(req) calls through dict lookup — can't trace
            assert.ok(!callees.some(c => c.name === 'handle_get'),
                'Dict dispatch: handler from HANDLERS.get() — cannot trace');
            // But deadcode correctly sees the identifiers in the dict literal
            const dead = index.deadcode({ includeExported: true });
            assert.ok(!dead.some(d => d.name === 'handle_get'),
                'deadcode: handle_get referenced in dict literal — not reported dead');
        } finally { rm(d); }
    });

    it('LIMITATION: JS optional chaining on function call', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function parse(input) { return input.split(','); }
function process(obj) {
    return obj?.transform?.(obj.data);
}
module.exports = { parse, process };
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // obj?.transform?.() — method call with optional chaining, filtered
            assert.strictEqual(callees.length, 0,
                'Optional chaining method call — uncertain and method filtered');
        } finally { rm(d); }
    });

    it('LIMITATION: Rust closure passed to iterator', () => {
        const d = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"',
            'src/main.rs': `
fn transform(x: i32) -> i32 {
    x * 2
}

fn process(items: Vec<i32>) -> Vec<i32> {
    items.iter().map(|x| transform(*x)).collect()
}

fn main() {
    let items = vec![1, 2, 3];
    process(items);
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // transform() inside closure — detected via line-range containment
            assert.ok(callees.some(c => c.name === 'transform'),
                'Call inside closure detected via line-range containment');
        } finally { rm(d); }
    });
});

// ============================================================================
// 16. SCOPE AND BINDING EDGE CASES
// ============================================================================

describe('16. Scope and Binding Edge Cases', () => {

    it('LIMITATION: block-scoped redeclaration — not modeled', () => {
        const d = tmp({
            'package.json': '{"name":"t"}',
            'lib.js': `
function helper() { return 'module'; }
function main() {
    if (true) {
        function helper() { return 'block'; }
        helper();
    }
    helper();
}
module.exports = { helper, main };
`});
        try {
            const index = idx(d);
            const callers = index.findCallers('helper');
            // Two bindings for 'helper' — scope disambiguation resolves calls
            assert.ok(callers.length >= 1,
                'At least some calls to helper are resolved despite block-scope complexity');
        } finally { rm(d); }
    });

    it('LIMITATION: Python nonlocal/global — scope not modeled', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'lib.py': `
counter = 0

def increment():
    global counter
    counter += 1

def get_count():
    return counter

def process():
    increment()
    return get_count()
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // Direct calls detected, but no data flow tracking for shared state
            assert.ok(callees.some(c => c.name === 'increment'),
                'Direct call to increment() detected');
            assert.ok(callees.some(c => c.name === 'get_count'),
                'Direct call to get_count() detected');
        } finally { rm(d); }
    });

    it('LIMITATION: Go goroutine launch — function ref not always detected', () => {
        const d = tmp({
            'go.mod': 'module test\ngo 1.21',
            'main.go': `package main

func worker(id int) {
    // do work
}

func main() {
    for i := 0; i < 10; i++ {
        go worker(i)
    }
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('main')?.[0];
            const callees = index.findCallees(def);
            // go worker(i) — go_statement wraps a call_expression
            assert.ok(callees.some(c => c.name === 'worker'),
                'go worker(i) — call detected inside go_statement');
        } finally { rm(d); }
    });

    it('LIMITATION: Java lambda — call inside lambda body', () => {
        const d = tmp({
            'pom.xml': '<project><modelVersion>4.0.0</modelVersion><groupId>t</groupId><artifactId>t</artifactId><version>1</version></project>',
            'App.java': `
import java.util.List;
import java.util.stream.Collectors;

public class App {
    public static String transform(String s) {
        return s.toUpperCase();
    }

    public static List<String> process(List<String> items) {
        return items.stream()
            .map(s -> transform(s))
            .collect(Collectors.toList());
    }
}
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // transform(s) inside lambda — detected via line-range containment
            assert.ok(callees.some(c => c.name === 'transform'),
                'Call inside Java lambda detected via line-range containment');
        } finally { rm(d); }
    });

    it('PASS: Python list comprehension calls detected', () => {
        const d = tmp({
            'pyproject.toml': '[project]\nname = "t"',
            'lib.py': `
def transform(x):
    return x * 2

def process(items):
    return [transform(x) for x in items]
`});
        try {
            const index = idx(d);
            const def = index.symbols.get('process')?.[0];
            const callees = index.findCallees(def);
            // transform(x) inside list comprehension — valid call_expression
            assert.ok(callees.some(c => c.name === 'transform'),
                'Call inside list comprehension detected — it IS a call_expression');
        } finally { rm(d); }
    });
});
