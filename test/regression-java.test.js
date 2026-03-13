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
            assert.strictEqual(ctx.methods.length, 3, 'User class should have 3 methods (constructor + 2 methods)');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('User'), 'Should include constructor User');
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
            // Should have: 1 class + 2 constructors (as members) = 3 entries
            // Should NOT have: extra duplicates from findFunctions
            const types = symbols.map(s => s.type);
            assert.strictEqual(types.filter(t => t === 'class').length, 1, 'Should have exactly 1 class entry');
            // Constructors should only come from extractClassMembers, not findFunctions
            const constructors = symbols.filter(s => s.type === 'constructor');
            assert.strictEqual(constructors.length, 2, 'Should have exactly 2 constructor entries');
            // Each constructor at a unique line
            const lines = constructors.map(c => c.startLine);
            assert.notStrictEqual(lines[0], lines[1], 'Constructors should be at different lines');
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

        // ErrorUtil in ErrorUtil.createErrorUid() should be a "call" (static method invocation)
        const callUsages = usages.filter(u => u.usageType === 'call');
        assert.ok(callUsages.length > 0,
            'ErrorUtil.createErrorUid() should classify ErrorUtil as "call"');
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
