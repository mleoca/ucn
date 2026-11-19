/**
 * Changes judged by where the toolchain reports them (fix #511): the check
 * holds an item for what reaches lines the change did not write, and leaves
 * a call the change wrote, whose value stays on written lines, to the
 * toolchain as a note. Each shape beside its twin: a value bound to a name
 * an unwritten line reads, directly or through another written binding,
 * pushed into a local array, narrowing a name such a line reads (a type
 * predicate, an inferred one, an assertion call, settled or not, a
 * `TypeGuard`), stored by new Python code in a member or a module name,
 * returned from a member that fills an inherited slot or from a function
 * value a typed binding holds; what a call does to what it is handed (a
 * Rust value moved or typed by its use, a TypeScript empty array, a C#
 * `out var`, a C++ template body) and what a replaced line supplied (an
 * assignment, a narrowing, a use, a thrown exception); and the breaks a change makes on unwritten lines
 * that the check does not see (a binding changed before an unchanged
 * `return`, a changed guard or assertion condition, a guard added above a
 * comparison), each pinned by id in eval/check-scoring.js.
 * `expect` is the toolchain's verdict (eval/run-check-matrix.js);
 * `answer` and `detail` are the check's.
 */
'use strict';

module.exports = [
    {
        "id": "written-py-binding-before-return",
        "lang": "py",
        "base": {
            "lib.py": "def f() -> int:\n    value = 1\n    return value\n"
        },
        "after": {
            "lib.py": "def f() -> int:\n    value = \"bad\"\n    return value\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-ts-binding-before-return",
        "lang": "ts",
        "base": {
            "lib.ts": "export function f(): number {\n  const value = 1;\n  return value;\n}\n"
        },
        "after": {
            "lib.ts": "export function f(): number {\n  const value = \"bad\";\n  return value;\n}\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-py-guard-condition-changed",
        "lang": "py",
        "base": {
            "lib.py": "def f(x: int | None) -> int:\n    if x is None:\n        return 0\n    return x\n"
        },
        "after": {
            "lib.py": "def f(x: int | None) -> int:\n    if x is not None:\n        return 0\n    return x\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-py-assert-condition-changed",
        "lang": "py",
        "base": {
            "lib.py": "def f(x: int | None) -> int:\n    assert x is not None\n    return x + 1\n"
        },
        "after": {
            "lib.py": "def f(x: int | None) -> int:\n    assert x is None\n    return x + 1\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-ts-guard-condition-changed",
        "lang": "ts",
        "base": {
            "lib.ts": "export function f(x: number | undefined): number {\n  if (x === undefined) return 0;\n  return x;\n}\n"
        },
        "after": {
            "lib.ts": "export function f(x: number | undefined): number {\n  if (x !== undefined) return 0;\n  return x;\n}\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-ts-guard-added-above-literal-comparison",
        "lang": "ts",
        "base": {
            "lib.ts": "export function f(k: \"a\" | \"b\"): number {\n  if (k === \"b\") return 2;\n  return 1;\n}\n"
        },
        "after": {
            "lib.ts": "export function f(k: \"a\" | \"b\"): number {\n  if (k !== \"a\") return 0;\n  if (k === \"b\") return 2;\n  return 1;\n}\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-ts-typed-binding-unreferenced-result-type",
        "lang": "ts",
        "base": {
            "lib.ts": "type Handler = (c: number) => number;\nconst h: Handler = (c) => {\n  return c;\n};\nexport {};\n"
        },
        "after": {
            "lib.ts": "type Handler = (c: number) => number;\nconst h: Handler = (c) => {\n  return String(c);\n};\nexport {};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "h:modified=review(inferred-return-contract)"
    },
    {
        "id": "written-ts-typed-binding-unreferenced-same-type",
        "lang": "ts",
        "base": {
            "lib.ts": "type Handler = (c: number) => number;\nconst h: Handler = (c) => {\n  return c;\n};\nexport {};\n"
        },
        "after": {
            "lib.ts": "type Handler = (c: number) => number;\nconst h: Handler = (c) => {\n  return c * 2;\n};\nexport {};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "h:modified=review(inferred-return-contract)"
    },
    {
        "id": "written-ts-discarded-call",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  return 1;\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  g(a.length);\n  return 1;\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-ts-discarded-call-wrong-argument",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  return 1;\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  g(a.at(0));\n  return 1;\n}\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-py-bound-read-on-written-lines",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    return 1\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    n = h(len(a))\n    print(n)\n    return 1\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-py-bound-read-on-an-unwritten-line",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    n = g(len(a))\n    return n\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    n = h(len(a))\n    return n\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-returned-under-written-type",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  return g(a.length);\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  return h(a.length);\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-returned-from-override",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport class A { area(): number { return 0; } }\nexport class B extends A {\n  n = 1;\n  area() {\n    return g(this.n);\n  }\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport class A { area(): number { return 0; } }\nexport class B extends A {\n  n = 1;\n  area() {\n    return h(this.n);\n  }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "area:modified=review(inferred-return-contract,outgoing-call-unverified)"
    },
    {
        "id": "written-py-returned-from-override",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\nclass A:\n    def area(self) -> int:\n        return 0\n\n\nclass B(A):\n    n = 1\n\n    def area(self):\n        return g(self.n)\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\nclass A:\n    def area(self) -> int:\n        return 0\n\n\nclass B(A):\n    n = 1\n\n    def area(self):\n        return h(self.n)\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "area:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-go-returned-under-written-type",
        "lang": "go",
        "base": {
            "go.mod": "module example.com/m\n\ngo 1.21\n",
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc h(x int) string { return \"\" }\n\nfunc f(a string) int {\n\treturn 1\n}\n"
        },
        "after": {
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc h(x int) string { return \"\" }\n\nfunc f(a string) int {\n\treturn h(len(a))\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-value-pushed-into-empty-array",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  const xs = [];\n  xs.push(g(a.length));\n  return xs[0];\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  const xs = [];\n  xs.push(h(a.length));\n  return xs[0];\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-value-pushed-same-type",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  const xs = [];\n  xs.push(g(a.length));\n  return xs[0];\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  const xs = [];\n  xs.push(g(a.length + 1));\n  return xs[0];\n}\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-py-value-appended-to-empty-list",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    xs = []\n    xs.append(g(len(a)))\n    return xs[0]\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    xs = []\n    xs.append(h(len(a)))\n    return xs[0]\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-py-value-flows-through-written-binding",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    n = g(len(a))\n    m = n\n    return m\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ndef f(a: str) -> int:\n    n = h(len(a))\n    m = n * 1\n    return m\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-value-flows-through-written-binding",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  const n = g(a.length);\n  const m = n;\n  return m;\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number): number { return x; }\nexport function h(x: number): string { return String(x); }\nexport function f(a: string): number {\n  const n = h(a.length);\n  const m = n.valueOf();\n  return m;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-type-predicate-guard",
        "lang": "ts",
        "base": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function isStr(x: unknown, tag: string): x is string { return typeof x === \"string\" && tag !== \"\"; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!isNum(v, tag)) return 0;\n  return v;\n}\n"
        },
        "after": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function isStr(x: unknown, tag: string): x is string { return typeof x === \"string\" && tag !== \"\"; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!isStr(v, tag)) return 0;\n  return v;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-type-predicate-guard-same-type",
        "lang": "ts",
        "base": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function isInt(x: unknown, tag: string): x is number { return Number.isInteger(x) && tag !== \"\"; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!isNum(v, tag)) return 0;\n  return v;\n}\n"
        },
        "after": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function isInt(x: unknown, tag: string): x is number { return Number.isInteger(x) && tag !== \"\"; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!isInt(v, tag)) return 0;\n  return v;\n}\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-assertion-call",
        "lang": "ts",
        "base": {
            "lib.ts": "export function assertNum(x: unknown, tag: string): asserts x is number { if (typeof x !== \"number\") throw new Error(tag); }\nexport function assertStr(x: unknown, tag: string): asserts x is string { if (typeof x !== \"string\") throw new Error(tag); }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  assertNum(v, tag);\n  return v;\n}\n"
        },
        "after": {
            "lib.ts": "export function assertNum(x: unknown, tag: string): asserts x is number { if (typeof x !== \"number\") throw new Error(tag); }\nexport function assertStr(x: unknown, tag: string): asserts x is string { if (typeof x !== \"string\") throw new Error(tag); }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  assertStr(v, tag);\n  return v;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(path-end-changed,outgoing-call-unverified)"
    },
    {
        "id": "written-ts-assertion-call-added",
        "lang": "ts",
        "base": {
            "lib.ts": "export function assertNum(x: unknown, tag: string): asserts x is number { if (typeof x !== \"number\") throw new Error(tag); }\nexport function f(v: string, name: string): string {\n  const tag = name.trim();\n  return v.toUpperCase() + tag;\n}\n"
        },
        "after": {
            "lib.ts": "export function assertNum(x: unknown, tag: string): asserts x is number { if (typeof x !== \"number\") throw new Error(tag); }\nexport function f(v: string, name: string): string {\n  const tag = name.trim();\n  assertNum(v, tag);\n  return v.toUpperCase() + tag;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-assertion-call-added-name-unread",
        "lang": "ts",
        "base": {
            "lib.ts": "export function assertNum(x: unknown, tag: string): asserts x is number { if (typeof x !== \"number\") throw new Error(tag); }\nexport function f(v: unknown, name: string): string {\n  return name;\n}\n"
        },
        "after": {
            "lib.ts": "export function assertNum(x: unknown, tag: string): asserts x is number { if (typeof x !== \"number\") throw new Error(tag); }\nexport function f(v: unknown, name: string): string {\n  assertNum(v, name.trim());\n  return name;\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-py-added-function-writes-global",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ncounter = 0\n\n\ndef read() -> int:\n    return counter\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ncounter = 0\n\n\ndef read() -> int:\n    return counter\n\n\ndef store(a: str) -> None:\n    global counter\n    counter = h(len(a))\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "store:added=review(outgoing-call-unverified)"
    },
    {
        "id": "written-py-added-method-writes-member",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\nclass C:\n    def __init__(self) -> None:\n        self.n = 0\n\n    def get(self) -> int:\n        return self.n\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\nclass C:\n    def __init__(self) -> None:\n        self.n = 0\n\n    def get(self) -> int:\n        return self.n\n\n    def put(self, a: str) -> None:\n        self.n = h(len(a))\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "put:added=review(outgoing-call-unverified)"
    },
    {
        "id": "written-py-added-function-writes-global-same-type",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ncounter = 0\n\n\ndef read() -> int:\n    return counter\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\ncounter = 0\n\n\ndef read() -> int:\n    return counter\n\n\ndef store(a: str) -> None:\n    global counter\n    counter = g(len(a))\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "store:added=review(outgoing-call-unverified)"
    },
    {
        "id": "written-py-added-method-writes-member-same-type",
        "lang": "py",
        "base": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\nclass C:\n    def __init__(self) -> None:\n        self.n = 0\n\n    def get(self) -> int:\n        return self.n\n"
        },
        "after": {
            "lib.py": "def g(x: int) -> int:\n    return x\n\n\ndef h(x: int) -> str:\n    return str(x)\n\n\nclass C:\n    def __init__(self) -> None:\n        self.n = 0\n\n    def get(self) -> int:\n        return self.n\n\n    def put(self, a: str) -> None:\n        self.n = g(len(a))\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "put:added=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-settled-assertion-call-name-unread",
        "lang": "ts",
        "base": {
            "lib.ts": "export function assertA(x: string): asserts x is \"a\" { if (x !== \"a\") throw new Error(x); }\nexport function f(v: string, n: number): number {\n  return n;\n}\n"
        },
        "after": {
            "lib.ts": "export function assertA(x: string): asserts x is \"a\" { if (x !== \"a\") throw new Error(x); }\nexport function f(v: string, n: number): number {\n  assertA(v);\n  return n;\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-ts-settled-assertion-call-above-comparison",
        "lang": "ts",
        "base": {
            "lib.ts": "export function assertA(x: string): asserts x is \"a\" { if (x !== \"a\") throw new Error(x); }\nexport function f(v: string): number {\n  if (v === \"b\") return 2;\n  return 1;\n}\n"
        },
        "after": {
            "lib.ts": "export function assertA(x: string): asserts x is \"a\" { if (x !== \"a\") throw new Error(x); }\nexport function f(v: string): number {\n  assertA(v);\n  if (v === \"b\") return 2;\n  return 1;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-inferred-predicate-guard",
        "lang": "ts",
        "base": {
            "lib.ts": "export function isStr(x: unknown) { return typeof x === \"string\"; }\nexport function f(v: unknown): number {\n  if (typeof v !== \"number\") return 0;\n  return v;\n}\n"
        },
        "after": {
            "lib.ts": "export function isStr(x: unknown) { return typeof x === \"string\"; }\nexport function f(v: unknown): number {\n  if (!isStr(v)) return 0;\n  return v;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-py-typeguard-guard",
        "lang": "py",
        "base": {
            "lib.py": "from typing import TypeGuard\n\n\ndef is_int(x: object, tag: str) -> TypeGuard[int]:\n    return isinstance(x, int) and tag != \"\"\n\n\ndef is_str(x: object, tag: str) -> TypeGuard[str]:\n    return isinstance(x, str) and tag != \"\"\n\n\ndef f(v: object, name: str) -> int:\n    tag = name.strip()\n    if not is_int(v, tag):\n        return 0\n    return v\n"
        },
        "after": {
            "lib.py": "from typing import TypeGuard\n\n\ndef is_int(x: object, tag: str) -> TypeGuard[int]:\n    return isinstance(x, int) and tag != \"\"\n\n\ndef is_str(x: object, tag: str) -> TypeGuard[str]:\n    return isinstance(x, str) and tag != \"\"\n\n\ndef f(v: object, name: str) -> int:\n    tag = name.strip()\n    if not is_str(v, tag):\n        return -1\n    return v\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-local-moved-by-a-call",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    first + token.id\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    consume(token);\n    first + token.id\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-parameter-moved-by-a-call",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(token: Token) -> u32 {\n    let first = 1;\n    first + token.id\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(token: Token) -> u32 {\n    let first = 1;\n    consume(token);\n    first + token.id\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-receiver-moved-by-a-method",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    first + token.id\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    token.finish();\n    first + token.id\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-local-borrowed-by-a-call",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    first + token.id\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    consume_ref(&token);\n    first + token.id\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "written-rs-receiver-borrowed-by-a-method",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    first + token.id\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let first = seed + 1;\n    token.peek();\n    first + token.id\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "written-rs-typed-copy-local-passed-by-value",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let n: u32 = seed + 1;\n    let first = seed + 1;\n    first + n\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let n: u32 = seed + 1;\n    let first = seed + 1;\n    takes_u32(n);\n    first + n\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "written-rs-local-moved-in-a-loop-read-earlier-in-it",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let mut total = 0;\n    for i in 0..2 {\n        total += token.id + i;\n    }\n    total\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let token = Token { id: seed };\n    let mut total = 0;\n    for i in 0..2 {\n        total += token.id + i;\n        consume(token);\n    }\n    total\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-untyped-local-typed-by-a-call",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let n = 5;\n    let big: u32 = n;\n    big + seed\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let n = 5;\n    takes_u8(n);\n    let big: u32 = n;\n    big + seed\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-typed-local-passed-to-a-call",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let n: u8 = 5;\n    let big: u32 = n as u32;\n    big + seed\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\nimpl Token {\n    pub fn finish(self) -> u32 {\n        self.id\n    }\n    pub fn peek(&self) -> u32 {\n        self.id\n    }\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn consume_ref(t: &Token) -> u32 {\n    t.id\n}\n\npub fn takes_u8(x: u8) -> u8 {\n    x\n}\n\npub fn takes_u32(x: u32) -> u32 {\n    x\n}\n\npub fn run(seed: u32) -> u32 {\n    let n: u8 = 5;\n    takes_u8(n);\n    let big: u32 = n as u32;\n    big + seed\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "written-rs-await-across-a-non-send-local",
        "lang": "rs",
        "base": {
            "a.rs": "use std::rc::Rc;\n\npub async fn helper() {}\n\nfn assert_send<T: Send>(_: T) {}\n\npub async fn work() -> u32 {\n    let local = Rc::new(1u32);\n    let v = *local;\n    v\n}\n\npub fn check() {\n    assert_send(work());\n}\n"
        },
        "after": {
            "a.rs": "use std::rc::Rc;\n\npub async fn helper() {}\n\nfn assert_send<T: Send>(_: T) {}\n\npub async fn work() -> u32 {\n    let local = Rc::new(1u32);\n    helper().await;\n    let v = *local;\n    v\n}\n\npub fn check() {\n    assert_send(work());\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "work:modified=review(inferred-return-contract)"
    },
    {
        "id": "written-java-throwing-call-replaced-in-try",
        "lang": "java",
        "base": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            risky();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "after": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            safe();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-java-throwing-call-removed-from-try",
        "lang": "java",
        "base": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            risky();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "after": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "written-java-throwing-call-replaced-with-its-handler",
        "lang": "java",
        "base": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            risky();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "after": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            safe();\n            return 1;\n        } catch (RuntimeException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-java-call-added-in-try",
        "lang": "java",
        "base": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            risky();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "after": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            risky();\n            safe();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-cs-out-variable-declared-above-a-declaration",
        "lang": "cs",
        "base": {
            "m.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Library</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable><NoWarn>CS0169;CS0414;CS8618;IDE0051</NoWarn></PropertyGroup></Project>\n",
            "A.cs": "class A {\n    static bool Parse(string s, out int n) {\n        n = s.Length;\n        return true;\n    }\n    static int Run(string s) {\n        var first = 1;\n        var n = 2;\n        return first + n;\n    }\n}\n"
        },
        "after": {
            "A.cs": "class A {\n    static bool Parse(string s, out int n) {\n        n = s.Length;\n        return true;\n    }\n    static int Run(string s) {\n        var first = 1;\n        Parse(s, out var n);\n        var n = 2;\n        return first + n;\n    }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "Run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-cs-out-variable-of-a-new-name",
        "lang": "cs",
        "base": {
            "m.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Library</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable><NoWarn>CS0169;CS0414;CS8618;IDE0051</NoWarn></PropertyGroup></Project>\n",
            "A.cs": "class A {\n    static bool Parse(string s, out int n) {\n        n = s.Length;\n        return true;\n    }\n    static int Run(string s) {\n        var first = 1;\n        var n = 2;\n        return first + n;\n    }\n}\n"
        },
        "after": {
            "A.cs": "class A {\n    static bool Parse(string s, out int n) {\n        n = s.Length;\n        return true;\n    }\n    static int Run(string s) {\n        var first = 1;\n        Parse(s, out var m);\n        var n = 2;\n        return first + n;\n    }\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "Run:modified=ready"
    },
    {
        "id": "written-ts-empty-array-handed-before-a-push",
        "lang": "ts",
        "base": {
            "lib.ts": "export function log(x: unknown): void { void x; }\nexport function f(a: string): number {\n  const xs = [];\n  xs.push(a.length);\n  return xs[0];\n}\n"
        },
        "after": {
            "lib.ts": "export function log(x: unknown): void { void x; }\nexport function f(a: string): number {\n  const xs = [];\n  log(xs);\n  xs.push(a.length);\n  return xs[0];\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-typed-array-handed-before-a-push",
        "lang": "ts",
        "base": {
            "lib.ts": "export function log(x: unknown): void { void x; }\nexport function f(a: string): number {\n  const xs: number[] = [];\n  xs.push(a.length);\n  return xs[0];\n}\n"
        },
        "after": {
            "lib.ts": "export function log(x: unknown): void { void x; }\nexport function f(a: string): number {\n  const xs: number[] = [];\n  log(xs);\n  xs.push(a.length);\n  return xs[0];\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-go-call-replaced-leaves-a-local-unused",
        "lang": "go",
        "base": {
            "go.mod": "module example.com/m\n\ngo 1.21\n",
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc h(x int) int { return x }\n\nfunc f(a int) int {\n\ty := a + 1\n\tg(y)\n\treturn a\n}\n"
        },
        "after": {
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc h(x int) int { return x }\n\nfunc f(a int) int {\n\ty := a + 1\n\th(a)\n\treturn a\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-go-call-removed-leaves-a-local-unused",
        "lang": "go",
        "base": {
            "go.mod": "module example.com/m\n\ngo 1.21\n",
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc f(a int) int {\n\ty := a + 1\n\tg(y)\n\treturn a\n}\n"
        },
        "after": {
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc f(a int) int {\n\ty := a + 1\n\treturn a\n}\n"
        },
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "written-go-call-changed-leaves-an-import-unused",
        "lang": "go",
        "base": {
            "go.mod": "module example.com/m\n\ngo 1.21\n",
            "a.go": "package m\n\nimport \"strings\"\n\nfunc g(s string) int { return len(s) }\n\nfunc f(s string) int {\n\tg(strings.ToUpper(s))\n\treturn 1\n}\n"
        },
        "after": {
            "a.go": "package m\n\nimport \"strings\"\n\nfunc g(s string) int { return len(s) }\n\nfunc f(s string) int {\n\tg(s + \"!\")\n\treturn 1\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-go-call-replaced-local-still-used",
        "lang": "go",
        "base": {
            "go.mod": "module example.com/m\n\ngo 1.21\n",
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc h(x int) int { return x }\n\nfunc f(a int) int {\n\ty := a + 1\n\tg(y)\n\treturn y\n}\n"
        },
        "after": {
            "a.go": "package m\n\nfunc g(x int) int { return x }\n\nfunc h(x int) int { return x }\n\nfunc f(a int) int {\n\ty := a + 1\n\th(a)\n\treturn y\n}\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-cpp-call-instantiates-a-template-body",
        "lang": "cpp",
        "base": {
            "a.cpp": "struct Text { int size() const { return 1; } };\ntemplate <class T> int length(T t) {\n    return t.size();\n}\nint run() {\n    return 1;\n}\nint main() { return run(); }\n"
        },
        "after": {
            "a.cpp": "struct Text { int size() const { return 1; } };\ntemplate <class T> int length(T t) {\n    return t.size();\n}\nint run() {\n    length(5);\n    return 1;\n}\nint main() { return run(); }\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-cpp-call-instantiates-a-template-body-that-fits",
        "lang": "cpp",
        "base": {
            "a.cpp": "struct Text { int size() const { return 1; } };\ntemplate <class T> int length(T t) {\n    return t.size();\n}\nint run() {\n    return 1;\n}\nint main() { return run(); }\n"
        },
        "after": {
            "a.cpp": "struct Text { int size() const { return 1; } };\ntemplate <class T> int length(T t) {\n    return t.size();\n}\nint run() {\n    length(Text());\n    return 1;\n}\nint main() { return run(); }\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-ts-call-below-an-expect-error-directive-fixed",
        "lang": "ts",
        "base": {
            "lib.ts": "export function takesString(s: string): void { void s; }\nexport function f(n: number): number {\n  // @ts-expect-error\n  takesString(n);\n  return n;\n}\n"
        },
        "after": {
            "lib.ts": "export function takesString(s: string): void { void s; }\nexport function f(n: number): number {\n  // @ts-expect-error\n  takesString(String(n));\n  return n;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified) (module):module=review(checking-context-changed)"
    },
    {
        "id": "replaced-ts-guard-predicate-by-a-plain-call",
        "lang": "ts",
        "base": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function ok(x: unknown, tag: string): boolean { return x !== null && tag !== \"\"; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!isNum(v, tag)) return 0;\n  return v;\n}\n"
        },
        "after": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function ok(x: unknown, tag: string): boolean { return x !== null && tag !== \"\"; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!ok(v, tag)) return 0;\n  return v;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "replaced-py-assert-condition-by-a-plain-call",
        "lang": "py",
        "base": {
            "lib.py": "def valid(x: object) -> bool:\n    return x is not None\n\n\ndef f(x: int | None) -> int:\n    assert x is not None\n    return x + 1\n"
        },
        "after": {
            "lib.py": "def valid(x: object) -> bool:\n    return x is not None\n\n\ndef f(x: int | None) -> int:\n    assert valid(x)\n    return x + 1\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "replaced-py-assert-kept-and-call-added",
        "lang": "py",
        "base": {
            "lib.py": "def valid(x: object) -> bool:\n    return x is not None\n\n\ndef f(x: int | None) -> int:\n    assert x is not None\n    return x + 1\n"
        },
        "after": {
            "lib.py": "def valid(x: object) -> bool:\n    return x is not None\n\n\ndef f(x: int | None) -> int:\n    assert x is not None\n    valid(x)\n    return x + 1\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "f:modified=ready"
    },
    {
        "id": "replaced-rs-call-that-typed-a-local",
        "lang": "rs",
        "base": {
            "a.rs": "pub fn fill(v: &mut Vec<u8>) { v.push(1); }\n\npub fn note(x: u32) -> u32 { x }\n\npub fn run(seed: u32) -> usize {\n    let mut v = Vec::new();\n    fill(&mut v);\n    v.len() + seed as usize\n}\n"
        },
        "after": {
            "a.rs": "pub fn fill(v: &mut Vec<u8>) { v.push(1); }\n\npub fn note(x: u32) -> u32 { x }\n\npub fn run(seed: u32) -> usize {\n    let mut v = Vec::new();\n    note(seed);\n    v.len() + seed as usize\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "replaced-cs-out-assignment-by-a-plain-call",
        "lang": "cs",
        "base": {
            "m.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Library</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable><NoWarn>CS0169;CS0414;CS8618;IDE0051</NoWarn></PropertyGroup></Project>\n",
            "A.cs": "class A {\n    static void Init(out int n) {\n        n = 1;\n    }\n    static void Touch(string s) {\n    }\n    static int Run(string s) {\n        int n;\n        Init(out n);\n        return n;\n    }\n}\n"
        },
        "after": {
            "A.cs": "class A {\n    static void Init(out int n) {\n        n = 1;\n    }\n    static void Touch(string s) {\n    }\n    static int Run(string s) {\n        int n;\n        Touch(s);\n        return n;\n    }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "Run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "replaced-cs-assignment-by-a-discarded-call",
        "lang": "cs",
        "base": {
            "m.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><OutputType>Library</OutputType><TargetFramework>net8.0</TargetFramework><Nullable>disable</Nullable><NoWarn>CS0169;CS0414;CS8618;IDE0051</NoWarn></PropertyGroup></Project>\n",
            "A.cs": "class A {\n    static int F() {\n        return 1;\n    }\n    static void G() {\n    }\n    static int Run() {\n        int x;\n        x = F();\n        return x;\n    }\n}\n"
        },
        "after": {
            "A.cs": "class A {\n    static int F() {\n        return 1;\n    }\n    static void G() {\n    }\n    static int Run() {\n        int x;\n        G();\n        return x;\n    }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "Run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "replaced-java-assignment-by-a-discarded-call",
        "lang": "java",
        "base": {
            "Lib.java": "public class Lib {\n    static int f() {\n        return 1;\n    }\n    static void g() {\n    }\n    static int run() {\n        int x;\n        x = f();\n        return x;\n    }\n}\n"
        },
        "after": {
            "Lib.java": "public class Lib {\n    static int f() {\n        return 1;\n    }\n    static void g() {\n    }\n    static int run() {\n        int x;\n        g();\n        return x;\n    }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "replaced-java-assignment-kept-and-call-added",
        "lang": "java",
        "base": {
            "Lib.java": "public class Lib {\n    static int f() {\n        return 1;\n    }\n    static void g() {\n    }\n    static int run() {\n        int x;\n        x = f();\n        return x;\n    }\n}\n"
        },
        "after": {
            "Lib.java": "public class Lib {\n    static int f() {\n        return 1;\n    }\n    static void g() {\n    }\n    static int run() {\n        int x;\n        x = f();\n        g();\n        return x;\n    }\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "replaced-ts-guard-argument-wrapped",
        "lang": "ts",
        "base": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function ok(x: unknown, tag: string): boolean { return x !== null && tag !== \"\"; }\nexport function wrap(x: unknown): unknown { return x; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!isNum(v, tag)) return 0;\n  return v;\n}\n"
        },
        "after": {
            "lib.ts": "export function isNum(x: unknown, tag: string): x is number { return typeof x === \"number\" && tag !== \"\"; }\nexport function ok(x: unknown, tag: string): boolean { return x !== null && tag !== \"\"; }\nexport function wrap(x: unknown): unknown { return x; }\nexport function f(v: unknown, name: string): number {\n  const tag = name.trim();\n  if (!isNum(wrap(v), tag)) return 0;\n  return v;\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "replaced-ts-argument-extended",
        "lang": "ts",
        "base": {
            "lib.ts": "export function g(x: number, y = 0): number { return x + y; }\nexport function f(a: string): number {\n  g(a.length);\n  return 1;\n}\n"
        },
        "after": {
            "lib.ts": "export function g(x: number, y = 0): number { return x + y; }\nexport function f(a: string): number {\n  g(a.length, a.length);\n  return 1;\n}\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "f:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-loop-binding-moved-by-a-call",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn run(tokens: Vec<Token>) -> u32 {\n    let mut total = 0;\n    for token in tokens {\n        total += token.id;\n    }\n    total\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn run(tokens: Vec<Token>) -> u32 {\n    let mut total = 0;\n    for token in tokens {\n        consume(token);\n        total += token.id;\n    }\n    total\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-rs-if-let-binding-moved-by-a-call",
        "lang": "rs",
        "base": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn run(slot: Option<Token>) -> u32 {\n    if let Some(token) = slot {\n        return token.id;\n    }\n    0\n}\n"
        },
        "after": {
            "a.rs": "pub struct Token {\n    pub id: u32,\n}\n\npub fn consume(t: Token) -> u32 {\n    t.id\n}\n\npub fn run(slot: Option<Token>) -> u32 {\n    if let Some(token) = slot {\n        consume(token);\n        return token.id;\n    }\n    0\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-java-throwing-call-replaced-in-try-with-an-argument",
        "lang": "java",
        "base": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky(Object value) throws IOException {\n    }\n\n    static void safe(Object value) {\n    }\n\n    static int run(int seed) {\n        var count = seed + 1;\n        try {\n            risky(count);\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "after": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky(Object value) throws IOException {\n    }\n\n    static void safe(Object value) {\n    }\n\n    static int run(int seed) {\n        var count = seed + 1;\n        try {\n            safe(count);\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "written-java-throwing-call-replaced-in-renamed-method",
        "lang": "java",
        "base": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run() {\n        try {\n            risky();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "after": {
            "Lib.java": "import java.io.IOException;\n\npublic class Lib {\n    static void risky() throws IOException {\n    }\n\n    static void safe() {\n    }\n\n    static int run2() {\n        try {\n            safe();\n            return 1;\n        } catch (IOException e) {\n            return 0;\n        }\n    }\n}\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "run2:added=review(outgoing-call-unverified) run:deleted=ready"
    }
];
