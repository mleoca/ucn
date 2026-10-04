# UCN resolution rules

How UCN decides whether a call, reference or type name belongs to the pinned definition: what confirms, what stays unverified with which reason, what is excluded. Read the section for the language at hand when a tier or reason in an answer needs explaining. The reason names in backticks are the ones the output prints.

This is portable AST analysis, not a compiler build; macros, templates, generated code, reflection, and external dependency semantics can remain unverified.

## Every language

### Type names and type identity

A type name written at a call site (a constructor, `Type::f()` / `Type.f()`, an annotated or constructed receiver, a declared field type, a producer's return type) denotes what that file binds it to: when it names an external type that shares its name with a project type (`use std::fs::File`, `import java.io.File`, `from pathlib import Path`, `import { Server } from 'http'`, `using F = System.IO.File`, `std::mutex`), members of the project type are excluded (`external-receiver`), and a project impl on the external type itself stays unverified `possible-dispatch`.

A type declared in a function body (Python, Java, JS/TS, Rust, C++, Go) is visible only in its block: a same-name type outside never captures its references or members, and inside the block it shadows the outer one. A Python field assigned a function-local class (`self.channel = Channel()`) names that class, not a same-named module class.

In JS/TS, Python and Rust a type's identity is its module: `Shared::init()` / `Shared.init()` names the `Shared` its own module declares or imports, never a same-name type of a sibling module (excluded `path-type-mismatch`).

A module-level `Alias = Box` (Python: bound once, or on every module-level `if`/`try` path to the same class; JS/TS: `const`, or a `let`/`var` never assigned again) names Box in annotations and constructor calls, also when imported, and `Alias(..)` / `new Alias(..)` is a caller of the class; an alias whose paths name different classes stays `possible-dispatch`.

Type aliases and import renames are the same type on both the caller and callee side: a receiver annotated with Go `type IntFlag = FlagBase[int]`, TS `import { Box as B }`, Rust `use crate::Wrap as W` or C# `using IntBox = G.Box<int>` reaches the original type's methods; a Go alias of an external type (`type Ctx = context.Context`) is not a same-named project type.

### Aliases, qualifiers and imports

Aliased and qualified calls resolve in every language: Rust `use m::f as g; g()` is a caller of `f` (listed as a beyond-text caller, since the line holds no target token); Java `pkg.Type.method()` and C# `Ns.Type.Method()` / `using T = Ns.Type; T.Method()` pick the type the qualifier names when several same-name types exist. A qualifier the resolver cannot place stays visible as `method-ambiguous`, never confirmed by first-definition order.

A bare name bound by an import resolves through that import only, never through another import whose package re-exports a same-named symbol. An import chain that reaches the target through any number of re-exports and renames (`export { a as b }`, then `import { b as c }`) is import evidence.

A one-hop local alias of a typed field, parameter or local (`config = self.config; config.load()`, `const c = this.config`, `var c = this.config`, `c := s.config`, `let c = &self.config`) receives like the aliased expression when the local is bound once and never reassigned.

A local value named like a function (`let f = g; f()`, C# delegates, C++ lambdas and function pointers) is the callee.

Explicit type arguments are call syntax (Go `f[T](x)` / `pkg.F[T](x)`, Rust `f::<T>(x)`, TS/C#/C++ `f<T>(x)` and `obj.template f<T>()`, Java `this.<T>f(x)`).

Inherited calls keep their declaring class; a shadowed or rebound module stays unverified, and a base-typed receiver can still dispatch to a subclass override.

### Configuration alternatives

Definitions of one name, owner and signature in one file under different `#if` branches (C/C++/C#) or `#[cfg]` attributes (Rust) are one item: a call bound to any of them reaches every variant alike, a type declared once per configuration is one type (receivers typed by either declaration reach its impls), members inside a class body's `#if` blocks are indexed in each branch, and a C++ implicit-this call reaches its own class definition, never a same-named class defined in another file. Python exclusive branches are one item too (see Python below).

### Callback references

Callable references passed to another function remain visible when a project method or function could be their target. An ordinary attribute read with no callable member candidate stays a non-call reference in ACCOUNT and `usages`. The caller model includes callback dependencies; it does not prove that the receiving function invokes every passed callable.

## JavaScript / TypeScript

A bare JS/TS name never reaches a function assigned as an object member (`req.setTimeout = () => {}`, `exports.f = function () {}`, prototype and object-literal members) unless the object is the global object (`globalThis`, `window`, `self`, `global`) or the call is inside the function's own named expression; a member of an object that may be the global object (a parameter, a plain function's `this`) stays unverified `member-object-unresolved`; `var global = globalThis` names the global object too.

A bare call of a global assigned in another file (`globalThis.f = ..` in a test setup module) is unverified `possible-dispatch` via `global f — assigned in project`, one runtime family per global.

A JS/TS name destructured from an object (`const { run } = api`, `({ run }: Api) => run()`) reads that member: its calls are member calls on the source, confirmed when the source is typed and unverified otherwise, and a same-name free function is never their target.

A JS file's extensionless import resolves a TS source; a bare specifier naming a package of the repository (workspaces, `@scope/core`) resolves to that package's source (its `exports`/`source` entries, else `src/index`), and one whose manifest names only build output absent from the checkout stays unverified, never external.

A structural receiver whose class resolves to a definition reaches the target only through that definition's ancestry: a sibling class sharing an ancestor's name is excluded, not a possible dispatch.

## Python

A Python name bound in one scope only in exclusive branches (`if`/`elif`/`else`, `try`/`except`, `match` cases: `if sys.platform == "win32": def getchar` / `else: def getchar`) is one item: a call inside one branch reaches that branch's definition, any other call reaches each definition alternative (confirmed for each, since it reaches it whenever that definition exists), and a definition reached only through one branch's import (`try: from ._speedups import f` / `except ImportError: def f`) is listed unverified `configuration-alternative`; `plan` renames every definition alternative and keeps the item's name on an import alternative (`from ._speedups import new as f`).

A name a Python module binds only by assignment is that module's value, never a re-export of what its other imports reach: `name = other` and `name = submodule.other` aliases are followed, `loads = registry.loads` with `registry = Registry()` is Registry's bound method (a call of the imported `loads` is no caller of another `loads`; it is an unverified `alias-call` of `Registry.loads`, and `plan` renames the attribute read `registry.loads`, never the variable or its calls), and any other value routes unverified `ambiguous-binding`.

Python qualified bases and receiver annotations follow the imported module, including aliased submodules and nested package paths.

An untyped `self.attr.m()` callee is unverified `single-owner` even when one class declares `m`. A `self` attribute a base class types is typed in its subclasses, by the declaring class's file, when no class on the way writes it, declares a member of its name or writes attributes dynamically and no outside base could set it; `def`s under `if`/`try`/`with`/loops in a class body are methods of the class, and `Union[X, None]` names X.

A `def` inside a function is visible only in that function (unless the function declares the name `global`), and a nested function's bare name binds what its enclosing functions bind before the module.

A structural receiver whose class resolves to a definition reaches the target only through that definition's ancestry: a sibling class sharing an ancestor's name is excluded, not a possible dispatch.

A Python string annotation that spells a call (`def cmd(v: "Annotated[int, typer.Argument()]")`) is parsed as the expression the runtime evaluates: its calls are callers and `plan` edits them; an annotation string that does not parse stays a text review item.

## Go

A Go import that writes no name binds a project package by its package clause (`.../internal/helpers` declaring `package utils` is `utils.F()`); an outside package's name is only the one the Go tools suggest (`github.com/goccy/go-json` is `json`, `k8s.io/api/core/v1` is `v1`), so a qualifier the file neither declares nor imports by that name stays unverified `package-qualifier`, never a confirmed or renamed project call, and `plan` keeps a call it cannot type as a review item in a file of another build configuration (`//go:build`, `_linux.go`) than the renamed declaration's.

`pkg.F()` names the package's function (or function-valued variable), never a same-named method. A Go instantiated value (`id[int]`) or package-qualified value (`pkg.F` passed as an argument) is a reference to that function. A composite literal `T{...}` names the type, never a same-named method.

A Go package-level variable has one static type across its package: `var CommandLine = NewFlagSet(..)` types `CommandLine.VarP(..)` in every file of the package, before or after the declaration, and `pkg.CommandLine.VarP(..)` in importers.

## Rust

Rust receivers are typed from annotations, closure parameters of the called function's `Fn` bounds, `Self::Assoc` returns, tuple `let` patterns, trait-provided methods, and range, tuple, slice, `vec!`, and `Some`/`Ok` values; owned versus `&` impls are told apart by the receiver's reference layer, and at one probe step an inherent method precedes a trait method (`self.key_mut()` inside a trait impl's own `key_mut` calls the inherent `key_mut`), on the caller and callee side; where a bound-conditional impl, a trait not provably in scope or a private inherent method could intervene, the site stays unverified.

Method probing follows the receiver's reference layer: a `self` receiver that reaches the member only after an autoref or deref step (a `&self` trait method called in a `&mut self` method) may be taken by an earlier impl, such as std's `impl AsRef<U> for &mut T`, so the site stays unverified `autoref-dispatch` unless the trait is the project's own and no impl for a reference type can intervene. A local bound from a producer returning `Self` or a value is owned and `-> &T` a reference, which selects between owned and `&` impls. An untyped `let` hides an outer binding's type, and calls in the item bodies of an item-position macro (`quickcheck! { fn p(..) { .. } }`, also when a project macro emits it) are read from the items, with their functions' locals typed.

A receiver behind a std deref wrapper (`Box`, `Rc`, `Arc`, `ManuallyDrop`, `LazyLock`, `Ref`/`RefMut` and lock guards, `Pin`, `Cow`; annotated, constructed with `W::new(..)` or a `LazyLock` static) reaches its target type's methods (a guard returned by a call such as `cell.borrow()` or `m.lock().unwrap()` is not typed, so its calls stay unverified); a name the wrapper itself may supply (`clone`, `as_ref`, std trait methods, project impls on the wrapper) stays unverified `autoref-dispatch`, and `rc.clone()` is the wrapper's.

Values of std containers, slices, arrays (`[a, b].iter()`), `str`, `Option`/`Result` and std iterator adaptors never reach a method owned by a project struct or enum. Raw pointers (`*const T`/`*mut T` parameters and locals, casts `(p as *const T)`, `as_ptr()` results and pointer arithmetic such as `p.add(n)`) reach `impl<T> Tr for *const T` members and never a struct's method.

A parameter typed `Self` is the enclosing impl's type. A receiver whose type is a generic parameter (including `self` in a trait's own methods) reaches only implementations of its bound traits (unverified `possible-dispatch` via the trait, external for std traits such as `Iterator`) and never an inherent method or another trait's impl. A Rust `const`/`static` item types its method receivers by its declared type (`FLAGS.iter()`; never a `static mut`), and a local destructured from `self` (`let Self { iter, .. } = self;`) is that field.

Crate aliases (`use x as y`, `extern crate x as y`), the package's own name in tests/examples, glob and `pub use` re-export chains, auto-deref wrappers, enum-variant values, unit-struct values (`S.m()`, also through `let w = S;`), tuple-struct and tuple-variant constructors (`T(1).m()`, `E::V(2).m()`, `Self(..)`), struct expressions, and in-scope blanket extension traits (`impl<T: Iterator> Ext for T`) are followed; a blanket-impl member confirms only when its where-clause holds through exactly one visible project impl. `Trait::f(..)` returned from a member of that trait's impl binds that impl; elsewhere it stays one trait family.

Impls of one generic trait for one type (`impl From<A> for Vec<u8>` beside `impl From<B> for Vec<u8>`) are selected by argument type (declared parameters and locals, struct literals, literals, range-indexed slices, locals bound from a `Type::ctor(..)` whose project definitions return the type): another argument type excludes the impl (`overload-mismatch`), an undecided argument stays `overload-ambiguous`, and an undecided argument never confirms the only project impl of an out-of-project trait such as `From`, whose other impls UCN cannot see.

Rust `crate::f()`, `super::f()`, `self::m::f()` and child-module paths resolve through the module tree (`mod` files in both layouts, `#[path]`, inline modules) and confirm as `module-owned`; a type path (`crate::tests::memchr::Runner::new()`) names the type that module declares, and a type a glob import (`use super::*`) brings in is that module's type; a bare call never resolves to a struct field.

### Rust macros

Invocations of project `macro_rules!` macros are expanded (rules matched over token trees, nested and recursive project macros, hygiene for locals the macro introduces, `$crate`, every `cfg` alternative): functions, impls and calls the expansion generates are indexed at the invocation, marked `[via macro NAME]`. A call written in the invocation keeps its own line and is typed in its expanded context; an unresolved call from the macro's template joins the target's `macro template` family in the compile-time band, and `plan` edits a generated declaration only through the argument or template token that spells it. Macros that only pass their arguments along (logging, `try!`-style matches) keep the invocation's token-tree view. Macros from dependencies are never expanded; project invocations that cannot be expanded are listed in `repo --sections=health` and warned by `deadcode`.

Macro names are their own namespace: `name!(...)`, `#[name]` and `#[derive(Name)]` never count as calls or references of a same-named fn (excluded `macro-namespace`), and a fn declared inside another fn's body is visible only there.

## Java and C# (shared)

Unimported Java and C# names follow the language's scoping: the same package or an enclosing namespace, then on-demand imports with the implicit `java.lang`, or `using` directives, global usings and project-file `<Using>` items (`Static="true"` items are `global using static`; `Directory.Build.props` above an indexed sub-project count up to the repository root). A `using` directive written inside a namespace resolves from that namespace outward (`namespace A.B; using Internal;` imports `A.Internal` when the project declares it), and nested `namespace` blocks name their members by the full path; a project type not in scope there is not the named type, and a project on-demand import beside a `java.lang` type of that name stays unverified.

Overload choice needs argument evidence (Java, C#): where the applicable overloads differ in a parameter and the argument's type is unknown, the site stays unverified `overload-ambiguous` for each of them (for `plan`, a review item at the site), including the fixed-arity versus varargs/`params` choice; explicit method type arguments (`M<int>(..)`), literals, typed locals, parameters, fields of the enclosing class and a lambda's parameter count against `Action`/`Func`/`java.util.function` shapes, project delegates and project functional interfaces (one abstract method) decide it; a C# generic method whose type parameter no parameter type mentions applies only with explicit type arguments; a C# target-typed `new(..)` constructs the type its position declares (a typed local or field, a property, the enclosing member's return type, a member it is assigned to, or the parameter of the overload a call, construction or `this(..)`/`base(..)` initializer binds, primary constructors and a platform collection field's element type included); a decided overload confirms it, an undecided one lists it unverified `overload-ambiguous` for each candidate type, and arguments that fit none of the pinned class's overloads (a C# extension method of another class) leave the site unverified, never confirmed.

In C# and Java a type name is no value: a bare argument spelled like a type (a property named like its type) is never the type's caller. In C# and Java a capitalized receiver that names a field or property of the enclosing class (declared in another `partial` part or inherited) is that member, typed in its declaring file's scope.

A bare Java/C# call binds a member of the enclosing classes (own or inherited, by class definition, never a same-name class of another package) before a static import (`import static`, `using static`); the import decides it, as caller and callee, only when every class in scope has a resolved project ancestry, and otherwise it stays unverified.

A Java/C# local's declared type is its static receiver type: `Shape s = new Circle(); s.area()` is a caller of `Shape.area` and a `possible-dispatch` candidate of each implementation, except those the constructed type cannot reach when the local is never reassigned. A field initializer types only its own class's field, and only a field that cannot be reassigned.

## Java

A package-qualified Java type (`p.Node pn`) names that package's type. A type-qualified call (`Util.isEmpty(s)`) and a return type (`A.builder().get()`) name the class the name denotes where it is written, before any overload fit: a same-name class of another package, or another class's nested `Builder`, never lends its better-fitting overload or member.

`super.m()` binds the superclass member, never the override; in an enum constant's body it is the enum's member, and a bare call in an anonymous class or enum-constant body looks up that body's supertype first (a method the body declares itself is its own). A Java member of a nested class is not in the outer class's simple-name scope, and a constructor callee is the class the name denotes where it is written (a single-type import before a same-package class's nested namesake).

A Java enum implements its interfaces like a class (renames reach the enum's member and enum-constant bodies), and serialization callbacks of an enum are ordinary members (enum constants serialize by name).

## C#

C# resolution uses declared property/field receiver types plus overload and hiding discipline. A C# `#if` that splits a declaration (a method body or expression body, a base-list entry, a parameter, alternative heads) is read one configuration at a time with every line number kept: the branch holding the most calls is primary, and the other alternatives' declarations and calls come from their own configuration.

C# generic arity is part of a type's identity: `Outcome`, `Outcome<T>` and `Outcome<T1, T2>` are distinct types, so a constructor `new Outcome<T>(..)`, a static call `Outcome.X()` / `Outcome<int>.X()`, a written receiver type and a base list name only the type of that arity (other-arity sites are excluded `generic-arity-mismatch`), and `partial` parts merge only with the same arity.

An extension-method call `x.Ext()` is a caller of the extension when the declaring static class is in scope and x's type fits the `this` parameter (directly, through project heritage, or through a type parameter's constraints); a receiver whose ancestry cannot decide it (an external type) stays unverified `extension-receiver-unresolved`, and an applicable instance method of the receiver type wins (also a platform collection's own member, `List<T>.Add(T)`, and `object` members). Type arguments must fit: a `List<string>` or `DbSet<Customer>` receiver never takes `this List<Transformer>`. Type arguments the receiver fixes type the other parameters (`TryAdd<T>(this List<T>, T)` never takes a `string[]`). An extension call on a project type that derives from an outside class (other than `object`, the modelled collections and the type the extension is declared for) stays unverified, since an inherited instance member may take it. A receiver typed by a type parameter converts only to its constraints.

A C# explicit interface implementation (`IEnumerator IEnumerable.GetEnumerator()`) is never reached by a simple-name or `this.` call, and through an interface-typed receiver only by runtime dispatch. An explicit interface implementation never types a member access on the class.

A C# static method is never reached through a value (a chained call's result, `this`, a field or a typed local), and `new X(..)` names the type X even where the enclosing class has a member named X. A C# static member path from a type (`Pool.Shared.Get()`, where `Pool` is no member of the enclosing class) is typed from that type's declared member, and a chained call (`Get().Initialize<T>()`) is typed from its producer or stays unverified, never read as a type name.

A C# `using static T` imports only the members T itself declares, never inherited ones. A using alias whose target starts with an alias of an enclosing scope resolves through it; a type written with an `extern alias` qualifier (`Old::Lib.Type`) is never resolved to a project type (its receivers stay unverified, `plan` lists its tokens for review).

A C# target-typed `new(..)` in a collection initializer or collection expression (`new List<T> { new(..) }`, `T[] a = [new(..)]`, dictionary `{ new(..), v }` pairs) constructs the element type, and an argument of a generic receiver's method (`Box<Item> b; b.Put(new(..))`) the type argument it binds.

## C and C++

C/C++ uses `compile_commands.json` when available to classify headers and resolve include paths; free-function visibility follows the transitive `#include` closure, and a quoted include found only by a unique project basename is weaker evidence (rule `include-basename`). C++ resolution uses namespace ownership, static overload shape (including arrays), and macro-parameter requalification.

### Declarations, linkage and configurations

Every non-static declaration of a free function (a header prototype or a local forward declaration in another file) is the same entity as its external definition, so its calls are the definition's callers and `plan` renames every declaration; a `static` forward declaration joins only its own file's definition. Several external-linkage definitions of one function (platform variants), or definitions in complementary `#if` branches, stay `link-ambiguous` on the caller and callee side unless the caller's own file (in the same branch) or the compile database separates them. A call in a header to a `static` function the header declares binds each including file's own definition: unverified `translation-unit-binding`.

Recoverable preprocessor branches contribute AST-proven source facts, so a single selected configuration does not silently erase definitions or calls; disagreeing conditional macro identities stay visible as unverified. Members a class declares only in a conditional branch the selected configuration skips are indexed too. In a C/C++ file too large for the configuration sweep, a conditional the parser could not place (in a member-initializer list, an expression, template arguments) or whose branches split a block's braces is read in one configuration.

A same-named class in a header that is only ever included in another branch of the same `#if` chain (`#ifdef _WIN32 #include "client-windows.h" #else #include "client.h"`) is that class in another configuration: calls its own members make are listed unverified `configuration-alternative` for this class's member, and `plan` renames the member in both.

### Receivers, qualifiers and lookup

A C++ `v->m()` reaches what `->` yields: the pointee of a pointer, of a std smart pointer (also behind a project alias) or of a class's `operator->`; any other object stays unverified. A receiver typed by a template parameter of the enclosing function or class template stays unverified `possible-dispatch` via that parameter, and an alias whose target is a dependent type (`typename X<..>::type`) is not a class. A C++ receiver declared with an alias (`Value v;`) has the class the alias names where it is written: a same-name alias in a namespace the site cannot see does not count.

`::f()` names the global namespace, so a namespace member is not its target unless a global-scope using brings it in (unverified `global-qualified-using`); `plan` edits a qualified reference (an explicit instantiation `template auto ns::f(float) -> R;`, `&ns::f`) when its qualifier names the renamed function's namespace or class, and lists it for review when the qualifier cannot be resolved. A C++ `Q::f()` qualifier is resolved through `using` aliases, using-declarations, and macro-opened namespaces (a namespace an object-like macro names, `namespace LIB_NS {`, is the namespace the macro expands to, also where a qualifier or using-directive spells the macro): it excludes only when Q provably names a namespace or an unrelated class, and routes `unresolved-qualifier` or `dependent-qualifier` (template parameter) otherwise. `plan` also renames each C++ using-declaration that names the renamed declaration (`using ns::f;`, `using ns::Type;`) when its qualifier resolves to the declaration's namespace or class, and lists it for review when only the qualifier's suffix matches.

A C++ class member hides every base member of its name unless a `using Base::name;` in the class brings them in (default arguments count in the arity); `v[k].m()` on a class object takes the class its `operator[]` returns when every `operator[]` it declares returns that one class; `T v(X());` in a block is an object initialized by the call `X()` unless `X` is a type. A C++ receiver whose class declares several overloads of the name is never a caller of an unrelated class's member, even when the arguments cannot choose among the overloads. A C++ implicit-this call names the member the enclosing class's lookup finds; an override of it in a subclass is reached only by runtime dispatch, as an unverified `possible-dispatch` candidate when the member is virtual and not at all otherwise.

A C++ `friend` function declared or defined in a class body is a function of the enclosing namespace, not a member (argument-dependent calls reach it, its body sees the class's static members, `plan` renames the friend declaration with the definition), and a member of a nested class reaches the enclosing class's members by bare name.

### Preprocessor macros

A C/C++ call spelled `NAME(` where a project `#define NAME` is in effect is the macro's, not a same-named function's; a macro defined under a preprocessor conditional routes the call unverified `macro-namespace`, and a header that both declares the function and defines the macro holds configuration alternatives. A macro whose replacement list calls its own name again (`#define f(x) f(x)`, never re-expanded) passes the call to the function; one that only spells the name without calling it routes unverified `macro-namespace`.

Invocations of project function-like macros that paste (`fs__##lc(req)`), call a parameter, or feed an X-macro list (`LIST(X)`, `#include "list.def"`) are expanded at the token level: a call the expansion produces is a caller at the invocation line, marked `[via macro NAME]` with rule `macro-expansion`; configuration-dependent definitions that disagree route `macro-definition-ambiguous`, and `plan --rename-to` lists such sites as manual review because the line does not spell the name.

A call spelled in a macro's replacement list binds at each place the macro is invoked (through other macros too): confirmed when every invocation sits where the call reaches the target (a member of the invoking class), unverified `macro-body-context` when only some do. A receiver the replacement list declares with a macro parameter as its type (`T v; v.f();` in `#define M(T)`) takes the class every project invocation passes for that parameter (through other macros too); invocations that disagree, or one that cannot be read, leave its calls unverified.

A decoration macro before a return type (`API std::string Cls::m()`, `bool API ns::Cls::m()`, `MACRO std::size_t f()` in a class) or in a class head (`class API Name : public Base<Name>`) is blanked before parsing, only when the file proves it decoration (its own `#define`, or a position no type can hold) and never the type, scope or keyword beside it; members after a class-body macro invocation take the access its definition spells, and when that definition is not in the project their access is unknown and `deadcode` treats them as public. Macros another header of the include closure defines are read by the recovery like the file's own when every project definition of the name agrees: decoration (`SPDLOG_INLINE`), removable statement (`TRY` / `CATCH` defined as `try` / a `catch` handler or nothing) and attribute or return-type macros (`ATTR(3)` before a member); `LUA_API int (lua_gettop)(..)` declares `lua_gettop`. Members that escaped a class body the parser closed early are disclosed as recovery-region lines.

An invocation of the file's own function-like macro that the parser reads as a declaration (`ERROR_DEF(Base, Name)` in a class body, `LIST(X)` statement lists) is read as the invocation: members its replacement list declares join the class at the invocation line (`generatedByMacro`), and a C++ declaration with no type outside a class body (`TEST(suite, name) { }`) is an invocation, never a function named after the macro. A namespace-scope invocation followed by a body (`TEST(suite, name) { }`, `TEST_CASE("text") { }`) defines a callable named from its arguments (`suite_name`, `text`), marked `generatedByMacro`: calls in the body belong to it, it is an entry point, and `plan` blocks its rename (`macro-generated-name`), as it does for a member a class-body invocation builds by token pasting (`Get##name##String`). A bare call in such a body to a member of a class one of its arguments names (`TEST_F(Fixture, Name)`) is unverified `macro-generated-scope via Fixture`, never excluded. A declaration named like a function-like macro in effect where it is written (`int seed_ GUARDED_BY(mu_);` under a conditional macro definition) is that macro's invocation, so `plan` blocks renaming it as a function (`macro-invocation`).
