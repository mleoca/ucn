/**
 * Changed calls that are settled, and the twins a toolchain rejects (fix #506).
 *
 * Each widening of what a changed call needs has a clean case the check
 * answers READY and a break twin the language's toolchain rejects: an
 * untyped parameter and a literal default, an argument the change did not
 * write, the caller's own parameter passed on, a new call whose value is
 * discarded or returned, a member reached through a receiver typed by its
 * construction, a callee name nothing binds. `expect` is the toolchain's
 * verdict (eval/run-check-matrix.js); `answer` and `detail` are the check's.
 */
'use strict';

module.exports = [
    {
        "id": "settled-py-untyped-extra-positional",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3, 5)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "name": "use_scale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_scale:modified=ready"
    },
    {
        "id": "settled-py-untyped-keywords",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(x=3, factor=1)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "name": "use_scale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_scale:modified=ready"
    },
    {
        "id": "settled-py-default-literal-of-another-type",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3, \"x\")\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "name": "use_scale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_scale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-default-float-into-int",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3, 5.5)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "name": "use_scale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_scale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-default-name-of-another-type",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    factor = \"x\"\n    return scale(3, factor)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "name": "use_scale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_scale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-untyped-any-expression",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    values = [1, 2]\n    return add(values, values[0:1])\n"
        },
        "name": "use_add",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_add:modified=ready"
    },
    {
        "id": "settled-py-none-default-takes-anything",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    note(\"x\", 3)\n    return add(1, 2)\n"
        },
        "name": "use_add",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_add:modified=ready"
    },
    {
        "id": "settled-py-result-follows-argument",
        "lang": "py",
        "base": {
            "lib.py": "def ident(v):\n    return v\n\n\ndef changed() -> int:\n    return ident(1)\n"
        },
        "after": {
            "lib.py": "def ident(v):\n    return v\n\n\ndef changed() -> int:\n    return ident(\"bad\")\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-result-follows-argument-through-operator",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n\n\ndef fresh():\n    return add(\"a\", \"b\") + scale(1)\n"
        },
        "name": "fresh",
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "fresh:added=ready"
    },
    {
        "id": "settled-py-result-in-operator-clean",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n\n\ndef fresh():\n    return add(1, 2) + scale(1)\n"
        },
        "name": "fresh",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "fresh:added=ready"
    },
    {
        "id": "settled-py-spread-of-a-longer-tuple",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    args = (1, 2, 3)\n    return add(*args)\n"
        },
        "name": "use_add",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_add:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-spread-of-a-fitting-tuple",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    args = (1, 2)\n    return add(*args)\n"
        },
        "name": "use_add",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_add:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-new-discarded-call",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    note(\"adding\")\n    return add(1, 2)\n"
        },
        "name": "use_add",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_add:modified=ready"
    },
    {
        "id": "settled-py-new-discarded-coroutine",
        "lang": "py",
        "base": {
            "lib.py": "async def notify(message):\n    return message\n\n\ndef changed():\n    return 1\n"
        },
        "after": {
            "lib.py": "async def notify(message):\n    return message\n\n\ndef changed():\n    notify(\"x\")\n    return 1\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-py-new-returned-same-written-type",
        "lang": "py",
        "base": {
            "lib.py": "def compute() -> int:\n    return 1\n\n\ndef other() -> str:\n    return \"s\"\n\n\ndef changed() -> int:\n    return 1\n\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute() -> int:\n    return 1\n\n\ndef other() -> str:\n    return \"s\"\n\n\ndef changed() -> int:\n    return compute()\n\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-py-new-returned-other-written-type",
        "lang": "py",
        "base": {
            "lib.py": "def compute() -> int:\n    return 1\n\n\ndef other() -> str:\n    return \"s\"\n\n\ndef changed() -> int:\n    return 1\n\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute() -> int:\n    return 1\n\n\ndef other() -> str:\n    return \"s\"\n\n\ndef changed() -> int:\n    return other()\n\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-new-returned-unannotated-result",
        "lang": "py",
        "base": {
            "lib.py": "def other():\n    return \"s\"\n\n\ndef changed() -> int:\n    return 1\n"
        },
        "after": {
            "lib.py": "def other():\n    return \"s\"\n\n\ndef changed() -> int:\n    return other()\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-new-result-bound-then-returned",
        "lang": "py",
        "base": {
            "lib.py": "def other() -> str:\n    return \"s\"\n\n\ndef changed() -> int:\n    return 1\n"
        },
        "after": {
            "lib.py": "def other() -> str:\n    return \"s\"\n\n\ndef changed() -> int:\n    value = other()\n    return value\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-own-parameter-of-another-type",
        "lang": "py",
        "base": {
            "helpers.py": "def audit(k: str) -> None:\n    print(k)\n",
            "lib.py": "from helpers import audit\n\n\ndef pick(k: int):\n    return 1\n\n\ndef other():\n    audit(\"x\")\n"
        },
        "after": {
            "lib.py": "from helpers import audit\n\n\ndef pick(k: int):\n    audit(k)\n    return 1\n\n\ndef other():\n    audit(\"x\")\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "settled-py-own-parameter-same-type-same-file",
        "lang": "py",
        "base": {
            "lib.py": "class Row:\n    pass\n\n\ndef audit(rows: list[Row]) -> None:\n    print(rows)\n\n\ndef pick(rows: list[Row]):\n    return 1\n"
        },
        "after": {
            "lib.py": "class Row:\n    pass\n\n\ndef audit(rows: list[Row]) -> None:\n    print(rows)\n\n\ndef pick(rows: list[Row]):\n    audit(rows)\n    return 1\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "settled-py-own-method-wrong-count",
        "lang": "py",
        "base": {
            "lib.py": "class Picker:\n    def audit(self):\n        print(\"x\")\n\n    def pick(self, k: str):\n        return 1\n"
        },
        "after": {
            "lib.py": "class Picker:\n    def audit(self):\n        print(\"x\")\n\n    def pick(self, k: str):\n        self.audit(k)\n        return 1\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "pick:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "settled-py-derived-owner-inherits-parameter-type",
        "lang": "py",
        "base": {
            "lib.py": "class Base:\n    def note(self, text: str) -> None:\n        print(text)\n\n\nclass Child(Base):\n    def note(self, text):\n        print(text)\n\n    def run(self):\n        return 1\n"
        },
        "after": {
            "lib.py": "class Base:\n    def note(self, text: str) -> None:\n        print(text)\n\n\nclass Child(Base):\n    def note(self, text):\n        print(text)\n\n    def run(self):\n        self.note(1)\n        return 1\n"
        },
        "name": "run",
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "settled-py-constructed-receiver-wrong-count",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def __init__(self, w, h):\n        self.w = w\n        self.h = h\n\n    def grow(self, by):\n        return Box(self.w + by, self.h + by)\n",
            "app.py": "from lib import Box\n\n\ndef use_grow():\n    return Box(1, 2).grow(1)\n"
        },
        "after": {
            "app.py": "from lib import Box\n\n\ndef use_grow():\n    return Box(1, 2).grow()\n"
        },
        "name": "use_grow",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "use_grow:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "settled-py-unbound-callee",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scalee(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "name": "use_scale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_scale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-builtin-callee",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return scale(3)\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "after": {
            "app.py": "from lib import add, note, scale\n\n\ndef use_scale():\n    return len([1, 2])\n\n\ndef use_add():\n    return add(1, 2)\n"
        },
        "name": "use_scale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_scale:modified=ready"
    },
    {
        "id": "settled-py-star-import-supplies-callee",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef note(message, level=None):\n    print(message, level)\n",
            "app.py": "from lib import *\n\n\ndef use_scale():\n    return 1\n"
        },
        "after": {
            "app.py": "from lib import *\n\n\ndef use_scale():\n    return scale(3)\n"
        },
        "name": "use_scale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_scale:modified=ready"
    },
    {
        "id": "settled-ts-default-typed-literal",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number, factor = 2): number { return x * factor; }\nexport function label(name: string, prefix = \"id\"): string { return prefix + name; }\nexport function note(level: number): void {}\n",
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  return scale(3);\n}\nexport function useLabel(): string {\n  return label(\"a\");\n}\n"
        },
        "after": {
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  return scale(3, 5);\n}\nexport function useLabel(): string {\n  return label(\"a\");\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "settled-ts-default-literal-of-another-type",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number, factor = 2): number { return x * factor; }\nexport function label(name: string, prefix = \"id\"): string { return prefix + name; }\nexport function note(level: number): void {}\n",
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  return scale(3);\n}\nexport function useLabel(): string {\n  return label(\"a\");\n}\n"
        },
        "after": {
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  return scale(3, \"x\");\n}\nexport function useLabel(): string {\n  return label(\"a\");\n}\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useScale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-default-string-literal",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number, factor = 2): number { return x * factor; }\nexport function label(name: string, prefix = \"id\"): string { return prefix + name; }\nexport function note(level: number): void {}\n",
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  return scale(3);\n}\nexport function useLabel(): string {\n  return label(\"a\");\n}\n"
        },
        "after": {
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  return scale(3);\n}\nexport function useLabel(): string {\n  return label(\"a\", \"key\");\n}\n"
        },
        "name": "useLabel",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useLabel:modified=ready"
    },
    {
        "id": "settled-ts-new-discarded-call",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number, factor = 2): number { return x * factor; }\nexport function label(name: string, prefix = \"id\"): string { return prefix + name; }\nexport function note(level: number): void {}\n",
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  return scale(3);\n}\nexport function useLabel(): string {\n  return label(\"a\");\n}\n"
        },
        "after": {
            "app.ts": "import { label, note, scale } from \"./lib\";\nexport function useScale(): number {\n  note(2);\n  return scale(3);\n}\nexport function useLabel(): string {\n  return label(\"a\");\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "settled-ts-new-call-needs-this",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(this: { value: number }): number { return this.value; }\nfunction changed(): number { return 1; }\nfunction consumer(): number { return changed() + compute.call({ value: 1 }); }\n"
        },
        "after": {
            "lib.ts": "function compute(this: { value: number }): number { return this.value; }\nfunction changed(): number { compute(); return 1; }\nfunction consumer(): number { return changed() + compute.call({ value: 1 }); }\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-new-call-through-type-only-import",
        "lang": "ts",
        "base": {
            "box.ts": "export function compute(): number { return 1; }\n",
            "lib.ts": "import type { compute } from \"./box\";\nexport type Compute = typeof compute;\nexport function changed(): number { return 1; }\n"
        },
        "after": {
            "lib.ts": "import type { compute } from \"./box\";\nexport type Compute = typeof compute;\nexport function changed(): number { compute(); return 1; }\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-returned-into-typed-holder",
        "lang": "ts",
        "base": {
            "lib.ts": "function stringValue(): string { return \"s\"; }\nconst changed: () => number = () => 1;\nexport function consumer(): number { return changed() + stringValue().length; }\n"
        },
        "after": {
            "lib.ts": "function stringValue(): string { return \"s\"; }\nconst changed: () => number = () => stringValue();\nexport function consumer(): number { return changed() + stringValue().length; }\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(inferred-return-contract,outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-own-parameter-shadowed-in-block",
        "lang": "ts",
        "base": {
            "lib.ts": "function audit(k: string): void {}\nexport function pick(k: string): number {\n  return 1;\n}\n"
        },
        "after": {
            "lib.ts": "function audit(k: string): void {}\nexport function pick(k: string): number {\n  { const k = 1; audit(k); }\n  return 1;\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "settled-ts-own-parameter-passed-on",
        "lang": "ts",
        "base": {
            "lib.ts": "function audit(k: string): void {}\nexport function pick(k: string): number {\n  return 1;\n}\n"
        },
        "after": {
            "lib.ts": "function audit(k: string): void {}\nexport function pick(k: string): number {\n  audit(k);\n  return 1;\n}\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "settled-py-returned-into-inferred-result-with-users",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n",
            "app.py": "from lib import scale\n\n\ndef use_scale():\n    return scale(3)\n",
            "use.py": "from app import use_scale\n\nn: int = use_scale()\n"
        },
        "after": {
            "app.py": "from lib import scale\n\n\ndef use_scale():\n    return scale(\"a\", 5)\n"
        },
        "name": "use_scale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_scale:modified=review(inferred-return-contract)"
    },
    {
        "id": "settled-py-inferred-result-reaches-written-type",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n",
            "app.py": "from lib import scale\n\n\ndef changed() -> int:\n    return 1\n"
        },
        "after": {
            "app.py": "from lib import scale\n\n\ndef helper():\n    return scale(\"a\")\n\n\ndef changed() -> int:\n    return helper()\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified) helper:added=ready"
    },
    {
        "id": "settled-py-local-function-called-before-its-line",
        "lang": "py",
        "base": {
            "lib.py": "def outer():\n    def inner():\n        return 1\n\n    return inner()\n"
        },
        "after": {
            "lib.py": "def outer():\n    inner()\n\n    def inner():\n        return 1\n\n    return inner()\n"
        },
        "name": "outer",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "outer:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-local-function-called-after-its-line",
        "lang": "py",
        "base": {
            "lib.py": "def outer():\n    def inner():\n        return 1\n\n    return 1\n"
        },
        "after": {
            "lib.py": "def outer():\n    def inner():\n        return 1\n\n    inner()\n    return 1\n"
        },
        "name": "outer",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "outer:modified=ready"
    },
    {
        "id": "settled-py-local-binding-answers-callee",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n",
            "app.py": "from lib import scale\n\n\ndef use_scale():\n    return scale(3)\n"
        },
        "after": {
            "app.py": "from lib import scale\n\n\ndef use_scale():\n    scale = lambda: 1\n    return scale()\n"
        },
        "name": "use_scale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use_scale:modified=ready"
    },
    {
        "id": "settled-py-global-statement-binds-callee",
        "lang": "py",
        "base": {
            "lib.py": "def setup():\n    global helper\n    helper = len\n\n\ndef use():\n    return 1\n"
        },
        "after": {
            "lib.py": "def setup():\n    global helper\n    helper = len\n\n\ndef use():\n    return helper(\"ab\")\n"
        },
        "name": "use",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "use:modified=ready"
    },
    {
        "id": "settled-py-unbound-callee-in-new-function",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n"
        },
        "after": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef fresh():\n    return missing_helper(1)\n"
        },
        "name": "fresh",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "fresh:added=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-exception-class-is-a-builtin",
        "lang": "py",
        "base": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n"
        },
        "after": {
            "lib.py": "def add(a, b):\n    return a + b\n\n\ndef scale(x, factor=2):\n    return x * factor\n\n\ndef fresh():\n    raise ValueError(\"no\")\n"
        },
        "name": "fresh",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "fresh:added=ready"
    },
    {
        "id": "settled-py-stub-file-types-the-parameter",
        "lang": "py",
        "base": {
            "lib.py": "def scale(x, factor=2):\n    return x * factor\n",
            "lib.pyi": "def scale(x: int, factor: int = ...) -> int: ...\n",
            "app.py": "from lib import scale\n\n\ndef use_scale():\n    return scale(3)\n"
        },
        "after": {
            "app.py": "from lib import scale\n\n\ndef use_scale():\n    return scale(\"a\")\n"
        },
        "name": "use_scale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use_scale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-own-parameter-that-may-be-absent",
        "lang": "ts",
        "base": {
            "lib.ts": "function audit(k: string): void {}\nexport function pick(k?: string): number {\n  return 1;\n}\nexport const kept = audit;\n"
        },
        "after": {
            "lib.ts": "function audit(k: string): void {}\nexport function pick(k?: string): number {\n  audit(k);\n  return 1;\n}\nexport const kept = audit;\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "settled-ts-function-value-typed-by-its-variable",
        "lang": "ts",
        "base": {
            "lib.ts": "const scale: (x: string) => number = function (x) { return x.length; };\nexport function changed(): number { return 1; }\nexport const kept = scale;\n"
        },
        "after": {
            "lib.ts": "const scale: (x: string) => number = function (x) { return x.length; };\nexport function changed(): number { scale(5); return 1; }\nexport const kept = scale;\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-arrow-typed-by-its-variable",
        "lang": "ts",
        "base": {
            "lib.ts": "const scale: (x: string) => number = (x) => x.length;\nexport function changed(): number { return 1; }\nexport const kept = scale;\n"
        },
        "after": {
            "lib.ts": "const scale: (x: string) => number = (x) => x.length;\nexport function changed(): number { scale(5); return 1; }\nexport const kept = scale;\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-own-method-through-another-this",
        "lang": "ts",
        "base": {
            "lib.ts": "export class Picker {\n  audit(): void {}\n  pick(k: string): number {\n    return 1;\n  }\n}\n"
        },
        "after": {
            "lib.ts": "export class Picker {\n  audit(): void {}\n  pick(k: string): number {\n    [1].forEach(function () { this.audit(); });\n    return 1;\n  }\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "settled-ts-own-method-new-call",
        "lang": "ts",
        "base": {
            "lib.ts": "export class Picker {\n  audit(level: number): void {}\n  pick(k: string): number {\n    return 1;\n  }\n}\n"
        },
        "after": {
            "lib.ts": "export class Picker {\n  audit(level: number): void {}\n  pick(k: string): number {\n    this.audit(2);\n    return 1;\n  }\n}\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "settled-py-returned-coroutine-as-its-result-type",
        "lang": "py",
        "base": {
            "lib.py": "async def compute() -> int:\n    return 1\n\n\ndef changed() -> int:\n    return 1\n"
        },
        "after": {
            "lib.py": "async def compute() -> int:\n    return 1\n\n\ndef changed() -> int:\n    return compute()\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-awaited-result-returned",
        "lang": "py",
        "base": {
            "lib.py": "async def compute() -> int:\n    return 1\n\n\nasync def changed() -> int:\n    return 1\n"
        },
        "after": {
            "lib.py": "async def compute() -> int:\n    return 1\n\n\nasync def changed() -> int:\n    return await compute()\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-py-method-of-derived-owner-returned",
        "lang": "py",
        "base": {
            "lib.py": "def text():\n    return \"s\"\n\n\nclass Base:\n    def value(self) -> int:\n        return 1\n\n\nclass Child(Base):\n    def value(self):\n        return 1\n"
        },
        "after": {
            "lib.py": "def text():\n    return \"s\"\n\n\nclass Base:\n    def value(self) -> int:\n        return 1\n\n\nclass Child(Base):\n    def value(self):\n        return text()\n"
        },
        "name": "value",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "value:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-generic-callee-returned",
        "lang": "ts",
        "base": {
            "lib.ts": "function first<T>(): T { return undefined as unknown as T; }\nexport function changed<T>(): T { return undefined as unknown as T; }\nexport const kept = first;\n"
        },
        "after": {
            "lib.ts": "function first<T>(): T { return undefined as unknown as T; }\nexport function changed<T>(): T { return first<string>(); }\nexport const kept = first;\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-py-keyword-into-default-typed-parameter",
        "lang": "py",
        "base": {
            "lib.py": "def greet(name, *, greeting=\"hi\"):\n    return greeting + name\n\n\ndef use():\n    return greet(\"a\")\n"
        },
        "after": {
            "lib.py": "def greet(name, *, greeting=\"hi\"):\n    return greeting + name\n\n\ndef use():\n    return greet(\"a\", greeting=3)\n"
        },
        "name": "use",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "use:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-go-literal-beside-kept-argument",
        "lang": "go",
        "base": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(1, label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow(1)\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow(1)\n}\n",
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(2, label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow(1)\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow(1)\n}\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-rs-literal-beside-kept-argument",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Bin { w: i32 }\nimpl Bin {\n    pub fn new() -> Bin { Bin { w: 1 } }\n    pub fn grow(&self, by: i32) -> Bin { Bin { w: self.w + by } }\n}\nfn consume(count: i32, label: &str) -> i32 { count + label.len() as i32 }\npub fn changed(label: &str) -> i32 {\n consume(1, label)\n}\npub fn use_grow() -> Bin {\n let b = Bin::new();\n b.grow(1)\n}\npub fn use_chain() -> Bin {\n Bin::new().grow(1)\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Bin { w: i32 }\nimpl Bin {\n    pub fn new() -> Bin { Bin { w: 1 } }\n    pub fn grow(&self, by: i32) -> Bin { Bin { w: self.w + by } }\n}\nfn consume(count: i32, label: &str) -> i32 { count + label.len() as i32 }\npub fn changed(label: &str) -> i32 {\n consume(2, label)\n}\npub fn use_grow() -> Bin {\n let b = Bin::new();\n b.grow(1)\n}\npub fn use_chain() -> Bin {\n Bin::new().grow(1)\n}\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-java-literal-beside-kept-argument",
        "lang": "java",
        "base": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(1, label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow(1);\n }\n static Bin useChain() {\n  return new Bin().grow(1);\n }\n}\n"
        },
        "after": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(2, label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow(1);\n }\n static Bin useChain() {\n  return new Bin().grow(1);\n }\n}\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-cs-literal-beside-kept-argument",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Bin {\n public int w = 1;\n public Bin Grow(int by) { var next = new Bin(); next.w = w + by; return next; }\n}\npublic class Demo {\n static int consume(int count, string label) { return count + label.Length; }\n public static int changed(string label) {\n  return consume(1, label);\n }\n public static Bin useGrow() {\n  Bin b = new Bin();\n  return b.Grow(1);\n }\n public static Bin useChain() {\n  return new Bin().Grow(1);\n }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Bin {\n public int w = 1;\n public Bin Grow(int by) { var next = new Bin(); next.w = w + by; return next; }\n}\npublic class Demo {\n static int consume(int count, string label) { return count + label.Length; }\n public static int changed(string label) {\n  return consume(2, label);\n }\n public static Bin useGrow() {\n  Bin b = new Bin();\n  return b.Grow(1);\n }\n public static Bin useChain() {\n  return new Bin().Grow(1);\n }\n}\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-cpp-literal-beside-kept-argument",
        "lang": "cpp",
        "base": {
            "main.cpp": "struct Bin {\n  int w = 1;\n  Bin grow(int by) const { Bin next; next.w = w + by; return next; }\n};\nint consume(int count, const char* label) { return count + (label ? 1 : 0); }\nint changed(const char* label) {\n  return consume(1, label);\n}\nBin useGrow() {\n  Bin b;\n  return b.grow(1);\n}\nBin useChain() {\n  return Bin().grow(1);\n}\nint main() { return changed(\"x\") + useGrow().w + useChain().w; }\n"
        },
        "after": {
            "main.cpp": "struct Bin {\n  int w = 1;\n  Bin grow(int by) const { Bin next; next.w = w + by; return next; }\n};\nint consume(int count, const char* label) { return count + (label ? 1 : 0); }\nint changed(const char* label) {\n  return consume(2, label);\n}\nBin useGrow() {\n  Bin b;\n  return b.grow(1);\n}\nBin useChain() {\n  return Bin().grow(1);\n}\nint main() { return changed(\"x\") + useGrow().w + useChain().w; }\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-ts-literal-beside-kept-argument",
        "lang": "ts",
        "base": {
            "lib.ts": "class Bin { w = 1; grow(by: number): Bin { const next = new Bin(); next.w = this.w + by; return next; } }\nfunction consume(count: number, label: string): number { return count + label.length; }\nexport function changed(label: string): number {\n  return consume(1, label);\n}\nexport function useGrow(): Bin {\n  const b = new Bin();\n  return b.grow(1);\n}\n"
        },
        "after": {
            "lib.ts": "class Bin { w = 1; grow(by: number): Bin { const next = new Bin(); next.w = this.w + by; return next; } }\nfunction consume(count: number, label: string): number { return count + label.length; }\nexport function changed(label: string): number {\n  return consume(2, label);\n}\nexport function useGrow(): Bin {\n  const b = new Bin();\n  return b.grow(1);\n}\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-py-literal-beside-kept-argument",
        "lang": "py",
        "base": {
            "lib.py": "def consume(count: int, label: str) -> int:\n    return count + len(label)\n\n\ndef changed(label: str) -> int:\n    return consume(1, label)\n"
        },
        "after": {
            "lib.py": "def consume(count: int, label: str) -> int:\n    return count + len(label)\n\n\ndef changed(label: str) -> int:\n    return consume(2, label)\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "settled-go-literal-into-kept-slot",
        "lang": "go",
        "base": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(1, label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow(1)\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow(1)\n}\n",
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(\"x\", label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow(1)\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow(1)\n}\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-java-literal-into-kept-slot",
        "lang": "java",
        "base": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(1, label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow(1);\n }\n static Bin useChain() {\n  return new Bin().grow(1);\n }\n}\n"
        },
        "after": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(\"x\", label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow(1);\n }\n static Bin useChain() {\n  return new Bin().grow(1);\n }\n}\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-go-constructed-receiver-wrong-count",
        "lang": "go",
        "base": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(1, label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow(1)\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow(1)\n}\n",
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(1, label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow()\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow(1)\n}\n"
        },
        "name": "useGrow",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useGrow:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "settled-go-literal-receiver-wrong-count",
        "lang": "go",
        "base": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(1, label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow(1)\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow(1)\n}\n",
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Box struct{ w int }\n\nfunc (b Box) Grow(by int) Box { return Box{b.w + by} }\n\nfunc NewBox() Box { return Box{1} }\n\nfunc consume(count int, label string) int { return count + len(label) }\n\nfunc changed(label string) int {\n return consume(1, label)\n}\n\nfunc useGrow() Box {\n b := NewBox()\n return b.Grow(1)\n}\n\nfunc useLiteral() Box {\n return Box{1}.Grow()\n}\n"
        },
        "name": "useLiteral",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useLiteral:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "settled-rs-constructed-receiver-wrong-count",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Bin { w: i32 }\nimpl Bin {\n    pub fn new() -> Bin { Bin { w: 1 } }\n    pub fn grow(&self, by: i32) -> Bin { Bin { w: self.w + by } }\n}\nfn consume(count: i32, label: &str) -> i32 { count + label.len() as i32 }\npub fn changed(label: &str) -> i32 {\n consume(1, label)\n}\npub fn use_grow() -> Bin {\n let b = Bin::new();\n b.grow(1)\n}\npub fn use_chain() -> Bin {\n Bin::new().grow(1)\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Bin { w: i32 }\nimpl Bin {\n    pub fn new() -> Bin { Bin { w: 1 } }\n    pub fn grow(&self, by: i32) -> Bin { Bin { w: self.w + by } }\n}\nfn consume(count: i32, label: &str) -> i32 { count + label.len() as i32 }\npub fn changed(label: &str) -> i32 {\n consume(1, label)\n}\npub fn use_grow() -> Bin {\n let b = Bin::new();\n b.grow()\n}\npub fn use_chain() -> Bin {\n Bin::new().grow(1)\n}\n"
        },
        "name": "use_grow",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "use_grow:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "settled-rs-chained-receiver-wrong-count",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Bin { w: i32 }\nimpl Bin {\n    pub fn new() -> Bin { Bin { w: 1 } }\n    pub fn grow(&self, by: i32) -> Bin { Bin { w: self.w + by } }\n}\nfn consume(count: i32, label: &str) -> i32 { count + label.len() as i32 }\npub fn changed(label: &str) -> i32 {\n consume(1, label)\n}\npub fn use_grow() -> Bin {\n let b = Bin::new();\n b.grow(1)\n}\npub fn use_chain() -> Bin {\n Bin::new().grow(1)\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Bin { w: i32 }\nimpl Bin {\n    pub fn new() -> Bin { Bin { w: 1 } }\n    pub fn grow(&self, by: i32) -> Bin { Bin { w: self.w + by } }\n}\nfn consume(count: i32, label: &str) -> i32 { count + label.len() as i32 }\npub fn changed(label: &str) -> i32 {\n consume(1, label)\n}\npub fn use_grow() -> Bin {\n let b = Bin::new();\n b.grow(1)\n}\npub fn use_chain() -> Bin {\n Bin::new().grow()\n}\n"
        },
        "name": "use_chain",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "use_chain:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "settled-java-constructed-receiver-wrong-count",
        "lang": "java",
        "base": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(1, label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow(1);\n }\n static Bin useChain() {\n  return new Bin().grow(1);\n }\n}\n"
        },
        "after": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(1, label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow();\n }\n static Bin useChain() {\n  return new Bin().grow(1);\n }\n}\n"
        },
        "name": "useGrow",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useGrow:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-java-chained-receiver-wrong-count",
        "lang": "java",
        "base": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(1, label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow(1);\n }\n static Bin useChain() {\n  return new Bin().grow(1);\n }\n}\n"
        },
        "after": {
            "Demo.java": "class Bin {\n int w = 1;\n Bin grow(int by) { Bin next = new Bin(); next.w = w + by; return next; }\n}\nclass Demo {\n static int consume(int count, String label) { return count + label.length(); }\n static int changed(String label) {\n  return consume(1, label);\n }\n static Bin useGrow() {\n  Bin b = new Bin();\n  return b.grow(1);\n }\n static Bin useChain() {\n  return new Bin().grow();\n }\n}\n"
        },
        "name": "useChain",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useChain:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-cs-constructed-receiver-wrong-count",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Bin {\n public int w = 1;\n public Bin Grow(int by) { var next = new Bin(); next.w = w + by; return next; }\n}\npublic class Demo {\n static int consume(int count, string label) { return count + label.Length; }\n public static int changed(string label) {\n  return consume(1, label);\n }\n public static Bin useGrow() {\n  Bin b = new Bin();\n  return b.Grow(1);\n }\n public static Bin useChain() {\n  return new Bin().Grow(1);\n }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Bin {\n public int w = 1;\n public Bin Grow(int by) { var next = new Bin(); next.w = w + by; return next; }\n}\npublic class Demo {\n static int consume(int count, string label) { return count + label.Length; }\n public static int changed(string label) {\n  return consume(1, label);\n }\n public static Bin useGrow() {\n  Bin b = new Bin();\n  return b.Grow();\n }\n public static Bin useChain() {\n  return new Bin().Grow(1);\n }\n}\n"
        },
        "name": "useGrow",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useGrow:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-cs-chained-receiver-wrong-count",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Bin {\n public int w = 1;\n public Bin Grow(int by) { var next = new Bin(); next.w = w + by; return next; }\n}\npublic class Demo {\n static int consume(int count, string label) { return count + label.Length; }\n public static int changed(string label) {\n  return consume(1, label);\n }\n public static Bin useGrow() {\n  Bin b = new Bin();\n  return b.Grow(1);\n }\n public static Bin useChain() {\n  return new Bin().Grow(1);\n }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Bin {\n public int w = 1;\n public Bin Grow(int by) { var next = new Bin(); next.w = w + by; return next; }\n}\npublic class Demo {\n static int consume(int count, string label) { return count + label.Length; }\n public static int changed(string label) {\n  return consume(1, label);\n }\n public static Bin useGrow() {\n  Bin b = new Bin();\n  return b.Grow(1);\n }\n public static Bin useChain() {\n  return new Bin().Grow();\n }\n}\n"
        },
        "name": "useChain",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useChain:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-cpp-constructed-receiver-wrong-count",
        "lang": "cpp",
        "base": {
            "main.cpp": "struct Bin {\n  int w = 1;\n  Bin grow(int by) const { Bin next; next.w = w + by; return next; }\n};\nint consume(int count, const char* label) { return count + (label ? 1 : 0); }\nint changed(const char* label) {\n  return consume(1, label);\n}\nBin useGrow() {\n  Bin b;\n  return b.grow(1);\n}\nBin useChain() {\n  return Bin().grow(1);\n}\nint main() { return changed(\"x\") + useGrow().w + useChain().w; }\n"
        },
        "after": {
            "main.cpp": "struct Bin {\n  int w = 1;\n  Bin grow(int by) const { Bin next; next.w = w + by; return next; }\n};\nint consume(int count, const char* label) { return count + (label ? 1 : 0); }\nint changed(const char* label) {\n  return consume(1, label);\n}\nBin useGrow() {\n  Bin b;\n  return b.grow();\n}\nBin useChain() {\n  return Bin().grow(1);\n}\nint main() { return changed(\"x\") + useGrow().w + useChain().w; }\n"
        },
        "name": "useGrow",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useGrow:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "settled-cpp-chained-receiver-wrong-count",
        "lang": "cpp",
        "base": {
            "main.cpp": "struct Bin {\n  int w = 1;\n  Bin grow(int by) const { Bin next; next.w = w + by; return next; }\n};\nint consume(int count, const char* label) { return count + (label ? 1 : 0); }\nint changed(const char* label) {\n  return consume(1, label);\n}\nBin useGrow() {\n  Bin b;\n  return b.grow(1);\n}\nBin useChain() {\n  return Bin().grow(1);\n}\nint main() { return changed(\"x\") + useGrow().w + useChain().w; }\n"
        },
        "after": {
            "main.cpp": "struct Bin {\n  int w = 1;\n  Bin grow(int by) const { Bin next; next.w = w + by; return next; }\n};\nint consume(int count, const char* label) { return count + (label ? 1 : 0); }\nint changed(const char* label) {\n  return consume(1, label);\n}\nBin useGrow() {\n  Bin b;\n  return b.grow(1);\n}\nBin useChain() {\n  return Bin().grow();\n}\nint main() { return changed(\"x\") + useGrow().w + useChain().w; }\n"
        },
        "name": "useChain",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useChain:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "settled-ts-constructed-receiver-wrong-count",
        "lang": "ts",
        "base": {
            "lib.ts": "class Bin { w = 1; grow(by: number): Bin { const next = new Bin(); next.w = this.w + by; return next; } }\nfunction consume(count: number, label: string): number { return count + label.length; }\nexport function changed(label: string): number {\n  return consume(1, label);\n}\nexport function useGrow(): Bin {\n  const b = new Bin();\n  return b.grow(1);\n}\n"
        },
        "after": {
            "lib.ts": "class Bin { w = 1; grow(by: number): Bin { const next = new Bin(); next.w = this.w + by; return next; } }\nfunction consume(count: number, label: string): number { return count + label.length; }\nexport function changed(label: string): number {\n  return consume(1, label);\n}\nexport function useGrow(): Bin {\n  const b = new Bin();\n  return b.grow();\n}\n"
        },
        "name": "useGrow",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useGrow:modified=blocked(outgoing-signature-mismatch)"
    }
];
