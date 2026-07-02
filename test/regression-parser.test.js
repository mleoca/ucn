/**
 * UCN Parser Regression Tests
 *
 * Tree-sitter coverage gaps: TS abstract class, Java record, Go embedded struct,
 * Rust trait impl/extern, TS enum/interface/namespace/decorators,
 * Python __all__/nested class/property, and cross-feature tests.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { execute } = require('../core/execute');
const { tmp, rm, idx } = require('./helpers');

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

describe('fix #233: usage classification is deterministic across index generations', () => {
    // Campaign G1-rust BUG-4 (the CI macro-flake root cause): tree-sitter
    // node WRAPPERS are not reference-stable — after a second ProjectIndex
    // build in the same process, `parent.child(i) === node` returned false
    // for the same underlying node inside macro token_trees, so
    // assert_eq!-wrapped calls flipped 'call'→'reference' and example
    // returned 'No examples found' deterministically. All parser
    // classification sites now compare node.id (sameNode in utils.js).
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': `pub fn camel_to_snake(s: &str) -> String {
    s.to_lowercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn works() {
        assert_eq!(camel_to_snake("helloWorld"), "hello_world");
    }
}
`,
    };

    it('example finds macro-wrapped call sites on every index generation', () => {
        const dir = tmp(FILES);
        try {
            for (let gen = 1; gen <= 3; gen++) {
                const index = idx(dir);
                execute(index, 'about', { name: 'camel_to_snake' });
                const r = execute(index, 'example', { name: 'camel_to_snake', includeTests: true });
                assert.ok(r.ok, `generation ${gen}: example must find the assert_eq! call site (${r.error})`);
            }
        } finally { rm(dir); }
    });

    it('usages keeps macro call sites classified as calls across generations', () => {
        const dir = tmp(FILES);
        try {
            for (let gen = 1; gen <= 3; gen++) {
                const index = idx(dir);
                execute(index, 'about', { name: 'camel_to_snake' });
                const r = execute(index, 'usages', { name: 'camel_to_snake', includeTests: true });
                assert.ok(r.ok);
                const call = r.result.find(u => u.line === 11);
                assert.ok(call, `generation ${gen}: line 11 present`);
                assert.strictEqual(call.usageType, 'call',
                    `generation ${gen}: assert_eq!-wrapped call must classify as call, got ${call.usageType}`);
            }
        } finally { rm(dir); }
    });
});
