'use strict';

/**
 * The pre-commit check answers by what a change DID.
 *
 * core/change-kinds.js reads a callable's contract (header, kind, inferred
 * return) before and after a change; core/capture.js asks whether an added
 * declaration can be reached by anything that existed; core/deletion.js
 * assesses a deleted declaration from its base record. core/check.js turns
 * those into one verdict per changed symbol: blocked (a break was
 * observed), review (can reach existing code, not settled) or ready
 * (nothing that existed depends on the change).
 */

require('./helpers/cache-root');
const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const { tmp, rm, idx, runCli } = require('./helpers');
const { execute } = require('../core/execute');
const output = require('../core/output');
const { callableContract, classifyChange, parseRevision } = require('../core/change-kinds');
const { definiteDependentsOf } = require('../core/deletion');

function git(dir, ...args) {
    return execFileSync('git', ['-c', 'user.email=t@example.test', '-c', 'user.name=t', ...args],
        { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** A repository with `files` committed as its base revision. */
function repo(files) {
    const dir = tmp(files);
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'base');
    return dir;
}

function write(dir, file, content) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content);
}

function edit(dir, file, from, to) {
    const before = fs.readFileSync(path.join(dir, file), 'utf8');
    assert.ok(before.includes(from), `${file} holds the text to replace`);
    fs.writeFileSync(path.join(dir, file), before.replace(from, to));
}

function checked(dir, params = {}) {
    const done = execute(idx(dir), 'check', params);
    assert.ok(done.ok, done.error);
    return done.result;
}

/** `name:kind=verdict(reasons)` for every changed symbol, in output order. */
function verdicts(result) {
    return (result.changed || []).map(item =>
        `${item.name}:${item.kind}=${item.verdict}${item.reasons.length ? `(${item.reasons.join(',')})` : ''}`);
}

describe('change kinds: what a change did to a callable\'s contract', () => {
    const lines = (...rows) => rows.join('\n') + '\n';
    // [label, language, before, after, [startLine, endLine] before, after, expected]
    const CASES = [
        ['py: a statement that names nothing the result is made of', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    print("called")', '    y = x + 1', '    return y'), [1, 3], [1, 4], 'inert'],
        // A statement that only calls something is where a path ends when
        // the callee is declared never to return. Nothing here says what
        // `log` is declared as.
        ['py: a call of something not shown to return', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    log("called")', '    y = x + 1', '    return y'), [1, 3], [1, 4], 'contract:inferred-return-contract'],
        ['py: such a call, handed what is returned', 'python',
            lines('def f(x):', '    log("one")', '    return x'),
            lines('def f(x):', '    log("two", x is None)', '    return x'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: what such a call is passed, when it names nothing returned', 'python',
            lines('def f(x):', '    log("one")', '    return 1'),
            lines('def f(x):', '    log("two")', '    return 1'), [1, 3], [1, 3], 'inert'],
        ['py: a builtin that never returns', 'python',
            lines('def f(x):', '    print(1)', '    return 1'),
            lines('def f(x):', '    exit(1)', '    return 1'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: a builtin name the callable binds itself', 'python',
            lines('def f(x, print):', '    return 1'),
            lines('def f(x, print):', '    print(1)', '    return 1'), [1, 2], [1, 3], 'contract:inferred-return-contract'],
        ['py: a raise that names nothing returned still ends a path', 'python',
            lines('def f(k):', '    if k:', '        return 1', '    raise ValueError(k)'),
            lines('def f(k):', '    if k:', '        return 1', '    print(k)'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        ['py: what is raised changes no type', 'python',
            lines('def f(k):', '    if k:', '        return 1', '    raise ValueError("one")'),
            lines('def f(k):', '    if k:', '        return 1', '    raise KeyError("two")'), [1, 4], [1, 4], 'inert'],
        ['py: a raise moved under a condition', 'python',
            lines('def f(k):', '    raise ValueError()'),
            lines('def f(k):', '    if DEBUG:', '        raise ValueError()'), [1, 2], [1, 3], 'contract:inferred-return-contract'],
        ['py: a loop that now runs forever', 'python',
            lines('def f(q):', '    while q.open():', '        q.step()'),
            lines('def f(q):', '    while True:', '        q.step()'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: a break that became a continue', 'python',
            lines('def f(q):', '    while True:', '        q.step()', '        break'),
            lines('def f(q):', '    while True:', '        q.step()', '        continue'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        ['py: a raise inside a closure ends the closure', 'python',
            lines('def f(k):', '    def inner():', '        print(k)', '    return 1'),
            lines('def f(k):', '    def inner():', '        raise ValueError(k)', '    return 1'), [1, 4], [1, 4], 'inert'],
        // Whether a call narrows or mutates what it is handed is the type
        // checker's knowledge, not the syntax tree's.
        ['py: a call handed a variable the result is made of', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    log(x)', '    y = x + 1', '    return y'), [1, 3], [1, 4],
            'contract:inferred-return-contract'],
        ['py: a mutation of the returned object', 'python',
            lines('def f():', '    xs = []', '    xs.append(1)', '    return xs'),
            lines('def f():', '    xs = []', '    xs.append("text")', '    return xs'), [1, 4], [1, 4],
            'contract:inferred-return-contract'],
        ['py: a condition that narrows the returned name', 'python',
            lines('def f(x):', '    if isinstance(x, int):', '        return x', '    return 0'),
            lines('def f(x):', '    if isinstance(x, str):', '        return x', '    return 0'), [1, 4], [1, 4],
            'contract:inferred-return-contract'],
        ['py: a statement under a condition of the slice', 'python',
            lines('def f(x):', '    if x is None:', '        fail()', '    return x'),
            lines('def f(x):', '    if x is None:', '        warn()', '    return x'), [1, 4], [1, 4],
            'contract:inferred-return-contract'],
        ['py: a closure that assigns the returned name', 'python',
            lines('def f():', '    total = 0', '    def add():', '        nonlocal total', '        total += 1', '    add()', '    return total'),
            lines('def f():', '    total = 0', '    def add():', '        nonlocal total', '        total += "x"', '    add()', '    return total'), [1, 7], [1, 7],
            'contract:inferred-return-contract'],
        ['py: nothing is returned and nothing ends a path differently', 'python',
            lines('def f(x):', '    log(x)'),
            lines('def f(x):', '    y = x', '    log(x, y)'), [1, 2], [1, 3], 'inert'],
        // `None` to its callers, or nothing at all: a function with no
        // result still has ends.
        ['py: nothing is returned, and one more call may not return', 'python',
            lines('def f(x):', '    log(x)'),
            lines('def f(x):', '    log(x)', '    audit(x)'), [1, 2], [1, 3], 'contract:inferred-return-contract'],
        ['py: nothing is returned, and the raise is gone', 'python',
            lines('def f(x):', '    raise ValueError(x)'),
            lines('def f(x):', '    print(x)'), [1, 2], [1, 2], 'contract:inferred-return-contract'],
        ['py: the returned expression', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    y = x + 1', '    return None'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: what a returned name is bound to', 'python',
            lines('def f(x):', '    y = x + 1', '    return y'),
            lines('def f(x):', '    y = str(x)', '    return y'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: a binding nothing returned uses', 'python',
            lines('def f(x):', '    z = 1', '    y = x + 1', '    return y'),
            lines('def f(x):', '    z = 2', '    y = x + 1', '    return y'), [1, 4], [1, 4], 'inert'],
        ['py: a yield makes it a generator', 'python',
            lines('def f(x):', '    return x'),
            lines('def f(x):', '    yield x', '    return x'), [1, 2], [1, 3], 'contract:callable-kind,inferred-return-contract'],
        ['py: a return moved under a condition can fall off the end', 'python',
            lines('def f(x):', '    return x'),
            lines('def f(x):', '    if x:', '        return x'), [1, 2], [1, 3], 'contract:inferred-return-contract'],
        ['py: an annotated return is the contract', 'python',
            lines('def f(x) -> int:', '    return x'),
            lines('def f(x) -> int:', '    return x + 1'), [1, 2], [1, 2], 'inert'],
        ['py: a default value is header', 'python',
            lines('def f(x, y=1):', '    return x'),
            lines('def f(x, y=2):', '    return x'), [1, 2], [1, 2], 'contract:header'],
        ['py: a decorator is header', 'python',
            lines('def f(x):', '    return x'),
            lines('@cache', 'def f(x):', '    return x'), [1, 2], [1, 3], 'contract:header'],
        ['py: a docstring is not', 'python',
            lines('def f(x):', '    """a"""', '    return x'),
            lines('def f(x):', '    """b"""', '    return x'), [1, 3], [1, 3], 'inert'],
        ['py: a reformatted, commented header is the same header', 'python',
            lines('def f(x, y):', '    return x'),
            lines('def f(x,', '      y):  # note', '    return x'), [1, 2], [1, 3], 'inert'],
        ['js: a statement that names nothing the result is made of', 'javascript',
            lines('function f(x) {', '  const y = x + 1;', '  return y;', '}'),
            lines('function f(x) {', '  console.log("called");', '  const y = x + 1;', '  return y;', '}'), [1, 4], [1, 5], 'inert'],
        ['ts: a throw that names nothing returned still ends a path', 'typescript',
            lines('function f(k: string) {', '  if (k === "a") return 1;', '  throw new Error("x");', '}'),
            lines('function f(k: string) {', '  if (k === "a") return 1;', '  console.log("x");', '}'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        ['ts: a member of a value is not shown to return', 'typescript',
            lines('function f(k: string) {', '  return 1;', '}'),
            lines('function f(k: string) {', '  logger.info(k);', '  return 1;', '}'), [1, 3], [1, 4], 'contract:inferred-return-contract'],
        ['ts: an awaited call of one', 'typescript',
            lines('async function f(k: string) {', '  return 1;', '}'),
            lines('async function f(k: string) {', '  await logger.flush();', '  return 1;', '}'), [1, 3], [1, 4], 'contract:inferred-return-contract'],
        ['ts: a global object that a parameter hides', 'typescript',
            lines('function f(console: Sink) {', '  return 1;', '}'),
            lines('function f(console: Sink) {', '  console.log("x");', '  return 1;', '}'), [1, 3], [1, 4], 'contract:inferred-return-contract'],
        ['ts: a loop with no condition', 'typescript',
            lines('function f(q: Queue) {', '  for (; q.open();) {', '    q.step();', '  }', '}'),
            lines('function f(q: Queue) {', '  for (;;) {', '    q.step();', '  }', '}'), [1, 5], [1, 5], 'contract:inferred-return-contract'],
        // A member of the receiver is a reference of its own.
        ['ts: a test of the returned member of the receiver', 'typescript',
            lines('class C {', '  get() {', '    if (this.value === undefined) return 0;', '    return this.value;', '  }', '}'),
            lines('class C {', '  get() {', '    if (this.other === undefined) return 0;', '    return this.value;', '  }', '}'), [2, 5], [2, 5], 'contract:inferred-return-contract', 'C'],
        ['ts: a statement about another member of the receiver', 'typescript',
            lines('class C {', '  get() {', '    this.hits += 1;', '    return this.value;', '  }', '}'),
            lines('class C {', '  get() {', '    this.hits += 2;', '    return this.value;', '  }', '}'), [2, 5], [2, 5], 'inert', 'C'],
        ['ts: a deeper member of the returned member', 'typescript',
            lines('class C {', '  get() {', '    this.value.items.push(1);', '    return this.value;', '  }', '}'),
            lines('class C {', '  get() {', '    this.value.items.push("text");', '    return this.value;', '  }', '}'), [2, 5], [2, 5], 'contract:inferred-return-contract', 'C'],
        ['ts: the receiver handed over whole', 'typescript',
            lines('class C {', '  get() {', '    register(this, 1);', '    return this.value;', '  }', '}'),
            lines('class C {', '  get() {', '    register(this, 2);', '    return this.value;', '  }', '}'), [2, 5], [2, 5], 'contract:inferred-return-contract', 'C'],
        // A receiver whose type is written is whatever that says, a
        // union included: a variable like any other.
        ['ts: a receiver with a written type', 'typescript',
            lines('class C {', '  get(this: A | B) {', '    if (this.kind === "a") return this.size;', '    return 0;', '  }', '}'),
            lines('class C {', '  get(this: A | B) {', '    if (this.kind === "b") return this.size;', '    return 0;', '  }', '}'), [2, 5], [2, 5], 'contract:inferred-return-contract', 'C'],
        ['ts: `this` outside a class is a variable', 'typescript',
            lines('function get() {', '  this.hits += 1;', '  return this.value;', '}'),
            lines('function get() {', '  this.hits += 2;', '  return this.value;', '}'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        ['py: a receiver with a written type', 'python',
            lines('class C:', '    def get(self: "A | B"):', '        if self.kind == "a":', '            return self.size', '        return 0'),
            lines('class C:', '    def get(self: "A | B"):', '        if self.kind == "b":', '            return self.size', '        return 0'), [2, 5], [2, 5], 'contract:inferred-return-contract', 'C'],
        // A test of one member of a variable narrows the variable.
        ['ts: a member of a variable is the variable', 'typescript',
            lines('function f(shape) {', '  if (shape.kind === "circle") return shape.radius;', '  return 0;', '}'),
            lines('function f(shape) {', '  if (shape.kind === "square") return shape.radius;', '  return 0;', '}'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        ['py: a statement about another member of the receiver', 'python',
            lines('class C:', '    def get(self):', '        print(self.hits)', '        return self.value'),
            lines('class C:', '    def get(self):', '        print(self.hits, 1)', '        return self.value'), [2, 4], [2, 4], 'inert', 'C'],
        ['py: a test of the returned member of the receiver', 'python',
            lines('class C:', '    def get(self):', '        if self.value is None:', '            return 0', '        return self.value'),
            lines('class C:', '    def get(self):', '        if self.other is None:', '            return 0', '        return self.value'), [2, 5], [2, 5], 'contract:inferred-return-contract', 'C'],
        ['py: a context manager decides whether its block ends the path', 'python',
            lines('def f():', '    with nullcontext():', '        return 1'),
            lines('def f():', '    with suppress(ValueError):', '        return 1'), [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['py: a condition that names nothing is decided by the checker', 'python',
            lines('def f():', '    if ready():', '        return 1', '    return "text"'),
            lines('def f():', '    if True:', '        return 1', '    return "text"'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        // A Python checker decides some conditions from the names in them
        // (the interpreter version, TYPE_CHECKING, configured constants):
        // a condition that guards a result is part of what is returned.
        ['py: a condition that guards a result', 'python',
            lines('def f(a, b):', '    if a:', '        return 1', '    return "text"'),
            lines('def f(a, b):', '    if b:', '        return 1', '    return "text"'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        ['py: a condition that guards what the result is made of', 'python',
            lines('def f():', '    if TYPE_CHECKING:', '        x = 1', '    else:', '        x = "text"', '    return x'),
            lines('def f():', '    if not TYPE_CHECKING:', '        x = 1', '    else:', '        x = "text"', '    return x'), [1, 6], [1, 6], 'contract:inferred-return-contract'],
        ['py: a loop condition decides whether the code after it is reached', 'python',
            lines('def f(q):', '    while q.open():', '        print(1)', '    return 1'),
            lines('def f(q):', '    while q.closed():', '        print(1)', '    return 1'), [1, 4], [1, 4], 'contract:inferred-return-contract'],
        ['py: a condition that guards nothing returned and ends nothing', 'python',
            lines('def f(a, b):', '    if a:', '        print(1)', '    return 1'),
            lines('def f(a, b):', '    if b:', '        print(1)', '    return 1'), [1, 4], [1, 4], 'inert'],
        // No JavaScript checker decides a condition from a name.
        ['ts: a condition that names something else, guarding the same results', 'typescript',
            lines('function f(a: boolean, b: boolean) {', '  if (a) return 1;', '  return "text";', '}'),
            lines('function f(a: boolean, b: boolean) {', '  if (b) return 1;', '  return "text";', '}'), [1, 4], [1, 4], 'inert'],
        // A switch that covers every value of its subject leaves no way
        // past it, and a label narrows the subject inside its case.
        ['ts: a label of a switch that holds a result', 'typescript',
            lines('function f(k: K) {', '  switch (k) {', '    case "a":', '      return 1;', '    case "b":', '      return 2;', '  }', '}'),
            lines('function f(k: K) {', '  switch (k) {', '    case "a":', '      return 1;', '    case "c":', '      return 2;', '  }', '}'), [1, 8], [1, 8], 'contract:inferred-return-contract'],
        ['ts: the subject of a switch that holds a throw', 'typescript',
            lines('function f(a: K, b: K) {', '  switch (a) {', '    case "x":', '      throw new Error("x");', '  }', '}'),
            lines('function f(a: K, b: K) {', '  switch (b) {', '    case "x":', '      throw new Error("x");', '  }', '}'), [1, 6], [1, 6], 'contract:inferred-return-contract'],
        ['ts: a label of a switch that only leaves itself', 'typescript',
            lines('function f(k: K) {', '  switch (k) {', '    case "a":', '      console.log(1);', '      break;', '  }', '  return 1;', '}'),
            lines('function f(k: K) {', '  switch (k) {', '    case "b":', '      console.log(1);', '      break;', '  }', '  return 1;', '}'), [1, 8], [1, 8], 'inert'],
        ['ts: a declared return type is the contract, whatever ends a path', 'typescript',
            lines('function f(k: string): number {', '  if (k === "a") return 1;', '  throw new Error("x");', '}'),
            lines('function f(k: string): number {', '  if (k === "a") return 1;', '  logger.info(k);', '  return 2;', '}'), [1, 4], [1, 5], 'inert'],
        ['js: a mutation of the returned array', 'javascript',
            lines('function f() {', '  const xs = [];', '  xs.push(1);', '  return xs;', '}'),
            lines('function f() {', '  const xs = [];', '  xs.push("text");', '  return xs;', '}'), [1, 5], [1, 5],
            'contract:inferred-return-contract'],
        ['js: a type guard on the returned name', 'javascript',
            lines('function f(x) {', "  if (typeof x === 'number') return x;", '  return 0;', '}'),
            lines('function f(x) {', "  if (typeof x === 'string') return x;", '  return 0;', '}'), [1, 4], [1, 4],
            'contract:inferred-return-contract'],
        ['js: a return inside a callback is the callback\'s', 'javascript',
            lines('function f(xs) {', '  xs.forEach(x => { return x; });', '}'),
            lines('function f(xs) {', '  xs.forEach(x => { return String(x); });', '}'), [1, 3], [1, 3], 'inert'],
        ['js: an arrow\'s expression body is its result', 'javascript',
            lines('const f = (x) => x + 1;'), lines('const f = (x) => String(x);'), [1, 1], [1, 1],
            'contract:inferred-return-contract'],
        ['js: a destructured binding of a returned name', 'javascript',
            lines('function f(o) {', '  const { a } = o;', '  return a;', '}'),
            lines('function f(o) {', '  const { a } = o.inner;', '  return a;', '}'), [1, 4], [1, 4],
            'contract:inferred-return-contract'],
        ['js: async and the generator star are header', 'javascript',
            lines('function f(x) {', '  return x;', '}'),
            lines('async function* f(x) {', '  return x;', '}'), [1, 3], [1, 3], 'contract:header'],
        ['ts: a declared return type is the contract', 'typescript',
            lines('function f(x: number): number {', '  return x;', '}'),
            lines('function f(x: number): number {', '  return x + 1;', '}'), [1, 3], [1, 3], 'inert'],
        ['ts: no return type, the body is', 'typescript',
            lines('function f(x: number) {', '  return x;', '}'),
            lines('function f(x: number) {', '  return String(x);', '}'), [1, 3], [1, 3],
            'contract:inferred-return-contract'],
        ['ts: a parameter type', 'typescript',
            lines('function f(x: number) {', '  return 1;', '}'),
            lines('function f(x: string) {', '  return 1;', '}'), [1, 3], [1, 3], 'contract:header'],
        ['go: the header is the whole contract', 'go',
            lines('package p', '', 'func f(x int) int {', '\treturn x', '}'),
            lines('package p', '', 'func f(x int) int {', '\treturn x + 1', '}'), [3, 5], [3, 5], 'inert'],
        ['go: a parameter', 'go',
            lines('package p', '', 'func f(x int) int {', '\treturn x', '}'),
            lines('package p', '', 'func f(x int, y int) int {', '\treturn x', '}'), [3, 5], [3, 5], 'contract:header'],
        ['java: a body edit', 'java',
            lines('class A {', '    int f(int x) {', '        return x;', '    }', '}'),
            lines('class A {', '    int f(int x) {', '        return x + 1;', '    }', '}'), [2, 4], [2, 4], 'inert'],
        ['java: a throws clause', 'java',
            lines('class A {', '    int f(int x) {', '        return x;', '    }', '}'),
            lines('class A {', '    int f(int x) throws Exception {', '        return x;', '    }', '}'), [2, 4], [2, 4],
            'contract:header'],
        ['rust: a declared return type', 'rust',
            lines('fn f(x: i32) -> i32 {', '    x', '}'), lines('fn f(x: i32) -> i32 {', '    x + 1', '}'),
            [1, 3], [1, 3], 'inert'],
        ['rust: an opaque return type exposes the body', 'rust',
            lines('fn f() -> impl Iterator<Item = i32> {', '    vec![1].into_iter()', '}'),
            lines('fn f() -> impl Iterator<Item = i32> {', '    std::iter::once(1)', '}'), [1, 3], [1, 3],
            'contract:inferred-return-contract'],
        ['rust: an attribute is header', 'rust',
            lines('fn f(x: i32) -> i32 {', '    x', '}'), lines('#[inline]', 'fn f(x: i32) -> i32 {', '    x', '}'),
            [1, 3], [2, 4], 'contract:header'],
        ['c++: a placeholder return type is deduced from the body', 'cpp',
            lines('auto f(int x) {', '    return x;', '}'), lines('auto f(int x) {', '    return x + 1.5;', '}'),
            [1, 3], [1, 3], 'contract:inferred-return-contract'],
        ['c++: a declared return type', 'cpp',
            lines('int f(int x) {', '    return x;', '}'), lines('int f(int x) {', '    return x + 1;', '}'),
            [1, 3], [1, 3], 'inert'],
        ['c#: an attribute is header', 'csharp',
            lines('class A {', '    int F(int x) {', '        return x;', '    }', '}'),
            lines('class A {', '    [Obsolete]', '    int F(int x) {', '        return x;', '    }', '}'), [2, 4], [2, 5],
            'contract:header'],
    ];
    // The optional last column is the class a method row belongs to.
    for (const [label, language, before, after, was, is, expected, className] of CASES) {
        it(label, () => {
            const change = classifyChange(
                callableContract(parseRevision(before, language), language, { startLine: was[0], endLine: was[1], className }),
                callableContract(parseRevision(after, language), language, { startLine: is[0], endLine: is[1], className }),
                language);
            assert.strictEqual(change.kind === 'inert' ? 'inert' : `${change.kind}:${change.reasons.join(',')}`, expected);
        });
    }

    it('a contract that cannot be read is unknown, never inert', () => {
        const contract = callableContract(parseRevision('def f(x):\n    return x\n', 'python'), 'python',
            { startLine: 1, endLine: 2 });
        assert.deepStrictEqual(classifyChange(null, contract, 'python'),
            { kind: 'unknown', reasons: ['contract-unreadable'] });
        assert.strictEqual(callableContract(parseRevision('x = 1\n', 'python'), 'python', { startLine: 7, endLine: 9 }), null);
    });
});

describe('check: a verdict per changed symbol, by what the change did', () => {
    const APP = [
        'def helper(x):',
        '    y = x + 1',
        '    return y',
        '',
        '',
        'def caller():',
        '    return helper(1) + helper(2)',
        '',
        '',
        'def gone():',
        '    return 3',
        '',
        '',
        'def user():',
        '    return gone()',
        '',
    ].join('\n');

    // [label, edit(dir), expected trust, expected verdicts]
    const SCENARIOS = [
        ['an inert body edit is ready, whatever calls it',
            dir => edit(dir, 'app.py', '    y = x + 1\n', '    print("called")\n    y = x + 1\n'),
            'READY_FOR_TOOLCHAIN', ['helper:modified=ready']],
        ['a statement handed what the result is made of is review: it may narrow or mutate it',
            dir => edit(dir, 'app.py', '    y = x + 1\n', '    print(x)\n    y = x + 1\n'),
            'REVIEW_REQUIRED', ['helper:modified=review(inferred-return-contract)']],
        ['a comment is an inert edit',
            dir => edit(dir, 'app.py', '    y = x + 1\n', '    y = x + 1  # note\n'),
            'READY_FOR_TOOLCHAIN', ['helper:modified=ready']],
        ['a changed inferred return is review',
            dir => edit(dir, 'app.py', '    return y\n', '    return None\n'),
            'REVIEW_REQUIRED', ['helper:modified=review(inferred-return-contract)']],
        ['a body that now yields is review',
            dir => edit(dir, 'app.py', '    y = x + 1\n', '    yield x\n    y = x + 1\n'),
            'REVIEW_REQUIRED', ['helper:modified=review(callable-kind,inferred-return-contract)']],
        ['a required parameter that call sites do not pass is a break',
            dir => edit(dir, 'app.py', 'def helper(x):', 'def helper(x, must):'),
            'BLOCKED', ['helper:modified=blocked(signature-mismatch,header)']],
        ['an optional parameter fits every call site: review, not a break',
            dir => edit(dir, 'app.py', 'def helper(x):', 'def helper(x, opt=None):'),
            'REVIEW_REQUIRED', ['helper:modified=review(header)']],
        ['a changed header nothing depends on is ready',
            dir => edit(dir, 'app.py', 'def user():', 'def user(flag=False):'),
            'READY_FOR_TOOLCHAIN', ['user:modified=ready']],
        ['a deleted function that is still called is a break',
            dir => edit(dir, 'app.py', 'def gone():\n    return 3\n\n\n', ''),
            'BLOCKED', ['gone:deleted=blocked(still-referenced)']],
        ['a deleted function nothing names is ready',
            dir => edit(dir, 'app.py', '\n\ndef user():\n    return gone()\n', '\n'),
            'READY_FOR_TOOLCHAIN', ['user:deleted=ready']],
        ['a new file under new names is ready',
            dir => write(dir, 'fresh.py', 'def brand_new_thing(a):\n    return a\n'),
            'READY_FOR_TOOLCHAIN', ['brand_new_thing:added=ready']],
        ['a new function and the new code that calls it are ready',
            dir => write(dir, 'app.py', APP +
                '\n\ndef brand_new_thing(a):\n    return a\n\n\ndef brand_new_user():\n    return brand_new_thing(1)\n'),
            'READY_FOR_TOOLCHAIN', ['brand_new_thing:added=ready', 'brand_new_user:added=ready']],
    ];
    for (const [label, change, trust, expected] of SCENARIOS) {
        it(label, () => {
            const dir = repo({ 'app.py': APP });
            try {
                change(dir);
                const result = checked(dir);
                assert.deepStrictEqual([result.trust.status, verdicts(result)], [trust, expected]);
                assert.strictEqual(result.trust.passes, trust !== 'BLOCKED');
            } finally { rm(dir); }
        });
    }

    it('a new function whose name existing code already uses is review, with the sites', () => {
        const dir = repo({ 'app.py': APP.replace('    return gone()\n', '    return gone() + later()\n') });
        try {
            write(dir, 'app.py', fs.readFileSync(path.join(dir, 'app.py'), 'utf8') + '\n\ndef later():\n    return 1\n');
            const result = checked(dir);
            assert.deepStrictEqual([result.trust.status, verdicts(result)],
                ['REVIEW_REQUIRED', ['later:added=review(name-in-use)']]);
            assert.deepStrictEqual(result.changed[0].sites, [{ file: 'app.py', line: 15 }]);
        } finally { rm(dir); }
    });

    it('--strict makes review fail; a break fails either way; ready passes either way', () => {
        const dir = repo({ 'app.py': APP });
        try {
            edit(dir, 'app.py', 'def helper(x):', 'def helper(x, opt=None):');
            assert.strictEqual(runCliStatus(dir, 'check'), 0);
            assert.strictEqual(runCliStatus(dir, 'check', '--strict'), 1);
            const strict = checked(dir, { strict: true });
            assert.deepStrictEqual([strict.trust.status, strict.trust.passes, strict.trust.strict],
                ['REVIEW_REQUIRED', false, true]);
            assert.match(output.formatCheck(strict), /strict: review does not pass/);
            edit(dir, 'app.py', 'def helper(x, opt=None):', 'def helper(x, must):');
            assert.strictEqual(runCliStatus(dir, 'check'), 1);
            edit(dir, 'app.py', 'def helper(x, must):', 'def helper(x):');
            edit(dir, 'app.py', '    y = x + 1\n', '    print("called")\n    y = x + 1\n');
            assert.strictEqual(runCliStatus(dir, 'check', '--strict'), 0);
        } finally { rm(dir); }
    });

    it('lists every call site of a break: thirteen sites are thirteen lines', () => {
        const calls = Array.from({ length: 13 }, (_, i) => `    total += widened(${i})`).join('\n');
        const dir = repo({
            'lib.py': 'def widened(a):\n    return a\n',
            'use.py': `from lib import widened\n\n\ndef run():\n    total = 0\n${calls}\n    return total\n`,
        });
        try {
            edit(dir, 'lib.py', 'def widened(a):', 'def widened(a, b):');
            const result = checked(dir);
            assert.strictEqual(result.trust.status, 'BLOCKED');
            assert.strictEqual(result.changed[0].mismatches.length, 13);
            const text = output.formatCheck(result);
            assert.strictEqual((text.match(/↳ use\.py:\d+ {2}total \+= widened\(\d+\) {2}expected 2 arg\(s\), got 1/g) || []).length, 13);
            assert.match(text, /BLOCKED \(1\) — a break was observed:/);
        } finally { rm(dir); }
    });

    it('counts caller evidence only where callers matter', () => {
        // An inert edit of a function with an unverified caller: nothing to
        // review, and the trust line does not say there is.
        const dir = repo({
            'a.js': 'function run(x) {\n  const y = x;\n  return y;\n}\nmodule.exports = { run };\n',
            'b.js': 'function go(obj) {\n  return obj.run(1);\n}\nmodule.exports = { go };\n',
        });
        try {
            edit(dir, 'a.js', '  const y = x;\n', '  console.log("called");\n  const y = x;\n');
            const result = checked(dir);
            assert.deepStrictEqual([result.trust.status, result.trust.unverifiedCallSites, result.trust.incompleteAccounts],
                ['READY_FOR_TOOLCHAIN', 0, 0]);
            assert.ok(result.changed[0].unverifiedCallerCount > 0, 'the candidate is still reported on the item');
        } finally { rm(dir); }
    });
});

function runCliStatus(dir, ...args) {
    try {
        execFileSync(process.execPath, [path.join(__dirname, '..', 'cli', 'index.js'), dir, ...args, '--no-cache'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
        return 0;
    } catch (error) {
        return error.status;
    }
}
void runCli;

describe('check: one change each, and whether it breaks code the change did not touch', () => {
    // eval/check-matrix-cases.js: `expect` is what the language's own
    // toolchain says about the change (judged by eval/run-check-matrix.js,
    // not here); `answer` and `detail` are the check's. Each change is
    // asked twice: against the worktree, and staged, from a snapshot
    // exported from the git index.
    const { CASES } = require('../eval/check-matrix-cases');
    const { materialize, answersFor, answerOf, detailOf } = require('../eval/run-check-matrix');
    for (const testCase of CASES) {
        it(`${testCase.id}: ${testCase.answer}`, () => {
            const dir = materialize(testCase);
            try {
                const { worktree, staged } = answersFor(testCase, dir);
                assert.deepStrictEqual([answerOf(worktree), detailOf(worktree)], [testCase.answer, testCase.detail]);
                assert.deepStrictEqual([answerOf(staged), detailOf(staged)], [testCase.answer, testCase.detail],
                    'the staged tree answers as the worktree does');
            } finally { rm(dir); }
        });
    }

    it('never passes a change the toolchain rejects, never calls a clean one a break', () => {
        const passes = answer => answer === 'READY_FOR_TOOLCHAIN' || answer === 'NO-CHANGES';
        for (const testCase of CASES) {
            if (testCase.expect === 'break') assert.ok(!passes(testCase.answer), testCase.id);
            else assert.notStrictEqual(testCase.answer, 'BLOCKED', testCase.id);
        }
        // Every language has a change that is READY and one that is a
        // break: asking for review of everything would pass the half above.
        for (const lang of new Set(CASES.map(testCase => testCase.lang))) {
            const ofLang = CASES.filter(testCase => testCase.lang === lang);
            assert.ok(ofLang.some(testCase => testCase.answer === 'READY_FOR_TOOLCHAIN'), `${lang}: a ready change`);
            assert.ok(ofLang.some(testCase => testCase.answer === 'BLOCKED'), `${lang}: an observed break`);
        }
    });
});

describe('check: the answer survives a character budget', () => {
    const { applyOutputBudget } = require('../core/output-budget');
    const calls = Array.from({ length: 40 }, (_, i) => `    total += widened(${i})`).join('\n');
    const files = {
        'lib.py': 'def widened(a):\n    return a\n\n\ndef tidy(a):\n    b = a\n    return b\n',
        'use.py': `from lib import widened, tidy\n\n\ndef run():\n    total = tidy(0)\n${calls}\n    return total\n`,
    };

    it('keeps the verdict and a head of every verdict section', () => {
        const dir = repo(files);
        try {
            edit(dir, 'lib.py', 'def widened(a):', 'def widened(a, b):');
            edit(dir, 'lib.py', '    b = a\n', '    print("called")\n    b = a\n');
            write(dir, 'fresh.py', 'def brand_new_one():\n    return 1\n');
            const full = output.formatCheck(checked(dir));
            assert.strictEqual((full.match(/↳ use\.py:/g) || []).length, 40);
            const cut = applyOutputBudget(full, { command: 'check', maxChars: 1200 }).text;
            assert.ok(cut.length <= 1200);
            assert.match(cut, /^TRUST: BLOCKED — /m);
            // Forty breaks do not push what is ready out of the answer.
            assert.match(cut, /BLOCKED \(1\) — a break was observed:\n {2}widened \(lib\.py:1\)/);
            assert.match(cut, /\.\.\. \+\d+ more/);
            assert.match(cut, /READY \(2\) — nothing that existed depends on the change:\n {2}tidy \(lib\.py:5\) \[MODIFIED, contract unchanged\]/);
            // A budget too small for any section still states the verdict.
            const tiny = applyOutputBudget(full, { command: 'check', maxChars: 300 }).text;
            assert.ok(tiny.length <= 300);
            assert.match(tiny, /TRUST: BLOCKED — UCN evidence is not semantic proof; compiler and tests are required/);
        } finally { rm(dir); }
    });
});

describe('review items: one count for the check, the caller listing and the oracle eval', () => {
    const { reviewItemsOf, uncertaintyClassOf, partitionUnverified } = require('../core/review-items');
    const sites = [
        { reason: 'no-binding-evidence' },
        { reason: 'receiver-untyped' },
        // One interface boundary, three sites: one thing to look at.
        { reason: 'possible-dispatch', dispatchVia: 'Shape', dispatchCandidates: 4 },
        { reason: 'possible-dispatch', dispatchVia: 'Shape', dispatchCandidates: 4 },
        { uncertaintyClass: 'runtime-dispatch', dispatchVia: 'Shape', dispatchCandidates: 4 },
        { reason: 'possible-dispatch', dispatchVia: 'Writer', dispatchCandidates: 2, externalContract: true },
        // A template family the compiler instantiates.
        { uncertaintyClass: 'compile-time-dispatch', dispatchFamily: 'emit<T>', dispatchCandidates: 3 },
        { uncertaintyClass: 'compile-time-dispatch', dispatchFamily: 'emit<T>', dispatchCandidates: 3 },
    ];

    it('charges a site a reader can settle once, and a dispatch family once', () => {
        assert.deepStrictEqual(reviewItemsOf(sites), {
            actionable: 2,
            runtimeDispatchSites: 4,
            runtimeDispatchGroups: 2,
            compileTimeDispatchSites: 2,
            compileTimeDispatchGroups: 1,
            items: 5,
        });
        assert.deepStrictEqual(reviewItemsOf([]).items, 0);
        assert.deepStrictEqual(reviewItemsOf(undefined).items, 0);
    });

    it('the class the engine recorded wins; every site has exactly one class', () => {
        assert.strictEqual(uncertaintyClassOf({ reason: 'possible-dispatch', dispatchVia: 'X' }), 'runtime-dispatch');
        assert.strictEqual(uncertaintyClassOf({ reason: 'possible-dispatch' }), 'actionable-ambiguity');
        assert.strictEqual(uncertaintyClassOf({
            uncertaintyClass: 'compile-time-dispatch', reason: 'possible-dispatch', dispatchVia: 'X',
        }), 'compile-time-dispatch');
        const parts = partitionUnverified(sites);
        assert.strictEqual(parts.actionable.length + parts.runtime.length + parts.compileTime.length, sites.length);
    });
});

describe('check: deletions are assessed from the base declaration', () => {
    it('an import of the name from its former module is a break; a module-path call is review', () => {
        const dir = repo({
            'm.py': 'def gone():\n    return 1\n\n\ndef other():\n    return 2\n',
            'named.py': 'from m import gone\n\nprint(gone())\n',
            'pathed.py': 'import m\n\nprint(m.other())\n',
        });
        try {
            edit(dir, 'm.py', 'def gone():\n    return 1\n\n\n', '');
            let result = checked(dir);
            assert.deepStrictEqual(verdicts(result), ['gone:deleted=blocked(still-referenced)']);
            assert.deepStrictEqual(result.changed[0].sites, [{ file: 'named.py', line: 1, kind: 'import' }]);
            // Reached through the module, never imported by name: the name
            // is still used, and nothing proves the use breaks.
            write(dir, 'named.py', 'import m\n\nprint(m.gone())\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'by module path');
            write(dir, 'm.py', 'def gone():\n    return 1\n\n\ndef other():\n    return 2\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'restore');
            edit(dir, 'm.py', 'def gone():\n    return 1\n\n\n', '');
            result = checked(dir);
            assert.deepStrictEqual(verdicts(result), ['gone:deleted=review(name-still-used)']);
            assert.strictEqual(result.trust.status, 'REVIEW_REQUIRED');
        } finally { rm(dir); }
    });

    it('a bare call is a break only where the language says the name has nothing left to mean', () => {
        for (const [file, base, removed, expected] of [
            // A parameter and a local of the same name are not the function.
            ['m.py', 'def gone():\n    return 1\n\n\ndef a():\n    return gone()\n\n\ndef b(gone):\n    return gone()\n\n\ndef c():\n    gone = lambda: 2\n    return gone()\n',
                'def gone():\n    return 1\n\n\n', [{ file: 'm.py', line: 2, kind: 'call' }]],
            ['m.js', 'function gone() { return 1; }\nfunction a() { return gone(); }\nfunction b(gone) { return gone(); }\nfunction c() { const gone = () => 2; return gone(); }\na(); b(); c();\n',
                'function gone() { return 1; }\n', [{ file: 'm.js', line: 1, kind: 'call' }]],
            ['m.rs', 'fn gone() -> i32 { 1 }\nfn a() -> i32 { gone() }\nfn c() -> i32 { let gone = || 2; gone() }\n',
                'fn gone() -> i32 { 1 }\n', [{ file: 'm.rs', line: 1, kind: 'call' }]],
            // Rebound at module scope: the call still has a meaning.
            ['r.py', 'def gone():\n    return 1\n\n\ngone = len\n\n\ndef a():\n    return gone([])\n',
                'def gone():\n    return 1\n\n\n', []],
        ]) {
            const dir = repo({ [file]: base });
            try {
                const before = idx(dir);
                const record = JSON.parse(JSON.stringify((before.symbols.get('gone') || [])
                    .find(definition => definition.type === 'function' && definition.startLine === 1)));
                edit(dir, file, removed, '');
                assert.deepStrictEqual(definiteDependentsOf(idx(dir), record), expected, file);
            } finally { rm(dir); }
        }
    });

    it('a directory package: a call in a sibling file is a break', () => {
        const dir = repo({
            'go.mod': 'module example.com/m\n\ngo 1.21\n',
            'm.go': 'package m\n\nfunc gone() int { return 1 }\n',
            'n.go': 'package m\n\nfunc a() int { return gone() }\nfunc c() int { gone := func() int { return 2 }; return gone() }\n',
        });
        try {
            edit(dir, 'm.go', 'func gone() int { return 1 }\n', '');
            const result = checked(dir);
            assert.deepStrictEqual(verdicts(result), ['gone:deleted=blocked(still-referenced)']);
            assert.deepStrictEqual(result.changed[0].sites, [{ file: 'n.go', line: 3, kind: 'call' }]);
        } finally { rm(dir); }
    });

    it('a registered handler and an exported library function are never ready to delete', () => {
        const dir = repo({
            'package.json': '{"name":"lib","main":"index.js"}',
            'index.js': 'function publicApi() { return 1; }\nfunction keep() { return 2; }\nmodule.exports = { publicApi, keep };\n',
            'web.py': 'from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.route("/health")\ndef health():\n    return "ok"\n\n\ndef keep():\n    return 1\n',
        });
        try {
            edit(dir, 'index.js', 'function publicApi() { return 1; }\n', '');
            edit(dir, 'index.js', 'module.exports = { publicApi, keep };', 'module.exports = { keep };');
            edit(dir, 'web.py', '@app.route("/health")\ndef health():\n    return "ok"\n\n\n', '');
            const result = checked(dir);
            const byName = Object.fromEntries(result.changed.map(item => [item.name, item]));
            // Zero occurrences left in the repository, both of them.
            assert.deepStrictEqual([byName.publicApi.verdict, byName.publicApi.reasons],
                ['review', ['downstream-exposure']]);
            assert.deepStrictEqual([byName.health.verdict, byName.health.reasons], ['review', ['registered']]);
            assert.strictEqual(result.trust.status, 'REVIEW_REQUIRED');
        } finally { rm(dir); }
    });
});

describe('check: what a change did to a module outside its declarations', () => {
    const moduleItem = result => (result.changed || []).find(item => item.kind === 'module');

    it('a name imported from somewhere else means something else everywhere in the file', () => {
        const dir = repo({
            'a.ts': 'export function load(): number {\n  return 1;\n}\n',
            'b.ts': 'export function load(): string {\n  return "one";\n}\n',
            'lib.ts': 'import { load } from "./a";\nexport function value() {\n  return load();\n}\n',
        });
        try {
            edit(dir, 'lib.ts', 'from "./a"', 'from "./b"');
            const item = moduleItem(checked(dir));
            assert.deepStrictEqual([item.file, item.verdict, item.reasons], ['lib.ts', 'review', ['import-rebound']]);
        } finally { rm(dir); }
    });

    it('an import written as a call is an import: adding a name to it is not module code', () => {
        const dir = repo({
            'shared.js': 'function a() { return 1; }\nfunction b() { return 2; }\nmodule.exports = { a, b };\n',
            'lib.js': 'const { a } = require("./shared");\nfunction keep() { return a(); }\nmodule.exports = { keep };\n',
        });
        try {
            write(dir, 'lib.js', 'const { a, b } = require("./shared");\nfunction keep() { return a() + b(); }\nmodule.exports = { keep };\n');
            const result = checked(dir);
            assert.strictEqual(moduleItem(result), undefined);
        } finally { rm(dir); }
    });

    it('an import dropped for what importing it did is review; one whose name is unused is not', () => {
        const dir = repo({
            'polyfill.js': 'globalThis.ready = true;\n',
            'util.js': 'function a() { return 1; }\nmodule.exports = { a };\n',
            'lib.js': 'require("./polyfill");\nconst { a } = require("./util");\nfunction keep() { return 2; }\nmodule.exports = { keep };\n',
        });
        try {
            // The unused binding goes: nothing in the file wrote `a`.
            write(dir, 'lib.js', 'require("./polyfill");\nfunction keep() { return 2; }\nmodule.exports = { keep };\n');
            assert.strictEqual(moduleItem(checked(dir)), undefined);
            // The side-effect import goes too.
            write(dir, 'lib.js', 'function keep() { return 2; }\nmodule.exports = { keep };\n');
            const item = moduleItem(checked(dir));
            assert.deepStrictEqual([item.verdict, item.reasons], ['review', ['imports-removed']]);
        } finally { rm(dir); }
    });

    it('an import whose name the file still uses is review, with the uses', () => {
        const dir = repo({
            'util.py': 'def helper():\n    return 1\n',
            'lib.py': 'from util import helper\n\n\ndef keep():\n    return helper()\n',
        });
        try {
            write(dir, 'lib.py', 'def keep():\n    return helper()\n');
            const item = moduleItem(checked(dir));
            assert.deepStrictEqual([item.verdict, item.reasons], ['review', ['import-removed-still-used']]);
            assert.deepStrictEqual(item.sites, [{ file: 'lib.py', line: 2, kind: 'uses helper' }]);
        } finally { rm(dir); }
    });

    it('loose module code is review in a module and nothing in a test file', () => {
        const dir = repo({
            'lib.py': 'def keep():\n    return 2\n\n\nprint(keep())\n',
            'tests/test_lib.py': 'from lib import keep\n\nassert keep() == 2\n',
        });
        try {
            write(dir, 'lib.py', 'def keep():\n    return 2\n\n\nprint(keep() + 1)\n');
            write(dir, 'tests/test_lib.py', 'from lib import keep\n\nassert keep() == 2\nassert keep() != 3\n');
            const result = checked(dir);
            const items = result.changed.filter(item => item.kind === 'module');
            assert.deepStrictEqual(items.map(item => [item.file, item.reasons]), [['lib.py', ['module-level-code']]]);
        } finally { rm(dir); }
    });

    it('a diff that only un-exports a name still imported is a break, not "no changes"', () => {
        const dir = repo({
            'lib.js': 'function a() { return 1; }\nfunction b() { return 2; }\nmodule.exports = { a, b };\n',
            'use.js': 'const { a, b } = require("./lib");\nmodule.exports = { run: () => a() + b() };\n',
        });
        try {
            write(dir, 'lib.js', 'function a() { return 1; }\nfunction b() { return 2; }\nb();\nmodule.exports = { a };\n');
            const result = checked(dir);
            assert.strictEqual(result.empty, undefined);
            assert.strictEqual(result.trust.status, 'BLOCKED');
            const item = moduleItem(result);
            assert.deepStrictEqual([item.verdict, item.reasons, item.sites],
                ['blocked', ['no-longer-provided'], [{ file: 'use.js', line: 1, kind: 'import b' }]]);
            assert.match(output.formatCheck(result), /\(module\) \(lib\.js:1\) \[MODULE, no-longer-provided\]\n {4}↳ use\.js:1 {2}import b/);
        } finally { rm(dir); }
    });
});

describe('check: a declaration that says nothing about never returning', () => {
    const { declaresPlainReturn } = require('../core/change-kinds');
    const plain = (language, source, startLine, endLine, never) =>
        declaresPlainReturn(parseRevision(source, language), { startLine, endLine: endLine || startLine }, never);
    it('typescript', () => {
        const never = ['never'];
        const ROWS = [
            ['function f() { g(); }', true],
            ['function f(): void { g(); }', true],
            ['function f(): number { return 1; }', true],
            ['function f(): never { throw new Error(); }', false],
            // An alias may name `never`.
            ['function f(): Stop { throw new Error(); }', false],
            ['function f(): Promise<void> { return g(); }', false],
            ['const f = () => { g(); };', true],
            ['const f = function () { g(); };', true],
            // The variable's type is the function's.
            ['const f: Failer = () => { g(); };', false],
            ['const f: Failer = function () { g(); };', false],
            // No body: an overload signature says what the implementation does not.
            ['declare function f(): void;', false],
        ];
        for (const [source, expected] of ROWS) assert.strictEqual(plain('typescript', `${source}\n`, 1, 1, never), expected, source);
        const inClass = 'class Box {\n  plain() { g(); }\n  stop(): never { throw new Error(); }\n  typed: Failer = () => { g(); };\n  held = () => { g(); };\n  @bound decorated() { g(); }\n}\n';
        assert.deepStrictEqual([2, 3, 4, 5, 6].map(line => plain('typescript', inClass, line, line, never)),
            [true, false, false, true, false]);
    });
    it('python', () => {
        const never = ['NoReturn', 'Never'];
        const ROWS = [
            ['def f():\n    g()\n', 1, 2, true],
            ['def f() -> None:\n    g()\n', 1, 2, true],
            ['def f() -> NoReturn:\n    raise ValueError()\n', 1, 2, false],
            ['def f() -> typing.NoReturn:\n    raise ValueError()\n', 1, 2, false],
            ['def f() -> "NoReturn":\n    raise ValueError()\n', 1, 2, false],
            // Any other name may be an alias of one.
            ['def f() -> Stop:\n    raise ValueError()\n', 1, 2, false],
            // A decorator can replace the function.
            ['@wraps\ndef f():\n    g()\n', 2, 3, false],
        ];
        for (const [source, start, end, expected] of ROWS) assert.strictEqual(plain('python', source, start, end, never), expected, source);
    });
});

describe('check: what the project\'s own judge looks at', () => {
    const { langTraits } = require('../languages');
    // What each checker's own scanner reads as "do not report this",
    // measured form by form against tsc and pyright.
    const silenced = (language, source, line, diagnostic = { kind: 'arity', name: 'f' }) => {
        const lines = source.split('\n');
        return langTraits(language).checkSuppressedAt({
            ...diagnostic, line, lines, root: parseRevision(source, language), memo: new Map(),
        });
    };
    it('typescript: a directive starts its comment and sits above the reported line', () => {
        const ROWS = [
            ['// @ts-ignore\nf(1);\n', 2, true],
            ['// @ts-ignore\n\nf(1);\n', 3, true],
            ['// @ts-ignore\n// another comment\nf(1);\n', 3, true],
            ['/* @ts-ignore */\nf(1);\n', 2, true],
            ['const a = 1; // @ts-ignore\nf(1);\n', 2, true],
            ['//@ts-ignore\nf(1);\n', 2, true],
            ['// @ts-expect-error on purpose\nf(1);\n', 2, true],
            // The scanner matches a prefix.
            ['// @ts-ignored\nf(1);\n', 2, true],
            // Not at the start of its comment.
            ['// see @ts-ignore\nf(1);\n', 2, false],
            ['/* text @ts-ignore */\nf(1);\n', 2, false],
            ['/**\n * @ts-ignore\n */\nf(1);\n', 4, false],
            // Only blank lines and `//` comments may stand between.
            ['// @ts-ignore\n/* a block comment */\nf(1);\n', 3, false],
            ['// @ts-ignore\ng(1);\nf(1);\n', 3, false],
            // A call over several lines is reported at the callee's name.
            ['// @ts-ignore\nf(\n  1,\n);\n', 2, true],
            ['f(\n  // @ts-ignore\n  1,\n);\n', 1, false],
        ];
        for (const [source, line, expected] of ROWS) assert.strictEqual(silenced('typescript', source, line), expected, source);
        // A member call is reported at the member's name.
        assert.strictEqual(silenced('typescript', 'k\n  // @ts-ignore\n  .f(1);\n', 3), true);
        assert.strictEqual(silenced('typescript', '// @ts-ignore\nk\n  .f(1);\n', 3), false);
        // One argument too many is reported at that argument.
        const tooMany = { kind: 'arity', name: 'f', most: 1 };
        assert.strictEqual(silenced('typescript', 'f(\n  1,\n  // @ts-ignore\n  2,\n);\n', 1, tooMany), true);
        assert.strictEqual(silenced('typescript', '// @ts-ignore\nf(\n  1,\n  2,\n);\n', 2, tooMany), false);
        // An import is reported at the name, or at the module string.
        const named = { kind: 'import-name', name: 'gone' };
        assert.strictEqual(silenced('typescript', 'import {\n  // @ts-ignore\n  gone,\n} from "./lib";\n', 1, named), true);
        assert.strictEqual(silenced('typescript', '// @ts-ignore\nimport {\n  gone,\n} from "./lib";\n', 2, named), false);
        assert.strictEqual(silenced('typescript', 'import { x } from\n  // @ts-ignore\n  "./gone";\n', 1, { kind: 'import-module' }), true);
        assert.strictEqual(langTraits('javascript').checkSuppressedAt, null, 'no checker, nothing to suppress');
    });

    it('typescript: `@ts-nocheck` is a `//` comment before the first token', () => {
        const ROWS = [
            ['// @ts-nocheck\nf(1);\n', 2, true],
            ['\n\n// @ts-nocheck\nf(1);\n', 4, true],
            ['#!/usr/bin/env node\n// license\n\n/* more */\n// @ts-nocheck\nf(1);\n', 6, true],
            ['/* @ts-nocheck */\nf(1);\n', 2, false],
            ['// note @ts-nocheck\nf(1);\n', 2, false],
            ['/**\n * @ts-nocheck\n */\nf(1);\n', 4, false],
            ['g(1);\n// @ts-nocheck\n\nf(1);\n', 4, false],
        ];
        for (const [source, line, expected] of ROWS) assert.strictEqual(silenced('typescript', source, line), expected, source);
    });

    it('typescript: of `@ts-nocheck` and `@ts-check`, the last one decides', () => {
        const ROWS = [
            ['// @ts-nocheck\n// @ts-check\nf(1);\n', 3, false],
            ['// @ts-check\n// @ts-nocheck\nf(1);\n', 3, true],
            ['// @ts-nocheck\n// @ts-check\n// @ts-nocheck\nf(1);\n', 4, true],
            ['// @ts-nocheck\n\n/* note */\n// @ts-check\nf(1);\n', 5, false],
            // A pragma is a `//` comment before the first token, whatever its case.
            ['// @ts-nocheck\n/* @ts-check */\nf(1);\n', 3, true],
            ['// @ts-nocheck\ng(1);\n// @ts-check\nf(1);\n', 4, true],
            ['// @TS-NOCHECK\nf(1);\n', 2, true],
            ['// @ts-nocheck\n// @TS-CHECK\nf(1);\n', 3, false],
            // Its name ends at a space or a colon, and is the whole name.
            ['// @ts-nocheck: generated\nf(1);\n', 2, true],
            ['// @ts-nochecked\nf(1);\n', 2, false],
            ['// @ts-nocheck\n// @ts-checked\nf(1);\n', 3, true],
        ];
        for (const [source, line, expected] of ROWS) assert.strictEqual(silenced('typescript', source, line), expected, source);
    });

    it('python: a level the checker does not know leaves the rule on', () => {
        const ROWS = [
            ['# pyright: reportCallIssue=False\nf(1)\n', 2, false],
            ['# pyright: reportcallissue=false\nf(1)\n', 2, false],
            ['# Pyright: reportCallIssue=false\nf(1)\n', 2, false],
            ['# pyright: reportCallIssue=false\n# pyright: basic\nf(1)\n', 3, false],
            ['# pyright: reportCallIssue=false\n# pyright: reportCallIssue=true\nf(1)\n', 3, false],
            ['# pyright: reportCallIssue=true\n# pyright: reportCallIssue=false\nf(1)\n', 3, true],
            // Within one comment the rule set is chosen first.
            ['# pyright: reportCallIssue=false, basic\nf(1)\n', 2, true],
            ['# type: ignore\n# pyright: strict\nf(1)\n', 3, true],
        ];
        for (const [source, line, expected] of ROWS) assert.strictEqual(silenced('python', source, line), expected, source);
    });

    it('the call is the one that was measured, by where it is in the source', () => {
        // Two calls on a line, an alias, a nested call: the span says which.
        const at = (source, text) => ({ start: source.indexOf(text), end: source.indexOf(text) + text.length });
        const two = 'f(1); f(1,\n// @ts-ignore\n2);\n';
        const tooMany = { kind: 'arity', name: 'f', most: 1 };
        assert.strictEqual(silenced('typescript', two, 1, { ...tooMany, span: at(two, 'f(1,\n// @ts-ignore\n2)') }), true);
        assert.strictEqual(silenced('typescript', two, 1, { ...tooMany, span: at(two, 'f(1)') }), false);
        const alias = 'g(1,\n// @ts-ignore\n2);\n';
        assert.strictEqual(silenced('typescript', alias, 1, { ...tooMany, span: at(alias, 'g(1,\n// @ts-ignore\n2)') }), true);
        const made = 'const k = new K(1,\n// @ts-ignore\n2);\n';
        assert.strictEqual(silenced('typescript', made, 1, { kind: 'arity', name: 'constructor', most: 1, span: at(made, 'new K(1,\n// @ts-ignore\n2)') }), true);
        const nested = 'n = f(f(1,\n        2))  # type: ignore\n';
        assert.strictEqual(silenced('python', nested, 1, { ...tooMany, span: at(nested, 'f(1,\n        2)') }), true);
        const twoPy = 'f(1, 2); n = f(1,\n    2)  # type: ignore\n';
        assert.strictEqual(silenced('python', twoPy, 1, { ...tooMany, span: at(twoPy, 'f(1, 2)') }), false);
        // Each report of a call has its own range: every one must be silenced.
        const keyword = 'n = f(\n    1,\n    b=2,  # type: ignore\n)\n';
        const problem = { kind: 'arity', name: 'f', span: at(keyword, 'f(\n    1,\n    b=2,  # type: ignore\n)') };
        assert.strictEqual(silenced('python', keyword, 1, { ...problem, problem: "unexpected keyword argument 'b'" }), true);
        assert.strictEqual(silenced('python', keyword, 1, { ...problem, problem: "unexpected keyword argument 'b'; missing required argument(s): c" }), true);
        const elsewhere = 'n = f(  # type: ignore\n    1,\n    b=2,\n)\n';
        assert.strictEqual(silenced('python', elsewhere, 1, { kind: 'arity', name: 'f', span: at(elsewhere, 'f(  # type: ignore\n    1,\n    b=2,\n)'), problem: "unexpected keyword argument 'b'" }), false);
        // An import statement is the one that names the module.
        const imports = 'import { gone } from "./other"; import {\n  // @ts-ignore\n  gone as again,\n} from "./lib";\n';
        assert.strictEqual(silenced('typescript', imports, 1, { kind: 'import-name', name: 'gone', module: './lib' }), true);
        assert.strictEqual(silenced('typescript', imports, 1, { kind: 'import-name', name: 'gone', module: './other' }), false);
    });

    it('python: a comment on a line of the reported range, naming the rule when it names any', () => {
        const ROWS = [
            ['f(1)  # type: ignore\n', 1, true],
            ['f(1)  # type: ignore[arg-type]\n', 1, true],
            ['f(1)  #type:ignore\n', 1, true],
            ['f(1)  # note # type: ignore\n', 1, true],
            ['f(1)  # pyright: ignore\n', 1, true],
            ['f(1)  # pyright: ignore[reportCallIssue]\n', 1, true],
            ['f(1)  # pyright: ignore[reportAttributeAccessIssue, reportCallIssue]\n', 1, true],
            // Another rule's ignore is not this one's.
            ['f(1)  # pyright: ignore[reportAttributeAccessIssue]\n', 1, false],
            ['f(1)  # see type: ignore\n', 1, false],
            ['f(1)  # TYPE: IGNORE\n', 1, false],
            ['f(1)  # type: ignored\n', 1, false],
            ['f(1)  # noqa\n', 1, false],
            ['f(1); s = "# type: ignore"\n', 1, false],
            ['x = 1\n# type: ignore\nf(1)\n', 3, false],
            // The whole call is the range; the rest of its statement is not.
            ['n = f(\n    1,\n)  # type: ignore\n', 1, true],
            ['total = [\n    f(1),\n    2,\n]  # type: ignore\n', 2, false],
        ];
        for (const [source, line, expected] of ROWS) assert.strictEqual(silenced('python', source, line), expected, source);
        // One argument too many is reported at that argument.
        const tooMany = { kind: 'arity', name: 'f', most: 1 };
        assert.strictEqual(silenced('python', 'n = f(\n    1,\n    2,  # type: ignore\n)\n', 1, tooMany), true);
        assert.strictEqual(silenced('python', 'n = f(  # type: ignore\n    1,\n    2,\n)\n', 1, tooMany), false);
        // An import is reported at the name under one rule, at the module under another.
        const named = { kind: 'import-name', name: 'GONE' };
        assert.strictEqual(silenced('python', 'from lib import (\n    GONE,  # type: ignore\n    KEEP,\n)\n', 1, named), true);
        assert.strictEqual(silenced('python', 'from lib import (  # type: ignore\n    GONE,\n    KEEP,\n)\n', 1, named), false);
        assert.strictEqual(silenced('python', 'from lib import GONE  # pyright: ignore[reportAttributeAccessIssue]\n', 1, named), true);
        assert.strictEqual(silenced('python', 'from lib import GONE  # pyright: ignore[reportMissingImports]\n', 1, named), false);
        assert.strictEqual(silenced('python', 'from .gone import X  # pyright: ignore[reportMissingImports]\n', 1, { kind: 'import-module' }), true);
    });

    it('python: what a comment says about the whole file', () => {
        const ROWS = [
            ['# type: ignore\nf(1)\n', 2, true],
            ['#!/usr/bin/env python\n# -*- coding: utf-8 -*-\n\n# type: ignore[arg-type]\nf(1)\n', 5, true],
            ['"doc"\n# type: ignore\nf(1)\n', 3, false],
            // A rule set chooses rules; it turns none off.
            ['# pyright: basic\nf(1)\n', 2, false],
            ['# pyright: standard\nf(1)\n', 2, false],
            ['# pyright: strict\nf(1)\n', 2, false],
            // A rule comment silences its own rule, wherever it stands alone on a line.
            ['# pyright: reportCallIssue=false\nf(1)\n', 2, true],
            ['# pyright: reportCallIssue=none\nf(1)\n', 2, true],
            ['# pyright: reportCallIssue=warning\nf(1)\n', 2, true],
            ['# pyright: reportCallIssue = false\nf(1)\n', 2, true],
            ['# pyright: strict, reportCallIssue=false\nf(1)\n', 2, true],
            ['f(1)\n# pyright: reportCallIssue=false\n', 1, true],
            ['# pyright: reportCallIssue=true\nf(1)\n', 2, false],
            ['# pyright: reportAttributeAccessIssue=false\nf(1)\n', 2, false],
            ['# pyright: reportGeneralTypeIssues=false\nf(1)\n', 2, false],
            ['# pyright: reportCallIssue=false\n# pyright: strict\nf(1)\n', 3, false],
            ['# note: pyright: reportCallIssue=false\nf(1)\n', 2, false],
            ['f(1)  # pyright: reportCallIssue=false\n', 1, false],
            // Not file-wide, and not this checker's.
            ['# pyright: ignore\nf(1)\n', 2, false],
            ['# mypy: ignore-errors\nf(1)\n', 2, false],
        ];
        for (const [source, line, expected] of ROWS) assert.strictEqual(silenced('python', source, line), expected, source);
    });

    it('an import the judge resolves, and a call it does not', () => {
        const source = 'import "./a";\nconst r = require("./h");\nasync function load() { return import("./j"); }\n' +
            'try { require("./k"); } catch {}\nexport * from "./f";\nexport const z = require("./m");\n';
        const typed = line => langTraits('typescript').checkedImportAt(parseRevision(source, 'typescript'), line);
        const untyped = line => langTraits('javascript').checkedImportAt(parseRevision(source, 'javascript'), line);
        // The compiler resolves statements and import(); a require call is a call to it.
        assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(typed), [true, false, true, false, true, false]);
        // With no compiler the runtime is the judge: a require outside a try block must find its module.
        assert.deepStrictEqual([1, 2, 3, 4, 5, 6].map(untyped), [true, true, true, false, true, true]);
        assert.strictEqual(langTraits('typescript').checkedImportAt(parseRevision('import eq = require("./i");\n', 'typescript'), 1), true);
        // Several imports can share a line: the one asked about is the one that names the module.
        const shared = 'import a from "./a"; const b = require("./gone");\n';
        const sharedTyped = parseRevision(shared, 'typescript');
        assert.deepStrictEqual(['./a', './gone'].map(module => langTraits('typescript').checkedImportAt(sharedTyped, 1, module)), [true, false]);
        const sharedPython = parseRevision('import os; m = importlib.import_module(".gone", __package__)\n', 'python');
        assert.deepStrictEqual(['os', '.gone'].map(module => langTraits('python').checkedImportAt(sharedPython, 1, module)), [true, false]);
        const python = 'import importlib\nfrom . import gone\nmod = importlib.import_module(".gone", __package__)\n';
        assert.deepStrictEqual([1, 2, 3].map(line => langTraits('python').checkedImportAt(parseRevision(python, 'python'), line)),
            [true, true, false]);
    });

    it('a deleted file a JavaScript module still requires is a break, unless the failure is handled', () => {
        const answer = use => {
            const dir = repo({ 'gone.js': 'module.exports = { marker: 1 };\n', 'use.js': use });
            try {
                fs.unlinkSync(path.join(dir, 'gone.js'));
                const item = checked(dir).changed.find(entry => entry.kind === 'module');
                return [item.verdict, item.reasons, item.sites];
            } finally { rm(dir); }
        };
        assert.deepStrictEqual(answer('const gone = require("./gone");\nmodule.exports = gone;\n'),
            ['blocked', ['deleted-still-imported'], [{ file: 'use.js', line: 1, kind: 'import' }]]);
        assert.deepStrictEqual(answer('let gone = null;\ntry {\n  gone = require("./gone");\n} catch (error) {\n  gone = null;\n}\nmodule.exports = gone;\n'),
            ['review', ['deleted-still-loaded-unchecked'], [{ file: 'use.js', line: 3, kind: 'import', unchecked: true }]]);
    });

    it('nothing read about a site outlives the check that read it', () => {
        // The same index, rebuilt between two checks: the second reads the
        // files as they are then.
        const dir = repo({
            'lib.ts': 'export function f(a: number) { return a; }\n',
            'use.ts': 'import { f } from "./lib";\nf(1);\n',
        });
        try {
            write(dir, 'lib.ts', 'export function f(a: number, b: number) { return a + b; }\n');
            const live = idx(dir);
            assert.strictEqual(execute(live, 'check', {}).result.trust.status, 'BLOCKED');
            // The caller is repaired, and a new caller is written under a suppression.
            write(dir, 'use.ts', 'import { f } from "./lib";\nf(1, 2);\n');
            write(dir, 'extra.ts', 'import { f } from "./lib";\n// @ts-ignore\nf(1);\n');
            live.build(null, { quiet: true });
            const reused = execute(live, 'check', {}).result;
            const fresh = execute(idx(dir), 'check', {}).result;
            const answer = result => [result.trust.status, result.changed.map(item => [item.name, item.verdict, item.reasons])];
            assert.deepStrictEqual(answer(reused), answer(fresh));
            assert.strictEqual(reused.trust.status, 'REVIEW_REQUIRED');
            // And the other way: the suppression is removed.
            write(dir, 'extra.ts', 'import { f } from "./lib";\nf(1);\n');
            live.build(null, { quiet: true });
            assert.strictEqual(execute(live, 'check', {}).result.trust.status, 'BLOCKED');
        } finally { rm(dir); }
    });

    it('what a callee declares is read again by the next check', () => {
        const dir = repo({
            'helpers.ts': 'export function stop() {\n  console.log("stop");\n}\n',
            'lib.ts': 'import { stop } from "./helpers";\nexport function pick(k: string) {\n  if (k === "a") return 1;\n  return 2;\n}\nexport const s = stop;\n',
        });
        try {
            // A bare call of a project function that declares nothing: it returns.
            write(dir, 'lib.ts', 'import { stop } from "./helpers";\nexport function pick(k: string) {\n  if (k === "a") return 1;\n  stop();\n  return 2;\n}\nexport const s = stop;\n');
            const live = idx(dir);
            const pick = result => result.changed.find(item => item.name === 'pick').verdict;
            assert.strictEqual(pick(execute(live, 'check', {}).result), 'ready');
            // Now the callee is declared never to return: the same call ends the path.
            write(dir, 'helpers.ts', 'export function stop(): never {\n  throw new Error("stop");\n}\n');
            live.build(null, { quiet: true });
            const reused = execute(live, 'check', {}).result;
            const fresh = execute(idx(dir), 'check', {}).result;
            assert.deepStrictEqual([pick(reused), pick(fresh)], ['review', 'review']);
        } finally { rm(dir); }
    });

    it('a site under a suppression is listed and is not what blocks', () => {
        const dir = repo({
            'lib.ts': 'export function f(a: number): number {\n  return a;\n}\n',
            'use.ts': 'import { f } from "./lib";\n// @ts-ignore\nexport const n: number = f(1);\n',
        });
        try {
            write(dir, 'lib.ts', 'export function f(a: number, b: number): number {\n  return a + b;\n}\n');
            let result = checked(dir);
            let item = result.changed.find(entry => entry.name === 'f');
            assert.deepStrictEqual([result.trust.status, item.verdict, item.reasons, item.signatureMismatches, item.mismatches.map(m => [m.line, m.unchecked])],
                ['REVIEW_REQUIRED', 'review', ['site-not-checked', 'header'], 0, [[3, true]]]);
            assert.match(output.formatCheck(result), /↳ use\.ts:3 .*\(not checked by the toolchain\)/);
            // One site the checker does look at is enough.
            write(dir, 'use.ts', 'import { f } from "./lib";\n// @ts-ignore\nexport const n: number = f(1);\nexport const m: number = f(2);\n');
            git(dir, 'add', '-A');
            result = checked(dir);
            item = result.changed.find(entry => entry.name === 'f');
            assert.deepStrictEqual([result.trust.status, item.signatureMismatches, item.mismatches.map(m => [m.line, !!m.unchecked])],
                ['BLOCKED', 1, [[3, true], [4, false]]]);
        } finally { rm(dir); }
    });
});

describe('check: what an object literal declared as a type has', () => {
    const members = (source, line) => {
        const found = require('../languages').langTraits('typescript').typedLiteralMembers(parseRevision(source, 'typescript'), line);
        return found && [[...found.names].filter(name => !['constructor', 'toString', 'toLocaleString', 'valueOf', 'hasOwnProperty', 'isPrototypeOf', 'propertyIsEnumerable'].includes(name)).sort(), found.open];
    };
    it('its written keys, and what every object has', () => {
        const found = require('../languages').langTraits('typescript').typedLiteralMembers(
            parseRevision('const box: Box = { size: () => 1 };\n', 'typescript'), 1);
        assert.ok(found.names.has('size') && found.names.has('toString') && found.names.has('hasOwnProperty') && !found.open);
        assert.deepStrictEqual(members('const box: Box = { size: () => 1, "quoted": 2, short, method() { return 1; }, get acc() { return 1; } };\n', 1),
            [['acc', 'method', 'quoted', 'short', 'size'], false]);
    });
    it('is open when a member or the check cannot be read', () => {
        const OPEN = [
            'const box: Box = { ...rest, size: () => 1 };',
            'const box: Box = { [key]: 1 };',
            'const box: Box = { "\\u0062rand": 1 };',
            'const box: Box = { \\u0062rand: 1 };',
            'const box: Box = { 0x1: 1 };',
            'const box: Box = { size: () => 1 } as Box;',
            'const box: Box = Object.freeze({ size: () => 1 });',
        ];
        for (const source of OPEN) assert.strictEqual(members(`${source}\n`, 1)[1], true, source);
        // Whether the declaration is checked at all is the judge's
        // question (`checkSuppressedAt`), not the literal's.
        assert.strictEqual(members('// @ts-ignore\nconst box: Box = { size: () => 1 };\n', 2)[1], false);
        assert.strictEqual(members('const n = 1;\n', 1), null);
    });
});

describe('check: a new member that every value of the type must have', () => {
    it('an object literal declared as a class that gains a member is a break', () => {
        const dir = repo({
            'main.ts': 'class Box {\n    size(): number { return 1; }\n}\nexport const box: Box = { size: () => 1 };\n',
        });
        try {
            edit(dir, 'main.ts', '    size(): number { return 1; }\n', '    brandNew(): number { return 2; }\n    size(): number { return 1; }\n');
            const result = checked(dir);
            assert.strictEqual(result.trust.status, 'BLOCKED');
            const item = result.changed.find(entry => entry.name === 'brandNew');
            assert.deepStrictEqual([item.verdict, item.reasons, item.sites],
                ['blocked', ['literal-lacks-new-member', 'shape-of-existing-type'], [{ file: 'main.ts', line: 5, kind: 'literal' }]]);
            assert.ok(result.actions.some(action => action.kind === 'addition_breaks' && action.severity === 'error'));
            assert.match(output.formatCheck(result), /brandNew \(main\.ts:2\) \[ADDED, literal-lacks-new-member, shape-of-existing-type, ORPHAN\]/);
            assert.match(output.formatCheck(result), /↳ main\.ts:5 {2}literal/);
        } finally { rm(dir); }
    });

    it('a literal that has the member, or is added with it, is not one', () => {
        const dir = repo({
            'main.ts': 'interface Shape {\n    area(): number;\n}\nexport const unit: Shape = { area: () => 1 };\n',
        });
        try {
            // The requirement and the literal's member arrive together.
            write(dir, 'main.ts', 'interface Shape {\n    area(): number;\n    perimeter(): number;\n}\nexport const unit: Shape = { area: () => 1, perimeter: () => 4 };\n');
            const item = checked(dir).changed.find(entry => entry.name === 'perimeter' && entry.symbolType !== 'function');
            assert.strictEqual(item.verdict, 'review');
            assert.ok(item.reasons.includes('new-requirement') && !item.reasons.includes('literal-lacks-new-member'));
            // An optional member is owed by nothing.
            write(dir, 'main.ts', 'interface Shape {\n    area(): number;\n    hint?(): string;\n}\nexport const unit: Shape = { area: () => 1 };\n');
            const optional = checked(dir).changed.find(entry => entry.name === 'hint');
            assert.ok(!optional.reasons.includes('literal-lacks-new-member') && !optional.reasons.includes('new-requirement'));
        } finally { rm(dir); }
    });
});

describe('check: a file that is gone, and the imports that named it', () => {
    it('a relative import of a deleted file is a break', () => {
        const dir = repo({
            'gone.ts': 'export const marker = 1;\n',
            'nested/deep.ts': 'import "../gone";\nexport const two = 2;\n',
            'use.ts': 'import "./gone";\nexport const one = 1;\n',
            'apart.ts': 'import "./keep";\n',
            'keep.ts': 'export const k = 1;\n',
        });
        try {
            fs.unlinkSync(path.join(dir, 'gone.ts'));
            const result = checked(dir);
            const item = result.changed.find(entry => entry.kind === 'module');
            assert.deepStrictEqual([item.file, item.verdict, item.reasons, item.sites], ['gone.ts', 'blocked', ['deleted-still-imported'], [
                { file: 'nested/deep.ts', line: 1, kind: 'import' }, { file: 'use.ts', line: 1, kind: 'import' },
            ]]);
        } finally { rm(dir); }
    });

    it('an absolute module name may be answered from outside the project: review', () => {
        const dir = repo({
            'gone.py': 'def setup():\n    print("setup")\n',
            'pkg/__init__.py': '',
            'pkg/inner.py': 'ONE = 1\n',
            'use.py': 'import gone\nfrom pkg import inner\n\nprint(inner.ONE)\n',
            'rel.py': 'from . import gone as g\n',
        });
        try {
            fs.unlinkSync(path.join(dir, 'gone.py'));
            let item = checked(dir).changed.find(entry => entry.kind === 'module');
            // The relative import can only have meant this file.
            assert.deepStrictEqual([item.verdict, item.reasons, item.sites.map(site => site.file)],
                ['blocked', ['deleted-still-imported'], ['rel.py']]);
            fs.unlinkSync(path.join(dir, 'rel.py'));
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'no relative importer');
            // Deleted again from a tree where only `import gone` names it.
            write(dir, 'gone.py', 'def setup():\n    print("setup")\n');
            git(dir, 'add', '-A');
            git(dir, 'commit', '-q', '-m', 'restore');
            fs.unlinkSync(path.join(dir, 'gone.py'));
            item = checked(dir).changed.find(entry => entry.kind === 'module');
            assert.deepStrictEqual([item.verdict, item.reasons, item.sites],
                ['review', ['deleted-name-still-imported'], [{ file: 'use.py', line: 1, kind: 'import' }]]);
        } finally { rm(dir); }
    });

    it('a name taken from a package of the project was its submodule, unless the package supplies it', () => {
        const files = init => ({
            'pkg/__init__.py': init,
            'pkg/inner.py': 'ONE = 1\n',
            'use.py': 'from pkg import inner\n\nprint(inner)\n',
            'dotted.py': 'import pkg.inner\n\nprint(pkg.inner)\n',
        });
        const answer = init => {
            const dir = repo(files(init));
            try {
                fs.unlinkSync(path.join(dir, 'pkg/inner.py'));
                const item = checked(dir).changed.find(entry => entry.kind === 'module');
                return [item.file, item.verdict, item.reasons[0], item.sites.map(site => `${site.file}:${site.line}`)];
            } finally { rm(dir); }
        };
        // Nothing else can answer either import: the package is here and
        // does not have the name.
        assert.deepStrictEqual(answer(''), ['pkg/inner.py', 'blocked', 'deleted-still-imported', ['dotted.py:1', 'use.py:1']]);
        // The package declares the name itself: only the dotted import,
        // which names a module, is left without one.
        assert.deepStrictEqual(answer('inner = 1\n'), ['pkg/inner.py', 'blocked', 'deleted-still-imported', ['dotted.py:1']]);
    });

    it('a package that computes its names cannot be shown to lack one', () => {
        for (const init of ['def __getattr__(name):\n    return 1\n', 'from .other import *\n']) {
            const dir = repo({
                'pkg/__init__.py': init,
                'pkg/other.py': 'TWO = 2\n',
                'pkg/inner.py': 'ONE = 1\n',
                'use.py': 'from pkg import inner\n\nprint(inner)\n',
            });
            try {
                fs.unlinkSync(path.join(dir, 'pkg/inner.py'));
                const item = checked(dir).changed.find(entry => entry.kind === 'module');
                assert.deepStrictEqual([item.verdict, item.reasons, item.sites],
                    ['review', ['deleted-name-still-imported'], [{ file: 'use.py', line: 1, kind: 'import' }]], init);
            } finally { rm(dir); }
        }
    });
});

describe('check: a new name is new where it can be meant', () => {
    // An occurrence of the same spelling somewhere the declaration cannot
    // be reached from is another name: it could not have meant this
    // declaration before the change and cannot now.
    const added = (dir, name) => checked(dir).changed.find(item => item.name === name && item.kind === 'added');
    const answer = item => `${item.verdict}${item.reasons.length ? `(${item.reasons.join(',')})` : ''}`;

    it('a module-private helper is not the local of that name in another module', () => {
        const dir = repo({
            'a.js': 'function keep() { return 1; }\nmodule.exports = { keep };\n',
            'b.js': 'const { keep } = require("./a");\nfunction other() { const rows = [keep()]; return rows; }\nmodule.exports = { other };\n',
        });
        try {
            write(dir, 'a.js', 'function keep() { return rows().length; }\nfunction rows() { return [1]; }\nmodule.exports = { keep };\n');
            assert.strictEqual(answer(added(dir, 'rows')), 'ready');
        } finally { rm(dir); }
    });

    it('the same file is always in reach', () => {
        const dir = repo({
            'a.js': 'function keep(rows) { return rows; }\nmodule.exports = { keep };\n',
        });
        try {
            write(dir, 'a.js', 'function keep(rows) { return rows; }\nfunction rows() { return [1]; }\nmodule.exports = { keep };\n');
            const item = added(dir, 'rows');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual(item.sites, [{ file: 'a.js', line: 1 }]);
        } finally { rm(dir); }
    });

    it('an exported name reaches the files that import it and the files that hold the module', () => {
        const dir = repo({
            'a.js': 'function keep() { return 1; }\nmodule.exports = { keep };\n',
            // Imports a name the module does not have yet.
            'named.js': 'const { keep, later } = require("./a");\nmodule.exports = { run: () => keep() + later() };\n',
            // Holds the module and reaches for the member.
            'held.js': 'const a = require("./a");\nmodule.exports = { run: () => a.keep() + a.later() };\n',
            // Its own `later`: never this one.
            'apart.js': 'function later() { return 0; }\nmodule.exports = { later };\n',
        });
        try {
            write(dir, 'a.js', 'function keep() { return 1; }\nfunction later() { return 2; }\nmodule.exports = { keep, later };\n');
            const item = added(dir, 'later');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual([...new Set(item.sites.map(site => site.file))], ['held.js', 'named.js']);
        } finally { rm(dir); }
    });

    it('a star import takes whatever the module has', () => {
        const dir = repo({
            'm.py': 'def keep():\n    return 1\n',
            'star.py': 'from m import *\n\n\ndef run(later):\n    return keep() + later\n',
            'apart.py': 'def run(later):\n    return later\n',
        });
        try {
            write(dir, 'm.py', 'def keep():\n    return 1\n\n\ndef later():\n    return 2\n');
            const item = added(dir, 'later');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual([...new Set(item.sites.map(site => site.file))], ['star.py']);
        } finally { rm(dir); }
    });

    it('scripts without module syntax share one scope', () => {
        const dir = repo({
            'a.js': 'function keep() { return 1; }\n',
            'b.js': 'function run() { return later(); }\n',
        });
        try {
            write(dir, 'a.js', 'function keep() { return 1; }\nfunction later() { return 2; }\n');
            const item = added(dir, 'later');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual(item.sites.map(site => site.file), ['b.js']);
        } finally { rm(dir); }
    });

    it('a member can be reached through a receiver from anywhere', () => {
        const dir = repo({
            'a.py': 'class Box:\n    def size(self):\n        return 1\n',
            'b.py': 'def run(thing):\n    return thing.weight()\n',
        });
        try {
            write(dir, 'a.py', 'class Box:\n    def size(self):\n        return 1\n\n    def weight(self):\n        return 2\n');
            const item = added(dir, 'weight');
            assert.strictEqual(answer(item), 'review(name-in-use)');
            assert.deepStrictEqual(item.sites, [{ file: 'b.py', line: 2 }]);
        } finally { rm(dir); }
    });
});

describe('check: an addition is inert only when nothing that existed can reach it', () => {
    // [label, base files, edit, expected verdict string for the added symbol]
    const CASES = [
        ['py: a method that overrides an inherited one',
            { 'a.py': 'class Base:\n    def run(self):\n        return 1\n\n\nclass Child(Base):\n    def other(self):\n        return 2\n' },
            dir => edit(dir, 'a.py', '    def other(self):\n        return 2\n', '    def other(self):\n        return 2\n\n    def run(self):\n        return 3\n'),
            'run:added=review(name-in-use,overrides-inherited)'],
        ['java: a new abstract method every implementer must now supply',
            { 'A.java': 'interface Contract {\n    void keep();\n}\nclass Impl implements Contract {\n    public void keep() {}\n}\n' },
            dir => edit(dir, 'A.java', '    void keep();\n', '    void keep();\n    void fresh();\n'),
            'fresh:added=review(new-requirement)'],
        ['rust: a new required trait method',
            { 'a.rs': 'trait Contract {\n    fn keep(&self);\n}\nstruct Impl;\nimpl Contract for Impl {\n    fn keep(&self) {}\n}\n' },
            dir => edit(dir, 'a.rs', '    fn keep(&self);\n', '    fn keep(&self);\n    fn fresh(&self);\n'),
            'fresh:added=review(new-requirement)'],
        ['py: a member the runtime calls by name',
            { 'a.py': 'class Box:\n    def size(self):\n        return 1\n' },
            dir => edit(dir, 'a.py', '        return 1\n', '        return 1\n\n    def __len__(self):\n        return 1\n'),
            '__len__:added=review(protocol-member)'],
        ['py: a handler registered by a decorator',
            { 'web.py': 'from flask import Flask\n\napp = Flask(__name__)\n' },
            dir => write(dir, 'web.py', 'from flask import Flask\n\napp = Flask(__name__)\n\n\n@app.route("/fresh")\ndef fresh_route():\n    return "ok"\n'),
            'fresh_route:added=review(registered)'],
        // A class that declares a private or protected member has no values
        // but its own instances. Its public members are still enumerated
        // (keyof, mapped types): a new one is review, a new hidden one is
        // seen by nothing.
        ['ts: a novel public method of a class that declares a private member',
            { 'a.ts': 'class Box {\n  private count = 0;\n  size() { return this.count; }\n}\nnew Box().size();\n' },
            dir => edit(dir, 'a.ts', '  size() { return this.count; }\n', '  size() { return this.count; }\n  freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=review(shape-of-existing-type)'],
        ['ts: a novel private method of a class that declares a private member is ready',
            { 'a.ts': 'class Box {\n  private count = 0;\n  size() { return this.count; }\n}\nnew Box().size();\n' },
            dir => edit(dir, 'a.ts', '  size() { return this.count; }\n', '  size() { return this.count; }\n  private freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=ready'],
        // The constructor's type is its own contract: a static member is
        // part of it whatever the instances are held to.
        ['ts: a novel private static method of a class that declares a private member',
            { 'a.ts': 'class Box {\n  private count = 0;\n  size() { return this.count; }\n}\nnew Box().size();\n' },
            dir => edit(dir, 'a.ts', '  size() { return this.count; }\n', '  size() { return this.count; }\n  private static freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=review(shape-of-existing-type)'],
        ['ts: a private constructor is not a private member',
            { 'a.ts': 'class Box {\n  private constructor() {}\n  size() { return 1; }\n}\nexport const box: Box = { size: () => 1 };\n' },
            dir => edit(dir, 'a.ts', '  size() { return 1; }\n', '  size() { return 1; }\n  private freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=blocked(literal-lacks-new-member,shape-of-existing-type)'],
        // A class with none is compared by shape, like an interface.
        ['ts: a novel method of a class compared by shape is review',
            { 'a.ts': 'class Box {\n  size() { return 1; }\n}\nnew Box().size();\n' },
            dir => edit(dir, 'a.ts', '  size() { return 1; }\n', '  size() { return 1; }\n  freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=review(shape-of-existing-type)'],
        // An inherited private member is shared by every class that
        // inherits it: any of them with the class's members is a value.
        ['ts: a private member of an ancestor does not hold the class',
            { 'a.ts': 'class Base {\n  protected seed = 0;\n}\nclass Box extends Base {\n  size() { return 1; }\n}\nnew Box().size();\n' },
            dir => edit(dir, 'a.ts', '  size() { return 1; }\n', '  size() { return 1; }\n  freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=review(shape-of-existing-type)'],
        ['js: a class in a language with no type checker is reached by name only',
            { 'a.js': 'class Box {\n  size() { return 1; }\n}\nmodule.exports = { Box };\n' },
            dir => edit(dir, 'a.js', '  size() { return 1; }\n', '  size() { return 1; }\n  freshlyNamed() { return 2; }\n'),
            'freshlyNamed:added=ready'],
        ['c++: a virtual member makes an aggregate something else',
            { 'a.cpp': 'struct Point {\n    int x;\n    int y;\n};\nint main() { Point p{1, 2}; return p.x; }\n' },
            dir => edit(dir, 'a.cpp', '    int y;\n', '    int y;\n    virtual int freshlyNamed() { return 1; }\n'),
            'freshlyNamed:added=review(shape-of-existing-type)'],
        ['rust: a new variant of an existing enum',
            { 'a.rs': 'pub enum Kind {\n    A,\n}\n' },
            dir => edit(dir, 'a.rs', '    A,\n', '    A,\n    FreshlyNamed,\n'),
            'FreshlyNamed:added=review(field-of-existing-type)'],
        ['ts: a novel class and its members are ready',
            { 'a.ts': 'export const one = 1;\n' },
            dir => write(dir, 'b.ts', 'export class FreshBox {\n  freshSize() { return 1; }\n}\n'),
            'freshSize:added=ready'],
    ];
    for (const [label, files, change, expected] of CASES) {
        it(label, () => {
            const dir = repo(files);
            try {
                change(dir);
                const result = checked(dir);
                assert.ok(verdicts(result).includes(expected), verdicts(result).join('  '));
            } finally { rm(dir); }
        });
    }
});
