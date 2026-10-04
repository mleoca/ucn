---
name: ucn
description: AST code intelligence for JavaScript/TypeScript, Python, Go, Rust, Java, C, C++, C#, and HTML. Use in repositories over roughly 500 LOC to orient, extract symbols, trace callers or callees, assess change impact, validate call sites, select tests, inspect dependencies, or investigate dead code. Prefer it over repeated grep-and-read cycles for semantic questions; use text search for literals, messages, configuration, and unsupported languages.
---

# UCN

Use UCN to gather compact, auditable code evidence before reading large files or changing a symbol.

## Core workflow

1. Run `ucn repo` in an unfamiliar repository. Add `--deep` when readiness or index health matters. If it reports skipped unsupported source, use grep/ripgrep and a language-native analyzer for those files; never interpret an `UNSUPPORTED` or `PARTIAL` scope as a semantic zero.
2. Pin a symbol with `ucn find <name>`, then pass its `path:line:name` handle to later commands.
3. Run `ucn show <handle>` for the default summary, callers, and callees. Request extra projections with `--sections=source,tests,types,dependencies,example,related`.
4. Before a change, run `ucn impact <handle>` and `ucn tests <handle> --depth=3`.
5. After a signature change, run `ucn check <handle>`. Before committing, run target-less `ucn check`. Both compare a changed declaration with its earlier parameters (`check <handle>` reads them at `HEAD`; target-less `check` at `--base`, default `HEAD`): call sites that bound the old declaration are checked against the new one, and a site that now fits no overload is a mismatch, never an excluded other-target line.
6. Read exact code with `ucn source <handle>` or `ucn source path/to/file:10-30` only when inspection is needed.

Prefer `--json` for automation. Every CLI JSON response uses `{ meta, data }`;
`meta.command` uses the native surface spelling and may include the internal
`canonicalCommand`. MCP returns text through one `ucn` tool and keeps contract
metadata visible when truncating results.

## One contract across surfaces

CLI, MCP, and interactive mode resolve the same 18 public commands through one registry, execute the same handlers, and use the same public formatters. CLI spells multiword commands with hyphens; MCP uses snake case. For example, use `audit-async` in CLI and `audit_async` in MCP.

The release board independently cross-checks overlapping stable-handle answers from `find`, `show`, `source`, `impact`, `tests`, `check`, and caller `trace`. Target identity, source and direct-test projections, caller tiers, evidence reasons, totals, and accounting must agree exactly; a mismatch is a failing witness rather than an interpretation left to an agent.

Publish-blocking semantic gates also compare stratified samples from pinned real repositories with independent language-native oracles: ts-morph, Pyright, gopls, rust-analyzer, JDT LS, clangd, and Roslyn. This validates the measured static evidence classes; it does not turn dynamic dispatch, generated code, reflection, or external dependencies into complete runtime knowledge.

MCP keeps its process and project index warm across calls. CLI and MCP share
the same text budget: broad sweep commands (`repo`, `entrypoints`,
`endpoints`, `deadcode`, `deps`, `check`, `audit-async`) default to 3K output
characters, all other commands to 10K, with a 100K hard ceiling. Use CLI
`--max-chars`, MCP `max_chars`, a narrower file/directory scope, or a smaller
section projection when necessary. Truncated output keeps the head of the
answer, a notice stating the full size and limit, and the accounting/contract
lines needed to interpret what remains; the requested limit includes all
three. Room for every trust line (`ACCOUNT`, `CONTRACT`, `WARNING`,
`FILTERED`, `CALLEE ACCOUNT`, `TREE ACCOUNT`) is reserved before any body
text; when the limit cannot hold them the answer is withheld and the notice
names the budget that would (`answer withheld; 2 of 4 trust line(s) shown.
Raise --max-chars to at least 964.`). `show` and `impact` keep a head of every tier section (confirmed,
runtime dispatch, unverified, callees) with a `+N more` line each, so a long
confirmed list never hides the unverified band. The text block is the whole response on every surface.

Persistent indexes live in a per-user, project-keyed cache rather than the analyzed repository. Set `UCN_CACHE_DIR` to override the cache root; CLI `--no-cache` bypasses persistence and `--clear-cache` removes the current project's cache. Legacy `<project>/.ucn-cache` directories are migrated on first use. Concurrent invocations on a cold cache share one build: the first process takes a build lock, the others wait for its cache (`Waiting for another ucn process building the index...` on stderr) instead of rebuilding; a lock left by a dead process is broken automatically.

Files named `*.min.js`, `*.bundle.js`, and `*.map` are disclosed as skipped
bundled sources; they make observed-text completeness partial. Pass
`--include-bundled` (MCP `include_bundled=true`) to index the JavaScript files.
This option bypasses the shared cache and still respects user exclusions.
Source maps remain disclosed but unindexed; inspect them with text tools.

Discovery applies the project's `.gitignore` files (root and nested) with git's
own matching rules, and git-tracked files are indexed even when a rule matches
them. If `git ls-files` fails inside a work tree, tracked files cannot be told
apart, so the index is disclosed as partial (`git-listing-failed` in
`repo --sections=health` and in caller contracts), never silently smaller.

Supported source families are JavaScript/TypeScript/TSX, Python, Go, Rust, Java, C, C++, C#, and HTML inline JavaScript/event handlers. C/C++ uses `compile_commands.json` when available to classify headers and resolve include paths; free-function visibility follows the transitive `#include` closure, and a quoted include found only by a unique project basename is weaker evidence (rule `include-basename`). Every non-static declaration of a free function (a header prototype or a local forward declaration in another file) is the same entity as its external definition, so its calls are the definition's callers and `plan` renames every declaration; a `static` forward declaration joins only its own file's definition. Several external-linkage definitions of one function (platform variants), or definitions in complementary `#if` branches, stay `link-ambiguous` on the caller and callee side unless the caller's own file (in the same branch) or the compile database separates them. A decoration macro before a return type (`API std::string Cls::m()`, `bool API ns::Cls::m()`, `MACRO std::size_t f()` in a class) or in a class head (`class API Name : public Base<Name>`) is blanked before parsing, only when the file proves it decoration (its own `#define`, or a position no type can hold) and never the type, scope or keyword beside it; members after a class-body macro invocation take the access its definition spells, and when that definition is not in the project their access is unknown and `deadcode` treats them as public. Members that escaped a class body the parser closed early are disclosed as recovery-region lines. A C++ `v->m()` reaches what `->` yields: the pointee of a pointer, of a std smart pointer (also behind a project alias) or of a class's `operator->`; any other object stays unverified. A receiver typed by a template parameter of the enclosing function or class template stays unverified `possible-dispatch` via that parameter, and an alias whose target is a dependent type (`typename X<..>::type`) is not a class. `::f()` names the global namespace, so a namespace member is not its target unless a global-scope using brings it in (unverified `global-qualified-using`); `plan` edits a qualified reference (an explicit instantiation `template auto ns::f(float) -> R;`, `&ns::f`) when its qualifier names the renamed function's namespace or class, and lists it for review when the qualifier cannot be resolved. A C++ `Q::f()` qualifier is resolved through `using` aliases, using-declarations, and macro-opened namespaces (a namespace an object-like macro names, `namespace LIB_NS {`, is the namespace the macro expands to, also where a qualifier or using-directive spells the macro): it excludes only when Q provably names a namespace or an unrelated class, and routes `unresolved-qualifier` or `dependent-qualifier` (template parameter) otherwise. Recoverable preprocessor branches contribute AST-proven source facts, so a single selected configuration does not silently erase definitions or calls; disagreeing conditional macro identities stay visible as unverified. C++ resolution uses namespace ownership, static overload shape (including arrays), and macro-parameter requalification. Invocations of project function-like macros that paste (`fs__##lc(req)`), call a parameter, or feed an X-macro list (`LIST(X)`, `#include "list.def"`) are expanded at the token level: a call the expansion produces is a caller at the invocation line, marked `[via macro NAME]` with rule `macro-expansion`; configuration-dependent definitions that disagree route `macro-definition-ambiguous`, and `plan --rename-to` lists such sites as manual review because the line does not spell the name. C# resolution uses declared property/field receiver types plus overload and hiding discipline. A C# `#if` that splits a declaration (a method body or expression body, a base-list entry, a parameter, alternative heads) is read one configuration at a time with every line number kept: the branch holding the most calls is primary, and the other alternatives' declarations and calls come from their own configuration. Overload choice needs argument evidence (Java, C#): where the applicable overloads differ in a parameter and the argument's type is unknown, the site stays unverified `overload-ambiguous` for each of them (for `plan`, a review item at the site), including the fixed-arity versus varargs/`params` choice; explicit method type arguments (`M<int>(..)`), literals, typed locals, parameters, fields of the enclosing class and a lambda's parameter count against `Action`/`Func`/`java.util.function` shapes, project delegates and project functional interfaces (one abstract method) decide it; a C# generic method whose type parameter no parameter type mentions applies only with explicit type arguments; a C# target-typed `new(..)` constructs the type its position declares (a typed local or field, a property, the enclosing member's return type, a member it is assigned to, or the parameter of the overload a call, construction or `this(..)`/`base(..)` initializer binds, primary constructors and a platform collection field's element type included); a decided overload confirms it, an undecided one lists it unverified `overload-ambiguous` for each candidate type, and arguments that fit none of the pinned class's overloads (a C# extension method of another class) leave the site unverified, never confirmed. C# generic arity is part of a type's identity: `Outcome`, `Outcome<T>` and `Outcome<T1, T2>` are distinct types, so a constructor `new Outcome<T>(..)`, a static call `Outcome.X()` / `Outcome<int>.X()`, a written receiver type and a base list name only the type of that arity (other-arity sites are excluded `generic-arity-mismatch`), and `partial` parts merge only with the same arity. An extension-method call `x.Ext()` is a caller of the extension when the declaring static class is in scope and x's type fits the `this` parameter (directly, through project heritage, or through a type parameter's constraints); a receiver whose ancestry cannot decide it (an external type) stays unverified `extension-receiver-unresolved`, and an applicable instance method of the receiver type wins (also a platform collection's own member, `List<T>.Add(T)`, and `object` members). Type arguments must fit: a `List<string>` or `DbSet<Customer>` receiver never takes `this List<Transformer>`. Type arguments the receiver fixes type the other parameters (`TryAdd<T>(this List<T>, T)` never takes a `string[]`). A C# explicit interface implementation (`IEnumerator IEnumerable.GetEnumerator()`) is never reached by a simple-name or `this.` call, and through an interface-typed receiver only by runtime dispatch. A C# static method is never reached through a value (a chained call's result, `this`, a field or a typed local), and `new X(..)` names the type X even where the enclosing class has a member named X. In C# and Java a type name is no value: a bare argument spelled like a type (a property named like its type) is never the type's caller. In C# and Java a capitalized receiver that names a field or property of the enclosing class (declared in another `partial` part or inherited) is that member, typed in its declaring file's scope. A bare Java/C# call binds a member of the enclosing classes (own or inherited, by class definition, never a same-name class of another package) before a static import (`import static`, `using static`); the import decides it, as caller and callee, only when every class in scope has a resolved project ancestry, and otherwise it stays unverified. Rust receivers are typed from annotations, closure parameters of the called function's `Fn` bounds, `Self::Assoc` returns, tuple `let` patterns, trait-provided methods, and range, tuple, slice, `vec!`, and `Some`/`Ok` values; owned versus `&` impls are told apart by the receiver's reference layer, and at one probe step an inherent method precedes a trait method (`self.key_mut()` inside a trait impl's own `key_mut` calls the inherent `key_mut`), on the caller and callee side; where a bound-conditional impl, a trait not provably in scope or a private inherent method could intervene, the site stays unverified. Raw pointers (`*const T`/`*mut T` parameters and locals, casts `(p as *const T)`, `as_ptr()` results and pointer arithmetic such as `p.add(n)`) reach `impl<T> Tr for *const T` members and never a struct's method. A parameter typed `Self` is the enclosing impl's type. A receiver whose type is a generic parameter (including `self` in a trait's own methods) reaches only implementations of its bound traits (unverified `possible-dispatch` via the trait, external for std traits such as `Iterator`) and never an inherent method or another trait's impl. Crate aliases (`use x as y`, `extern crate x as y`), the package's own name in tests/examples, glob and `pub use` re-export chains, auto-deref wrappers, enum-variant values, unit-struct values (`S.m()`, also through `let w = S;`), tuple-struct and tuple-variant constructors (`T(1).m()`, `E::V(2).m()`, `Self(..)`), struct expressions, and in-scope blanket extension traits (`impl<T: Iterator> Ext for T`) are followed; a blanket-impl member confirms only when its where-clause holds through exactly one visible project impl. `Trait::f(..)` returned from a member of that trait's impl binds that impl; elsewhere it stays one trait family. Invocations of project `macro_rules!` macros are expanded (rules matched over token trees, nested and recursive project macros, hygiene for locals the macro introduces, `$crate`, every `cfg` alternative): functions, impls and calls the expansion generates are indexed at the invocation, marked `[via macro NAME]`. A call written in the invocation keeps its own line and is typed in its expanded context; an unresolved call from the macro's template joins the target's `macro template` family in the compile-time band, and `plan` edits a generated declaration only through the argument or template token that spells it. Macros that only pass their arguments along (logging, `try!`-style matches) keep the invocation's token-tree view. Macros from dependencies are never expanded; project invocations that cannot be expanded are listed in `repo --sections=health` and warned by `deadcode`. Macro names are their own namespace: `name!(...)`, `#[name]` and `#[derive(Name)]` never count as calls or references of a same-named fn (excluded `macro-namespace`), and a fn declared inside another fn's body is visible only there. A C/C++ call spelled `NAME(` where a project `#define NAME` is in effect is the macro's, not a same-named function's; a macro defined under a preprocessor conditional routes the call unverified `macro-namespace`, and a header that both declares the function and defines the macro holds configuration alternatives. A macro whose replacement list calls its own name again (`#define f(x) f(x)`, never re-expanded) passes the call to the function; one that only spells the name without calling it routes unverified `macro-namespace`. Definitions of one name, owner and signature in one file under different `#if` branches (C/C++/C#) or `#[cfg]` attributes (Rust) are one item: a call bound to any of them reaches every variant alike, a type declared once per configuration is one type (receivers typed by either declaration reach its impls), members inside a class body's `#if` blocks are indexed in each branch, and a C++ implicit-this call reaches its own class definition, never a same-named class defined in another file. A Python name bound in one scope only in exclusive branches (`if`/`elif`/`else`, `try`/`except`, `match` cases: `if sys.platform == "win32": def getchar` / `else: def getchar`) is one item too: a call inside one branch reaches that branch's definition, any other call reaches each definition alternative (confirmed for each, since it reaches it whenever that definition exists), and a definition reached only through one branch's import (`try: from ._speedups import f` / `except ImportError: def f`) is listed unverified `configuration-alternative`; `plan` renames every definition alternative and keeps the item's name on an import alternative (`from ._speedups import new as f`). A name a Python module binds only by assignment is that module's value, never a re-export of what its other imports reach: `name = other` and `name = submodule.other` aliases are followed, `loads = registry.loads` with `registry = Registry()` is Registry's bound method (a call of the imported `loads` is no caller of another `loads`; it is an unverified `alias-call` of `Registry.loads`, and `plan` renames the attribute read `registry.loads`, never the variable or its calls), and any other value routes unverified `ambiguous-binding`. An untyped `self.attr.m()` callee is unverified `single-owner` even when one class declares `m`. A `self` attribute a base class types is typed in its subclasses, by the declaring class's file, when no class on the way writes it, declares a member of its name or writes attributes dynamically and no outside base could set it; `def`s under `if`/`try`/`with`/loops in a class body are methods of the class, and `Union[X, None]` names X. A `def` inside a function is visible only in that function (unless the function declares the name `global`), and a nested function's bare name binds what its enclosing functions bind before the module. A structural receiver whose class resolves to a definition reaches the target only through that definition's ancestry: a sibling class sharing an ancestor's name is excluded, not a possible dispatch. A Python string annotation that spells a call (`def cmd(v: "Annotated[int, typer.Argument()]")`) is parsed as the expression the runtime evaluates: its calls are callers and `plan` edits them; an annotation string that does not parse stays a text review item. A same-named class in a header that is only ever included in another branch of the same `#if` chain (`#ifdef _WIN32 #include "client-windows.h" #else #include "client.h"`) is that class in another configuration: calls its own members make are listed unverified `configuration-alternative` for this class's member, and `plan` renames the member in both. `plan` also renames each C++ using-declaration that names the renamed declaration (`using ns::f;`, `using ns::Type;`) when its qualifier resolves to the declaration's namespace or class, and lists it for review when only the qualifier's suffix matches. An invocation of the file's own function-like macro that the parser reads as a declaration (`ERROR_DEF(Base, Name)` in a class body, `LIST(X)` statement lists) is read as the invocation: members its replacement list declares join the class at the invocation line (`generatedByMacro`), and a C++ declaration with no type outside a class body (`TEST(suite, name) { }`) is an invocation, never a function named after the macro. A namespace-scope invocation followed by a body (`TEST(suite, name) { }`, `TEST_CASE("text") { }`) defines a callable named from its arguments (`suite_name`, `text`), marked `generatedByMacro`: calls in the body belong to it, it is an entry point, and `plan` blocks its rename (`macro-generated-name`), as it does for a member a class-body invocation builds by token pasting (`Get##name##String`). A declaration named like a function-like macro in effect where it is written (`int seed_ GUARDED_BY(mu_);` under a conditional macro definition) is that macro's invocation, so `plan` blocks renaming it as a function (`macro-invocation`). A bare call in such a body to a member of a class one of its arguments names (`TEST_F(Fixture, Name)`) is unverified `macro-generated-scope via Fixture`, never excluded. A call spelled in a macro's replacement list binds at each place the macro is invoked (through other macros too): confirmed when every invocation sits where the call reaches the target (a member of the invoking class), unverified `macro-body-context` when only some do. A receiver the replacement list declares with a macro parameter as its type (`T v; v.f();` in `#define M(T)`) takes the class every project invocation passes for that parameter (through other macros too); invocations that disagree, or one that cannot be read, leave its calls unverified. A C++ class member hides every base member of its name unless a `using Base::name;` in the class brings them in (default arguments count in the arity); `v[k].m()` on a class object takes the class its `operator[]` returns when every `operator[]` it declares returns that one class; `T v(X());` in a block is an object initialized by the call `X()` unless `X` is a type. A C++ receiver whose class declares several overloads of the name is never a caller of an unrelated class's member, even when the arguments cannot choose among the overloads. A C++ receiver declared with an alias (`Value v;`) has the class the alias names where it is written: a same-name alias in a namespace the site cannot see does not count. A C++ implicit-this call names the member the enclosing class's lookup finds; an override of it in a subclass is reached only by runtime dispatch, as an unverified `possible-dispatch` candidate when the member is virtual and not at all otherwise. A call in a header to a `static` function the header declares binds each including file's own definition: unverified `translation-unit-binding`. Macros another header of the include closure defines are read by the recovery like the file's own when every project definition of the name agrees: decoration (`SPDLOG_INLINE`), removable statement (`TRY` / `CATCH` defined as `try` / a `catch` handler or nothing) and attribute or return-type macros (`ATTR(3)` before a member); `LUA_API int (lua_gettop)(..)` declares `lua_gettop`. A C++ `friend` function declared or defined in a class body is a function of the enclosing namespace, not a member (argument-dependent calls reach it, its body sees the class's static members, `plan` renames the friend declaration with the definition), and a member of a nested class reaches the enclosing class's members by bare name. In a C/C++ file too large for the configuration sweep, a conditional the parser could not place (in a member-initializer list, an expression, template arguments) or whose branches split a block's braces is read in one configuration. Members a class declares only in a conditional branch the selected configuration skips are indexed too. Rust `crate::f()`, `super::f()`, `self::m::f()` and child-module paths resolve through the module tree (`mod` files in both layouts, `#[path]`, inline modules) and confirm as `module-owned`; a type path (`crate::tests::memchr::Runner::new()`) names the type that module declares, and a type a glob import (`use super::*`) brings in is that module's type; a bare call never resolves to a struct field. A local value named like a function (`let f = g; f()`, C# delegates, C++ lambdas and function pointers) is the callee. A Go import that writes no name binds a project package by its package clause (`.../internal/helpers` declaring `package utils` is `utils.F()`); an outside package's name is only the one the Go tools suggest (`github.com/goccy/go-json` is `json`, `k8s.io/api/core/v1` is `v1`), so a qualifier the file neither declares nor imports by that name stays unverified `package-qualifier`, never a confirmed or renamed project call, and `plan` keeps a call it cannot type as a review item in a file of another build configuration (`//go:build`, `_linux.go`) than the renamed declaration's. A type name written at a call site (a constructor, `Type::f()` / `Type.f()`, an annotated or constructed receiver, a declared field type, a producer's return type) denotes what that file binds it to: when it names an external type that shares its name with a project type (`use std::fs::File`, `import java.io.File`, `from pathlib import Path`, `import { Server } from 'http'`, `using F = System.IO.File`, `std::mutex`), members of the project type are excluded (`external-receiver`), and a project impl on the external type itself stays unverified `possible-dispatch`. A type declared in a function body (Python, Java, JS/TS, Rust, C++) is visible only in its block: a same-name type outside never captures its references or members, and inside the block it shadows the outer one. A module-level `Alias = Box` (Python: bound once, or on every module-level `if`/`try` path to the same class; JS/TS: `const`, or a `let`/`var` never assigned again) names Box in annotations and constructor calls, also when imported, and `Alias(..)` / `new Alias(..)` is a caller of the class; an alias whose paths name different classes stays `possible-dispatch`. In JS/TS, Python and Rust a type's identity is its module: `Shared::init()` / `Shared.init()` names the `Shared` its own module declares or imports, never a same-name type of a sibling module (excluded `path-type-mismatch`). Unimported Java and C# names follow the language's scoping: the same package or an enclosing namespace, then on-demand imports with the implicit `java.lang`, or `using` directives, global usings and project-file `<Using>` items (`Static="true"` items are `global using static`; `Directory.Build.props` above an indexed sub-project count up to the repository root). A `using` directive written inside a namespace resolves from that namespace outward (`namespace A.B; using Internal;` imports `A.Internal` when the project declares it), and nested `namespace` blocks name their members by the full path; a project type not in scope there is not the named type, and a project on-demand import beside a `java.lang` type of that name stays unverified. A package-qualified Java type (`p.Node pn`) names that package's type. A type-qualified call (`Util.isEmpty(s)`) and a return type (`A.builder().get()`) name the class the name denotes where it is written, before any overload fit: a same-name class of another package, or another class's nested `Builder`, never lends its better-fitting overload or member. A Java/C# local's declared type is its static receiver type: `Shape s = new Circle(); s.area()` is a caller of `Shape.area` and a `possible-dispatch` candidate of each implementation, except those the constructed type cannot reach when the local is never reassigned. A field initializer types only its own class's field, and only a field that cannot be reassigned. `super.m()` binds the superclass member, never the override; in an enum constant's body it is the enum's member, and a bare call in an anonymous class or enum-constant body looks up that body's supertype first (a method the body declares itself is its own). A Java member of a nested class is not in the outer class's simple-name scope, and a constructor callee is the class the name denotes where it is written (a single-type import before a same-package class's nested namesake). Values of std containers, slices, arrays (`[a, b].iter()`), `str`, `Option`/`Result` and std iterator adaptors never reach a method owned by a project struct or enum. A receiver behind a std deref wrapper (`Box`, `Rc`, `Arc`, `ManuallyDrop`, `LazyLock`, `Ref`/`RefMut` and lock guards, `Pin`, `Cow`; annotated, constructed with `W::new(..)` or a `LazyLock` static) reaches its target type's methods (a guard returned by a call such as `cell.borrow()` or `m.lock().unwrap()` is not typed, so its calls stay unverified); a name the wrapper itself may supply (`clone`, `as_ref`, std trait methods, project impls on the wrapper) stays unverified `autoref-dispatch`, and `rc.clone()` is the wrapper's. A local bound from a producer returning `Self` or a value is owned and `-> &T` a reference, which selects between owned and `&` impls. An untyped `let` hides an outer binding's type, and calls in the item bodies of an item-position macro (`quickcheck! { fn p(..) { .. } }`, also when a project macro emits it) are read from the items, with their functions' locals typed. A Rust `const`/`static` item types its method receivers by its declared type (`FLAGS.iter()`; never a `static mut`), and a local destructured from `self` (`let Self { iter, .. } = self;`) is that field. Method probing follows the receiver's reference layer: a `self` receiver that reaches the member only after an autoref or deref step (a `&self` trait method called in a `&mut self` method) may be taken by an earlier impl, such as std's `impl AsRef<U> for &mut T`, so the site stays unverified `autoref-dispatch` unless the trait is the project's own and no impl for a reference type can intervene. A C# `using static T` imports only the members T itself declares, never inherited ones. A C# target-typed `new(..)` in a collection initializer or collection expression (`new List<T> { new(..) }`, `T[] a = [new(..)]`, dictionary `{ new(..), v }` pairs) constructs the element type, and an argument of a generic receiver's method (`Box<Item> b; b.Put(new(..))`) the type argument it binds. A using alias whose target starts with an alias of an enclosing scope resolves through it; a type written with an `extern alias` qualifier (`Old::Lib.Type`) is never resolved to a project type (its receivers stay unverified, `plan` lists its tokens for review). An extension call on a project type that derives from an outside class (other than `object`, the modelled collections and the type the extension is declared for) stays unverified, since an inherited instance member may take it. A receiver typed by a type parameter converts only to its constraints. An explicit interface implementation never types a member access on the class. A C# static member path from a type (`Pool.Shared.Get()`, where `Pool` is no member of the enclosing class) is typed from that type's declared member, and a chained call (`Get().Initialize<T>()`) is typed from its producer or stays unverified, never read as a type name. A Java enum implements its interfaces like a class (renames reach the enum's member and enum-constant bodies), and serialization callbacks of an enum are ordinary members (enum constants serialize by name). Impls of one generic trait for one type (`impl From<A> for Vec<u8>` beside `impl From<B> for Vec<u8>`) are selected by argument type (declared parameters and locals, struct literals, literals, range-indexed slices, locals bound from a `Type::ctor(..)` whose project definitions return the type): another argument type excludes the impl (`overload-mismatch`), an undecided argument stays `overload-ambiguous`, and an undecided argument never confirms the only project impl of an out-of-project trait such as `From`, whose other impls UCN cannot see. A bare JS/TS name never reaches a function assigned as an object member (`req.setTimeout = () => {}`, `exports.f = function () {}`, prototype and object-literal members) unless the object is the global object (`globalThis`, `window`, `self`, `global`) or the call is inside the function's own named expression; a member of an object that may be the global object (a parameter, a plain function's `this`) stays unverified `member-object-unresolved`; `var global = globalThis` names the global object too. A bare call of a global assigned in another file (`globalThis.f = ..` in a test setup module) is unverified `possible-dispatch` via `global f — assigned in project`, one runtime family per global. A JS/TS name destructured from an object (`const { run } = api`, `({ run }: Api) => run()`) reads that member: its calls are member calls on the source, confirmed when the source is typed and unverified otherwise, and a same-name free function is never their target. A JS file's extensionless import resolves a TS source; a bare specifier naming a package of the repository (workspaces, `@scope/core`) resolves to that package's source (its `exports`/`source` entries, else `src/index`), and one whose manifest names only build output absent from the checkout stays unverified, never external. An import chain that reaches the target through any number of re-exports and renames (`export { a as b }`, then `import { b as c }`) is import evidence. This is portable AST analysis, not a compiler build; macros, templates, generated code, reflection, and external dependency semantics can remain unverified.

`repo` ranks HOT production functions by confirmed production callers, exactly
(test call sites are not scanned for it). Each function appears once: overload
signatures and C/C++ prototypes count with their implementation. Exact ranking
has a work budget (call records examined); only a very large repository exceeds
it, and then the header says the ranking is approximate while every shown count
stays exact; narrow with `--in=<dir>` for an exact list.
`repo --sections=stats --hot` ranks by all callers under a larger budget,
disclosed the same way.

`repo` readiness is task-specific. Its headline is navigation readiness;
refactor, deletion, semantic recall, and the sampled evidence mix are separate
dimensions. The confirmed/unverified percentage is a classification profile,
not an accuracy grade.

## Interpret evidence correctly

For caller-bearing `show`, `impact`, `trace`, `tests`, and `check` views:

- `CONFIRMED` has binding, receiver, import, or ownership evidence for the pinned target.
- `UNVERIFIED` is a possible target with insufficient identity evidence. Review it before a breaking change. When same-name definitions cause the ambiguity, `show` lists their stable handles once above the sites so the competing targets are explicit.
- `ACCOUNT` partitions observed literal-name lines into confirmed, unverified, non-call, excluded, and unresolved buckets. In mixed-language repositories it also counts occurrences in unsupported-language source files.
- `CONTRACT` states the scope and completeness of that observed-text partition. When unsupported-language files contain the name, it says so explicitly and the partition-complete claim is limited to supported languages.
- `WARNING` identifies unreadable, unparsed, or partially indexed files, and lists unsupported-language occurrence sites (file:line plus the line text) so nothing grep would show is hidden. `usages` and `tests` carry the same disclosure as a note.
- `FILTERED` means query options hid evidence.

When the selected definition is a property/getter/setter, `impact` adds a
separate `PROPERTY ACCESS SITES` band. Confirmed reads/writes have receiver
identity; matching attribute syntax with an unresolved receiver stays
unverified. These are change dependencies, not fabricated caller edges, so
the caller `ACCOUNT` remains a call-shaped partition. Reads and writes include
access kind and token column; getter/setter handles describe the same property.
Unambiguous inherited properties share that owner evidence.

When the selected definition is a type, interface, enum, trait, or record,
`impact` adds a `TYPE REFERENCE SITES` band: annotation and reference sites
confirmed by an import link to the definition's file (or package scope in
Go/Java), the rest visible as unverified with a reason. `DEPENDENCY SITES`
counts them; `CALL SITES` stays call-shaped.

Target-less `impact` and `check` diff the working tree against `HEAD` AND
include untracked, non-ignored source files as whole-file additions, so new
modules are checked before `git add`. `--staged` keeps its index-only meaning.
The changed-path note also counts untracked documentation and configuration.
Classes, interfaces, types, and fields appear in separate declaration bands
with their dependency sites. Modified/deleted declarations block `check` until
reviewed with the language toolchain: arity checks cannot validate shape or
inheritance compatibility.

An observed-text zero is not semantic zero or safe-delete proof. Numeric evidence values are ordinal ranking weights, not probabilities.

When a plain name selects more than one definition, action-oriented commands
(`impact`, `tests`, `check`, and `plan`) carry the same ambiguity warning as
`show`/`source`/`trace`. Prefer a stable handle; never treat the auto-selected
definition as an implicit repository-wide target.

## Choose a command

| Decision | Command |
|---|---|
| Orient or diagnose a repository | `ucn repo [--sections=files,stats,health] [--deep]` |
| Understand one symbol | `ucn show <handle> [--sections=...]` |
| Locate definitions or types | `ucn find <name> [--type=type]` |
| Inspect literal-name occurrence kinds | `ucn usages <name>` |
| Search literal text, explicit regex, or AST structure | `ucn search [term] [--regex] [--type=...]` |
| Extract exact source | `ucn source <handle\|file:range>` |
| Follow calls down or up | `ucn trace <handle> --direction=callees\|callers` |
| Find paths to roots | `ucn trace <handle> --direction=callers --to=entrypoints` |
| Assess direct or Git-diff impact | `ucn impact [handle]` |
| Select direct or transitive tests | `ucn tests <handle> [--depth=N]` |
| Validate a symbol or pending diff | `ucn check [handle]` |
| Preview a refactor | `ucn plan <handle> --rename-to=X` |
| Inspect file dependencies | `ucn deps <file> [--direction=...]` |
| Find circular imports | `ucn deps --cycles` (project-wide; no file target) |
| Inspect public surface | `ucn api [file]` |
| Review entry points or HTTP routes | `ucn entrypoints`; `ucn endpoints` |
| Generate review candidates | `ucn deadcode`; `ucn audit-async` |
| Resolve runtime frames | `ucn stacktrace <text>` |

## In a shell, next to grep

`ucn` is a Bash tool as much as an MCP tool. Two flags make it compose like
`grep -n` so a shell-first agent can keep its reflexes and still get symbol
answers:

```bash
ucn find handleRequest --lines            # path:line:signature   # kind
ucn show handleRequest --lines            # callers as path:line:text; unverified ones end in "\t# unverified: <reason>"
ucn show handleRequest --lines --sections=callees
ucn usages handleRequest --lines          # every literal-name occurrence; non-call kinds tagged "# import" / "# definition"
ucn search 'retry(' --lines               # grep -n output, code-aware scope
ucn impact handleRequest --lines
ucn source handleRequest --raw            # the code and nothing else, ready for an exact-string edit
ucn source src/server.js:40-80 --raw
```

Records go to stdout; the `ACCOUNT` / `CONTRACT` lines, notes, and the
same-name disambiguation go to stderr prefixed `# ` (MCP keeps them in the one
text block, and `--raw` appends its note as one trailing `# ` line there).
`usages --lines` emits one record per source line, combining occurrence kinds
and disclosing repeated occurrences (including JSX open/close tags). JSON keeps
the individual occurrence records. Definition handles start at decorators when
present, while usages point at token lines (`nameLine` identifies the declaration
token when it differs from `startLine`). Structural `search --unused` keeps its
safety note and decorator tags in shell output; runtime registrations can appear
and zero call edges do not prove a symbol is safe to delete.
`--lines` lists the whole band without default row/character caps, so pipe through
`grep -v '# unverified'` for the confirmed tier. To count distinct source lines
per file, use `cut -d: -f1,2 | sort -u | cut -d: -f1 | sort | uniq -c`;
JSON usage records can count a source line more than once.
Nothing to list prints nothing and exits 1, grep's
contract; errors exit 2. Explicit `--top`/`--limit` still apply and disclose
omissions. `show --lines` accepts only callers/callees sections; target-less
`impact --lines` lists Git-diff callers with per-target accounting. Closing a
pipe with `head` is supported. `source --raw` extracts full large classes too;
`--max-lines` truncation is disclosed on stderr. An explicit `--max-chars`
fails before stdout if the complete shell output exceeds it. Unusual path
characters (backslash/tab/CR/LF) are escaped; use JSON for exact filenames.
`trace` and `tests` scripting uses `--json`. Use `grep` for literals, messages, configuration, and unsupported
languages; use `ucn ... --lines` when the question is a symbol, a caller, or a
definition, and `--raw` when the next step is an edit.

Command errors exit 2 in ordinary text mode as well. CLI JSON preserves its
own contract: successful empty results exit 0; command errors exit 1 with
`meta.ok: false` and an `error` field. A target-less `check` exits 1 when
`TRUST` is `BLOCKED`, 0 otherwise; a check that could not run exits 2.
An exception inside UCN is an internal error, not a refusal: its message
starts `Internal error:` on every surface (CLI text, MCP, interactive) and CLI
JSON adds `meta.internalError: true`. It says nothing about the code; rerun
with a narrower target or report it. Exit codes are those of any command
error.

## Breaking-change protocol

1. Pin the exact definition with `find`.
2. Run `impact`; review every unverified, excluded, filtered, and warning entry.
3. Run `trace --direction=callers` for transitive behavioral impact.
4. Run `tests --depth=3`; treat paths without static test links as test-planning signals, not runtime coverage proof.
5. Make the change.
6. Run `check <handle>`, the relevant compiler/type checker, and selected tests.
7. Run target-less `check` to reconcile the repository diff.

## Deletion protocol

Treat `deadcode` as a candidate generator. Before deletion, inspect `usages`, `impact`, `entrypoints`, `api`, and `repo --sections=health --deep`; then corroborate with the compiler/type checker and tests. Computed dispatch such as `handlers[key]()` is a reported blind spot; registry members reached by a modeled computed receiver are withheld. Statically named reflection such as `getattr(obj, "run")` is positive liveness evidence, so every matching member spelling is withheld. A reflective name built from literal fragments around a runtime part (`getattr(self, "_get_%s_perms" % src)`, f-strings, `.format`, `"get" + name` in `getMethod`, `MethodByName(fmt.Sprintf(...))`, `obj["on" + evt]`) is a pattern: members it can spell on a receiver that may hold their class are withheld and counted per pattern, and `show`/`impact`/`plan` list the site as an unverified `reflection-pattern` caller. `eval(name)`/`globals()[name]` reach only their own module's top-level names. Reflection with no specific literal part is counted and warned because it cannot be attributed to one member. Members the runtime or compiler invokes by name are hidden as runtime callbacks: Python dunders and Enum hooks (`_generate_next_value_`, `_missing_`) on Enum subclasses, Java serialization callbacks and `serialVersionUID` on Serializable types (also when written `implements java.io.Serializable` or inherited) and, as possible members with the protocol's signature, on classes that derive from another out-of-project type (`extends IOException`, `extends ArrayList`; `plan` keeps their edits and lists the definition for review), C# pattern members (`GetEnumerator`, `GetAwaiter`, `Deconstruct`), C# compiler-required types the project declares for a feature it uses (`System.Runtime.CompilerServices.IsExternalInit` with `init` accessors or positional records, `RequiredMemberAttribute` with `required` members, `System.Index`/`Range` with `^i`/`a..b`; unused when the feature is absent), JS `toJSON`/`then`/`[Symbol.*]`, C++ `begin`/`end`. Unknown decorators/annotations and member-assigned event handlers are also withheld by default because they can be the registration itself. Members of a class deriving from an outside base (underscore hooks such as a stream's `_transform` included) and members of an object literal declared with an outside type (`ProxyHandler` traps) may be called by that outside code and are hidden as external-contract surface. In C/C++, names an expanded macro invocation produces are live; a token-pasting macro that is never seen expanded withholds every candidate its paste pattern could spell, and invocations that cannot be expanded are warned as `token-pasting macro dispatch` (also in `repo --sections=health --deep`). Rust definitions generated by project `macro_rules!` invocations are never candidates, calls their expansions make count as uses, and unexpandable invocations are warned. All remaining candidates are still review-only. Never delete solely from `deadcode` or an observed-text-zero result.

`usages` includes comment/string/docstring occurrences and non-code text
(JSX children, HTML markup and attributes) in an `OTHER TEXT` section unless
`--code-only` is set, and test files unless `--exclude-tests` is set (which
states how many test-file usages it hid), so it lists every line the
`ACCOUNT` counts. This is a
literal-name inventory, not exact target binding. Identifier boundaries are
Unicode-aware and match `grep -w`: `hit` never matches inside `hitΔ`, while
`$` is a boundary (`buy${...}`, `$fail`, `ws$close()` all count).

Aliased and qualified calls resolve in every language: Rust `use m::f as g; g()`
is a caller of `f` (listed as a beyond-text caller, since the line holds no
target token); Java `pkg.Type.method()` and C# `Ns.Type.Method()` /
`using T = Ns.Type; T.Method()` pick the type the qualifier names when several
same-name types exist. A qualifier the resolver cannot place stays visible as
`method-ambiguous`, never confirmed by first-definition order.
Python qualified bases and receiver annotations follow the imported module,
including aliased submodules and nested package paths. Inherited calls keep
their declaring class; a shadowed or rebound module stays unverified, and a
base-typed receiver can still dispatch to a subclass override.

Type aliases and import renames are the same type on both the caller and callee
side: a receiver annotated with Go `type IntFlag = FlagBase[int]`, TS
`import { Box as B }`, Rust `use crate::Wrap as W` or C# `using IntBox =
G.Box<int>` reaches the original type's methods; a Go alias of an external type
(`type Ctx = context.Context`) is not a same-named project type. Explicit type
arguments are call syntax (Go `f[T](x)` / `pkg.F[T](x)`, Rust `f::<T>(x)`,
TS/C#/C++ `f<T>(x)` and `obj.template f<T>()`, Java `this.<T>f(x)`), and a Go
instantiated value (`id[int]`) or package-qualified value (`pkg.F` passed as an
argument) is a reference to that function; `pkg.F()` names the package's
function (or function-valued variable), never a same-named method. A Go
package-level variable has one static type across its package: `var
CommandLine = NewFlagSet(..)` types `CommandLine.VarP(..)` in every file of
the package, before or after the declaration, and `pkg.CommandLine.VarP(..)`
in importers. A composite literal `T{...}` names
the type, never a same-named method, and a type declared inside a function body
is visible only in its block (Go, JS/TS, Python, Java, Rust): a Python field
assigned a function-local class (`self.channel = Channel()`) names that class,
not a same-named module class. A bare name bound by an import resolves through
that import only, never through another import whose package re-exports a
same-named symbol. A one-hop local alias of a typed field, parameter or local
(`config = self.config; config.load()`, `const c = this.config`, `var c =
this.config`, `c := s.config`, `let c = &self.config`) receives like the
aliased expression when the local is bound once and never reassigned.

`endpoints` labels test routes and requests with `[test]` (JSON `isTest`).
Use `--exclude-tests` for a production inventory or `--in=api/` for a directory.

Route tables count too: Django URLconfs (`path`/`re_path`/`include`, composed
from `ROOT_URLCONF`), DRF routers, Starlette `Route`/`Mount`/`Host` lists,
Flask `add_url_rule`, aiohttp `add_routes`/`router.add_*`. Methods come from
the view (`require_*` decorators, class-view handlers, viewset actions); an
unresolved view serves `ALL`. Tags: `[regex]` (a `re_path` shown in path
form, an unconvertible part as `{?...}`), `[drf-router]`, `[static]`, and
`[include]`/`[mount]` for a target that cannot be resolved (shown as
`prefix/{?target}`, matched only as uncertain). Django composes as Django
does: an include prefix and the included pattern are concatenated as written
(`path("api", include(...))` + `"items/"` serves `/apiitems/`); a `re_path`
without `^` or, for a view, without `$` matches any text there, shown as
`{?*}` (matched as a catch-all); a regex group that can match `/` is written `<path:name>`.

`endpoints` recognizes client receivers by evidence (a receiver typed to an
HTTP client class, or bound to a pytest fixture that constructs one), not only
by name. Request-configuration calls (`request(OpenAPI, { method, url })`,
`client.post({ url })`, `session.request(method=..., url=...)`, generated
OpenAPI SDKs) count as clients when the callee's definition reaches an HTTP
call (fetch, axios, requests, ...). Request-shaped calls on an unrecognized
receiver or an unproven helper are listed under `Possible client requests`
(JSON `uncertainRequests`, with the reason), counted in `meta`, never in the
inventory.

A request through an in-process test client built from an app
(`TestClient(app)`, a fixture's client, `app.test_client()`,
`AsyncClient(transport=ASGITransport(app=app))`) bridges only to routes of
that app or mounted under it; an app declared as a function or class serves
the request itself and matches no route. A supertest client
(`request(app).get('/x')`, `request.agent(app)`, a client bound to a local; the
name bound to the `supertest` module, whatever it is called) is one too, its
app followed through imports and `app.callback()` / `http.createServer(app)`;
`request(this.app)` in a mocha test or hook takes the app its suite's
`before`/`beforeEach` hook stores on `this` (the nearest suite assigning it,
which writes it nowhere else and registers nothing through `this.app`). When the app does not resolve, every path match stays, marked `[unscoped]`
(JSON `unscoped: true`). A HEAD request
matches a GET route where the framework serves HEAD with GET (Starlette,
Flask, Express).

Route paths include router mount prefixes composed from the code: FastAPI
`include_router(prefix=)`, Flask `register_blueprint(url_prefix=)`, Express
`use`, Hono `route`/`basePath`, Fastify `register({ prefix })`, gin/echo
`Group`, chi `Route`/`Mount`, gorilla `PathPrefix().Subrouter()`,
`http.StripPrefix`, Spring/JAX-RS class mappings, ASP.NET `[Route]` with
`[controller]`/`[action]` and `MapGroup`, axum `nest`, actix `scope`. Each
framework joins as it does at runtime: echo groups and koa-router prefixes
concatenate (`Group("/api")` + `"items"` is `/apiitems`), Fastify route URLs
concatenate to the plugin prefix (one shared `/`, a `/` route serves at the
prefix), the others join with one `/`. The framework label is the router
module the file imports (or the project's own package when the project is
that framework); without one it is the family label (`express` for JS/TS,
`go-http` for Go). The handler is the registration's handler argument (the
last one; echo's first), `<anonymous>` for an inline function; an axum
`.route(path, get(a).post(b))` lists one route per method. Catch-all
parameters (`<path:x>`, `{x:path}`, `{*x}`, `*name`, a bare `*` in JS/Go
routers, a `{x:regex}` that matches `/`) span segments (`**` in
`normalizedPath`); a `:` in a Starlette route or a client URL is text. Go
`http.NewRequest(method, url)` counts with its own method and URL; a URL
with no scheme and host is served in process and bridges only to routes its
own test function registers. Prefix
expressions are folded (constants, f-strings, concatenation, a settings
instance's field default). A prefix that cannot be proven appears as a
`{?expr}` segment and matches clients only as `UNCERTAIN`; a router mounted
twice lists both paths. `search` treats its term literally by default; pass `--regex` only
when regular-expression semantics are intended. Ordinary regex patterns run
through an RE2-compatible linear-time engine; unsafe nested repetition is
rejected, and unsupported advanced syntax should be handed to ripgrep.

`find` activity counts are definition-pinned: confirmed plus visible unverified
call candidates. Calls proved to belong to another same-name target are
disclosed separately and excluded from the activity total.
Broad queries rank candidates by inexpensive approximate usage totals before
applying the row limit; only returned definitions receive caller adjudication.
The selection note discloses that approximation. `find`, text `search`,
`deadcode`, `api`, and `repo --sections=files` default to at most 500 results
(structural `search`: 50). `find` text shows the top 5 results in detail and
counts the rest, while JSON returns up to 500; `--limit=N` raises both. Use an
explicit `--limit=N` to request more; `usages` and `--lines` have no default
row cap.

Automatic test filtering follows the language's conventions: Python `spec.py`
and `chart_spec.py` are production paths; `test_*.py`, `*_test.py`, and test
directories remain test paths. Structural search discloses hidden test files,
including empty results; `--include-tests` gives the full indexed inventory.
Explicit `--exclude=spec` still means the requested path exclusion.

Public JSON source `file` fields are relative to `meta.pathBase` (the absolute
project root). Dependency edge paths use the same base. Both absolute and
relative indexed-file handles are accepted. Definition handles retain their
decorator span; use `nameLine` for the name token rather than joining usages
to a handle's start line.

Callable references passed to another function remain visible when a project
method or function could be their target. An ordinary attribute read with no
callable member candidate stays a non-call reference in ACCOUNT and `usages`.
The caller model includes callback dependencies; it does not prove that the
receiving function invokes every passed callable.

`audit-async` checks recognized async producers. An unawaited coroutine or
promise is a finding only when it is lost (a bare statement, or stored in a
local that is never read) or used as if resolved (member access, arithmetic,
conditions, destructuring); a value passed as an argument, placed in a
collection, generator or spread, returned, chosen by a ternary/logical
expression, or assigned to a field, property or outer variable flows on and is
not flagged. In JS/TS/HTML it also checks
captured promises used in arithmetic, conditions, or resolved-value member
access within the same lexical scope. In Python, coroutine calls in sync
functions count too, and a local assigned straight from a coroutine call is
flagged where it is used as the result while every value it can hold there is
that coroutine (`stored-coroutine-used-as-value`); identity tests, comparison
with None, string formatting and uses in nested functions are not. Awaiting,
returning, promise handlers, reassignment, and shadowed bindings are
distinguished. Producers are classified
by what a call returns: async generators/iterators (consumed by `async for`,
`for await`, `await foreach`) and `@asynccontextmanager` factories (entered by
`async with`) are flagged only when the call is discarded; C# `async void` is
never flagged; calls to async functions behind an unrecognized decorator are
counted as not audited. Bare calls resolve through lexical scope, then
import identity: the imported module's own definitions (Python star imports
through `__all__` or public names) or an engine-established target. A same-name
function elsewhere in the project is not a producer. A JS/TS import is read
through re-exports (`export { default } from`, `export * from`) to the
function its module declares, anonymous `export default async` functions
included. JS/TS and Python member calls are audited when the engine types the
receiver (`const s = new Svc(); s.fetchAll()`, an annotation, a field,
`this`/`self`) and confirms the async callee; other member calls are not. C#
member calls (`s.SaveAsync()`, `_svc.SaveAsync()`, `this.Local()`,
`p?.SaveAsync()`) are audited through the receiver's type and its project
ancestors; a typed receiver that owns none of the async definitions is not.
Rust:
calling an `async fn`, a fn returning `impl Future`/`Pin<Box<dyn Future>>`/
`BoxFuture` or a future type alias, or a local `|| async {..}` closure creates a
lazy future, in sync functions too; it is flagged when discarded, dropped by
`let _ =`, bound to a local never used, or used as its Output (`?`, operators,
a project method of the Output type). Awaiting, passing (spawn, `join!`,
`select!`, `block_on`), storing in a field or collection, `Box::pin` and
returning flow on. Only engine-confirmed call targets are audited; futures of a
type implementing `Future` or behind a non-builtin attribute (`#[tokio::main]`)
are counted as not audited. It is a bounded AST audit, not a compiler-wide
proof that every missing await has been found.

For `plan --rename-to`, the selected declaration is only the starting point.
When the index proves the relationship, the rename unit closes over
overload/signature groups, base and override declarations across the whole
resolved hierarchy (through intermediate classes that do not redeclare the
member; same-signature slot only where overloads exist, with the type
arguments of generic base clauses substituted, so `Fmt : Visitor<TextWriter,
bool>` overrides `Visit(TState, ..)` as `Visit(TextWriter, ..)`), overrides
in anonymous classes (`new Listener<String>() { .. }`) and JS/TS class
expressions, declared
`implements` slots and interface-typed object literals, Rust trait slots
(generic traits included; including `macro_rules!` template tokens it can
attribute), configuration alternatives (Rust `#[cfg]`, C/C++/C# `#if`
definitions of the same item), Python alternative bindings of one scope
variable (version-conditional `def`/assignment, try/except import fallbacks,
class-body aliases such as `close = release`, `@prop.setter`), Go interface
slots and their satisfiers (complete method sets with promoted methods, plus
conversions of a type to an interface), exact call and value-reference tokens
(C# method groups such as `new(Build, 4)`, `x += OnChanged`, `.Select(Build)`,
`this.Build` and `nameof(Build)` by C# simple-name lookup, a method group of
overloads or one a local of that name may hide being a review item; Java
`this::m`/`super::m` by the enclosing class; a local function only in its
block, never a same-name member access; a C# explicit interface
implementation only with its interface's slot, and a `protected`, `private`
or `internal` member never with an interface slot),
imports/exports, Python `__all__` strings, and module-attribute references.
A member that fills a slot of a contract outside the project cannot be renamed
in project code: an external trait impl (also a trait name bound to an
external trait under some `cfg`), an override marker whose overridden member
is not located in the project, a language protocol member (Python dunders), a compiler-required type (C# `IsExternalInit`), a declaration in a
standard-library namespace (a C# `System.*` polyfill, a C++ `namespace std`
specialization) or a root-supertype
member (`toString`, `ToString`) sets `contract.blocked` and withholds every
edit. When the owner only declares outside supertypes (including a Java
serialization member of a class deriving from a JDK type that may be
Serializable, and JS/TS and Python members named with a leading `_`, such as
a stream subclass's `_transform`; only language-private names, `#x`, TS
`private` and Python `__x`, override nothing), a member belongs to an object
literal declared with an outside type (`const traps: ProxyHandler<T> = {..}`),
or a Go type is used as
an outside or open interface (including a value passed to an out-of-project
function such as `sort.Sort(x.(*T))` or stored in an out-of-project struct
field, for exported methods), the edits stay but the definition requires
review and each contract site is listed with `contractDependency`. Macro
template tokens it cannot attribute are listed with `templateDependency`.
Type renames cover TypeScript namespaces, Java annotation types (`@interface`)
and Rust unions; a C# written arity (`typeof(Outcome<>)`, `Outcome<,>`,
`nameof(Outcome)`) selects the type of that arity. Renaming a Java annotation
element edits its `name = value` keys, and a single-element use
(`@Marker("x")`, which sets `value`) becomes `@Marker(renamed = "x")`; one
whose annotation type does not resolve stays unverified `annotation-shorthand`.
A reference is edited where the language's scoping proves it names the
renamed binding (inside function bodies, on decorator lines, in default
values; a local binding of the name is left alone, a local import is a review
item), and each same-name call on a line is decided by its own call node. A
decorator that replaces the callable may bind it by name (pytest fixtures,
CLI commands, endpoints, registries keyed by `__name__`, a TS member decorator
reading the property key): the definition is a review item
(`decorator-name-binding`) unless every decorator is a standard
name-preserving one (`property`, `staticmethod`, `functools.wraps`,
`lru_cache`, `contextmanager`, ...), the member's own property accessor, or a
project decorator that only calls, returns or wraps the function. A pytest
fixture is resolved the way pytest resolves it (class fixtures, the module,
then `conftest.py` files up the directory tree): the test and fixture
parameters that receive it are renamed with it, with the uses that bind them;
a parametrized name, a module pytest does not collect by default, a module or
class that binds the name otherwise, and requests of a fixture defined outside
`conftest.py` and test modules (a plugin) are review items. A fixture named by
`name=` keeps its parameters.
Exact token/expression spans keep a foreign same-named occurrence on the same
line unchanged; a definition line renames only the declaration's own name,
never a same-spelled parameter, named result, or type. Same-file member
references rename exactly the `this.m`/`self.m` tokens of the member's own
class (`this.m = this.m.bind(this)` changes both; `{ m: this.m }` keeps its
key); in Java and Rust a paren-less `this.m` is a field and stays. A bound or
stored method on a typed receiver (`obj.m.bind(obj)`, `const f = obj.m`) is
edited like a call. A name destructured from the member (`const { run } =
api; run()`) is renamed at the pattern key and keeps its local binding
(`{ renamed: run }`). An object-literal shorthand of the renamed binding keeps
its key (`{ gen }` becomes `{ gen: renamed }`), except in a module's export
object (`module.exports = { gen }`), whose key is the export name the rename
follows into every importer. A getter and a setter of one property (class or
object literal) are renamed together, with `this.x` reads and writes in the
owner and destructuring keys read from `this`; other receivers are review
items when untyped. An import binds its local name only: `import { g as f }`
and `const f = require('m').g` keep `f` and its uses, and edit `g` only when
the module binds the renamed definition. A C# member
rename edits the `cref` attributes that resolve to it (`<see cref="M"/>`,
`cref="Type.M(int)"`) and lists the ones it cannot resolve for review. Imports and
exports are edited only for module-level symbols they bind, never for a method
or field, and an import only when the module it imports from binds the renamed
definition. An ancestor that does not resolve to one project class is listed
for review. The plan's ACCOUNT counts the sites it lists: edited calls are
confirmed and listed candidates unverified, whichever slot member's sweep
found them. Go examples bound by name follow the rename (`editKind:
"example"`): `Example<Type>_<Method>[_suffix]` and `Example<Ident>[_suffix]`
in `_test.go` files, bound the way `go vet` binds them (the example's own
package, else the packages it imports; members promoted through embedding
count); an example whose name could bind to two imported packages is a
review item. A finding that holds at many sites (one type used as an outside
interface everywhere, one comment dependency) is stated once with its site
list.
Renaming a type (class, struct, interface, trait, enum, record, union, type
alias, typedef) edits every token that names it, each resolved by the
language's own name lookup: base/implements clauses, field, parameter,
return, local and generic-argument types, casts and type tests, static
qualifiers (`Widget.X`, `Widget::f`), constructor and destructor names and
C++ member initializers, construction expressions and struct literals,
qualified spellings (`pkg.Widget`, `app::Widget`, `crate::m::Widget`),
imports, re-exports and `use` trees (an import alias keeps its local name),
Python forward-reference strings (`"Widget"`, `Union["Widget"]`, the value
of `X: TypeAlias = "Widget | None"`), C# doc
`cref`s, forward declarations and TS declaration merges, a Go embedded
field's selectors and literal keys (the field is named after the type), and
names a Go dot import (`import . "pkg"`) brings in when that package declares
the type (an import path the index cannot resolve leaves the token for review).
A redundant `X as X` alias in Python, JS/TS or Rust renames both tokens.
Python module attributes follow aliased imports and nested package paths
(`from pkg import sub as api; api.inner.Widget`); a shadowed or rebound
module receiver requires review. A
same-name type of another module, package, namespace or crate, a local
binding, a type parameter and a member named like the type stay unchanged
(so does an object-initializer member, `new Address { Country = .. }`).
A C `typedef struct { .. } T;` is the typedef name T (no tag), and a C++
nested type (`struct Outer<K>::Node { .. }` or one in the class body) is
reached through `Outer::Node` spellings in any file.
A type or function name a macro spells by token pasting (`struct sdshdr##T`)
lists the pasting macro and each invocation that produces the name
(`SDS_HDR_VAR(8, s)`) for review. A C function's value references
(`set_cb(on_event)`, a table entry) are edited like its calls, through a
forward declaration or a header prototype; other external definitions of
the same declared function (platform variants in other files) are renamed
with it, and one that no declaration of it reaches is a review item. A call
excluded inside a region the parser could not read is a review item.
A token the lookup cannot settle (a Python module variable that both an
import of the type and an assignment bind, a name a macro expansion may bring into
scope, a macro argument its replacement list also uses in another role, a
specialization member through a dependent qualifier, text inside a macro
body or a handler attribute) is a `needsReview` change with its
`reviewReason`. Java moves a top-level type's `Widget.java` with it
(`fileRenames`); a constructor or C# finalizer handle plans the class
rename.
Open external interfaces, incomplete ownership, unresolved dispatch, an
inexact token, or a property assignment onto a function-local or undeclared
object (`reviewReason`) route to `needsReview` instead of a synthesized
edit. Comment/string occurrences in indexed source appear in `reviewItems` and
are never rewritten automatically; the result also tells you to search
documentation, configuration, generated files, and unsupported languages for
the old spelling. Read `changeSummary` and every review item. `plan` previews
only: it does not modify files, run a compiler, or prove runtime compatibility.

For `deps --cycles`, `eager` means every edge executes at module scope.
`deferred` means at least one edge does not: a function-local import (Python
`def`/`lambda` bodies; JS/TS `require()`/`import()` inside any function,
including `() => require()` thunks), a Python `if TYPE_CHECKING:` import, or a
TypeScript type-only import. Each deferred edge names its reason. A deferred
chain is not an unconditional import-time cycle; function-local chains stay
visible because invoking that function during initialization can still matter.
Cycles are enumerated completely and independently of build history (capped at
500 with a disclosed truncation; groups above 2000 files skip enumeration);
`CYCLE GROUPS` and the files-in-cycles count remain complete even when the
enumerated cycle counts are lower bounds. `CYCLE GROUPS` lists each strongly connected
file set, the unit a refactor has to break.

## Efficient use

- Prefer handles over plain names. Use `--class-name` or `--file` only when a handle is unavailable.
- Use `--sections` to request only the `show` or `repo` evidence needed.
- Use `--expand-unverified` only when deliberately exploring possible caller chains; those descendants remain possible, not confirmed.
- Use `--all` only when that command's output reports a supported cap; otherwise narrow the query or raise `--max-chars`.
- Use `search` or ordinary repository search for text, filenames, configuration, and unsupported syntax.

Read [references/commands.md](references/commands.md) for all public commands and flags. Read [references/trust-contract.md](references/trust-contract.md) before building automation that gates changes on UCN output.


### Inspect confirmation provenance

Caller and callee JSON carries compact `provenance`: `rule`, contributing `rules`
when there is more than one, `validation`, and the receiver's source and origin
line when recorded. Incomplete proofs include a `diagnostic`, also shown in text.
Callees retain compact `siteProvenance` for each distinct occurrence; their summary
uses the weakest confirmed site's rule. Exclusions expose counts by rule and
validation under `account.excluded.evidenceSummary`. Full declaration, import,
and member-lookup facts remain on engine results and in oracle reports.

A lone project owner of a method name does not identify an untyped receiver.
Such candidates stay unverified with `single-owner`; importing the class does not
change that. `provenance-incomplete` means the available facts cannot establish
this declaration. Inspect the site and diagnostic before editing it. Neither
reason is permission to discard a possible caller. `validation: unsupported`
means the witness collector does not yet cover that path (for example a wildcard
re-export or an external inherited member). Its existing classification is kept
in report-only mode; it is not a validated proof. Missing or inconsistent facts
on a supported lookup still route unverified. Full rule migration is tracked as
#356. Ordinal evidence weights are not probabilities.
