'use strict';

// Valid source fixtures for the receiver-to-target contract. Language-specific
// unknown shapes intentionally differ: nominal languages require a declared
// interface/bound, while structural languages permit an untyped receiver.
const RECEIVER_FIXTURES = {
    python: {
        method: 'as_posix', owner: 'Local', file: 'local.py',
        files: {
            'local.py': 'class Local:\n    def as_posix(self):\n        return "local"\n    def own(self):\n        return self.as_posix()\n',
            'app.py': 'def render(value):\n    return value.as_posix()\n',
            'imported.py': 'from local import Local\ndef imported(value):\n    return value.as_posix()\n',
            'typed.py': 'from local import Local\ndef typed(value: Local):\n    return value.as_posix()\ndef constructed():\n    value = Local()\n    return value.as_posix()\n',
        },
        other: { 'other.py': 'class Other:\n    def as_posix(self):\n        return "other"\n' },
        unknownFiles: ['app.py', 'imported.py'], singleOwner: true,
    },
    javascript: {
        method: 'as_posix', owner: 'Local', file: 'local.js',
        files: {
            'package.json': '{"type":"module"}',
            'local.js': 'export class Local {\n  as_posix() { return "local"; }\n  own() { return this.as_posix(); }\n}\n',
            'app.js': 'export function render(value) {\n  return value.as_posix();\n}\n',
            'imported.js': 'import { Local } from "./local.js";\nexport function imported(value) {\n  return value.as_posix();\n}\n',
            'typed.js': 'import { Local } from "./local.js";\nexport function constructed() {\n  const value = new Local();\n  return value.as_posix();\n}\n',
        },
        other: { 'other.js': 'export class Other {\n  as_posix() { return "other"; }\n}\n' },
        unknownFiles: ['app.js', 'imported.js'], singleOwner: true,
    },
    typescript: {
        method: 'as_posix', owner: 'Local', file: 'local.ts',
        files: {
            'package.json': '{"type":"module"}',
            'local.ts': 'export class Local {\n  as_posix() { return "local"; }\n  own() { return this.as_posix(); }\n}\n',
            'app.ts': 'export function render(value: any) {\n  return value.as_posix();\n}\n',
            'imported.ts': 'import { Local } from "./local";\nexport function imported(value: any) {\n  return value.as_posix();\n}\n',
            'typed.ts': 'import { Local } from "./local";\nexport function typed(value: Local) {\n  return value.as_posix();\n}\nexport function constructed() {\n  const value = new Local();\n  return value.as_posix();\n}\n',
        },
        other: { 'other.ts': 'export class Other {\n  as_posix() { return "other"; }\n}\n' },
        unknownFiles: ['app.ts', 'imported.ts'], singleOwner: true,
    },
    go: {
        method: 'AsPosix', owner: 'Local', file: 'local.go',
        files: {
            'go.mod': 'module example.test/evidence\n\ngo 1.23\n',
            '.gitignore': 'external/\n',
            'external/contract.go': 'package external\ntype Posix interface { AsPosix() string }\n',
            'local.go': 'package evidence\ntype Local struct{}\nfunc (v *Local) AsPosix() string { return "local" }\nfunc (v *Local) Own() string { return v.AsPosix() }\n',
            'app.go': 'package evidence\nimport "example.test/evidence/external"\nfunc render(value external.Posix) string {\n return value.AsPosix()\n}\n',
            'typed.go': 'package evidence\nfunc typed(value *Local) string { return value.AsPosix() }\nfunc constructed() string {\n value := &Local{}\n return value.AsPosix()\n}\n',
        },
        other: { 'other.go': 'package evidence\ntype Other struct{}\nfunc (v *Other) AsPosix() string { return "other" }\n' },
        unknownFiles: ['app.go'],
    },
    rust: {
        method: 'as_posix', owner: 'Local', file: 'src/lib.rs', traitTarget: true,
        files: {
            'Cargo.toml': '[package]\nname="evidence_fixture"\nversion="0.1.0"\nedition="2021"\n[dependencies]\nexternal={path="external"}\n',
            '.gitignore': 'external/\ntarget/\n',
            'external/Cargo.toml': '[package]\nname="external"\nversion="0.1.0"\nedition="2021"\n',
            'external/src/lib.rs': 'pub trait Posix { fn as_posix(&self) -> String; }\n',
            'src/lib.rs': 'use external::Posix;\npub struct Local {}\nimpl external::Posix for Local {\n fn as_posix(&self) -> String { "local".into() }\n}\nimpl Local {\n pub fn own(&self) -> String { self.as_posix() }\n}\npub fn render(value: &dyn external::Posix) -> String { value.as_posix() }\npub fn typed(value: &Local) -> String { value.as_posix() }\npub fn constructed() -> String {\n let value = Local {};\n value.as_posix()\n}\n',
        },
        unknownFiles: ['src/lib.rs'], unknownFunctions: ['render'],
    },
    java: {
        method: 'toUri', owner: 'Local', file: 'Local.java',
        files: {
            '.gitignore': 'external/\n',
            'external/Posix.java': 'package external;\npublic interface Posix { java.net.URI toUri(); }\n',
            'Local.java': 'import external.Posix;\nclass Local implements Posix {\n @Override public java.net.URI toUri() { return java.net.URI.create("local:test"); }\n java.net.URI own() { return this.toUri(); }\n}\n',
            'App.java': 'class App {\n java.net.URI render(external.Posix value) { return value.toUri(); }\n java.net.URI typed(Local value) { return value.toUri(); }\n java.net.URI constructed() {\n  Local value = new Local();\n  return value.toUri();\n }\n}\n',
        },
        unknownFiles: ['App.java'], unknownFunctions: ['render'],
    },
    csharp: {
        method: 'AsPosix', owner: 'Local', file: 'App.cs',
        files: {
            'App.cs': 'public class Local {\n public string AsPosix() { return "local"; }\n public string Own() { return this.AsPosix(); }\n}\npublic class App {\n public string render(dynamic value) { return value.AsPosix(); }\n public string typed(Local value) { return value.AsPosix(); }\n public string constructed() {\n  var value = new Local();\n  return value.AsPosix();\n }\n}\n',
        },
        unknownFiles: ['App.cs'], unknownFunctions: ['render'],
    },
    cpp: {
        method: 'as_posix', owner: 'Local', file: 'app.cpp',
        files: {
            'app.cpp': 'struct Local {\n int as_posix() { return 1; }\n int own() { return this->as_posix(); }\n};\ntemplate<class T> int render(T &value) { return value.as_posix(); }\nint typed(Local &value) { return value.as_posix(); }\nint constructed() {\n Local value;\n return value.as_posix();\n}\n',
        },
        unknownFiles: ['app.cpp'], unknownFunctions: ['render'],
    },
};

// Reusable source generators for the positive / confusable-negative /
// unresolved triple. JS uses construction where annotations do not exist;
// nominal languages use a declared interface, bound, or template parameter.
const RECEIVER_SHAPES = {
    javascript: {
        classWithMethod: name => `class ${name} { as_posix() { return 1; } }`,
        untypedOrExternalReceiverCall: () => 'function unresolved(value) { return value.as_posix(); }',
        annotatedReceiverCall: () => 'function declared() { const value = new Local(); return value.as_posix(); }',
        constructorReceiverCall: () => 'function constructed() { const value = new Local(); return value.as_posix(); }',
        unrelatedTypedReceiverCall: () => 'function different() { const value = new Other(); return value.as_posix(); }',
    },
    typescript: {
        classWithMethod: name => `class ${name} { as_posix() { return 1; } }`,
        untypedOrExternalReceiverCall: () => 'function unresolved(value: any) { return value.as_posix(); }',
        annotatedReceiverCall: () => 'function declared(value: Local) { return value.as_posix(); }',
        constructorReceiverCall: () => 'function constructed() { const value = new Local(); return value.as_posix(); }',
        unrelatedTypedReceiverCall: () => 'function different(value: Other) { return value.as_posix(); }',
    },
    python: {
        classWithMethod: name => `class ${name}:\n    def as_posix(self): return 1`,
        untypedOrExternalReceiverCall: () => 'def unresolved(value): return value.as_posix()',
        annotatedReceiverCall: () => 'def declared(value: Local): return value.as_posix()',
        constructorReceiverCall: () => 'def constructed():\n    value = Local()\n    return value.as_posix()',
        unrelatedTypedReceiverCall: () => 'def different(value: Other): return value.as_posix()',
    },
    go: {
        prelude: 'package fixture',
        classWithMethod: name => `type ${name} struct{}\nfunc (v *${name}) as_posix() int { return 1 }`,
        untypedOrExternalReceiverCall: () => 'type Contract interface { as_posix() int }\nfunc unresolved(value Contract) int { return value.as_posix() }',
        annotatedReceiverCall: () => 'func declared(value *Local) int { return value.as_posix() }',
        constructorReceiverCall: () => 'func constructed() int { value := &Local{}; return value.as_posix() }',
        unrelatedTypedReceiverCall: () => 'func different(value *Other) int { return value.as_posix() }',
    },
    rust: {
        classWithMethod: name => `struct ${name} {}\nimpl ${name} { fn as_posix(&self) -> i32 { 1 } }`,
        untypedOrExternalReceiverCall: () => 'trait Contract { fn as_posix(&self) -> i32; }\nfn unresolved<T: Contract>(value: &T) -> i32 { value.as_posix() }',
        annotatedReceiverCall: () => 'fn declared(value: &Local) -> i32 { value.as_posix() }',
        constructorReceiverCall: () => 'fn constructed() -> i32 { let value = Local {}; value.as_posix() }',
        unrelatedTypedReceiverCall: () => 'fn different(value: &Other) -> i32 { value.as_posix() }',
    },
    java: {
        classWithMethod: name => `class ${name} { int as_posix() { return 1; } }`,
        untypedOrExternalReceiverCall: () => 'interface Contract { int as_posix(); }\nclass Unknown { int unresolved(Contract value) { return value.as_posix(); } }',
        annotatedReceiverCall: () => 'class Declared { int declared(Local value) { return value.as_posix(); } }',
        constructorReceiverCall: () => 'class Constructed { int constructed() { Local value = new Local(); return value.as_posix(); } }',
        unrelatedTypedReceiverCall: () => 'class Different { int different(Other value) { return value.as_posix(); } }',
    },
    csharp: {
        classWithMethod: name => `class ${name} { public int as_posix() { return 1; } }`,
        untypedOrExternalReceiverCall: () => 'class Unknown { int unresolved(dynamic value) { return value.as_posix(); } }',
        annotatedReceiverCall: () => 'class Declared { int declared(Local value) { return value.as_posix(); } }',
        constructorReceiverCall: () => 'class Constructed { int constructed() { var value = new Local(); return value.as_posix(); } }',
        unrelatedTypedReceiverCall: () => 'class Different { int different(Other value) { return value.as_posix(); } }',
    },
    cpp: {
        classWithMethod: name => `struct ${name} { int as_posix() { return 1; } };`,
        untypedOrExternalReceiverCall: () => 'template<class T> int unresolved(T &value) { return value.as_posix(); }',
        annotatedReceiverCall: () => 'int declared(Local &value) { return value.as_posix(); }',
        constructorReceiverCall: () => 'int constructed() { Local value; return value.as_posix(); }',
        unrelatedTypedReceiverCall: () => 'int different(Other &value) { return value.as_posix(); }',
    },
};

module.exports = { RECEIVER_FIXTURES, RECEIVER_SHAPES };
