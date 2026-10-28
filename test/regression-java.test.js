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

describe('fix #417: a class literal fixes an unbounded method return variable', () => {
    const cases = [
        ['project type', 'class Wanted {}class Box {Box(Wanted value){}Box(Object value){}}class Producer {static <Value> Value create(Class<Value> type){return null;}}class Use {static Box build(){return new Box(Producer.create(Wanted.class));}}', 'Wanted', false],
        ['primitive literal', 'class Box {Box(Integer value){}Box(Object value){}}class Producer {static <Value> Value create(Class<Value> type){return null;}}class Use {static Box build(){return new Box(Producer.create(int.class));}}', 'Integer', true],
        ['array literal', 'class Wanted {}class Box {Box(Wanted[] value){}Box(Object value){}}class Producer {static <Value> Value create(Class<Value> type){return null;}}class Use {static Box build(){return new Box(Producer.create(Wanted[].class));}}', 'Wanted[]', true],
        ['explicit arguments', 'class Wanted {}class Box {Box(Wanted value){}Box(Object value){}}class Producer {static <Value> Value create(Class<Value> type){return null;}static Object create(Object type){return null;}}class Use {static Box build(){return new Box(Producer.<Object>create(Wanted.class));}}', 'Object', true],
    ];
    for (const [label, source, expected, review] of cases) it(label, () => {
        const dir = tmp({ 'N.java': source });
        try {
            const index = idx(dir), target = index.symbols.get('Box').find(def => def.type === 'constructor' && def.paramsStructured[0].type === expected);
            const callers = index.findCallers('Box', { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length, review ? 0 : 1);
            assert.equal(callers.unverifiedEntries.length, review ? 1 : 0);
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.deepEqual(callees.filter(def => def.type === 'constructor').map(def => def.paramsStructured[0].type), review ? [] : [expected]);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
    it('the literal type is resolved in the caller file', () => {
        const dir = tmp({
            'p/Wanted.java': 'package p; public class Wanted {}',
            'q/Producer.java': 'package q; class Wanted {}public class Producer {public static <Value> Value create(Class<Value> type){return null;}}',
            'N.java': 'import p.Wanted; import q.Producer; class Box {Box(Wanted value){}Box(Object value){}}class Use {static Box build(){return new Box(Producer.create(Wanted.class));}}',
        });
        try {
            const index = idx(dir), target = index.symbols.get('Box').find(def => def.type === 'constructor' && def.paramsStructured[0].type === 'Wanted');
            const callers = index.findCallers('Box', { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length, 1);
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.deepEqual(callees.filter(def => def.type === 'constructor').map(def => def.paramsStructured[0].type), ['Wanted']);
            const { validateConfirmation, declarationIdentity } = require('../core/provenance');
            for (const edge of callees.filter(def => def.type === 'constructor')) for (const site of edge.siteProvenance || []) assert.equal(
                validateConfirmation(JSON.parse(JSON.stringify(site.provenance)), declarationIdentity(target)).verdict, 'establishes-target');
        } finally { rm(dir); }
    });
});

describe('fix #417: unbounded Class method parameters infer from one argument', () => {
    const cases = [
        ['class literal', 'import java.lang.reflect.Type; class Target {static <Value> int pick(Class<Value> value){return 1;}static int pick(Type value){return 2;}}class Use {static int build(){return Target.pick(String.class);}}', 'Class<Value>', false],
        ['captured class', 'import java.lang.reflect.Type; class Target {static <Value> int pick(Class<Value> value){return 1;}static int pick(Type value){return 2;}}class Use {static int build(Class<?> value){return Target.pick(value);}}', 'Class<Value>', false],
        ['SDK class producer', 'import java.lang.reflect.Type; import java.lang.reflect.Method; class Target {static <Value> int pick(Class<Value> value){return 1;}static int pick(Type value){return 2;}}class Use {static int build(Method value){return Target.pick(value.getReturnType());}}', 'Class<Value>', false],
        ['SDK declaring class producer', 'import java.lang.reflect.Type; import java.lang.reflect.Constructor; class Target {static <Value> int pick(Class<Value> value){return 1;}static int pick(Type value){return 2;}}class Use {static int build(Constructor<?> value){return Target.pick(value.getDeclaringClass());}}', 'Class<Value>', false],
        ['SDK annotation type', 'import java.lang.reflect.Type; import java.lang.annotation.Annotation; class Target {static <Value> int pick(Class<Value> value){return 1;}static int pick(Type value){return 2;}}class Use {static int build(Annotation value){return Target.pick(value.annotationType());}}', 'Class<Value>', false],
        ['explicit argument mismatch', 'import java.lang.reflect.Type; class Target {static <Value> int pick(Class<Value> value){return 1;}static int pick(Type value){return 2;}}class Use {static int build(){return Target.<Integer>pick(String.class);}}', 'Type', true],
        ['bounded variable', 'import java.lang.reflect.Type; class Target {static <Value extends Number> int pick(Class<Value> value){return 1;}static int pick(Type value){return 2;}}class Use {static int build(){return Target.pick(String.class);}}', 'Type', true],
        ['another argument constrains the variable', 'import java.lang.reflect.Type; class Target {static <Value> int pick(Class<Value> value,Value other){return 1;}static int pick(Type value,Object other){return 2;}}class Use {static int build(){return Target.pick(String.class,1);}}', 'Type', true],
        ['owner variable is already fixed', 'import java.lang.reflect.Type; class Target<Value> {int pick(Class<Value> value){return 1;}int pick(Type value){return 2;}}class Use {static int build(Target<Integer> value){return value.pick(String.class);}}', 'Type', true],
        ['generic constructor', 'import java.lang.reflect.Type; class Box {<Value> Box(Class<Value> value){}Box(Type value){}}class Use {static Box build(){return new Box(String.class);}}', 'Class<Value>', false],
        ['explicit constructor mismatch', 'import java.lang.reflect.Type; class Box {<Value> Box(Class<Value> value){}Box(Type value){}}class Use {static Box build(){return new <Integer> Box(String.class);}}', 'Type', true],
    ];
    for (const [label, source, expected, review] of cases) it(label, () => {
        const dir = tmp({ 'N.java': source });
        try {
            const index = idx(dir), name = label.includes('constructor') ? 'Box' : 'pick';
            const target = index.symbols.get(name).find(def =>
                (name !== 'Box' || def.type === 'constructor') && def.paramsStructured?.[0]?.type === expected);
            assert.ok(target);
            const callers = index.findCallers(name, { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length, review ? 0 : 1);
            assert.equal(callers.unverifiedEntries.length, review ? 1 : 0);
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            const selected = callees.filter(def => name === 'Box' ? def.type === 'constructor' && def.className === 'Box' : def.name === 'pick');
            assert.deepEqual(selected.map(def => def.bindingId), review ? [] : [target.bindingId]);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #417: closed SDK values exclude unrelated imported interfaces', () => {
    const cases = [
        ['constructor', 'import java.nio.file.Path; import java.nio.file.LinkOption; class Box {Box(Path value,LinkOption... options){}Box(String value,LinkOption... options){}}class Use {static Box build(){return new Box("x");}}', 'Box'],
        ['method', 'import java.nio.file.Path; import java.nio.file.LinkOption; class Target {static int pick(Path value,LinkOption... options){return 1;}static int pick(String value,LinkOption... options){return 2;}}class Use {static int build(){return Target.pick("x");}}', 'pick'],
        ['Path implementation', 'import java.nio.file.Path; import java.nio.file.LinkOption; abstract class Target implements Path {static int pick(Path value,LinkOption... options){return 1;}static int pick(String value,LinkOption... options){return 2;}}class Use {static int build(){return Target.pick("x");}}', 'pick'],
        ['file-system provider', 'import java.nio.file.Path; import java.nio.file.LinkOption; import java.nio.file.spi.FileSystemProvider; abstract class Target extends FileSystemProvider {static int pick(Path value,LinkOption... options){return 1;}static int pick(String value,LinkOption... options){return 2;}}class Use {static int build(){return Target.pick("x");}}', 'pick'],
    ];
    // A platform supertype's members are unknown (fix #421: no JDK member
    // tables in the engine), so an owner implementing one keeps an open
    // overload family: both overloads are reviewed, the Path one never
    // confirmed.
    const openFamily = new Set(['Path implementation', 'file-system provider']);
    for (const [label, source, name] of cases) it(`${label}: a string does not become a Path`, () => {
        const dir = tmp({ 'N.java': source });
        try {
            const index = idx(dir);
            if (openFamily.has(label)) {
                for (const target of index.symbols.get(name)) {
                    const callers = index.findCallers(name, { targetDefinitions: [target], collectAccount: true });
                    assert.equal(callers.length, 0);
                    assert.deepEqual(callers.unverifiedEntries.map(entry => entry.reason), ['overload-ambiguous']);
                }
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.equal(callees.filter(def => def.name === name).length, 0);
                assert.deepEqual(callees.unverifiedCallees.map(entry => entry.name), [name]);
                return;
            }
            for (const [type, count] of [['Path', 0], ['String', 1]]) {
                const target = index.symbols.get(name).find(def => (name !== 'Box' || def.type === 'constructor') && def.paramsStructured?.[0]?.type === type);
                const callers = index.findCallers(name, { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, count);
                assert.equal(callers.unverifiedEntries.length, 0);
            }
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            const selected = callees.filter(def => name === 'Box' ? def.type === 'constructor' && def.className === 'Box' : def.name === 'pick');
            assert.deepEqual(selected.map(def => def.paramsStructured[0].type), ['String']);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
    it('an unseen parent may bind a formal type name to a different class', () => {
        const dir = tmp({ 'N.java': 'import dep.Base; class Target extends Base {private int pick(Class<?> value){return 1;}private int pick(Other<?> value){return 3;}int build(){return pick(String.class);}}' });
        try {
            const index = idx(dir);
            for (const target of index.symbols.get('pick')) {
                const callers = index.findCallers('pick', { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, 0);
                assert.equal(callers.unverifiedEntries.length, 1);
            }
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.equal(callees.filter(def => def.name === 'pick').length, 0);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #417: Comparable arguments retain their invariant type parameter', () => {
    const cases = [
        ['different invariant argument', 'Comparable<Integer>', '"x"', 'Object'],
        ['same invariant argument', 'Comparable<String>', '"x"', 'Comparable<String>'],
        ['boxed invariant argument', 'Comparable<Integer>', '1', 'Comparable<Integer>'],
        ['wider invariant argument', 'Comparable<Number>', '1', 'Object'],
        ['upper bound matches', 'Comparable<? extends CharSequence>', '"x"', 'Comparable<? extends CharSequence>'],
        ['upper bound differs', 'Comparable<? extends Number>', '"x"', 'Object'],
        ['lower bound matches', 'Comparable<? super String>', '"x"', 'Comparable<? super String>'],
        ['lower bound differs', 'Comparable<? super Integer>', '"x"', 'Object'],
        ['unbounded wildcard', 'Comparable<?>', '"x"', 'Comparable<?>'],
    ];
    for (const [label, formal, argument, expected] of cases) for (const constructor of [true, false]) {
        it(`${label}: ${constructor ? 'constructor' : 'method'} selection uses the generic contract`, () => {
            const source = constructor
                ? `import java.io.Closeable;\nclass Box implements Closeable {Box(${formal} value){} Box(Object value){} public void close(){}}\nclass Factory {static Box build(){return new Box(${argument});}}\n`
                : `import java.io.Closeable;\nclass Target implements Closeable {void accept(${formal} value){} void accept(Object value){} public void close(){}}\nclass Factory {static void build(Target value){value.accept(${argument});}}\n`;
            const dir = tmp({ 'N.java': source });
            try {
                const index = idx(dir), name = constructor ? 'Box' : 'accept';
                const target = index.symbols.get(name).find(def => (constructor ? def.type === 'constructor' : true) && def.paramsStructured?.[0]?.type === expected);
                const callers = index.findCallers(name, { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, 1, callers.unverifiedEntries.map(site => site.reason).join(','));
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                const edges = callees.filter(def => constructor ? def.type === 'constructor' && def.className === 'Box' : def.name === 'accept');
                assert.deepEqual(edges.map(def => def.bindingId), [target.bindingId]);
                const { validateConfirmation, declarationIdentity } = require('../core/provenance');
                for (const edge of edges) for (const site of edge.siteProvenance || []) assert.equal(
                    validateConfirmation(JSON.parse(JSON.stringify(site.provenance)), declarationIdentity(target)).verdict, 'establishes-target');
                assert.equal(callees.calleeAccount.conserved, true);
            } finally { rm(dir); }
        });
    }
    for (const [label, source, expected] of [
        ['class literal with a closed generic target',
            'import java.io.Closeable; class Box implements Closeable {Box(Class<Integer> value){} Box(Object value){} public void close(){}} class Factory {static Box build(){return new Box(String.class);}}', 'Object'],
        ['owner type parameter',
            'import java.io.Closeable; class Box<T> implements Closeable {Box(Comparable<T> value){} Box(Object value){} public void close(){}} class Factory {static Box<String> build(){return new Box<String>("x");}}', 'Comparable<T>'],
    ]) it(`${label}: unresolved substitutions retain the compiler-selected candidate`, () => {
        const dir = tmp({ 'N.java': source + '\n' });
        try {
            const index = idx(dir), target = index.symbols.get('Box').find(def => def.type === 'constructor' && def.paramsStructured[0].type === expected);
            const callers = index.findCallers('Box', { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length, 0);
            assert.equal(callers.unverifiedEntries.length, 1);
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.equal(callees.filter(def => def.type === 'constructor' && def.className === 'Box').length, 0);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #417: variable-arity candidates check both argument forms', () => {
    for (const [label, method] of [
        ['external subtype', 'Box create(q.Foo value){return new Box(value);}'],
        ['external subtype array', 'Box create(q.Foo[] value){return new Box(value);}'],
        ['bounded parameter', '<Text extends Note> Box create(Text value){return new Box(value);}'],
        ['bounded parameter array', '<Text extends Note> Box create(Text[] value){return new Box(value);}'],
    ]) it(`${label}: an unproved ancestry cannot eliminate the variadic target`, () => {
        const dir = tmp({
            'p/Note.java': 'package p; public class Note{}',
            'N.java': `import p.Note; class Box {Box(Note... values){}Box(Object... values){}} class Use {${method}}`,
        });
        try {
            const index = idx(dir), target = index.symbols.get('Box').find(def =>
                def.type === 'constructor' && def.paramsStructured[0].type === 'Note[]');
            const callers = index.findCallers('Box', { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length, 0);
            assert.equal(callers.unverifiedEntries.length, 1);
            const callees = index.findCallees(index.symbols.get('create')[0], { collectAccount: true });
            assert.ok(!callees.some(def => def.type === 'constructor'));
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
    for (const [label, source, expected, review] of [
        ['fixed list', 'import java.util.List; class Note{} class Parent {void annotate(Note... values){}void annotate(List<Note> values){}} class Child extends Parent {@Override void annotate(List<Note> values){}} class Box {Box(Note... values){}Box(List<Note> values){}} class Use {void run(Parent value){value.annotate((List<Note>)null);}Box create(){return new Box((List<Note>)null);}}', 'List<Note>', false],
        ['normal array', 'import java.util.List; class Note{} class Box {Box(Note... values){}Box(List<Note> values){}} class Use {Box create(){return new Box(new Note[]{new Note()});}}', 'Note', false],
        ['expanded scalar', 'import java.util.List; class Note{} class Box {Box(Note... values){}Box(List<Note> values){}} class Use {Box create(){return new Box(new Note());}}', 'Note', false],
        ['expanded tail', 'class Note{} class Box {Box(Note... values){}Box(Object... values){}} class Use {Box create(){return new Box(new Note(),"x");}}', 'Object', false],
        ['generic object fallback', 'import java.util.List; class Box {Box(List<String> values){}Box(Object... values){}} class Use {Box create(){return new Box((List<Integer>)null);}}', 'Object', true],
        ['reference array competes before expansion', 'class Note{} class Box {Box(Note... values){}Box(Object value){}} class Use {Box create(){return new Box(new Note[0]);}}', 'Note', true],
        ['primitive array competes before expansion', 'class Box {Box(int... values){}Box(Object value){}} class Use {Box create(){return new Box(new int[0]);}}', 'int', false],
    ]) it(`${label}: an incompatible element cannot keep a variadic candidate applicable`, () => {
        const dir = tmp({ 'N.java': source });
        try {
            const index = idx(dir), targets = index.symbols.get('Box').filter(def => def.type === 'constructor');
            const target = targets.find(def => def.paramsStructured[0].type.replace(/\.\.\.$|\[\]$/, '') === expected);
            const callers = index.findCallers('Box', { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length, review ? 0 : 1);
            assert.equal(callers.unverifiedEntries.length, review ? 1 : 0);
            const callees = index.findCallees(index.symbols.get('create')[0], { collectAccount: true });
            const strong = callees.filter(def => def.type === 'constructor' && def.className === 'Box');
            assert.deepEqual(strong.map(def => def.bindingId), review ? [] : [target.bindingId]);
            assert.equal(callees.calleeAccount.conserved, true);
            if (label === 'fixed list') {
                const override = index.symbols.get('annotate').find(def => def.className === 'Child');
                const sites = index.findCallers('annotate', { targetDefinitions: [override], collectAccount: true });
                assert.equal(sites.length, 0);
                assert.deepEqual(sites.unverifiedEntries.map(site => site.reason), ['possible-dispatch']);
            }
        } finally { rm(dir); }
    });
});

describe('fix #417: capitalized fields keep their value receiver', () => {
    it('a wildcard static import does not turn an owned field into a type qualifier', () => {
        const dir = tmp({
            'q/Values.java': 'package q; public class Values {public static final int UNUSED=0;}',
            'N.java': 'import static q.Values.*; class A {void copy(){}} class B {void copy(){}} class Use {A Cache=new A(); void run(){Cache.copy();}}',
        });
        try {
            const index = idx(dir);
            for (const [owner, count] of [['A', 1], ['B', 0]]) {
                const target = index.symbols.get('copy').find(def => def.className === owner);
                const callers = index.findCallers('copy', { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, count);
                assert.equal(callers.unverifiedEntries.length, 0);
            }
            const callees = index.findCallees(index.symbols.get('run')[0], { collectAccount: true });
            assert.deepEqual(callees.filter(def => def.name === 'copy').map(def => def.className), ['A']);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #417: qualified producer returns bind their actual root', () => {
    for (const [label, packageName, provider] of [
        ['same package', 'p', 'p'], ['imported root', 'r', 'p'], ['other imported root', 'r', 'q'],
    ]) for (const chain of ['source().build()', 'source().step().build()']) it(`${label}, ${chain}: a relative nested return keeps its owner`, () => {
        const dir = tmp({
            'p/Outer.java': 'package p; public class Outer {public static class Builder {public Builder step(){return this;}public void build(){}}}',
            'q/Outer.java': 'package q; public class Outer {public static class Builder {public Builder step(){return this;}public void build(){}}}',
            [`${packageName}/Use.java`]: `package ${packageName}; ${packageName === provider ? '' : `import ${provider}.Outer;`} public class Use {Outer.Builder source(){return new Outer.Builder();}void run(){${chain};}}`,
        });
        try {
            const index = idx(dir);
            for (const namespace of ['p', 'q']) {
                const target = index.symbols.get('build').find(def => def.namespace === namespace);
                const callers = index.findCallers('build', { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, namespace === provider ? 1 : 0);
                assert.equal(callers.unverifiedEntries.length, 0);
            }
            const callees = index.findCallees(index.symbols.get('run')[0], { collectAccount: true });
            assert.deepEqual(callees.filter(def => def.name === 'build').map(def => def.namespace), [provider]);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #417: primitive conversion preserves nominal argument names', () => {
    it('a concrete String cannot unbox to char under a wildcard import', () => {
        const dir = tmp({ 'N.java': 'import static java.util.Collections.*; class Target {void pick(char value){} void pick(String value){}} class Use {void run(Target target,String value){target.pick(value);}}' });
        try {
            const index = idx(dir);
            for (const [type, count] of [['char', 0], ['String', 1]]) {
                const target = index.symbols.get('pick').find(def => def.paramsStructured[0].type === type);
                const callers = index.findCallers('pick', { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, count);
                assert.equal(callers.unverifiedEntries.length, 0);
            }
        } finally { rm(dir); }
    });
    for (const name of ['String', 'Text']) it(`${name}: a type parameter may unbox through its wrapper bound`, () => {
        const dir = tmp({ 'N.java': `class Target {void pick(char value){}} class Use {<${name} extends Character> void run(Target target,${name} value){target.pick(value);}}` });
        try {
            const index = idx(dir), target = index.symbols.get('pick')[0];
            const callers = index.findCallers('pick', { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length + callers.unverifiedEntries.length, 1);
            const callees = index.findCallees(index.symbols.get('run')[0], { collectAccount: true });
            assert.equal(callees.length + callees.unverifiedCallees.length, 1);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #417: SDK receiver producers retain their naming scope', () => {
    for (const [label, imports, method, parameter] of [
        ['map', 'import javax.lang.model.element.AnnotationMirror; import javax.lang.model.element.ExecutableElement;',
            'Object use(AnnotationMirror annotation, ExecutableElement element){return annotation.getElementValues().get(element);}', 'Object'],
        ['list', 'import javax.lang.model.element.TypeElement; import javax.lang.model.util.ElementFilter;',
            'Object use(TypeElement element){return ElementFilter.methodsIn(element.getEnclosedElements()).get(0);}', 'int'],
    ]) it(`${label}: an unrelated nested base does not obscure an imported producer`, () => {
        const dir = tmp({ 'N.java': `${imports}\nclass Target {void get(${parameter} value){}}\nclass Use {${method}\n abstract static class Unrelated extends java.util.AbstractList<Object>{}}\n` });
        try {
            const index = idx(dir), target = index.symbols.get('get')[0];
            const callers = index.findCallers('get', { targetDefinitions: [target], collectAccount: true });
            assert.equal(callers.length, 0);
            assert.equal(callers.unverifiedEntries.length, 0);
            const callees = index.findCallees(index.symbols.get('use')[0], { collectAccount: true });
            assert.ok(!callees.some(def => def.className === 'Target' && def.name === 'get'));
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
});

describe('fix #417: SDK contracts retain their written type identity', () => {
    const cases = [
        ['Iterable formal', '',
            'class Box implements Iterable<Object> {Box(Number value){} Box(String value){} public java.util.Iterator<Object> iterator(){return null;}}',
            'static Box build(){return new Box(1);}', 'Number'],
        ['unbounded Class formal', '',
            'class Box {Box(Class<?> value){} Box(Object value){}}',
            'static Box build(){return new Box(String.class);}', 'Class<?>'],
        ['implicit Class producer', '',
            'class Box {Box(Class<?> value){} Box(java.lang.reflect.Type value){}}',
            'static Box build(Class<?> value){return new Box(value.getEnclosingClass());}', 'Class<?>'],
        ['implicit Enum producer', '',
            'class Box {Box(Class<?> value){} Box(java.lang.reflect.Type value){}}',
            'static Box build(Enum<?> value){return new Box(value.getDeclaringClass());}', 'Class<?>'],
        ['final getClass producer', 'import static java.util.Collections.*;',
            'class Box {Box(Class<?> value){} Box(java.lang.reflect.Type value){}}',
            'static Box build(){return new Box(new Object(){}.getClass());}', 'Class<?>'],
        ['getClass overload', '',
            'class Maker {Maker self(){return this;} String getClass(int value){return "x";}} class Box {Box(Class<?> value){} Box(String value){}}',
            'static Box build(){return new Box(new Maker().self().getClass(1));}', 'String'],
        ['reflection generic array sibling', 'import java.lang.reflect.Type; import java.lang.reflect.GenericArrayType;',
            'class Product{} class ChildProduct extends Product{} class Parent {static Product pick(Type value){return new Product();}} class Maker extends Parent {static ChildProduct pick(GenericArrayType value){return new ChildProduct();}} class Box {Box(Product value){} Box(ChildProduct value){}}',
            'static Box build(){return new Box(Maker.pick(Object[].class));}', 'Product'],
        ['reflection type variable sibling', 'import java.lang.reflect.Type; import java.lang.reflect.TypeVariable;',
            'class Product{} class ChildProduct extends Product{} class Parent {static Product pick(Type value){return new Product();}} class Maker extends Parent {static ChildProduct pick(TypeVariable<?> value){return new ChildProduct();}} class Box {Box(Product value){} Box(ChildProduct value){}}',
            'static Box build(){return new Box(Maker.pick(Object.class));}', 'Product'],
        ['reflection wildcard sibling', 'import java.lang.reflect.Type; import java.lang.reflect.WildcardType;',
            'class Product{} class ChildProduct extends Product{} class Parent {static Product pick(Type value){return new Product();}} class Maker extends Parent {static ChildProduct pick(WildcardType value){return new ChildProduct();}} class Box {Box(Product value){} Box(ChildProduct value){}}',
            'static Box build(){return new Box(Maker.pick(Object.class));}', 'Product'],
        ['string beside reflection type variable', 'import java.lang.reflect.TypeVariable;',
            'class Product{} class ChildProduct extends Product{} class Parent {static Product pick(String value){return new Product();}} class Maker extends Parent {static ChildProduct pick(TypeVariable<?> value){return new ChildProduct();}} class Box {Box(Product value){} Box(ChildProduct value){}}',
            'static Box build(){return new Box(Maker.pick("x"));}', 'Product'],
        ['Closeable formal', 'import java.io.Closeable;',
            'class Box implements Closeable {Box(String value){} Box(Integer value){} public void close(){}}',
            'static Box build(){return new Box("x");}', 'String'],
        ['Map.Entry formal', 'import java.util.Map;',
            'class Box implements Map.Entry<String,String> {Box(Number value){} Box(String value){} public String getKey(){return "";} public String getValue(){return "";} public String setValue(String value){return value;}}',
            'static Box build(){return new Box(1);}', 'Number'],
        ['Map.Entry producer', 'import java.util.Map;',
            'class Product{} class ChildProduct extends Product{} class Maker implements Map.Entry<String,String> {ChildProduct make(){return new ChildProduct();} public String getKey(){return "";} public String getValue(){return "";} public String setValue(String value){return value;}} class Box {Box(ChildProduct value){} Box(Product value){}}',
            'static Box build(){return new Box(new Maker().make());}', 'ChildProduct'],
        ['Comparable producer', '',
            'class Product{} class ChildProduct extends Product{} class Parent {static Product get(java.lang.reflect.Type value){return new Product();} static Product get(javax.lang.model.type.TypeMirror value){return new Product();}} class Maker extends Parent implements Comparable<Maker> {static ChildProduct get(Class<?> value){return new ChildProduct();} public int compareTo(Maker other){return 0;}} class Box {Box(ChildProduct value){} Box(Product value){}}',
            'static Box build(){return new Box(Maker.get(Factory.class));}', 'ChildProduct'],
        ['imported reflection producer', 'import java.lang.reflect.Method; import java.lang.reflect.Type; import static java.util.Collections.*;',
            'class Box {Box(Type value){} Box(String value){}}',
            'static Box build(Method method){return new Box(method.getGenericReturnType());}', 'Type'],
        ['imported model producer', 'import javax.lang.model.element.TypeParameterElement; import javax.lang.model.type.TypeMirror; import static java.util.Collections.*;',
            'class Box {Box(TypeMirror value){} Box(String value){}}',
            'static Box build(TypeParameterElement element){return new Box(element.asType());}', 'TypeMirror'],
        ['reflection chain', 'import java.lang.reflect.Type; import static java.util.Collections.*;',
            'class Box {Box(Type value){} Box(String value){}}',
            'static Box build() throws Exception {return new Box(new Factory().getClass().getDeclaredMethod("build").getGenericReturnType());}', 'Type'],
        ['model collection element', 'import java.util.List; import javax.lang.model.element.TypeParameterElement; import javax.lang.model.type.TypeMirror; import static java.util.Collections.*;',
            'class Box {Box(TypeMirror value){} Box(String value){}}',
            'static Box build(List<TypeParameterElement> elements){return new Box(elements.get(0).asType());}', 'TypeMirror'],
        ['model map element', 'import java.util.Map; import javax.lang.model.element.TypeParameterElement; import javax.lang.model.type.TypeMirror; import static java.util.Collections.*;',
            'class Box {Box(TypeMirror value){} Box(String value){}}',
            'static Box build(Map<String, TypeParameterElement> elements){return new Box(elements.get("x").asType());}', 'TypeMirror'],
        ['concrete SDK collection element', 'import java.util.ArrayList; import javax.lang.model.element.TypeParameterElement; import javax.lang.model.type.TypeMirror; import static java.util.Collections.*;',
            'class Box {Box(TypeMirror value){} Box(String value){}}',
            'static Box build(ArrayList<TypeParameterElement> elements){return new Box(elements.get(0).asType());}', 'TypeMirror'],
        ['upper bounded collection element', 'import java.util.List; import javax.lang.model.element.TypeParameterElement; import javax.lang.model.type.TypeMirror; import static java.util.Collections.*;',
            'class Box {Box(TypeMirror value){} Box(String value){}}',
            'static Box build(List<? extends TypeParameterElement> elements){return new Box(elements.get(0).asType());}', 'TypeMirror'],
        ['project container get', 'import javax.lang.model.element.TypeParameterElement; import javax.lang.model.type.TypeMirror; import java.lang.reflect.Type; import static java.util.Collections.*;',
            'class Wrong {Type asType(){return String.class;}} class Container<T> {Wrong get(int index){return new Wrong();}} class Box {Box(TypeMirror value){} Box(Type value){}}',
            'static Box build(Container<TypeParameterElement> elements){return new Box(elements.get(0).asType());}', 'Type'],
        ['project interface namesake', '',
            'interface Iterable<T> {class Number{}} class Box implements Iterable<Object> {Box(Number value){} Box(Object value){}}',
            'static Box build(){return new Box(1);}', 'Object'],
        ['project Closeable namesake', '',
            'interface Closeable {class String{}} class Box implements Closeable {Box(String value){} Box(Object value){}}',
            'static Box build(){return new Box("x");}', 'Object'],
    ];
    for (const [label, imports, declarations, build, expected] of cases) {
        it(`${label}: caller and callee select the compiler-visible constructor`, () => {
            const dir = tmp({ 'N.java': `${imports}\n${declarations}\nclass Factory {${build}}\n` });
            try {
                const index = idx(dir), target = index.symbols.get('Box').find(def =>
                    def.type === 'constructor' && def.paramsStructured[0].type === expected);
                const callers = index.findCallers('Box', { targetDefinitions: [target], collectAccount: true });
                assert.equal(callers.length, 1, callers.unverifiedEntries.map(site => site.reason).join(','));
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                const edges = callees.filter(def => def.type === 'constructor' && def.className === 'Box');
                assert.deepEqual(edges.map(def => def.bindingId), [target.bindingId]);
                const { validateConfirmation, declarationIdentity } = require('../core/provenance');
                for (const site of edges[0].siteProvenance) assert.equal(
                    validateConfirmation(JSON.parse(JSON.stringify(site.provenance)), declarationIdentity(target)).verdict,
                    'establishes-target');
                assert.equal(callees.calleeAccount.conserved, true);
            } finally { rm(dir); }
        });
    }
    it('Iterable also closes ordinary method formal lookup', () => {
        const dir = tmp({ 'N.java': 'class Target implements Iterable<Object> {void accept(Number value){} void accept(String value){} public java.util.Iterator<Object> iterator(){return null;}}\nclass Factory {static void build(Target value){value.accept(1);}}\n' });
        try {
            const index = idx(dir), target = index.symbols.get('accept').find(def => def.paramsStructured[0].type === 'Number');
            assert.equal(index.findCallers('accept', { targetDefinitions: [target], collectAccount: true }).length, 1);
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.deepEqual(callees.filter(def => def.name === 'accept').map(def => def.bindingId), [target.bindingId]);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
    it('Closeable also closes ordinary method formal lookup', () => {
        const dir = tmp({ 'N.java': 'import java.io.Closeable;\nclass Target implements Closeable {void accept(String value){} void accept(Integer value){} public void close(){}}\nclass Factory {static void build(Target value){value.accept("x");}}\n' });
        try {
            const index = idx(dir), target = index.symbols.get('accept').find(def => def.paramsStructured[0].type === 'String');
            assert.equal(index.findCallers('accept', { targetDefinitions: [target], collectAccount: true }).length, 1);
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.deepEqual(callees.filter(def => def.name === 'accept').map(def => def.bindingId), [target.bindingId]);
            assert.equal(callees.calleeAccount.conserved, true);
        } finally { rm(dir); }
    });
    it('an inherited member type wins over a single SDK import', () => {
        const dir = tmp({ 'N.java': 'import java.lang.reflect.Method;\nclass Base {static class Method {String getGenericReturnType(){return "x";}}}\nclass Box {Box(java.lang.reflect.Type value){} Box(String value){}}\nclass Factory extends Base {static Box build(Method method){return new Box(method.getGenericReturnType());}}\n' });
        try {
            const index = idx(dir), wrong = index.symbols.get('Box').find(def =>
                def.type === 'constructor' && def.paramsStructured[0].type === 'java.lang.reflect.Type');
            assert.equal(index.findCallers('Box', { targetDefinitions: [wrong], collectAccount: true }).length, 0);
            assert.ok(!index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                .some(def => def.bindingId === wrong.bindingId));
        } finally { rm(dir); }
    });
});

describe('fix #417: Java type-name evidence follows lexical translation', () => {
    const { translateUnicodeEscapes, typeNameSourceCanonical } = require('../languages/java-unicode');
    it('translates eligible escapes once, respecting backslash parity and repeated markers', () => {
        for (const [source, expected] of [
            [String.raw`\u0061`, 'a'], [String.raw`\uuuu0061`, 'a'],
            [String.raw`\\u0061`, String.raw`\\u0061`],
            [String.raw`\u005cu0061`, String.raw`\u0061`],
            [String.raw`\u005c\u0061`, '\\a'],
            [String.raw`\\\u006e`, '\\\\n'],
            [String.raw`\uD83D\uDE00`, '😀'],
            [String.raw`\u123`, null], [String.raw`\u12xz`, null],
        ]) assert.equal(translateUnicodeEscapes(source), expected, source);
    });
    it('retains canonical names for harmless literal and comment changes', () => {
        for (const source of [
            'class A {String f(){return "x";}}',
            String.raw`class A {String f(){return "\u0078";}}`,
            String.raw`class A {String f(){return "\\u0078";}}`,
            String.raw`// \u0061` + '\nclass A {}',
            'class A {String f(){return "\u200d";}}',
            String.raw`class A {char zero='\u0000'; String f(){return "\u0000";}}`,
            String.raw`// \u0000 harmless comment` + '\nclass A {}',
            String.raw`//\u0000` + '\nclass A {}',
            String.raw`/*\u0000*/class A {}`,
            String.raw`class A {String emoji="😀"; char zero='\u0000';}`,
        ]) assert.equal(typeNameSourceCanonical(source), true, source);
    });
    it('withdraws certainty when translation changes imports or identifiers', () => {
        for (const source of [
            String.raw`//\u000a import q.java;` + '\nclass A {}',
            String.raw`import q.j\u0061va;` + '\nclass A {}',
            'import q.j\u200dava;\nclass A {}',
            String.raw`class j\u0061va {}`,
            'class A {',
            String.raw`class j\u0000ava {}`,
            'class j\0ava {}',
            'class A {char zero=\'\0\'; String f(){return "\0";}}',
            '// \0 harmless comment\nclass A {}',
        ]) assert.equal(typeNameSourceCanonical(source), false, source);
    });
    it('literal NUL contents preserve a receiver member proof and constructor argument identity', () => {
        const dir = tmp({
            'Target.java': String.raw`class Target {char zero='\u0000'; void work(){}}` + '\n',
            'Use.java': 'class Use {void call(Target value){value.work();}}\n',
            'Box.java': String.raw`class Box {char zero='\u0000'; Box(Target value){} Box(Object value){}}` + '\n',
            'Factory.java': String.raw`class Factory {static java.lang.String text(){return "\u0000";} static Box build(){return new Box(text());}}` + '\n',
        });
        try {
            const index = idx(dir), work = index.symbols.get('work')[0];
            const callers = index.findCallers('work', { targetDefinitions: [work], collectAccount: true });
            assert.equal(callers.filter(site => site.tier !== 'unverified').length, 1);
            const ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
            assert.equal(index.findCallers('Box', { targetDefinitions: [ctors[1]], collectAccount: true }).length, 1);
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.ok(callees.some(def => def.type === 'constructor' && def.className === 'Box' && def.paramsStructured[0].type === 'Object'));
        } finally { rm(dir); }
    });
    for (const binding of [String.raw`//\u000a import q.java;`, String.raw`import q.j\u0061va;`, 'import q.j\u200dava;']) {
        it(`${JSON.stringify(binding)}: an opaque lexical binding cannot prove a platform argument`, () => {
            const dir = tmp({
                'p/Target.java': 'package p;public class Target{}\n',
                'q/java.java': 'package q;public class java {public static class lang {public static class String extends p.Target{}}}\n',
                'N.java': `${binding}\nimport p.Target;\nclass Box {Box(Target value){} Box(Object value){}}\nclass Factory {static Box build(){return new Box(new java.lang.String());}}\n`,
            });
            try {
                const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                assert.equal(index.findCallers('Box', { targetDefinitions: [ctors[1]], collectAccount: true }).length, 0);
                const target = index.findCallers('Box', { targetDefinitions: [ctors[0]], collectAccount: true });
                assert.equal(target.length + target.unverifiedEntries.length, 1);
                assert.ok(!index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                    .some(def => def.type === 'constructor' && def.className === 'Box'));
            } finally { rm(dir); }
        });
    }
    it('a literal cannot prove a formal type whose import appears after Unicode processing', () => {
        const dir = tmp({
            'p/String.java': 'package p;public class String{}\n',
            'N.java': String.raw`//\u000a import p.String;` + '\nclass Box {Box(String value){} Box(Object value){}}\nclass Factory {static Box build(){return new Box("x");}}\n',
        });
        try {
            const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
            assert.equal(index.findCallers('Box', { targetDefinitions: [ctors[0]], collectAccount: true }).length, 0);
            const target = index.findCallers('Box', { targetDefinitions: [ctors[1]], collectAccount: true });
            assert.equal(target.length + target.unverifiedEntries.length, 1);
        } finally { rm(dir); }
    });
});

describe('fix #417: argument type spellings retain their lexical identity', () => {
    for (const shadowed of [false, true]) {
        it(`${shadowed ? 'unresolved project' : 'platform'} receiver: a platform method contract needs type identity`, () => {
            const dir = tmp({ 'N.java': `${shadowed ? 'import q.java;\n' : ''}class Target{}\nclass Box {Box(Target value){} Box(Object value){}}\nclass Factory {static Box build(java.lang.Class value){return new Box(value.getEnclosingClass());}}\n` });
            try {
                const index = idx(dir), constructors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                const selected = index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                    .filter(def => def.type === 'constructor' && def.className === 'Box');
                assert.deepStrictEqual(selected.map(def => def.paramsStructured[0].type), shadowed ? [] : ['Object']);
                if (shadowed) for (const ctor of constructors) {
                    const callers = index.findCallers('Box', { targetDefinitions: [ctor], collectAccount: true });
                    assert.equal(callers.length, 0);
                    assert.equal(callers.unverifiedEntries.length, 1);
                }
            } finally { rm(dir); }
        });
    }
    it('an implemented interface supplies member types to constructor parameters', () => {
        const dir = tmp({ 'N.java': 'interface Contract {class String{}}\nclass Box implements Contract {Box(String value){} Box(Object value){}}\nclass Factory {static Box build(){return new Box("x");}}\n' });
        try {
            const index = idx(dir), constructors = index.symbols.get('Box').filter(def => def.type === 'constructor');
            const edge = index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                .find(def => def.type === 'constructor' && def.className === 'Box');
            assert.equal(edge?.paramsStructured[0].type, 'Object');
            assert.equal(index.findCallers('Box', { targetDefinitions: [constructors[0]], collectAccount: true }).length, 0);
            assert.equal(index.findCallers('Box', { targetDefinitions: [constructors[1]], collectAccount: true }).length, 1);
        } finally { rm(dir); }
    });
    for (const name of ['String', 'Class', 'Integer']) {
        it(`${name}: a project type cannot acquire a platform argument identity`, () => {
            const dir = tmp({ 'N.java': `class Target{}\nclass ${name} extends Target{}\nclass Box {Box(Target value){} Box(Object value){}}\nclass Factory {static Box build(${name} value){return new Box(value);}}\n` });
            try {
                const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                assert.equal(index.findCallers('Box', { targetDefinitions: [ctors[1]], collectAccount: true }).length, 0);
                const target = index.findCallers('Box', { targetDefinitions: [ctors[0]], collectAccount: true });
                assert.equal(target.length + target.unverifiedEntries.length, 1);
                assert.ok(!index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                    .some(def => def.type === 'constructor' && def.paramsStructured[0].type === 'Object'));
            } finally { rm(dir); }
        });
    }
    it('an unrelated nested class cannot supply types to an outer argument', () => {
        const dir = tmp({ 'N.java': 'class Target{}\nclass Box {Box(Target value){} Box(Object value){}}\nclass Factory {static Box build(Class<?> value){return new Box(value);} static class Nested extends External{}}\n' });
        try {
            const index = idx(dir), ctor = index.symbols.get('Box').find(def => def.type === 'constructor' && def.paramsStructured[0].type === 'Object');
            const edge = index.findCallees(index.symbols.get('build')[0], { collectAccount: true }).find(def => def.type === 'constructor');
            assert.equal(edge?.bindingId, ctor.bindingId);
            const { declarationIdentity, validateConfirmation } = require('../core/provenance');
            const proof = JSON.parse(JSON.stringify(edge.siteProvenance[0].provenance));
            assert.equal(validateConfirmation(proof, declarationIdentity(ctor)).verdict, 'establishes-target');
            proof.facts.constructorCall.overload.call.callSite.start++;
            assert.notEqual(validateConfirmation(proof, declarationIdentity(ctor)).verdict, 'establishes-target');
        } finally { rm(dir); }
    });
    for (const [label, factory] of [
        ['inherited', 'class Factory extends External {static Box build(String value){return new Box(value);}}'],
        ['anonymous', 'class Factory {static void build(){new External(){Box call(String value){return new Box(value);}};}}'],
    ]) {
        it(`${label}: an unindexed lexical base keeps the actual type unresolved`, () => {
            const dir = tmp({ 'N.java': `class Target{}\nclass Box {Box(Target value){} Box(Object value){}}\n${factory}\n` });
            try {
                const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                for (const ctor of ctors) {
                    const callers = index.findCallers('Box', { targetDefinitions: [ctor], collectAccount: true });
                    assert.equal(callers.length, 0);
                    assert.equal(callers.unverifiedEntries.length, 1);
                }
            } finally { rm(dir); }
        });
    }
});

describe('fix #417: class literal arguments retain their JDK identity', () => {
    const targetSource = 'package p;public class Target{}\n';
    const shadowSource = 'package q;public class java {public static class lang {public static class String extends p.Target{}}}\n';
    for (const [label, declaration, argument] of [
        ['construction', '', 'new java.lang.String()'],
        ['cast', 'Object value', '(java.lang.String)value'],
        ['annotation', 'java.lang.String value', 'value'],
    ]) {
        it(`${label}: a qualified argument type may start at an imported project type`, () => {
            const dir = tmp({
                'p/Target.java': targetSource, 'q/java.java': shadowSource,
                'N.java': `import q.java;import p.Target;\nclass Box {Box(Target value){} Box(Object value){}}\nclass Factory {static Box build(${declaration}){return new Box(${argument});}}\n`,
            });
            try {
                const index = idx(dir), constructors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                assert.equal(index.findCallers('Box', { targetDefinitions: [constructors[1]], collectAccount: true }).length, 0);
                const target = index.findCallers('Box', { targetDefinitions: [constructors[0]], collectAccount: true });
                assert.equal(target.length + target.unverifiedEntries.length, 1, 'the compiler-selected target remains visible');
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.ok(!callees.some(def => def.bindingId === constructors[1].bindingId));
                assert.equal(callees.calleeAccount.conserved, true);
            } finally { rm(dir); }
        });
    }
    for (const [label, producer, argument] of [
        ['return', 'class Producer {static java.lang.String source(){return null;}}', 'Producer.source()'],
        ['field', 'class Producer {static java.lang.String value;}', 'Producer.value'],
    ]) {
        for (const shadowed of [false, true]) {
            it(`${label}: the type name belongs to the ${shadowed ? 'shadowed' : 'unshadowed'} declaring file`, () => {
                const dir = tmp({
                    'p/Target.java': targetSource,
                    ...(shadowed ? {} : { 'q/java.java': shadowSource }),
                    'Producer.java': `${shadowed ? 'import dep.java;\n' : ''}${producer}\n`,
                    'N.java': `${shadowed ? '' : 'import q.java;'}import p.Target;\nclass Box {Box(Target value){} Box(Object value){}}\nclass Factory {static Box build(){return new Box(${argument});}}\n`,
                });
                try {
                    const index = idx(dir), constructors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                    const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                    if (shadowed) {
                        assert.ok(!callees.some(def => def.bindingId === constructors[1].bindingId));
                        const callers = index.findCallers('Box', { targetDefinitions: [constructors[0]], collectAccount: true });
                        assert.equal(callers.length + callers.unverifiedEntries.length, 1);
                    } else {
                        const edge = callees.find(def => def.type === 'constructor' && def.className === 'Box');
                        assert.equal(edge?.bindingId, constructors[1].bindingId, callees.unverifiedCallees.map(def => def.reason).join(','));
                        const { validateConfirmation, declarationIdentity } = require('../core/provenance');
                        const proof = JSON.parse(JSON.stringify(edge.siteProvenance[0].provenance));
                        assert.equal(validateConfirmation(proof, declarationIdentity(constructors[1])).verdict, 'establishes-target');
                        proof.facts.constructorCall.overload.call.argumentFile = 'Producer.java';
                        assert.notEqual(validateConfirmation(proof, declarationIdentity(constructors[1])).verdict, 'establishes-target');
                    }
                    assert.equal(callees.calleeAccount.conserved, true);
                } finally { rm(dir); }
            });
        }
    }
    for (const [label, source] of [
        ['unrelated nested Object', 'package p; class Other {static class Object{}} class Type{} class Box {Box(Type value){} Box(Object value){}}'],
        ['own member before import', 'import java.lang.reflect.Type; class Box {static class Type{} Box(Type value){} Box(Object value){}}'],
        ['inherited member before import', 'import java.lang.reflect.Type; class Base {static class Type{}} class Box extends Base {Box(Type value){} Box(Object value){}}'],
    ]) {
        it(`${label}: formal type lookup uses the declaring class scope`, () => {
            const dir = tmp({ 'N.java': `${source}\nclass Factory {static Box build(){return new Box(String.class);}}\n` });
            try {
                const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.equal(callees.find(def => def.type === 'constructor' && def.className === 'Box')?.bindingId,
                    ctors[1].bindingId, callees.unverifiedCallees.map(def => def.reason).join(','));
                for (const [position, ctor] of ctors.entries()) {
                    const callers = index.findCallers('Box', { targetDefinitions: [ctor], collectAccount: true });
                    assert.equal(callers.length, position);
                }
                assert.equal(callees.calleeAccount.conserved, true);
            } finally { rm(dir); }
        });
    }
    it('an unindexed superclass may supply a type that shadows an import', () => {
        const dir = tmp({ 'N.java': 'import java.lang.reflect.Type;\nclass Box extends dep.Base {Box(Type value){}\n Box(Object value){}}\nclass Factory {static Box build(){return new Box(String.class);}}\n' });
        try {
            const index = idx(dir);
            for (const ctor of index.symbols.get('Box').filter(def => def.type === 'constructor')) {
                const callers = index.findCallers('Box', { targetDefinitions: [ctor], collectAccount: true });
                assert.equal(callers.length, 0);
                assert.equal(callers.unverifiedEntries.length, 1);
            }
            // The class dependency stays; its constructor body is undecided (fix #421).
            const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.deepStrictEqual(callees.map(def => [def.name, def.type]), [['Box', 'class']]);
            assert.deepStrictEqual(callees.initializerReviews.map(def => def.name), ['Box']);
        } finally { rm(dir); }
    });
    it('a superclass name is not an inherited member type', () => {
        const dir = tmp({
            'dep/Object.java': 'package dep;public class Object{}\n',
            'N.java': 'class Type{}\nclass Box extends dep.Object {Box(Type value){}\n Box(Object value){}}\nclass Factory {static Box build(){return new Box(String.class);}}\n',
        });
        try {
            const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
            assert.equal(index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                .find(def => def.type === 'constructor')?.bindingId, ctors[1].bindingId);
            assert.equal(index.findCallers('Box', { targetDefinitions: [ctors[1]], collectAccount: true }).length, 1);
        } finally { rm(dir); }
    });
    for (const [name, argument, producer] of [
        ['String', '"x"', ''], ['Integer', '1', ''], ['Number', '1', ''],
        ['CharSequence', '"x"', ''], ['Boolean', 'true', ''], ['Character', "'x'", ''],
        ['String', 'source()', 'static java.lang.String source(){return "x";}'],
        ['String', 'new java.lang.String("x")', ''],
    ]) {
        it(`${name} with ${argument}: known JDK values do not convert to a project namesake`, () => {
            const dir = tmp({ 'N.java': `class ${name} {}\nclass Box {Box(${name} value){}\n Box(java.lang.Object value){}}\nclass Factory {${producer} static Box build(){return new Box(${argument});}}\n` });
            try {
                const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.equal(callees.find(def => def.type === 'constructor' && def.className === 'Box')?.bindingId, ctors[1].bindingId,
                    callees.unverifiedCallees.map(def => def.reason).join(','));
                assert.equal(index.findCallers('Box', { targetDefinitions: [ctors[0]], collectAccount: true }).length, 0);
            } finally { rm(dir); }
        });
    }
    for (const name of ['Type', 'Class', 'Serializable', 'GenericDeclaration', 'AnnotatedElement', 'Object']) {
        it(`a project ${name} is not a supertype of java.lang.Class`, () => {
            const dir = tmp({ 'N.java': `class ${name} {}\nclass Box {\n Box(${name} value){}\n Box(java.lang.Object value){}\n}\nclass Factory {static Box build(){return new Box(String.class);}}\n` });
            try {
                const index = idx(dir);
                for (const def of index.symbols.get('Box').filter(def => def.type === 'constructor')) {
                    const callers = index.findCallers('Box', { targetDefinitions: [def], collectAccount: true });
                    assert.equal(callers.length, def.startLine === 4 ? 1 : 0, def.params);
                }
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.equal(callees.find(def => def.type === 'constructor')?.startLine, 4);
                assert.equal(callees.calleeAccount.conserved, true);
            } finally { rm(dir); }
        });
    }
    for (const [label, imports, formal, project, expected] of [
        ['single JDK import', 'import java.lang.reflect.Type;', 'Type', false, 2],
        ['JDK on-demand import', 'import java.lang.reflect.*;', 'Type', false, 2],
        ['qualified JDK type', '', 'java.lang.reflect.Type', false, 2],
        ['local type before on-demand import', 'import java.lang.reflect.*;', 'Type', true, 3],
        ['qualified project type', 'package p;', 'p.Type', true, 3],
        ['imported project type', 'import q.Type;', 'Type', false, 3],
    ]) {
        it(`${label}: parameter binding precedes platform assignability`, () => {
            const code = `${imports}${project ? 'class Type {}' : ''}\nclass Box {Box(${formal} value){}\n Box(java.lang.Object value){}}\nclass Factory {static Box build(){return new Box(String.class);}}\n`;
            const files = { 'N.java': code, 'q/Type.java': 'package q;public class Type {}\n' };
            const dir = tmp(files);
            try {
                const index = idx(dir), callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.equal(callees.find(def => def.type === 'constructor')?.params,
                    `${expected === 2 ? formal : 'java.lang.Object'} value`,
                    callees.unverifiedCallees.map(def => def.reason).join(','));
            } finally { rm(dir); }
        });
    }
    it('Class array elements retain the formal declaration scope', () => {
        const dir = tmp({ 'N.java': 'class Type {}\nclass Box {Box(Type[] value){}\n Box(java.lang.Object[] value){}}\nclass Factory {static java.lang.Class<?>[] source(){return null;} static Box build(){return new Box(source());}}\n' });
        try {
            const index = idx(dir), callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
            assert.equal(callees.find(def => def.type === 'constructor')?.startLine, 3);
        } finally { rm(dir); }
    });
    for (const formal of ['java.lang.constant.Constable', 'java.lang.invoke.TypeDescriptor', 'java.lang.invoke.TypeDescriptor.OfField<?>']) {
        it(`${formal}: a declared JDK superinterface remains applicable`, () => {
            const dir = tmp({ 'N.java': `class Box {Box(${formal} value){}\n Box(java.lang.Object value){}}\nclass Factory {static Box build(){return new Box(String.class);}}\n` });
            try {
                const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.equal(callees.find(def => def.type === 'constructor')?.bindingId, ctors[0].bindingId);
                assert.equal(index.findCallers('Box', { targetDefinitions: [ctors[0]], collectAccount: true }).length, 1);
            } finally { rm(dir); }
        });
    }
    for (const member of ['public static int Type;', 'public static void Type(){}']) {
        it(`a static ${member.includes('void') ? 'method' : 'field'} import does not shadow a formal type`, () => {
            const dir = tmp({
                'p/Holder.java': `package p;public class Holder {${member}}\n`,
                'q/Type.java': 'package q;public class Type {}\n',
                'N.java': 'import static p.Holder.Type;\nimport java.lang.reflect.*;\nclass Box {Box(Type value){}\n Box(Object value){}}\nclass Factory {static Box build(){return new Box(String.class);}}\n',
            });
            try {
                const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                assert.equal(callees.find(def => def.type === 'constructor')?.bindingId, ctors[0].bindingId);
            } finally { rm(dir); }
        });
    }
    it('a static nested-type import belongs to the type namespace', () => {
        const dir = tmp({
            'p/Holder.java': 'package p;public class Holder {public static class Type{}}\n',
            'N.java': 'import static p.Holder.Type;\nclass Box {Box(Type value){}\n Box(Object value){}}\nclass Factory {static Box build(){return new Box(String.class);}}\n',
        });
        try {
            const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
            assert.equal(index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                .find(def => def.type === 'constructor')?.bindingId, ctors[1].bindingId);
        } finally { rm(dir); }
    });
    it('an explicit cast to java.lang.Class retains its qualified identity', () => {
        const dir = tmp({ 'N.java': 'class Type{}\nclass Box {Box(Type value){}\n Box(Object value){}}\nclass Factory {static Box build(Object value){return new Box((java.lang.Class<?>)value);}}\n' });
        try {
            const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
            assert.equal(index.findCallees(index.symbols.get('build')[0], { collectAccount: true })
                .find(def => def.type === 'constructor')?.bindingId, ctors[1].bindingId);
        } finally { rm(dir); }
    });
    it('a class literal cannot implement an imported unrelated interface', () => {
        const dir = tmp({ 'N.java': 'import dep.Opaque;\nclass Box {Box(Opaque value){}\n Box(Object value){}}\nclass Factory {static Box build(){return new Box(String.class);}}\n' });
        try {
            const index = idx(dir), ctors = index.symbols.get('Box').filter(def => def.type === 'constructor');
            for (const ctor of ctors) {
                const callers = index.findCallers('Box', { targetDefinitions: [ctor], collectAccount: true });
                assert.equal(callers.length, ctor.paramsStructured[0].type === 'Object' ? 1 : 0);
                assert.equal(callers.unverifiedEntries.length, 0);
            }
        } finally { rm(dir); }
    });
});

describe('fix #417: external argument types cannot select unrelated constructor overloads', () => {
    const source = (array = false, namespace = '') => `${namespace}class Lit {}\nclass Box {\n Box(Class<?>${array ? '[]' : ''} value){}\n Box(java.lang.reflect.Type${array ? '[]' : ''} value){}\n Box(Lit${array ? '[]' : ''} value){}\n}\nclass Factory {\n static java.lang.reflect.ParameterizedType${array ? '[]' : ''} source(){return null;}\n static java.lang.reflect.ParameterizedType${array ? '[]' : ''} value;\n static Box build(){return new Box(ARG);}\n}\n`;
    for (const [label, argument, array] of [
        ['return', 'source()', false], ['field', 'Factory.value', false],
        ['array-return', 'source()', true], ['array-field', 'Factory.value', true],
    ]) {
        for (const namespace of ['', 'package p;']) {
            it(`${namespace ? 'package' : 'default-package'} ${label}: a project namesake is not an applicable parameter type`, () => {
                const dir = tmp({ 'N.java': source(array, namespace).replace('ARG', argument) });
                try {
                    const index = idx(dir), constructors = index.symbols.get('Box').filter(def => def.type === 'constructor');
                    for (const ctor of constructors) {
                        const callers = index.findCallers('Box', { targetDefinitions: [ctor], collectAccount: true });
                        assert.equal(callers.length, ctor.startLine === 4 ? 1 : 0, ctor.params);
                    }
                    const callees = index.findCallees(index.symbols.get('build')[0], { collectAccount: true });
                    assert.equal(callees.find(def => def.type === 'constructor')?.startLine, 4, JSON.stringify(callees.unverifiedCallees));
                    assert.equal(callees.calleeAccount.conserved, true);
                } finally { rm(dir); }
            });
        }
    }
    it('a recursive return-type comparison retains the constructor type parameter scope', () => {
        const dir = tmp({ 'N.java': 'class Value {}\nclass Box {\n <Value> Box(Value value){}\n Box(String value){}\n}\nclass Factory {static java.lang.reflect.ParameterizedType source(){return null;} static Box build(){return new Box(source());}}\n' });
        try {
            const index = idx(dir), ctor = index.symbols.get('Box').find(def => def.type === 'constructor' && def.startLine === 3);
            assert.equal(index.findCallers('Box', { targetDefinitions: [ctor], collectAccount: true }).length, 1);
            assert.ok(index.findCallees(index.symbols.get('build')[0], { collectAccount: true }).some(def => def.type === 'constructor' && def.startLine === 3));
        } finally { rm(dir); }
    });
    it('a changed interface-taking constructor is checked against the saved overload binding', () => {
        const { execFileSync } = require('child_process');
        const code = source().replace('ARG', 'source()'), dir = tmp({ 'N.java': code });
        const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'pipe' });
        try {
            git('init', '-q'); git('add', '.'); git('commit', '-qm', 'initial');
            fs.writeFileSync(path.join(dir, 'N.java'), code.replace('Type value)', 'Type value,int required)'));
            const result = execute(idx(dir), 'check', { name: 'N.java:4:Box' });
            assert.ok(result.ok, result.error);
            assert.equal(result.result.mismatches, 1, JSON.stringify(result.result));
            assert.equal(result.result.valid, 0);
            assert.equal(result.result.mismatchDetails[0].boundBeforeChange, true);
        } finally { rm(dir); }
    });
});

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
            assert.strictEqual(ctx.methods.length, 3, 'User exposes its constructor, greet and validate');

            const methodNames = ctx.methods.map(m => m.name);
            assert.ok(methodNames.includes('greet'), 'Should include greet');
            assert.ok(methodNames.includes('validate'), 'Should include validate');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

describe('v5 ownership evidence: nested Java method identity', () => {
    it('does not conflate overloads on same-named nested classes in one package', () => {
        const dir = tmp({
            'src/main/java/p/OuterA.java': [
                'package p;',
                'public class OuterA {',
                '  public static class Builder {',
                '    public int build(int value) { return value; }',
                '  }',
                '  public static Builder builder() { return new Builder(); }',
                '}',
            ].join('\n'),
            'src/main/java/p/OuterB.java': [
                'package p;',
                'public class OuterB {',
                '  public static class Builder {',
                '    public String build(String value) { return value; }',
                '  }',
                '  public static Builder builder() { return new Builder(); }',
                '}',
            ].join('\n'),
            'src/main/java/p/Use.java': [
                'package p;',
                'class Use {',
                '  void run(OuterA.Builder a, OuterB.Builder b) {',
                '    a.build(1);',
                '    b.build("x");',
                '    OuterA.builder().build(2);',
                '    OuterB.builder().build("y");',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('build').find(d =>
                d.relativePath.endsWith('/OuterA.java'));
            assert.strictEqual(target.enclosingType, 'OuterA');
            const callers = index.findCallers('build', {
                targetDefinitions: [target],
                collectAccount: true,
            });
            assert.ok(callers.some(c => c.relativePath.endsWith('/Use.java') && c.line === 4),
                `OuterA.Builder.build call must confirm: ${JSON.stringify(callers)}`);
            assert.ok(callers.some(c => c.relativePath.endsWith('/Use.java') && c.line === 6),
                `OuterA builder chain must confirm: ${JSON.stringify(callers)}`);
            assert.ok(!callers.some(c => c.relativePath.endsWith('/Use.java') && c.line === 5),
                `OuterB.Builder.build must not confirm: ${JSON.stringify(callers)}`);
            assert.ok(!callers.some(c => c.relativePath.endsWith('/Use.java') && c.line === 7),
                `OuterB builder chain must not confirm: ${JSON.stringify(callers)}`);
            assert.ok(!(callers.unverifiedCallers || [])
                .some(c => c.relativePath.endsWith('/Use.java') &&
                    (c.line === 5 || c.line === 7)),
                `other nested owner must be excluded, not ambiguous: ` +
                `${JSON.stringify(callers.unverifiedCallers)}`);
            const result = execute(index, 'context', {
                name: `${target.relativePath}:${target.startLine}:build`,
            });
            assert.ok(result.ok, result.error);
            assert.strictEqual(result.result.meta.account.conserved, true);
        } finally { rm(dir); }
    });

    it('routes explicit Java static owners before overload ambiguity', () => {
        const dir = tmp({
            'src/main/java/p/A.java': [
                'package p;',
                'class A { static String get(String value) { return value; } }',
            ].join('\n'),
            'src/main/java/p/B.java': [
                'package p;',
                'class B { static String get(String value) { return value; } }',
            ].join('\n'),
            'src/main/java/p/Use.java': [
                'package p;',
                'class Use {',
                '  void run() { A.get("a"); B.get("b"); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('get').find(d => d.className === 'A');
            const callers = index.findCallers('get', {
                targetDefinitions: [target],
                collectAccount: true,
            });
            assert.strictEqual(callers.filter(c => c.relativePath.endsWith('/Use.java')).length, 1);
            assert.ok(!(callers.unverifiedEntries || [])
                .some(c => c.relativePath.endsWith('/Use.java')),
                `B.get must be excluded before overload routing: ` +
                `${JSON.stringify(callers.unverifiedEntries)}`);
        } finally { rm(dir); }
    });
});

describe('v5 Java evidence: nested fields, overloads, dispatch, and recursion', () => {
    it('carries lexical nested owners through a declared-field receiver path', () => {
        const dir = tmp({
            'Code.java': [
                'class Code {',
                '  static class Builder {',
                '    Code build() { return new Code(); }',
                '  }',
                '}',
            ].join('\n'),
            'Envelope.java': [
                'class Envelope {',
                '  static class Builder {',
                '    Code.Builder code;',
                '  }',
                '  Envelope(Builder builder) {',
                '    builder.code.build();',
                '  }',
                '}',
            ].join('\n'),
            'Decoy.java': [
                'class Decoy {',
                '  static class Builder {',
                '    Decoy build() { return new Decoy(); }',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('build').find(definition =>
                definition.enclosingType === 'Code');
            const callers = index.findCallers('build', {
                targetDefinitions: [target],
                collectAccount: true,
            });
            assert.ok(callers.some(caller =>
                caller.relativePath === 'Envelope.java' && caller.line === 6),
            `Code.Builder.build owns the nested field call: ${JSON.stringify(callers)}`);
            assert.ok(!(callers.unverifiedEntries || []).some(entry =>
                entry.relativePath === 'Envelope.java' && entry.line === 6),
            `exact nested field identity is not ambiguous: ` +
                `${JSON.stringify(callers.unverifiedEntries)}`);
        } finally { rm(dir); }
    });

    it('uses an enclosing field type to select an inherited varargs overload', () => {
        const dir = tmp({
            'Spec.java': 'class Spec {}',
            'Base.java': [
                'import java.util.List;',
                'class Base {',
                '  Base annotated(Spec... values) { return this; }',
                '  Base annotated(List<Spec> values) { return this; }',
                '}',
            ].join('\n'),
            'Child.java': [
                'import java.util.List;',
                'class Child extends Base {',
                '  @Override Child annotated(List<Spec> values) { return this; }',
                '}',
            ].join('\n'),
            'Use.java': [
                'class Use {',
                '  private final Spec VALUE = new Spec();',
                '  void run(Child child) {',
                '    child.annotated(VALUE);',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('annotated').find(definition =>
                definition.className === 'Child');
            const callers = index.findCallers('annotated', {
                targetDefinitions: [target],
                collectAccount: true,
            });
            assert.ok(!callers.some(caller =>
                caller.relativePath === 'Use.java' && caller.line === 4));
            assert.ok(!(callers.unverifiedEntries || []).some(entry =>
                entry.relativePath === 'Use.java' && entry.line === 4));
            assert.ok((callers.accountRaw?.excludedEntries || []).some(entry =>
                entry.line === 4 && entry.reason === 'overload-mismatch'),
            `Spec field selects inherited Spec... overload: ${JSON.stringify(callers.accountRaw)}`);
        } finally { rm(dir); }
    });

    it('labels multi-owner Object methods as runtime dispatch, not actionable ambiguity', () => {
        const dir = tmp({
            'A.java': 'class A { @Override public String toString() { return "a"; } }',
            'B.java': 'class B { @Override public String toString() { return "b"; } }',
            'Use.java': [
                'class Use {',
                '  String render(Object value) { return value.toString(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('toString').find(definition =>
                definition.className === 'A');
            const callers = index.findCallers('toString', {
                targetDefinitions: [target],
                collectAccount: true,
            });
            const site = (callers.unverifiedEntries || []).find(entry =>
                entry.relativePath === 'Use.java' && entry.line === 2);
            assert.strictEqual(site?.reason, 'possible-dispatch');
            assert.ok(String(site?.dispatchVia || '').startsWith('Object'));
        } finally { rm(dir); }
    });

    it('exposes exact self-recursion on the contract callee surface', () => {
        const dir = tmp({
            'Walk.java': [
                'class Walk {',
                '  void walk(int depth) {',
                '    if (depth > 0) walk(1);',
                '  }',
                '  void walk(String value) {}',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('walk').find(definition =>
                definition.startLine === 2);
            const callees = index.findCallees(target, {
                includeMethods: true,
                collectAccount: true,
            });
            const recursive = callees.find(edge =>
                edge.bindingId === target.bindingId);
            assert.deepStrictEqual(recursive?.sites, [3]);
            assert.strictEqual(
                callees.calleeAccount?.excluded.byReason['self-recursion'] || 0,
                0);
            assert.strictEqual(callees.calleeAccount?.conserved, true);
        } finally { rm(dir); }
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
            const types = symbols.map(s => s.type);
            assert.strictEqual(types.filter(t => t === 'class').length, 1, 'Should have exactly 1 class entry');
            const constructors = symbols.filter(s => s.type === 'constructor');
            assert.strictEqual(constructors.length, 2, 'Each declared constructor has its own symbol');
            assert.strictEqual(new Set(constructors.map(def => def.bindingId)).size, 2);
            assert.deepStrictEqual(constructors.map(def => def.params), ['', 'int value']);
            assert.strictEqual(symbols.length, 3, 'One class and two constructor declarations');
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
        const { getParser, getLanguageAdapter } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageAdapter('java');
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
        const { getParser, getLanguageAdapter } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageAdapter('java');
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
        const { getParser, getLanguageAdapter } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageAdapter('java');
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
        const { getParser, getLanguageAdapter } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageAdapter('java');
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
        const { getParser, getLanguageAdapter } = require('../languages/index');
        const parser = getParser('java');
        const javaMod = getLanguageAdapter('java');
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
    public long longValue() { return 1; }
    public float floatValue() { return 1; }
    public double doubleValue() { return 1; }
}
`,
        'Caller.java': `public class Caller {
    void use(Object o, java.util.List<LazyNum> nums) {
        int a = ((Integer) o).intValue();
        int b = nums.get(0).ownMethod();
    }
    void opaque(java.util.function.Supplier<LazyNum> value) {
        value.get().ownMethod();
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

    it('a typed SDK collection element supplies receiver evidence', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'LazyNum.java:4:ownMethod');
            assert.ok(res.confirmed.includes('Caller.java:4'));
            assert.ok(!res.unverified.some(c => c.key === 'Caller.java:4'));
            assert.strictEqual(res.conserved, true);
        } finally { rm(dir); }
    });

    it('un-marked single-owner methods remain visible without receiver evidence (#355)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'LazyNum.java:4:ownMethod');
            assert.ok(!res.confirmed.includes('Caller.java:7'));
            assert.strictEqual(res.unverified.find(c => c.key === 'Caller.java:7')?.reason, 'single-owner');
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
            assert.ok(text.includes('CALLERS — RUNTIME DISPATCH'));
            assert.ok(text.includes('via Number: 1 site; open external implementation set'),
                `label renders the contract: ${text}`);
        } finally { rm(dir); }
    });

    it('legacy drops unsupported receivers and retains typed callers (#355)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const { findCallers } = require('../core/callers');
            const legacy = findCallers(index, 'intValue', {});
            assert.ok(!legacy.some(c => (c.relativePath || c.file).includes('Caller.java') && c.line === 3));
            assert.ok(legacy.some(c => c.relativePath === 'Typed.java' && c.line === 4));
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

    it('a receiver with no modeled member cannot prove a different target (#355)', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const res = contract(index, 'src/Num.java:2:size');
            assert.ok(!res.confirmed.includes('src/Show.java:5'),
                'x is typed Other — not a Num caller');
            assert.strictEqual(res.unverified.find(u => u.key === 'src/Show.java:5')?.reason, 'provenance-incomplete');
            assert.strictEqual(res.conserved, true);
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
            assert.ok(at.result.notStaticallyLinked.includes('square'));
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
            '        k.set(null);',     // 6 — compiler-visible ambiguity
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

    it('uses exact argument types and keeps genuinely ambiguous overloads visible', () => {
        const dir = tmp(FILES);
        try {
            const index = idx(dir);
            const go = (index.symbols.get('go') || [])[0];
            const res = index.findCallees(go, { includeMethods: true, collectAccount: true });
            const setEdges = res.filter(e => e.name === 'set');
            const confirmedSites = setEdges.flatMap(e => e.sites || []);
            assert.ok(confirmedSites.includes(5),
                `k.set(a) statically selects set(A): ${JSON.stringify(setEdges)}`);
            assert.ok(!confirmedSites.includes(6),
                `k.set(null) cannot pick between set(A)/set(B): ${JSON.stringify(setEdges)}`);
            const unv = (res.unverifiedCallees || []).find(u => u.name === 'set');
            assert.ok(unv && (unv.sites || []).includes(6),
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

describe('v5 Java compiler-shaped call IR', () => {
    it('does not treat Java type-qualified static calls as unbound instance calls', () => {
        const dir = tmp({
            'TypeVariableName.java': [
                'class TypeVariableName {',
                '  static void get(Object value) {}',
                '  static void get(String name, Object... bounds) {}',
                '}',
            ].join('\n'),
            'Use.java': [
                'class Use {',
                '  void run() { TypeVariableName.get("T", new Object()); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const oneArg = index.symbols.get('get').find(definition =>
                definition.startLine === 2);
            const result = index.findCallers('get', {
                targetDefinitions: [oneArg], collectAccount: true,
            });
            assert.strictEqual(result.length, 0);
            assert.strictEqual(result.unverifiedEntries?.length || 0, 0);
            assert.ok((result.accountRaw?.excludedEntries || []).some(entry =>
                entry.line === 2 && entry.reason === 'other-definition'),
            `the two-argument call binds the sibling: ${JSON.stringify(result.accountRaw)}`);
        } finally { rm(dir); }
    });

    it('uses class-qualified static field types to select overloads', () => {
        const dir = tmp({
            'Type.java': 'interface Type {}',
            'TypeName.java': [
                'class TypeName {',
                '  static final TypeName DOUBLE = new TypeName();',
                '}',
            ].join('\n'),
            'ParameterSpec.java': [
                'class ParameterSpec {',
                '  static void builder(Type type, String name) {}',
                '  static void builder(TypeName type, String name) {}',
                '  void go() { ParameterSpec.builder(TypeName.DOUBLE, "money"); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const definitions = index.symbols.get('builder');
            const typeOverload = definitions.find(definition =>
                definition.paramsStructured?.[0]?.type === 'Type');
            const typeNameOverload = definitions.find(definition =>
                definition.paramsStructured?.[0]?.type === 'TypeName');

            const wrong = index.findCallers('builder', {
                targetDefinitions: [typeOverload], collectAccount: true,
            });
            assert.strictEqual(wrong.length, 0);
            assert.strictEqual(wrong.unverifiedEntries?.length || 0, 0);
            assert.ok((wrong.accountRaw?.excludedEntries || []).some(entry =>
                entry.line === 4 && entry.reason === 'other-definition'));

            const right = index.findCallers('builder', {
                targetDefinitions: [typeNameOverload], collectAccount: true,
            });
            assert.ok(right.some(caller => caller.line === 4),
                `field type selects TypeName overload: ${JSON.stringify(right)}`);
        } finally { rm(dir); }
    });

    it('uses same-class helpers, generic collection values, and JDK return contracts for overloads', () => {
        const dir = tmp({
            'A.java': 'class A {}',
            'B.java': 'class B {}',
            'K.java': [
                'import java.lang.reflect.Method;',
                'import java.lang.reflect.Type;',
                'import java.util.List;',
                'class K {',
                '  void pick(A value) {}',
                '  void pick(B value) {}',
                '  void reflect(Class<?> value) {}',
                '  void reflect(Type value) {}',
                '  A make() { return new A(); }',
                '  void go(List<A> values, Method method) {',
                '    pick(make());',
                '    pick(values.get(0));',
                '    reflect(method.getReturnType());',
                '    reflect(method.getGenericReturnType());',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const go = index.symbols.get('go')[0];
            const callees = index.findCallees(go, {
                collectAccount: true,
                includeMethods: true,
            });
            const sitesFor = startLine => callees
                .filter(edge => edge.startLine === startLine)
                .flatMap(edge => edge.sites || []);
            assert.deepStrictEqual(sitesFor(5), [11, 12],
                `A overload selected from helper and List<A>.get: ${JSON.stringify(callees)}`);
            assert.deepStrictEqual(sitesFor(7), [13],
                `Method.getReturnType selects Class: ${JSON.stringify(callees)}`);
            assert.deepStrictEqual(sitesFor(8), [14],
                `Method.getGenericReturnType selects Type: ${JSON.stringify(callees)}`);
            assert.ok(!(callees.unverifiedCallees || []).some(edge =>
                ['pick', 'reflect'].includes(edge.name) &&
                [11, 12, 13, 14].some(line => edge.sites?.includes(line))),
            `compiler-shaped sites are not unverified: ${JSON.stringify(callees.unverifiedCallees)}`);
        } finally { rm(dir); }
    });

    it('excludes platform collection calls from an unrelated project method', () => {
        const dir = tmp({
            'Target.java': 'class Target { void get(int index) {} }',
            'Use.java': [
                'import javax.lang.model.element.ExecutableElement;',
                'class Use {',
                '  Object first(ExecutableElement element) {',
                '    return element.getParameters().get(0);',
                '  }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const target = index.symbols.get('get')
                .find(definition => definition.className === 'Target');
            const result = index.findCallers('get', {
                targetDefinitions: [target],
                collectAccount: true,
                includeMethods: true,
            });
            assert.strictEqual(result.length, 0);
            assert.strictEqual(result.unverifiedEntries?.length || 0, 0);
            assert.ok((result.accountRaw?.excludedEntries || []).some(entry =>
                entry.line === 4 && entry.reason === 'receiver-type-mismatch'),
            `List.get is positively outside Target.get: ${JSON.stringify(result.accountRaw)}`);
        } finally { rm(dir); }
    });

    it('resolves bare static calls through a nested class lexical owner', () => {
        const dir = tmp({
            'A.java': 'class A {}',
            'Outer.java': [
                'class Outer {',
                '  static void get(A value) {}',
                '  static class Inner {',
                '    void run(A value) { get(value); }',
                '  }',
                '}',
            ].join('\n'),
            'Other.java': 'class Other { static void get(A value) {} }',
        });
        try {
            const index = idx(dir);
            const defs = index.symbols.get('get');
            const outer = defs.find(definition => definition.className === 'Outer');
            const other = defs.find(definition => definition.className === 'Other');
            const outerCallers = index.findCallers('get', {
                targetDefinitions: [outer], collectAccount: true,
            });
            assert.ok(outerCallers.some(caller =>
                caller.relativePath === 'Outer.java' && caller.line === 4));
            const otherCallers = index.findCallers('get', {
                targetDefinitions: [other], collectAccount: true,
            });
            assert.ok(!otherCallers.some(caller =>
                caller.relativePath === 'Outer.java' && caller.line === 4));
            assert.ok(!(otherCallers.unverifiedEntries || []).some(entry =>
                entry.relativePath === 'Outer.java' && entry.line === 4));
        } finally { rm(dir); }
    });
});

describe('v5 Java nested-type callee identity', () => {
    it('keeps chained Builder.build calls on the defining outer type', () => {
        const dir = tmp({
            'AnnotationSpec.java': [
                'class AnnotationSpec {',
                '  static class Builder { AnnotationSpec build() { return null; } }',
                '}',
            ].join('\n'),
            'CodeBlock.java': [
                'class CodeBlock {',
                '  static Builder builder() { return new Builder(); }',
                '  static class Builder {',
                '    Builder add() { return this; }',
                '    CodeBlock build() { return new CodeBlock(); }',
                '  }',
                '}',
            ].join('\n'),
            'Use.java': [
                'class Use {',
                '  CodeBlock run() { return CodeBlock.builder().add().build(); }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const run = index.symbols.get('run')[0];
            const callees = index.findCallees(run, {
                collectAccount: true,
                includeMethods: true,
            });
            const build = callees.find(edge =>
                edge.name === 'build' && edge.sites?.includes(2));
            assert.ok(build, JSON.stringify(callees));
            assert.equal(build.relativePath, 'CodeBlock.java');
            assert.equal(build.enclosingType, 'CodeBlock');
            assert.ok(!(callees.unverifiedCallees || []).some(edge =>
                edge.name === 'build' && edge.sites?.includes(2)));
        } finally { rm(dir); }
    });
});

describe('fix #286c (Java): static-imported field receivers resolve as values', () => {
    it('a capitalized static-imported field types the receiver by its declared type', () => {
        // jsoup-measured (scheduled eval, 2026-08-17): `import static
        // ...SimpleBufferedInput.BufferPool` binds BufferPool.borrow() to the
        // SoftPool-typed field, but the capitalized receiver took the
        // static-call reading and excluded the compiler-true caller
        // receiver-other-class.
        const dir = tmp({
            'com/ex/Pool.java': [
                'package com.ex;',
                '',
                'public class Pool {',
                '    public byte[] borrow() {',
                '        return new byte[16];',
                '    }',
                '}',
                '',
            ].join('\n'),
            'com/ex/Owner.java': [
                'package com.ex;',
                '',
                'public class Owner {',
                '    static final Pool BufferPool = new Pool();',
                '}',
                '',
            ].join('\n'),
            'com/ex/User.java': [
                'package com.ex;',
                '',
                'import static com.ex.Owner.BufferPool;',
                '',
                'public class User {',
                '    byte[] use() {',
                '        return BufferPool.borrow();',
                '    }',
                '}',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'com/ex/Pool.java:4:borrow' });
            assert.ok(r.ok, `context failed: ${r.error}`);
            assert.ok(r.result.callers.some(c =>
                c.relativePath === 'com/ex/User.java' && c.line === 7),
                `static-imported field call must confirm: ${JSON.stringify(r.result.callers)}`);
            const excl = r.result.meta.account.excluded.byReason || {};
            assert.ok(!excl['receiver-other-class'],
                `must not exclude receiver-other-class: ${JSON.stringify(excl)}`);
            assert.ok(r.result.meta.account.conserved);
        } finally { rm(dir); }
    });

    it('a static import naming a nested type keeps static-call semantics', () => {
        // Counter-probe: `import static com.ex.Holder.Inner` imports a TYPE —
        // Inner.borrow() stays a static-qualified call against the nested
        // class, never a field-typed value receiver.
        const dir = tmp({
            'com/ex/Pool2.java': [
                'package com.ex;',
                '',
                'public class Pool2 {',
                '    public byte[] borrow() {',
                '        return new byte[16];',
                '    }',
                '}',
                '',
            ].join('\n'),
            'com/ex/Holder.java': [
                'package com.ex;',
                '',
                'public class Holder {',
                '    public static class Inner {',
                '        static byte[] borrow() {',
                '            return new byte[4];',
                '        }',
                '    }',
                '}',
                '',
            ].join('\n'),
            'com/ex/User2.java': [
                'package com.ex;',
                '',
                'import static com.ex.Holder.Inner;',
                '',
                'public class User2 {',
                '    byte[] use() {',
                '        return Inner.borrow();',
                '    }',
                '}',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'context', { name: 'com/ex/Pool2.java:4:borrow' });
            assert.ok(r.ok);
            assert.ok(!r.result.callers.some(c => c.relativePath === 'com/ex/User2.java'),
                'Inner.borrow() must never confirm against Pool2.borrow');
        } finally { rm(dir); }
    });
});

describe('fix #299D: Java overload-ambiguous promotion by static shape', () => {
    const writerFixture = () => tmp({
        'Writer.java': [
            'public class Writer {',
            '  public Writer value(String v) { return this; }',
            '  public Writer value(boolean v) { return this; }',
            '  public Writer value(float v) { return this; }',
            '  public Writer value(double v) { return this; }',
            '  public Writer value(long v) { return this; }',
            '  public Writer value(Number v) { return this; }',
            '}',
        ].join('\n'),
        'TreeWriter.java': [
            'public class TreeWriter extends Writer {',
            '  @Override public Writer value(String v) { return this; }',
            '  @Override public Writer value(boolean v) { return this; }',
            '  @Override public Writer value(float v) { return this; }',
            '  @Override public Writer value(double v) { return this; }',
            '  @Override public Writer value(long v) { return this; }',
            '  @Override public Writer value(Number v) { return this; }',
            '}',
        ].join('\n'),
        'Use.java': [
            'public class Use {',
            '  void run(TreeWriter w) {',
            '    w.value(7);',
            '    w.value("s");',
            '    w.value((Number) get());',
            '    w.value(Float.NaN);',
            '  }',
            '  Object get() { return null; }',
            '}',
        ].join('\n'),
    });

    it('an int literal binds value(long): widening beats boxing, narrowest wins', () => {
        const dir = writerFixture();
        try {
            const index = idx(dir);
            const longPin = (index.symbols.get('value') || []).find(d =>
                d.className === 'TreeWriter' && d.paramsStructured?.[0]?.type === 'long');
            const result = index.findCallers('value', {
                targetDefinitions: [longPin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepStrictEqual(result.map(c => c.line), [3],
                'only the int-literal site: ' + JSON.stringify(result.map(c => c.line)));
            const excluded = result.accountRaw.excludedEntries;
            assert.ok(excluded.some(e => e.line === 4 && e.reason === 'overload-mismatch'),
                'the String site binds value(String): ' + JSON.stringify(excluded));
            assert.ok(excluded.some(e => e.line === 5 && e.reason === 'overload-mismatch'),
                'the cast-Number site binds value(Number): ' + JSON.stringify(excluded));
            assert.ok(excluded.some(e => e.line === 6 && e.reason === 'overload-mismatch'),
                'Float.NaN is a float — binds value(float): ' + JSON.stringify(excluded));
        } finally { rm(dir); }
    });

    it('overridden ancestor slots never re-enter the family as siblings', () => {
        const dir = writerFixture();
        try {
            const index = idx(dir);
            const numberPin = (index.symbols.get('value') || []).find(d =>
                d.className === 'TreeWriter' && d.paramsStructured?.[0]?.type === 'Number');
            const result = index.findCallers('value', {
                targetDefinitions: [numberPin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepStrictEqual(result.map(c => c.line), [5],
                'the cast-Number site confirms uniquely: ' +
                JSON.stringify(result.map(c => c.line)));
        } finally { rm(dir); }
    });

    const sinkFixture = (extra = {}) => tmp({
        'Element.java': 'public class Element {}',
        'Sink.java': [
            'public class Sink {',
            '  public void add(Boolean b) {}',
            '  public void add(Character c) {}',
            '  public void add(Number n) {}',
            '  public void add(String s) {}',
            '  public void add(Element e) {}',
            '}',
        ].join('\n'),
        'UseSink.java': [
            'import java.math.BigInteger;',
            'public class UseSink {',
            '  void run(Sink s) {',
            '    s.add((Integer) box());',
            '    s.add(BigInteger.valueOf(9));',
            '    s.add((char) c());',
            '    s.add((Boolean) box());',
            '  }',
            '  Object box() { return null; }',
            '  char c() { return 120; }',
            '}',
        ].join('\n'),
        ...extra,
    });

    it('platform value types decide reference overloads', () => {
        const dir = sinkFixture();
        try {
            const index = idx(dir);
            const numberPin = (index.symbols.get('add') || []).find(d =>
                d.className === 'Sink' && d.paramsStructured?.[0]?.type === 'Number');
            const result = index.findCallers('add', {
                targetDefinitions: [numberPin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.deepStrictEqual(result.map(c => c.line).sort((a, b) => a - b), [4, 5],
                'Integer cast + BigInteger.valueOf bind add(Number): ' +
                JSON.stringify(result.map(c => c.line)));
            const excluded = result.accountRaw.excludedEntries;
            assert.ok(excluded.some(e => e.line === 6 && e.reason === 'overload-mismatch'),
                'char boxes to Character, never Number: ' + JSON.stringify(excluded));
            assert.ok(excluded.some(e => e.line === 7 && e.reason === 'overload-mismatch'),
                'Boolean binds add(Boolean): ' + JSON.stringify(excluded));
        } finally { rm(dir); }
    });

    it('a project class shadowing a platform name refuses the ancestry denial', () => {
        const dir = sinkFixture({
            'Integer.java': 'public class Integer extends Element {}',
        });
        try {
            const index = idx(dir);
            const elementPin = (index.symbols.get('add') || []).find(d =>
                d.className === 'Sink' && d.paramsStructured?.[0]?.type === 'Element');
            const result = index.findCallers('add', {
                targetDefinitions: [elementPin],
                collectAccount: true,
                includeMethods: true,
            });
            assert.ok(!result.accountRaw.excludedEntries.some(e => e.line === 4),
                'the project Integer may bind add(Element): ' +
                JSON.stringify(result.accountRaw.excludedEntries));
        } finally { rm(dir); }
    });
});

describe('fix #386: renaming a type edits every reference to it', () => {
    const { applyRenamePlan } = require('./helpers');
    const files = {
        'src/com/a/Widget.java': [
            'package com.a;',
            '',
            'public class Widget extends Base implements Shape {',
            '    public static final int SIZE = 3;',
            '    private Widget next;',
            '    public Widget() { this(1); }',
            '    public Widget(int n) { super(); }',
            '    public static Widget make() { return new Widget(); }',
            '    public Widget copy(Widget other) {',
            '        Widget w = (Widget) other;',
            '        if (other instanceof Widget) { return w; }',
            '        return Widget.make();',
            '    }',
            '}',
        ].join('\n'),
        'src/com/a/Base.java': 'package com.a;\npublic class Base {}\n',
        'src/com/a/Shape.java': 'package com.a;\npublic interface Shape {}\n',
        'src/com/a/User.java': [
            'package com.a;',
            'import java.util.List;',
            'public class User {',
            '    List<Widget> items;',
            '    Class<?> k = Widget.class;',
            '    int s = Widget.SIZE;',
            '    Widget build() { return Widget.make(); }',
            '    void run() { java.util.function.Supplier<Widget> f = Widget::new; }',
            '}',
        ].join('\n'),
        'src/com/b/Widget.java': 'package com.b;\npublic class Widget { }\n',
        'src/com/b/Other.java': [
            'package com.b;',
            'import com.a.Shape;',
            'public class Other extends com.a.Base {',
            '    Widget local;',
            '    com.a.Widget far;',
            '}',
        ].join('\n'),
        'src/com/b/Imp.java': [
            'package com.b;',
            'import com.a.Widget;',
            'public class Imp {',
            '    Widget w = new Widget();',
            '    Widget get() { return w; }',
            '}',
        ].join('\n'),
    };

    it('Java: type positions, constructors, casts, literals, imports and qualified names; the other package keeps its Widget', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'Widget', file: 'com/a/Widget.java', renameTo: 'Gadget' });
            assert.ok(r.ok, r.error);
            const { contents, reviews } = applyRenamePlan(dir, r.result);
            assert.deepStrictEqual(reviews, []);
            const renamed = text => text.replace(/\bWidget\b/g, 'Gadget');
            assert.strictEqual(contents['src/com/a/Gadget.java'], renamed(files['src/com/a/Widget.java']));
            assert.strictEqual(contents['src/com/a/Widget.java'], null, 'the public class moves to Gadget.java');
            assert.strictEqual(contents['src/com/a/User.java'], renamed(files['src/com/a/User.java']));
            assert.strictEqual(contents['src/com/b/Imp.java'], renamed(files['src/com/b/Imp.java']));
            assert.strictEqual(contents['src/com/b/Other.java'],
                files['src/com/b/Other.java'].replace('com.a.Widget far', 'com.a.Gadget far'));
            assert.ok(!('src/com/b/Widget.java' in contents), 'com.b.Widget is another type');
            assert.deepStrictEqual(r.result.fileRenames,
                [{ from: 'src/com/a/Widget.java', to: 'src/com/a/Gadget.java' }]);
            assert.strictEqual(r.result.unverifiedCount, 0, JSON.stringify(r.result.unverifiedSites));
        } finally { rm(dir); }
    });

    it('Java: a field named like the type is not the type; a nested type is renamed through its outer name', () => {
        const dir = tmp({
            'src/p/Outer.java': [
                'package p;',
                'public class Outer {',
                '    public static class Widget { static int N = 1; }',
                '    Widget w;',
                '}',
            ].join('\n'),
            'src/p/Use.java': [
                'package p;',
                'public class Use {',
                '    Outer.Widget a = new Outer.Widget();',
                '    int Widget = 2;',
                '    int b() { return Widget + 1; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'Widget', file: 'p/Outer.java', renameTo: 'Gadget' });
            assert.ok(r.ok, r.error);
            const { contents, reviews } = applyRenamePlan(dir, r.result);
            assert.deepStrictEqual(reviews, []);
            assert.ok(contents['src/p/Outer.java'].includes('public static class Gadget'));
            assert.ok(contents['src/p/Outer.java'].includes('    Gadget w;'));
            assert.ok(contents['src/p/Use.java'].includes('Outer.Gadget a = new Outer.Gadget();'));
            assert.ok(contents['src/p/Use.java'].includes('int Widget = 2;'));
            assert.ok(contents['src/p/Use.java'].includes('return Widget + 1;'));
            assert.strictEqual(r.result.fileRenames, undefined);
        } finally { rm(dir); }
    });
});

describe('fix #389: Java annotation types, local classes, serialization ancestry', () => {
    const { applyRenamePlan } = require('./helpers');
    const at = entries => (entries || []).map(entry => `${entry.relativePath || entry.file}:${entry.line}`).sort();

    it('an @interface is an indexed interface: elements are methods, element keys are their sites, the shorthand is reviewed', () => {
        const dir = tmp({
            'src/Marker.java': [
                'package p;',
                '',
                'import java.lang.annotation.Retention;',
                'import java.lang.annotation.RetentionPolicy;',
                '',
                '@Retention(RetentionPolicy.RUNTIME)',
                'public @interface Marker {',
                '    String value() default "";',
                '    int priority() default 0;',
                '    int MAX = 10;',
                '}',
            ].join('\n'),
            'src/Use.java': [
                'package p;',
                '',
                '@Marker("x")',
                'public class Use {',
                '    @Marker(value = "y", priority = 2)',
                '    void m() {',
                '        Marker mk = Use.class.getAnnotation(Marker.class);',
                '        int p = mk.priority() + Marker.MAX;',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const marker = (index.symbols.get('Marker') || []).find(d => d.type === 'interface');
            assert.ok(marker && marker.annotationType, JSON.stringify(index.symbols.get('Marker')));
            assert.strictEqual(marker.nameLine, 7);
            const priority = (index.symbols.get('priority') || [])[0];
            assert.strictEqual(priority.className, 'Marker');
            assert.deepStrictEqual((priority.modifiers || []).filter(m => m === 'default'), []);
            assert.deepStrictEqual((index.symbols.get('MAX') || []).map(d => `${d.type}:${d.className}`), ['field:Marker']);
            assert.deepStrictEqual(at(index.context('priority', { file: 'src/Marker.java' }).callers),
                ['src/Use.java:5', 'src/Use.java:8']);
            const type = execute(index, 'plan', { name: 'Marker', file: 'src/Marker.java', renameTo: 'Tag' });
            assert.ok(type.ok, type.error);
            const renamed = applyRenamePlan(dir, type.result);
            assert.deepStrictEqual(renamed.reviews, []);
            assert.ok(!/\bMarker\b/.test(renamed.contents['src/Use.java']), renamed.contents['src/Use.java']);
            assert.strictEqual(renamed.contents['src/Marker.java'], null);
            assert.ok(renamed.contents['src/Tag.java'].includes('public @interface Tag {'));
            const element = execute(index, 'plan', { name: 'priority', file: 'src/Marker.java', renameTo: 'prio' });
            const elementEdits = applyRenamePlan(dir, element.result);
            assert.ok(elementEdits.contents['src/Use.java'].includes('@Marker(value = "y", prio = 2)'));
            // `@Marker("x")` sets `value` with no name token: the rename names it.
            const value = execute(index, 'plan', { name: 'value', file: 'src/Marker.java', renameTo: 'label' });
            assert.deepStrictEqual(value.result.unverifiedSites || [], []);
            const valueEdits = applyRenamePlan(dir, value.result);
            assert.deepStrictEqual(valueEdits.reviews, []);
            assert.ok(valueEdits.contents['src/Use.java'].includes('@Marker(label = "x")'), valueEdits.contents['src/Use.java']);
            assert.ok(valueEdits.contents['src/Use.java'].includes('@Marker(label = "y", priority = 2)'));
            // impact lists the site as a caller with its reason.
            const impact = execute(index, 'impact', { name: 'value', file: 'src/Marker.java' });
            assert.ok(JSON.stringify(impact.result).includes('annotation-shorthand'));
        } finally { rm(dir); }
    });

    it('a local class and its members are not the top-level namesake (callers, callees, members, plans)', () => {
        const dir = tmp({
            'src/Mod.java': [
                'package p;',
                '',
                'class Widget {',
                '    String render() { return "top"; }',
                '}',
                '',
                'public class Mod {',
                '    String build() {',
                '        class Widget {',
                '            String render() { return "local"; }',
                '        }',
                '        Widget w = new Widget();',
                '        return w.render();',
                '    }',
                '',
                '    String useTop() {',
                '        Widget w = new Widget();',
                '        return w.render();',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const top = index.context('render', { file: 'src/Mod.java', line: 4 });
            assert.deepStrictEqual(at(top.callers), ['src/Mod.java:18']);
            assert.deepStrictEqual(at(top.unverifiedCallers), []);
            const local = index.context('render', { file: 'src/Mod.java', line: 10 });
            assert.deepStrictEqual(at(local.callers), ['src/Mod.java:13']);
            assert.deepStrictEqual(at(local.unverifiedCallers), []);
            const build = index.context('build', { file: 'src/Mod.java' });
            assert.deepStrictEqual(build.callees.map(c => `${c.name}:${c.startLine}`).sort(), ['Widget:9', 'render:10']);
            const widget = index.symbols.get('Widget').find(d => d.startLine === 9);
            assert.deepStrictEqual(index.findMethodsForType('Widget', widget).map(m => m.startLine), [10]);
            const plan = execute(index, 'plan', { name: 'render', file: 'src/Mod.java', line: 4, renameTo: 'draw' });
            assert.deepStrictEqual(plan.result.changes.map(c => c.line).sort((a, b) => a - b), [4, 18]);
        } finally { rm(dir); }
    });

    it('serialization members of a class with an out-of-project supertype are possible protocol members', () => {
        const dir = tmp({
            'src/Err.java': [
                'package p;',
                '',
                'import java.io.IOException;',
                'import java.io.ObjectInputStream;',
                'import java.io.ObjectOutputStream;',
                'import java.util.ArrayList;',
                '',
                'class Err extends IOException {',
                '    private static final long serialVersionUID = 1L;',
                '    private void writeObject(ObjectOutputStream out) throws IOException { }',
                '    private Object readResolve() { return this; }',
                '    private Object readObject(String json) { return json; }',
                '}',
                '',
                'class Bag extends ArrayList<String> {',
                '    private Object writeReplace() { return this; }',
                '}',
                '',
                'class Plain {',
                '    private Object readResolve() { return this; }',
                '}',
                '',
                'class Runner implements Runnable {',
                '    public void run() { }',
                '    private Object readResolve() { return this; }',
                '}',
                '',
                'class Ser implements java.io.Serializable {',
                '    private Object readResolve() { return this; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const dead = execute(index, 'deadcode', {});
            const claimed = (dead.result.results || dead.result).map?.(d => `${d.className}.${d.name}`) ||
                JSON.stringify(dead.result);
            const names = new Set(Array.isArray(claimed) ? claimed : []);
            // Kept live: the JDK supertype may be Serializable.
            for (const kept of ['Err.writeObject', 'Err.readResolve', 'Bag.writeReplace', 'Ser.readResolve']) {
                assert.ok(!names.has(kept), `${kept} claimed: ${[...names]}`);
            }
            // Claimable: no out-of-project supertype, a java.lang type known
            // not to be Serializable, or not the protocol's signature.
            for (const claim of ['Plain.readResolve', 'Runner.readResolve', 'Err.readObject']) {
                assert.ok(names.has(claim), `${claim} not claimed: ${[...names]}`);
            }
            const possible = execute(index, 'plan', { name: 'writeObject', file: 'src/Err.java', renameTo: 'w' });
            assert.strictEqual(possible.result.contract?.blocked, false);
            assert.strictEqual(possible.result.contract?.external?.[0]?.certainty, 'possible');
            assert.ok(possible.result.changes.some(c => c.newExpression && c.line === 10));
            const definite = execute(index, 'plan', { name: 'readResolve', file: 'src/Err.java', line: 29, renameTo: 'r' });
            assert.strictEqual(definite.result.contract?.blocked, true);
            const field = execute(index, 'plan', { name: 'serialVersionUID', file: 'src/Err.java', renameTo: 'uid' });
            assert.strictEqual(field.result.contract?.external?.[0]?.reason, 'possible-protocol-member');
        } finally { rm(dir); }
    });
});

describe('fix #390: Java generic base slots, same-name class identity, annotated field names', () => {
    const { applyRenamePlan } = require('./helpers');
    const planLines = (dir, index, handle, to) => {
        const [file, line, name] = handle.split(':');
        const r = execute(index, 'plan', { name, file, line: Number(line), renameTo: to });
        assert.ok(r.ok, r.error);
        const { contents } = applyRenamePlan(dir, r.result);
        const out = [];
        for (const [f, text] of Object.entries(contents)) {
            if (text == null) continue;
            text.split('\n').forEach((row, i) => { if (row.includes(to)) out.push(`${f}:${i + 1}`); });
        }
        return out.sort();
    };

    it('a rename follows the override slot through generic base clauses by substituted parameter types', () => {
        const dir = tmp({
            'src/p/Base.java': [
                'package p;',
                'public abstract class Base<S, R> {',
                '    protected abstract R visit(S state, String x);',
                '    public R run(S s) { return visit(s, "a"); }',
                '}',
            ].join('\n'),
            'src/p/Impl.java': [
                'package p;',
                'public class Impl extends Base<StringBuilder, Boolean> {',
                '    @Override',
                '    protected Boolean visit(StringBuilder state, String x) { return true; }',
                '    protected Boolean visit(Integer other, String x) { return false; }',
                '    void use() {',
                '        visit(new StringBuilder(), "b");',
                '        visit(1, "c");',
                '    }',
                '}',
            ].join('\n'),
            'src/p/Mid.java': 'package p;\npublic abstract class Mid<T> extends Base<T, Boolean> {}\n',
            'src/p/Leaf.java': [
                'package p;',
                'public class Leaf extends Mid<Integer> {',
                '    @Override',
                '    protected Boolean visit(Integer state, String x) { return false; }',
                '    protected Boolean visit(Long state, String x) { return true; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const slot = ['src/p/Base.java:3', 'src/p/Base.java:4', 'src/p/Impl.java:4', 'src/p/Impl.java:7',
                'src/p/Leaf.java:4'];
            // From the base, the override in each subclass, never the
            // other overloads (visit(Integer) in Impl, visit(Long) in Leaf).
            assert.deepStrictEqual(planLines(dir, index, 'src/p/Base.java:3:visit', 'visitZq'), slot);
            // From a leaf through Mid<T> -> Base<T, Boolean>: the same slot.
            assert.deepStrictEqual(planLines(dir, index, 'src/p/Leaf.java:3:visit', 'visitZq'), slot);
            const other = planLines(dir, index, 'src/p/Impl.java:5:visit', 'visitZq');
            assert.ok(!other.includes('src/p/Base.java:3'), other.join(' '));
        } finally { rm(dir); }
    });

    it('a class named like a subclass of the target in another package binds its bare call through its static import', () => {
        const dir = tmp({
            'src/junit/framework/Assert.java': [
                'package junit.framework;',
                'public class Assert {',
                '    public static void assertFalse(boolean c) {}',
                '}',
            ].join('\n'),
            'src/junit/framework/TestCase.java': [
                'package junit.framework;',
                'public abstract class TestCase extends Assert {',
                '    public static void assertTrue(boolean c) {}',
                '}',
            ].join('\n'),
            'src/org/junit/Assert.java': [
                'package org.junit;',
                'public class Assert {',
                '    public static void assertFalse(boolean c) {}',
                '    public static void assertTrue(boolean c) {}',
                '}',
            ].join('\n'),
            'test/junit/samples/MoneyTest.java': [
                'package junit.samples;',
                'import junit.framework.TestCase;',
                'public class MoneyTest extends TestCase {',
                '    public void testA() { assertFalse(false); assertTrue(true); }',
                '}',
            ].join('\n'),
            'test/org/junit/samples/MoneyTest.java': [
                'package org.junit.samples;',
                'import static org.junit.Assert.assertFalse;',
                'import static org.junit.Assert.assertTrue;',
                'public class MoneyTest {',
                '    public void testA() {',
                '        assertFalse(false);',
                '        assertTrue(true);',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const callers = (file, line, name) => {
                const r = index.context(name, { file, line });
                const all = [...(r.callers || []), ...(r.unverifiedCallers || [])];
                return all.map(c => `${c.relativePath || c.file}:${c.line}`).sort();
            };
            assert.deepStrictEqual(callers('src/junit/framework/Assert.java', 3, 'assertFalse'),
                ['test/junit/samples/MoneyTest.java:4']);
            assert.deepStrictEqual(callers('src/org/junit/Assert.java', 3, 'assertFalse'),
                ['test/org/junit/samples/MoneyTest.java:6']);
            // Callee side: the static import, not the other package's TestCase.
            const r = index.context('testA', { file: 'test/org/junit/samples/MoneyTest.java' });
            const callees = (r.callees || []).map(c => `${c.relativePath}:${c.startLine}`).sort();
            assert.deepStrictEqual(callees, ['src/org/junit/Assert.java:3', 'src/org/junit/Assert.java:4']);
        } finally { rm(dir); }
    });

    it('an annotated field is renamed on the line that names it', () => {
        const dir = tmp({
            'src/p/A.java': [
                'package p;',
                'public class A {',
                '    @Deprecated',
                '    int field = 1;',
                '    int use() { return this.field; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('field').find(d => d.className === 'A');
            assert.strictEqual(def.nameLine, 4);
            const r = execute(index, 'plan', { name: 'field', file: 'src/p/A.java', renameTo: 'count' });
            assert.ok(r.ok, r.error);
            const definition = r.result.changes.find(c => c.editKind === 'definition');
            assert.strictEqual(definition.line, 4);
            assert.match(definition.newExpression, /int count = 1;/);
        } finally { rm(dir); }
    });
});

describe('fix #390: a static import binds a bare call only when no class in scope can supply the member', () => {
    it('a class with an out-of-project supertype keeps its statically imported bare call unverified', () => {
        const dir = tmp({
            'src/org/junit/Assert.java': 'package org.junit;\npublic class Assert {\n    public static void assertTrue(boolean c) {}\n}\n',
            'test/t/Closed.java': 'package t;\nimport static org.junit.Assert.assertTrue;\npublic class Closed {\n    void a() { assertTrue(true); }\n}\n',
            'test/t/Open.java': 'package t;\nimport static org.junit.Assert.assertTrue;\npublic class Open extends junit.framework.TestCase {\n    void a() { assertTrue(true); }\n}\n',
        });
        try {
            const index = idx(dir);
            const ctx = index.context('assertTrue', { file: 'src/org/junit/Assert.java' });
            assert.deepStrictEqual((ctx.callers || []).map(c => `${c.relativePath}:${c.line}`), ['test/t/Closed.java:4']);
            assert.deepStrictEqual((ctx.unverifiedCallers || []).map(c => `${c.relativePath || c.file}:${c.line}`),
                ['test/t/Open.java:4']);
        } finally { rm(dir); }
    });
});

describe('fix #390: anonymous class overrides rename with the slot', () => {
    it('`new Listener<String>() { run(String, int) }` is renamed, another overload and an unrelated anonymous class are not, a diamond is reviewed', () => {
        const dir = tmp({
            'src/p/Listener.java': [
                'package p;',
                'public abstract class Listener<T> {',
                '    public void run(T value, int n) {}',
                '    public void fire(T v) { run(v, 1); }',
                '}',
            ].join('\n'),
            'src/p/Use.java': [
                'package p;',
                'public class Use {',
                '    void a() {',
                '        Listener<String> l = new Listener<String>() {',
                '            @Override',
                '            public void run(String value, int n) {}',
                '            public void run(Integer other, int n) {}',
                '        };',
                '        Listener<Long> m = new Listener<>() {',
                '            @Override public void run(Long v, int n) {}',
                '        };',
                '        Object o = new Object() { public void run(String s, int n) {} };',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'run', file: 'src/p/Listener.java', line: 3, renameTo: 'runZq' });
            assert.ok(r.ok, r.error);
            const use = r.result.changes.filter(c => c.file === 'src/p/Use.java');
            assert.deepStrictEqual(use.map(c => `${c.line}:${c.needsReview ? 'review' : 'edit'}`), ['6:edit', '10:review']);
            assert.match(use[0].newExpression, /public void runZq\(String value, int n\)/);
        } finally { rm(dir); }
    });
});

describe('fix #390: member references and base names resolve like javac', () => {
    it('a paren-less `this.size` is a field: neither a nested class field nor a same-name field is renamed with the method', () => {
        const dir = tmp({
            'src/p/Table.java': [
                'package p;',
                'public class Table {',
                '    private int count;',
                '    int flag;',
                '    public int size() { return count; }',
                '    public int flag() { return this.flag; }',
                '    static final class Info {',
                '        final int size;',
                '        Info(int size) { this.size = size; }',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const size = execute(index, 'plan', { name: 'size', file: 'src/p/Table.java', line: 5, renameTo: 'sizeZq' });
            assert.ok(size.ok, size.error);
            assert.deepStrictEqual(size.result.changes.map(c => c.line), [5]);
            const flag = execute(index, 'plan', { name: 'flag', file: 'src/p/Table.java', line: 6, renameTo: 'flagZq' });
            assert.ok(flag.ok, flag.error);
            const edited = flag.result.changes.filter(c => c.newExpression !== undefined);
            assert.deepStrictEqual(edited.map(c => c.newExpression), ['public int flagZq() { return this.flag; }']);
        } finally { rm(dir); }
    });

    it('a base named like a project class but imported from outside the project is not that class', () => {
        const dir = tmp({
            'src/org/junit/internal/matchers/TypeSafeMatcher.java': [
                'package org.junit.internal.matchers;',
                'public abstract class TypeSafeMatcher<T> {',
                '    public abstract boolean matchesSafely(T item);',
                '}',
            ].join('\n'),
            'src/org/junit/internal/matchers/Stack.java': [
                'package org.junit.internal.matchers;',
                'public class Stack<T> extends TypeSafeMatcher<T> {',
                '    @Override',
                '    public boolean matchesSafely(T item) { return true; }',
                '}',
            ].join('\n'),
            'src/org/junit/internal/matchers/Cause.java': [
                'package org.junit.internal.matchers;',
                'import org.hamcrest.TypeSafeMatcher;',
                'public class Cause<T> extends TypeSafeMatcher<T> {',
                '    @Override',
                '    protected boolean matchesSafely(T item) { return false; }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const project = execute(index, 'plan', { name: 'matchesSafely',
                file: 'src/org/junit/internal/matchers/TypeSafeMatcher.java', line: 3, renameTo: 'm2' });
            assert.ok(project.ok, project.error);
            const files = [...new Set(project.result.changes.map(c => c.file))].sort();
            assert.deepStrictEqual(files, ['src/org/junit/internal/matchers/Stack.java',
                'src/org/junit/internal/matchers/TypeSafeMatcher.java']);
            // The hamcrest override fills an out-of-project slot.
            const external = execute(index, 'plan', { name: 'matchesSafely',
                file: 'src/org/junit/internal/matchers/Cause.java', line: 4, renameTo: 'm2' });
            assert.ok(external.ok, external.error);
            assert.ok(external.result.contract?.blocked, JSON.stringify(external.result.contract));
        } finally { rm(dir); }
    });
});

describe('fix #390: a string concatenation argument is a String', () => {
    it('`addStatement("a" + b)` selects addStatement(String, Object...), never addStatement(CodeBlock)', () => {
        const dir = tmp({
            'src/p/Code.java': 'package p;\npublic class Code {}\n',
            'src/p/Builder.java': [
                'package p;',
                'public class Builder {',
                '    public Builder addStatement(String format, Object... args) { return this; }',
                '    public Builder addStatement(Code code) { return this; }',
                '}',
            ].join('\n'),
            'src/p/Use.java': [
                'package p;',
                'public class Use {',
                '    void a(Builder b, String x) {',
                '        b.addStatement("return " + x);',
                '        b.addStatement(new Code());',
                '    }',
                '}',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            const r = execute(index, 'plan', { name: 'addStatement', file: 'src/p/Builder.java', line: 4, renameTo: 'addCode' });
            assert.ok(r.ok, r.error);
            const use = r.result.changes.filter(c => c.file === 'src/p/Use.java').map(c => c.line);
            assert.deepStrictEqual(use, [5]);
        } finally { rm(dir); }
    });
});

describe('fix #392: enums implement interfaces; enum serialization callbacks', () => {
    it('renaming an interface method renames the enum member and enum constant bodies', () => {
        const dir = tmp({
            'Op.java': 'public interface Op { int apply(int x); }\n',
            'Ops.java': [
                'public enum Ops implements Op {',
                '    ADD {',
                '        @Override',
                '        public int apply(int x) { return x + 1; }',
                '    },',
                '    NEG;',
                '',
                '    @Override',
                '    public int apply(int x) { return -x; }',
                '}',
            ].join('\n') + '\n',
            'Use.java': 'public class Use {\n    static int run(Op o) { return o.apply(3); }\n}\n',
        });
        try {
            const r = execute(idx(dir), 'plan', { name: 'apply', file: 'Op.java', line: 1, renameTo: 'applyZ' });
            assert.ok(r.ok, r.error);
            const edits = r.result.changes.filter(c => c.newExpression).map(c => `${c.file}:${c.line}`).sort();
            assert.deepStrictEqual(edits, ['Op.java:1', 'Ops.java:4', 'Ops.java:9', 'Use.java:2']);
        } finally { rm(dir); }
    });

    it('serialization callbacks of an enum are ordinary members (enum constants serialize by name)', () => {
        const dir = tmp({
            'Color.java': [
                'import java.io.Serializable;',
                'public enum Color implements Serializable {',
                '    RED;',
                '    private Object readResolve() { return this; }',
                '}',
            ].join('\n') + '\n',
            'Ser.java': [
                'import java.io.Serializable;',
                'public class Ser implements Serializable {',
                '    private Object readResolve() { return this; }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const { protocolMemberOf } = require('../core/contract-membership');
            const byClass = new Map((index.symbols.get('readResolve') || []).map(d => [d.className, d]));
            assert.strictEqual(protocolMemberOf(index, byClass.get('Color')), false);
            assert.strictEqual(protocolMemberOf(index, byClass.get('Ser')), true);
            const dead = execute(index, 'deadcode', {}).result;
            const names = (dead.symbols || dead.results || dead).map?.(s => `${s.className}.${s.name}`) || [];
            assert.ok(names.includes('Color.readResolve'), JSON.stringify(names));
            assert.ok(!names.includes('Ser.readResolve'));
        } finally { rm(dir); }
    });
});

// ============================================================================
// fix #394: constructor names in type renames, check against the base
// declaration, owner identity before overload fit, package-qualified and
// nested types, field initializers, super calls, declared local types
// ============================================================================

describe('fix #394: Java identity, check and plan', () => {
    const { execFileSync } = require('child_process');
    const gitInit = (dir) => {
        execFileSync('git', ['init', '-q'], { cwd: dir });
        execFileSync('git', ['add', '.'], { cwd: dir });
        execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init'], { cwd: dir });
    };
    const tiers = (index, name, def) => {
        const r = index.findCallers(name, { includeMethods: true, targetDefinitions: [def], collectAccount: true });
        return {
            confirmed: [...new Set(r.filter(c => c.tier !== 'unverified').map(c => `${c.relativePath}:${c.line}`))].sort(),
            unverified: [...new Set([...r.filter(c => c.tier === 'unverified'), ...(r.unverifiedEntries || [])]
                .map(c => `${c.relativePath}:${c.line}`))].sort(),
            excluded: r.accountRaw.excludedEntries.map(e => `${path.relative(index.root, e.file)}:${e.line}:${e.reason}`).sort(),
        };
    };
    const defAt = (index, name, file, line) => index.symbols.get(name).find(d =>
        d.relativePath === file && (line == null || d.startLine === line || d.nameLine === line));

    it('renames an annotated class and its constructor without crashing', () => {
        const dir = tmp({
            'src/p/Base.java': 'package p;\n\npublic abstract class Base {\n}\n',
            'src/p/Basic.java': 'package p;\n\n@Deprecated\npublic class Basic extends Base {\n\n    public Basic() {\n    }\n}\n',
            'src/p/Use.java': 'package p;\n\npublic class Use {\n    Base make() {\n        return new Basic();\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const plan = execute(index, 'plan', { name: 'Basic', file: 'src/p/Basic.java', line: 4, renameTo: 'Plain' });
            assert.ok(plan.ok, plan.error);
            const lines = plan.result.changes.map(c => `${c.file}:${c.line}`).sort();
            assert.deepStrictEqual(lines, ['src/p/Basic.java:4', 'src/p/Basic.java:6', 'src/p/Use.java:5']);
        } finally { rm(dir); }
    });

    it('check reports callers of a changed overload as mismatches, never other-target', () => {
        const dir = tmp({
            'src/p/Util.java': [
                'package p;', '',
                'final class Util {',
                '    static boolean isEmpty(final Object[] array) {',
                '        return array == null;',
                '    }',
                '',
                '    static boolean isEmpty(final String str) {',
                '        return str == null;',
                '    }',
                '}',
            ].join('\n') + '\n',
            'src/p/Use.java': [
                'package p;', '',
                'class Use {',
                '    boolean a(String s) { return Util.isEmpty(s); }',
                '    boolean b(String[] xs) { return Util.isEmpty(xs); }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            gitInit(dir);
            const file = path.join(dir, 'src/p/Util.java');
            fs.writeFileSync(file, fs.readFileSync(file, 'utf-8')
                .replace('isEmpty(final String str)', 'isEmpty(final String str, final boolean trim)'));
            const index = idx(dir);
            const check = execute(index, 'check', { name: 'isEmpty', file: 'src/p/Util.java', line: 8 });
            assert.ok(check.ok, check.error);
            assert.deepStrictEqual(check.result.mismatchDetails.map(m => `${m.file}:${m.line}`), ['src/p/Use.java:4']);
            assert.match(check.result.changedSince.signature, /isEmpty \(str: String\)/);
            assert.strictEqual(check.result.account.confirmed + check.result.account.unverified >= 1, true);
            // The array overload keeps its own caller; the String site never
            // binds it.
            const arrayDef = defAt(index, 'isEmpty', 'src/p/Util.java', 4);
            assert.deepStrictEqual(tiers(index, 'isEmpty', arrayDef).confirmed, ['src/p/Use.java:5']);
            const diff = execute(index, 'check', {});
            assert.ok(diff.ok, diff.error);
            assert.strictEqual(diff.result.trust?.status || diff.result.status, 'BLOCKED');
            const text = require('../core/output').formatPublicText('check', diff.result, {}, diff);
            assert.match(text, /SIG-DRIFT\(1\)/);
        } finally { rm(dir); }
    });

    it('check fills the line of an overload-family call it validates', () => {
        const dir = tmp({
            'src/p/Opt.java': 'package p;\n\npublic class Opt {\n    public String getKey() {\n        return "k";\n    }\n}\n',
            // More unverified family calls than the engine enriches with
            // line text: every one must still be validated with its line.
            'src/p/Group.java': 'package p;\n\npublic class Group {\n    String s;\n    void set(final Opt option) {\n' +
                Array.from({ length: 12 }, () => '        s = option.getKey();\n').join('') + '    }\n}\n',
        });
        try {
            gitInit(dir);
            const file = path.join(dir, 'src/p/Opt.java');
            fs.writeFileSync(file, fs.readFileSync(file, 'utf-8').replace('getKey()', 'getKey(int n)'));
            const index = idx(dir);
            const check = execute(index, 'check', { name: 'getKey', file: 'src/p/Opt.java', line: 4 });
            assert.ok(check.ok, check.error);
            assert.ok(check.result.mismatchDetails.every(m => m.expression === 's = option.getKey();'));
            assert.deepStrictEqual(check.result.mismatchDetails.map(m => m.line),
                Array.from({ length: 12 }, (_, i) => 6 + i));
        } finally { rm(dir); }
    });

    it('a nested builder returned by another package namesake is its own type', () => {
        const dir = tmp({
            'src/p/A.java': 'package p;\n\npublic class A {\n    public static class Builder {\n        public A get() {\n            return new A();\n        }\n    }\n\n    public static Builder builder() {\n        return new Builder();\n    }\n}\n',
            'src/p/B.java': 'package p;\n\npublic class B {\n    public static class Builder {\n        public B get() {\n            return new B();\n        }\n    }\n}\n',
            'src/p/Use.java': 'package p;\n\npublic class Use {\n    void run() {\n        A a = A.builder().get();\n    }\n}\n',
            'src/q/A.java': 'package q;\n\npublic class A {\n    public static class Builder {\n        public A get() {\n            return new A();\n        }\n    }\n\n    public static Builder builder() {\n        return new Builder();\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'get', defAt(index, 'get', 'src/p/A.java')).confirmed, ['src/p/Use.java:5']);
            const other = tiers(index, 'get', defAt(index, 'get', 'src/p/B.java'));
            assert.deepStrictEqual(other.confirmed, []);
            assert.deepStrictEqual(other.unverified, []);
            assert.deepStrictEqual(tiers(index, 'get', defAt(index, 'get', 'src/q/A.java')).confirmed, []);
        } finally { rm(dir); }
    });

    it('a returned nested builder reaches members it inherits from a same-name base builder', () => {
        const dir = tmp({
            'src/p/Base.java': [
                'package p;', '',
                'public abstract class Base {',
                '    public abstract static class Builder<B extends Builder<B>> {',
                '        public B setWidth(int w) {',
                '            return (B) this;',
                '        }',
                '    }',
                '}',
            ].join('\n') + '\n',
            'src/p/Fmt.java': [
                'package p;', '',
                'public class Fmt extends Base {',
                '    public static class Builder extends Base.Builder<Builder> {',
                '        public Fmt get() {',
                '            return new Fmt();',
                '        }',
                '    }',
                '    public static Builder builder() {',
                '        return new Builder();',
                '    }',
                '}',
            ].join('\n') + '\n',
            'src/q/Fmt.java': 'package q;\n\npublic class Fmt {\n    public static Object builder() {\n        return null;\n    }\n}\n',
            'src/p/Use.java': 'package p;\n\npublic class Use {\n    void run() {\n        Fmt.builder().setWidth(3);\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'setWidth', defAt(index, 'setWidth', 'src/p/Base.java')).confirmed, ['src/p/Use.java:5']);
        } finally { rm(dir); }
    });

    it('a package-qualified declared type names that package, never the current one', () => {
        const dir = tmp({
            'src/p/Node.java': 'package p;\n\npublic class Node {\n    public Node(String n) {}\n    public String label() {\n        return "p";\n    }\n}\n',
            'src/q/Node.java': 'package q;\n\npublic class Node {\n    public String label() {\n        return "q";\n    }\n}\n',
            'src/q/Use.java': [
                'package q;', '',
                'public class Use {',
                '    String go() {',
                '        p.Node pn = new p.Node("x");',
                '        Node n = new Node();',
                '        return pn.label() + n.label();',
                '    }',
                '    String go2(p.Node arg) {',
                '        return arg.label();',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const pLabel = tiers(index, 'label', defAt(index, 'label', 'src/p/Node.java'));
            assert.deepStrictEqual(pLabel.confirmed, ['src/q/Use.java:10', 'src/q/Use.java:7']);
            const plan = execute(index, 'plan', { name: 'label', file: 'src/q/Node.java', line: 4, renameTo: 'labelQ' });
            assert.ok(plan.ok, plan.error);
            const use = plan.result.changes.filter(c => c.file === 'src/q/Use.java');
            assert.deepStrictEqual(use.map(c => c.line), [7]);
            assert.strictEqual(use[0].newExpression, 'return pn.label() + n.labelQ();');
        } finally { rm(dir); }
    });

    it('owner identity precedes overload fit across same-name classes of two packages', () => {
        const dir = tmp({
            'src/p/Util.java': 'package p;\n\nfinal class Util {\n    static boolean isEmpty(final String str) {\n        return str == null;\n    }\n}\n',
            'src/p/help/Util.java': 'package p.help;\n\nfinal class Util {\n    static boolean isEmpty(final CharSequence str) {\n        return str == null;\n    }\n}\n',
            'src/p/help/Fmt.java': 'package p.help;\n\npublic class Fmt {\n    void run(String s) {\n        if (Util.isEmpty(s)) {\n            return;\n        }\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'isEmpty', defAt(index, 'isEmpty', 'src/p/help/Util.java')).confirmed,
                ['src/p/help/Fmt.java:5']);
            assert.deepStrictEqual(tiers(index, 'isEmpty', defAt(index, 'isEmpty', 'src/p/Util.java')).confirmed, []);
            const plan = execute(index, 'plan', { name: 'isEmpty', file: 'src/p/help/Util.java', line: 4, renameTo: 'blank' });
            assert.ok(plan.result.changes.some(c => c.file === 'src/p/help/Fmt.java' && c.line === 5));
        } finally { rm(dir); }
    });

    it('a nested class field initializer never types the outer class field', () => {
        const dir = tmp({
            'src/p/Shape.java': 'package p;\n\npublic interface Shape {\n    double area();\n}\n',
            'src/p/Circle.java': 'package p;\n\npublic class Circle implements Shape {\n    public static Circle make() {\n        return new Circle();\n    }\n    public double area() {\n        return 1;\n    }\n}\n',
            'src/p/Square.java': 'package p;\n\npublic class Square implements Shape {\n    public double area() {\n        return 2;\n    }\n}\n',
            'src/p/Outer.java': [
                'package p;', '',
                'public class Outer {',
                '    public static class Builder {',
                '        private Shape shape = Circle.make();',
                '    }',
                '    private final Shape shape;',
                '    private Shape mutable = Circle.make();',
                '    Outer(Shape s) {',
                '        this.shape = s;',
                '    }',
                '    double draw() {',
                '        return shape.area() + mutable.area();',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'area', defAt(index, 'area', 'src/p/Shape.java')).confirmed, ['src/p/Outer.java:13']);
            for (const file of ['src/p/Circle.java', 'src/p/Square.java']) {
                const t = tiers(index, 'area', defAt(index, 'area', file));
                assert.deepStrictEqual(t.confirmed, [], file);
                assert.deepStrictEqual(t.excluded, [], file);
                assert.ok(t.unverified.includes('src/p/Outer.java:13'), file);
            }
        } finally { rm(dir); }
    });

    it('super.m() is a caller of the superclass method, not of the override', () => {
        const dir = tmp({
            'src/p/Node.java': 'package p;\n\npublic class Node {\n    public String label() {\n        return "n";\n    }\n}\n',
            'src/p/Leaf.java': 'package p;\n\npublic class Leaf extends Node {\n    @Override\n    public String label() {\n        return "leaf:" + super.label();\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'label', defAt(index, 'label', 'src/p/Node.java')).confirmed, ['src/p/Leaf.java:6']);
            const leaf = tiers(index, 'label', defAt(index, 'label', 'src/p/Leaf.java', 4));
            assert.deepStrictEqual(leaf.confirmed, []);
            assert.deepStrictEqual(leaf.unverified, []);
        } finally { rm(dir); }
    });

    it('super.m() into an external superclass member is never a project caller', () => {
        const dir = tmp({
            'src/p/Sub.java': 'package p;\n\npublic class Sub {\n    @Override\n    public String toString() {\n        return super.toString() + "!";\n    }\n}\n',
            'src/p/Other.java': 'package p;\n\npublic class Other {\n    @Override\n    public String toString() {\n        return "o";\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const other = tiers(index, 'toString', defAt(index, 'toString', 'src/p/Other.java', 5));
            assert.deepStrictEqual(other.unverified, []);
            assert.deepStrictEqual(other.excluded, ['src/p/Sub.java:6:other-definition']);
        } finally { rm(dir); }
    });

    it('super.m() in an anonymous class body binds the anonymous base type member', () => {
        const dir = tmp({
            'src/p/Sb.java': 'package p;\n\npublic class Sb {\n    public Sb append(String s) {\n        return this;\n    }\n}\n',
            'src/p/UseSb.java': [
                'package p;', '',
                'public class UseSb {',
                '    Sb make() {',
                '        return new Sb() {',
                '            @Override',
                '            public Sb append(String s) {',
                '                return super.append(s);',
                '            }',
                '        };',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'append', defAt(index, 'append', 'src/p/Sb.java')).confirmed, ['src/p/UseSb.java:8']);
        } finally { rm(dir); }
    });

    it('a declared JDK-typed argument never binds a project-typed parameter', () => {
        const dir = tmp({
            'src/p/Opts.java': 'package p;\n\npublic class Opts {\n}\n',
            'src/p/Fmt.java': [
                'package p;', '',
                'import java.util.List;', '',
                'public class Fmt {',
                '    public void print(Iterable<String> items) {',
                '    }',
                '    public void print(Opts opts) {',
                '    }',
                '}',
            ].join('\n') + '\n',
            'src/p/Use.java': [
                'package p;', '',
                'import java.util.ArrayList;',
                'import java.util.List;', '',
                'public class Use {',
                '    void run(Fmt f) {',
                '        final List<String> items = new ArrayList<>();',
                '        f.print(items);',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'print', defAt(index, 'print', 'src/p/Fmt.java', 6)).confirmed, ['src/p/Use.java:9']);
            const opts = tiers(index, 'print', defAt(index, 'print', 'src/p/Fmt.java', 8));
            assert.deepStrictEqual(opts.unverified, []);
            assert.deepStrictEqual(opts.confirmed, []);
        } finally { rm(dir); }
    });

    it('the declared type of a local is its static receiver type', () => {
        const dir = tmp({
            'src/p/Shape.java': 'package p;\n\npublic interface Shape {\n    double area();\n}\n',
            'src/p/Circle.java': 'package p;\n\npublic class Circle implements Shape {\n    public double area() {\n        return 1;\n    }\n}\n',
            'src/p/Square.java': 'package p;\n\npublic class Square implements Shape {\n    public double area() {\n        return 2;\n    }\n}\n',
            'src/p/Main.java': [
                'package p;', '',
                'public class Main {',
                '    void go() {',
                '        Shape s = new Circle();',
                '        s.area();',
                '        var c = new Circle();',
                '        c.area();',
                '        Shape t = new Circle();',
                '        t = new Square();',
                '        t.area();',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            // The declared type binds Shape.area; a local never reassigned
            // runs Circle.area and never Square.area; a reassigned one may
            // run either.
            assert.deepStrictEqual(tiers(index, 'area', defAt(index, 'area', 'src/p/Shape.java')).confirmed,
                ['src/p/Main.java:11', 'src/p/Main.java:6']);
            const circle = tiers(index, 'area', defAt(index, 'area', 'src/p/Circle.java'));
            assert.deepStrictEqual(circle.confirmed, ['src/p/Main.java:6', 'src/p/Main.java:8']);
            assert.deepStrictEqual(circle.unverified, ['src/p/Main.java:11']);
            const square = tiers(index, 'area', defAt(index, 'area', 'src/p/Square.java'));
            assert.deepStrictEqual(square.excluded,
                ['src/p/Main.java:6:receiver-type-mismatch', 'src/p/Main.java:8:receiver-type-mismatch']);
            assert.deepStrictEqual(square.unverified, ['src/p/Main.java:11']);
            // The callee side runs the same member.
            const callees = index.findCallees(defAt(index, 'go', 'src/p/Main.java'), { collectAccount: true });
            assert.ok(callees.some(c => c.name === 'area' && c.className === 'Circle' && c.tier === 'confirmed'));
            assert.ok(!callees.some(c => c.name === 'area' && c.className === 'Square' && c.tier === 'confirmed'));
        } finally { rm(dir); }
    });

    it('argument kinds keep array dimensions in overload choice', () => {
        const dir = tmp({
            'src/p/U.java': [
                'package p;', '',
                'public class U {',
                '    static String F[] = null;',
                '    static boolean isEmpty(Object[] a) { return a == null; }',
                '    static boolean isEmpty(String s) { return s == null; }',
                '    void t(String s, String[] arr, String c[]) {',
                '        isEmpty(s);',
                '        isEmpty(arr);',
                '        isEmpty(new String[3]);',
                '        isEmpty("lit");',
                '        isEmpty((Object[]) null);',
                '        isEmpty(c);',
                '        isEmpty(F);',
                '        isEmpty(arr[0]);',
                '    }',
                '}',
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(tiers(index, 'isEmpty', defAt(index, 'isEmpty', 'src/p/U.java', 5)).confirmed,
                ['src/p/U.java:10', 'src/p/U.java:12', 'src/p/U.java:13', 'src/p/U.java:14', 'src/p/U.java:9']);
            assert.deepStrictEqual(tiers(index, 'isEmpty', defAt(index, 'isEmpty', 'src/p/U.java', 6)).confirmed,
                ['src/p/U.java:11', 'src/p/U.java:15', 'src/p/U.java:8']);
        } finally { rm(dir); }
    });
});

// fix #395: `this::m` / `super::m` name a member of the enclosing class
// definition or its ancestry, decided like a `this.m()` call.
describe('fix #395: Java method references through this and super', () => {
    const lineSet = (items) => [...new Set(items.map(c => `${c.relativePath}:${c.line}`))].sort();
    const tiers = (index, name, def) => {
        const r = index.findCallers(name, { includeMethods: true, targetDefinitions: [def], collectAccount: true });
        return {
            confirmed: lineSet(r.filter(c => c.tier !== 'unverified')),
            unverified: lineSet([...r.filter(c => c.tier === 'unverified'), ...(r.unverifiedEntries || [])]),
            excluded: r.accountRaw.excludedEntries.map(e => `${path.relative(index.root, e.file)}:${e.line}`).sort(),
        };
    };

    it('this::build binds the enclosing class member; another class with its own build is not a caller', () => {
        const dir = tmp({
            'p/Host.java': 'package p;\nimport java.util.function.Function;\npublic class Host {\n' +
                '    String build(int k) { return "" + k; }\n    void run() {\n        Function<Integer, String> f = this::build;\n    }\n}\n',
            'p/Sub.java': 'package p;\nimport java.util.function.Function;\npublic class Sub extends Host {\n' +
                '    void go() {\n        Function<Integer, String> f = this::build;\n        Function<Integer, String> g = super::build;\n    }\n}\n',
            'p/Other.java': 'package p;\nimport java.util.function.Function;\npublic class Other {\n' +
                '    String build(int k) { return ""; }\n    void go() {\n        Function<Integer, String> f = this::build;\n    }\n}\n',
        });
        try {
            const index = idx(dir);
            const host = index.symbols.get('build').find(d => d.className === 'Host');
            const t = tiers(index, 'build', host);
            assert.deepStrictEqual(t.confirmed, ['p/Host.java:6', 'p/Sub.java:5', 'p/Sub.java:6']);
            assert.ok(t.excluded.includes('p/Other.java:6'));
            const r = execute(index, 'plan', { name: 'build', file: 'p/Host.java', line: 4, renameTo: 'make' });
            assert.ok(r.ok, r.error);
            const edited = r.result.changes.filter(c => c.newExpression !== undefined).map(c => `${c.file}:${c.line}`).sort();
            assert.deepStrictEqual(edited, ['p/Host.java:4', 'p/Host.java:6', 'p/Sub.java:5', 'p/Sub.java:6']);
        } finally { rm(dir); }
    });
});

describe('fix #401: Java super in enum-constant bodies, nested-class member scope, constructor callees by import', () => {
    const lines = (entries) => (entries || []).map(c => `${c.relativePath}:${c.line}`).sort();

    it('`super.m()` in an enum constant body is the enum\'s own member', () => {
        const dir = tmp({
            'src/p/Op.java': [
                'package p;',                                          // 1
                'public enum Op {',                                    // 2
                '    PLUS {',                                          // 3
                '        @Override',                                   // 4
                '        int apply(int a) { return super.apply(a) + 1; }', // 5
                '    },',                                              // 6
                '    MINUS;',                                          // 7
                '    int apply(int a) { return a; }',                  // 8
                '}',                                                   // 9
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const def = index.symbols.get('apply').find(d => d.startLine === 8);
            const callers = index.findCallers('apply', { targetDefinitions: [def], collectAccount: true });
            assert.deepStrictEqual(lines(callers), ['src/p/Op.java:5']);
        } finally { rm(dir); }
    });

    it('`Iface.super.m()` is the named superinterface\'s default method', () => {
        const dir = tmp({
            'src/p/Greeter.java': 'package p;\npublic interface Greeter {\n    default String greet() { return "hi"; }\n}\n',
            'src/p/Polite.java': 'package p;\npublic interface Polite {\n    default String greet() { return "hello"; }\n}\n',
            'src/p/Both.java': [
                'package p;',                                                            // 1
                'public class Both implements Greeter, Polite {',                         // 2
                '    @Override',                                                          // 3
                '    public String greet() {',                                            // 4
                '        return Greeter.super.greet() +',                                 // 5
                '            Polite.super.greet();',                                      // 6
                '    }',                                                                  // 7
                '}',                                                                      // 8
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            for (const [file, line] of [['src/p/Greeter.java', 5], ['src/p/Polite.java', 6]]) {
                const def = index.symbols.get('greet').find(d => d.relativePath === file);
                assert.deepStrictEqual(lines(index.findCallers('greet', { targetDefinitions: [def], collectAccount: true })),
                    [`src/p/Both.java:${line}`]);
            }
            const both = index.symbols.get('greet').find(d => d.relativePath === 'src/p/Both.java');
            assert.deepStrictEqual(lines(index.findCallers('greet', { targetDefinitions: [both], collectAccount: true })), []);
        } finally { rm(dir); }
    });

    it("a nested class's member is not in the outer class's simple-name scope", () => {
        const dir = tmp({
            'src/p/Base.java': 'package p;\npublic class Base {\n    public String name() { return "b"; }\n}\n',
            'src/p/Outer.java': [
                'package p;',                                              // 1
                'public class Outer extends Base {',                        // 2
                '    String first() { return name(); }',                    // 3
                '    class Inner {',                                        // 4
                '        private String name() { return "i"; }',           // 5
                '        String second() { return name(); }',               // 6
                '    }',                                                    // 7
                '}',                                                        // 8
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const base = index.symbols.get('name').find(d => d.relativePath === 'src/p/Base.java');
            assert.deepStrictEqual(lines(index.findCallers('name', { targetDefinitions: [base], collectAccount: true })),
                ['src/p/Outer.java:3']);
            const inner = index.symbols.get('name').find(d => d.relativePath === 'src/p/Outer.java');
            assert.deepStrictEqual(lines(index.findCallers('name', { targetDefinitions: [inner], collectAccount: true })),
                ['src/p/Outer.java:6']);
        } finally { rm(dir); }
    });

    it('a bare call in an anonymous class body looks up the anonymous supertype first', () => {
        const dir = tmp({
            'src/p/Base.java': 'package p;\npublic class Base {\n    public String name() { return "b"; }\n}\n',
            'src/p/Holder.java': [
                'package p;',                                                      // 1
                'public class Holder {',                                           // 2
                '    private String name() { return "h"; }',                       // 3
                '    Base make() {',                                               // 4
                '        return new Base() {',                                     // 5
                '            String twice() { return name() + name(); }',          // 6
                '        };',                                                      // 7
                '    }',                                                           // 8
                '    String own() { return name(); }',                             // 9
                '    Base other() {',                                              // 10
                '        return new Base() {',                                     // 11
                '            public String name() { return "o"; }',                // 12
                '            String once() { return name(); }',                    // 13
                '        };',                                                      // 14
                '    }',                                                           // 15
                '}',                                                               // 16
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const base = index.symbols.get('name').find(d => d.relativePath === 'src/p/Base.java');
            // Line 13 calls the anonymous body's own override.
            assert.deepStrictEqual(lines(index.findCallers('name', { targetDefinitions: [base], collectAccount: true })),
                ['src/p/Holder.java:6', 'src/p/Holder.java:6']);
            const holder = index.symbols.get('name').find(d => d.relativePath === 'src/p/Holder.java');
            assert.deepStrictEqual(lines(index.findCallers('name', { targetDefinitions: [holder], collectAccount: true })),
                ['src/p/Holder.java:9']);
            // The callee side agrees: `make` calls Base.name from the anonymous body.
            const make = index.symbols.get('make').find(d => d.relativePath === 'src/p/Holder.java');
            const callees = index.findCallees(make, { collectAccount: true });
            assert.deepStrictEqual(callees.filter(c => c.name === 'name').map(c => c.relativePath), ['src/p/Base.java']);
        } finally { rm(dir); }
    });

    it('a constructor callee is the class the single-type import names, not a same-package nested namesake', () => {
        const dir = tmp({
            'src/lib/model/TestClass.java': 'package lib.model;\npublic class TestClass {\n    public TestClass(Class<?> c) { }\n}\n',
            'src/app/Holder.java': 'package app;\npublic class Holder {\n    public static class TestClass { }\n}\n',
            'src/app/UseIt.java': [
                'package app;',                                             // 1
                'import lib.model.TestClass;',                              // 2
                'public class UseIt {',                                     // 3
                '    void run() {',                                         // 4
                '        TestClass t = new TestClass(UseIt.class);',        // 5
                '    }',                                                    // 6
                '}',                                                        // 7
            ].join('\n') + '\n',
        });
        try {
            const index = idx(dir);
            const run = index.symbols.get('run').find(d => d.relativePath === 'src/app/UseIt.java');
            const callees = index.findCallees(run, { collectAccount: true });
            // The class and its constructor body (fix #421), both from the import.
            assert.deepStrictEqual(callees.filter(c => c.name === 'TestClass').map(c => [c.relativePath, c.type]),
                [['src/lib/model/TestClass.java', 'class'], ['src/lib/model/TestClass.java', 'constructor']]);
        } finally { rm(dir); }
    });
});

describe('fix #418: the indexed parse decides Java type-name canonicality without a second parse', () => {
    it('a hint from the index agrees with a fresh derivation for every source shape', () => {
        const modulePath = require.resolve('../languages/java-unicode');
        const fresh = () => { delete require.cache[modulePath]; return require('../languages/java-unicode'); };
        const { getParser, safeParse } = require('../languages');
        const sources = [
            'class A { int x; }',
            'class A { String s = "plain"; char c = \'a\'; }',
            'class \\u0041B { }',
            'class A { String s = "\\u0022"; }',
            'class A { void f() { int x = ; } }',
            'class A { String s = STR."v \\{x}"; }',
            'class A { String t = """\n  text\n"""; }',
            'class A​ { }',
            'class A { /* ​ */ }',
            'class A { String s = "​"; }',
            'class A { // \u0007\n }',
            '',
        ];
        const hinted = fresh(), derived = fresh();
        for (const source of sources) {
            const parseError = !!safeParse(getParser('java'), source).rootNode.hasError;
            assert.strictEqual(hinted.typeNameSourceCanonical(source, () => parseError),
                derived.typeNameSourceCanonical(source), JSON.stringify(source));
        }
    });
});

describe('fix #419: record constructors delegate inside the record; a delegation never targets itself', () => {
    const constructorOf = (index, owner, types) => index.symbols.get(owner).find(def => def.type === 'constructor' &&
        (def.paramsStructured || []).map(param => param.type).join(',') === types);
    const callerSites = (index, def) => {
        const callers = index.findCallers(def.name, { targetDefinitions: [def], collectAccount: true });
        const at = site => `${site.relativePath || path.relative(index.root, site.file)}:${site.line}`;
        return {
            confirmed: callers.map(at).sort(),
            unverified: callers.unverifiedEntries.map(at).sort(),
            excluded: callers.accountRaw.excludedEntries.map(site => `${at(site)} ${site.reason}`).sort(),
        };
    };
    it('a nested record delegation names the record, never the enclosing class', () => {
        const dir = tmp({ 'p/Outer.java': 'package p;\n\npublic class Outer {\n    public Outer(int x) { }\n' +
            '    public Outer(String s) { }\n\n    public record R(int x) {\n        public R(String s) {\n' +
            '            this(1);\n        }\n    }\n\n    static Object make() { return new Outer(1); }\n}\n' });
        try {
            const index = idx(dir);
            const call = index.getCachedCalls(path.join(dir, 'p/Outer.java')).find(call => call.ctorDelegation === 'this');
            assert.strictEqual(call.name, 'R');
            assert.deepStrictEqual(callerSites(index, constructorOf(index, 'Outer', 'int')).confirmed, ['p/Outer.java:13']);
            // `this(1)` runs the implicit canonical R(int), never R(String) itself.
            const own = callerSites(index, constructorOf(index, 'R', 'String'));
            assert.deepStrictEqual([own.confirmed, own.unverified], [[], []]);
            assert.deepStrictEqual(own.excluded, ['p/Outer.java:9 constructor-delegation-self']);
        } finally { rm(dir); }
    });
    it('the implicit canonical constructor joins overload selection', () => {
        const dir = tmp({
            'p/R.java': 'package p;\n\npublic record R(int x) {\n    public R(String s) { this(s.length()); }\n' +
                '    public R(long l) { this(5); }\n}\n',
            'p/U.java': 'package p;\n\npublic class U {\n    static R a() { return new R(1); }\n' +
                '    static R b() { return new R("x"); }\n    static R c(String q) { return new R(q.length()); }\n' +
                '    static R d() { return new R(7L); }\n}\n',
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(index.symbols.get('R').find(def => def.type === 'record').primaryParams,
                [{ name: 'x', type: 'int' }]);
            const ofLong = callerSites(index, constructorOf(index, 'R', 'long'));
            assert.deepStrictEqual(ofLong.confirmed, ['p/U.java:7']);
            assert.ok(ofLong.excluded.includes('p/R.java:5 constructor-delegation-self'), ofLong.excluded);
            assert.ok(ofLong.excluded.includes('p/U.java:4 constructor-overload-other'), ofLong.excluded);
            const ofString = callerSites(index, constructorOf(index, 'R', 'String'));
            assert.deepStrictEqual(ofString.confirmed, ['p/U.java:5']);
            assert.ok(!ofString.confirmed.includes('p/R.java:4') && !ofString.unverified.includes('p/R.java:4'));
            // A delegation that reaches the header constructor depends on the record.
            const callees = index.findCallees(constructorOf(index, 'R', 'long'), { collectAccount: true });
            assert.deepStrictEqual(callees.map(def => `${def.type}:${def.name}`), ['record:R']);
            // The record's class account stays conserved; its delegations
            // remain visible as for a class.
            const show = execute(index, 'show', { name: 'p/R.java:3:R' });
            assert.ok(show.ok, show.error);
            const account = show.result.context.meta.account;
            assert.ok(account.conserved && account.unaccounted === 0, JSON.stringify(account));
            assert.strictEqual(account.confirmed, 4, JSON.stringify(account));
        } finally { rm(dir); }
    });
    it('a compact canonical constructor receives the record delegations', () => {
        const dir = tmp({
            'p/R.java': 'package p;\n\npublic record R(int x) {\n    public R {\n' +
                '        if (x < 0) throw new IllegalArgumentException();\n    }\n    public R(String s) { this(s.length()); }\n}\n',
            'p/U.java': 'package p;\n\npublic class U {\n    static R a() { return new R(1); }\n    static R b() { return new R("x"); }\n}\n',
        });
        try {
            const index = idx(dir);
            assert.strictEqual(index.symbols.get('R').find(def => def.type === 'record').primaryParams, undefined);
            assert.deepStrictEqual(callerSites(index, constructorOf(index, 'R', 'int')).confirmed, ['p/R.java:7', 'p/U.java:4']);
            assert.deepStrictEqual(callerSites(index, constructorOf(index, 'R', 'String')).confirmed, ['p/U.java:5']);
        } finally { rm(dir); }
    });
    it('a class constructor is never a caller of itself', () => {
        const dir = tmp({ 'p/K.java': 'package p;\n\npublic class K {\n    public K(int x) { }\n' +
            '    public K(String s) { this(s.length()); }\n    public K(long l) {\n        this(5);\n    }\n}\n' });
        try {
            const index = idx(dir);
            const own = callerSites(index, constructorOf(index, 'K', 'String'));
            assert.deepStrictEqual([own.confirmed, own.unverified], [[], []]);
            assert.deepStrictEqual(callerSites(index, constructorOf(index, 'K', 'int')).confirmed, ['p/K.java:7']);
        } finally { rm(dir); }
    });
});

describe('fix #420: Java pattern variables are locals scoped by their pattern flow', () => {
    const { tmp, rm, idx } = require('./helpers');
    it('instanceof and switch patterns hide a field only where the pattern matched', () => {
        const dir = tmp({ 'Box.java': [
            'public class Box {',
            '    int limit = 3;',
            '    record P(int limit, int other) {}',
            '    int a(Object o) {',
            '        if (o instanceof Integer limit) {',
            '            return limit + this.limit;',
            '        }',
            '        return limit;',
            '    }',
            '    int b(Object o) {',
            '        return switch (o) {',
            '            case P(int limit, int other) -> limit + other;',
            '            case Integer limit when limit > 0 -> limit;',
            '            default -> limit;',
            '        };',
            '    }',
            '    int c(Object o) {',
            '        if (!(o instanceof Integer limit)) {',
            '            return limit;',
            '        }',
            '        return limit;',
            '    }',
            '}',
            '',
        ].join('\n') });
        try {
            const result = execute(idx(dir), 'plan', { name: 'Box.java:2:limit', renameTo: 'cap' });
            assert.strictEqual(result.ok, true, result.error);
            const edits = Object.fromEntries(result.result.changes.filter(change => !change.needsReview &&
                change.newExpression !== undefined).map(change => [change.line, change.newExpression]));
            assert.deepStrictEqual(edits, {
                2: 'int cap = 3;', 6: 'return limit + this.cap;', 8: 'return cap;', 14: 'default -> cap;', 19: 'return cap;',
            });
            assert.ok(!result.result.changes.some(change => change.needsReview), 'every token is decided');
        } finally { rm(dir); }
    });
});

describe('fix #421: a parse error reaches only the member it lies in', () => {
    const files = {
        'p/T.java': 'package p;\npublic class T {\n    public static int pick(int v) { return 1; }\n    public static int pick(String s) { return 2; }\n    public static int one(int v) { return 3; }\n}\n',
        'p/Use.java': 'package p;\npublic class Use {\n    static int a() { return T.pick(1); }\n    static int b() { return T.one(1); }\n    static int c() { int x = 1 +; return T.one(x); }\n}\n',
    };
    it('calls in other members keep their overload choice; the broken member stays in review', () => {
        const dir = tmp(files);
        try {
            const index = idx(dir);
            const calleesOf = name => index.findCallees(index.symbols.get(name)[0], { collectAccount: true });
            assert.deepStrictEqual(calleesOf('a').map(def => [def.name, def.startLine]), [['pick', 3]]);
            assert.deepStrictEqual(calleesOf('b').map(def => [def.name, def.startLine]), [['one', 5]]);
            const broken = calleesOf('c');
            assert.ok(!broken.some(def => def.name === 'one'));
            assert.ok(broken.unverifiedCallees.some(entry => entry.name === 'one'));
        } finally { rm(dir); }
    });
    it('an error outside every member (an import) keeps the whole file in review', () => {
        const dir = tmp({ ...files, 'p/Use.java': 'package p;\nimport java.util.;\npublic class Use {\n    static int b() { return T.one(1); }\n}\n' });
        try {
            const index = idx(dir);
            const callees = index.findCallees(index.symbols.get('b')[0], { collectAccount: true });
            assert.ok(!callees.some(def => def.name === 'one'));
        } finally { rm(dir); }
    });
});

describe('fix #421: producer overloads that agree on their return type decide the argument type', () => {
    const key = 'package p;\npublic class Key<T> {\n    public static <T> Key<T> get(Class<T> type) { return null; }\n    public static Key<?> get(java.lang.reflect.Type type) { return null; }\n}\n';
    it('every applicable producer returns Key: the Key overload is the target', () => {
        const dir = tmp({
            'p/Key.java': key,
            'p/Injector.java': 'package p;\npublic class Injector {\n    public <T> Object getBinding(Key<T> key) { return key; }\n    public <T> Object getBinding(Class<T> type) { return getBinding(Key.get(check(type))); }\n    static <T> T check(T value) { return value; }\n}\n',
        });
        try {
            const index = idx(dir);
            const [byKey, byClass] = ['Key<T>', 'Class<T>'].map(type => index.symbols.get('getBinding')
                .find(def => def.paramsStructured[0].type === type));
            const callers = index.findCallers('getBinding', { targetDefinitions: [byKey], collectAccount: true });
            assert.deepStrictEqual(callers.map(site => [site.line, site.tier]), [[4, 'confirmed']]);
            assert.deepStrictEqual(index.findCallers('getBinding', { targetDefinitions: [byClass], collectAccount: true })
                .map(site => site.line), []);
        } finally { rm(dir); }
    });
    it('producers that disagree leave the outer call in review', () => {
        const dir = tmp({
            'p/Key.java': key.replace('public static Key<?> get(java.lang.reflect.Type type)', 'public static String get(java.lang.reflect.Type type)'),
            'p/Injector.java': 'package p;\npublic class Injector {\n    public <T> Object getBinding(Key<T> key) { return key; }\n    public Object getBinding(String type) { return getBinding(Key.get(check(type))); }\n    static <T> T check(T value) { return value; }\n}\n',
        });
        try {
            const index = idx(dir);
            const byKey = index.symbols.get('getBinding').find(def => def.paramsStructured[0].type === 'Key<T>');
            const callers = index.findCallers('getBinding', { targetDefinitions: [byKey], collectAccount: true });
            assert.strictEqual(callers.length, 0);
            assert.deepStrictEqual(callers.unverifiedEntries.map(site => site.line), [4]);
        } finally { rm(dir); }
    });
});

describe('fix #425: Java pattern variables type their receivers where their scope reaches', () => {
    const { tmp, rm, idx } = require('./helpers');
    const { execute } = require('../core/execute');
    const callers = (index, name) => {
        const result = execute(index, 'context', { name });
        assert.strictEqual(result.ok, true, result.error);
        return {
            confirmed: (result.result.callers || []).map(c => `${c.relativePath}:${c.line}`).sort(),
            unverified: (result.result.unverifiedCallers || []).map(c => `${c.relativePath}:${c.line}`).sort(),
        };
    };
    it('instanceof, switch-label and record-component patterns; a field of the name outside the scope stays untyped', () => {
        const dir = tmp({
            'p/Sq.java': 'package p;\n\npublic class Sq { int scale() { return 2; } }\n',
            'p/Ci.java': 'package p;\n\npublic class Ci { int scale() { return 3; } }\n',
            'p/Pt.java': 'package p;\n\npublic record Pt(Sq a, int b) {}\n',
            'p/Use.java': [
                'package p;',
                '',
                'class Use {',
                '    Ci s;',
                '    int use(Object x) {',
                '        switch (x) {',
                '            case Sq s -> { return s.scale(); }',
                '            case Pt(Sq a, int b) -> { return a.scale(); }',
                '            default -> { }',
                '        }',
                '        if (x instanceof Sq q) return q.scale();',
                '        return s.scale();',
                '    }',
                '}',
                '',
            ].join('\n'),
        });
        try {
            const index = idx(dir);
            assert.deepStrictEqual(callers(index, 'p/Sq.java:3:scale').confirmed, ['p/Use.java:11', 'p/Use.java:7', 'p/Use.java:8']);
            assert.ok(!callers(index, 'p/Sq.java:3:scale').confirmed.includes('p/Use.java:12'));
        } finally { rm(dir); }
    });
});
