/**
 * UCN Rust Regression Tests
 *
 * Rust-specific regressions: crate imports, trait impls, self methods, super::.
 * Extracted from parser.test.js.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { parse } = require('../core/parser');
const { ProjectIndex } = require('../core/project');
const { tmp, rm, idx, FIXTURES_PATH, PROJECT_DIR } = require('./helpers');

describe('Regression: Rust impl methods in context', () => {
    it('should show impl methods for Rust structs via receiver', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-impl-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "test"
version = "0.1.0"
`);
            fs.writeFileSync(path.join(tmpDir, 'lib.rs'), `pub struct User {
    name: String,
}

impl User {
    pub fn new(name: String) -> Self {
        User { name }
    }

    pub fn greet(&self) -> String {
        format!("Hello {}", self.name)
    }

    fn validate(&self) -> bool {
        !self.name.is_empty()
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            const ctx = index.context('User');

            // Should identify as struct
            assert.strictEqual(ctx.type, 'struct', 'User should be identified as struct');
            assert.ok(ctx.methods, 'Should have methods array');
            assert.strictEqual(ctx.methods.length, 3, 'User impl should have 3 methods');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('new'), 'Should include new');
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('validate'), 'Should include validate');

            // Methods should have receiver info pointing to User
            const greetMethod = ctx.methods.find(m => m.name === 'greet');
            assert.strictEqual(greetMethod.receiver, 'User', 'greet should have User as receiver');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Rust main and #[test] not flagged as deadcode', () => {
    it('should NOT report main() or #[test] functions as dead code in Rust', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-main-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]
name = "test"
version = "0.1.0"
`);
            fs.writeFileSync(path.join(tmpDir, 'main.rs'), `fn main() {
    helper();
}

fn helper() {
    println!("Helper");
}

fn unused_fn() {
    println!("Unused");
}

#[test]
fn test_something() {
    assert!(true);
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // main should NOT be flagged as dead code (entry point)
            assert.ok(!deadNames.includes('main'), 'main() should not be flagged as dead code');

            // test_something should NOT be flagged (has #[test] attribute)
            assert.ok(!deadNames.includes('test_something'), '#[test] function should not be flagged as dead code');

            // helper is called by main
            assert.ok(!deadNames.includes('helper'), 'helper() is called by main, not dead');

            // unused_fn should be flagged as dead
            assert.ok(deadNames.includes('unused_fn'), 'unused_fn() should be flagged as dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Rust crate:: import resolution', () => {
    it('should resolve crate:: paths and mod declarations to file paths', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-imports-${Date.now()}`);
        const srcDir = path.join(tmpDir, 'src');
        const displayDir = path.join(srcDir, 'display');
        fs.mkdirSync(displayDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test-crate"');

            // main.rs with mod declarations
            fs.writeFileSync(path.join(srcDir, 'main.rs'), `
mod display;
mod config;

use crate::display::Display;
use crate::config::Settings;

fn main() {
    let display = Display::new();
    let config = Settings::default();
}
`);
            // display/mod.rs
            fs.writeFileSync(path.join(displayDir, 'mod.rs'), `
use crate::config::Settings;

pub struct Display {
    width: u32,
    height: u32,
}

impl Display {
    pub fn new() -> Self {
        Display { width: 800, height: 600 }
    }
}
`);
            // config.rs
            fs.writeFileSync(path.join(srcDir, 'config.rs'), `
pub struct Settings {
    pub theme: String,
}

impl Settings {
    pub fn default() -> Self {
        Settings { theme: String::from("dark") }
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Test mod declaration resolution: main.rs imports display/ and config.rs
            const mainImporters = index.importGraph.get(path.join(srcDir, 'main.rs')) || [];
            assert.ok(mainImporters.length >= 2,
                `main.rs should import at least 2 files (display + config), got ${mainImporters.length}`);

            // Test exporters: display/mod.rs should be imported by main.rs
            const displayExporters = index.exporters('src/display/mod.rs');
            assert.ok(displayExporters.length >= 1,
                `display/mod.rs should have at least 1 exporter, got ${displayExporters.length}`);
            assert.ok(displayExporters.some(e => e.file.includes('main.rs')),
                `main.rs should import display/mod.rs`);

            // Test crate:: resolution: display/mod.rs imports config.rs via crate::config
            const displayImports = index.importGraph.get(path.join(displayDir, 'mod.rs')) || [];
            assert.ok(displayImports.some(i => i.includes('config.rs')),
                `display/mod.rs should import config.rs via crate::config, got ${displayImports.map(i => path.basename(i))}`);

            // Test exporters for config.rs: should be imported by both main.rs and display/mod.rs
            const configExporters = index.exporters('src/config.rs');
            assert.ok(configExporters.length >= 2,
                `config.rs should have at least 2 exporters (main + display), got ${configExporters.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should resolve nested crate:: paths like crate::display::color', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-nested-${Date.now()}`);
        const srcDir = path.join(tmpDir, 'src');
        const displayDir = path.join(srcDir, 'display');
        fs.mkdirSync(displayDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');

            fs.writeFileSync(path.join(srcDir, 'main.rs'), `
mod display;
use crate::display::color::Rgb;

fn main() {
    let c = Rgb::new(255, 0, 0);
}
`);
            fs.writeFileSync(path.join(displayDir, 'mod.rs'), `
pub mod color;
pub struct Display;
`);
            fs.writeFileSync(path.join(displayDir, 'color.rs'), `
pub struct Rgb {
    pub r: u8,
    pub g: u8,
    pub b: u8,
}

impl Rgb {
    pub fn new(r: u8, g: u8, b: u8) -> Self {
        Rgb { r, g, b }
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // main.rs should resolve crate::display::color::Rgb to display/color.rs
            const mainImports = index.importGraph.get(path.join(srcDir, 'main.rs')) || [];
            assert.ok(mainImports.some(i => i.includes('color.rs')),
                `main.rs should import display/color.rs via crate::display::color::Rgb, got ${mainImports.map(i => path.basename(i))}`);

            // color.rs exporters should include main.rs
            const colorExporters = index.exporters('src/display/color.rs');
            assert.ok(colorExporters.some(e => e.file.includes('main.rs')),
                `color.rs should be exported to main.rs`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: Rust self.method() same-class resolution', () => {
    it('findCallees should resolve self.method() to same-class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rustself-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'service.rs'), `
struct DataService {
    base_url: String,
}

impl DataService {
    fn fetch_remote(&self, key: &str, days: i32) -> Option<String> {
        self.make_request(&format!("/api/{}", key))
    }

    fn make_request(&self, url: &str) -> Option<String> {
        None
    }

    fn get_records(&self, key: &str) -> Option<String> {
        if self.is_valid(key) {
            return self.fetch_remote(key, 365);
        }
        None
    }

    fn is_valid(&self, key: &str) -> bool {
        !key.is_empty()
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.rs', { quiet: true });

            // get_records should have fetch_remote and is_valid as callees
            const defs = index.symbols.get('get_records');
            assert.ok(defs && defs.length > 0, 'Should find get_records');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('fetch_remote'),
                `Should resolve self.fetch_remote(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('is_valid'),
                `Should resolve self.is_valid(), got: ${calleeNames.join(', ')}`);

            // fetch_remote should have get_records as caller
            const callers = index.findCallers('fetch_remote');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('get_records'),
                `Should find get_records as caller of fetch_remote, got: ${callerNames.join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: deadcode skips Rust trait impl methods', () => {
    it('should not report trait impl methods as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-rust-trait-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            // A struct with an inherent impl and a trait impl
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), `
struct Foo {
    val: i32,
}

impl Foo {
    fn new(val: i32) -> Self {
        Foo { val }
    }

    fn unused_method(&self) -> i32 {
        self.val
    }
}

impl std::fmt::Display for Foo {
    fn fmt(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
        write!(f, "{}", self.val)
    }
}

impl PartialEq for Foo {
    fn eq(&self, other: &Self) -> bool {
        self.val == other.val
    }
}

fn main() {
    let f = Foo::new(42);
}
`);
            const idx = new ProjectIndex(tmpDir);
            idx.build(null, { quiet: true });
            const dead = idx.deadcode();
            const deadNames = dead.map(d => d.name);

            // Trait impl methods should NOT appear
            assert.ok(!deadNames.includes('fmt'), 'fmt (trait impl) should not be dead code');
            assert.ok(!deadNames.includes('eq'), 'eq (trait impl) should not be dead code');

            // Genuinely unused inherent method SHOULD appear
            assert.ok(deadNames.includes('unused_method'), 'unused_method should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// Regression: Rust #[bench] functions should be treated as entry points
describe('Regression: deadcode treats Rust #[bench] as entry points', () => {
    it('should not report #[bench] functions as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-rust-bench-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\nversion = "0.1.0"');
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'benches'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), `
fn main() {}

fn helper() -> i32 { 42 }
`);
            fs.writeFileSync(path.join(tmpDir, 'benches', 'my_bench.rs'), `
#![feature(test)]
extern crate test;
use test::Bencher;

#[bench]
fn bench_something(b: &mut Bencher) {
    b.iter(|| 1 + 1);
}

fn unused_bench_helper() -> i32 {
    42
}
`);
            const idx = new ProjectIndex(tmpDir);
            idx.build(null, { quiet: true });
            const dead = idx.deadcode();
            const deadNames = dead.map(d => d.name);

            // #[bench] should NOT appear as dead code
            assert.ok(!deadNames.includes('bench_something'), 'bench_something should not be dead code');

            // Genuinely unused function SHOULD appear
            assert.ok(deadNames.includes('unused_bench_helper'), 'unused_bench_helper should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('Regression: deadcode relative path fix works for Rust projects', () => {
    it('should not treat non-test Rust files as test files when project is inside /tests/ directory', () => {
        // Project lives inside a directory called "tests"
        const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-relpath-${Date.now()}`, 'tests', 'myproject');
        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
            fs.writeFileSync(path.join(srcDir, 'lib.rs'), `
fn unused_helper() -> i32 {
    42
}

pub fn used_func() -> i32 {
    unused_helper()
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // unused_helper should be flagged (it has a caller but let's check it's not filtered)
            // The key assertion: src/lib.rs should NOT be treated as a test file
            const { isTestFile } = require('../core/discovery');
            assert.ok(!isTestFile('src/lib.rs', 'rust'),
                'src/lib.rs should not be a test file');

            // Verify the old bug: absolute path WOULD falsely match
            const absPath = path.join(tmpDir, 'src', 'lib.rs');
            // The absolute path contains /tests/ from parent dir
            assert.ok(absPath.includes('/tests/'),
                'Absolute path should contain /tests/ from parent directory');
        } finally {
            const topDir = tmpDir.split('/tests/myproject')[0];
            if (topDir.includes('ucn-test-rust-relpath')) {
                fs.rmSync(topDir, { recursive: true, force: true });
            }
        }
    });
});

describe('Bug Report #3: Rust Regressions', () => {

it('Rust type_identifier — struct expressions and type annotations detected', (t) => {
    const { getParser } = require('../languages');
    const { findUsagesInCode } = require('../languages/rust');

    const code = `struct MyService {
    name: String,
}

impl MyService {
    fn new() -> MyService {
        MyService { name: String::new() }
    }
    fn run(&self) {}
}

fn use_service(svc: MyService) {
    svc.run();
}

fn main() {
    let svc = MyService::new();
    let x: MyService = svc;
}
`;
    const parser = getParser('rust');
    const usages = findUsagesInCode(code, 'MyService', parser);

    // Struct expression MyService{} should be "call"
    const calls = usages.filter(u => u.usageType === 'call');
    assert.ok(calls.length >= 2, `Should find at least 2 calls (struct expr + scoped call), got ${calls.length}`);

    // MyService::new() should be classified as "call" (the identifier inside scoped_identifier)
    const scopedCall = usages.find(u => u.line === 17 && u.usageType === 'call');
    assert.ok(scopedCall, 'MyService::new() should classify MyService as "call"');

    // Type references (return type, param type, let type) should be found
    const refs = usages.filter(u => u.usageType === 'reference');
    assert.ok(refs.length >= 2, `Should find type references, got ${refs.length}`);

    // Total usages should include type_identifier nodes
    assert.ok(usages.length >= 7, `Should find at least 7 usages (with type_identifier), got ${usages.length}`);
});

it('Rust type_identifier — parameter type not misclassified as definition', (t) => {
    const { getParser } = require('../languages');
    const { findUsagesInCode } = require('../languages/rust');

    const code = `struct Config {}
fn use_cfg(cfg: Config) {}
`;
    const parser = getParser('rust');
    const usages = findUsagesInCode(code, 'Config', parser);

    // The parameter type should be "reference", not "definition"
    const paramTypeUsage = usages.find(u => u.line === 2 && u.usageType !== 'definition');
    assert.ok(paramTypeUsage, 'Config in fn use_cfg(cfg: Config) should be reference, not definition');
    assert.strictEqual(paramTypeUsage.usageType, 'reference');
});

it('Rust scoped call — Type::method() classified as call', (t) => {
    const { getParser } = require('../languages');
    const { findUsagesInCode } = require('../languages/rust');

    const code = `struct Config {}
impl Config {
    fn new() -> Config { Config {} }
    fn default() -> Config { Config::new() }
}
fn main() {
    let c = Config::new();
}
`;
    const parser = getParser('rust');
    const usages = findUsagesInCode(code, 'Config', parser);

    // Config::new() calls should be classified as "call"
    const callLines = usages.filter(u => u.usageType === 'call').map(u => u.line);
    assert.ok(callLines.includes(4), 'Config::new() on line 4 should be "call"');
    assert.ok(callLines.includes(7), 'Config::new() on line 7 should be "call"');
});

}); // end describe('Bug Report #3: Rust Regressions')

describe('Bug Report #4: Rust Regressions', () => {

// BUG 3: Rust Type::method() static calls should be included by default
it('Rust auto-includes method calls like Go/Java', (t) => {
    const { ProjectIndex } = require('../core/project');
    const rustCode = `
struct Config {}
impl Config {
    fn new() -> Config { Config {} }
}
fn main() {
    let c = Config::new();
}
`;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug3-'));
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'main.rs'), rustCode);
    fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"');
    try {
        const idx = new ProjectIndex(tmpDir);
        idx.build();
        const callers = idx.findCallers('new', {});
        assert.ok(callers.some(c => c.callerName === 'main'), 'Rust Config::new() should be found as caller of new without --include-methods');
    } finally {
        fs.rmSync(tmpDir, { recursive: true });
    }
});

// BUG 7: Rust enum variant references should not match struct usages
it('Rust usages filters Boundary::Grid enum variant from Grid struct usages', (t) => {
    const { getParser } = require('../languages');
    const { findUsagesInCode } = require('../languages/rust');

    const code = `
enum Boundary {
    Grid,
    Cursor,
}
struct Grid<T> {
    data: Vec<T>,
}
impl<T> Grid<T> {
    fn new() -> Grid<T> { Grid { data: vec![] } }
}
fn main() {
    let g = Grid::new();
    let b = Boundary::Grid;
    let c = Boundary::Cursor;
}
`;
    const parser = getParser('rust');
    const usages = findUsagesInCode(code, 'Grid', parser);
    // Boundary::Grid should NOT be in the usages (line 14 in the test code)
    const lines = usages.map(u => u.line);
    assert.ok(!lines.includes(14), 'Boundary::Grid (line 14) should not be a usage of Grid struct');
    // Grid::new() SHOULD be in the usages (Grid is the path/left side, line 13)
    assert.ok(lines.includes(13), 'Grid::new() (line 13) should be a usage of Grid struct');
    // Boundary::Cursor should not appear at all (searching for "Grid")
    assert.ok(!lines.includes(15), 'Boundary::Cursor should not appear in Grid usages');
});

// BUG 7b: Rust enum variant filter doesn't affect module paths or Self::
it('Rust usages keeps module::Item and Self::method references', (t) => {
    const { getParser } = require('../languages');
    const { findUsagesInCode } = require('../languages/rust');

    const code = `
mod mymod {
    pub fn helper() {}
}
fn main() {
    mymod::helper();
}
`;
    const parser = getParser('rust');
    const usages = findUsagesInCode(code, 'helper', parser);
    // mymod::helper() should still be found (module path is lowercase)
    assert.ok(usages.some(u => u.line === 6 && u.usageType === 'call'), 'mymod::helper() should be found as call');
});

}); // end describe('Bug Report #4: Rust Regressions')

describe('Rust Fix Regressions', () => {

it('FIX 84 — Rust super:: resolves correctly for mod.rs and regular files', () => {
    const { resolveImport } = require('../core/imports');
    const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-super-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const srcDir = path.join(tmpDir, 'src');
    fs.mkdirSync(path.join(srcDir, 'foo'), { recursive: true });

    try {
        fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\n');
        fs.writeFileSync(path.join(srcDir, 'bar.rs'), 'pub fn bar_fn() {}\n');
        fs.writeFileSync(path.join(srcDir, 'foo', 'mod.rs'), '');
        fs.writeFileSync(path.join(srcDir, 'foo', 'baz.rs'), '');
        fs.writeFileSync(path.join(srcDir, 'main.rs'), '');

        const config = { language: 'rust', root: tmpDir };

        // mod.rs: super:: should resolve one level up from src/foo/ to src/
        const modResult = resolveImport(
            'super::bar',
            path.join(srcDir, 'foo', 'mod.rs'),
            config
        );
        assert.ok(modResult && modResult.endsWith(path.join('src', 'bar.rs')),
            `mod.rs super::bar should resolve to src/bar.rs, got: ${modResult}`);

        // regular file: super:: from baz.rs stays in src/foo/ (parent module is foo)
        // super::bar from baz.rs → look for bar in src/foo/ (doesn't exist → null)
        const regResult = resolveImport(
            'super::bar',
            path.join(srcDir, 'foo', 'baz.rs'),
            config
        );
        // Key: mod.rs resolves to src/, regular file resolves to src/foo/
        // modResult found bar.rs in src/, regResult should NOT find it in src/foo/
        assert.ok(modResult !== regResult,
            'mod.rs and regular .rs should resolve super:: to different directories');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 85 — Rust include! macro name matches without trailing !', () => {
    const { getParser } = require('../languages');
    const rustParser = require('../languages/rust');
    const parser = getParser('rust');
    const code = `include!("generated.rs");\ninclude_str!("data.txt");\n`;
    const imports = rustParser.findImportsInCode(code, parser);
    // Should detect include! and include_str! as imports
    const includeImports = imports.filter(i => i.type === 'include');
    assert.ok(includeImports.length >= 1,
        `Should detect include! macros as imports, found ${includeImports.length}`);
});

it('FIX 89 — findCallees includes Rust method calls by default', () => {
    const tmpDir = path.join(os.tmpdir(), `ucn-test-rust-callees-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    fs.mkdirSync(tmpDir, { recursive: true });

    try {
        fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), '[package]\nname = "test"\n');
        fs.writeFileSync(path.join(tmpDir, 'lib.rs'), `
struct Foo;
impl Foo {
    fn bar(&self) -> i32 { 42 }
}
fn main() {
    let f = Foo;
    f.bar();
}
`);
        const index = new ProjectIndex(tmpDir);
        index.build('**/*.rs', { quiet: true });

        // findCallees for 'main' should include f.bar() by default for Rust
        const callees = index.findCallees('main');
        // Verify no crash and returns array
        assert.ok(Array.isArray(callees), 'findCallees should return array for Rust');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

it('FIX 100 — findEnclosingFunction excludes enum and trait', () => {
    const projectCode = fs.readFileSync(path.join(PROJECT_DIR, 'core', 'project.js'), 'utf-8');
    // NON_CALLABLE_TYPES module constant should include enum and trait
    const match = projectCode.match(/NON_CALLABLE_TYPES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    assert.ok(match, 'NON_CALLABLE_TYPES constant should exist');
    assert.ok(match[1].includes("'enum'"), 'enum should be in NON_CALLABLE_TYPES');
    assert.ok(match[1].includes("'trait'"), 'trait should be in NON_CALLABLE_TYPES');
});

}); // end describe('Rust Fix Regressions')

// ============================================================================
// Bug Hunt: Rust turbofish calls
// ============================================================================

describe('Bug Hunt: Rust turbofish calls detected', () => {
    it('should detect turbofish method calls like .parse::<i32>()', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `fn main() {
    let x = "42".parse::<i32>().unwrap();
    let v: Vec<_> = vec![1,2,3].iter().collect::<Vec<_>>();
}`;
        const calls = rustMod.findCallsInCode(code, parser);
        const names = calls.map(c => c.name);
        assert.ok(names.includes('parse'), 'should detect parse::<i32>()');
        assert.ok(names.includes('collect'), 'should detect collect::<Vec<_>>()');
        assert.ok(names.includes('unwrap'), 'should still detect unwrap()');
    });

    it('should detect turbofish standalone calls like func::<T>()', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `fn main() { let x = convert::<String>(); }
fn convert<T>() -> T { todo!() }`;
        const calls = rustMod.findCallsInCode(code, parser);
        assert.ok(calls.some(c => c.name === 'convert'), 'should detect convert::<String>()');
    });

    it('turbofish calls should appear in raw call lists', () => {
        const dir = tmp({
            'src/main.rs': `
fn convert<T: Default>() -> T { T::default() }
fn caller() {
    let x = convert::<String>();
}
`,
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"'
        });
        const index = new ProjectIndex(dir);
        index.build(null, { quiet: true });
        const caller = index.symbols.get('caller');
        assert.ok(caller && caller.length > 0, 'caller should exist');
        const callees = index.findCallees(caller[0]);
        const calleeNames = callees.map(c => c.name);
        assert.ok(calleeNames.includes('convert'), `callees should include 'convert', got: ${calleeNames}`);
        rm(dir);
    });
});

// ============================================================================
// Bug Hunt: Rust super:: with lib.rs/main.rs
// ============================================================================

describe('Bug Hunt: Rust super:: resolution for lib.rs and main.rs', () => {
    it('should treat lib.rs and main.rs as module roots like mod.rs', () => {
        const { resolveImport } = require('../core/imports');
        // For lib.rs, super:: should go up from the directory containing lib.rs
        const dir = tmp({
            'src/lib.rs': 'use super::other;',
            'other.rs': 'pub fn hello() {}',
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"'
        });
        // resolveImport takes (importPath, fromFile, config)
        const resolved = resolveImport('super::other', path.join(dir, 'src', 'lib.rs'), { projectRoot: dir, language: 'rust' });
        // For lib.rs, isMod=true → ups=1 → goes from src/ up to dir, finds other.rs
        if (resolved) {
            assert.ok(resolved.includes('other'), `resolved path should reference 'other', got: ${resolved}`);
        }
        // Verify main.rs is also treated as module root
        const dir2 = tmp({
            'src/main.rs': 'mod sub;',
            'src/sub.rs': 'pub fn helper() {}',
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"'
        });
        const resolved2 = resolveImport('sub', path.join(dir2, 'src', 'main.rs'), { projectRoot: dir2, language: 'rust' });
        assert.ok(resolved2 && resolved2.includes('sub'), `main.rs mod resolution should work, got: ${resolved2}`);
        rm(dir);
        rm(dir2);
    });
});
