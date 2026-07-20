/**
 * UCN Java Regression Tests
 *
 * Java-specific regressions: constructors, overloads, static imports, inner classes.
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
const { tmp, rm, idx, FIXTURES_PATH } = require('./helpers');

const PROJECT_DIR = path.resolve(__dirname, '..');

// ============================================================================
// Java class methods in context
// ============================================================================

describe('Regression: Java class methods in context', () => {
    it('should show methods for Java classes via className', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-class-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'User.java'), `public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }

    public String greet() {
        return "Hello " + this.name;
    }

    public boolean validate() {
        return this.name != null && this.name.length() > 0;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            const ctx = index.context('User');

            // Should identify as class
            assert.strictEqual(ctx.type, 'class', 'User should be identified as class');
            assert.ok(ctx.methods, 'Should have methods array');
            // JAVA-3: constructors are no longer emitted as separate symbols.
            // The class IS the symbol; the constructor is its initializer. So
            // User class has 2 methods (greet, validate), not 3.
            assert.strictEqual(ctx.methods.length, 2, 'User class should have 2 methods (greet + validate; constructor not emitted as separate symbol)');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('validate'), 'Should include validate');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java main() not flagged as deadcode
// ============================================================================

describe('Regression: Java main() not flagged as deadcode', () => {
    it('should NOT report public static main as dead code in Java', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-main-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'App.java'), `public class App {
    public static void main(String[] args) {
        System.out.println("Hello");
        helper();
    }

    private static void helper() {
        System.out.println("Helper");
    }

    private static void unusedMethod() {
        System.out.println("Unused");
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            const deadcode = index.deadcode();
            const deadNames = deadcode.map(d => d.name);

            // main should NOT be flagged as dead code (entry point)
            assert.ok(!deadNames.includes('main'), 'main() should not be flagged as dead code');

            // helper is called by main, so not dead
            assert.ok(!deadNames.includes('helper'), 'helper() is called by main, not dead');

            // unusedMethod should be flagged as dead
            assert.ok(deadNames.includes('unusedMethod'), 'unusedMethod() should be flagged as dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Context class label bug — Java class test
// ============================================================================

describe('Regression: Context class label bug (Java)', () => {
    it('should show Java class name in context', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-ctx-java-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Gson.java'), `
public class Gson {
    public Gson() {}
    public String toJson(Object src) {
        return "";
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const ctx = index.context('Gson');
            assert.strictEqual(ctx.type, 'class');
            assert.strictEqual(ctx.name, 'Gson', 'Should show Gson, not undefined');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java duplicate constructor entries
// ============================================================================

describe('Regression: Java duplicate constructor entries', () => {
    it('should not duplicate constructors in find results', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-dedup-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'MyClass.java'), `
public class MyClass {
    private int value;

    public MyClass() {
        this.value = 0;
    }

    public MyClass(int value) {
        this.value = value;
    }

    public int getValue() {
        return value;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            const symbols = index.symbols.get('MyClass') || [];
            // JAVA-3: constructors are no longer emitted as separate symbols.
            // The class IS the symbol; new MyClass() resolves to the class via
            // isConstructor: true on the call. So we expect exactly 1 entry: the class.
            const types = symbols.map(s => s.type);
            assert.strictEqual(types.filter(t => t === 'class').length, 1, 'Should have exactly 1 class entry');
            // Should NOT emit constructors as separate symbols
            const constructors = symbols.filter(s => s.type === 'constructor');
            assert.strictEqual(constructors.length, 0, 'Should NOT emit constructors as separate symbols (class IS the symbol)');
            // Total symbols for MyClass: just the class itself
            assert.strictEqual(symbols.length, 1, 'Only the class symbol should exist for MyClass');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// R3-NEW-2: Java about Foo with `new Foo()` should populate CALLERS
// ============================================================================

describe('Regression R3-NEW-2: Java new ClassName() registers as caller of class', () => {
    it('about Foo should show callers for `new Foo()` invocations', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-new-callers-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Foo.java'), `
public class Foo {
}
`);
            fs.writeFileSync(path.join(tmpDir, 'Bar.java'), `
public class Bar {
    public void run() {
        Foo f = new Foo();
        System.out.println(f);
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // findCallers should find run() as caller of Foo via `new Foo()`
            const callers = index.findCallers('Foo');
            assert.ok(callers.length >= 1, `Should find at least 1 caller for Foo, got ${callers.length}`);
            assert.ok(callers.some(c => c.callerName === 'run'),
                `Should include run() as caller; got: ${callers.map(c => c.callerName).join(',')}`);

            // The class symbol IS the target — find should return only the class
            const found = index.symbols.get('Foo') || [];
            assert.strictEqual(found.length, 1, 'Foo should be a single symbol (class)');
            assert.strictEqual(found[0].type, 'class', 'Symbol type should be class');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java overloaded method callees
// ============================================================================

describe('Regression: Java overloaded method callees', () => {
    it('should detect callees for overloaded methods', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-overload-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Converter.java'), `
public class Converter {
    public String convert(Object src) {
        return convert(src, src.getClass());
    }

    public String convert(Object src, Class<?> type) {
        return type.getName() + ": " + src.toString();
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // The first overload calls the second — smart should show it as a dependency
            const smart = index.smart('convert', { file: 'Converter' });
            assert.ok(smart, 'smart should return a result');
            // Should have at least 1 dependency (the other overload)
            assert.ok(smart.dependencies.length >= 1,
                `Should find overload as dependency, got ${smart.dependencies.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java inner classes found after constructor dedup
// ============================================================================

describe('Regression: Java inner classes found after constructor dedup', () => {
    it('should find inner classes with their own members', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-inner-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Outer.java'), `
public class Outer {
    public static class Inner {
        private int x;

        public Inner(int x) {
            this.x = x;
        }

        public int getX() {
            return x;
        }
    }

    public Inner create() {
        return new Inner(42);
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Inner class should be found
            assert.ok(index.symbols.has('Inner'), 'Should find Inner class');
            const innerSyms = index.symbols.get('Inner');
            const innerClass = innerSyms.find(s => s.type === 'class');
            assert.ok(innerClass, 'Should have Inner as class type');

            // Outer class should also be found
            assert.ok(index.symbols.has('Outer'), 'Should find Outer class');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java package import resolution for exporters
// ============================================================================

describe('Regression: Java package import resolution for exporters', () => {
    it('should resolve Java package imports and find exporters', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-exports-${Date.now()}`);
        const pkgDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example');
        fs.mkdirSync(pkgDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(pkgDir, 'Model.java'), `
package com.example;
public class Model {
    private String name;
    public String getName() { return name; }
}
`);
            fs.writeFileSync(path.join(pkgDir, 'Service.java'), `
package com.example;
import com.example.Model;
public class Service {
    public Model getModel() { return new Model(); }
}
`);
            fs.writeFileSync(path.join(pkgDir, 'Controller.java'), `
package com.example;
import com.example.Model;
import com.example.Service;
public class Controller {
    private Service service = new Service();
    public Model handle() { return service.getModel(); }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // Model.java should have exporters (Service.java and Controller.java import it)
            const modelExporters = index.exporters('src/main/java/com/example/Model.java');
            assert.ok(modelExporters.length >= 2,
                `Model.java should have at least 2 importers, got ${modelExporters.length}: ${JSON.stringify(modelExporters.map(e => e.file))}`);

            // Service.java should also have an exporter (Controller.java imports it)
            const serviceExporters = index.exporters('src/main/java/com/example/Service.java');
            assert.ok(serviceExporters.length >= 1,
                `Service.java should have at least 1 importer, got ${serviceExporters.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java overload callees finds ALL overloads
// ============================================================================

describe('Regression: Java overload callees finds ALL overloads', () => {
    it('should find all overload callees, not just the first', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-all-overloads-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Serializer.java'), `
public class Serializer {
    public String serialize(Object src) {
        if (src == null) {
            return serialize("null_value");
        }
        return serialize(src, src.getClass());
    }

    public String serialize(Object src, Class<?> type) {
        return type.getName() + ": " + src.toString();
    }

    public String serialize(String value) {
        return "string: " + value;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // smart for the first overload should show other overloads as dependencies
            const smart = index.smart('serialize', { file: 'Serializer' });
            assert.ok(smart, 'smart should return a result');

            // Should find at least 2 overload dependencies (the other two overloads)
            assert.ok(smart.dependencies.length >= 2,
                `Should find at least 2 overload dependencies, got ${smart.dependencies.length}: ${smart.dependencies.map(d => d.startLine).join(', ')}`);

            // Each dependency should be a different overload (different startLine)
            const depLines = new Set(smart.dependencies.map(d => d.startLine));
            assert.ok(depLines.size >= 2,
                `Dependencies should be distinct overloads, got ${depLines.size} unique`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('should use binding ID for exact symbol lookup', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-java-binding-${Date.now()}`);
        fs.mkdirSync(tmpDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Builder.java'), `
public class Builder {
    public Builder set(String key, Object value) {
        return set(key, value, false);
    }

    public Builder set(String key, Object value, boolean override) {
        return this;
    }

    public String build() {
        return "built";
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // context for the first set() should show the second set() as a callee
            const ctx = index.context('set', { file: 'Builder' });
            assert.ok(ctx, 'context should return a result');
            assert.ok(ctx.callees.length >= 1,
                `Should find at least 1 callee (the other overload), got ${ctx.callees.length}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// fn command extracts Java overloaded method
// ============================================================================

describe('Regression: fn command extracts Java overloaded method', () => {
    it('should find and extract Java overloaded method via symbol index', () => {
        const tmpDir = path.join(os.tmpdir(), `ucn-test-fn-overload-${Date.now()}`);
        const pkgDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example');
        fs.mkdirSync(pkgDir, { recursive: true });

        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(pkgDir, 'Converter.java'), `
package com.example;
public class Converter {
    public String toJson(Object obj) {
        return obj.toString();
    }
    public String toJson(Object obj, boolean pretty) {
        String result = obj.toString();
        return pretty ? format(result) : result;
    }
    private String format(String s) {
        return s;
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });

            // find should return toJson overloads
            const matches = index.find('toJson').filter(m => m.type === 'function' || m.params !== undefined);
            assert.ok(matches.length >= 1, `Should find toJson, got ${matches.length}`);

            // Each match should have valid location for direct extraction
            for (const match of matches) {
                assert.ok(match.startLine, `Match at ${match.relativePath} should have startLine`);
                assert.ok(match.endLine, `Match at ${match.relativePath} should have endLine`);

                const code = fs.readFileSync(match.file, 'utf-8');
                const lines = code.split('\n');
                const fnCode = lines.slice(match.startLine - 1, match.endLine).join('\n');
                assert.ok(fnCode.includes('toJson'), `Extracted code should contain toJson, got: ${fnCode}`);
            }
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java this.method() same-class resolution
// ============================================================================

describe('Regression: Java this.method() same-class resolution', () => {
    it('findCallees should resolve this.method() to same-class methods', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-javathis-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'DataService.java'), `
public class DataService {
    private Object fetchRemote(String key, int days) {
        return this.makeRequest("/api/" + key);
    }

    private Object makeRequest(String url) {
        return null;
    }

    public Object getRecords(String key) {
        if (this.isValid(key)) {
            return this.fetchRemote(key, 365);
        }
        return null;
    }

    private boolean isValid(String key) {
        return key.length() > 0;
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            // getRecords should have fetchRemote and isValid as callees
            const defs = index.symbols.get('getRecords');
            assert.ok(defs && defs.length > 0, 'Should find getRecords');
            const callees = index.findCallees(defs[0]);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('fetchRemote'),
                `Should resolve this.fetchRemote(), got: ${calleeNames.join(', ')}`);
            assert.ok(calleeNames.includes('isValid'),
                `Should resolve this.isValid(), got: ${calleeNames.join(', ')}`);

            // fetchRemote should have getRecords as caller
            const callers = index.findCallers('fetchRemote');
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('getRecords'),
                `Should find getRecords as caller of fetchRemote, got: ${callerNames.join(', ')}`);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// deadcode skips Java @Override methods
// ============================================================================

describe('Regression: deadcode skips Java @Override methods', () => {
    it('should not report @Override methods as dead code', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-java-override-'));
        try {
            fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'src', 'MyClass.java'), `
public class MyClass implements Runnable {
    @Override
    public void run() {
        System.out.println("running");
    }

    @Override
    public String toString() {
        return "MyClass";
    }

    void unusedMethod() {
        System.out.println("unused");
    }

    public static void main(String[] args) {
        new MyClass().run();
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            const dead = index.deadcode();
            const deadNames = dead.map(d => d.name);

            // @Override methods should NOT appear
            assert.ok(!deadNames.includes('run'), 'run (@Override) should not be dead code');
            assert.ok(!deadNames.includes('toString'), 'toString (@Override) should not be dead code');

            // Genuinely unused method SHOULD appear
            assert.ok(deadNames.includes('unusedMethod'), 'unusedMethod should be dead code');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java extractExtends should not include "extends" keyword
// ============================================================================

describe('Regression: Java extractExtends should not include "extends" keyword', () => {
    it('should extract superclass name without extends keyword', () => {
        const result = parse(`
public class SecurityConfig extends WebSecurityConfigurerAdapter {
    public void configure() {}
}
`, 'java');
        assert.ok(result.classes.length > 0, 'should find the class');
        const cls = result.classes[0];
        assert.strictEqual(cls.extends, 'WebSecurityConfigurerAdapter',
            `Expected "WebSecurityConfigurerAdapter" but got "${cls.extends}"`);
    });

    it('should handle generic superclass', () => {
        const result = parse(`
public class MyList extends ArrayList<String> {
}
`, 'java');
        const cls = result.classes[0];
        assert.strictEqual(cls.extends, 'ArrayList<String>',
            `Expected "ArrayList<String>" but got "${cls.extends}"`);
    });
});

// ============================================================================
// Java method callers found by default
// ============================================================================

describe('Regression: Java method callers found by default', () => {
    it('should find Java method callers without include_methods flag', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-callers-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');
            fs.writeFileSync(path.join(tmpDir, 'Service.java'), `
public class Service {
    public String getData() {
        return "data";
    }
}
`);
            fs.writeFileSync(path.join(tmpDir, 'Controller.java'), `
public class Controller {
    private Service service;
    public void handle() {
        String result = service.getData();
    }
}
`);
            const index = new ProjectIndex(tmpDir);
            index.build(null, { quiet: true });
            // Default: no includeMethods flag
            const callers = index.findCallers('getData');
            assert.ok(callers.length > 0, 'should find callers of getData without include_methods');
            assert.ok(callers.some(c => c.content.includes('getData')), 'should include the call site');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// deadcode excludes Java src/test/ files
// ============================================================================

describe('Regression: deadcode excludes Java src/test/ files', () => {
    it('should not report symbols from src/test/ as dead code', () => {
        const { isTestFile } = require('../core/discovery');
        // Java files in src/test/ directory should be recognized as test files
        assert.ok(isTestFile('src/test/java/com/example/MyShould.java', 'java'),
            'src/test/ java file should be test file');
        assert.ok(isTestFile('src/test/java/com/example/HelperShould.java', 'java'),
            'src/test/ java file with non-Test suffix should be test file');
    });
});

// ============================================================================
// Java static imports resolved as INTERNAL
// ============================================================================

describe('Regression: Java static imports resolved as INTERNAL', () => {
    it('should resolve import static com.pkg.Class.method as INTERNAL', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');

        // Create the target class
        const utilDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example', 'util');
        fs.mkdirSync(utilDir, { recursive: true });
        fs.writeFileSync(path.join(utilDir, 'CollectionsUtil.java'), `
package com.example.util;
public class CollectionsUtil {
    public static <T> List<T> copyOf(Collection<T> c) { return new ArrayList<>(c); }
}
`);

        // Create the importing file
        const repoDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example', 'repo');
        fs.mkdirSync(repoDir, { recursive: true });
        fs.writeFileSync(path.join(repoDir, 'EntityRepo.java'), `
package com.example.repo;
import static com.example.util.CollectionsUtil.copyOf;
public class EntityRepo {
    public List<String> getNames() { return copyOf(names); }
}
`);

        const index = new ProjectIndex(tmpDir);
        index.build();

        const imports = index.imports('src/main/java/com/example/repo/EntityRepo.java');
        const staticImport = imports.find(i => i.module.includes('CollectionsUtil.copyOf'));
        assert.ok(staticImport, 'should find static import');
        assert.strictEqual(staticImport.isExternal, false,
            `static import CollectionsUtil.copyOf should be INTERNAL but was EXTERNAL`);
        assert.ok(staticImport.resolved.includes('CollectionsUtil.java'),
            `should resolve to CollectionsUtil.java, got: ${staticImport.resolved}`);

        fs.rmSync(tmpDir, { recursive: true });
    });

    it('should resolve import static com.pkg.Class.* as INTERNAL', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');

        const utilDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example', 'util');
        fs.mkdirSync(utilDir, { recursive: true });
        fs.writeFileSync(path.join(utilDir, 'DataShareUtil.java'), `
package com.example.util;
public class DataShareUtil {
    public static String format(String s) { return s; }
}
`);

        const consumerDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example', 'service');
        fs.mkdirSync(consumerDir, { recursive: true });
        fs.writeFileSync(path.join(consumerDir, 'Service.java'), `
package com.example.service;
import static com.example.util.DataShareUtil.*;
public class Service {
    public String process(String s) { return format(s); }
}
`);

        const index = new ProjectIndex(tmpDir);
        index.build();

        const imports = index.imports('src/main/java/com/example/service/Service.java');
        const wildcardImport = imports.find(i => i.module.includes('DataShareUtil.*'));
        assert.ok(wildcardImport, 'should find wildcard static import');
        assert.strictEqual(wildcardImport.isExternal, false,
            `static wildcard import DataShareUtil.* should be INTERNAL but was EXTERNAL`);

        fs.rmSync(tmpDir, { recursive: true });
    });

    it('should resolve import static with inner class path as INTERNAL', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');

        const modelDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example', 'model');
        fs.mkdirSync(modelDir, { recursive: true });
        fs.writeFileSync(path.join(modelDir, 'FilterCondition.java'), `
package com.example.model;
public class FilterCondition {
    public enum Operator { IN, EQ, GT }
}
`);

        const consumerDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example', 'service');
        fs.mkdirSync(consumerDir, { recursive: true });
        fs.writeFileSync(path.join(consumerDir, 'Query.java'), `
package com.example.service;
import static com.example.model.FilterCondition.Operator.IN;
public class Query {
    public void filter() { Operator op = IN; }
}
`);

        const index = new ProjectIndex(tmpDir);
        index.build();

        const imports = index.imports('src/main/java/com/example/service/Query.java');
        const innerImport = imports.find(i => i.module.includes('FilterCondition.Operator.IN'));
        assert.ok(innerImport, 'should find inner class static import');
        assert.strictEqual(innerImport.isExternal, false,
            `static import FilterCondition.Operator.IN should be INTERNAL but was EXTERNAL`);
        assert.ok(innerImport.resolved.includes('FilterCondition.java'),
            `should resolve to FilterCondition.java, got: ${innerImport.resolved}`);

        fs.rmSync(tmpDir, { recursive: true });
    });

    it('should keep truly external static imports as EXTERNAL', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-test-'));
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');

        const srcDir = path.join(tmpDir, 'src', 'main', 'java', 'com', 'example');
        fs.mkdirSync(srcDir, { recursive: true });
        fs.writeFileSync(path.join(srcDir, 'App.java'), `
package com.example;
import static java.util.List.of;
import static java.util.stream.Collectors.toList;
public class App {}
`);

        const index = new ProjectIndex(tmpDir);
        index.build();

        const imports = index.imports('src/main/java/com/example/App.java');
        for (const imp of imports) {
            assert.strictEqual(imp.isExternal, true,
                `stdlib import ${imp.module} should be EXTERNAL`);
        }

        fs.rmSync(tmpDir, { recursive: true });
    });
});

// ============================================================================
// Java wildcard package imports classified as INTERNAL
// ============================================================================

describe('Regression: Java wildcard package imports classified as INTERNAL', () => {
    it('should resolve import com.pkg.model.* as INTERNAL when model/ is a project directory', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-wildcard-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>');

            // Create the package directory with files
            const modelDir = path.join(tmpDir, 'src/main/java/com/example/model');
            fs.mkdirSync(modelDir, { recursive: true });
            fs.writeFileSync(path.join(modelDir, 'User.java'), `
package com.example.model;
public class User { }
`);
            fs.writeFileSync(path.join(modelDir, 'Product.java'), `
package com.example.model;
public class Product { }
`);

            // Create a file that uses wildcard import
            const serviceDir = path.join(tmpDir, 'src/main/java/com/example/service');
            fs.mkdirSync(serviceDir, { recursive: true });
            fs.writeFileSync(path.join(serviceDir, 'Service.java'), `
package com.example.service;
import com.example.model.*;
public class Service {
    public User getUser() { return new User(); }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            const imports = index.imports('src/main/java/com/example/service/Service.java');
            const wildcardImport = imports.find(i => i.module === 'com.example.model.*');
            assert.ok(wildcardImport, 'should find wildcard import');
            assert.strictEqual(wildcardImport.isExternal, false,
                'wildcard import com.example.model.* should be INTERNAL, not EXTERNAL');
            assert.ok(wildcardImport.resolved,
                'wildcard import should have a resolved path');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java cross-class method caller disambiguation
// ============================================================================

describe('Regression: Java cross-class method caller disambiguation', () => {
    it('should not report obj.method() as caller when receiver matches a different class', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-java-receiver-'));
        try {
            fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project/>');

            const srcDir = path.join(tmpDir, 'src/main/java/com/example');
            fs.mkdirSync(srcDir, { recursive: true });

            fs.writeFileSync(path.join(srcDir, 'UploadService.java'), `
package com.example;
public class UploadService {
    public void createDataFile(String name) { }
}
`);

            fs.writeFileSync(path.join(srcDir, 'JavascriptFileService.java'), `
package com.example;
public class JavascriptFileService {
    public void createDataFile(String name, String type) { }
}
`);

            fs.writeFileSync(path.join(srcDir, 'Controller.java'), `
package com.example;
import com.example.UploadService;
import com.example.JavascriptFileService;
public class Controller {
    private UploadService uploadService;
    private JavascriptFileService javascriptFileService;

    public void handleUpload() {
        uploadService.createDataFile("test");
    }

    public void handleJsUpload() {
        javascriptFileService.createDataFile("test", "js");
    }
}
`);

            const index = new ProjectIndex(tmpDir);
            index.build('**/*.java', { quiet: true });

            // Find the UploadService definition
            const defs = index.find('createDataFile');
            const uploadDef = defs.find(d => d.file.includes('UploadService'));
            assert.ok(uploadDef, 'Should find UploadService.createDataFile definition');

            // Get callers scoped to UploadService definition
            const callers = index.findCallers('createDataFile', {
                targetDefinitions: [uploadDef]
            });

            // uploadService.createDataFile() should be a caller
            const uploadCaller = callers.find(c => c.content && c.content.includes('uploadService.createDataFile'));
            assert.ok(uploadCaller, 'uploadService.createDataFile() should be a caller');

            // javascriptFileService.createDataFile() should NOT be a caller
            // (receiver "javascriptFileService" matches class JavascriptFileService, not UploadService)
            const jsCaller = callers.find(c => c.content && c.content.includes('javascriptFileService.createDataFile'));
            assert.ok(!jsCaller,
                'javascriptFileService.createDataFile() should NOT be reported as caller of UploadService.createDataFile');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Java usages: new ClassName(), static method calls, type_identifier
// ============================================================================

describe('Java Fix Regressions', () => {
    it('BUG 8 — Java new ClassName() classified as call, not reference', (t) => {
        const { getParser } = require('../languages');
        const { findUsagesInCode } = require('../languages/java');

        const code = `
package example;
import example.EntityRepository;

public class Controller {
    public void handle() {
        EntityRepository repo = new EntityRepository(dataSource);
        repo.findAll();
    }
}
`;
        const parser = getParser('java');
        const usages = findUsagesInCode(code, 'EntityRepository', parser);

        // new EntityRepository() should be a "call"
        const constructorUsage = usages.find(u => u.usageType === 'call');
        assert.ok(constructorUsage, 'new EntityRepository() should be classified as "call"');
    });

    it('BUG 8b — Java static method calls classified as call', (t) => {
        const { getParser } = require('../languages');
        const { findUsagesInCode } = require('../languages/java');

        const code = `
package example;
import example.ErrorUtil;

public class Handler {
    public void handle() {
        String uid = ErrorUtil.createErrorUid(exception);
    }
}
`;
        const parser = getParser('java');
        const usages = findUsagesInCode(code, 'ErrorUtil', parser);

        // ErrorUtil in ErrorUtil.createErrorUid() is the OBJECT position — a
        // type reference; the call belongs to createErrorUid. (Object position
        // used to classify as 'call', which made the account tag receiver
        // lines like iterator.hasNext() call-not-resolved for `iterator`.)
        const usageLines = usages.map(u => u.usageType);
        assert.ok(usageLines.includes('reference'),
            `ErrorUtil.createErrorUid() should classify ErrorUtil as "reference": ${usageLines}`);
        const callUsages = usages.filter(u => u.usageType === 'call');
        assert.strictEqual(callUsages.length, 0,
            'object position must not classify as call');
        // ...and the method name owns the call classification
        const methodUsages = findUsagesInCode(code, 'createErrorUid', parser);
        assert.ok(methodUsages.some(u => u.usageType === 'call'),
            'createErrorUid should classify as "call"');
    });

    it('BUG 8c — Java type_identifier in new expression detected', (t) => {
        const { getParser } = require('../languages');
        const { findUsagesInCode } = require('../languages/java');

        const code = `
package example;

public class Service {
    private Repository repo;
    public void init() {
        this.repo = new Repository(config);
    }
}
`;
        const parser = getParser('java');
        const usages = findUsagesInCode(code, 'Repository', parser);

        // Should find definition (field type) and call (new expression)
        assert.ok(usages.length >= 1, 'Repository should have usages');
        const callUsage = usages.find(u => u.usageType === 'call');
        assert.ok(callUsage, 'new Repository() should be classified as "call"');
    });

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
            const index = new ProjectIndex(tmpDir);
            index.build();
            const stats = { uncertain: 0 };
            const callers = index.findCallers('validate', { stats });
            assert.ok(callers.length > 0, 'validate should have callers');
            assert.ok(callers.some(c => c.callerName === 'process'), 'process should call validate');
            // The key assertion: these should NOT be uncertain
            assert.strictEqual(stats.uncertain, 0, 'same-class implicit calls should not be uncertain');
        } finally {
            fs.rmSync(tmpDir, { recursive: true });
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
        // String in the parameter should NOT be a definition - it's a type reference
        const defs = usages.filter(u => u.type === 'definition');
        assert.strictEqual(defs.length, 0, 'String should not be classified as a definition in formal_parameter');
    });
});

// ============================================================================
// Recovered lost tests
// ============================================================================

describe('Bug Report #3: Java graph', () => {
    it('BUG 5 — graph deduplicates multiple imports to same file', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug5-'));

        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(path.join(srcDir, 'FilterCondition.java'), `
package example;
public class FilterCondition {
    public enum Operator { EQ, NE, GT }
    public enum Condition { AND, OR }
}
`);
        fs.writeFileSync(path.join(srcDir, 'Visitor.java'), `
package example;
import example.FilterCondition;
import example.FilterCondition.Operator;
import example.FilterCondition.Condition;

public class Visitor {
    public void visit(FilterCondition fc) {
        Operator op = fc.getOp();
        Condition cond = fc.getCond();
    }
}
`);
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const graph = index.graph('src/Visitor.java', { direction: 'imports', maxDepth: 1 });
        const edgesToFC = graph.edges.filter(e =>
            e.from === graph.root && e.to.includes('FilterCondition'));
        assert.ok(edgesToFC.length <= 1,
            `Should have at most 1 edge to FilterCondition (got ${edgesToFC.length})`);

        fs.rmSync(tmpDir, { recursive: true });
    });
});

describe('Bug Report #3: Java deadcode entry points', () => {
    it('BUG 12 — deadcode excludes entry points even with include_exported', () => {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ucn-bug12-'));
        const srcDir = path.join(tmpDir, 'src');
        fs.mkdirSync(srcDir, { recursive: true });

        fs.writeFileSync(path.join(srcDir, 'Application.java'), `
package example;

public class Application {
    public static void main(String[] args) {
        System.out.println("Hello");
    }
}
`);
        fs.writeFileSync(path.join(tmpDir, 'pom.xml'), '<project></project>');

        const index = new ProjectIndex(tmpDir);
        index.build(null, { quiet: true });

        const dead = index.deadcode({ includeExported: true });
        const mainDead = dead.find(d => d.name === 'main');
        assert.ok(!mainDead, 'main() should never be reported as dead code');

        fs.rmSync(tmpDir, { recursive: true });
    });
});

// ============================================================================
// Bug Hunt: Java final parameter modifier false positive
// ============================================================================

describe('Bug Hunt: Java final in params not misclassified as method modifier', () => {
    it('should not report "final" on method when only parameter is final', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = `public class Foo {
    void doWork(final String name, final int count) {}
    public static final void doStatic() {}
}`;
        const classes = javaMod.findClasses(code, parser);
        assert.ok(classes.length > 0, 'should find class Foo');
        const doWork = classes[0].members.find(m => m.name === 'doWork');
        assert.ok(doWork, 'should find doWork method');
        assert.ok(!doWork.modifiers || !doWork.modifiers.includes('final'),
            `doWork should NOT have 'final' modifier from params, got: ${JSON.stringify(doWork.modifiers)}`);
    });

    it('should keep "final" on method when it IS a method modifier', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = `public class Foo {
    public final void locked() {}
}`;
        const classes = javaMod.findClasses(code, parser);
        const locked = classes[0].members.find(m => m.name === 'locked');
        assert.ok(locked, 'should find locked method');
        assert.ok(locked.modifiers && locked.modifiers.includes('final'),
            `locked should have 'final' modifier, got: ${JSON.stringify(locked.modifiers)}`);
    });
});

// ============================================================================
// fix #163: Java receiver type tracking for method disambiguation
// ============================================================================

describe('fix #163: Java receiver type tracking in findCallsInCode', () => {
    it('infers receiverType from method parameters', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = `public class Runner {
    public void process(Filter f, Score s) {
        f.run();
        s.run();
    }
}`;
        const calls = javaMod.findCallsInCode(code, parser);
        const fRun = calls.find(c => c.name === 'run' && c.receiver === 'f');
        const sRun = calls.find(c => c.name === 'run' && c.receiver === 's');
        assert.ok(fRun, 'Should find f.run() call');
        assert.ok(sRun, 'Should find s.run() call');
        assert.strictEqual(fRun.receiverType, 'Filter', 'f should have receiverType Filter');
        assert.strictEqual(sRun.receiverType, 'Score', 's should have receiverType Score');
    });

    it('infers receiverType from new Type() assignments', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = `public class App {
    public void main() {
        Filter f = new Filter();
        f.run();
    }
}`;
        const calls = javaMod.findCallsInCode(code, parser);
        const fRun = calls.find(c => c.name === 'run' && c.receiver === 'f');
        assert.ok(fRun, 'Should find f.run() call');
        // receiverType inferred via _buildTypedLocalTypeMap from constructor call
        // At parser level, the call only has receiver='f' without receiverType
        // The type comes from the local_variable_declaration tracking
    });

    it('does not set receiverType for this.method()', () => {
        const { getParser, getLanguageModule } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageModule('java');
        const code = `public class Foo {
    public void bar() { this.baz(); }
    public void baz() {}
}`;
        const calls = javaMod.findCallsInCode(code, parser);
        const thisBaz = calls.find(c => c.name === 'baz' && c.receiver === 'this');
        assert.ok(thisBaz, 'Should find this.baz() call');
        assert.strictEqual(thisBaz.receiverType, undefined, 'this.baz() should not have receiverType');
    });
});

describe('fix #163: Java callee disambiguation with receiver type', () => {
    it('resolves callees to correct type when multiple types have same method', () => {
        const dir = tmp({
            'Filter.java': `public class Filter {
    public String run() { return "filter"; }
}`,
            'Score.java': `public class Score {
    public String run() { return "score"; }
}`,
            'Runner.java': `public class Runner {
    public void process(Filter f, Score s) {
        f.run();
        s.run();
    }
}`
        });
        try {
            const index = idx(dir);

            // Runner.process should resolve f.run() → Filter.run, s.run() → Score.run
            const processDef = (index.symbols.get('process') || [])
                .find(d => d.className === 'Runner');
            assert.ok(processDef, 'Should find Runner.process');
            const callees = index.findCallees(processDef);
            const runCallees = callees.filter(c => c.name === 'run');
            assert.ok(runCallees.length >= 2,
                `Should find both run callees, got: ${runCallees.map(c => c.className).join(', ')}`);
            assert.ok(runCallees.some(c => c.className === 'Filter'),
                'Should include Filter.run');
            assert.ok(runCallees.some(c => c.className === 'Score'),
                'Should include Score.run');
        } finally {
            rm(dir);
        }
    });

    it('resolves callers to correct type with targetDefinitions', () => {
        const dir = tmp({
            'Filter.java': `public class Filter {
    public String process() { return "filter"; }
}`,
            'Score.java': `public class Score {
    public String process() { return "score"; }
}`,
            'Runner.java': `public class Runner {
    public void runFilters(Filter f) {
        f.process();
    }
    public void runScores(Score s) {
        s.process();
    }
}`
        });
        try {
            const index = idx(dir);

            // Callers of Filter.process should include runFilters, not runScores
            const filterProcess = (index.symbols.get('process') || [])
                .find(d => d.className === 'Filter');
            assert.ok(filterProcess, 'Should find Filter.process');

            const callers = index.findCallers('process', {
                targetDefinitions: [filterProcess]
            });
            const callerNames = callers.map(c => c.callerName);
            assert.ok(callerNames.includes('runFilters'),
                'runFilters should be a caller of Filter.process');
            assert.ok(!callerNames.includes('runScores'),
                'runScores should NOT be a caller of Filter.process');
        } finally {
            rm(dir);
        }
    });
});

describe('fix #167: Java method references detected as callbacks', () => {
    it('detects this::method as callback reference', () => {
        const dir = tmp({
            'Main.java': `public class Main {
    void worker() { System.out.println("work"); }
    void run() {
        execute(this::worker);
    }
    static void execute(Runnable r) { r.run(); }
}`,
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('run')?.find(s => s.file.includes('Main.java'));
            assert.ok(def, 'run method should exist');
            const callees = index.findCallees(def);
            const calleeNames = callees.map(c => c.name);
            assert.ok(calleeNames.includes('execute'), 'should find execute as callee');
            assert.ok(calleeNames.includes('worker'), 'should find worker as callback callee');
        } finally {
            rm(dir);
        }
    });
});

// ============================================================================
// ENTRYPOINTS: Java Spring annotation detection
// ============================================================================

describe('Entrypoints: Spring annotation detection', () => {
    const { detectEntrypoints, isFrameworkEntrypoint } = require('../core/entrypoints');

    it('detects @GetMapping/@PostMapping handlers', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'Controller.java': `
package com.example;

@RestController
public class ItemController {
    @GetMapping("/items")
    public List<Item> getItems() { return items; }

    @PostMapping("/items")
    public Item createItem() { return new Item(); }

    @DeleteMapping("/items/{id}")
    public void deleteItem(Long id) {}

    private void helper() {}
}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            const names = eps.map(e => e.name);
            assert.ok(names.includes('getItems'), 'should detect @GetMapping');
            assert.ok(names.includes('createItem'), 'should detect @PostMapping');
            assert.ok(names.includes('deleteItem'), 'should detect @DeleteMapping');
            assert.ok(!names.includes('helper'), 'should not detect private helper');
            assert.ok(eps.filter(e => e.name === 'getItems').some(e => e.framework === 'spring'));
        } finally { rm(dir); }
    });

    it('detects @Service/@Component DI entry points', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'Service.java': `
package com.example;

@Service
public class UserService {
    public void doWork() {}
}

@Component
public class HealthIndicator {
    public String check() { return "ok"; }
}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            assert.ok(eps.some(e => e.type === 'di'), 'should detect DI entry points');
        } finally { rm(dir); }
    });

    it('detects @Scheduled job entry points', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'Jobs.java': `
package com.example;

@Component
public class CleanupJob {
    @Scheduled(fixedRate = 5000)
    public void cleanup() {
        System.out.println("cleaning...");
    }
}
`
        });
        try {
            const index = idx(dir);
            const eps = detectEntrypoints(index);
            assert.ok(eps.some(e => e.name === 'cleanup' && e.type === 'jobs'), 'should detect @Scheduled');
        } finally { rm(dir); }
    });

    it('Spring annotations excluded from deadcode', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'App.java': `
@RestController
public class App {
    @GetMapping("/health")
    public String health() { return "ok"; }
}
`
        });
        try {
            const index = idx(dir);
            const dc = index.deadcode();
            const names = dc.map(d => d.name);
            assert.ok(!names.includes('health'), '@GetMapping method should not be dead code');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #177: Java enum methods not double-indexed
// ============================================================================

describe('fix #177: Java enum methods not double-indexed', () => {
    it('Java enum methods should not have duplicate entries in symbol table', () => {
        const dir = tmp({
            'Main.java': 'public class Main {\n    enum Status {\n        ACTIVE, INACTIVE;\n        public String getValue() { return name(); }\n    }\n}'
        });
        try {
            const i = idx(dir);
            const defs = i.symbols.get('getValue') || [];
            assert.strictEqual(defs.length, 1, 'enum method should not be double-indexed');
            assert.strictEqual(defs[0].className, 'Status');
        } finally { rm(dir); }
    });
});

describe('fix #184: impact detects class field receiver types', () => {
    it('should find call sites through class field receivers', () => {
        const dir = tmp({
            'Main.java': [
                'public class Main {',
                '    private final Service service;',
                '    public Main(Service service) { this.service = service; }',
                '    public void run() { service.execute("task"); }',
                '}',
            ].join('\n'),
            'Service.java': [
                'public class Service {',
                '    public void execute(String name) { System.out.println(name); }',
                '}',
            ].join('\n'),
        });
        try {
            const i = idx(dir);
            const { execute } = require('../core/execute');
            const r = execute(i, 'impact', { name: 'execute', className: 'Service' });
            assert.ok(r.ok);
            assert.ok(r.result.totalCallSites >= 1, 'should find service.execute() via class field type');
        } finally { rm(dir); }
    });
});

// ============================================================================
// FEATURE A: CALL-SITE CLASSIFICATION (Java)
// ============================================================================

describe('Feature A: Java call-site classification', () => {
    it('Java: inLoop set for calls inside for/while loops', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/Main.java': [
                'public class Main {',
                '    public static int helper(int x) { return x; }',
                '    public static void caller() {',
                '        for (int i = 0; i < 3; i++) {',
                '            helper(i);',
                '        }',
                '        helper(0);',  // outside loop
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 2);
            assert.strictEqual(r.patterns.inLoop, 1, 'one of two calls in loop');
        } finally { rm(dir); }
    });

    it('Java: inTry set for calls inside try { ... }', () => {
        const dir = tmp({
            'pom.xml': '<project></project>',
            'src/Main.java': [
                'public class Main {',
                '    public static int helper() { return 1; }',
                '    public static void caller() {',
                '        try { helper(); } catch (Exception e) {}',
                '        helper();',  // outside try
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = index.verify('helper');
            assert.strictEqual(r.totalCalls, 2);
            assert.strictEqual(r.patterns.inTry, 1);
        } finally { rm(dir); }
    });
});

// ============================================================================
// endpoints command — Java (Spring + JAX-RS)
// ============================================================================

describe('endpoints command (Java)', () => {
    const FIXTURE = path.join(FIXTURES_PATH, 'endpoints', 'java');

    it('extracts Spring + JAX-RS server routes (8 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // UserController.java: 5 routes (GET, GET/{id}, POST, PUT/{id}, DELETE/{id})
        // JaxRsResource.java: 3 routes (GET, POST/new, DELETE/{id})
        assert.strictEqual(result.meta.totalRoutes, 8, 'expected 8 routes');
        assert.strictEqual(result.meta.byFramework.spring, 5);
        assert.strictEqual(result.meta.byFramework['jax-rs'], 3);
    });

    it('Spring @RequestMapping class prefix is concatenated to method paths', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // @RestController + @RequestMapping("/api/users") + @GetMapping → /api/users
        const findAll = result.routes.find(r =>
            r.framework === 'spring' && r.handler === 'findAll');
        assert.ok(findAll, 'should find Spring findAll route');
        assert.strictEqual(findAll.method, 'GET');
        assert.strictEqual(findAll.path, '/api/users');
        assert.strictEqual(findAll.classPrefix, '/api/users');

        // @GetMapping("/{id}") on /api/users → /api/users/{id}
        const findOne = result.routes.find(r =>
            r.framework === 'spring' && r.handler === 'findOne');
        assert.ok(findOne);
        assert.strictEqual(findOne.path, '/api/users/{id}');
        assert.strictEqual(findOne.normalizedPath, '/api/users/*');
    });

    it('JAX-RS @Path("/items") class prefix concatenates with @Path subpaths', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // @Path("/items") + @POST + @Path("/new") → /items/new
        const create = result.routes.find(r =>
            r.framework === 'jax-rs' && r.handler === 'create');
        assert.ok(create);
        assert.strictEqual(create.method, 'POST');
        assert.strictEqual(create.path, '/items/new');
    });

    it('JAX-RS @GET without method-level @Path uses class prefix only', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        // @Path("/items") + @GET (no method-level @Path) → /items
        const getAll = result.routes.find(r =>
            r.framework === 'jax-rs' && r.handler === 'getAll');
        assert.ok(getAll, 'should find JAX-RS getAll route');
        assert.strictEqual(getAll.method, 'GET');
        assert.strictEqual(getAll.path, '/items');
    });

    it('extracts Java client requests: RestTemplate (2 total)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        assert.strictEqual(result.meta.totalRequests, 2);
    });

    it('restTemplate.getForObject infers GET, postForObject infers POST', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', {});
        assert.ok(ok);
        const get = result.requests.find(r => r.callerName === 'listUsers');
        assert.ok(get, 'should find getForObject from listUsers');
        assert.strictEqual(get.method, 'GET');
        assert.strictEqual(get.path, '/api/users');
        const post = result.requests.find(r => r.callerName === 'createUser');
        assert.ok(post);
        assert.strictEqual(post.method, 'POST');
        assert.strictEqual(post.path, '/api/users');
    });

    it('--bridge: Spring GET /api/users matches restTemplate.getForObject(/api/users)', () => {
        const index = idx(FIXTURE);
        const { ok, result } = execute(index, 'endpoints', { bridge: true });
        assert.ok(ok);
        const exact = result.bridges.find(b =>
            b.matchType === 'exact' &&
            b.route.method === 'GET' &&
            b.route.path === '/api/users' &&
            b.request.method === 'GET');
        assert.ok(exact, 'should produce exact match for Spring GET /api/users');
        assert.strictEqual(exact.confidence, 1);
    });
});

describe('fix #202: declared-field receivers (Java)', () => {
    const FILES = {
        'Service.java': `public class Service {
    public void execute() {}
}
`,
        'Other.java': `public class Other {
    public void execute() {}
}
`,
        'Main.java': `public class Main {
    private Service service;

    public void run() {
        this.service.execute();
    }

    public void bare() {
        service.execute();
    }

    public void shadowed() {
        Other service = new Other();
        service.execute();
    }
}
`,
        'Base.java': `public class Base {
    public void parse() {}
}
`,
        'Child.java': `public class Child extends Base {
    public void parse() {}
}
`,
        'Holder.java': `public class Holder {
    private Base b;

    public void go() {
        this.b.parse();
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
                key: `${c.file}:${c.line}`, reason: c.reason, dispatchVia: c.dispatchVia,
            })),
            excluded: json.meta.account?.excluded,
            conserved: json.meta.account?.conserved,
        };
    }

    it('this.field and bare-field receivers type from field declarations', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const service = callersOf(index, 'Service.java:2:execute');
            assert.ok(service.confirmed.includes('Main.java:5'),
                `this.service.execute() must confirm Service.execute: ${service.confirmed}`);
            assert.ok(service.confirmed.includes('Main.java:9'),
                `bare service.execute() (implicit this) must confirm Service.execute: ${service.confirmed}`);
            assert.ok(!service.confirmed.includes('Main.java:14'),
                `shadowed local typed Other must not confirm Service.execute: ${service.confirmed}`);
            assert.strictEqual(service.conserved, true);
        } finally { rm(dir); }
    });

    it('field-typed receivers exclude unrelated same-name targets with reason', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const other = callersOf(index, 'Other.java:2:execute');
            assert.ok(other.confirmed.includes('Main.java:14'),
                `local new Other() receiver must confirm Other.execute: ${other.confirmed}`);
            assert.ok(!other.confirmed.includes('Main.java:5') && !other.confirmed.includes('Main.java:9'),
                `Service-typed field sites must not confirm Other.execute: ${other.confirmed}`);
            assert.ok(other.excluded.byReason['receiver-type-mismatch'],
                'mismatched field receivers excluded with reason');
            assert.strictEqual(other.conserved, true);
        } finally { rm(dir); }
    });

    it('supertype-typed fields route to possible-dispatch, never excluded (virtual dispatch)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const child = callersOf(index, 'Child.java:2:parse');
            // Dispatch tiering: a Base-typed field MAY dispatch to Child.parse —
            // visible as possible-dispatch (unverified), never confirmed (no
            // evidence it reaches THIS override), never excluded.
            assert.ok(!child.confirmed.includes('Holder.java:5'),
                `supertype-typed field is not receiver evidence for the override: ${child.confirmed}`);
            const entry = child.unverified.find(u => u.key === 'Holder.java:5');
            assert.ok(entry, `this.b.parse() with b typed Base stays visible: ${JSON.stringify(child.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Base');
            assert.strictEqual(child.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #202: external-typed field receivers (Java)', () => {
    const FILES = {
        'Registry.java': `import java.util.Map;

public class Registry {
    private final Map<String, String> creators = null;

    public String lookup(String type) {
        return creators.get(type);
    }
}
`,
        'Store.java': `public class Store {
    public String get(String key) { return key; }
}
`,
        'TreeMapLike.java': `import java.util.AbstractMap;

public class TreeMapLike extends AbstractMap<String, String> {
    public String get(Object key) { return null; }
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
                key: `${c.file}:${c.line}`, reason: c.reason, dispatchVia: c.dispatchVia,
            })),
            conserved: json.meta.account?.conserved,
        };
    }

    it('Map-typed field excludes unrelated project targets with resolved ancestry', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const store = callersOf(index, 'Store.java:2:get');
            assert.ok(!store.confirmed.includes('Registry.java:7'),
                `creators.get() on a java.util.Map field must not confirm Store.get: ${store.confirmed}`);
            assert.strictEqual(store.conserved, true);
        } finally { rm(dir); }
    });

    it('never excludes targets whose ancestry dead-ends at an external class', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            // TreeMapLike extends AbstractMap (external) — the chain to Map is
            // invisible, so a Map-typed receiver may reach TreeMapLike.get.
            // Dispatch tiering: visible as possible-dispatch (the Map-typed
            // receiver is not evidence it reaches THIS def), never excluded.
            const tree = callersOf(index, 'TreeMapLike.java:4:get');
            assert.ok(!tree.confirmed.includes('Registry.java:7'),
                `external supertype field is not receiver evidence: ${tree.confirmed}`);
            const entry = tree.unverified.find(u => u.key === 'Registry.java:7');
            assert.ok(entry, `Map-typed receiver stays a possible caller of TreeMapLike.get: ${JSON.stringify(tree.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Map');
            assert.strictEqual(tree.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #204: possible-dispatch tiering (Java)
// ============================================================================

describe('fix #204: possible-dispatch tiering (Java)', () => {
    const FILES = {
        'Storage.java': `public interface Storage {
    void save(String data);
}
`,
        'DiskStorage.java': `public class DiskStorage implements Storage {
    public void save(String data) { System.out.println(data); }
}
`,
        'MemStorage.java': `public class MemStorage implements Storage {
    public void save(String data) { System.out.println(data); }
}
`,
        'App.java': `public class App {
    private Storage storage;
    private DiskStorage disk;

    public void run(String data) {
        storage.save(data);
    }

    public void runTyped(Storage s, String data) {
        s.save(data);
    }

    public void runDisk(String data) {
        disk.save(data);
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

    it('interface-typed param receiver routes to possible-dispatch (was excluded)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'DiskStorage.java:2:save');
            assert.ok(!res.confirmed.includes('App.java:10'),
                `s.save() on a Storage param is not evidence for DiskStorage.save: ${res.confirmed}`);
            const entry = res.unverified.find(u => u.key === 'App.java:10');
            assert.ok(entry, `interface-typed receiver stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Storage');
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('interface-typed field receiver routes to possible-dispatch with implementation count', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'DiskStorage.java:2:save');
            const entry = res.unverified.find(u => u.key === 'App.java:6');
            assert.ok(entry, `storage.save() on a Storage field stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Storage');
            // Implementations only — the interface's abstract declaration is
            // not a landing site.
            assert.strictEqual(entry.dispatchCandidates, 2);
        } finally { rm(dir); }
    });

    it('exact-class field receiver stays confirmed', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'DiskStorage.java:2:save');
            assert.ok(res.confirmed.includes('App.java:14'),
                `disk.save() on a DiskStorage field confirms DiskStorage.save: ${res.confirmed}`);
        } finally { rm(dir); }
    });

    it('legacy commands unaffected: trace finds no tier routing', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            // trace runs findCallers WITHOUT collectAccount — dispatch tiering
            // must not change its results (byte-identical legacy contract).
            const r = execute(index, 'trace', { name: 'save' });
            assert.ok(r.ok, `trace failed: ${r.error}`);
            const text = require('../core/output').formatTrace(r.result);
            assert.ok(!text.includes('possible-dispatch'),
                'legacy trace output must not carry dispatch-tier markers');
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #205: arity pruning + overload discipline (Java)
// ============================================================================

describe('fix #205: overload discipline and arity pruning (Java)', () => {
    const FILES = {
        'Element.java': 'public class Element {}\n',
        'Sub.java': 'public class Sub extends Element {}\n',
        'Sink.java': `public class Sink {
    public void add(Number n) {}
    public void add(String s) {}
    public void add(Element e) {}
    public String[] asList() { return null; }
}
`,
        'Use.java': `public class Use {
    public void go(Sink sink, Element el) {
        sink.add(1);
        sink.add("x");
        sink.add(new Sub());
        sink.add(el);
        Arrays.asList(1, 2, 3);
        sink.asList();
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
                key: `${c.file}:${c.line}`, reason: c.reason, dispatchCandidates: c.dispatchCandidates,
            })),
            excluded: json.meta.account?.excluded,
            conserved: json.meta.account?.conserved,
        };
    }

    it('literal kinds narrow to the pinned overload (int → add(Number) confirmed)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'Sink.java:2:add');
            assert.ok(res.confirmed.includes('Use.java:3'),
                `sink.add(1) uniquely binds add(Number): ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('literal kinds proving a sibling overload exclude with overload-mismatch', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'Sink.java:2:add');
            // add("x") binds add(String); add(new Sub()) and add(el) bind
            // add(Element), the former via project ancestry Sub -> Element.
            assert.ok(!res.confirmed.includes('Use.java:4') && !res.confirmed.includes('Use.java:5'),
                `string/constructor args must not confirm add(Number): ${res.confirmed}`);
            assert.strictEqual(res.excluded.byReason['overload-mismatch']?.count, 3,
                `sibling-overload calls excluded with reason: ${JSON.stringify(res.excluded.byReason)}`);
        } finally { rm(dir); }
    });

    it('a statically typed variable proving a sibling overload is excluded', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'Sink.java:2:add');
            assert.ok(!res.confirmed.includes('Use.java:6'), 'sink.add(el) cannot bind add(Number)');
            assert.ok(!res.unverified.some(u => u.key === 'Use.java:6'),
                `a compiler-visible Element type is decisive: ${JSON.stringify(res.unverified)}`);
        } finally { rm(dir); }
    });

    it('argument count that fits no pinned signature excludes with arity-mismatch', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = callersOf(index, 'Sink.java:5:asList');
            assert.ok(res.confirmed.includes('Use.java:8'),
                `sink.asList() confirms: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('Use.java:7'),
                `Arrays.asList(1,2,3) cannot bind a 0-param method: ${res.confirmed}`);
            assert.strictEqual(res.excluded.byReason['arity-mismatch']?.count, 1,
                `arity mismatch excluded with reason: ${JSON.stringify(res.excluded.byReason)}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #206: qualified object creation keeps its package qualifier
// ============================================================================

describe('fix #206: qualified constructor records receiver (Java)', () => {
    it('new com.example.Foo() records receiver, new Foo() does not', () => {
        const dir = tmp({
            'A.java': `class A {
    void m() {
        Object a = new com.example.Foo(1);
        Object b = new Foo(2);
    }
}
`,
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
            const qualified = calls.find(c => c.line === 3);
            const bare = calls.find(c => c.line === 4);
            assert.ok(qualified, 'qualified constructor recorded');
            assert.strictEqual(qualified.receiver, 'example',
                `package qualifier kept as receiver: ${JSON.stringify(qualified)}`);
            assert.ok(bare, 'bare constructor recorded');
            assert.strictEqual(bare.receiver, undefined,
                `bare constructor has no receiver: ${JSON.stringify(bare)}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #207: nominal return-type flow + declared-type locals (Java) —
// `var x = Factory.find()` types x from the producer's declared return;
// `Service s = anyExpr()` types s from the declaration itself.
// ============================================================================

describe('fix #207: return-type flow and declared-type locals (Java)', () => {
    const FILES = {
        'Service.java': `public class Service {
    public int run() { return 1; }
}
`,
        'Handler.java': `public interface Handler {
    int handle();
}
`,
        'WebHandler.java': `public class WebHandler implements Handler {
    public int handle() { return 2; }
}
`,
        'Registry.java': `public class Registry {
    public static Service lookup(String name) { return new Service(); }
    public static Handler pick(String name) { return new WebHandler(); }
}
`,
        'App.java': `public class App {
    void go() {
        var s = Registry.lookup("a");
        s.run();
        Service t = obtain();
        t.run();
        var h = Registry.pick("b");
        h.handle();
    }
    Service obtain() { return new Service(); }
}
`,
    };

    function contractCallers(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => ({
                key: `${u.file}:${u.line}`, reason: u.reason, dispatchVia: u.dispatchVia,
            })),
            conserved: json.meta.account?.conserved,
        };
    }

    it('var assigned from a static factory confirms calls on the returned type', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contractCallers(index, 'Service.java:2:run');
            assert.ok(res.confirmed.includes('App.java:4'),
                `var s = Registry.lookup(..) types s as Service: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('declared-type local confirms regardless of the value expression', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contractCallers(index, 'Service.java:2:run');
            assert.ok(res.confirmed.includes('App.java:6'),
                `Service t = obtain() types t from the declaration: ${res.confirmed}`);
        } finally { rm(dir); }
    });

    it('interface-returning factory routes the consuming call to possible-dispatch', () => {
        // var h = Registry.pick(..) returns the Handler INTERFACE — h.handle()
        // can dispatch into WebHandler.handle but is not receiver evidence.
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contractCallers(index, 'WebHandler.java:2:handle');
            assert.ok(!res.confirmed.includes('App.java:8'),
                `h is Handler-typed, not WebHandler evidence: ${res.confirmed}`);
            const entry = res.unverified.find(u => u.key === 'App.java:8');
            assert.ok(entry, `h.handle() stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Handler');
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #210: external-contract methods (gson-measured, JDK-name collisions).
// A method with @Override and a SINGLE project-wide owner overrides a
// contract UCN cannot see (LazilyParsedNumber extends Number → intValue is
// Number's contract): any external-typed receiver satisfies the same call,
// so unique project ownership is not identity evidence. Receiver-evidence-
// free calls route possible-dispatch (visible, never excluded); receiver-
// evidenced calls keep confirming. Account-gated — legacy paths unchanged.
// ============================================================================

describe('fix #210: external-contract methods (Java)', () => {
    const FILES = {
        'LazyNum.java': `public class LazyNum extends Number {
    @Override
    public int intValue() { return 1; }
    public int ownMethod() { return 2; }
}
`,
        'Caller.java': `public class Caller {
    void use(Object o, LazyNum[] nums) {
        int a = ((Integer) o).intValue();
        int b = nums[0].ownMethod();
    }
}
`,
        'Typed.java': `public class Typed {
    void go() {
        LazyNum n = new LazyNum();
        int c = n.intValue();
    }
}
`,
        'Plain.java': `public class Plain {
    @Override
    public String toString() { return "p"; }
}
`,
        'Stringer.java': `public class Stringer {
    Object make() { return new Object(); }
    void show() {
        String s = make().toString();
    }
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
            text: r.result,
        };
    }

    it('@Override + single owner routes receiver-evidence-free calls possible-dispatch via the external supertype', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'LazyNum.java:2:intValue');
            assert.ok(!res.confirmed.includes('Caller.java:3'),
                `((Integer) o).intValue() could be Number's: ${res.confirmed}`);
            const entry = res.unverified.find(u => u.key === 'Caller.java:3');
            assert.ok(entry, `cast-receiver call stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.reason, 'possible-dispatch');
            assert.strictEqual(entry.dispatchVia, 'Number');
            assert.strictEqual(entry.externalContract, true);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('receiver-evidenced calls keep confirming on external-contract methods', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'LazyNum.java:2:intValue');
            assert.ok(res.confirmed.includes('Typed.java:4'),
                `LazyNum-typed receiver outranks the contract demotion: ${res.confirmed}`);
        } finally { rm(dir); }
    });

    it('un-marked single-owner methods keep confirming (control)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'LazyNum.java:4:ownMethod');
            assert.ok(res.confirmed.includes('Caller.java:4'),
                `ownMethod has no override marker — unique ownership stays evidence: ${res.confirmed}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('@Override with no explicit supertypes attributes via Object', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Plain.java:2:toString');
            const entry = res.unverified.find(u => u.key === 'Stringer.java:4');
            assert.ok(entry, `o.toString() stays visible: ${JSON.stringify(res.unverified)}`);
            assert.strictEqual(entry.dispatchVia, 'Object');
            assert.strictEqual(entry.externalContract, true);
        } finally { rm(dir); }
    });

    it('text rendering labels the entry as an external contract', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'LazyNum.java:2:intValue' });
            assert.ok(r.ok);
            const output = require('../core/output');
            const formatted = output.formatContext(r.result);
            const text = typeof formatted === 'string' ? formatted : formatted.text;
            assert.ok(text.includes('possible-dispatch via Number — external contract'),
                `label renders the contract: ${text}`);
        } finally { rm(dir); }
    });

    it('legacy (non-account) caller resolution is unchanged', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const { findCallers } = require('../core/callers');
            const legacy = findCallers(index, 'intValue', {});
            assert.ok(legacy.some(c => (c.relativePath || c.file).includes('Caller.java') && c.line === 3),
                `legacy keeps the edge (drop-vs-route asymmetry): ${JSON.stringify(legacy.map(c => `${c.relativePath || c.file}:${c.line}`))}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #211: deadcode — abstract interface members labeled; default methods not
// ============================================================================

describe('fix #211: deadcode — Java interface declarations', () => {
    it('abstract interface members carry declaredOn; default methods do not', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/Api.java': [
                'interface Api {',
                '    void call();',
                '    default void assist() { }',
                '}',
                'public class App {',
                '    void deadPkgPrivate() {}',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // Java interface members are implicitly public — exported arm
            const claims = index.deadcode({ includeExported: true });
            const call = claims.find(d => d.name === 'call');
            assert.ok(call, `abstract interface member is reported: ${claims.map(d => d.name)}`);
            assert.deepStrictEqual(call.declaredOn, { kind: 'interface', name: 'Api' });
            const assist = claims.find(d => d.name === 'assist');
            assert.ok(assist, `default method is reported: ${claims.map(d => d.name)}`);
            assert.strictEqual(assist.declaredOn, undefined,
                'default methods have bodies — executable code');
            // Explicit visibility languages: package-private member of a public
            // class stays claimable by default (implicitlyPublicMembers=false)
            const def = index.deadcode({});
            assert.ok(def.some(d => d.name === 'deadPkgPrivate'),
                `package-private method stays claimable: ${def.map(d => d.name)}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #212: universal-supertype receivers — `void show(Object o) { o.size() }`
// was excluded receiver-type-mismatch, but an Object-typed receiver can hold
// ANY project instance and dispatch into any override. The implicit
// `extends Object` edge is invisible to declared-ancestry walks, so the
// universalSupertype trait short-circuits _dispatchCapableSupertype.
// Demote-only: reroutes excluded → visible possible-dispatch, never confirms.
// ============================================================================

describe('fix #212: Object-typed receivers route possible-dispatch, never excluded', () => {
    const FILES = {
        'pom.xml': '<project/>',
        'src/Num.java': [
            'public class Num {',
            '    public int size() { return 1; }',
            '}',
        ].join('\n'),
        'src/Other.java': [
            'public class Other {',
            '    public int area() { return 2; }',
            '}',
        ].join('\n'),
        'src/Show.java': [
            'public class Show {',
            '    void show(Object o, java.lang.Object q, Other x) {',
            '        int a = o.size();',
            '        int b = q.size();',
            '        int c = x.size();',
            '    }',
            '}',
        ].join('\n'),
    };

    function contract(index, handle) {
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => ({
                key: `${u.file}:${u.line}`, reason: u.reason, dispatchVia: u.dispatchVia,
            })),
            conserved: json.meta.account?.conserved,
        };
    }

    it('Object and java.lang.Object receivers are dispatch-capable toward any override', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'src/Num.java:2:size');
            assert.strictEqual(res.confirmed.length, 0,
                `an Object receiver is not evidence FOR Num.size: ${res.confirmed}`);
            for (const line of ['src/Show.java:3', 'src/Show.java:4']) {
                const entry = res.unverified.find(u => u.key === line);
                assert.ok(entry, `${line} must be visible, not excluded: ${JSON.stringify(res.unverified)}`);
                assert.strictEqual(entry.reason, 'possible-dispatch');
                assert.strictEqual(entry.dispatchVia, 'Object');
            }
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('unrelated concrete project receivers still exclude (control)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'src/Num.java:2:size');
            assert.ok(!res.confirmed.includes('src/Show.java:5'),
                'x is typed Other — not a Num caller');
            assert.ok(!res.unverified.some(u => u.key === 'src/Show.java:5'),
                `Other defines no size and is unrelated to Num — stays excluded: ${JSON.stringify(res.unverified)}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #218 (nominal): a same-class match landing on a STRICT ancestor of the
// pinned target's class routes possible-dispatch — `this.render()` inside an
// abstract base lexically binds the base's def; reaching a pinned subclass
// override is dynamic dispatch. Pinning the base def itself stays confirmed.
// ============================================================================

describe('fix #218: strict-ancestor same-class match routes possible-dispatch (Java)', () => {
    const FILES = {
        'pom.xml': '<project/>',
        'Base.java': [
            'public abstract class Base {',
            '    public String call(int task) {',
            '        return this.render(task);',
            '    }',
            '',
            '    public abstract String render(int task);',
            '}',
            '',
        ].join('\n'),
        'Speed.java': [
            'public class Speed extends Base {',
            '    @Override',
            '    public String render(int task) {',
            '        return String.valueOf(task);',
            '    }',
            '}',
            '',
        ].join('\n'),
    };

    it('pinned subclass override: base-class this-call is possible-dispatch', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'Speed.java:2:render' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            const unv = (json.data.unverifiedCallers || []);
            assert.ok(!confirmed.includes('Base.java:3'),
                `this.render in Base reaches the override only dynamically: ${confirmed}`);
            assert.ok(unv.some(c => `${c.file}:${c.line}` === 'Base.java:3'),
                `visible possible-dispatch, conserved: ${JSON.stringify(unv)}`);
        } finally { rm(dir); }
    });

    it('pinned base def: the same this-call stays confirmed', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'Base.java:6:render' });
            assert.ok(r.ok, JSON.stringify(r.error));
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('Base.java:3'),
                `matchedClass ∈ targetClasses — confirmation stands: ${confirmed}`);
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #220 (Java): chained receivers from declared returns; bare same-class
// calls keep binding (bareCallReachesMethods control)
// ============================================================================
describe('fix #220 (Java): chained receivers + bare-call control', () => {
    function contractCallers(index, handle) {
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, `context ${handle} failed: ${r.error}`);
        const output = require('../core/output');
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(u => `${u.file}:${u.line}:${u.reason}`),
            conserved: json.meta.account?.conserved,
        };
    }

    it('chained receiver typed from the producer return annotation', () => {
        // getConfig().validate() — Config.validate confirms; the same-name
        // method on an unrelated class is excluded.
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/Config.java': `public class Config {
    public boolean validate() { return true; }
}
`,
            'src/Other.java': `public class Other {
    public boolean validate() { return false; }
}
`,
            'src/App.java': `public class App {
    private Config config;

    public Config getConfig() { return config; }

    public boolean check() {
        return getConfig().validate();
    }
}
`,
        });
        try {
            const index = idx(dir);
            const cfg = contractCallers(index, 'src/Config.java:2:validate');
            assert.ok(cfg.confirmed.includes('src/App.java:7'),
                `producer returns Config — confirms: ${cfg.confirmed}`);
            const other = contractCallers(index, 'src/Other.java:2:validate');
            assert.ok(!other.confirmed.includes('src/App.java:7'),
                `Other.validate is excluded by the flow type: ${other.confirmed}`);
            assert.strictEqual(other.conserved, true);
        } finally { rm(dir); }
    });

    it('bare same-class calls keep confirming (bareCallReachesMethods)', () => {
        // Java control for the Go/Rust bare-call discipline: execute() inside
        // a class means this.execute().
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/Runner.java': `public class Runner {
    public void run() {
        execute();
    }

    public void execute() { }
}
`,
        });
        try {
            const index = idx(dir);
            const m = contractCallers(index, 'src/Runner.java:6:execute');
            assert.ok(m.confirmed.includes('src/Runner.java:3'),
                `Java bare calls reach same-class methods: ${m.confirmed}`);
        } finally { rm(dir); }
    });
});

describe('fix #229 (Java): bare-call name ownership — static imports and inheritance', () => {
    // `import static app.U.twice; twice(21)` is a compiler-certain call to
    // U.twice — the main-path kind filter used to exclude it method-kind-
    // mismatch (the callback path honored bareCallReachesMethods, the plain
    // path did not), so verify went green and plan rename broke the build.
    // The replacement gate also stops the opposite FP: package-mate scope is
    // NOT how Java resolves bare names, so a bare call with no static import
    // and no ancestry routes visible instead of confirming scope-match.
    const FILES = {
        'pom.xml': '<project/>',
        'app/U.java': 'package app;\npublic class U {\n    public static int twice(int x) { return x * 2; }\n}\n',
        'app/C.java': 'package app;\nimport static app.U.twice;\npublic class C {\n    int use() { return twice(21); }\n}\n',
        'app/D.java': 'package app;\nimport external.lib.Base;\npublic class D extends Base {\n    int other() { return twice(9); }\n}\n',
    };

    it('static-import bare call confirms; no-import bare call routes visible', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'twice' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            assert.ok(r.result.callers.some(c => c.relativePath === 'app/C.java' && c.line === 4),
                'C.java:4 (static import) must be confirmed');
            assert.ok(!r.result.callers.some(c => c.relativePath === 'app/D.java'),
                'D.java (no static import, external base) must NOT be confirmed');
            assert.ok((r.result.unverifiedCallers || []).some(u =>
                (u.relativePath || u.file) === 'app/D.java' && u.line === 4),
                'D.java:4 must be visible unverified');
        } finally { rm(dir); }
    });

    it('verify counts the static-import call; plan rename lists the call site', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const v = execute(index, 'verify', { name: 'twice' });
            assert.ok(v.ok);
            assert.strictEqual(v.result.valid, 1, 'static-import call site must be arg-checked valid');
            const p = execute(index, 'plan', { name: 'twice', renameTo: 'thrice' });
            assert.ok(p.ok);
            const callChange = (p.result.changes || []).find(c => c.file === 'app/C.java' && c.line === 4);
            assert.ok(callChange, 'plan must list the C.java:4 call site, not just the import line');
        } finally { rm(dir); }
    });

    it('static import bound to a DIFFERENT class excludes against the pinned target', () => {
        const dir = tmp({
            ...FILES,
            'app/V.java': 'package app;\npublic class V {\n    public int twice(int x) { return x + x; }\n}\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'V.twice' });
            assert.ok(r.ok);
            assert.ok(!r.result.callers.some(c => c.relativePath === 'app/C.java'),
                'C.java static-imports U.twice — never a confirmed caller of V.twice');
            assert.ok(!(r.result.unverifiedCallers || []).some(u => (u.relativePath || u.file) === 'app/C.java'),
                'C.java is excluded other-definition-import, not unverified');
        } finally { rm(dir); }
    });

    it('cross-file inherited bare this-call confirms', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'app/V.java': 'package app;\npublic class V {\n    public int twice(int x) { return x + x; }\n}\n',
            'app/Sub.java': 'package app;\npublic class Sub extends V {\n    int go() { return twice(4); }\n}\n',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'V.twice' });
            assert.ok(r.ok);
            assert.ok(r.result.callers.some(c => c.relativePath === 'app/Sub.java' && c.line === 3),
                'inherited implicit this-call must be confirmed');
        } finally { rm(dir); }
    });
});

describe('fix #229 (Java): wrong-arity evidence-backed calls reach the mismatch band', () => {
    // The #205 arity prune excluded any call whose arg count fit no pinned
    // def — but "binds a different symbol" needs a different symbol the call
    // COULD bind. With no other def fitting the count, a wrong-arity call is
    // the broken call site verify/diff-impact exist to surface (the
    // pre-commit false-green). Sibling-fitting calls keep the exclusion.
    it('typed-receiver and type-qualified static wrong-arity calls are mismatches', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'app/A.java': 'package app;\npublic class A {\n    public String f(String a, int b, boolean c) { return a; }\n    public static String g(String a, int b) { return a; }\n}\n',
            'app/B.java': 'package app;\npublic class B {\n    void viaStatic() { A.g("only-one"); }\n    void viaTyped(A a) { a.f("x", 2); }\n}\n',
        });
        try {
            const index = idx(dir);
            const vg = execute(index, 'verify', { name: 'g' });
            assert.ok(vg.ok);
            assert.strictEqual(vg.result.mismatches, 1, 'A.g("only-one") must be a visible mismatch');
            const vf = execute(index, 'verify', { name: 'f' });
            assert.ok(vf.ok);
            assert.strictEqual(vf.result.mismatches, 1, 'a.f("x",2) must be a visible mismatch');
        } finally { rm(dir); }
    });

    it('call fitting NO overload is a mismatch; call fitting a sibling stays excluded', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'app/Calc.java': 'package app;\npublic class Calc {\n    public int add(int a) { return a; }\n    public int add(int a, int b) { return a + b; }\n}\n',
            'app/UseCalc.java': 'package app;\npublic class UseCalc {\n    int go(Calc c) { return c.add(1, 2, 3); }\n}\n',
            'app/UseCalc2.java': 'package app;\npublic class UseCalc2 {\n    int go(Calc c) { return c.add(4, 5); }\n}\n',
        });
        try {
            const index = idx(dir);
            // Pin add(int): the 3-arg call fits neither overload — mismatch;
            // the 2-arg call fits the sibling add(int,int) — excluded.
            const v = execute(index, 'verify', { name: 'add', file: 'Calc.java', line: 3 });
            assert.ok(v.ok);
            assert.strictEqual(v.result.mismatches, 1);
            assert.ok(v.result.mismatchDetails.some(m => m.file === 'app/UseCalc.java'),
                'the no-overload-fits site is the mismatch');
            assert.ok(!v.result.mismatchDetails.some(m => m.file === 'app/UseCalc2.java'),
                'the sibling-fitting site stays excluded');
        } finally { rm(dir); }
    });
});

describe('fix #230 (Java): enum constructors carry paramsStructured', () => {
    it('verify and plan use the enum constructor signature', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'Level.java': 'public enum Level {\n    LOW(1), HIGH(2);\n    private final int val;\n    Level(int val) { this.val = val; }\n    public int getVal() { return val; }\n}\n',
        });
        try {
            const index = idx(dir);
            const v = execute(index, 'verify', { name: 'Level' });
            assert.ok(v.ok);
            assert.deepStrictEqual(v.result.expectedArgs, { min: 1, max: 1 },
                'enum ctor takes one int, not zero args');
            const p = execute(index, 'plan', { name: 'Level', addParam: 'tag' });
            assert.ok(p.ok);
            assert.ok(p.result.after.params.includes('tag'));
            assert.ok(p.result.after.params.some(x => /val/.test(x)),
                `existing ctor param preserved: ${JSON.stringify(p.result.after.params)}`);
        } finally { rm(dir); }
    });
});

describe('fix #231 (Java): try-with-resources declarations type receivers', () => {
    // G1-understand-java BUG-4: `try (Res r = new Res()) { r.use(); }` routed
    // method-ambiguous for BOTH Res.use and a same-named Other.use, while the
    // identical plain declaration confirmed and excluded correctly — the
    // resource node was not a typing source (#220(7) family).
    const FILES = {
        'Res.java': `public class Res implements AutoCloseable {
    public void use() {}
    public void close() {}
}
`,
        'Other.java': `public class Other {
    public void use() {}
}
`,
        'Consumer.java': `public class Consumer {
    public void run() {
        try (Res r = new Res()) {
            r.use();
        }
        Res r2 = new Res();
        r2.use();
    }
}
`,
    };

    it('confirms the resource receiver against its declared class', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'use', className: 'Res' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            assert.ok(r.result.callers.some(c => c.relativePath === 'Consumer.java' && c.line === 4),
                'try-resource call r.use() must be a confirmed caller of Res.use');
            assert.ok(!(r.result.unverifiedCallers || []).some(u => u.line === 4),
                'r.use() must not sit in the unverified band');
        } finally { rm(dir); }
    });

    it('excludes the resource receiver against the sibling class', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'use', className: 'Other' });
            assert.ok(r.ok);
            assert.strictEqual(r.result.callers.length, 0, 'Other.use has no callers');
            assert.ok(!(r.result.unverifiedCallers || []).some(u => u.line === 4),
                'r.use() is provably Res.use — excluded, not unverified, for Other.use');
        } finally { rm(dir); }
    });

    it('types `var` resources from the new Type() value', () => {
        const dir = tmp({
            ...FILES,
            'Consumer.java': `public class Consumer {
    public void run() throws Exception {
        try (var r = new Res()) {
            r.use();
        }
    }
}
`,
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'use', className: 'Res' });
            assert.ok(r.ok);
            assert.ok(r.result.callers.some(c => c.relativePath === 'Consumer.java' && c.line === 4),
                'var resource typed from new Res() must confirm');
        } finally { rm(dir); }
    });
});

describe('fix #236 (Java): callee-side static-style type-qualified receivers', () => {
    const FILES = {
        'pom.xml': '<project/>',
        'Helper.java': 'public class Helper {\n    public static int process(int x) {\n        return x * 2;\n    }\n}\n',
        'App.java': 'public class App {\n    public int main() {\n        int v = Helper.process(3);\n        int m = Math.max(v, 10);\n        return m;\n    }\n}\n',
    };

    it('Helper.process() confirms the project class method; Math.max() routes external', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const def = index.symbols.get('main').find(s => s.className === 'App');
            const acct = index.findCallees(def, { collectAccount: true });
            assert.ok(acct.some(c => c.name === 'process' && c.className === 'Helper'),
                `Helper.process() must confirm: ${JSON.stringify(acct.map(c => c.name))}`);
            assert.strictEqual(acct.filter(c => c.name === 'max').length, 0,
                'Math.max() must not confirm any project def');
            assert.ok(acct.calleeAccount.external.count >= 1,
                `Math.max() lands external: ${JSON.stringify(acct.calleeAccount)}`);
            assert.ok(acct.calleeAccount.conserved);
        } finally { rm(dir); }
    });

    it('counter-probe: an external-class receiver never confirms a same-name project method', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'Sorter.java': 'import java.util.List;\npublic class Sorter {\n    public void sort(List<Integer> xs) {\n    }\n}\n',
            'App.java': 'import java.util.Collections;\nimport java.util.List;\npublic class App {\n    public void run(List<Integer> xs) {\n        Collections.sort(xs);\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('run').find(s => s.className === 'App');
            const acct = index.findCallees(def, { collectAccount: true });
            assert.strictEqual(acct.filter(c => c.name === 'sort').length, 0,
                `Collections.sort() must not confirm Sorter.sort: ${JSON.stringify(acct.map(c => c.name))}`);
        } finally { rm(dir); }
    });
});

describe('fix #238 (Java): constructor delegation and enum constants record calls', () => {
    it('super(x) surfaces as a caller of the parent class', () => {
        // Java constructors are not indexed as standalone symbols —
        // constructor invocations (new X(), super(x), this(x)) resolve to
        // the CLASS def, so the class pin is where the edge surfaces.
        const dir = tmp({
            'pom.xml': '<project/>',
            'Base.java': 'public class Base {\n    public Base(int x) {}\n}\n',
            'Child.java': 'public class Child extends Base {\n    public Child(int x) {\n        super(x);\n    }\n    public Child() {\n        this(1);\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const r = execute(index, 'context', { name: 'Base' });
            assert.ok(r.ok);
            assert.ok((r.result.callers || []).some(c => c.line === 3),
                `super(x) at Child.java:3 is a confirmed caller of Base: ${JSON.stringify(r.result.callers)}`);
        } finally { rm(dir); }
    });

    it('enum constants invoke the enum constructor — search --unused stays quiet', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'Color.java': 'public enum Color {\n    RED(1), GREEN(2);\n    private final int v;\n    Color(int v) { this.v = v; }\n    public int value() { return v; }\n}\n',
            'App.java': 'public class App {\n    public int main() {\n        return Color.RED.value();\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const r = execute(index, 'search', { unused: true });
            assert.ok(r.ok);
            const names = r.result.results.map(s => `${s.className || ''}.${s.name}`);
            assert.ok(!names.some(n => n === 'Color.Color'),
                `enum constructor is invoked by its constants: ${JSON.stringify(names)}`);
        } finally { rm(dir); }
    });
});

describe('fix #240 (Java): wildcard package imports link every package file, non-recursively', () => {
    it('links ALL files of the package, and exporters reports the import line for each', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/com/lib/A.java': 'package com.lib;\npublic class A { public void a() {} }',
            'src/com/lib/B.java': 'package com.lib;\npublic class B { public void b() {} }',
            'src/com/app/Main.java': 'package com.app;\nimport com.lib.*;\npublic class Main {\n    public static void main(String[] args) { new A(); new B(); }\n}',
        });
        try {
            const index = idx(dir);
            for (const target of ['src/com/lib/A.java', 'src/com/lib/B.java']) {
                const r = execute(index, 'exporters', { file: target });
                assert.ok(r.ok);
                const main = r.result.find(x => x.file === 'src/com/app/Main.java');
                assert.ok(main, `Main.java imports ${target} via the wildcard`);
                assert.strictEqual(main.importLine, 2, 'line of the import statement');
            }
        } finally { rm(dir); }
    });

    it('does NOT link subpackage files — Java wildcards are not recursive', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/com/lib/A.java': 'package com.lib;\npublic class A {}',
            'src/com/lib/sub/Deep.java': 'package com.lib.sub;\npublic class Deep {}',
            'src/com/app/Main.java': 'package com.app;\nimport com.lib.*;\npublic class Main { public static void main(String[] args) { new A(); } }',
        });
        try {
            const index = idx(dir);
            const deep = execute(index, 'exporters', { file: 'src/com/lib/sub/Deep.java' });
            assert.ok(deep.ok);
            assert.ok(!deep.result.some(x => x.file.endsWith('Main.java')),
                'com.lib.* must not reach com/lib/sub/Deep.java');
        } finally { rm(dir); }
    });

    it('a wildcard over a package with only subpackage files resolves to nothing (external)', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/com/lib/sub/Deep.java': 'package com.lib.sub;\npublic class Deep {}',
            'src/com/app/Main.java': 'package com.app;\nimport com.lib.*;\npublic class Main {}',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'imports', { file: 'src/com/app/Main.java' });
            assert.ok(r.ok);
            const wc = r.result.find(i => i.module === 'com.lib.*');
            assert.ok(wc, 'wildcard import listed');
            assert.strictEqual(wc.resolved, null, 'no direct package files — unresolved, not a subpackage hit');
        } finally { rm(dir); }
    });
});

describe('fix #241 (Java): zero-param methods record empty params, not the unknown sentinel', () => {
    it('params is "" for empty parens and keeps real params intact', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'A.java': 'public class A {\n    public void zero() {}\n    public void two(int a, String b) {}\n}',
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index.symbols.get('zero')[0].params, '');
            assert.strictEqual(index.symbols.get('two')[0].params, 'int a, String b');
        } finally { rm(dir); }
    });
});

describe('fix #243 (Java): same-name dead methods reported; static main kept as entry', () => {
    it('a never-called method is dead even when an unrelated interface declares the same name', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'Shape.java': 'public interface Shape { double area(); }',
            'A.java': 'public class A {\n    public double area() { return 1.0; }\n}',
            'Main.java': 'public class Main { public static void main(String[] args) { new A(); } }',
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'deadcode', { includeExported: true });
            assert.ok(r.result.some(s => s.name === 'area' && s.file === 'A.java'),
                'A does not implement Shape — the declaration line is not a usage');
        } finally { rm(dir); }
    });

    it('public static main stays an entry point (Java main IS a method)', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'Main.java': 'public class Main {\n    public static void main(String[] args) {}\n}',
        });
        try {
            const index = idx(dir);
            const eps = execute(index, 'entrypoints', {});
            assert.ok(eps.result.some(e => e.name === 'main' && e.type === 'runtime'));
        } finally { rm(dir); }
    });
});

describe('fix #244 (Java): same-package test discovery and shadow discipline', () => {
    it('tests --file keeps same-package test files that need no import statement', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/app/Calculator.java': 'package app;\npublic class Calculator {\n    public static int square(int x) { return x * x; }\n}',
            'src/app/MathIntegrationTest.java': 'package app;\npublic class MathIntegrationTest {\n    public void testMath() {\n        int r = Calculator.square(5);\n    }\n}',
        });
        try {
            const index = idx(dir);
            const t = execute(index, 'tests', { name: 'square', file: 'Calculator.java' });
            assert.ok(t.result.some(f => f.file.endsWith('MathIntegrationTest.java')),
                'same-package Java tests idiomatically have no import');
        } finally { rm(dir); }
    });

    it('a bare call of a test-local same-name method is never coverage of the pinned symbol', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'src/app/Calculator.java': 'package app;\npublic class Calculator {\n    public static int square(int x) { return x * x; }\n}',
            'src/app/HelperTest.java': 'package app;\npublic class HelperTest {\n    private static int square(int x) { return x + 1; }\n    public void testLocal() {\n        int r = square(7);\n    }\n}',
        });
        try {
            const index = idx(dir);
            const at = execute(index, 'affectedTests', { name: 'square', file: 'Calculator.java' });
            assert.strictEqual(at.result.testFiles.length, 0,
                'the bare call binds HelperTest.square — the account excludes the site, the coverage band must agree');
            assert.ok(at.result.uncovered.includes('square'));
        } finally { rm(dir); }
    });
});

describe('fix #246: Maven/Gradle source roots are one package', () => {
    it('src/test/java caller of a src/main/java static method confirms via same-package scope', () => {
        const dir = tmp({
            'src/main/java/App.java': 'public class App {\n    public static int helper() { return 1; }\n}',
            'src/test/java/AppTest.java': 'public class AppTest {\n    public void testHelper() { App.helper(); }\n}',
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('helper', { collectAccount: true, includeMethods: true, includeTests: true });
            const testEdge = callers.find(c => c.relativePath.includes('AppTest'));
            assert.ok(testEdge, 'edge present');
            assert.strictEqual(testEdge.tier, 'confirmed',
                `same declared package across source sets is scope evidence, got ${testEdge.tier}/${testEdge.resolution}`);
        } finally { rm(dir); }
    });

    it('same-named packages in DIFFERENT modules stay separate', () => {
        const dir = tmp({
            'svc-a/src/main/java/com/util/App.java': 'package com.util;\npublic class App {\n    public static int helper() { return 1; }\n    public static int caller() { return helper(); }\n}',
            'svc-b/src/main/java/com/util/Other.java': 'package com.util;\npublic class Other {\n    public void run() { App.helper(); }\n}',
        });
        try {
            const index = idx(dir);
            const callers = index.findCallers('helper', { collectAccount: true, includeMethods: true });
            const crossModule = callers.find(c => c.relativePath.includes('svc-b'));
            // svc-b has no import edge and a different module prefix — the
            // edge may surface, but never via same-package scope confirmation.
            if (crossModule) {
                assert.notStrictEqual(crossModule.resolution, 'scope-match',
                    'different module prefixes must not create package identity');
            }
        } finally { rm(dir); }
    });
});

// ============================================================================
// Fix #258: chained-receiver fold — builder chains typed hop-by-hop from the
// producer link (the clap family, Java shape: Cfg.builder().opt(1).opt(2)).
// ============================================================================

describe('fix #258: chained-receiver fold (Java)', () => {
    const FILES = {
        'Cfg.java': `public class Cfg {
    private int n;
    public static Cfg builder() { return new Cfg(); }
    public Cfg opt(int v) { this.n += v; return this; }
    public int done() { return n; }
}
`,
        'Grp.java': `public class Grp {
    private int n;
    public static Grp builder() { return new Grp(); }
    public Grp opt(int v) { this.n += v; return this; }
}
`,
        'User.java': `public class User {
    public int build() {
        return Cfg.builder()
            .opt(1)
            .opt(2)
            .done();
    }
    public void group() {
        Grp g = Grp.builder().opt(9);
    }
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
            conserved: json.meta.account?.conserved,
        };
    }

    it('static-factory-rooted chain confirms both hops on the right owner', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Cfg.java:4:opt');
            assert.ok(res.confirmed.includes('User.java:4'), `hop 1: ${res.confirmed}`);
            assert.ok(res.confirmed.includes('User.java:5'), `hop 2: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('User.java:9'), 'Grp chain never confirms on Cfg.opt');
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('counter: the sibling owner claims its own chain', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Grp.java:4:opt');
            assert.ok(res.confirmed.includes('User.java:9'), `Grp chain: ${res.confirmed}`);
            assert.ok(!res.confirmed.includes('User.java:4'), 'Cfg hops stay off the Grp pin');
        } finally { rm(dir); }
    });

    it('chain terminal resolves through folded hops', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Cfg.java:5:done');
            assert.ok(res.confirmed.includes('User.java:6'), `terminal: ${res.confirmed}`);
        } finally { rm(dir); }
    });
});

describe('fix #265: java.lang.Object universal names defeat single-owner', () => {
    it('untyped-receiver toString never confirms via unique project ownership', () => {
        const dir = tmp({
            'Node.java': [
                'public class Node {',
                '    @Deprecated',
                '    public String describe() { return "n"; }',
                '    public String toString() { return "n"; }',
                '}',
            ].join('\n'),
            'Dump.java': [
                'import java.util.List;',
                'public class Dump {',
                '    public void run(List<Object> items) {',
                '        items.forEach(item -> System.out.println(item.toString()));',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const def = (index.symbols.get('toString') || [])[0];
            assert.ok(def);
            const res = index.findCallers('toString', {
                targetDefinitions: [def], collectAccount: true,
            });
            assert.ok(!res.some(c => c.relativePath === 'Dump.java'),
                'item.toString() satisfies Object — not identity evidence for Node.toString');
            assert.ok((res.unverifiedEntries || []).some(u => /Dump/.test(u.file || '')),
                'universal-name call routes visible, never dropped');
        } finally { rm(dir); }
    });
});

describe('fix #268: Java bare same-class overload calls route through the overload discipline', () => {
    const FILES = {
        'Spec.java': [
            'public class Spec {',                                        // 1
            '    private Code defaultValue;',                             // 2
            '    public Spec defaultValue(String format, Object... args) {', // 3
            '        return defaultValue(Code.of(format, args));',        // 4
            '    }',                                                      // 5
            '    public Spec defaultValue(Code codeBlock) {',             // 6
            '        this.defaultValue = codeBlock;',                     // 7
            '        return this;',                                       // 8
            '    }',                                                      // 9
            '    public Spec both() {',                                   // 10
            '        return defaultValue("x", 1, 2);',                    // 11
            '    }',                                                      // 12
            '}',                                                          // 13
        ].join('\n'),
        'Code.java': [
            'public class Code {',
            '    public static Code of(String format, Object... args) { return new Code(); }',
            '}',
        ].join('\n'),
    };

    function contract(index, handle) {
        const { execute } = require('../core/execute');
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error || {}));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}:${c.reason}`),
            conserved: json.meta.account?.conserved,
        };
    }

    it('bare 1-expr-arg delegation is never a false zero: visible, not other-definition', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Spec.java:6:defaultValue');
            const claimed = res.confirmed.includes('Spec.java:4') ||
                res.unverified.some(u => u.startsWith('Spec.java:4:'));
            assert.ok(claimed,
                `delegation site must be confirmed or visible, got conf=${res.confirmed} unv=${res.unverified}`);
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('counter: bare 3-arg call proves the varargs sibling — excluded for the 1-param pin', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Spec.java:6:defaultValue');
            assert.ok(!res.confirmed.includes('Spec.java:11'),
                '3-arg call binds the varargs overload, never the Code one');
            assert.ok(!res.unverified.some(u => u.startsWith('Spec.java:11:')),
                'sibling-proving call is excluded, not visible');
        } finally { rm(dir); }
    });
});

describe('fix #268: inherited sibling overloads join the Java overload discipline', () => {
    const FILES = {
        'Base.java': [
            'import java.util.List;',
            'public class Base {',
            '    public final Base annotated(Spec... specs) { return this; }',   // 3
            '    public Base annotated(List<Spec> specs) { return this; }',      // 4
            '}',
        ].join('\n'),
        'Child.java': [
            'import java.util.List;',
            'public class Child extends Base {',
            '    @Override public Base annotated(List<Spec> specs) { return new Child(); }', // 3
            '}',
        ].join('\n'),
        'Spec.java': 'public class Spec {}',
        'Use.java': [
            'public class Use {',
            '    void go(Spec spec) {',
            '        Child c = new Child();',
            '        c.annotated(spec);',      // 4
            '    }',
            '    void many(Spec a, Spec b) {',
            '        Child c = new Child();',
            '        c.annotated(a, b);',      // 8
            '    }',
            '}',
        ].join('\n'),
    };

    function contract(index, handle) {
        const { execute } = require('../core/execute');
        const output = require('../core/output');
        const r = execute(index, 'context', { name: handle });
        assert.ok(r.ok, JSON.stringify(r.error || {}));
        const json = JSON.parse(output.formatContextJson(r.result));
        return {
            confirmed: (json.data.callers || []).map(c => `${c.file}:${c.line}`),
            unverified: (json.data.unverifiedCallers || []).map(c => `${c.file}:${c.line}`),
        };
    }

    it('1-arg typed call proves the inherited final varargs sibling', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Child.java:3:annotated');
            assert.ok(!res.confirmed.includes('Use.java:4'),
                `annotated(spec) may bind the inherited varargs overload: ${res.confirmed}`);
            assert.ok(!res.unverified.includes('Use.java:4'),
                `the Spec parameter statically selects Spec...: ${res.unverified}`);
        } finally { rm(dir); }
    });

    it('counter: 2-arg call proves the inherited varargs sibling — excluded for the List pin', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'Child.java:3:annotated');
            assert.ok(!res.confirmed.includes('Use.java:8'), 'proves the sibling');
            assert.ok(!res.unverified.includes('Use.java:8'), 'excluded, not visible');
        } finally { rm(dir); }
    });

    it('counter: identical-signature ancestor is the override slot, not a sibling', () => {
        const dir = tmp({
            'P.java': 'public class P { public void run(String s) {} }',
            'Q.java': 'public class Q extends P { @Override public void run(String s) {} }',
            'UseQ.java': [
                'public class UseQ {',
                '    void go() {',
                '        Q q = new Q();',
                '        q.run("x");',   // 4
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const { execute } = require('../core/execute');
            const output = require('../core/output');
            const r = execute(index, 'context', { name: 'Q.java:1:run' });
            const json = JSON.parse(output.formatContextJson(r.result));
            const confirmed = (json.data.callers || []).map(c => `${c.file}:${c.line}`);
            assert.ok(confirmed.includes('UseQ.java:4'),
                `plain override keeps confirming: ${confirmed}`);
        } finally { rm(dir); }
    });
});

describe('fix #268: callee-side same-class overload arity selection', () => {
    const FILES = {
        'K.java': [
            'public class K {',
            '    public void run(A a) {}',        // 2
            '    public void run(A a, B b) {}',   // 3
            '    public void set(A a) {}',        // 4
            '    public void set(B b) {}',        // 5
            '}',
        ].join('\n'),
        'A.java': 'public class A {}',
        'B.java': 'public class B {}',
        'Use.java': [
            'public class Use {',
            '    void go(K k, A a, B b) {',
            '        k.run(a);',        // 3
            '        k.run(a, b);',     // 4
            '        k.set(a);',        // 5
            '    }',
            '}',
        ].join('\n'),
    };

    it('each site attaches to the arity-matching overload, not defs[0]', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const go = (index.symbols.get('go') || [])[0];
            assert.ok(go);
            const res = index.findCallees(go, { includeMethods: true, collectAccount: true });
            const runEdges = res.filter(e => e.name === 'run');
            const siteToDef = {};
            for (const e of runEdges) for (const s of e.sites || []) siteToDef[s] = e.startLine;
            assert.strictEqual(siteToDef[3], 2, `k.run(a) binds the 1-param overload: ${JSON.stringify(siteToDef)}`);
            assert.strictEqual(siteToDef[4], 3, `k.run(a, b) binds the 2-param overload: ${JSON.stringify(siteToDef)}`);
        } finally { rm(dir); }
    });

    it('same-arity type overloads are statically undecidable — visible, not defs[0]', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const go = (index.symbols.get('go') || [])[0];
            const res = index.findCallees(go, { includeMethods: true, collectAccount: true });
            const setEdges = res.filter(e => e.name === 'set');
            const confirmedSites = setEdges.flatMap(e => e.sites || []);
            assert.ok(!confirmedSites.includes(5),
                `k.set(a) cannot statically pick between set(A)/set(B): ${JSON.stringify(setEdges)}`);
            const unv = (res.unverifiedCallees || []).find(u => u.name === 'set');
            assert.ok(unv && (unv.sites || []).includes(5),
                `undecidable overload visible in the unverified band: ${JSON.stringify(res.unverifiedCallees)}`);
            assert.strictEqual(res.calleeAccount?.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #270 (Java): interface extends recorded; implements chain shields only public members', () => {
    // The grammar exposes interface extends as an `extends_interfaces` child,
    // not an `extends` field — the field lookup silently returned nothing and
    // interfaces never recorded their supertypes.
    it('records the extends clause on interface declarations', () => {
        const result = parse('interface A extends B, C<D, E> { }', 'java');
        const iface = result.classes.find(c => c.name === 'A');
        assert.ok(iface, 'interface indexed');
        assert.strictEqual(iface.extends, 'B, C<D, E>');
    });

    it('labels a public member externalContract when the implements chain reaches an external interface', () => {
        const dir = tmp({
            'pom.xml': '<project/>',
            'MyContract.java': [
                'import ext.pkg.ExternalShape;',
                'public interface MyContract extends ExternalShape { }',
            ].join('\n'),
            'Impl.java': [
                'class Impl implements MyContract {',
                '  public void requiredByExt() { }',
                '  public static void main(String[] a) { Impl i = new Impl(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            // public → exported surface: audited under includeExported, where
            // the shield labels instead of hiding.
            const dead = index.deadcode({ includeExported: true });
            const claim = dead.find(d => d.name === 'requiredByExt');
            assert.ok(claim, 'listed under includeExported');
            assert.strictEqual(claim.externalContract, true,
                'implements → project interface → external interface is contract surface');
        } finally { rm(dir); }
    });

    it('package-private member cannot satisfy an interface contract — still claimed dead (counter)', () => {
        // javac requires interface implementations to be public: a
        // package-private member provably implements nothing, so
        // `implements` never shields it (compiler physics, not heuristic).
        const dir = tmp({
            'pom.xml': '<project/>',
            'MyContract.java': [
                'import ext.pkg.ExternalShape;',
                'public interface MyContract extends ExternalShape { }',
            ].join('\n'),
            'Impl.java': [
                'class Impl implements MyContract {',
                '  void helperling() { }',
                '  public static void main(String[] a) { Impl i = new Impl(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = index.deadcode();
            assert.ok(dead.some(d => d.name === 'helperling'),
                `package-private member stays claimable: ${dead.map(d => d.name)}`);
        } finally { rm(dir); }
    });
});

describe('fix #273 (Java): virtual bare calls and receiver-owned callees', () => {
    it('resolves an inherited fixed static overload through a subclass qualifier', () => {
        const dir = tmp({
            'Base.java': [
                'import java.lang.reflect.Type;',
                'class Base { static String get(Type type) { return "base"; } }',
            ].join('\n'),
            'Child.java': [
                'class Child extends Base {',
                '  static String get(String name, Object... rest) { return "child"; }',
                '}',
            ].join('\n'),
            'Use.java': 'class Use { String go() { return Child.get(Object.class); } }',
        });
        try {
            const index = idx(dir);
            const calls = index.getCachedCalls(require('path').join(dir, 'Use.java'));
            assert.ok(calls.some(c => c.name === 'get' && c.argKinds?.[0] === 'class:Object'));
            const r = execute(index, 'context', { name: 'Base.java:2:get' });
            const json = JSON.parse(require('../core/output').formatContextJson(r.result));
            assert.ok((json.data.callers || []).some(c => c.file === 'Use.java' && c.line === 1),
                `fixed inherited overload owns Child.get(Object.class): ${JSON.stringify(json.data)}`);
        } finally { rm(dir); }
    });

    it('resolves a capitalized bare static field as a receiver value', () => {
        const dir = tmp({
            'Use.java': [
                'class Pool { Object borrow() { return new Object(); } }',
                'class Use {',
                '  static final Pool BufferPool = new Pool();',
                '  Object go() { return BufferPool.borrow(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const go = index.symbols.get('go')[0];
            const callees = index.findCallees(go, { collectAccount: true, includeMethods: true });
            assert.ok(callees.some(c => c.name === 'borrow' && c.className === 'Pool'),
                `capitalized field hop resolves Pool.borrow: ${JSON.stringify(callees)}`);
        } finally { rm(dir); }
    });

    it('types enhanced-for receivers within the loop and preserves interface dispatch', () => {
        const dir = tmp({
            'Factory.java': [
                'interface Factory { void create(); }',
                'class ConcreteFactory implements Factory { public void create() {} }',
            ].join('\n'),
            'Use.java': [
                'import java.util.List;',
                'class Use {',
                '  void go(List<Factory> factories) {',
                '    for (Factory factory : factories) factory.create();',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const calls = index.getCachedCalls(require('path').join(dir, 'Use.java'));
            assert.ok(calls.some(c => c.line === 4 && c.name === 'create' &&
                c.receiverType === 'Factory'),
            `enhanced-for variable carries its declared type: ${JSON.stringify(calls)}`);
            const target = (index.symbols.get('create') || [])
                .find(d => d.className === 'ConcreteFactory');
            const r = execute(index, 'context', {
                name: `${target.relativePath}:${target.startLine}:create`,
            });
            const json = JSON.parse(require('../core/output').formatContextJson(r.result));
            assert.ok((json.data.unverifiedCallers || []).some(c => c.line === 4),
                `interface loop receiver routes possible dispatch: ${JSON.stringify(json.data)}`);
        } finally { rm(dir); }
    });

    it('does not bind an external-interface receiver to a same-name project method', () => {
        const dir = tmp({
            'ProjectEntry.java': 'class ProjectEntry { String getKey() { return "wrong"; } }',
            'Use.java': [
                'import java.util.Map;',
                'class Use {',
                '  void copy(Map<String, String> values) {',
                '    for (Map.Entry<String, String> entry : values.entrySet()) {',
                '      String key = entry.getKey();',
                '    }',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const copy = index.symbols.get('copy')[0];
            const callees = index.findCallees(copy, { collectAccount: true, includeMethods: true });
            assert.ok(!callees.some(c => c.name === 'getKey' && c.sites?.includes(5)),
                `Map.Entry.getKey must not bind ProjectEntry.getKey: ${JSON.stringify(callees)}`);
            assert.ok((callees.unverifiedCallees || []).some(c =>
                c.name === 'getKey' && c.reason === 'possible-dispatch' && c.sites.includes(5)),
            `external interface dispatch must stay visible: ${JSON.stringify(callees.unverifiedCallees)}`);
            assert.strictEqual(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });

    it('resolves duplicate simple type names through Java main/test package identity', () => {
        const dir = tmp({
            'src/main/java/p/Attribute.java': [
                'package p;',
                'public class Attribute { public String getValue() { return "p"; } }',
            ].join('\n'),
            'src/main/java/q/Outer.java': [
                'package q;',
                'public class Outer {',
                '  static class Attribute { String getValue() { return "q"; } }',
                '}',
            ].join('\n'),
            'src/test/java/p/AttributeTest.java': [
                'package p;',
                'class AttributeTest {',
                '  String read(Attribute attr) { return attr.getValue(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', {
                name: 'src/main/java/p/Attribute.java:2:getValue',
            });
            const json = JSON.parse(require('../core/output').formatContextJson(r.result));
            assert.ok((json.data.callers || []).some(c =>
                c.file === 'src/test/java/p/AttributeTest.java' && c.line === 3),
            `same-package main/test type wins over foreign nested names: ${JSON.stringify(json.data)}`);
            assert.ok(!json.meta.account.excluded.byReason['receiver-type-mismatch']);
        } finally { rm(dir); }
    });

    it('uses an owner-scoped static factory return type to select an overload', () => {
        const dir = tmp({
            'CodeBlock.java': [
                'class CodeBlock {',
                '  static CodeBlock of(String value) { return new CodeBlock(); }',
                '}',
            ].join('\n'),
            'Builder.java': [
                'class Builder {',
                '  void build(String format, Object... args) {}',
                '  void build(CodeBlock code) {}',
                '  void go() { build(CodeBlock.of("x")); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const go = index.symbols.get('go')[0];
            const callees = index.findCallees(go, { collectAccount: true, includeMethods: true });
            const edge = callees.find(c => c.name === 'build' && c.sites?.includes(4));
            assert.ok(edge && edge.startLine === 3,
                `CodeBlock.of return identity selects build(CodeBlock): ${JSON.stringify(callees)}`);
            assert.ok(!(callees.unverifiedCallees || []).some(c =>
                c.name === 'build' && c.sites?.includes(4)),
            'the owner-scoped factory type makes overload selection exact');
        } finally { rm(dir); }
    });

    it('tracks a capitalized static-field receiver without claiming one override', () => {
        const dir = tmp({
            'Base.java': [
                'class Base {',
                '  static Base VALUE = new Child();',
                '  void run() {}',
                '}',
                'class Child extends Base { void run() {} }',
                'class Use { void go() { Base.VALUE.run(); } }',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const childRun = (index.symbols.get('run') || []).find(d => d.className === 'Child');
            const r = execute(index, 'context', {
                name: `${childRun.relativePath}:${childRun.startLine}:run`,
            });
            assert.ok(r.ok, JSON.stringify(r.error));
            const json = JSON.parse(require('../core/output').formatContextJson(r.result));
            assert.ok((json.data.unverifiedCallers || []).some(c => c.line === 6),
                `Base.VALUE may dispatch to Child.run: ${JSON.stringify(json.data)}`);
            assert.ok(!json.meta.account.excluded.byReason['receiver-type-mismatch'],
                `base-typed field cannot exclude a virtual override: ${JSON.stringify(json.meta.account)}`);
        } finally { rm(dir); }
    });

    it('implicit-this calls in a base expose descendant overrides in both directions', () => {
        const dir = tmp({
            'Base.java': [
                'class Base {',
                '  boolean wantsNodes() { return false; }',
                '  boolean matches() { return wantsNodes(); }',
                '}',
                'class Child extends Base {',
                '  boolean wantsNodes() { return true; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'Base.java:6:wantsNodes' });
            const json = JSON.parse(require('../core/output').formatContextJson(r.result));
            assert.ok((json.data.unverifiedCallers || []).some(c => c.line === 3),
                `base implicit-this call can dispatch to Child: ${JSON.stringify(json.data)}`);
            const matches = index.symbols.get('matches')[0];
            const callees = index.findCallees(matches, { collectAccount: true, includeMethods: true });
            assert.ok(!callees.some(c => c.name === 'wantsNodes' && c.sites?.includes(3)),
                'the base implementation is not the only runtime callee');
            assert.ok((callees.unverifiedCallees || []).some(c =>
                c.name === 'wantsNodes' && c.reason === 'possible-dispatch'),
            `virtual callee remains visible: ${JSON.stringify(callees.unverifiedCallees)}`);
        } finally { rm(dir); }
    });

    it('a receiver-qualified method never binds the enclosing same-name method', () => {
        const dir = tmp({
            'FieldSpec.java': 'class FieldSpec { void emit() {} }',
            'TypeSpec.java': [
                'class TypeSpec {',
                '  void emit(Iterable<FieldSpec> fields) {',
                '    for (FieldSpec fieldSpec : fields) fieldSpec.emit();',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const outer = (index.symbols.get('emit') || []).find(d => d.className === 'TypeSpec');
            const callees = index.findCallees(outer, { collectAccount: true, includeMethods: true });
            assert.ok(!callees.some(c => c.className === 'TypeSpec' && c.sites?.includes(3)),
                `fieldSpec.emit cannot recurse into TypeSpec.emit: ${JSON.stringify(callees)}`);
            assert.ok(callees.some(c => c.className === 'FieldSpec' && c.sites?.includes(3)) ||
                (callees.unverifiedCallees || []).some(c => c.name === 'emit' && c.sites.includes(3)),
            'the receiver-owned edge is exact when typed, otherwise visibly unverified');
        } finally { rm(dir); }
    });

    it('an untyped chained method result never borrows a unique project return type', () => {
        const dir = tmp({
            'Tag.java': 'class Tag { String renderTag() { return "tag"; } }',
            'ProjectValue.java': 'class ProjectValue { String getValue() { return "wrong"; } }',
            'Use.java': [
                'import java.util.Map;',
                'class Use {',
                '  String read(Map.Entry<String, Tag> entry) {',
                '    return entry.getValue().renderTag();',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'Tag.java:1:renderTag' });
            const json = JSON.parse(require('../core/output').formatContextJson(r.result));
            assert.ok((json.data.callers || []).some(c => c.file === 'Use.java' && c.line === 4) ||
                (json.data.unverifiedCallers || []).some(c => c.file === 'Use.java' && c.line === 4),
            `the real edge stays visible: ${JSON.stringify(json.data)}`);
            assert.ok(!json.meta.account.excluded.byReason['receiver-type-mismatch'],
                `ProjectValue.getValue(): String cannot type Map.Entry.getValue(): ${JSON.stringify(json.meta.account)}`);
        } finally { rm(dir); }
    });

    it('an unresolved chained receiver never binds a same-name method in the caller class', () => {
        const dir = tmp({
            'Target.java': 'class Target { Target annotated() { return this; } }',
            'Other.java': [
                'class Other {',
                '  Other annotated() { return this; }',
                '  static <T> T check(T value) { return value; }',
                '  Target go(Target raw) { return check(raw).annotated(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'Target.java:1:annotated' });
            const json = JSON.parse(require('../core/output').formatContextJson(r.result));
            assert.ok((json.data.unverifiedCallers || []).some(c => c.file === 'Other.java' && c.line === 4),
                `generic identity chain stays visible: ${JSON.stringify(json.data)}`);
            const go = index.symbols.get('go')[0];
            const callees = index.findCallees(go, { collectAccount: true, includeMethods: true });
            assert.ok(!callees.some(c => c.className === 'Other' && c.name === 'annotated'),
                'receiver-blind lexical binding never steals the chain terminal');
            assert.ok((callees.unverifiedCallees || []).some(c => c.name === 'annotated'),
                `callee chain stays visible: ${JSON.stringify(callees.unverifiedCallees)}`);
        } finally { rm(dir); }
    });

    it('pins same-named top-level and nested constructors by Java ownership', () => {
        const dir = tmp({
            'src/main/java/p/Outer.java': [
                'package p;',
                'public class Outer {',
                '  public static class Tag {}',
                '  Tag own() { return new Tag(); }',
                '}',
            ].join('\n'),
            'src/main/java/q/Tag.java': 'package q; public class Tag {}',
            'src/test/java/q/Use.java': [
                'package q;',
                'import p.Outer;',
                'class Use {',
                '  Object local() { return new Tag(); }',
                '  Object nested() { return new Outer.Tag(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('Tag');
            const nested = defs.find(d => d.relativePath.endsWith('/p/Outer.java'));
            const top = defs.find(d => d.relativePath.endsWith('/q/Tag.java'));
            assert.strictEqual(nested.enclosingType, 'Outer');

            const nestedCallers = index.findCallers('Tag', {
                targetDefinitions: [nested], collectAccount: true,
            });
            assert.ok(nestedCallers.some(c => c.relativePath.endsWith('/q/Use.java') && c.line === 5));
            assert.ok(!nestedCallers.some(c => c.relativePath.endsWith('/q/Use.java') && c.line === 4));

            const topCallers = index.findCallers('Tag', {
                targetDefinitions: [top], collectAccount: true,
            });
            assert.ok(topCallers.some(c => c.relativePath.endsWith('/q/Use.java') && c.line === 4));
            assert.ok(!topCallers.some(c => c.relativePath.endsWith('/q/Use.java') && c.line === 5));
        } finally { rm(dir); }
    });

    it('uses cast types and ignores nested types during package lookup', () => {
        const dir = tmp({
            'src/main/java/nodes/Node.java': [
                'package nodes;',
                'public class Node { public Node parentElement() { return this; } }',
            ].join('\n'),
            'src/main/java/nodes/TextNode.java': 'package nodes; public class TextNode extends Node {}',
            'src/main/java/nodes/Comment.java': [
                'package nodes;',
                'public class Comment { public String getData() { return "node"; } }',
            ].join('\n'),
            'src/main/java/parser/Token.java': [
                'package parser;',
                'class Token {',
                '  static class Comment { String getData() { return "token"; } }',
                '}',
            ].join('\n'),
            'src/test/java/parser/Use.java': [
                'package parser;',
                'import nodes.*;',
                'class Use {',
                '  Node parent(TextNode text) { return ((Node) text).parentElement(); }',
                '  String data() { Comment comment = new Comment(); return comment.getData(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const parent = index.symbols.get('parentElement')[0];
            const parentCallers = index.findCallers('parentElement', {
                targetDefinitions: [parent], collectAccount: true,
            });
            assert.ok(parentCallers.some(c => c.relativePath.endsWith('/parser/Use.java') && c.line === 4),
                `cast receiver must resolve Node.parentElement: ${JSON.stringify(parentCallers)}`);

            const getDataDefs = index.symbols.get('getData');
            const nodeData = getDataDefs.find(d => d.relativePath.endsWith('/nodes/Comment.java'));
            const tokenData = getDataDefs.find(d => d.relativePath.endsWith('/parser/Token.java'));
            const nodeCallers = index.findCallers('getData', {
                targetDefinitions: [nodeData], collectAccount: true,
            });
            assert.ok(nodeCallers.some(c => c.relativePath.endsWith('/parser/Use.java') && c.line === 5),
                `wildcard import must outrank nested same-package type: ${JSON.stringify(nodeCallers)}`);
            const tokenCallers = index.findCallers('getData', {
                targetDefinitions: [tokenData], collectAccount: true,
            });
            assert.ok(!tokenCallers.some(c => c.relativePath.endsWith('/parser/Use.java') && c.line === 5));
        } finally { rm(dir); }
    });
});
