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
const { execute } = require('../core/execute');
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
            const mainImporters = index.importGraph.get(path.join(srcDir, 'main.rs')) || new Set();
            assert.ok(mainImporters.size >= 2,
                `main.rs should import at least 2 files (display + config), got ${mainImporters.size}`);

            // Test exporters: display/mod.rs should be imported by main.rs
            const displayExporters = index.exporters('src/display/mod.rs');
            assert.ok(displayExporters.length >= 1,
                `display/mod.rs should have at least 1 exporter, got ${displayExporters.length}`);
            assert.ok(displayExporters.some(e => e.file.includes('main.rs')),
                `main.rs should import display/mod.rs`);

            // Test crate:: resolution: display/mod.rs imports config.rs via crate::config
            const displayImports = index.importGraph.get(path.join(displayDir, 'mod.rs')) || new Set();
            let hasConfig = false;
            for (const i of displayImports) { if (i.includes('config.rs')) { hasConfig = true; break; } }
            assert.ok(hasConfig,
                `display/mod.rs should import config.rs via crate::config, got ${[...displayImports].map(i => path.basename(i))}`);

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
            const mainImports = index.importGraph.get(path.join(srcDir, 'main.rs')) || new Set();
            let hasColor = false;
            for (const i of mainImports) { if (i.includes('color.rs')) { hasColor = true; break; } }
            assert.ok(hasColor,
                `main.rs should import display/color.rs via crate::display::color::Rgb, got ${[...mainImports].map(i => path.basename(i))}`);

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
    assert.ok(calls.length >= 1, `Should find at least 1 call (struct expr), got ${calls.length}`);

    // MyService in MyService::new() is the path QUALIFIER — a type reference;
    // the call belongs to `new` (matches ts-morph/pyright classification and
    // keeps the account from tagging qualifier lines call-not-resolved)
    const scopedQualifier = usages.find(u => u.line === 17 && u.usageType === 'reference');
    assert.ok(scopedQualifier, 'MyService::new() should classify MyService as "reference"');

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

it('Rust scoped call — Type::method() qualifier classified as reference', (t) => {
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

    // Config in Config::new() is the path qualifier: the CALL belongs to
    // `new`; for the symbol Config these lines are type references. (The
    // qualifier used to classify as 'call', which made the account tag
    // File::open(...) lines call-not-resolved for the type File.)
    const refLines = usages.filter(u => u.usageType === 'reference').map(u => u.line);
    assert.ok(refLines.includes(4), 'Config::new() on line 4 should be "reference"');
    assert.ok(refLines.includes(7), 'Config::new() on line 7 should be "reference"');
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
    const sharedCode = fs.readFileSync(path.join(PROJECT_DIR, 'core', 'shared.js'), 'utf-8');
    // NON_CALLABLE_TYPES constant should include enum and trait
    const match = sharedCode.match(/NON_CALLABLE_TYPES\s*=\s*new Set\(\[([^\]]+)\]\)/);
    assert.ok(match, 'NON_CALLABLE_TYPES constant should exist in shared.js');
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

describe('Bug Hunt: Rust trait default implementations not double-counted', () => {
    it('should not list trait default methods as standalone functions', () => {
        const code = `
trait Drawable {
    fn draw(&self);

    fn default_color(&self) -> &str {
        "black"
    }
}

struct Circle {
    radius: f64,
}

impl Drawable for Circle {
    fn draw(&self) {
        println!("Drawing circle");
    }
}

fn main() {
    let c = Circle { radius: 5.0 };
    c.draw();
}
`;
        const result = parse(code, 'rust');
        const fnNames = result.functions.map(f => f.name);

        // main should be a standalone function
        assert.ok(fnNames.includes('main'), 'main should be found');

        // default_color is a trait default impl — should NOT appear as standalone
        assert.ok(!fnNames.includes('default_color'),
            `Trait default method 'default_color' should not appear as standalone function, got: [${fnNames.join(', ')}]`);

        // draw should not appear as standalone either (it's in impl block)
        assert.ok(!fnNames.includes('draw'),
            `Impl method 'draw' should not appear as standalone function`);

        // But both should appear as class members
        const traitClass = result.classes.find(c => c.name === 'Drawable');
        assert.ok(traitClass, 'Drawable trait should be found as a class');
        const traitMembers = traitClass.members.map(m => m.name);
        assert.ok(traitMembers.includes('default_color'),
            'default_color should be a member of Drawable trait');
    });
});

// ============================================================================
// FIX #115: Rust `use X as Y` imports silently dropped
// ============================================================================

describe('Bug Hunt: Rust use-as imports detected', () => {
    it('should detect use X as Y imports', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `use std::collections::HashMap as Map;
use foo::bar::Baz as MyBaz;
use crate::utils::helper as h;
`;
        const imports = rustMod.findImportsInCode(code, parser);
        assert.strictEqual(imports.length, 3, 'should find 3 imports');
        assert.strictEqual(imports[0].names[0], 'Map', 'alias should be Map');
        assert.strictEqual(imports[0].module, 'std::collections::HashMap');
        assert.strictEqual(imports[1].names[0], 'MyBaz', 'alias should be MyBaz');
        assert.strictEqual(imports[2].names[0], 'h', 'alias should be h');
    });

    it('should detect use-as inside use lists', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `use std::{io, collections::HashMap as Map};`;
        const imports = rustMod.findImportsInCode(code, parser);
        assert.ok(imports.length >= 1, 'should find imports');
        const names = imports.flatMap(i => i.names);
        assert.ok(names.includes('Map'), 'should include alias Map from use list');
    });

    it('should resolve aliased imports in project via imports command (verified by integration)', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-alias-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'), `[package]\nname = "test"\nversion = "0.1.0"\n`);
            fs.writeFileSync(path.join(tmpDir, 'lib.rs'), `pub fn original_fn() -> i32 { 42 }\n`);
            fs.writeFileSync(path.join(tmpDir, 'main.rs'), `use crate::lib::original_fn as aliased;
fn main() {
    aliased();
}
`);
            const index = idx(tmpDir);
            const result = index.imports('main.rs');
            assert.ok(result && result.length > 0, 'should find imports');
            assert.ok(result.some(i => i.names && i.names.includes('aliased')),
                'should detect aliased import name');
        } finally {
            rm(tmpDir);
        }
    });
});

// Bug Hunt: Rust associated functions (no self) should have isMethod=false
describe('Bug Hunt: Rust associated functions vs methods', () => {
    it('should distinguish associated functions (no self) from methods (with self)', () => {
        const tmpDir = tmp({
            'Cargo.toml': `[package]\nname = "test"\nversion = "0.1.0"\n`,
            'lib.rs': `
pub struct Config {
    pub name: String,
}

impl Config {
    pub fn new(name: String) -> Self {
        Config { name }
    }

    pub fn default() -> Self {
        Config::new("default".to_string())
    }

    pub fn validate(&self) -> bool {
        !self.name.is_empty()
    }

    fn reset(&mut self) {
        self.name = String::new();
    }
}
`
        });
        try {
            const index = idx(tmpDir);
            const ctx = index.context('Config');
            assert.ok(ctx, 'Config should be found');
            assert.strictEqual(ctx.methods.length, 4, 'Should list all 4 impl members');

            // All should have receiver pointing to Config
            for (const m of ctx.methods) {
                assert.strictEqual(m.receiver, 'Config', `${m.name} should have Config receiver`);
            }

            // Check the symbols directly for isMethod flag
            const symbols = index.symbols;
            const newFn = Array.from(symbols.values()).flat().find(s => s.name === 'new' && s.receiver === 'Config');
            const validateFn = Array.from(symbols.values()).flat().find(s => s.name === 'validate' && s.receiver === 'Config');

            assert.ok(newFn, 'new should exist in symbol index');
            assert.ok(validateFn, 'validate should exist in symbol index');
            assert.ok(!newFn.isMethod, 'new() without self should not have isMethod=true');
            assert.strictEqual(validateFn.isMethod, true, 'validate(&self) should have isMethod=true');
        } finally {
            rm(tmpDir);
        }
    });
});

// Bug Hunt: Rust deeply nested use paths should classify as import
describe('Bug Hunt: Rust nested use path import classification', () => {
    it('should classify identifiers in deeply nested use paths as imports', () => {
        const { getParser, getLanguageModule } = require('../languages');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `
use std::collections::HashMap;
use std::io::Read;
use crate::module::submodule::MyType;

fn main() {
    let mut map = HashMap::new();
    let val: MyType = get_value();
}
`;
        const usages = rustMod.findUsagesInCode(code, 'HashMap', parser);
        const importUsage = usages.find(u => u.usageType === 'import');
        assert.ok(importUsage, 'HashMap in use std::collections::HashMap should be classified as import');

        const myTypeUsages = rustMod.findUsagesInCode(code, 'MyType', parser);
        const myTypeImport = myTypeUsages.find(u => u.usageType === 'import');
        assert.ok(myTypeImport, 'MyType in deeply nested use path should be classified as import');

        const readUsages = rustMod.findUsagesInCode(code, 'Read', parser);
        const readImport = readUsages.find(u => u.usageType === 'import');
        assert.ok(readImport, 'Read in use std::io::Read should be classified as import');
    });
});

// ============================================================================
// fix #163: Rust receiver type tracking for method disambiguation
// ============================================================================

describe('fix #163: Rust receiver type tracking in findCallsInCode', () => {
    it('infers receiverType from function parameters', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `struct Filter {}
impl Filter { fn run(&self) {} }
struct Score {}
impl Score { fn run(&self) {} }
fn process(f: &Filter, s: &Score) {
    f.run();
    s.run();
}`;
        const calls = rustMod.findCallsInCode(code, parser);
        const fRun = calls.find(c => c.name === 'run' && c.receiver === 'f');
        const sRun = calls.find(c => c.name === 'run' && c.receiver === 's');
        assert.ok(fRun, 'Should find f.run() call');
        assert.ok(sRun, 'Should find s.run() call');
        assert.strictEqual(fRun.receiverType, 'Filter', 'f should have receiverType Filter');
        assert.strictEqual(sRun.receiverType, 'Score', 's should have receiverType Score');
    });

    it('does not set receiverType for self.method()', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `struct Foo {}
impl Foo {
    fn bar(&self) { self.baz(); }
    fn baz(&self) {}
}`;
        const calls = rustMod.findCallsInCode(code, parser);
        const selfBaz = calls.find(c => c.name === 'baz' && c.receiver === 'self');
        assert.ok(selfBaz, 'Should find self.baz() call');
        assert.strictEqual(selfBaz.receiverType, undefined, 'self.baz() should not have receiverType');
    });

    it('strips reference types to get base type', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('rust');
        const rustMod = getLanguageModule('rust');
        const code = `struct Config {}
impl Config { fn validate(&self) -> bool { true } }
fn check(cfg: &mut Config) {
    cfg.validate();
}`;
        const calls = rustMod.findCallsInCode(code, parser);
        const cfgValidate = calls.find(c => c.name === 'validate' && c.receiver === 'cfg');
        assert.ok(cfgValidate, 'Should find cfg.validate() call');
        assert.strictEqual(cfgValidate.receiverType, 'Config',
            '&mut Config should resolve to Config');
    });
});

describe('fix #163: Rust callee disambiguation with receiver type', () => {
    it('resolves callees to correct type when multiple types have same method', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"',
            'src/main.rs': `struct Filter {}
impl Filter {
    fn run(&self) -> String { String::from("filter") }
}

struct Score {}
impl Score {
    fn run(&self) -> String { String::from("score") }
}

fn process(f: &Filter, s: &Score) {
    f.run();
    s.run();
}

fn main() {}
`
        });
        try {
            const index = idx(dir);

            // process should resolve f.run() → Filter.run, s.run() → Score.run
            const processDef = (index.symbols.get('process') || [])[0];
            assert.ok(processDef, 'Should find process');
            const callees = index.findCallees(processDef);
            const runCallees = callees.filter(c => c.name === 'run');
            assert.ok(runCallees.length >= 2,
                `Should find both run callees, got: ${runCallees.map(c => c.receiver).join(', ')}`);
            assert.ok(runCallees.some(c => c.receiver === 'Filter'),
                'Should include Filter.run');
            assert.ok(runCallees.some(c => c.receiver === 'Score'),
                'Should include Score.run');
        } finally {
            rm(dir);
        }
    });

    it('resolves callers to correct type with targetDefinitions', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"',
            'src/main.rs': `struct Filter {}
impl Filter {
    fn process(&self) -> String { String::from("filter") }
}

struct Score {}
impl Score {
    fn process(&self) -> String { String::from("score") }
}

fn run_filters(f: &Filter) {
    f.process();
}

fn run_scores(s: &Score) {
    s.process();
}

fn main() {}
`
        });
        try {
            const index = idx(dir);

            // Callers of Filter.process should include run_filters, not run_scores
            const filterProcess = (index.symbols.get('process') || [])
                .find(d => d.receiver === 'Filter');
            assert.ok(filterProcess, 'Should find Filter.process');

            const callers = index.findCallers('process', {
                targetDefinitions: [filterProcess]
            });
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('run_filters'),
                'run_filters should be a caller of Filter.process');
            assert.ok(!callerNames.includes('run_scores'),
                'run_scores should NOT be a caller of Filter.process');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #167: Rust method references detected as callbacks', () => {
    it('detects obj.method passed as argument as callback reference', () => {
        const dir = tmp({
            'main.rs': `struct Handler;
impl Handler {
    fn process(&self) {}
}
fn execute(f: impl Fn()) { f(); }
fn main() {
    let h = Handler;
    execute(h.process);
}`,
        });
        try {
            const index = idx(dir);
            const mainDef = index.symbols.get('main')?.find(s => s.file.includes('main.rs'));
            assert.ok(mainDef, 'main function should exist');
            const callees = index.findCallees(mainDef);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('execute'), 'should find execute as callee');
            assert.ok(calleeNames.includes('process'), 'should find process as callback callee');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #191: Rust local variable type inference for confidence scoring', () => {
    it('infers receiverType from struct expression: let s = Server { ... }', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'lib.rs': `
struct Server { port: u16 }
impl Server { fn start(&self) {} }
struct Client { url: String }
impl Client { fn start(&self) {} }

fn setup() {
    let s = Server { port: 8080 };
    s.start();
}
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('start', { includeMethods: true });
            const setup = callers.find(c => c.callerName === 'setup');
            assert.ok(setup, 'setup should be a caller');
            assert.strictEqual(setup.receiverType, 'Server', 'should infer Server from struct expression');
            assert.strictEqual(setup.resolution, 'receiver-hint');
        } finally {
            rm(dir);
        }
    });

    it('infers receiverType from constructor call: let s = Server::new()', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'lib.rs': `
struct Server { port: u16 }
impl Server {
    fn new() -> Server { Server { port: 8080 } }
    fn start(&self) {}
}

fn setup() {
    let s = Server::new();
    s.start();
}
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('start', { includeMethods: true });
            const setup = callers.find(c => c.callerName === 'setup');
            assert.ok(setup, 'setup should be a caller');
            assert.strictEqual(setup.receiverType, 'Server', 'should infer Server from ::new()');
            assert.strictEqual(setup.resolution, 'receiver-hint');
        } finally {
            rm(dir);
        }
    });

    it('infers receiverType from explicit type annotation: let s: Server = ...', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'lib.rs': `
struct Server { port: u16 }
impl Server { fn start(&self) {} }

fn get_server() -> Server { Server { port: 8080 } }

fn setup() {
    let s: Server = get_server();
    s.start();
}
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('start', { includeMethods: true });
            const setup = callers.find(c => c.callerName === 'setup');
            assert.ok(setup, 'setup should be a caller');
            assert.strictEqual(setup.receiverType, 'Server', 'should infer Server from type annotation');
            assert.strictEqual(setup.resolution, 'receiver-hint');
        } finally {
            rm(dir);
        }
    });

    it('infers receiverType from reference to struct: let s = &Config { ... }', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'lib.rs': `
struct Config { debug: bool }
impl Config { fn validate(&self) -> bool { true } }

fn init() {
    let cfg = &Config { debug: true };
    cfg.validate();
}
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('validate', { includeMethods: true });
            const init = callers.find(c => c.callerName === 'init');
            assert.ok(init, 'init should be a caller');
            assert.strictEqual(init.receiverType, 'Config', 'should infer Config from &struct');
        } finally {
            rm(dir);
        }
    });

    it('infers from ::default(), ::from(), ::with_* constructors', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'lib.rs': `
struct Builder { ready: bool }
impl Builder { fn build(&self) {} }

fn run() {
    let b = Builder::default();
    b.build();
}
`
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('build', { includeMethods: true });
            const run = callers.find(c => c.callerName === 'run');
            assert.ok(run, 'run should be a caller');
            assert.strictEqual(run.receiverType, 'Builder', 'should infer Builder from ::default()');
        } finally {
            rm(dir);
        }
    });

    it('disambiguates between types with same method name using inferred receiverType', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"',
            'lib.rs': `
struct Server { port: u16 }
impl Server { fn start(&self) {} }
struct Client { url: String }
impl Client { fn start(&self) {} }

fn launch_server() {
    let s = Server::new();
    s.start();
}
fn launch_client() {
    let c = Client::from("localhost");
    c.start();
}
`
        });
        try {
            const index = idx(dir);
            // Check callers of start targeting Server
            const serverDefs = index.symbols.get('start')?.filter(s => s.className === 'Server');
            assert.ok(serverDefs?.length > 0, 'should find Server.start definition');
            const serverCallers = index.findCallers('start', { includeMethods: true, targetDefinitions: serverDefs });
            const serverCallerNames = serverCallers.map(c => c.callerName);
            assert.ok(serverCallerNames.includes('launch_server'), 'launch_server should call Server.start');
            assert.ok(!serverCallerNames.includes('launch_client'), 'launch_client should NOT call Server.start');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// ENTRYPOINTS: Rust Actix/Tokio detection
// ============================================================================

describe('Entrypoints: Actix/Tokio detection', () => {
    const { detectEntrypoints } = require('../core/entrypoints');

    it('detects #[get] and #[post] Actix route attributes', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"',
            'main.rs': `
use actix_web::{get, post, HttpResponse};

#[get("/health")]
async fn health() -> HttpResponse {
    HttpResponse::Ok().finish()
}

#[post("/items")]
async fn create_item() -> HttpResponse {
    HttpResponse::Created().finish()
}

fn helper() -> i32 { 42 }
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('health'), 'should detect #[get] handler');
            assert.ok(names.includes('create_item'), 'should detect #[post] handler');
            assert.ok(!names.includes('helper'), 'should not detect plain helper');
            assert.ok(eps.find(e => e.name === 'health').framework === 'actix');
        } finally { rm(dir); }
    });

    it('detects #[tokio::main] runtime entry point', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"',
            'main.rs': `
#[tokio::main]
async fn main() {
    println!("Hello");
}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            // main is already a runtime entry point, but tokio::main should also detect
            assert.ok(eps.some(e => e.framework === 'tokio'), 'should detect tokio::main');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #175: Rust scoped_identifier (::) calls parsed by verify
// ============================================================================

describe('fix #175: Rust scoped_identifier (::) calls parsed by verify', () => {
    const { execute } = require('../core/execute');

    it('verify can parse Task::new() call arguments', () => {
        const dir = tmp({
            'a.rs': 'pub struct Task { id: String, name: String }\nimpl Task {\n    pub fn new(id: String, name: String) -> Self {\n        Task { id, name }\n    }\n}\nfn create() { Task::new("1".to_string(), "test".to_string()); }'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'verify', { name: 'new', className: 'Task' });
            assert.ok(r.ok, 'verify should succeed');
            assert.strictEqual(r.result.uncertain, 0, 'Task::new() should not be uncertain');
            assert.strictEqual(r.result.valid, 1, 'Task::new() should be valid');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #179: removeParam 'self' normalizes to match &self/&mut self
// ============================================================================

describe('fix #179: plan --remove-param self normalizes to match &self', () => {
    const { execute } = require('../core/execute');

    it('plan --remove-param self matches &self parameter', () => {
        const dir = tmp({
            'a.rs': 'struct Foo;\nimpl Foo {\n    fn bar(&self) { }\n}\nfn main() { let f = Foo; f.bar(); }'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'plan', { name: 'bar', removeParam: 'self', className: 'Foo' });
            assert.ok(r.ok, 'should not error');
            assert.ok(r.result.found, 'should find the function');
            assert.ok(!r.result.error, 'should not say "self not found"');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #182: Turbofish syntax in verify
// ============================================================================

describe('BUG-CX: Rust fn main() not mis-tagged as test-case in affectedTests', () => {
    it('fn main() should NOT appear as a test-case match', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"',
            // main.rs calls helper() from main(); test_helper() is the actual test.
            'src/main.rs': `fn helper() -> i32 {
    1
}

fn main() {
    let _ = helper();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_helper() {
        assert_eq!(helper(), 1);
    }
}
`
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result, 'affectedTests should return a result');

            // Collect all test-case matches across files.
            const testCaseMatches = [];
            for (const r of result.testFiles || []) {
                for (const m of r.matches || []) {
                    if (m.matchType === 'test-case') {
                        testCaseMatches.push({ file: r.file, line: m.line, content: m.content });
                    }
                }
            }

            // BUG-CX: main() must never be classified as a test-case.
            assert.ok(
                !testCaseMatches.some(m => m.content.includes('fn main')),
                `main() must not be tagged as test-case. Got: ${JSON.stringify(testCaseMatches, null, 2)}`
            );
            // The actual test_helper() must be classified as a test-case.
            assert.ok(
                testCaseMatches.some(m => m.content.includes('fn test_helper')),
                `test_helper() should be a test-case. Got: ${JSON.stringify(testCaseMatches, null, 2)}`
            );
        } finally { rm(dir); }
    });
});

describe('BUG-CY: Rust tests inside #[cfg(test)] mod block are not in uncovered', () => {
    it('helper called by an inline #[cfg(test)] mod test should be covered', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"',
            // helper() lives in lib.rs; its only call site is inside a #[cfg(test)] mod tests block.
            'src/lib.rs': `pub fn helper() -> i32 {
    42
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_helper() {
        assert_eq!(helper(), 42);
    }
}
`
        });
        try {
            const index = idx(dir);
            const result = index.affectedTests('helper');
            assert.ok(result, 'affectedTests should return a result');

            // BUG-CY: helper must be in coveredFunctions, not uncovered.
            assert.ok(
                !result.uncovered.includes('helper'),
                `helper should be covered (called from inline #[cfg(test)] mod tests), but got uncovered: [${result.uncovered.join(', ')}]`
            );
            assert.strictEqual(
                result.summary.uncoveredCount, 0,
                'uncoveredCount should be 0 when the only target is covered by an inline test'
            );
            // The lib.rs file (containing the inline #[cfg(test)] mod) should appear in testFiles.
            assert.ok(
                result.testFiles.length > 0,
                `inline test module should produce a test file in results. Got: ${JSON.stringify(result.testFiles)}`
            );
        } finally { rm(dir); }
    });

    it('test helper inside #[cfg(test)] mod (no #[test]) is treated as test code', () => {
        // Functions inside #[cfg(test)] mod blocks that lack a direct #[test]
        // attribute (shared test helpers) should still be classified as test
        // entries — they only compile under cargo test.
        const { getLanguageModule } = require('../languages');
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"',
            'src/lib.rs': `pub fn helper() -> i32 { 1 }

#[cfg(test)]
mod tests {
    pub fn shared_setup() -> i32 {
        helper()
    }

    #[test]
    fn uses_setup() {
        assert_eq!(shared_setup(), 1);
    }
}
`
        });
        try {
            const index = idx(dir);
            const rust = getLanguageModule('rust');
            assert.ok(typeof rust.getEntryPointKind === 'function',
                'rust module must export getEntryPointKind');

            // Find the shared_setup symbol to inspect its modifiers.
            const sharedSyms = index.symbols.get('shared_setup') || [];
            assert.ok(sharedSyms.length > 0, 'shared_setup should be indexed');
            const sym = sharedSyms[0];
            assert.ok(
                (sym.modifiers || []).includes('cfg_test_module'),
                `shared_setup should carry cfg_test_module modifier. Got: ${JSON.stringify(sym.modifiers)}`
            );
            assert.strictEqual(
                rust.getEntryPointKind(sym), 'test',
                'cfg(test) module function should classify as test kind'
            );
        } finally { rm(dir); }
    });
});

describe('BUG-CX/CY: getEntryPointKind distinguishes test from main', () => {
    it('rust: fn main() is kind=main, not kind=test', () => {
        const { getLanguageModule } = require('../languages');
        const rust = getLanguageModule('rust');
        assert.strictEqual(rust.getEntryPointKind({ name: 'main', modifiers: [] }), 'main');
        assert.strictEqual(rust.getEntryPointKind({ name: 'helper', modifiers: ['test'] }), 'test');
        assert.strictEqual(rust.getEntryPointKind({ name: 'helper', modifiers: ['bench'] }), 'test');
        assert.strictEqual(rust.getEntryPointKind({ name: 'helper', modifiers: ['cfg_test_module'] }), 'test');
        assert.strictEqual(rust.getEntryPointKind({ name: 'plain', modifiers: [] }), null);
    });
});

describe('fix #182: turbofish syntax handled by verify', () => {
    const { execute } = require('../core/execute');

    it('verify handles turbofish generic_function AST nodes', () => {
        const dir = tmp({
            'a.rs': 'fn process<F: Fn(i32)>(f: F) { f(1); }\nfn main() { process::<fn(i32)>(|x| {}); }'
        });
        try {
            const i = idx(dir);
            const r = execute(i, 'verify', { name: 'process' });
            assert.ok(r.ok, 'verify should succeed');
            assert.strictEqual(r.result.uncertain, 0, 'turbofish call should not be uncertain');
        } finally { rm(dir); }
    });
});

// ============================================================================
// FEATURE A: CALL-SITE CLASSIFICATION (Rust)
// ============================================================================

describe('Feature A: Rust call-site classification', () => {
    it('Rust: inLoop set for calls inside for/while/loop', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"',
            'src/main.rs': [
                'fn helper(x: i32) -> i32 { x }',
                'fn caller() {',
                '    for i in 0..3 {',
                '        helper(i);',
                '    }',
                '    while true {',
                '        helper(99);',
                '        break;',
                '    }',
                '    helper(0);',  // outside loop
                '}',
                'fn main() { caller(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 3);
            assert.strictEqual(r.patterns.inLoop, 2, 'two of three calls in loop');
        } finally { rm(dir); }
    });

    it('Rust: inTry is always 0 (Result-based, no try)', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"',
            'src/main.rs': [
                'fn helper() -> i32 { 1 }',
                'fn caller() { helper(); }',
                'fn main() { caller(); }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.patterns.inTry, 0, 'Rust has no try — inTry must be 0');
        } finally { rm(dir); }
    });
});

// ============================================================================
// endpoints command — Rust (actix attribute routes)
// ============================================================================

describe('endpoints command (Rust)', () => {
    const FIXTURE = path.join(FIXTURES_PATH, 'endpoints', 'rust');

    it('extracts actix attribute routes (4 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // server.rs:
        //   #[get("/users")] list_users (line 5)
        //   #[post("/users")] create_user (line 8)
        //   #[get("/users/{id}")] get_user (line 11)
        //   #[delete("/users/{id}")] remove_user (line 14)
        assert.strictEqual(result.meta.totalRoutes, 4, 'expected 4 routes');
        assert.strictEqual(result.meta.byFramework.actix, 4);
    });

    it('actix #[get("/users")] resolves to GET /users with handler list_users', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        const r = result.routes.find(r =>
            r.framework === 'actix' && r.method === 'GET' && r.path === '/users');
        assert.ok(r, 'should find #[get("/users")]');
        assert.strictEqual(r.handler, 'list_users');
        assert.strictEqual(r.line, 5);
    });

    it('actix path with {id} placeholder normalizes to /users/*', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        const r = result.routes.find(r =>
            r.framework === 'actix' && r.handler === 'get_user');
        assert.ok(r);
        assert.strictEqual(r.path, '/users/{id}');
        assert.strictEqual(r.normalizedPath, '/users/*');
    });

    it('extracts reqwest client requests (2 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // client.rs: client.get("/users") + client.post("/users")
        // Note: client.get(&url) with format!() is not a string-literal call,
        // so only 2 of 3 are captured.
        assert.strictEqual(result.meta.totalRequests, 2);
        const get = result.requests.find(r => r.callerName === 'fetch_users');
        assert.ok(get, 'should find reqwest GET');
        assert.strictEqual(get.method, 'GET');
        assert.strictEqual(get.path, '/users');
        assert.strictEqual(get.framework, 'reqwest');
    });

    it('--bridge: actix GET /users matches reqwest client.get(/users) as exact', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { bridge: true });
        assert.ok(ok);
        const exact = result.bridges.find(b =>
            b.matchType === 'exact' &&
            b.route.method === 'GET' && b.route.path === '/users');
        assert.ok(exact, 'should bridge actix GET /users to reqwest GET /users');
        assert.strictEqual(exact.confidence, 1);
    });
});

// ============================================================================
// RUST-2: Multi-line method chain line offset
// ============================================================================

describe('Regression RUST-2: chained method call line offset', () => {
    it('each method in chained call reports its own line, not outer expr start', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-2-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'),
                '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n');
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), `
fn parse_env(var: &str) -> Option<usize> {
    Some(var.to_string())
        .and_then(|s| s.parse::<usize>().ok())
        .map(|x| x + 1)
}
`);
            const index = idx(tmpDir);
            const { getCachedCalls } = require('../core/callers');
            const calls = getCachedCalls(index, path.join(tmpDir, 'src', 'main.rs'));
            // Find the and_then call - should be on line 4
            const andThen = calls.find(c => c.name === 'and_then');
            assert.ok(andThen, 'should find and_then call');
            assert.strictEqual(andThen.line, 4,
                `and_then should report line 4, got ${andThen.line}`);
            // Find the map call - should be on line 5
            const mapCall = calls.find(c => c.name === 'map');
            assert.ok(mapCall, 'should find map call');
            assert.strictEqual(mapCall.line, 5,
                `map should report line 5, got ${mapCall.line}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// R3-NEW-3: Rust struct expressions are constructor calls
// ============================================================================

describe('Regression R3-NEW-3: Rust struct expression as constructor', () => {
    it('Foo { x: 1 } struct expression registers as caller of struct Foo', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-r3-new-3-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'),
                '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n');
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), `struct Foo { x: u32 }

fn main() {
    let _ = Foo { x: 1 };
}
`);
            const index = idx(tmpDir);
            const callers = index.findCallers('Foo');
            assert.ok(callers.length >= 1,
                `Should find caller for Foo via Foo { x:1 }; got ${callers.length}`);
            assert.ok(callers.some(c => c.callerName === 'main'),
                `Should include main as caller; got: ${callers.map(c => c.callerName).join(',')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('struct literal with path prefix module::Foo {...} registers as Foo caller', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-rust-r3-new-3b-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'Cargo.toml'),
                '[package]\nname = "test"\nversion = "0.1.0"\nedition = "2021"\n');
            fs.writeFileSync(path.join(tmpDir, 'src', 'main.rs'), `mod inner {
    pub struct Bar { pub x: u32 }
}

fn build() -> inner::Bar {
    inner::Bar { x: 1 }
}
`);
            const index = idx(tmpDir);
            const callers = index.findCallers('Bar');
            assert.ok(callers.length >= 1, 'Should find caller for Bar via inner::Bar {x:1}');
            assert.ok(callers.some(c => c.callerName === 'build'),
                `Should include build as caller; got: ${callers.map(c => c.callerName).join(',')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('export-rename aliases (rust): pub use renames captured in exports', () => {
    const { extractExports } = require('../core/imports');

    it('pub use foo::bar as baz emits a re-export with alias', () => {
        const { exports } = extractExports('pub use foo::bar as baz;\npub fn real() {}', 'rust');
        const rename = exports.find(e => e.alias === 'baz');
        assert.ok(rename, `rename must be captured: ${JSON.stringify(exports)}`);
        assert.strictEqual(rename.name, 'bar');
        assert.strictEqual(rename.type, 're-export');
    });

    it('nested use-list renames are captured; plain re-exports are not emitted', () => {
        const { exports } = extractExports('pub use m::{a as b, c};', 'rust');
        assert.ok(exports.some(e => e.name === 'a' && e.alias === 'b'),
            `nested rename captured: ${JSON.stringify(exports)}`);
        assert.ok(!exports.some(e => e.name === 'c'),
            'plain (un-renamed) pub use entries are intentionally not emitted');
    });
});

describe('fix #201 (rust): calls inside macro bodies are extracted', () => {
    it('assert_eq!/format! arguments produce call candidates', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"',
            'src/lib.rs': [
                'pub fn check(x: i32) -> i32 { x }',
                '',
                'pub fn caller() {',
                '    assert_eq!(check(1), 1);',
                '    let s = format!("{}", check(2));',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'check' });
            assert.ok(r.ok);
            const lines = (r.result.callers || []).map(c => `${c.relativePath}:${c.line}`);
            assert.ok(lines.includes('src/lib.rs:4'), `check inside assert_eq! is a caller: ${lines}`);
            assert.ok(lines.includes('src/lib.rs:5'), `check inside format! is a caller: ${lines}`);
            assert.strictEqual(r.result.meta.account.conserved, true);
            assert.strictEqual((r.result.meta.account.callNotResolved || []).length, 0,
                'no unclaimed call lines');
        } finally { rm(dir); }
    });

    it('macro_rules! transcriber calls are extracted; matcher patterns are not', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"',
            'src/lib.rs': [
                'pub fn emit(s: &str) {}',
                '',
                'macro_rules! say {',
                '    ($($tt:tt)*) => {',
                '        emit(concat!($($tt)*));',
                '    };',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'emit' });
            assert.ok(r.ok);
            const all = [...(r.result.callers || []), ...(r.result.unverifiedCallers || [])]
                .map(c => `${c.relativePath}:${c.line}`);
            assert.ok(all.includes('src/lib.rs:5'),
                `emit in the macro transcriber must be visible: ${all}`);
        } finally { rm(dir); }
    });
});

describe('fix #202: declared-field receivers (Rust)', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
        'hay.rs': `
pub struct Haystack { dent: DirEntry }
impl Haystack {
    pub fn path(&self) -> u8 {
        if self.strip_dot_prefix && self.dent.path().starts_with("./") {
            return self.dent.path().strip_prefix("./").unwrap();
        }
        self.dent.path()
    }
    pub fn is_dir(&self) -> bool {
        self.dent.path().is_dir()
    }
}
`,
        'dent.rs': `
pub struct DirEntry { x: u8 }
impl DirEntry {
    pub fn path(&self) -> u8 { self.x }
}
`,
        'user.rs': `
pub struct Low { sep: Separator }
pub struct Separator { b: u8 }
impl Separator {
    pub fn into_bytes(&self) -> u8 { self.b }
}
pub struct OtherSep { b: u8 }
impl OtherSep {
    pub fn into_bytes(&self) -> u8 { self.b }
}
impl Low {
    pub fn run(&self) -> u8 {
        self.sep.clone().into_bytes()
    }
}
pub struct Holder { flag: Box<dyn Flag> }
pub struct Concrete { y: u8 }
impl Concrete {
    pub fn is_switch(&self) -> bool { true }
}
impl Holder {
    pub fn check(&self) -> bool {
        self.flag.is_switch()
    }
}
`,
    };

    function callersOf(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            excluded: json.meta.account?.excluded,
            conserved: json.meta.account?.conserved,
        };
    }

    it('excludes self.field.method() against an unrelated same-name target', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const hay = callersOf(index, 'hay.rs:3:path');
            assert.ok(!hay.confirmed.some(c => c.startsWith('hay.rs:')),
                `self.dent.path() sites must not confirm Haystack::path: ${hay.confirmed}`);
            assert.ok(hay.excluded.byReason['receiver-type-mismatch'],
                'field-typed receivers excluded with reason');
            assert.strictEqual(hay.conserved, true);
        } finally { rm(dir); }
    });

    it('confirms self.field.method() for the field-typed target', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const dent = callersOf(index, 'dent.rs:3:path');
            for (const line of ['hay.rs:4', 'hay.rs:5', 'hay.rs:7', 'hay.rs:10']) {
                assert.ok(dent.confirmed.includes(line),
                    `${line} (self.dent.path()) must confirm DirEntry::path: ${dent.confirmed}`);
            }
            assert.strictEqual(dent.conserved, true);
        } finally { rm(dir); }
    });

    it('types receivers through .clone() chains (clone returns Self)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const sep = callersOf(index, 'user.rs:4:into_bytes');
            assert.ok(sep.confirmed.includes('user.rs:12'),
                `self.sep.clone().into_bytes() must confirm Separator::into_bytes: ${sep.confirmed}`);
            const other = callersOf(index, 'user.rs:8:into_bytes');
            assert.ok(!other.confirmed.includes('user.rs:12'),
                `clone-chain site must not confirm OtherSep::into_bytes: ${other.confirmed}`);
            assert.strictEqual(other.conserved, true);
        } finally { rm(dir); }
    });

    it('never excludes through Box<dyn Trait> fields (dynamic dispatch)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const concrete = callersOf(index, 'user.rs:18:is_switch');
            assert.ok(concrete.confirmed.includes('user.rs:22'),
                `self.flag.is_switch() through Box<dyn Flag> stays a possible edge: ${concrete.confirmed}`);
        } finally { rm(dir); }
    });
});

describe('fix #202b: same-class resolution respects the pinned target class (Rust)', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
        'a.rs': `pub struct Haystack { x: u8 }
impl Haystack {
    pub fn path(&self) -> u8 { self.x }
}
`,
        'b.rs': `pub struct StandardImpl { y: u8 }
impl StandardImpl {
    fn path(&self) -> u8 { self.y }
    fn write_path_line(&self) -> u8 {
        self.path()
    }
}
`,
    };

    it('self.path() in an unrelated impl is not a caller of the pinned target', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const rA = execute(index, 'context', { name: 'a.rs:3:path' });
            const jsonA = JSON.parse(output.formatContextJson(rA.result));
            const confA = (jsonA.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(!confA.includes('b.rs:5'),
                `StandardImpl-internal self.path() must not confirm Haystack::path: ${confA}`);
            assert.ok(jsonA.meta.account.excluded.byReason['other-definition'],
                'cross-impl self-call excluded with reason');
            assert.strictEqual(jsonA.meta.account.conserved, true);

            const rB = execute(index, 'context', { name: 'b.rs:3:path' });
            const jsonB = JSON.parse(output.formatContextJson(rB.result));
            const confB = (jsonB.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confB.includes('b.rs:5'),
                `self.path() must still confirm its own impl's path: ${confB}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #204: possible-dispatch tiering (Rust)
// ============================================================================

describe('fix #204: possible-dispatch tiering (Rust)', () => {
    const FILES = {
        'lib.rs': `pub trait Haystack {
    fn path(&self) -> String;
}

pub struct FileHaystack {
    name: String,
}

impl Haystack for FileHaystack {
    fn path(&self) -> String {
        self.name.clone()
    }
}

pub struct MemHaystack {}

impl Haystack for MemHaystack {
    fn path(&self) -> String {
        String::from("mem")
    }
}

pub struct Searcher {
    target: Box<dyn Haystack>,
    direct: FileHaystack,
}

impl Searcher {
    pub fn search(&self) -> String {
        self.target.path()
    }
    pub fn search_direct(&self) -> String {
        self.direct.path()
    }
}
`,
    };

    function callersOf(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => ({
                key: `${c.file}:${c.line}`, reason: c.reason,
                dispatchVia: c.dispatchVia, dispatchCandidates: c.dispatchCandidates,
            })),
            conserved: json.meta.account?.conserved,
        };
    }

    it('Box<dyn Trait> field routes to possible-dispatch against a pinned impl', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'lib.rs:10:path');
            assert.ok(!res.confirmed.includes('lib.rs:30'),
                `self.target.path() through dyn Haystack is not evidence for FileHaystack's impl: ${res.confirmed}`);
            const entry = res.unverified.find(u => u.key === 'lib.rs:30');
            assert.ok(entry, `dyn-trait dispatch stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Haystack');
            assert.strictEqual(entry.dispatchCandidates, 2);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('concrete field typed as the pinned impl stays confirmed', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'lib.rs:10:path');
            assert.ok(res.confirmed.includes('lib.rs:33'),
                `self.direct.path() with direct: FileHaystack confirms the impl: ${res.confirmed}`);
        } finally { rm(dir); }
    });

    it('dyn-trait field confirms when the trait declaration itself is pinned', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'lib.rs:2:path');
            assert.ok(res.confirmed.includes('lib.rs:30'),
                `self.target.path() with target: Box<dyn Haystack> references Haystack::path: ${res.confirmed}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #205: arity pruning (Rust — both directions, UFCS self-shift)
// ============================================================================

describe('fix #205: arity pruning (Rust)', () => {
    const FILES = {
        'lib.rs': `pub struct Engine {}

impl Engine {
    pub fn run(&self, input: i32) -> i32 { input }
}

pub fn solo(x: i32) -> i32 { x }

pub fn use_bound(e: Engine) -> i32 {
    e.run(1)
}

pub fn use_ufcs(e: Engine) -> i32 {
    Engine::run(&e, 1)
}

pub fn use_exact() -> i32 {
    solo(7)
}
`,
        // Separate file: no same-file binding for solo, so the arity gate
        // (which binding evidence outranks) is reachable.
        'other.rs': `pub fn use_too_many() -> i32 {
    solo(1, 2, 3)
}
`,
    };

    function callersOf(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            excluded: json.meta.account?.excluded,
            conserved: json.meta.account?.conserved,
        };
    }

    it('bound and UFCS call forms both stay confirmed (self-shift)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'lib.rs:4:run');
            assert.ok(res.confirmed.includes('lib.rs:10'),
                `e.run(1) bound form confirms: ${res.confirmed}`);
            assert.ok(res.confirmed.includes('lib.rs:14'),
                `Engine::run(&e, 1) UFCS form confirms: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('arg count outside any signature range excludes with arity-mismatch', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'lib.rs:7:solo');
            assert.ok(res.confirmed.includes('lib.rs:18'),
                `solo(7) confirms: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('other.rs:2'),
                `solo(1,2,3) cannot bind a 1-param fn: ${res.confirmed}`);
            assert.strictEqual(res.excluded.byReason['arity-mismatch']?.count, 1,
                JSON.stringify(res.excluded.byReason));
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #206: qualified struct expressions keep their path qualifier
// ============================================================================

describe('fix #206: qualified struct expression records receiver (Rust)', () => {
    it('other::Foo { } records receiver, bare Foo { } does not', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "p"\nversion = "0.1.0"\n',
            'src/main.rs': `mod other;

fn main() {
    let a = other::Foo { x: 1 };
    let b = Foo { x: 2 };
}

struct Foo { x: i32 }
`,
            'src/other.rs': 'pub struct Foo { pub x: i32 }\n',
        });
        try {
            const index = idx(dir);
            const { getCachedCalls } = require('../core/callers');
            const calls = [];
            for (const [f] of index.files) {
                for (const c of getCachedCalls(index, f)) {
                    if (c.name === 'Foo' && c.isConstructor) calls.push(c);
                }
            }
            const qualified = calls.find(c => c.line === 4);
            const bare = calls.find(c => c.line === 5);
            assert.ok(qualified, 'qualified struct expression recorded');
            assert.strictEqual(qualified.receiver, 'other',
                `path qualifier kept as receiver: ${JSON.stringify(qualified)}`);
            assert.ok(bare, 'bare struct expression recorded');
            assert.strictEqual(bare.receiver, undefined,
                `bare literal has no receiver: ${JSON.stringify(bare)}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #207: nominal return-type flow (Rust) — variables typed by what the
// assigned call's declared return annotation says, with Result/Option
// unwrapping through `?` / .unwrap() / .expect() and Self resolution.
// ============================================================================

describe('fix #207: nominal return-type flow (Rust)', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
        'src/flags.rs': `pub struct LowArgs { pub n: i32 }

impl LowArgs {
    pub fn special_mode(&self) -> i32 { self.n }
}

pub struct Config { pub v: i32 }

impl Config {
    pub fn make_default() -> Self { Config { v: 0 } }
    pub fn apply_all(&self) -> i32 { self.v }
}

pub fn parse_low_raw(s: &str) -> anyhow::Result<LowArgs> {
    Ok(LowArgs { n: 1 })
}
`,
        'src/main.rs': `mod flags;
use flags::{parse_low_raw, Config};

fn run_try() -> anyhow::Result<()> {
    let args = parse_low_raw("x")?;
    args.special_mode();
    Ok(())
}

fn run_unwrap() {
    let args = parse_low_raw("y").unwrap();
    args.special_mode();
}

fn run_factory() {
    let cfg = Config::make_default();
    cfg.apply_all();
}

fn run_no_unwrap() {
    let res = parse_low_raw("z");
    res.special_mode();
}

fn main() { run_factory(); }
`,
    };

    function contractCallers(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => `${u.file}:${u.line}:${u.reason}`),
            excluded: json.meta.account?.excluded,
            conserved: json.meta.account?.conserved,
        };
    }

    it('`?` assignment unwraps Result and confirms calls on the inner type', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contractCallers(index, 'src/flags.rs:4:special_mode');
            assert.ok(res.confirmed.includes('src/main.rs:6'),
                `let args = parse_low_raw(..)? types args as LowArgs: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('.unwrap() assignment unwraps Result and confirms calls on the inner type', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contractCallers(index, 'src/flags.rs:4:special_mode');
            assert.ok(res.confirmed.includes('src/main.rs:12'),
                `.unwrap() types args as LowArgs: ${res.confirmed}`);
        } finally { rm(dir); }
    });

    it('Self-returning path factory types the variable as the impl type', () => {
        // make_default doesn't match the parser's constructor-name heuristic
        // (new|from|create|...) — only the flow map's Self resolution types cfg.
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contractCallers(index, 'src/flags.rs:11:apply_all');
            assert.ok(res.confirmed.includes('src/main.rs:17'),
                `Config::make_default() -> Self types cfg as Config: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('a non-unwrapped Result assignment never types as the inner value', () => {
        // let res = parse_low_raw(..) — res is a Result, not LowArgs;
        // res.special_mode() must not confirm against LowArgs::special_mode.
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contractCallers(index, 'src/flags.rs:4:special_mode');
            assert.ok(!res.confirmed.includes('src/main.rs:22'),
                `res is Result-typed, not LowArgs: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #208: type-alias receivers — `pub type StyledString = SpannedString<X>`
// is the SAME type (compiler identity). Path calls qualified with the alias
// were excluded as path-type-mismatch (cursive-measured: 24 true
// StyledString::plain edges).
// ============================================================================

describe('fix #208: type-alias receivers (Rust)', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
        'src/lib.rs': `pub mod markup;
pub mod user;
`,
        'src/markup.rs': `pub struct SpannedString<T> { pub v: T }

pub type StyledString = SpannedString<u8>;

impl SpannedString<u8> {
    pub fn plain_text(s: &str) -> Self {
        SpannedString { v: 0 }
    }
}
`,
        'src/user.rs': `use crate::markup::StyledString;

pub fn build_label() {
    let label = StyledString::plain_text("Leaf");
    let _ = label;
}
`,
    };

    it('alias-qualified path call confirms against the aliased type method', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'src/markup.rs:6:plain_text' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const output = require('../core/output');
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('src/user.rs:4'),
                `StyledString::plain_text IS SpannedString::plain_text: ${confirmed} / excluded ${JSON.stringify(json.meta.account.excluded.byReason)}`);
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('parser records aliasOf on type-alias symbols', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const defs = index.symbols.get('StyledString') || [];
            assert.strictEqual(defs.length, 1);
            assert.strictEqual(defs[0].type, 'type');
            assert.strictEqual(defs[0].aliasOf, 'SpannedString');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Receiver-blind bindings (cursive-measured: 9 of 11 method FPs): a method
// call resolves through its RECEIVER, never file scope — a same-file def of
// `map` is not evidence that `parse_hex(v).map(...)` (chained receiver) or
// `self.inner.next()` (generic field) dispatches to it. Such calls route
// through dispatch tiering; self-receiver calls keep confirming.
// ============================================================================

describe('receiver-blind bindings: chained method calls never confirm via name binding (Rust)', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
        'src/lib.rs': 'pub mod color;\npub mod other;\n',
        'src/color.rs': `pub struct Rgb { pub r: u8 }

fn parse_hex(v: &str) -> Option<u8> { v.parse().ok() }

impl Rgb {
    pub fn map(self, f: impl Fn(u8) -> u8) -> Rgb {
        Rgb { r: f(self.r) }
    }
    pub fn brighten(self) -> Rgb {
        self.map(|x| x + 1)
    }
}

pub fn from_hex(v: &str) -> Option<u8> {
    parse_hex(v).map(|x| x * 2)
}
`,
        'src/other.rs': `pub struct Pal { pub v: u8 }

impl Pal {
    pub fn map(self, f: impl Fn(u8) -> u8) -> Pal {
        Pal { v: f(self.v) }
    }
}
`,
    };

    it('chained-receiver call demotes to visible; self call stays confirmed', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'src/color.rs:6:map' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            const output = require('../core/output');
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('src/color.rs:10'),
                `self.map(...) stays confirmed: ${confirmed}`);
            assert.ok(!confirmed.includes('src/color.rs:15'),
                `parse_hex(v).map(...) is Option::map, not Rgb::map: ${confirmed}`);
            const entry = (json.data.unverifiedCallers || [])
                .find(u => u.line === 15);
            assert.ok(entry, `chained call routes VISIBLE, not dropped: ${JSON.stringify(json.data.unverifiedCallers)}`);
            assert.strictEqual(json.meta.account.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #210: external-contract methods (Rust side — `impl ExternalTrait for X`).
// A method defined in a trait impl whose trait is not a project trait
// (std Iterator, Display, ...) with a single project-wide owner: any
// external-typed receiver satisfies the same call, so unique ownership is
// not identity evidence. Receiver-evidence-free calls route possible-
// dispatch via the trait (visible, never excluded).
// ============================================================================

describe('fix #210: external-contract methods (Rust)', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
        'src/lib.rs': `pub mod mine;
pub mod user;
`,
        'src/mine.rs': `pub struct Mine { pub v: u32 }

impl Iterator for Mine {
    type Item = u32;
    fn next(&mut self) -> Option<u32> { None }
}

impl Mine {
    pub fn fresh() -> Mine { Mine { v: 0 } }
    pub fn bump(&self) -> u32 { self.v + 1 }
}
`,
        'src/user.rs': `use crate::mine::Mine;

pub fn drive() -> u32 {
    let _n = Mine::fresh().next();
    Mine::fresh().bump()
}
`,
    };

    function contract(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => ({
                key: `${u.file}:${u.line}`, reason: u.reason,
                dispatchVia: u.dispatchVia, externalContract: u.externalContract,
            })),
            conserved: json.meta.account?.conserved,
        };
    }

    it('trait-impl member symbols carry traitName', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const next = (index.symbols.get('next') || []).find(d => d.className === 'Mine');
            assert.ok(next, 'next indexed as Mine member');
            assert.strictEqual(next.traitImpl, true);
            assert.strictEqual(next.traitName, 'Iterator');
        } finally { rm(dir); }
    });

    it('external-trait method routes chained receiver-blind calls possible-dispatch via the trait', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'src/mine.rs:5:next');
            assert.ok(!res.confirmed.includes('src/user.rs:4'),
                `Mine::fresh().next() could be any Iterator's: ${res.confirmed}`);
            const entry = res.unverified.find(u => u.key === 'src/user.rs:4');
            assert.ok(entry, `chained call stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Iterator');
            assert.strictEqual(entry.externalContract, true);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('inherent-impl single-owner methods keep confirming (control)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'src/mine.rs:10:bump');
            assert.ok(res.confirmed.includes('src/user.rs:5'),
                `bump is Mine's own method — unique ownership stays evidence: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #211: deadcode — trait declarations labeled; explicit member visibility
// ============================================================================

describe('fix #211: deadcode — Rust trait declarations and pub control', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname="t"\nversion="0.1.0"',
        'src/lib.rs': [
            'pub struct Widget {}',
            'impl Widget {',
            '    pub fn shown(&self) {}',
            '    fn hidden_dead(&self) {}',
            '}',
            'trait Render {',
            '    fn draw(&self);',
            '    fn assist(&self) { }',
            '}',
        ].join('\n'),
    };

    it('non-pub method of a pub struct stays claimable (implicitlyPublicMembers=false)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const names = index.deadcode({}).map(d => d.name);
            assert.ok(names.includes('hidden_dead'),
                `Rust member visibility is the member's own pub marker: ${names}`);
            assert.ok(!names.includes('shown'), `pub method is exported: ${names}`);
        } finally { rm(dir); }
    });

    it('required trait methods carry declaredOn; default-bodied ones do not', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            // Trait methods are parsed with the `public` modifier (implicitly
            // public within the trait), so they live in the exported arm.
            const claims = index.deadcode({ includeExported: true });
            const draw = claims.find(d => d.name === 'draw');
            assert.ok(draw, `body-less trait method is reported: ${claims.map(d => d.name)}`);
            assert.deepStrictEqual(draw.declaredOn, { kind: 'trait', name: 'Render' });
            const assist = claims.find(d => d.name === 'assist');
            assert.ok(assist, `default-bodied trait method is reported: ${claims.map(d => d.name)}`);
            assert.strictEqual(assist.declaredOn, undefined,
                'a default body is executable code, not pure contract');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #220 (Rust): literal receivers, sibling-impl overload ambiguity,
// generic-param identity, paren-less member access, dot-call kind discipline,
// path-call type identity (ripgrep/cursive seed-B-measured)
// ============================================================================
describe('fix #220 (Rust): receiver physics and sibling impls', () => {
    function contractCallers(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => `${u.file}:${u.line}:${u.reason}`),
            excluded: json.meta.account?.excluded,
            conserved: json.meta.account?.conserved,
        };
    }

    it('string-literal receivers are str — never a project method', () => {
        // ripgrep: "match:fg:magenta".parse().unwrap() confirmed against the
        // project's parse method via scope evidence.
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/lib.rs': `pub struct Spec;

impl Spec {
    pub fn parse(&self, s: &str) -> usize { s.len() }
}

pub fn check() -> usize {
    let n: usize = "match:fg".parse().unwrap();
    n
}
`,
        });
        try {
            const index = idx(dir);
            const m = contractCallers(index, 'src/lib.rs:4:parse');
            assert.ok(!m.confirmed.includes('src/lib.rs:8'),
                `"...".parse() is str::parse: ${m.confirmed}`);
            assert.strictEqual(m.conserved, true);
        } finally { rm(dir); }
    });

    it('same-type sibling impls route overload-ambiguous (class-level evidence only)', () => {
        // cursive: impl From<Color> for ColorStyle ×4 — ColorStyle::from(x)
        // proves SOME from, never the pinned impl block's.
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/style.rs': `pub struct ColorStyle;
pub struct Color;
pub struct Palette;

impl From<Color> for ColorStyle {
    fn from(c: Color) -> Self { ColorStyle }
}

impl From<Palette> for ColorStyle {
    fn from(p: Palette) -> Self { ColorStyle }
}
`,
            'src/use_site.rs': `use crate::style::{Color, ColorStyle};

pub fn apply(color: Color) -> ColorStyle {
    ColorStyle::from(color)
}
`,
        });
        try {
            const index = idx(dir);
            const m = contractCallers(index, 'src/style.rs:6:from');
            assert.ok(!m.confirmed.includes('src/use_site.rs:4'),
                `sibling impls make the pin ambiguous: ${m.confirmed}`);
            assert.ok(m.unverified.some(u => u === 'src/use_site.rs:4:overload-ambiguous'),
                `routed visible overload-ambiguous: ${JSON.stringify(m.unverified)}`);
            assert.strictEqual(m.conserved, true);
        } finally { rm(dir); }
    });

    it('generic-param field types and blanket-impl class names are not identity', () => {
        // cursive: impl<T: ViewWrapper> View for T records className 'T';
        // LastSizeView's field `view: T` must not "validate" T==T.
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/view.rs': `pub trait Wrapper {
    fn unwrap_it(&self) -> usize;
}

pub trait View {
    fn layout(&mut self, n: usize) {}
}

impl<T: Wrapper> View for T {
    fn layout(&mut self, n: usize) { let _ = n; }
}

pub struct Sized2 {
    pub size: usize,
}

impl View for Sized2 {
    fn layout(&mut self, n: usize) { self.size = n; }
}
`,
            'src/wrap.rs': `pub struct Holder<T> {
    pub view: T,
}

impl<T> Holder<T> {
    pub fn wrap_layout(&mut self, n: usize) {
        self.view.layout(n);
    }
}
`,
        });
        try {
            const index = idx(dir);
            const m = contractCallers(index, 'src/view.rs:10:layout');
            assert.ok(!m.confirmed.includes('src/wrap.rs:7'),
                `generic field hop must not confirm the blanket impl: ${m.confirmed}`);
            assert.ok(m.unverified.some(u => u.startsWith('src/wrap.rs:7:')),
                `routed visible: ${JSON.stringify(m.unverified)}`);
            assert.strictEqual(m.conserved, true);
        } finally { rm(dir); }
    });

    it('paren-less member access is a field, never a method', () => {
        // ripgrep: builder.strip(self.paths.has_implicit_path) — Rust method
        // values are path-only; x.name without parens is always the field.
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/lib.rs': `pub struct Paths {
    pub has_implicit: bool,
}

pub struct Args {
    pub paths: Paths,
}

impl Args {
    pub fn has_implicit(&self) -> bool { self.paths.has_implicit }

    pub fn builder(&self) -> bool {
        strip(self.paths.has_implicit)
    }
}

pub fn strip(b: bool) -> bool { !b }
`,
        });
        try {
            const index = idx(dir);
            const m = contractCallers(index, 'src/lib.rs:10:has_implicit');
            assert.ok(!m.confirmed.includes('src/lib.rs:13'),
                `paren-less access denotes the field: ${m.confirmed}`);
            assert.strictEqual(m.conserved, true);
        } finally { rm(dir); }
    });

    it('a dot-call never binds a standalone function, even with a name binding', () => {
        // ripgrep: .preprocessor_globs(...) confirmed exact-binding against
        // the same-file FUNCTION — Rust needs (s.f)() parens for that.
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/lib.rs': `pub struct Builder;

impl Builder {
    pub fn build(&self) -> usize {
        self.glob_set(3)
    }

    fn glob_set(&self, n: usize) -> usize { n }
}

pub fn glob_other() {
    let b = Builder;
    b.build();
}

pub fn globs(n: usize) -> usize { globs_inner(n) }

fn globs_inner(n: usize) -> usize { n }
`,
            'src/hi.rs': `pub struct HiArgs {
    pub n: usize,
}

impl HiArgs {
    pub fn assemble(&self) -> usize {
        self.globs2(self.n)
    }

    fn globs2(&self, n: usize) -> usize { n }
}

pub fn globs2(n: usize) -> usize { n }
`,
        });
        try {
            const index = idx(dir);
            // pinned FUNCTION globs2 — the dot-call self.globs2(...) can
            // never reach it (method exists; even if it didn't, dot-calls
            // don't bind free functions)
            const fn2 = contractCallers(index, 'src/hi.rs:13:globs2');
            assert.ok(!fn2.confirmed.includes('src/hi.rs:7'),
                `dot-call cannot bind the free function: ${fn2.confirmed}`);
            assert.strictEqual(fn2.conserved, true);
        } finally { rm(dir); }
    });

    it('path-call receivers resolve type identity to the target package', () => {
        // ripgrep: each crate defines its own Config — printer's
        // Config::default() never confirms core's Config.default.
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/core/search.rs': `pub struct Config {
    pub n: usize,
}

impl Config {
    pub fn fresh() -> Config { Config { n: 0 } }
}

pub fn local_use() -> Config {
    Config::fresh()
}
`,
            'src/printer/json.rs': `pub struct Config {
    pub pretty: bool,
}

impl Config {
    pub fn fresh() -> Config { Config { pretty: false } }
}

pub struct JSONBuilder {
    config: Config,
}

impl JSONBuilder {
    pub fn new() -> JSONBuilder {
        JSONBuilder { config: Config::fresh() }
    }
}
`,
        });
        try {
            const index = idx(dir);
            const core = contractCallers(index, 'src/core/search.rs:6:fresh');
            assert.ok(!core.confirmed.includes('src/printer/json.rs:15'),
                `printer's Config is a different type: ${core.confirmed}`);
            assert.ok(core.confirmed.includes('src/core/search.rs:10'),
                `same-file Config::fresh() keeps confirming: ${core.confirmed}`);
            assert.strictEqual(core.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #222 (seed-C): turbofish path receivers + generic-param path calls
// ============================================================================

describe('fix #222: turbofish path receivers carry the type (Rust)', () => {
    function contract(index, handle) {
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => ({ key: `${u.file}:${u.line}`, reason: u.reason })),
            conserved: json.meta.account?.conserved,
        };
    }

    it('Vec::<T>::new() inside assert_eq! never confirms a project new', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/lowargs.rs': [
                'pub struct LowArgs { n: usize }',
                'impl LowArgs {',
                '    pub fn new() -> LowArgs { LowArgs { n: 0 } }',
                '}',
            ].join('\n'),
            'src/defs.rs': [
                'pub fn check(args: &[String]) {',
                '    assert_eq!(Vec::<String>::new(), args);',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const res = contract(index, 'src/lowargs.rs:3:new');
            assert.ok(!res.confirmed.includes('src/defs.rs:2'),
                `Vec::<String>::new() is std's new, not LowArgs::new: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('AST-branch turbofish receiver is the plain type name', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/lib.rs': [
                'pub struct Maker { n: usize }',
                'impl Maker {',
                '    pub fn make() -> Maker { Maker { n: 0 } }',
                '}',
                'pub fn go() -> Maker {',
                '    Maker::make()',
                '}',
                'pub fn other() {',
                '    let v = Vec::<u8>::new();',
                '    let _ = v;',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // type-qualified receiver on the true target still confirms
            const res = contract(index, 'src/lib.rs:3:make');
            assert.ok(res.confirmed.includes('src/lib.rs:6'),
                `Maker::make() stays confirmed: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('T::method() on a generic param routes visible, never scope-confirms', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/vec2.rs': [
                'pub struct XY<T> { pub x: T, pub y: T }',
                'impl<T: Default> XY<T> {',
                '    pub fn zero() -> XY<T> { XY { x: T::default(), y: T::default() } }',
                '    pub fn keep_x(&self) -> XY<T> where T: Clone {',
                '        XY { x: self.x.clone(), y: T::zero_val() }',
                '    }',
                '    pub fn zero_val() -> T { T::default() }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const res = contract(index, 'src/vec2.rs:7:zero_val');
            assert.ok(!res.confirmed.includes('src/vec2.rs:5'),
                `T::zero_val() is the generic param's, not provably XY's: ${res.confirmed}`);
            const entry = res.unverified.find(u => u.key === 'src/vec2.rs:5');
            assert.ok(entry, `the edge stays VISIBLE: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #222b: use-as import renames keep type-qualified calls confirmable', () => {
    it('Separator::disabled() under `use ContextSeparator as Separator` stays visible-or-confirmed', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/lowargs.rs': [
                'pub struct ContextSeparator(Option<u8>);',
                'impl ContextSeparator {',
                '    pub fn disabled() -> ContextSeparator { ContextSeparator(None) }',
                '}',
            ].join('\n'),
            'src/defs.rs': [
                'pub fn update() {',
                '    use crate::lowargs::ContextSeparator as Separator;',
                '    let _a = Separator::disabled();',
                '}',
            ].join('\n'),
            'src/lib.rs': 'pub mod lowargs;\npub mod defs;\n',
        });
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'src/lowargs.rs:3:disabled' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            const unverified = (json.data.unverifiedCallers || []).map(u => `${u.file}:${u.line}`);
            assert.ok(confirmed.includes('src/defs.rs:3') || unverified.includes('src/defs.rs:3'),
                `the renamed type-qualified call is a true edge — never excluded: ` +
                `confirmed=${confirmed} unverified=${unverified}`);
            assert.strictEqual(json.meta.account?.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #223: receiver-qualified same-name calls resolve to the named type's
// binding instead of fanning out to every same-name def (callee-arm-measured:
// ripgrep's HiArgs::from_low_args calls Patterns::/Paths::/BinaryDetection::
// from_low_args — each def was claimed at all three sites).
// ============================================================================

describe('fix #223: type-qualified same-name callee resolves per type', () => {
    it('A::build calling B::build and C::build does not spray defs across sites', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\n',
            'src/lib.rs': [
                'pub struct A;',                                  // 1
                'pub struct B;',                                  // 2
                'pub struct C;',                                  // 3
                'impl B { pub fn build(_n: u32) -> B { B } }',    // 4
                'impl C { pub fn build(_n: u32) -> C { C } }',    // 5
                'impl A {',                                       // 6
                '    pub fn build(n: u32) -> A {',                // 7
                '        let _b = B::build(n);',                  // 8
                '        let _c = C::build(n);',                  // 9
                '        A',                                      // 10
                '    }',                                          // 11
                '}',                                              // 12
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const aBuild = (index.symbols.get('build') || []).find(d => d.className === 'A');
            assert.ok(aBuild, 'A::build indexed');
            const callees = index.findCallees(aBuild, { includeMethods: true, collectAccount: true });
            const buildEdges = callees.filter(c => c.name === 'build');
            const bEdge = buildEdges.find(e => e.className === 'B');
            const cEdge = buildEdges.find(e => e.className === 'C');
            assert.ok(bEdge && cEdge, 'both typed callees present: ' + JSON.stringify(buildEdges.map(e => e.className)));
            assert.deepStrictEqual(bEdge.sites, [8], 'B::build claims only its own site');
            assert.deepStrictEqual(cEdge.sites, [9], 'C::build claims only its own site');
            assert.ok(callees.calleeAccount.conserved, 'account conserved');
        } finally { rm(dir); }
    });
});

describe('fix #232 (Rust): Self:: path calls resolve same-class, never path-type-mismatch', () => {
    // Campaign G1-rust BUG-1: `Self::new()` inside an impl was excluded
    // path-type-mismatch whenever `new` had several project-wide defs — the
    // multi-def path filter lacked the #222(2) Self exemption. Self IS the
    // enclosing impl's type: same-class resolution confirms it for the impl's
    // class and excludes it for a pinned sibling (#202b).
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': `pub struct Foo;

impl Foo {
    pub fn new() -> Self {
        Foo
    }
}

impl Default for Foo {
    fn default() -> Self {
        Self::new()
    }
}

pub struct Bar;

impl Bar {
    pub fn new() -> Self {
        Bar
    }
}
`,
    };

    it('confirms Self::new() for the enclosing impl class despite a same-name sibling', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'new', className: 'Foo' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            assert.ok(r.result.callers.some(c => c.line === 11 && c.callerName === 'default'),
                'Self::new() inside impl Default for Foo must be a confirmed caller of Foo::new');
        } finally { rm(dir); }
    });

    it('excludes Self::new() for a pinned sibling class with reason other-definition', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'new', className: 'Bar' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.callers.length, 0, 'Bar::new has no callers');
            assert.ok(!(r.result.unverifiedCallers || []).some(u => u.line === 11),
                'the Foo Self-call must not be unverified for Bar::new');
            const excl = r.result.meta?.account?.excluded?.byReason || {};
            assert.ok((excl['other-definition']?.count || excl['other-definition'] || 0) >= 1,
                `Self::new must be excluded other-definition for Bar: ${JSON.stringify(excl)}`);
        } finally { rm(dir); }
    });
});

describe('fix #234 (Rust): usages classifies Type::method() path calls', () => {
    // Campaign G2-rust BUG-1: the enum-variant filter swallowed sites the
    // scoped-call branch had already classified as CALLS — usages reported
    // '0 calls' for every path-qualified invocation of a live function.
    it('counts path-qualified calls and keeps enum-variant refs filtered', () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': `pub struct Svc;

impl Svc {
    pub fn with_defaults() -> Self {
        Svc
    }
}

pub enum Boundary {
    Grid,
}

pub struct Grid;

pub fn make() -> Svc {
    Svc::with_defaults()
}

pub fn pick() -> Boundary {
    Boundary::Grid
}
`,
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'usages', { name: 'with_defaults' });
            assert.ok(r.ok);
            const call = r.result.find(u => u.line === 16 && !u.isDefinition);
            assert.ok(call, 'Svc::with_defaults() call site present');
            assert.strictEqual(call.usageType, 'call');
            // counter-probe: Boundary::Grid must stay filtered for struct Grid
            const g = execute(index, 'usages', { name: 'Grid' });
            assert.ok(g.ok);
            assert.ok(!g.result.some(u => u.line === 20 && !u.isDefinition),
                'enum variant reference must stay filtered from struct usages');
        } finally { rm(dir); }
    });
});

describe('fix #236 (Rust): callee-side path-receiver identity', () => {
    // Campaign G1-rust BUG-2/BUG-3: builtin path calls (String::new(),
    // Arc::new(Mutex::new(Vec::new()))) CONFIRMED callee edges to arbitrary
    // same-named project methods through bare name bindings — including
    // fan-out double-claims (one site in two defs' sites[]) and self-
    // recursion edges — while findCallers excluded the identical edges as
    // path-type-mismatch. The receiver NAMES the type; the type owns the call.
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': `pub struct Task;

impl Task {
    pub fn new() -> Self {
        Task
    }
}

pub struct TaskProcessor;

impl TaskProcessor {
    pub fn new() -> Self {
        TaskProcessor
    }
}

pub struct TaskManager;

impl TaskManager {
    pub fn new() -> i32 {
        let _x = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        0
    }
}

pub fn make_string() -> String {
    String::new()
}

pub fn make_task() -> Task {
    crate::Task::new()
}
`,
    };

    it('routes builtin path calls external — never a project callee edge', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('make_string')[0];
            const legacy = index.findCallees(def);
            assert.strictEqual(legacy.length, 0,
                `String::new() must not confirm a project new: ${JSON.stringify(legacy.map(c => c.className))}`);
            const acct = index.findCallees(def, { collectAccount: true });
            assert.strictEqual(acct.length, 0);
            assert.strictEqual(acct.calleeAccount.external.count, 1,
                'String::new() lands in the external bucket');
            assert.ok(acct.calleeAccount.conserved);
        } finally { rm(dir); }
    });

    it('never fans one builtin path site out across same-name project defs', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('new').find(s => s.className === 'TaskManager');
            const acct = index.findCallees(def, { collectAccount: true });
            assert.strictEqual(acct.filter(c => c.name === 'new').length, 0,
                `Arc/Mutex/Vec ::new must not claim Task.new/TaskProcessor.new: ${JSON.stringify(acct.map(c => c.className))}`);
            assert.strictEqual(acct.calleeAccount.external.count, 3,
                'all three builtin path calls route external');
            assert.ok(acct.calleeAccount.conserved);
        } finally { rm(dir); }
    });

    it('counter-probe: project-type path calls still confirm, crate:: qualifier included', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('make_task')[0];
            const acct = index.findCallees(def, { collectAccount: true });
            assert.ok(acct.some(c => c.name === 'new' && c.className === 'Task'),
                `crate::Task::new() must confirm Task::new: ${JSON.stringify(acct.map(c => c.className))}`);
            const legacy = index.findCallees(def);
            assert.ok(legacy.some(c => c.name === 'new' && c.className === 'Task'),
                'legacy mode confirms the same edge');
        } finally { rm(dir); }
    });
});

describe('fix #236 (Rust): Self:: callees, alias closure, generic-param receivers', () => {
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': `pub struct Widget;

impl Widget {
    pub fn build() -> i32 {
        Self::helper()
    }
    pub fn helper() -> i32 {
        2
    }
}

pub struct Other;

impl Other {
    pub fn helper() -> i32 {
        3
    }
}

pub type Gadget = Widget;

pub fn use_alias() -> i32 {
    Gadget::helper()
}

pub fn generic_call<T: Default>() -> T {
    T::default()
}
`,
    };

    it('Self::method() resolves to the enclosing impl, not a sibling', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('build')[0];
            const acct = index.findCallees(def, { collectAccount: true });
            const helpers = acct.filter(c => c.name === 'helper');
            assert.strictEqual(helpers.length, 1);
            assert.strictEqual(helpers[0].className, 'Widget',
                `Self::helper() inside Widget must be Widget::helper: ${JSON.stringify(helpers)}`);
        } finally { rm(dir); }
    });

    it('alias-qualified path calls confirm through the base type (#208)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('use_alias')[0];
            const acct = index.findCallees(def, { collectAccount: true });
            assert.ok(acct.some(c => c.name === 'helper' && c.className === 'Widget'),
                `Gadget::helper() must confirm Widget::helper: ${JSON.stringify(acct.map(c => c.className))}`);
        } finally { rm(dir); }
    });

    it('generic-param path receivers route visible method-ambiguous, never confirm or vanish', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('generic_call')[0];
            const acct = index.findCallees(def, { collectAccount: true });
            assert.strictEqual(acct.length, 0, 'T::default() must not confirm any project def');
            assert.ok((acct.unverifiedCallees || []).some(u =>
                u.name === 'default' && u.reason === 'method-ambiguous'),
                `T::default() must be visible unverified: ${JSON.stringify(acct.unverifiedCallees)}`);
            assert.ok(acct.calleeAccount.conserved);
        } finally { rm(dir); }
    });
});

describe('fix #237 (Rust): same-name fan-out needs receiver evidence', () => {
    // Campaign G1-rust BUG-7: CacheService.get's `cache.get(key)` (untyped
    // MutexGuard receiver) hit the same-name fan-out and sprayed a confirmed
    // callee edge onto ApiClient.get — reachability credit then leaked from
    // CacheService.get's test callers onto ApiClient.get while its sibling
    // methods stayed unreachable. Name-equality with the enclosing def is
    // not receiver evidence.
    const FILES = {
        'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
        'src/lib.rs': `use std::collections::HashMap;

pub struct CacheService {
    cache: HashMap<String, i32>,
}

impl CacheService {
    pub fn get(&self, key: &str) -> Option<i32> {
        let cache = &self.cache;
        cache.get(key).copied()
    }
}

pub struct ApiClient;

impl ApiClient {
    pub fn get(&self) -> i32 {
        1
    }
}
`,
    };

    it('untyped-receiver same-name call never sprays onto sibling classes', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('get').find(s => s.className === 'CacheService');
            const acct = index.findCallees(def, { collectAccount: true });
            assert.ok(!acct.some(c => c.className === 'ApiClient'),
                `cache.get() must not confirm ApiClient.get: ${JSON.stringify(acct.map(c => c.className))}`);
            const legacy = index.findCallees(def);
            assert.ok(!legacy.some(c => c.className === 'ApiClient'), 'legacy mode agrees');
            assert.ok((acct.unverifiedCallees || []).some(u => u.name === 'get'),
                `the call stays visible unverified: ${JSON.stringify(acct.unverifiedCallees)}`);
            assert.ok(acct.calleeAccount.conserved);
        } finally { rm(dir); }
    });
});

describe('fix #238 (Rust): zero-param functions record empty params, not the unknown sentinel', () => {
    it("params is '' for fn run() {}", () => {
        const dir = tmp({
            'Cargo.toml': '[package]\nname = "t"\nversion = "0.1.0"\nedition = "2021"\n',
            'src/lib.rs': 'pub fn run() {\n}\n\npub fn with_args(x: i32) -> i32 {\n    x\n}\n',
        });
        try {
            const index = idx(dir);
            const run = index.symbols.get('run')[0];
            assert.strictEqual(run.params, '', `zero-param → '' (got ${JSON.stringify(run.params)})`);
            const withArgs = index.symbols.get('with_args')[0];
            assert.strictEqual(withArgs.params, 'x: i32');
        } finally { rm(dir); }
    });
});
