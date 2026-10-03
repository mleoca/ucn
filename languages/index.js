/**
 * languages/index.js - Language registry and detection
 *
 * Manages language parsers and provides extension-based detection.
 */

const path = require('path');
const { UcnError } = require('../core/errors');
const { createLanguageAdapter } = require('./adapter');

// Lazy-loaded tree-sitter
let TreeSitter = null;

// Cached parser instances
const parsers = {};
const adapters = {};

// Shared trait presets for languages with the same type-system characteristics
/**
 * Build a `languageProtocolMember` predicate from rules (fix #360, #363).
 * A rule names members the language runtime or compiler invokes BY NAME:
 *   { pattern | names, member?: true, owners?: [bare type names] }
 * `member` restricts it to class members; `owners` restricts it to classes
 * whose heritage reaches one of those out-of-project types (Enum hooks on
 * Enum subclasses only). The predicate takes (name, ctx) with ctx
 * { isMember, derivesFrom(ownerNames) }; without derivesFrom an owner-gated
 * rule never matches.
 */
function protocolMembers(rules) {
    return (name, ctx = {}) => {
        let possible = false;
        for (const rule of rules) {
            const named = rule.pattern ? rule.pattern.test(name) : rule.names.includes(name);
            if (!named) continue;
            if (rule.member && ctx.isMember === false) continue;
            // Owner kinds the runtime exempts from the protocol (fix #392:
            // Java enum constants serialize by name and ignore the callbacks).
            if (rule.exceptOwnerKinds && typeof ctx.ownerKinds === 'function' &&
                ctx.ownerKinds().some(kind => rule.exceptOwnerKinds.includes(kind))) continue;
            if (!rule.owners) return 'definite';
            if (typeof ctx.derivesFrom === 'function' && ctx.derivesFrom(rule.owners)) return 'definite';
            // An owner whose heritage leaves the project through another
            // out-of-project supertype may still derive from the contract
            // (fix #389: `extends IOException` is Serializable through the
            // JDK): possible, when the member has the protocol's shape.
            const via = rule.possibleViaExternal;
            if (via && typeof ctx.externalSupertypes === 'function' &&
                ctx.externalSupertypes().some(type => !via.except.includes(type)) &&
                (!via.shape || via.shape(name, ctx))) possible = true;
        }
        return possible ? 'possible' : false;
    };
}

/**
 * Build a `languageProtocolType` predicate from rules (fix #380): types the
 * compiler references by their full name when a language feature appears
 * (C# `init` lowers to `System.Runtime.CompilerServices.IsExternalInit`).
 * A project declaration of such a type in that namespace is used exactly
 * when the project uses the feature. `ctx.hasFeature(name)` answers from the
 * parser's per-file `languageFeatures`.
 */
function protocolTypes(rules) {
    return (name, ctx = {}) => rules.some(rule => rule.names.includes(name) &&
        (ctx.namespace || '') === rule.namespace &&
        typeof ctx.hasFeature === 'function' && rule.features.some(feature => ctx.hasFeature(feature)));
}

/**
 * The shape the Java serialization runtime looks for (fix #389): instance
 * methods `writeObject(ObjectOutputStream)` / `readObject(ObjectInputStream)`,
 * `readResolve()` / `writeReplace()` / `readObjectNoData()` without
 * parameters, static fields `serialVersionUID` and `serialPersistentFields`.
 */
function javaSerializationShape(name, ctx) {
    const modifiers = ctx.modifiers || [];
    if (name === 'serialVersionUID' || name === 'serialPersistentFields') {
        return ctx.isField === true && modifiers.includes('static');
    }
    if (ctx.isField || modifiers.includes('static')) return false;
    const params = ctx.paramTypes;
    if (!Array.isArray(params)) return true;
    if (name === 'writeObject' || name === 'readObject') {
        const stream = name === 'writeObject' ? 'ObjectOutputStream' : 'ObjectInputStream';
        return params.length === 1 && (!params[0] || params[0] === stream);
    }
    return params.length === 0;
}

// java.lang types that do not implement java.io.Serializable (JDK API):
// an unqualified supertype spelled like one of these, and not imported
// from elsewhere, carries no serialization contract.
const JAVA_LANG_NOT_SERIALIZABLE = ['Object', 'Runnable', 'AutoCloseable', 'Comparable', 'Iterable',
    'CharSequence', 'Cloneable', 'Appendable', 'Readable', 'Thread', 'ThreadGroup', 'ClassLoader',
    'ThreadLocal', 'InheritableThreadLocal', 'ClassValue', 'SecurityManager', 'Process', 'Record'];

const STRUCTURAL_TRAITS = {
    typeSystem: 'structural',
    // A type's identity is its declaring module (a source file or inline
    // module), not the directory (fix #384): two same-name types in two
    // modules of one directory are distinct (JS/TS, Python modules, Rust
    // modules). Go packages, Java packages, C# namespaces and C/C++
    // namespaces keep their own identity rules.
    moduleTypeIdentity: true,
    // Leading path segments that always name the language's own standard
    // library (fix #371): a type written under one of them (`std::fs::File`)
    // denotes an external type, never a same-name project type.
    standardPathRoots: [],
    // How an unqualified type name reaches a file beyond its own
    // declarations and single-name imports (fix #372): 'package-on-demand'
    // (Java: same package, then on-demand imports plus the implicit ones),
    // 'namespace-usings' (C#: enclosing namespaces, then using directives,
    // global usings and project-file <Using> items), or null.
    typeNameScoping: null,
    // Types every file imports on demand without writing it (Java java.lang,
    // JLS 7.3): { module, names }. A project type of the same name in another
    // package is visible only through an import.
    implicitTypeImport: null,
    methodCallInclusion: 'explicit',
    packageScope: 'file',
    hasReceiverPackageCalls: false,
    exportVisibility: 'keyword',
    hasDynamicImports: true,
    testDirs: [],
    // Whether the language supports default parameter values in function
    // signatures (JS/TS/Python: yes). Drives plan --add-param --default:
    // without them, every call site needs the new argument and the rendered
    // signature must not use `= value` syntax (Go/Java/Rust).
    hasDefaultParams: true,
    allMethodsVirtual: false,
    hasArityOverloads: false,
    // Whether `from pkg import name` can bind a SUBMODULE file as a plain
    // name (fix #224). Python sets true: graph-build resolves the composed
    // dotted specifier and records it in moduleResolved, making the receiver
    // a module receiver at query time. JS from-imports bind values only.
    submoduleImports: false,
    // Class members are public unless marked otherwise (#name, _name,
    // `private`). An exported class therefore exposes its non-private methods
    // as public API — deadcode treats them as exported (fix #211). Languages
    // with explicit member visibility (Rust `pub`, Java `public` — already
    // captured as modifiers) or capitalization rules (Go) set false: there
    // the member's own marker decides.
    implicitlyPublicMembers: true,
    // Member names the language itself keeps private to the declaring class
    // (JS/TS `#x`; Python mangles `__x`): such a member never implements or
    // overrides a supertype's member. A leading `_` is a naming convention
    // only: Node stream hooks (`_transform`, `_flush`) and Python
    // `TextWrapper._handle_long_word` are members an outside base calls
    // (fix #397). Languages without the trait keep the conservative
    // underscore rule.
    privateMemberName: name => String(name).startsWith('#'),
    // A bare (receiver-less) name can never denote a METHOD here — JS/Python
    // methods are reached through their receiver; only a rebound alias could,
    // which is separate name-level evidence. Java sets true: `execute()`
    // inside a class means this.execute(), and static imports bind foreign
    // class methods to bare names (fix #220).
    bareCallReachesMethods: false,
    // A method-shaped call CAN reach a standalone function here: attribute
    // assignment rebinds functions onto objects (obj.print = print), so the
    // #218b gate routes such calls visible instead of excluding (fix #220).
    methodCallReachesFunctions: true,
    // Generic-parameter receivers can reach inherited/structural satisfiers
    // (see the nominal preset); only Rust closes dispatch over bound traits.
    genericBoundDispatchClosed: false,
    // Whether `Type(...)` constructs a class without a `new` token. Python
    // classes are ordinary callable objects; JS/TS classes require `new`.
    classesCallableWithoutNew: false,
    // Whether a decorator REPLACES the callable it decorates with its own
    // return value (Python/JS decorators, fix #364). What a decorated async
    // function's call returns is then decided by the decorator, not by the
    // `async` keyword. Attribute/annotation languages (C#, Java, Rust) only
    // attach metadata and set false.
    decoratorsWrapCallables: true,
    callableDecorators: null,
    // Runtime-provided global functions that return an awaitable (JS
    // `fetch`), audited by audit-async as bare calls (fix #364).
    knownAsyncGlobals: null,
    // Whether a plain assignment `x = v` inside a function declares a local
    // (Python, unless `global`/`nonlocal` names it). Elsewhere an undeclared
    // name is an outer variable or an implicit-this field, so an awaitable
    // stored there flows on (audit-async, fix #380).
    assignmentDeclaresLocal: false,
    // Whether a type's generic arity is part of its identity (C#: `Outcome`,
    // `Outcome<T>` and `Outcome<T1, T2>` are distinct types that coexist).
    // Java erases generics and TS/Rust/C++ cannot declare two same-name types
    // differing only in arity, so a written arity decides nothing there.
    // Drives arity-aware constructor, type-qualified and typed-receiver
    // resolution (fix #380).
    genericArityIsIdentity: false,
    // Whether a generic method's type arguments are inferred from its call
    // ARGUMENTS only (C#: a type parameter no parameter type mentions makes
    // the method inapplicable without explicit type arguments). Java infers
    // from the target type too; C++ templates are not overload-applicability
    // evidence here (fix #393).
    typeArgumentsFromArgumentsOnly: false,
    // Test functions the toolchain binds to a declared identifier by NAME
    // (fix #383): Go examples (GO_EXAMPLE_NAMES). Rust doc tests and
    // Java/C#/Python doc references are comment text, listed by plan as
    // text dependencies; no other language checks a test function's name
    // against a declaration.
    nameBoundTestFunctions: null,
    // Whether a top-level type is declared in a source file named after it
    // (fix #386): javac requires `public class Widget` in Widget.java, so a
    // type rename renames that file too.
    typeNamedSourceFile: false,
    // Documentation references the compiler resolves (fix #390): C# XML doc
    // `cref` attributes (CS1574 when documentation is generated). A member
    // rename edits the crefs that name the renamed member.
    docCrefReferences: false,
    // Whether a method's simple name in value position is a method group
    // (fix #395, C#: `new(Build, 4)`, `x += OnChanged`, `.Select(Build)`,
    // `Func<int> f = Build`): plan renames it by the language's simple-name
    // lookup. Java spells method values apart (`Type::m`).
    methodGroupReferences: false,
    // Whether a class may declare a field and a method of one name, so a
    // paren-less member access (`this.size`) names the field and a method
    // value is spelled apart (`obj::m`, `Type::m`) (fix #390: Java, Rust).
    fieldsAndMethodsSeparate: false,
    // Whether call sites bind arguments by parameter NAME (Python keyword
    // arguments). Drives verify/check keyword binding validation (fix #281):
    // keyword names checked against the signature, keyword-only/positional-only
    // markers honored, required coverage enforced. Languages without named
    // arguments must stay false — a JS call with fewer args than params is
    // legal, so required-coverage checks would false-flag.
    keywordArguments: false,
    // Members whose NAME is fixed by the language itself (fix #360): Python
    // data-model dunders (`__eq__`, `__iter__`) implement a protocol the
    // interpreter dispatches by name. Renaming one never renames a project
    // symbol; it withdraws the protocol. null = no such name class.
    languageProtocolMember: null,
    // Types the compiler itself references when a language feature is used
    // (fix #380; C# polyfills such as IsExternalInit). null = none.
    languageProtocolType: null,
    // Runtime reflection vocabulary (fix #307, #363): calls that select a
    // member by a string name. `functions` match the callee text (name and
    // receiver by argument position), `members` match a method name on a
    // receiver object; `computedMembers` treats `obj[expr]` as member access;
    // `membersOnly` when the API can only reach class members; `formatCalls`
    // are string-formatting calls whose first argument is a format template;
    // `selfTypeCalls`/`typeLiteralNodes` spell "the runtime class of this" and
    // class literals. `hintPattern` locates vocabulary spellings whose
    // enclosing call nodes are inspected (the AST decides); `namespaceLookups` are module-namespace lookups by
    // name (eval, globals()[k]). `family` groups languages sharing one
    // runtime. null = no runtime reflection.
    reflectionApi: null,
    // Members every class inherits from the implicit root supertype, keyed by
    // name with their parameter count (Java Object.toString/equals/...,
    // C# object.ToString/Equals/...). A same-name same-arity member overrides
    // the root contract even without an override marker (fix #360). null =
    // no universal supertype surface.
    universalSupertypeMembers: null,
    // Whether macro definitions hold token-level TEMPLATES whose identifiers
    // bind at each expansion site (Rust macro_rules!). Plan renames model
    // their transcriber tokens explicitly (fix #360).
    macroTemplateBodies: false,
    // Whether a translation unit sees every declaration reachable through its
    // transitive #include closure (C/C++ textual inclusion, fix #361). Free
    // function visibility then follows the include closure, not one import
    // hop, and several external-linkage definitions of one name are resolved
    // by the linker, which source evidence alone cannot choose between.
    textualIncludes: false,
};
const NOMINAL_TRAITS = {
    typeSystem: 'nominal',
    moduleTypeIdentity: false,
    standardPathRoots: [],
    typeNameScoping: null,
    implicitTypeImport: null,
    methodCallInclusion: 'auto',
    packageScope: 'file',
    hasReceiverPackageCalls: false,
    exportVisibility: 'keyword',
    hasDynamicImports: true,
    testDirs: [],
    // Call sites don't bind arguments by parameter name here (see
    // STRUCTURAL_TRAITS.keywordArguments — Python overrides true). C# HAS
    // named arguments but its parser doesn't record them yet; the trait stays
    // false there until that family is measured (fix #281, classified-deferred).
    keywordArguments: false,
    // See STRUCTURAL_TRAITS for the three contract-membership traits (fix #360).
    languageProtocolMember: null,
    languageProtocolType: null,
    reflectionApi: null,
    universalSupertypeMembers: null,
    macroTemplateBodies: false,
    textualIncludes: false,
    // Go/Java/Rust have no default parameter values — see STRUCTURAL_TRAITS.
    hasDefaultParams: false,
    // Whether ANY instance method call can dynamically dispatch to a subtype
    // override (Java: all instance methods are virtual). Go struct method
    // sets and Rust inherent methods bind statically — only interface/trait
    // receivers dispatch there, which is detected per-type, not per-language.
    allMethodsVirtual: false,
    // Whether one class can define several same-name methods differing only
    // in parameters (Java overloading). Drives the overload discipline in
    // the caller contract: a pinned overload is only confirmed when the call
    // site provably binds it.
    hasArityOverloads: false,
    // What a TYPE-QUALIFIED method call looks like, so a receiver that merely
    // shares the target type's NAME isn't mistaken for the type itself:
    //   'static'      — Type.method() static form, any arity (Java).
    //   'method-expr' — Go method expressions T.M(recv, ...): the receiver
    //                   instance is the FIRST argument, so a zero-arg call on
    //                   a type-named receiver must be a variable (grpc-go
    //                   names builder structs and Builder locals both `bb`).
    //   'path'        — Rust Type::method (isPathCall); a DOT-call receiver
    //                   matching a type name is a variable, never the type.
    typeQualifiedCallStyle: 'static',
    implicitlyPublicMembers: false,
    // The implicit root supertype every class extends without declaring it
    // (Java `Object`). A receiver declared with this type can hold ANY project
    // instance, so it is dispatch-capable toward every override — but the
    // edge is invisible to declared-ancestry walks (fix #212). Routing only,
    // never exclusion evidence. Go/Rust: null — Go's interface{}/any cannot
    // receive method calls without an assertion, Rust has no universal
    // supertype. Structural languages: null — any/object/unknown receivers
    // are already refused as exclusion evidence by the trust gate.
    universalSupertype: null,
    // A bare (receiver-less) call or reference can never denote a METHOD:
    // Go method values/expressions require an explicit receiver or type
    // qualifier (m.Helper(), T.Helper); Rust requires self./Type:: and `use`
    // cannot import associated functions. A bare MarkFlagDirname(...) inside
    // Command.MarkFlagDirname denotes the package FUNCTION (fix #220,
    // cobra/grpc-go-measured). Java overrides true (implicit this-calls,
    // static imports).
    bareCallReachesMethods: false,
    // Whether a method-shaped call (x.f()) can reach a standalone FUNCTION:
    // Go func-typed fields are name-callable (s.Run() may invoke a stored
    // function), so exclusion needs !bindingId there; Rust requires (s.f)()
    // parens and Java requires .apply() — a dot-call provably never binds a
    // free function (fix #220, ripgrep-measured).
    methodCallReachesFunctions: false,
    // Whether a call on a receiver typed by a GENERIC PARAMETER can reach a
    // concrete method only through the traits in that parameter's bound
    // closure (fix #368). Rust: no implementation inheritance, so
    // `c.split_at()` with `C: Consumer` never reaches a Producer impl member
    // or an inherent method. Java/C#/Go/TS: a subclass or structural
    // satisfier can inherit the target through the bound, so false.
    genericBoundDispatchClosed: false,
    // Whether a paren-less member access (x.name) can denote a METHOD. Rust
    // sets true for the inverse — `x.name` is ALWAYS a field there (method
    // values are path-only: Type::method), so a member-access reference
    // against a method target is excluded (fix #220, ripgrep-measured:
    // `self.paths.has_implicit_path` is the bool FIELD, not the method).
    // Go method values (obj.Method) and Java `::` references DO denote
    // methods — false. Per-language override, not preset-wide.
    memberAccessNeverMethod: false,
    classesCallableWithoutNew: false,
    decoratorsWrapCallables: false,
    callableDecorators: null,
    knownAsyncGlobals: null,
    assignmentDeclaresLocal: false,
    genericArityIsIdentity: false,
    typeArgumentsFromArgumentsOnly: false,
    // Test functions the toolchain binds to a declared identifier by NAME
    // (fix #383); see GO_EXAMPLE_NAMES. null: no such convention.
    nameBoundTestFunctions: null,
    // A top-level type lives in a file named after it (fix #386, Java).
    typeNamedSourceFile: false,
    // Compiler-resolved doc references (fix #390, C# crefs).
    docCrefReferences: false,
    // Simple-name method groups (fix #395, C#).
    methodGroupReferences: false,
    // A static import of a type brings only the members the type itself
    // declares, never inherited ones (fix #392, C# `using static`). Java's
    // static imports reach inherited static members.
    staticImportsDeclaredOnly: false,
    // Fields and methods are separate namespaces (fix #390, Java/Rust).
    fieldsAndMethodsSeparate: false,
};

/**
 * Go example functions (fix #383): go vet's `tests` analyzer (run by
 * `go test`) and godoc bind `Example<Ident>[_<Member>][_<suffix>]` in a
 * _test.go file to the identifier it names. The name is split the way vet
 * splits it: at most three parts at '_', and a part starting with a
 * lower-case letter is a suffix, not a member. Renaming the identifier or
 * member without the example fails vet ("refers to unknown field or method").
 */
const GO_EXAMPLE_NAMES = {
    kind: 'go-example',
    prefix: 'Example',
    testFile: /_test\.go$/,
    parse(fnName) {
        if (typeof fnName !== 'string' || !fnName.startsWith('Example')) return null;
        const exName = fnName.slice('Example'.length);
        const first = exName.indexOf('_');
        const ident = first < 0 ? exName : exName.slice(0, first);
        if (!ident) return null; // Example / Example_suffix: package examples
        let member = null;
        if (first >= 0) {
            const after = exName.slice(first + 1);
            const second = after.indexOf('_');
            const part = second < 0 ? after : after.slice(0, second);
            if (part && !/^\p{Ll}/u.test(part)) member = part;
        }
        return {
            ident,
            member,
            // The function name with its ident and/or member part replaced.
            rename({ ident: newIdent = ident, member: newMember = member } = {}) {
                const tail = exName.slice(ident.length);
                if (!member) return `Example${newIdent}${tail}`;
                return `Example${newIdent}_${newMember}${tail.slice(1 + member.length)}`;
            },
        };
    },
};

// JS/TS runtime protocol members: JSON.stringify calls toJSON, await and
// promise resolution call then, coercion calls toString/valueOf, and
// well-known symbols (`[Symbol.iterator]`) are invoked by the runtime.
const JS_PROTOCOL_MEMBERS = protocolMembers([
    { names: ['toJSON', 'then', 'toString', 'valueOf', 'toLocaleString'], member: true },
    { pattern: /^\[Symbol\.[A-Za-z]+\]$/, member: true },
]);
const JS_REFLECTION_API = {
    hintPattern: /\bReflect\s*\.\s*(?:get|set|has|deleteProperty)\b|\beval\s*\(/,
    functions: [{ callee: /^(?:globalThis\.)?Reflect\.(?:get|set|has|deleteProperty)$/,
        nameArg: 1, receiverArg: 0, qualified: true }],
    computedMembers: true,
    namespaceLookups: { calls: /^eval$/ },
    family: 'javascript',
};

// Language configurations
const LANGUAGES = {
    javascript: {
        name: 'javascript',
        extensions: ['.js', '.jsx', '.mjs', '.cjs'],
        treeSitterLang: 'javascript',
        module: () => require('./javascript'),
        treeSitterModule: () => require('tree-sitter-javascript'),
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            reflectionApi: JS_REFLECTION_API,
            languageProtocolMember: JS_PROTOCOL_MEMBERS,
            storedPromises: true,
            knownAsyncGlobals: ['fetch'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.test.ts`, `${base}.test.js`, `${base}.spec.ts`, `${base}.spec.js`],
            testDirs: ['__tests__'],
        },
    },
    typescript: {
        name: 'typescript',
        extensions: ['.ts'],
        treeSitterLang: 'typescript',
        module: () => require('./javascript'),  // Same module, different parser
        treeSitterModule: () => require('tree-sitter-typescript').typescript,
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            reflectionApi: JS_REFLECTION_API,
            languageProtocolMember: JS_PROTOCOL_MEMBERS,
            storedPromises: true,
            knownAsyncGlobals: ['fetch'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.test.ts`, `${base}.test.js`, `${base}.spec.ts`, `${base}.spec.js`],
            testDirs: ['__tests__'],
        },
    },
    tsx: {
        name: 'tsx',
        extensions: ['.tsx'],
        treeSitterLang: 'tsx',
        module: () => require('./javascript'),
        treeSitterModule: () => require('tree-sitter-typescript').tsx,
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            reflectionApi: JS_REFLECTION_API,
            languageProtocolMember: JS_PROTOCOL_MEMBERS,
            storedPromises: true,
            knownAsyncGlobals: ['fetch'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`, `${base}.test.ts`, `${base}.test.js`, `${base}.spec.ts`, `${base}.spec.js`],
            testDirs: ['__tests__'],
        },
    },
    python: {
        name: 'python',
        extensions: ['.py', '.pyi'],
        treeSitterLang: 'python',
        module: () => require('./python'),
        treeSitterModule: () => require('tree-sitter-python'),
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['self', 'cls'],
            // fix #224: `from pkg import name` may bind a SUBMODULE file, not
            // a symbol — graph-build resolves the composed dotted specifier
            // and query code treats such receivers as module receivers. JS
            // from-imports bind values only (`import * as ns` is parser-marked).
            submoduleImports: true,
            // `__x` (not a dunder) is name-mangled per class (fix #397).
            privateMemberName: name => /^__/.test(String(name)) && !/__$/.test(String(name)),
            classesCallableWithoutNew: true,
            // Call sites bind by parameter name (f(x=1)); signatures carry
            // keyword-only (`*`) and positional-only (`/`) markers (fix #281).
            keywordArguments: true,
            assignmentDeclaresLocal: true,
            // Calling an async def creates a coroutine object in any scope:
            // audit-async checks such calls in sync functions too, and
            // follows a local assigned from the call to the uses that need
            // its result (fix #398).
            storedCoroutines: true,
            // Decorators with a known effect on what calling the decorated
            // function returns (fix #364), as resolved qualified names (a
            // trailing `()` marks a decorator factory call). Any other
            // decorator makes an async function's result unknown.
            callableDecorators: {
                builtins: ['staticmethod', 'classmethod', 'property', 'callable', 'isinstance'],
                transparent: [
                    'builtins.staticmethod', 'builtins.classmethod', 'abc.abstractmethod',
                    'typing.override', 'typing_extensions.override', 'typing.final',
                    'typing_extensions.final', 'typing.overload', 'typing_extensions.overload',
                    'functools.wraps()',
                ],
                asyncContextManagers: ['contextlib.asynccontextmanager'],
                // Standard-library decorators that never read the decorated
                // callable's name (fix #392): a rename of the definition and
                // its references is complete under them.
                namePreserving: [
                    'builtins.property', 'abc.abstractproperty', 'abc.abstractclassmethod',
                    'abc.abstractstaticmethod', 'functools.cached_property', 'functools.cache',
                    'functools.lru_cache', 'functools.lru_cache()', 'functools.singledispatch',
                    'functools.singledispatchmethod', 'functools.total_ordering',
                    'contextlib.contextmanager', 'typing.no_type_check',
                    'typing.runtime_checkable', 'typing_extensions.runtime_checkable',
                    'typing_extensions.deprecated()', 'warnings.deprecated()',
                    'dataclasses.dataclass', 'dataclasses.dataclass()', 'enum.unique',
                    'unittest.mock.patch()', 'unittest.mock.patch.object()', 'unittest.mock.patch.dict()',
                    'unittest.mock.patch.multiple()', 'unittest.skip()', 'unittest.skipIf()',
                    'unittest.skipUnless()', 'unittest.expectedFailure',
                ],
            },
            languageProtocolMember: protocolMembers([
                // Data-model dunders (__eq__, __init_subclass__, __set_name__,
                // __reduce__, module __getattr__) are dispatched by name.
                { pattern: /^__[A-Za-z][A-Za-z0-9_]*__$/ },
                // Enum machinery hooks (auto() values, lookup fallback).
                { names: ['_generate_next_value_', '_missing_'], member: true,
                    owners: ['Enum', 'IntEnum', 'StrEnum', 'Flag', 'IntFlag', 'ReprEnum'] },
            ]),
            reflectionApi: {
                hintPattern: /\b(?:getattr|setattr|hasattr|delattr|eval)\s*\(|\b(?:globals|vars)\s*\(\s*\)\s*\[/,
                functions: [{ callee: /^(?:getattr|setattr|hasattr|delattr)$/, nameArg: 1, receiverArg: 0 }],
                namespaceLookups: { calls: /^eval$/, subscriptOf: /^(?:globals|vars)\(\)$/ },
            },
            testFileCandidates: (base, ext) => [`test_${base}.py`, `${base}_test.py`],
            testDirs: ['tests'],
        },
    },
    go: {
        name: 'go',
        extensions: ['.go'],
        treeSitterLang: 'go',
        module: () => require('./go'),
        treeSitterModule: () => require('tree-sitter-go'),
        traits: {
            ...NOMINAL_TRAITS,
            selfParam: null,
            packageScope: 'directory',
            hasReceiverPackageCalls: true,
            exportVisibility: 'capitalization',
            hasDynamicImports: false,
            typeQualifiedCallStyle: 'method-expr',
            methodCallReachesFunctions: true,
            reflectionApi: {
                hintPattern: /\b(?:MethodByName|FieldByName)\b/,
                members: [{ member: /^(?:MethodByName|FieldByName)$/, nameArg: 0 }],
                membersOnly: true,
                formatCalls: { 'fmt.Sprintf': 'percent' },
            },
            testFileCandidates: (base, ext) => [`${base}_test.go`],
            nameBoundTestFunctions: GO_EXAMPLE_NAMES,
        },
    },
    rust: {
        name: 'rust',
        extensions: ['.rs'],
        treeSitterLang: 'rust',
        module: () => require('./rust'),
        treeSitterModule: () => require('tree-sitter-rust'),
        traits: {
            ...NOMINAL_TRAITS,
            selfParam: ['self', '&self', '&mut self', 'mut self'],
            hasDynamicImports: false,
            moduleTypeIdentity: true,
            // Same-scope definitions of one name are configuration
            // alternatives selected by `#[cfg]` (fix #376).
            conditionalDefinitions: 'attribute',
            typeQualifiedCallStyle: 'path',
            standardPathRoots: ['std', 'core', 'alloc'],
            // Call records say whether their value is consumed where it is
            // produced (`valueConsumed`, `consumingMethod`; fix #371).
            callValueFacts: true,
            memberAccessNeverMethod: true,
            fieldsAndMethodsSeparate: true,
            genericBoundDispatchClosed: true,
            macroTemplateBodies: true,
            // Macro invocations are written `name!(...)` / `#[name]`: a
            // separate namespace from fns and values (fix #377).
            macroInvocationSyntax: 'marked',
            // A fn declared inside a fn body is an item of that block: a
            // bare path outside the block never names it (fix #377).
            nestedItemsBlockScoped: true,
            // Names every module sees without a `use` (the std prelude of
            // editions 2015-2024 and the primitive types): a name no `use`,
            // glob or item binds must be one of them, or come from a macro
            // expansion (fix #386).
            implicitPreludeNames: new Set([
                'Option', 'Some', 'None', 'Result', 'Ok', 'Err', 'Vec', 'String', 'Box',
                'ToString', 'ToOwned', 'Clone', 'Copy', 'Send', 'Sync', 'Sized', 'Unpin',
                'Drop', 'Fn', 'FnMut', 'FnOnce', 'AsyncFn', 'AsyncFnMut', 'AsyncFnOnce',
                'Iterator', 'IntoIterator', 'Extend', 'DoubleEndedIterator', 'ExactSizeIterator',
                'FromIterator', 'Default', 'Eq', 'PartialEq', 'Ord', 'PartialOrd', 'AsRef',
                'AsMut', 'Into', 'From', 'TryFrom', 'TryInto', 'Future', 'IntoFuture', 'Debug',
                'Hash', 'bool', 'char', 'str', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize',
                'i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'f32', 'f64',
            ]),
            testFileCandidates: (base, ext) => [`${base}_test.rs`],
            testDirs: ['tests'],
        },
    },
    java: {
        name: 'java',
        extensions: ['.java'],
        treeSitterLang: 'java',
        module: () => require('./java'),
        treeSitterModule: () => require('tree-sitter-java'),
        traits: {
            ...NOMINAL_TRAITS,
            fieldsAndMethodsSeparate: true,
            standardPathRoots: ['java', 'javax'],
            typeNameScoping: 'package-on-demand',
            typeNamedSourceFile: true,
            // The public top-level types of java.lang (JDK 8-21, preview
            // included): a spec-level list, not project knowledge.
            implicitTypeImport: { module: 'java.lang', names: new Set([
                'AbstractMethodError', 'Appendable', 'ArithmeticException',
                'ArrayIndexOutOfBoundsException', 'ArrayStoreException', 'AssertionError',
                'AutoCloseable', 'Boolean', 'BootstrapMethodError', 'Byte', 'Character',
                'CharSequence', 'Class', 'ClassCastException', 'ClassCircularityError',
                'ClassFormatError', 'ClassLoader', 'ClassNotFoundException', 'ClassValue',
                'CloneNotSupportedException', 'Cloneable', 'Comparable', 'Compiler', 'Deprecated',
                'Double', 'Enum', 'EnumConstantNotPresentException', 'Error', 'Exception',
                'ExceptionInInitializerError', 'Float', 'FunctionalInterface',
                'IllegalAccessError', 'IllegalAccessException', 'IllegalArgumentException',
                'IllegalCallerException', 'IllegalMonitorStateException', 'IllegalStateException',
                'IllegalThreadStateException', 'IncompatibleClassChangeError',
                'IndexOutOfBoundsException', 'InheritableThreadLocal', 'InstantiationError',
                'InstantiationException', 'Integer', 'InternalError', 'InterruptedException',
                'Iterable', 'LayerInstantiationException', 'LinkageError', 'Long',
                'MatchException', 'Math', 'Module', 'ModuleLayer', 'NegativeArraySizeException',
                'NoClassDefFoundError', 'NoSuchFieldError', 'NoSuchFieldException',
                'NoSuchMethodError', 'NoSuchMethodException', 'NullPointerException', 'Number',
                'NumberFormatException', 'Object', 'OutOfMemoryError', 'Override', 'Package',
                'Process', 'ProcessBuilder', 'ProcessHandle', 'Readable', 'Record',
                'ReflectiveOperationException', 'Runnable', 'Runtime', 'RuntimeException',
                'RuntimePermission', 'SafeVarargs', 'ScopedValue', 'SecurityException',
                'SecurityManager', 'Short', 'StackOverflowError', 'StackTraceElement',
                'StackWalker', 'StrictMath', 'String', 'StringBuffer', 'StringBuilder',
                'StringIndexOutOfBoundsException', 'StringTemplate', 'SuppressWarnings', 'System',
                'Thread', 'ThreadDeath', 'ThreadGroup', 'ThreadLocal', 'Throwable',
                'TypeNotPresentException', 'UnknownError', 'UnsatisfiedLinkError',
                'UnsupportedClassVersionError', 'UnsupportedOperationException', 'VerifyError',
                'VirtualMachineError', 'Void', 'WrongThreadException',
            ]) },
            selfParam: ['this'],
            allMethodsVirtual: true,
            hasArityOverloads: true,
            universalSupertype: 'Object',
            universalSupertypeMembers: { toString: 0, equals: 1, hashCode: 0, clone: 0, finalize: 0 },
            // Serialization callbacks and fields the JVM uses reflectively.
            languageProtocolMember: protocolMembers([
                // java.lang roots that implement java.io.Serializable (JDK API):
                // a project subclass inherits the contract (fix #380). Any
                // other out-of-project supertype but Object may implement it
                // too (`extends IOException`, `extends ArrayList`): possible.
                { names: ['readObject', 'writeObject', 'readResolve', 'writeReplace', 'readObjectNoData',
                    'serialVersionUID', 'serialPersistentFields'],
                member: true, owners: ['Serializable', 'Externalizable', 'Number', 'Throwable',
                    'Exception', 'RuntimeException', 'Error'],
                // Enum constants are serialized by name: readObject,
                // writeObject, readResolve, writeReplace, readObjectNoData and
                // serialVersionUID/serialPersistentFields of an enum type are
                // ignored (Java Object Serialization Specification 1.12).
                exceptOwnerKinds: ['enum'],
                possibleViaExternal: { except: JAVA_LANG_NOT_SERIALIZABLE, shape: javaSerializationShape } },
            ]),
            reflectionApi: {
                hintPattern: /\b(?:getMethod|getDeclaredMethod|getField|getDeclaredField)\b/,
                members: [{ member: /^(?:getMethod|getDeclaredMethod|getField|getDeclaredField)$/, nameArg: 0 }],
                membersOnly: true,
                formatCalls: { 'String.format': 'percent' },
                selfTypeCalls: ['getClass'],
                typeLiteralNodes: ['class_literal'],
            },
            bareCallReachesMethods: true,
            testFileCandidates: (base, ext) => [`${base}Test.java`, `${base}Tests.java`, `${base}TestCase.java`],
        },
    },
    c: {
        name: 'c',
        extensions: ['.c', '.h'],
        treeSitterLang: 'c',
        module: () => require('./c'),
        treeSitterModule: () => require('tree-sitter-c'),
        traits: {
            ...NOMINAL_TRAITS,
            selfParam: null,
            packageScope: 'file',
            hasDynamicImports: false,
            exportVisibility: 'linkage',
            // Same-signature definitions in one file are `#if` alternatives.
            conditionalDefinitions: 'preprocessor',
            textualIncludes: true,
            // Function-like macros are invoked with call syntax: a call
            // spelled NAME( where #define NAME( is in effect is the macro
            // (fix #377).
            macroInvocationSyntax: 'call',
            typeQualifiedCallStyle: 'static',
            bareCallReachesMethods: false,
            methodCallReachesFunctions: true,
            testFileCandidates: (base, ext) => [
                `${base}_test${ext}`, `test_${base}${ext}`, `${base}.test${ext}`,
            ],
            testDirs: ['test', 'tests'],
        },
    },
    cpp: {
        name: 'cpp',
        extensions: ['.cc', '.cpp', '.cxx', '.c++', '.hpp', '.hh', '.hxx', '.h++'],
        treeSitterLang: 'cpp',
        module: () => require('./cpp'),
        treeSitterModule: () => require('tree-sitter-cpp'),
        traits: {
            ...NOMINAL_TRAITS,
            selfParam: ['this'],
            packageScope: 'file',
            hasDynamicImports: false,
            conditionalDefinitions: 'preprocessor',
            exportVisibility: 'linkage',
            textualIncludes: true,
            // Function-like macros are invoked with call syntax: a call
            // spelled NAME( where #define NAME( is in effect is the macro
            // (fix #377).
            macroInvocationSyntax: 'call',
            typeQualifiedCallStyle: 'path',
            standardPathRoots: ['std'],
            hasArityOverloads: true,
            // Range-for lowers onto member begin()/end() with no name token.
            languageProtocolMember: protocolMembers([
                { names: ['begin', 'end'], member: true },
            ]),
            // C++ instance dispatch is virtual only when the declaration
            // explicitly says virtual/override (unlike Java's implicit rule).
            explicitVirtualDispatch: true,
            bareCallReachesMethods: true,
            // `obj.f()` performs member lookup and cannot bind a namespace
            // free function. `ns::f()` remains supported through isPathCall.
            methodCallReachesFunctions: false,
            testFileCandidates: (base, ext) => [
                `${base}_test${ext}`, `test_${base}${ext}`, `${base}.test${ext}`,
            ],
            testDirs: ['test', 'tests'],
        },
    },
    csharp: {
        name: 'csharp',
        extensions: ['.cs', '.csx'],
        treeSitterLang: 'c_sharp',
        module: () => require('./csharp'),
        treeSitterModule: () => require('tree-sitter-c-sharp'),
        traits: {
            ...NOMINAL_TRAITS,
            standardPathRoots: ['System'],
            conditionalDefinitions: 'preprocessor',
            typeNameScoping: 'namespace-usings',
            genericArityIsIdentity: true,
            typeArgumentsFromArgumentsOnly: true,
            selfParam: ['this', 'base'],
            packageScope: 'namespace',
            hasDynamicImports: false,
            hasArityOverloads: true,
            bareCallReachesMethods: true,
            typeQualifiedCallStyle: 'static',
            universalSupertype: 'Object',
            universalSupertypeMembers: { ToString: 0, Equals: 1, GetHashCode: 0, Finalize: 0 },
            docCrefReferences: true,
            methodGroupReferences: true,
            staticImportsDeclaredOnly: true,
            // Pattern-bound members the compiler lowers syntax onto
            // (foreach, await, deconstruction) - invoked with no name token.
            languageProtocolMember: protocolMembers([
                { names: ['GetEnumerator', 'GetAsyncEnumerator', 'MoveNext', 'MoveNextAsync', 'Current',
                    'GetAwaiter', 'GetResult', 'IsCompleted', 'OnCompleted', 'UnsafeOnCompleted',
                    'Deconstruct'], member: true },
            ]),
            // Compiler-required types a feature's lowering names (C# spec;
            // polyfilled by projects targeting older frameworks).
            languageProtocolType: protocolTypes([
                { names: ['IsExternalInit'], namespace: 'System.Runtime.CompilerServices', features: ['init'] },
                { names: ['RequiredMemberAttribute', 'CompilerFeatureRequiredAttribute'],
                    namespace: 'System.Runtime.CompilerServices', features: ['required'] },
                { names: ['ExtensionAttribute'], namespace: 'System.Runtime.CompilerServices',
                    features: ['extension-method'] },
                { names: ['NullableAttribute', 'NullableContextAttribute', 'NullablePublicOnlyAttribute'],
                    namespace: 'System.Runtime.CompilerServices', features: ['nullable'] },
                { names: ['IsByRefLikeAttribute'], namespace: 'System.Runtime.CompilerServices', features: ['ref-struct'] },
                { names: ['IsReadOnlyAttribute'], namespace: 'System.Runtime.CompilerServices', features: ['readonly'] },
                { names: ['IsUnmanagedAttribute'], namespace: 'System.Runtime.CompilerServices', features: ['unmanaged'] },
                { names: ['TupleElementNamesAttribute'], namespace: 'System.Runtime.CompilerServices',
                    features: ['tuple-names'] },
                { names: ['Index', 'Range'], namespace: 'System', features: ['index-range'] },
            ]),
            reflectionApi: {
                hintPattern: /\b(?:GetMethod|GetProperty|GetField|GetMember)\b/,
                members: [{ member: /^(?:GetMethod|GetProperty|GetField|GetMember)$/, nameArg: 0 }],
                membersOnly: true,
                formatCalls: { 'string.Format': 'brace', 'String.Format': 'brace' },
                selfTypeCalls: ['GetType'],
                typeLiteralNodes: ['typeof_expression'],
            },
            testFileCandidates: (base, ext) => [
                `${base}Tests${ext}`, `${base}Test${ext}`, `${base}.Tests${ext}`,
            ],
            testDirs: ['test', 'tests'],
        },
    },
    html: {
        name: 'html',
        extensions: ['.html', '.htm'],
        treeSitterLang: 'html',
        module: () => require('./html'),
        treeSitterModule: () => require('tree-sitter-html'),
        traits: {
            ...STRUCTURAL_TRAITS,
            selfParam: ['this'],
            storedPromises: true,
            knownAsyncGlobals: ['fetch'],
            testFileCandidates: (base, ext) => [`${base}.test${ext}`, `${base}.spec${ext}`],
        },
    }
};

// Extension to language mapping
const EXT_MAP = {};
for (const [langName, config] of Object.entries(LANGUAGES)) {
    for (const ext of config.extensions) {
        EXT_MAP[ext] = langName;
    }
}

/**
 * Load tree-sitter module (lazy)
 * @returns {object} TreeSitter class
 */
function loadTreeSitter() {
    if (!TreeSitter) {
        try {
            TreeSitter = require('tree-sitter');
        } catch (e) {
            throw new UcnError(
                'tree-sitter is required but not installed.\n' +
                'Install with: npm install',
                { cause: e }
            );
        }
        _installNodeTypeCache(TreeSitter);
        _installNodeParentCache(TreeSitter);
        _installNodeFieldCaches(TreeSitter);
    }
    return TreeSitter;
}

// Immutable facts of a node wrapper, read natively once (fix #385). They
// live in one record per wrapper, created with every field at once (fix
// #388): a wrapper gains a single property whichever fact is read first,
// instead of one per fact in read order.
const NODE_FACTS = Symbol('ucn.nodeFacts');
const UNREAD = Symbol('ucn.unread');

function NodeFacts() {
    this.parent = UNREAD;
    this.startIndex = -1;
    this.endIndex = -1;
    this.fields = null;
    this.namedChildren = null;
}

// Internal read of a node's named children without a defensive copy: the
// caller never mutates the array (the flat node list builder in utils.js).
const NAMED_CHILDREN_LIST = Symbol.for('ucn.namedChildrenList');
const NO_CHILDREN = Object.freeze([]);

function nodeFactsOf(node) {
    let facts = node[NODE_FACTS];
    if (facts === undefined) {
        facts = new NodeFacts();
        node[NODE_FACTS] = facts;
    }
    return facts;
}

/**
 * Same discipline as the parent cache for the other immutable facts hot
 * walks re-read: byte offsets and field children (fix #385).
 */
function _installNodeFieldCaches(TS) {
    try {
        const base = TS?.SyntaxNode?.prototype;
        if (!base) return;
        const startDesc = Object.getOwnPropertyDescriptor(base, 'startIndex');
        if (startDesc?.get && !startDesc.set) {
            const nativeStart = startDesc.get;
            Object.defineProperty(base, 'startIndex', {
                configurable: true,
                get() {
                    const facts = nodeFactsOf(this);
                    let value = facts.startIndex;
                    if (value < 0) {
                        value = nativeStart.call(this);
                        facts.startIndex = value;
                    }
                    return value;
                },
            });
        }
        const endDesc = Object.getOwnPropertyDescriptor(base, 'endIndex');
        if (endDesc?.get && !endDesc.set) {
            const nativeEnd = endDesc.get;
            Object.defineProperty(base, 'endIndex', {
                configurable: true,
                get() {
                    const facts = nodeFactsOf(this);
                    let value = facts.endIndex;
                    if (value < 0) {
                        value = nativeEnd.call(this);
                        facts.endIndex = value;
                    }
                    return value;
                },
            });
        }
        // Named children (fix #388): the flat node list reads every named
        // node's children once; later reads of the same node (child loops,
        // counts, walks) are served from that array. Callers always get a
        // fresh array, as from the binding.
        const namedDesc = Object.getOwnPropertyDescriptor(base, 'namedChildren');
        const countDesc = Object.getOwnPropertyDescriptor(base, 'namedChildCount');
        const firstDesc = Object.getOwnPropertyDescriptor(base, 'firstNamedChild');
        const lastDesc = Object.getOwnPropertyDescriptor(base, 'lastNamedChild');
        const nativeNamedChild = base.namedChild;
        if (namedDesc?.get && !namedDesc.set && countDesc?.get && !countDesc.set &&
            firstDesc?.get && !firstDesc.set && lastDesc?.get && !lastDesc.set &&
            typeof nativeNamedChild === 'function') {
            const nativeNamed = namedDesc.get;
            const nativeCount = countDesc.get;
            const nativeFirst = firstDesc.get;
            const nativeLast = lastDesc.get;
            // A leaf's empty list is not stored unless the node already has
            // a facts record: most named nodes are leaves, and a record per
            // leaf would only hold an empty array (build-worker RSS).
            const namedList = node => {
                const existing = node[NODE_FACTS];
                if (existing !== undefined && existing.namedChildren !== null) return existing.namedChildren;
                const list = nativeNamed.call(node);
                if (list.length > 0) nodeFactsOf(node).namedChildren = list;
                else if (existing !== undefined) existing.namedChildren = NO_CHILDREN;
                return list;
            };
            Object.defineProperty(base, NAMED_CHILDREN_LIST, {
                configurable: true,
                writable: true,
                value() { return namedList(this); },
            });
            Object.defineProperty(base, 'namedChildren', {
                configurable: true,
                get() { return namedList(this).slice(); },
            });
            const cachedList = node => {
                const facts = node[NODE_FACTS];
                return facts === undefined ? null : facts.namedChildren;
            };
            Object.defineProperty(base, 'namedChildCount', {
                configurable: true,
                get() {
                    const list = cachedList(this);
                    return list === null ? nativeCount.call(this) : list.length;
                },
            });
            Object.defineProperty(base, 'namedChild', {
                configurable: true,
                writable: true,
                value(index) {
                    const list = cachedList(this);
                    if (list !== null && Number.isInteger(index) && index >= 0 && index < list.length) {
                        return list[index];
                    }
                    return nativeNamedChild.call(this, index);
                },
            });
            Object.defineProperty(base, 'firstNamedChild', {
                configurable: true,
                get() {
                    const list = cachedList(this);
                    return list === null ? nativeFirst.call(this) : (list.length > 0 ? list[0] : null);
                },
            });
            Object.defineProperty(base, 'lastNamedChild', {
                configurable: true,
                get() {
                    const list = cachedList(this);
                    return list === null ? nativeLast.call(this) : (list.length > 0 ? list[list.length - 1] : null);
                },
            });
        }
        const nativeField = base.childForFieldName;
        if (typeof nativeField === 'function') {
            Object.defineProperty(base, 'childForFieldName', {
                configurable: true,
                writable: true,
                value(fieldName) {
                    const facts = nodeFactsOf(this);
                    let fields = facts.fields;
                    if (fields === null) {
                        fields = new Map();
                        facts.fields = fields;
                    } else if (fields.has(fieldName)) {
                        return fields.get(fieldName);
                    }
                    const child = nativeField.call(this, fieldName);
                    fields.set(fieldName, child);
                    return child;
                },
            });
        }
    } catch { /* stock accessors keep working */ }
}

/**
 * Make SyntaxNode#parent a native call only once per node wrapper.
 *
 * The binding returns one wrapper object per node of a tree (its node cache),
 * trees are never edited here, and a node's parent is immutable, so the first
 * native read is stored on the wrapper and later reads are property hits.
 * Enclosing-scope helpers climb to the translation unit from every call
 * site and declaration; on C++ headers those climbs were the single largest
 * native-bridge cost of a cold build (fix #385).
 */
function _installNodeParentCache(TS) {
    try {
        const base = TS?.SyntaxNode?.prototype;
        const desc = base && Object.getOwnPropertyDescriptor(base, 'parent');
        if (!desc?.get || desc.set) return; // shape changed upstream: leave it alone
        const nativeGet = desc.get;
        Object.defineProperty(base, 'parent', {
            configurable: true,
            get() {
                const facts = nodeFactsOf(this);
                let parent = facts.parent;
                if (parent === UNREAD) {
                    parent = nativeGet.call(this);
                    facts.parent = parent;
                }
                return parent;
            },
        });
    } catch { /* stock getter keeps working */ }
}

/**
 * Make SyntaxNode#type a cheap data-property read.
 *
 * The binding generates one node subclass per grammar type id and intends
 * `nodeSubclass.prototype.type = typeName` to shadow the base getter — but
 * SyntaxNode.prototype.type is a getter-only accessor, so that plain
 * assignment silently no-ops and EVERY `.type` read marshals into native
 * code. Hot walks read `.type` many times per node; on a ~300-file build
 * this getter alone costs seconds.
 *
 * A node's type is immutable and each generated subclass maps to exactly
 * one grammar type, so the first native read per CLASS plants the string as
 * a data property on that class's prototype — all later reads on any node
 * of that type are plain property hits. Nodes using the base class itself
 * (anonymous tokens, ERROR) keep the native getter.
 */
function _installNodeTypeCache(TS) {
    try {
        const base = TS?.SyntaxNode?.prototype;
        const desc = base && Object.getOwnPropertyDescriptor(base, 'type');
        if (!desc?.get || desc.set) return; // shape changed upstream — leave it alone
        const nativeGet = desc.get;
        Object.defineProperty(base, 'type', {
            configurable: true,
            get() {
                const t = nativeGet.call(this);
                const ctor = this.constructor;
                if (ctor && ctor !== TS.SyntaxNode && ctor.prototype instanceof TS.SyntaxNode) {
                    Object.defineProperty(ctor.prototype, 'type', {
                        value: t, configurable: true
                    });
                }
                return t;
            }
        });
    } catch { /* stock getter keeps working */ }
}

/**
 * Get or create parser for a language
 * @param {string} language - Language name
 * @returns {object} Tree-sitter parser instance
 */
function getParser(language) {
    if (parsers[language]) return parsers[language];

    const TS = loadTreeSitter();
    const parser = new TS();
    const config = LANGUAGES[language];

    if (!config) {
        throw new UcnError(`Unsupported language: ${language}`);
    }

    try {
        const lang = config.treeSitterModule();
        parser.setLanguage(lang);
    } catch (e) {
        throw new UcnError(
            `Failed to load tree-sitter grammar for ${language}.\n` +
            `Install with: npm install tree-sitter-${language}\n` +
            `Original error: ${e.message}`,
            { cause: e }
        );
    }

    parsers[language] = parser;
    return parser;
}

/**
 * Detect language from file path
 * @param {string} filePath - File path
 * @returns {string|null} Language name or null if unsupported
 */
function detectLanguage(filePath, projectRoot = null) {
    const rawExt = path.extname(filePath);
    const ext = rawExt.toLowerCase();
    if (ext === '.h') {
        const { detectHeaderLanguage } = require('../core/compilation-database');
        return detectHeaderLanguage(filePath, projectRoot);
    }
    return EXT_MAP[ext] || null;
}

/**
 * Get the normalized v5 adapter for a language.
 * @param {string} language - Language name
 * @returns {object} Language adapter
 */
function getLanguageAdapter(language) {
    if (adapters[language]) return adapters[language];
    const config = LANGUAGES[language];
    if (!config) {
        throw new UcnError(`Unsupported language: ${language}`);
    }
    adapters[language] = createLanguageAdapter(config);
    return adapters[language];
}

/**
 * Check if a language is supported
 * @param {string} language - Language name
 * @returns {boolean}
 */
function isSupported(language) {
    return language in LANGUAGES;
}

/**
 * Get all supported extensions
 * @returns {string[]}
 */
function getSupportedExtensions() {
    return Object.keys(EXT_MAP);
}

/**
 * Get all supported languages
 * @returns {string[]}
 */
function getSupportedLanguages() {
    return Object.keys(LANGUAGES);
}

// Buffer size for tree-sitter parser (workaround for default 32KB limit)
// Default 1MB handles most files; can be overridden via UCN_BUFFER_SIZE env var
const DEFAULT_BUFFER_SIZE = 1024 * 1024; // 1MB
const MAX_BUFFER_SIZE = 64 * 1024 * 1024; // 64MB cap
const SMALL_BUFFER_SIZE = 32 * 1024;

const PARSE_OPTIONS = {
    bufferSize: parseInt(process.env.UCN_BUFFER_SIZE, 10) || DEFAULT_BUFFER_SIZE
};

/**
 * Get parse options with dynamic buffer sizing based on content size
 * @param {number} contentLength - Length of content to parse
 * @returns {object} Parse options with appropriate buffer size
 */
function getParseOptions(contentLength = 0) {
    // Start with configured/default size, scale up for large files
    // Buffer needs room for syntax tree which can be 2-3x content size
    const minBuffer = parseInt(process.env.UCN_BUFFER_SIZE, 10) || DEFAULT_BUFFER_SIZE;
    const scaledBuffer = Math.max(minBuffer, contentLength * 3);
    const bufferSize = Math.min(scaledBuffer, MAX_BUFFER_SIZE);
    return { bufferSize };
}

/**
 * Safely parse content with automatic buffer retry on failure
 * @param {object} parser - tree-sitter parser instance
 * @param {string} content - Source code to parse
 * @param {object} oldTree - Previous tree for incremental parsing (optional)
 * @param {object} options - Additional parse options
 * @returns {object} Parsed tree
 */
// Single-entry parse cache: during indexFile(), the same (parser, content) is parsed
// 5 times (findFunctions + findClasses + findStateObjects + findImports + findExports).
// Caching the last result eliminates 4 out of 5 parses per file (80% reduction).
let _lastParseParser = null;
let _lastParseContent = null;
let _lastParseTree = null;

function safeParse(parser, content, oldTree = undefined, options = {}) {
    // Fast path: return cached tree if same parser and content (no oldTree override)
    if (!oldTree && parser === _lastParseParser && content === _lastParseContent && _lastParseTree) {
        return _lastParseTree;
    }

    const contentLength = content.length;

    // Try with escalating buffer sizes. The first holds the content with
    // room to spare but no more: a 1MB buffer for a one-line probe or a
    // macro body costs 20x the parse itself (fix #396).
    const bufferSizes = [
        parseInt(process.env.UCN_BUFFER_SIZE, 10) ||
            Math.min(DEFAULT_BUFFER_SIZE, Math.max(SMALL_BUFFER_SIZE, contentLength * 2)),
        DEFAULT_BUFFER_SIZE,
        Math.max(DEFAULT_BUFFER_SIZE, contentLength * 2),
        Math.max(4 * 1024 * 1024, contentLength * 3),
        Math.max(16 * 1024 * 1024, contentLength * 4),
        MAX_BUFFER_SIZE
    ].filter((size, i, arr) => i === 0 || size > arr[i - 1]); // Remove duplicates

    let lastError;
    for (const bufferSize of bufferSizes) {
        try {
            const tree = parser.parse(content, oldTree, { ...options, bufferSize });
            // Cache the result for same-(parser, content) reuse
            if (!oldTree) {
                _lastParseParser = parser;
                _lastParseContent = content;
                _lastParseTree = tree;
            }
            return tree;
        } catch (e) {
            lastError = e;
            // Only retry on buffer-related errors
            // tree-sitter throws "Invalid argument" when buffer is too small
            const msg = e.message?.toLowerCase() || '';
            if (!msg.includes('buffer') &&
                !msg.includes('memory') &&
                !msg.includes('alloc') &&
                !msg.includes('invalid argument')) {
                throw e; // Non-buffer error, don't retry
            }
            // Continue to next buffer size
        }
    }

    // All attempts failed
    throw lastError;
}

/**
 * Get trait object for a language.
 * @param {string} language - Language name (e.g. 'go', 'python')
 * @returns {object|undefined} Trait object or undefined if unknown language
 */
function langTraits(language) {
    return LANGUAGES[language]?.traits;
}

module.exports = {
    detectLanguage,
    getParser,
    getLanguageAdapter,
    isSupported,
    getSupportedExtensions,
    getSupportedLanguages,
    LANGUAGES,
    PARSE_OPTIONS,
    getParseOptions,
    safeParse,
    langTraits,
    DEFAULT_BUFFER_SIZE,
    MAX_BUFFER_SIZE
};
