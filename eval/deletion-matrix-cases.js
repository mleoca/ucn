/**
 * eval/deletion-matrix-cases.js - members nothing names, and whether
 * deleting them breaks the build.
 *
 * Each case is a tiny project with one declaration to delete. A line that
 * starts with the marker is part of that declaration; the marker is
 * stripped when the files are written. `expect` is what the language's own
 * toolchain says after the deletion: 'break' (the project no longer
 * compiles or type-checks) or 'clean'.
 * `answer` is the engine's verdict and
 * reason for the deletion, the same before the declaration is deleted and
 * after (when it is assessed from its saved record).
 *
 * Two consumers share this data, so neither can drift from the other:
 *   - eval/run-deletion-matrix.js judges every case with its compiler and
 *     fails on any deletion the engine cleared that the compiler rejects;
 *   - test/deletion.test.js pins the engine's answer on every case, with
 *     no toolchain needed.
 *
 * What the cases have in common is that no call and no reference names the
 * member: it is held in place by a contract (an interface, an abstract
 * class, a trait, a pure virtual, a protocol or an object type satisfied by
 * shape), so a count of the name's uses says nothing.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const MARK = '\u00a7';
const GO_MOD = 'module example.com/m\n\ngo 1.21\n';
const CSPROJ = '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Library</OutputType>' +
    '<TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable>' +
    '<NoWarn>CS0169;CS0414;CS8618;IDE0051</NoWarn></PropertyGroup></Project>\n';

const L = (...lines) => lines.join('\n') + '\n';
const CASES = [
    // ---------------- TypeScript
    { id: 'ts-iface-object-return', lang: 'ts', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'interface Contract {', '    slot(): { value: number };', '}',
        'class Impl implements Contract {', '§    slot() { return { value: 1 }; }', '}', 'new Impl();') } },
    { id: 'ts-iface-nonascii-oneline', lang: 'ts', name: 'other', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'interface Cöntract { other(): number; }',
        'class Impl2 implements Cöntract {', '§    other() { return 1; }', '}', 'new Impl2();') } },
    { id: 'ts-getter-for-property-signature', lang: 'ts', name: 'v', expect: 'break', answer: 'review/structural-contract', files: { 'a.ts': L(
        'interface HasV { readonly v: number; }',
        'class C implements HasV {', '§    get v() { return 1; }', '}', 'new C();') } },
    { id: 'ts-method-for-function-property', lang: 'ts', name: 'run', expect: 'break', answer: 'review/structural-contract', files: { 'a.ts': L(
        'interface Runner { run: () => void; }',
        'class C implements Runner {', '§    run() {}', '}', 'new C();') } },
    { id: 'ts-abstract-method', lang: 'ts', name: 'run', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'abstract class Base { abstract run(): void; }',
        'class Child extends Base {', '§    run() {}', '}', 'new Child();') } },
    { id: 'ts-abstract-getter', lang: 'ts', name: 'size', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'abstract class Base { abstract get size(): number; }',
        'class Child extends Base {', '§    get size() { return 1; }', '}', 'new Child();') } },
    { id: 'ts-structural-assignment', lang: 'ts', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.ts': L(
        'interface Greeter { greet(): string; }',
        'class English {', '§    greet() { return "hi"; }', '}',
        'const g: Greeter = new English();', 'console.log(g);') } },
    { id: 'ts-structural-parameter', lang: 'ts', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.ts': L(
        'interface Greeter { greet(): string; }',
        'class English {', '§    greet() { return "hi"; }', '}',
        'function take(_g: Greeter) {}', 'take(new English());') } },
    { id: 'ts-structural-type-alias', lang: 'ts', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.ts': L(
        'type Greeter = { greet(): string };',
        'class English {', '§    greet() { return "hi"; }', '}',
        'const g: Greeter = new English();', 'console.log(g);') } },
    { id: 'ts-structural-inherited-rest', lang: 'ts', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.ts': L(
        'interface Greeter { greet(): string; name: string; }',
        'class Named { name = "n"; }',
        'class English extends Named {', '§    greet() { return "hi"; }', '}',
        'const g: Greeter = new English();', 'console.log(g);') } },
    { id: 'ts-iface-extends-iface', lang: 'ts', name: 'm', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'interface A { m(): void; }', 'interface B extends A {}',
        'class C implements B {', '§    m() {}', '}', 'new C();') } },
    { id: 'ts-generic-iface', lang: 'ts', name: 'load', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'interface Repo<T> { load(id: string): T; }',
        'class Users implements Repo<number> {', '§    load(_id: string) { return 1; }', '}', 'new Users();') } },
    { id: 'ts-iface-other-file', lang: 'ts', name: 'slot', expect: 'break', answer: 'review/required-slot', files: {
        'contract.ts': L('export interface Contract { slot(): number; }'),
        'a.ts': L('import { Contract } from "./contract";',
            'class Impl implements Contract {', '§    slot() { return 1; }', '}', 'new Impl();') } },
    { id: 'ts-typed-literal-member', lang: 'ts', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'interface Contract { slot(): number; }',
        'const impl: Contract = {', '§    slot() { return 1; },', '};', 'console.log(impl);') } },
    { id: 'ts-literal-typed-by-alias', lang: 'ts', name: 'slot', expect: 'break', answer: 'review/external-contract', files: { 'a.ts': L(
        'type Contract = { slot(): number };',
        'const impl: Contract = {', '§    slot() { return 1; },', '};', 'console.log(impl);') } },
    { id: 'ts-literal-optional-member', lang: 'ts', name: 'nick', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'a.ts': L(
        'interface Contract { nick?(): string; }',
        'const impl: Contract = {', '§    nick() { return "n"; },', '};', 'console.log(impl);') } },
    { id: 'ts-implements-alias', lang: 'ts', name: 'slot', expect: 'break', answer: 'review/external-contract', files: { 'a.ts': L(
        'type Contract = { slot(): number };',
        'class Impl implements Contract {', '§    slot() { return 1; }', '}', 'new Impl();') } },
    { id: 'ts-arrow-field-for-method', lang: 'ts', name: 'run', expect: 'break', answer: 'review/kind-not-audited', files: { 'a.ts': L(
        'interface Runner { run(): void; }',
        'class C implements Runner {', '§    run = () => {};', '}', 'new C();') } },
    { id: 'ts-inherited-fills-slot', lang: 'ts', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'interface Contract { slot(): number; }',
        'class Base {', '§    slot() { return 1; }', '}',
        'class Impl extends Base implements Contract {}', 'new Impl();') } },
    { id: 'ts-structural-descendant-completes', lang: 'ts', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.ts': L(
        'interface Greeter { greet(): string; name: string; }',
        'class Base {', '§    greet() { return "hi"; }', '}',
        'class English extends Base { name = "n"; }',
        'const g: Greeter = new English();', 'console.log(g);') } },
    { id: 'ts-abstract-requirement-itself', lang: 'ts', name: 'run', expect: 'break', answer: 'review/required-slot', files: { 'a.ts': L(
        'abstract class Base {', '§    abstract run(): void;', '    keep() {}', '}',
        'class Child extends Base {', '    override run() {}', '}', 'new Child();') } },
    { id: 'ts-interface-requirement-itself', lang: 'ts', name: 'slot', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'a.ts': L(
        'interface Contract {', '§    slot(): number;', '    keep(): number;', '}',
        'class Impl implements Contract {', '    slot() { return 1; }', '    keep() { return 2; }', '}',
        'new Impl().keep();') } },
    { id: 'ts-optional-member', lang: 'ts', name: 'nick', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'a.ts': L(
        'interface Greeter { nick?(): string; }',
        'class English implements Greeter {', '§    nick() { return "e"; }', '}', 'new English();') } },
    { id: 'ts-plain-unused', lang: 'ts', name: 'spare', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'a.ts': L(
        'class Plain {', '§    spare() { return 1; }', '}', 'new Plain();') } },

    // ---------------- Python
    { id: 'py-protocol-assignment', lang: 'py', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.py': L(
        'from typing import Protocol', '', '',
        'class Greeter(Protocol):', '    def greet(self) -> str: ...', '', '',
        'class English:', '    def other(self) -> int:', '        return 1', '',
        '§    def greet(self) -> str:', '§        return "hi"', '', '',
        'g: Greeter = English()') } },
    { id: 'py-protocol-parameter', lang: 'py', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.py': L(
        'import typing', '', '',
        'class Greeter(typing.Protocol):', '    def greet(self) -> str: ...', '', '',
        'class English:', '    def other(self) -> int:', '        return 1', '',
        '§    def greet(self) -> str:', '§        return "hi"', '', '',
        'def take(g: Greeter) -> None:', '    pass', '', '', 'take(English())') } },
    { id: 'py-protocol-generic', lang: 'py', name: 'load', expect: 'break', answer: 'review/structural-contract', files: { 'a.py': L(
        'from typing import Protocol, TypeVar', '', 'T = TypeVar("T", covariant=True)', '', '',
        'class Repo(Protocol[T]):', '    def load(self) -> T: ...', '', '',
        'class Users:', '    def other(self) -> int:', '        return 1', '',
        '§    def load(self) -> int:', '§        return 1', '', '',
        'r: Repo[int] = Users()') } },
    { id: 'py-protocol-property', lang: 'py', name: 'label', expect: 'break', answer: 'review/structural-contract', files: { 'a.py': L(
        'from typing import Protocol', '', '',
        'class Labeled(Protocol):', '    @property', '    def label(self) -> str: ...', '', '',
        'class Box:', '    def other(self) -> int:', '        return 1', '',
        '§    @property', '§    def label(self) -> str:', '§        return "b"', '', '',
        'x: Labeled = Box()') } },
    { id: 'py-protocol-descendant-completes', lang: 'py', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.py': L(
        'from typing import Protocol', '', '',
        'class Greeter(Protocol):', '    def greet(self) -> str: ...', '', '    def name(self) -> str: ...', '', '',
        'class Base:', '    def other(self) -> int:', '        return 1', '',
        '§    def greet(self) -> str:', '§        return "hi"', '', '',
        'class English(Base):', '    def name(self) -> str:', '        return "n"', '', '',
        'g: Greeter = English()') } },
    { id: 'py-protocol-explicit-subclass', lang: 'py', name: 'greet', expect: 'break', answer: 'review/external-contract', files: { 'a.py': L(
        'from abc import abstractmethod', 'from typing import Protocol', '', '',
        'class Greeter(Protocol):', '    @abstractmethod', '    def greet(self) -> str: ...', '', '',
        'class English(Greeter):', '    def other(self) -> int:', '        return 1', '',
        '§    def greet(self) -> str:', '§        return "hi"', '', '',
        'English()') } },
    { id: 'py-protocol-import-alias', lang: 'py', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.py': L(
        'from typing import Protocol as Shape', '', '',
        'class Greeter(Shape):', '    def greet(self) -> str: ...', '', '',
        'class English:', '    def other(self) -> int:', '        return 1', '',
        '§    def greet(self) -> str:', '§        return "hi"', '', '',
        'g: Greeter = English()') } },
    { id: 'py-protocol-module-alias', lang: 'py', name: 'greet', expect: 'break', answer: 'review/structural-contract', files: { 'a.py': L(
        'import typing as t', '', '',
        'class Greeter(t.Protocol):', '    def greet(self) -> str: ...', '', '',
        'class English:', '    def other(self) -> int:', '        return 1', '',
        '§    def greet(self) -> str:', '§        return "hi"', '', '',
        'g: Greeter = English()') } },
    { id: 'py-abc-abstractmethod', lang: 'py', name: 'run', expect: 'break', answer: 'review/external-contract', files: { 'a.py': L(
        'from abc import ABC, abstractmethod', '', '',
        'class Base(ABC):', '    @abstractmethod', '    def run(self) -> int: ...', '', '',
        'class Child(Base):', '    def other(self) -> int:', '        return 1', '',
        '§    def run(self) -> int:', '§        return 1', '', '',
        'Child()') } },
    { id: 'py-plain-unused', lang: 'py', name: '_spare', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'a.py': L(
        'class Plain:', '    def other(self) -> int:', '        return 1', '',
        '§    def _spare(self) -> int:', '§        return 1', '', '', 'Plain().other()') } },

    // ---------------- Go
    { id: 'go-implicit-conversion', lang: 'go', name: 'goSlot', expect: 'break', answer: 'review/required-slot', files: { 'go.mod': GO_MOD, 'c.go': L(
        'package m', '', 'type contract interface {', '\tgoSlot()', '}', '', 'type impl struct{}', '',
        '§func (impl) goSlot() {}', '', 'var _ contract = impl{}') } },
    { id: 'go-implicit-parameter', lang: 'go', name: 'goSlot', expect: 'break', answer: 'review/required-slot', files: { 'go.mod': GO_MOD, 'c.go': L(
        'package m', '', 'type contract interface {', '\tgoSlot()', '}', '', 'type impl struct{}', '',
        '§func (impl) goSlot() {}', '', 'func take(contract) {}', '', 'func init() { take(impl{}) }') } },
    { id: 'go-embedded-interface', lang: 'go', name: 'inner', expect: 'break', answer: 'review/required-slot', files: { 'go.mod': GO_MOD, 'c.go': L(
        'package m', '', 'type base interface {', '\tinner()', '}', '', 'type wide interface {', '\tbase', '}', '',
        'type impl struct{}', '', '§func (impl) inner() {}', '', 'var _ wide = impl{}') } },
    { id: 'go-promoted-method', lang: 'go', name: 'inner', expect: 'break', answer: 'review/required-slot', files: { 'go.mod': GO_MOD, 'c.go': L(
        'package m', '', 'type contract interface {', '\tinner()', '}', '', 'type base struct{}', '',
        '§func (base) inner() {}', '', 'type impl struct{ base }', '', 'var _ contract = impl{}') } },
    { id: 'go-plain-unused', lang: 'go', name: 'spare', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'go.mod': GO_MOD, 'c.go': L(
        'package m', '', 'type impl struct{}', '', '§func (impl) spare() {}', '', 'var _ = impl{}') } },

    // ---------------- Rust
    { id: 'rs-trait-required', lang: 'rs', name: 'slot', expect: 'break', answer: 'review/entry-point', files: { 'a.rs': L(
        'trait Contract {', '    fn slot(&self);', '}', 'struct Impl;',
        'impl Contract for Impl {', '§    fn slot(&self) {}', '}', 'pub fn make() { let _ = Impl; }') } },
    { id: 'rs-trait-requirement-itself', lang: 'rs', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'a.rs': L(
        'trait Contract {', '§    fn slot(&self);', '    fn keep(&self) {}', '}', 'struct Impl;',
        'impl Contract for Impl {', '    fn slot(&self) {}', '}', 'pub fn make() { let _ = Impl; }') } },
    { id: 'rs-generic-trait-required', lang: 'rs', name: 'load', expect: 'break', answer: 'review/entry-point', files: { 'a.rs': L(
        'trait Repo<T> {', '    fn load(&self) -> T;', '}', 'struct Users;',
        'impl Repo<u32> for Users {', '§    fn load(&self) -> u32 { 1 }', '}', 'pub fn make() { let _ = Users; }') } },
    { id: 'rs-trait-provided-itself', lang: 'rs', name: 'hint', expect: 'break', answer: 'review/required-slot', files: { 'a.rs': L(
        'trait Contract {', '§    fn hint(&self) {}', '    fn keep(&self) {}', '}', 'struct Impl;',
        'impl Contract for Impl {', '    fn hint(&self) {}', '}', 'pub fn make() { let _ = Impl; }') } },
    { id: 'rs-trait-provided-override', lang: 'rs', name: 'hint', expect: 'clean', answer: 'review/entry-point', files: { 'a.rs': L(
        'trait Contract {', '    fn hint(&self) {}', '}', 'struct Impl;',
        'impl Contract for Impl {', '§    fn hint(&self) {}', '}', 'pub fn make() { let _ = Impl; }') } },
    { id: 'rs-plain-unused', lang: 'rs', name: 'spare', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'a.rs': L(
        'struct Impl;', 'impl Impl {', '§    fn spare(&self) {}', '}', 'pub fn make() { let _ = Impl; }') } },

    // ---------------- Java
    { id: 'java-interface', lang: 'java', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'A.java': L(
        'interface Contract { void slot(); }',
        'class Impl implements Contract {', '§    public void slot() {}', '}',
        'class Use { Object o = new Impl(); }') } },
    { id: 'java-abstract-class', lang: 'java', name: 'run', expect: 'break', answer: 'review/required-slot', files: { 'A.java': L(
        'abstract class Base { abstract void run(); }',
        'class Child extends Base {', '§    void run() {}', '}',
        'class Use { Object o = new Child(); }') } },
    { id: 'java-generic-interface', lang: 'java', name: 'load', expect: 'break', answer: 'review/required-slot', files: { 'A.java': L(
        'interface Repo<T> { T load(String id); }',
        'class Users implements Repo<Integer> {', '§    public Integer load(String id) { return 1; }', '}',
        'class Use { Object o = new Users(); }') } },
    { id: 'java-enum-interface', lang: 'java', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'A.java': L(
        'interface Contract { int slot(); }',
        'enum Kind implements Contract {', '    ONE;', '§    public int slot() { return 1; }', '}',
        'class Use { Object o = Kind.ONE; }') } },
    { id: 'java-inherited-fills-slot', lang: 'java', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'A.java': L(
        'interface Contract { void slot(); }',
        'class Base {', '§    public void slot() {}', '}',
        'class Impl extends Base implements Contract {}',
        'class Use { Object o = new Impl(); }') } },
    { id: 'java-interface-requirement-itself', lang: 'java', name: 'slot', expect: 'break', answer: 'review/required-slot', files: { 'A.java': L(
        'interface Contract {', '§    void slot();', '}',
        'class Impl implements Contract {', '    @Override public void slot() {}', '}',
        'class Use { Object o = new Impl(); }') } },
    { id: 'java-default-override', lang: 'java', name: 'hint', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'A.java': L(
        'interface Contract { default void hint() {} }',
        'class Impl implements Contract {', '§    public void hint() {}', '}',
        'class Use { Object o = new Impl(); }') } },
    { id: 'java-plain-unused', lang: 'java', name: 'spare', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'A.java': L(
        'class Plain {', '§    private void spare() {}', '}', 'class Use { Object o = new Plain(); }') } },

    // ---------------- C#
    { id: 'cs-interface', lang: 'cs', name: 'Slot', expect: 'break', answer: 'review/required-slot', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'interface IContract { void Slot(); }',
        'class Impl : IContract {', '§    public void Slot() { }', '}',
        'class Use { object o = new Impl(); }') } },
    { id: 'cs-abstract-override', lang: 'cs', name: 'Run', expect: 'break', answer: 'review/required-slot', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'abstract class Base { public abstract void Run(); }',
        'class Child : Base {', '§    public override void Run() { }', '}',
        'class Use { object o = new Child(); }') } },
    { id: 'cs-explicit-interface', lang: 'cs', name: 'Slot', expect: 'break', answer: 'review/external-contract', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'interface IContract { void Slot(); }',
        'class Impl : IContract {', '§    void IContract.Slot() { }', '}',
        'class Use { object o = new Impl(); }') } },
    { id: 'cs-interface-property', lang: 'cs', name: 'Value', expect: 'break', answer: 'review/required-slot', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'interface IContract { int Value { get; } }',
        'class Impl : IContract {', '§    public int Value { get { return 1; } }', '}',
        'class Use { object o = new Impl(); }') } },
    { id: 'cs-inherited-fills-slot', lang: 'cs', name: 'Slot', expect: 'break', answer: 'review/required-slot', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'interface IContract { void Slot(); }',
        'class Base {', '§    public void Slot() { }', '}',
        'class Impl : Base, IContract { }',
        'class Use { object o = new Impl(); }') } },
    { id: 'cs-abstract-requirement-itself', lang: 'cs', name: 'Run', expect: 'break', answer: 'review/required-slot', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'abstract class Base {', '§    public abstract void Run();', '}',
        'class Child : Base {', '    public override void Run() { }', '}',
        'class Use { object o = new Child(); }') } },
    { id: 'cs-explicit-requirement-itself', lang: 'cs', name: 'Slot', expect: 'break', answer: 'review/required-slot', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'interface IContract {', '§    void Slot();', '    void Keep() { }', '}',
        'class Impl : IContract {', '    void IContract.Slot() { }', '}',
        'class Use { object o = new Impl(); }') } },
    { id: 'cs-default-interface-method', lang: 'cs', name: 'Hint', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'interface IContract { void Hint() { } }',
        'class Impl : IContract {', '§    public void Hint() { }', '}',
        'class Use { object o = new Impl(); }') } },
    { id: 'cs-plain-unused', lang: 'cs', name: 'Spare', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'm.csproj': CSPROJ, 'A.cs': L(
        'class Plain {', '§    private void Spare() { }', '}', 'class Use { object o = new Plain(); }') } },

    // ---------------- C++
    { id: 'cpp-pure-virtual', lang: 'cpp', name: 'area', expect: 'break', answer: 'review/required-slot', files: { 'a.cpp': L(
        'struct Shape {', '    virtual double area() const = 0;', '    virtual ~Shape() {}', '};',
        'struct Square : Shape {', '§    double area() const { return 1.0; }', '};',
        'int main() { Square s; (void)s; return 0; }') } },
    { id: 'cpp-pure-virtual-override', lang: 'cpp', name: 'area', expect: 'break', answer: 'review/required-slot', files: { 'a.cpp': L(
        'struct Shape {', '    virtual double area() const = 0;', '    virtual ~Shape() {}', '};',
        'struct Square : Shape {', '§    double area() const override { return 1.0; }', '};',
        'int main() { Square s; (void)s; return 0; }') } },
    { id: 'cpp-pure-virtual-intermediate', lang: 'cpp', name: 'area', expect: 'break', answer: 'review/required-slot', files: { 'a.cpp': L(
        'struct Shape {', '    virtual double area() const = 0;', '    virtual ~Shape() {}', '};',
        'struct Mid : Shape {};',
        'struct Square : Mid {', '§    double area() const { return 1.0; }', '};',
        'int main() { Square s; (void)s; return 0; }') } },
    { id: 'cpp-out-of-class-definition', lang: 'cpp', name: 'area', expect: 'break', answer: 'review/required-slot', files: { 'a.cpp': L(
        'struct Shape {', '    virtual double area() const = 0;', '    virtual ~Shape() {}', '};',
        'struct Square : Shape {', '    double area() const;', '};',
        '§double Square::area() const { return 1.0; }',
        'int main() { Square s; (void)s; return 0; }') } },
    { id: 'cpp-pure-virtual-requirement-itself', lang: 'cpp', name: 'area', expect: 'break', answer: 'review/required-slot', files: { 'a.cpp': L(
        'struct Shape {', '§    virtual double area() const = 0;', '    virtual ~Shape() {}', '};',
        'struct Square : Shape {', '    double area() const override { return 1.0; }', '};',
        'int main() { Square s; (void)s; return 0; }') } },
    { id: 'cpp-plain-unused', lang: 'cpp', name: 'spare', expect: 'clean', answer: 'no-static-dependents/claimed', files: { 'a.cpp': L(
        'struct Plain {', '§    int spare() const { return 1; }', '};',
        'int main() { Plain p; (void)p; return 0; }') } },
];

/**
 * Write a case's files under `root` (an application: exported symbols are
 * assessed, so exposure never stands in for the contract being tested) and
 * return the declaration to delete: { file, from, to } in 1-based lines.
 */
function materialize(testCase, root) {
    let target = null;
    for (const [file, content] of Object.entries(testCase.files)) {
        const lines = content.split('\n');
        const marked = [];
        lines.forEach((line, i) => { if (line.startsWith(MARK)) marked.push(i + 1); });
        if (marked.length > 0) target = { file, from: marked[0], to: marked[marked.length - 1] };
        fs.writeFileSync(path.join(root, file),
            lines.map(line => (line.startsWith(MARK) ? line.slice(MARK.length) : line)).join('\n'));
    }
    fs.writeFileSync(path.join(root, '.ucn.json'), '{"kind":"application"}\n');
    return target;
}

/** Remove the target's lines from its file. */
function deleteTarget(root, target) {
    const file = path.join(root, target.file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.splice(target.from - 1, target.to - target.from + 1);
    fs.writeFileSync(file, lines.join('\n'));
}

module.exports = { CASES, materialize, deleteTarget };
