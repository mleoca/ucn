/** Generic changed outgoing-call families (fix #502). */
'use strict';

module.exports = [
    {
        "id": "outgoing-py-missing",
        "lang": "py",
        "base": {
            "lib.py": "def scale(x: int) -> int:\n    return x * 2\n",
            "app.py": "from lib import scale\n\ndef useScale() -> int:\n    return scale(1)\n",
            "consumer.py": "from app import useScale\n\ndef consume() -> int:\n    return useScale()\n"
        },
        "after": {
            "app.py": "from lib import scale\n\ndef useScale() -> int:\n    return scale()\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-py-valid",
        "lang": "py",
        "base": {
            "lib.py": "def scale(x: int) -> int:\n    return x * 2\n",
            "app.py": "from lib import scale\n\ndef useScale() -> int:\n    return scale(1)\n",
            "consumer.py": "from app import useScale\n\ndef consume() -> int:\n    return useScale()\n"
        },
        "after": {
            "app.py": "from lib import scale\n\ndef useScale() -> int:\n    return scale(2)\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-ts-missing",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number): number { return x * 2; }\n",
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(1);\n}\n",
            "consumer.ts": "import { useScale } from \"./app\";\nexport function consume(): number { return useScale(); }\n"
        },
        "after": {
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale();\n}\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-ts-valid",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number): number { return x * 2; }\n",
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(1);\n}\n",
            "consumer.ts": "import { useScale } from \"./app\";\nexport function consume(): number { return useScale(); }\n"
        },
        "after": {
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(2);\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-go-missing",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc scale(x int) int { return x * 2 }\nfunc useScale() int {\n return scale(1)\n}\nfunc consume() int { return useScale() }\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc scale(x int) int { return x * 2 }\nfunc useScale() int {\n return scale()\n}\nfunc consume() int { return useScale() }\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-go-valid",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc scale(x int) int { return x * 2 }\nfunc useScale() int {\n return scale(1)\n}\nfunc consume() int { return useScale() }\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc scale(x int) int { return x * 2 }\nfunc useScale() int {\n return scale(2)\n}\nfunc consume() int { return useScale() }\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-rs-missing",
        "lang": "rs",
        "base": {
            "lib.rs": "fn scale(x: i32) -> i32 { x * 2 }\nfn useScale() -> i32 {\n scale(1)\n}\npub fn consume() -> i32 { useScale() }\n"
        },
        "after": {
            "lib.rs": "fn scale(x: i32) -> i32 { x * 2 }\nfn useScale() -> i32 {\n scale()\n}\npub fn consume() -> i32 { useScale() }\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-rs-valid",
        "lang": "rs",
        "base": {
            "lib.rs": "fn scale(x: i32) -> i32 { x * 2 }\nfn useScale() -> i32 {\n scale(1)\n}\npub fn consume() -> i32 { useScale() }\n"
        },
        "after": {
            "lib.rs": "fn scale(x: i32) -> i32 { x * 2 }\nfn useScale() -> i32 {\n scale(2)\n}\npub fn consume() -> i32 { useScale() }\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-java-missing",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale(1);\n }\n static int consume() { return useScale(); }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale();\n }\n static int consume() { return useScale(); }\n}\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-java-valid",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale(1);\n }\n static int consume() { return useScale(); }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale(2);\n }\n static int consume() { return useScale(); }\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-cs-missing",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale(1);\n }\n public static int consume() { return useScale(); }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale();\n }\n public static int consume() { return useScale(); }\n}\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-cs-valid",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale(1);\n }\n public static int consume() { return useScale(); }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Demo {\n static int scale(int x) { return x * 2; }\n static int useScale() {\n  return scale(2);\n }\n public static int consume() { return useScale(); }\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-cpp-missing",
        "lang": "cpp",
        "base": {
            "main.cpp": "int scale(int x) { return x * 2; }\nint useScale() {\n return scale(1);\n}\nint main() { return useScale(); }\n"
        },
        "after": {
            "main.cpp": "int scale(int x) { return x * 2; }\nint useScale() {\n return scale();\n}\nint main() { return useScale(); }\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useScale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-cpp-valid",
        "lang": "cpp",
        "base": {
            "main.cpp": "int scale(int x) { return x * 2; }\nint useScale() {\n return scale(1);\n}\nint main() { return useScale(); }\n"
        },
        "after": {
            "main.cpp": "int scale(int x) { return x * 2; }\nint useScale() {\n return scale(2);\n}\nint main() { return useScale(); }\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-c-missing",
        "lang": "c",
        "base": {
            "main.c": "int scale(int x) { return x * 2; }\nint useScale(void) {\n return scale(1);\n}\nint main(void) { return useScale(); }\n"
        },
        "after": {
            "main.c": "int scale(int x) { return x * 2; }\nint useScale(void) {\n return scale();\n}\nint main(void) { return useScale(); }\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-c-valid",
        "lang": "c",
        "base": {
            "main.c": "int scale(int x) { return x * 2; }\nint useScale(void) {\n return scale(1);\n}\nint main(void) { return useScale(); }\n"
        },
        "after": {
            "main.c": "int scale(int x) { return x * 2; }\nint useScale(void) {\n return scale(2);\n}\nint main(void) { return useScale(); }\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-js-missing",
        "lang": "js",
        "base": {
            "lib.js": "exports.scale = function scale(x) { if (arguments.length !== 1) throw new TypeError(\"one argument required\"); return x * 2; };\n",
            "app.js": "const { scale } = require(\"./lib\");\nfunction useScale() {\n scale(1);\n return 0;\n}\nexports.useScale = useScale;\n",
            "consumer.js": "const { useScale } = require(\"./app\");\nuseScale();\n"
        },
        "after": {
            "app.js": "const { scale } = require(\"./lib\");\nfunction useScale() {\n scale();\n return 0;\n}\nexports.useScale = useScale;\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useScale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-js-valid",
        "lang": "js",
        "base": {
            "lib.js": "exports.scale = function scale(x) { if (arguments.length !== 1) throw new TypeError(\"one argument required\"); return x * 2; };\n",
            "app.js": "const { scale } = require(\"./lib\");\nfunction useScale() {\n scale(1);\n return 0;\n}\nexports.useScale = useScale;\n",
            "consumer.js": "const { useScale } = require(\"./app\");\nuseScale();\n"
        },
        "after": {
            "app.js": "const { scale } = require(\"./lib\");\nfunction useScale() {\n scale(2);\n return 0;\n}\nexports.useScale = useScale;\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "useScale:modified=ready"
    },
    {
        "id": "outgoing-go-added",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc scale(x int) int { return x * 2 }\nfunc useScale() int {\n return scale(1)\n}\nfunc consume() int { return useScale() }\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc scale(x int) int { return x * 2 }\nfunc useScale() int {\n return scale(1)\n}\nfunc consume() int { return useScale() }\n\nfunc freshAdded() int { return scale() }\n"
        },
        "name": "freshAdded",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "freshAdded:added=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-rs-added",
        "lang": "rs",
        "base": {
            "lib.rs": "fn scale(x: i32) -> i32 { x * 2 }\nfn useScale() -> i32 {\n scale(1)\n}\npub fn consume() -> i32 { useScale() }\n"
        },
        "after": {
            "lib.rs": "fn scale(x: i32) -> i32 { x * 2 }\nfn useScale() -> i32 {\n scale(1)\n}\npub fn consume() -> i32 { useScale() }\n\nfn freshAdded() -> i32 { scale() }\n"
        },
        "name": "freshAdded",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "freshAdded:added=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-ts-added",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number): number { return x * 2; }\n",
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(1);\n}\n",
            "consumer.ts": "import { useScale } from \"./app\";\nexport function consume(): number { return useScale(); }\n"
        },
        "after": {
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(1);\n}\n\nexport function freshAdded(): number { return scale(); }\n"
        },
        "name": "freshAdded",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "freshAdded:added=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-ts-suppressed",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number): number { return x * 2; }\n",
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(1);\n}\n",
            "consumer.ts": "import { useScale } from \"./app\";\nexport function consume(): number { return useScale(); }\n"
        },
        "after": {
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n // @ts-ignore\n return scale();\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "useScale:modified=review(site-not-checked) (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-ts-spread-tuple",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number): number { return x * 2; }\n",
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(1);\n}\n",
            "consumer.ts": "import { useScale } from \"./app\";\nexport function consume(): number { return useScale(); }\n"
        },
        "after": {
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n const args: [number] = [2];\n return scale(...args);\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "useScale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-ts-overload-valid",
        "lang": "ts",
        "base": {
            "lib.ts": "export function scale(x: number): number;\nexport function scale(x: string): number;\nexport function scale(x: number | string): number { return Number(x); }\n",
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(1);\n}\n",
            "consumer.ts": "import { useScale } from \"./app\";\nexport function consume(): number { return useScale(); }\n"
        },
        "after": {
            "app.ts": "import { scale } from \"./lib\";\nexport function useScale(): number {\n return scale(\"2\");\n}\n"
        },
        "name": "useScale",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "useScale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-ts-method-missing",
        "lang": "ts",
        "base": {
            "lib.ts": "export class Calc { scale(x: number): number { return x * 2; } }\n",
            "app.ts": "import { Calc } from \"./lib\";\nexport function useScale(): number {\n return new Calc().scale(1);\n}\n",
            "consumer.ts": "import { useScale } from \"./app\";\nexport function consume(): number { return useScale(); }\n"
        },
        "after": {
            "app.ts": "import { Calc } from \"./lib\";\nexport function useScale(): number {\n return new Calc().scale();\n}\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "useScale:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-py-constructor-missing",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def __init__(self, x: int):\n        self.value = x\n",
            "app.py": "from lib import Box\n\ndef useScale() -> int:\n    return Box(1).value\n",
            "consumer.py": "from app import useScale\n\ndef consume() -> int:\n    return useScale()\n"
        },
        "after": {
            "app.py": "from lib import Box\n\ndef useScale() -> int:\n    return Box().value\n"
        },
        "name": "useScale",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "useScale:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-review-py-argument-type",
        "lang": "py",
        "base": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    return compute(1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    return compute(\"bad\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-py-argument-literal-valid",
        "lang": "py",
        "base": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    return compute(1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    return compute(3)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review-ts-argument-type",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n  return compute(1);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n  return compute(\"bad\");\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-ts-argument-literal-valid",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n  return compute(1);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n  return compute(3);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review-go-argument-type",
        "lang": "go",
        "base": {
            "lib.go": "package probe\nfunc compute(value int) int { return value * 2 }\nfunc changed() int {\n return compute(1)\n}\nfunc consumer() int { return changed() }\n",
            "go.mod": "module example.invalid/review\n\ngo 1.20\n"
        },
        "after": {
            "lib.go": "package probe\nfunc compute(value int) int { return value * 2 }\nfunc changed() int {\n return compute(\"bad\")\n}\nfunc consumer() int { return changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-rs-argument-type",
        "lang": "rs",
        "base": {
            "lib.rs": "fn compute(value: i32) -> i32 { value * 2 }\nfn changed() -> i32 {\n compute(1)\n}\npub fn consumer() -> i32 { changed() }\n"
        },
        "after": {
            "lib.rs": "fn compute(value: i32) -> i32 { value * 2 }\nfn changed() -> i32 {\n compute(\"bad\")\n}\npub fn consumer() -> i32 { changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-java-argument-type",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n static int compute(int value) { return value * 2; }\n static int changed() {\n  return compute(1);\n }\n static int consumer() { return changed(); }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n static int compute(int value) { return value * 2; }\n static int changed() {\n  return compute(\"bad\");\n }\n static int consumer() { return changed(); }\n}\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-cs-argument-type",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo {\n static int compute(int value) { return value * 2; }\n static int changed() {\n  return compute(1);\n }\n static int consumer() { return changed(); }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "public class Demo {\n static int compute(int value) { return value * 2; }\n static int changed() {\n  return compute(\"bad\");\n }\n static int consumer() { return changed(); }\n}\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-cpp-argument-type",
        "lang": "cpp",
        "base": {
            "lib.cpp": "int compute(int value) { return value * 2; }\nint changed() {\n return compute(1);\n}\nint consumer() { return changed(); }\n\nint main() { return consumer(); }\n"
        },
        "after": {
            "lib.cpp": "int compute(int value) { return value * 2; }\nint changed() {\n return compute(\"bad\");\n}\nint consumer() { return changed(); }\n\nint main() { return consumer(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-c-argument-type",
        "lang": "c",
        "base": {
            "lib.c": "int compute(int value) { return value * 2; }\nint changed() {\n return compute(1);\n}\nint consumer() { return changed(); }\n"
        },
        "after": {
            "lib.c": "int compute(int value) { return value * 2; }\nint changed() {\n return compute(\"bad\");\n}\nint consumer() { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-ts-local-alias-rebound",
        "lang": "ts",
        "base": {
            "lib.ts": "function zero(): number { return 0; }\nfunction one(value: number): number { return value; }\nfunction changed(): number {\n  const invoke = zero;\n  return invoke();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function zero(): number { return 0; }\nfunction one(value: number): number { return value; }\nfunction changed(): number {\n  const invoke = one;\n  return invoke();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "BLOCKED",
        "detail": "changed:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-review-ts-argument-binding-type",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n const value = 1;\n return compute(value);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n const value = \"bad\";\n return compute(value);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-py-argument-binding-type",
        "lang": "py",
        "base": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    value = 1\n    return compute(value)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    value = \"bad\"\n    return compute(value)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-ts-receiver-rebound",
        "lang": "ts",
        "base": {
            "lib.ts": "class First { read(): number { return 1; } }\nclass Second { read(value: number): number { return value; } }\nfunction changed(): number {\n const item = new First();\n return item.read();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "class First { read(): number { return 1; } }\nclass Second { read(value: number): number { return value; } }\nfunction changed(): number {\n const item = new Second();\n return item.read();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-py-receiver-rebound",
        "lang": "py",
        "base": {
            "lib.py": "class First:\n    def read(self) -> int:\n        return 1\n\nclass Second:\n    def read(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    item = First()\n    return item.read()\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "class First:\n    def read(self) -> int:\n        return 1\n\nclass Second:\n    def read(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    item = Second()\n    return item.read()\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-ts-suppression-removed",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n  // @ts-ignore\n  return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value * 2; }\nfunction changed(): number {\n  return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "BLOCKED",
        "detail": "changed:modified=blocked(outgoing-signature-mismatch) (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review-py-suppression-removed",
        "lang": "py",
        "base": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    return compute()  # type: ignore\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute(value: int) -> int:\n    return value * 2\n\ndef changed() -> int:\n    return compute()\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "BLOCKED",
        "detail": "changed:modified=blocked(outgoing-signature-mismatch) (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review-ts-overloaded-constructor-invalid",
        "lang": "ts",
        "base": {
            "lib.ts": "class Box {\n constructor(value: number);\n constructor(value: string);\n constructor(value: number | string) {}\n}\nfunction changed(): number {\n new Box(1);\n return 1;\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "class Box {\n constructor(value: number);\n constructor(value: string);\n constructor(value: number | string) {}\n}\nfunction changed(): number {\n new Box(true);\n return 1;\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-ts-overloaded-constructor-valid",
        "lang": "ts",
        "base": {
            "lib.ts": "class Box {\n constructor(value: number);\n constructor(value: string);\n constructor(value: number | string) {}\n}\nfunction changed(): number {\n new Box(1);\n return 1;\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "class Box {\n constructor(value: number);\n constructor(value: string);\n constructor(value: number | string) {}\n}\nfunction changed(): number {\n new Box(\"ok\");\n return 1;\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-ts-same-line-alias-bad",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n const invoke = compute;\n return compute(1) + invoke(2);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n const invoke = compute;\n return compute(1) + invoke();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "BLOCKED",
        "detail": "changed:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-review-ts-same-line-alias-suppressed",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n const invoke = compute;\n return compute(1) + invoke(2);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n const invoke = compute;\n // @ts-ignore\n return compute(1) + invoke();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(site-not-checked,outgoing-call-unverified) (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review-ts-root-expression-arrow-missing",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nconst changed = (): number => compute(1);\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nconst changed = (): number => compute();\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "BLOCKED",
        "detail": "changed:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-review-ts-root-expression-arrow-valid",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nconst changed = (): number => compute(1);\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nconst changed = (): number => compute(2);\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review-rs-small-integer-overflow",
        "lang": "rs",
        "base": {
            "lib.rs": "fn compute(value: i8) -> i8 { value }\nfn changed() -> i8 { compute(1) }\npub fn consumer() -> i8 { changed() }\n"
        },
        "after": {
            "lib.rs": "fn compute(value: i8) -> i8 { value }\nfn changed() -> i8 { compute(128) }\npub fn consumer() -> i8 { changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-rs-small-integer-valid",
        "lang": "rs",
        "base": {
            "lib.rs": "fn compute(value: i8) -> i8 { value }\nfn changed() -> i8 { compute(1) }\npub fn consumer() -> i8 { changed() }\n"
        },
        "after": {
            "lib.rs": "fn compute(value: i8) -> i8 { value }\nfn changed() -> i8 { compute(3) }\npub fn consumer() -> i8 { changed() }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review-ts-private-constructor",
        "lang": "ts",
        "base": {
            "lib.ts": "class Box { private constructor() {} }\nfunction changed(): number { return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "class Box { private constructor() {} }\nfunction changed(): number { new Box(); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-ts-abstract-constructor",
        "lang": "ts",
        "base": {
            "lib.ts": "abstract class Box {}\nfunction changed(): number { return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "abstract class Box {}\nfunction changed(): number { new Box(); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-js-caller-ts-target-arity",
        "lang": "js",
        "base": {
            "lib.ts": "export function compute(value: number): number { return value; }\n",
            "app.js": "const { compute } = require(\"./lib\");\nfunction changed() { compute(1); return 1; }\nmodule.exports.changed = changed;\n"
        },
        "after": {
            "app.js": "const { compute } = require(\"./lib\");\nfunction changed() { compute(); return 1; }\nmodule.exports.changed = changed;\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review-py-bytes-not-string",
        "lang": "py",
        "base": {
            "lib.py": "def compute(value: str) -> int:\n    return len(value)\n\ndef changed() -> int:\n    return compute(\"ok\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute(value: str) -> int:\n    return len(value)\n\ndef changed() -> int:\n    return compute(b\"bad\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-required-this",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(this: { value: number }, x: number): number { return x; }\nfunction changed(): number {\n return compute.call({value: 1}, 1);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(this: { value: number }, x: number): number { return x; }\nfunction changed(): number {\n return compute(2);\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-public-overload-literal",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: 1): number;\nfunction compute(x: number): number { return x; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: 1): number;\nfunction compute(x: number): number { return x; }\nfunction changed(): number { return compute(2); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-public-overload-type",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: number): number;\nfunction compute(x: number | string): number { return 1; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: number): number;\nfunction compute(x: number | string): number { return 1; }\nfunction changed(): number { return compute(\"bad\"); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-public-constructor-literal",
        "lang": "ts",
        "base": {
            "lib.ts": "class Box { constructor(x: 1); constructor(x: number) {} }\nfunction changed(): number { new Box(1); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "class Box { constructor(x: 1); constructor(x: number) {} }\nfunction changed(): number { new Box(2); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-type-only-construction",
        "lang": "ts",
        "base": {
            "lib.ts": "import type { Box } from \"./box\";\nfunction changed(): number { return 1; }\nfunction consumer(): number { return changed(); }\n",
            "box.ts": "export class Box {}\n"
        },
        "after": {
            "lib.ts": "import type { Box } from \"./box\";\nfunction changed(): number { new Box(); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-zeroarg-generic-constraint",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute<T extends number>(): T { return 1 as T; }\nfunction changed(): number { compute<number>(); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute<T extends number>(): T { return 1 as T; }\nfunction changed(): number { compute<string>(); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-zeroarg-return-context",
        "lang": "ts",
        "base": {
            "lib.ts": "function numberValue(): number { return 1; }\nfunction stringValue(): string { return \"bad\"; }\nfunction changed(): number { return numberValue(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function numberValue(): number { return 1; }\nfunction stringValue(): string { return \"bad\"; }\nfunction changed(): number { return stringValue(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-class-without-new",
        "lang": "ts",
        "base": {
            "lib.ts": "class Box {}\nfunction changed(): number { new Box(); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "class Box {}\nfunction changed(): number { Box(); return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-private-zeroarg",
        "lang": "ts",
        "base": {
            "lib.ts": "class Box { private static secret(): number { return 1; } public static allowed(): number { return 1; } }\nfunction changed(): number { return Box.allowed(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "class Box { private static secret(): number { return 1; } public static allowed(): number { return 1; } }\nfunction changed(): number { return Box.secret(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-boxed-number-valid",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: Number): number { return Number(x); }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: Number): number { return Number(x); }\nfunction changed(): number { return compute(2); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-alias-number-valid",
        "lang": "ts",
        "base": {
            "lib.ts": "type Count = number;\nfunction compute(x: Count): number { return x; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "type Count = number;\nfunction compute(x: Count): number { return x; }\nfunction changed(): number { return compute(2); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-small-int-bigint",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: number): number { return x; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: number): number { return x; }\nfunction changed(): number { return compute(1n); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-go-int8-range",
        "lang": "go",
        "base": {
            "lib.go": "package probe\nfunc compute(value int8) int { return int(value) }\nfunc changed() int { return compute(127) }\nfunc consumer() int { return changed() }\n",
            "go.mod": "module example.invalid/review\n\ngo 1.20\n"
        },
        "after": {
            "lib.go": "package probe\nfunc compute(value int8) int { return int(value) }\nfunc changed() int { return compute(128) }\nfunc consumer() int { return changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-rs-i8-range",
        "lang": "rs",
        "base": {
            "lib.rs": "fn compute(value: i8) -> i32 { value as i32 }\nfn changed() -> i32 { compute(127) }\npub fn consumer() -> i32 { changed() }\n"
        },
        "after": {
            "lib.rs": "fn compute(value: i8) -> i32 { value as i32 }\nfn changed() -> i32 { compute(128) }\npub fn consumer() -> i32 { changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-rs-unsafe-wrapper-removed",
        "lang": "rs",
        "base": {
            "lib.rs": "unsafe fn dangerous() -> i32 { 1 }\nfn changed() -> i32 {\n unsafe { dangerous() }\n}\npub fn consumer() -> i32 { changed() }\n"
        },
        "after": {
            "lib.rs": "unsafe fn dangerous() -> i32 { 1 }\nfn changed() -> i32 {\n dangerous()\n}\npub fn consumer() -> i32 { changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-rs-unsafe-call-added",
        "lang": "rs",
        "base": {
            "lib.rs": "unsafe fn dangerous() -> i32 { 1 }\nfn changed() -> i32 { 1 }\npub fn consumer() -> i32 { changed() }\n"
        },
        "after": {
            "lib.rs": "unsafe fn dangerous() -> i32 { 1 }\nfn changed() -> i32 { dangerous() }\npub fn consumer() -> i32 { changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-rs-char-vs-string",
        "lang": "rs",
        "base": {
            "lib.rs": "fn compute(value: &str) -> i32 { value.len() as i32 }\nfn changed() -> i32 { compute(\"a\") }\npub fn consumer() -> i32 { changed() }\n"
        },
        "after": {
            "lib.rs": "fn compute(value: &str) -> i32 { value.len() as i32 }\nfn changed() -> i32 { compute('a') }\npub fn consumer() -> i32 { changed() }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-cpp-deleted-zeroarg",
        "lang": "cpp",
        "base": {
            "lib.cpp": "int compute() = delete;\nint allowed() { return 1; }\nint changed() { return allowed(); }\nint consumer() { return changed(); }\n\nint main() { return consumer(); }\n"
        },
        "after": {
            "lib.cpp": "int compute() = delete;\nint allowed() { return 1; }\nint changed() { return compute(); }\nint consumer() { return changed(); }\n\nint main() { return consumer(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-cpp-nonconst-reference-literal",
        "lang": "cpp",
        "base": {
            "lib.cpp": "void compute(int& value) {}\nint changed() { int value = 1; compute(value); return 1; }\nint consumer() { return changed(); }\n\nint main() { return consumer(); }\n"
        },
        "after": {
            "lib.cpp": "void compute(int& value) {}\nint changed() { int value = 1; compute(1); return 1; }\nint consumer() { return changed(); }\n\nint main() { return consumer(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-java-no-constant-narrowing",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n static int compute(byte x) { return x; }\n static int changed() { return compute((byte)1); }\n static int consumer() { return changed(); }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n static int compute(byte x) { return x; }\n static int changed() { return compute(1); }\n static int consumer() { return changed(); }\n}\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-java-no-boxed-narrowing",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n static int compute(Byte x) { return x; }\n static int changed() { return compute((byte)1); }\n static int consumer() { return changed(); }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n static int compute(Byte x) { return x; }\n static int changed() { return compute(1); }\n static int consumer() { return changed(); }\n}\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-java-package-private-zeroarg",
        "lang": "java",
        "base": {
            "lib/Api.java": "package lib; public class Api { public static int allowed() { return 1; } static int secret() { return 1; } }\n",
            "app/Demo.java": "package app; import lib.Api; class Demo { static int changed() { return Api.allowed(); } static int consumer() { return changed(); } }\n"
        },
        "after": {
            "app/Demo.java": "package app; import lib.Api; class Demo { static int changed() { return Api.secret(); } static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-java-instance-method-on-type",
        "lang": "java",
        "base": {
            "Demo.java": "class Box { int compute(int value) { return value; } }\nclass Demo { static int changed() { return new Box().compute(1); } static int consumer() { return changed(); } }\n"
        },
        "after": {
            "Demo.java": "class Box { int compute(int value) { return value; } }\nclass Demo { static int changed() { return Box.compute(1); } static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-cs-byte-range",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo { static int compute(byte x) { return x; } static int changed() { return compute(127); } public static int consumer() { return changed(); } }\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "public class Demo { static int compute(byte x) { return x; } static int changed() { return compute(300); } public static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-cs-zeroarg-generic-constraint",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo { static int compute<T>() where T : struct { return 1; } static int changed() { return compute<int>(); } public static int consumer() { return changed(); } }\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "public class Demo { static int compute<T>() where T : struct { return 1; } static int changed() { return compute<string>(); } public static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-cs-private-same-spelling-owner",
        "lang": "cs",
        "base": {
            "Demo.cs": "namespace Left { public class Box { private static int Secret() { return 1; } public static int Allowed() { return 1; } } }\nnamespace Right { public class Box { public static int changed() { return Left.Box.Allowed(); } public static int consumer() { return changed(); } } }\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "namespace Left { public class Box { private static int Secret() { return 1; } public static int Allowed() { return 1; } } }\nnamespace Right { public class Box { public static int changed() { return Left.Box.Secret(); } public static int consumer() { return changed(); } } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-cs-ref-modifier-removed",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo { static void compute(ref int value) {} static int changed() { int value = 1; compute(ref value); return 1; } public static int consumer() { return changed(); } }\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "public class Demo { static void compute(ref int value) {} static int changed() { int value = 1; compute(1); return 1; } public static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-py-bytes-vs-string",
        "lang": "py",
        "base": {
            "lib.py": "def compute(value: str) -> int:\n    return len(value)\n\ndef changed() -> int:\n    return compute(\"ok\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute(value: str) -> int:\n    return len(value)\n\ndef changed() -> int:\n    return compute(b\"bad\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-py-shadowed-str",
        "lang": "py",
        "base": {
            "lib.py": "class str:\n    pass\n\ndef compute(value: str) -> int:\n    return 1\n\ndef changed() -> int:\n    return compute(str())\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "class str:\n    pass\n\ndef compute(value: str) -> int:\n    return 1\n\ndef changed() -> int:\n    return compute(\"bad\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-py-external-star-shadows-str",
        "lang": "py",
        "base": {
            "lib.py": "from shadow import *\n\ndef compute(value: str) -> int:\n    return 1\n\ndef changed() -> int:\n    return compute(str())\n\ndef consumer() -> int:\n    return changed()\n",
            "vendor/shadow.py": "class str:\n    pass\n",
            "pyrightconfig.json": "{\"extraPaths\":[\"vendor\"]}",
            ".ucn.json": "{\"outsideProject\":[\"vendor/**\"]}"
        },
        "after": {
            "lib.py": "from shadow import *\n\ndef compute(value: str) -> int:\n    return 1\n\ndef changed() -> int:\n    return compute(\"bad\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-py-unbound-method-on-class",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box().compute(1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box.compute(1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-js-class-without-new",
        "lang": "js",
        "base": {
            "lib.js": "class Box {}\nfunction changed() { new Box(); return 1; }\nfunction consumer() { return changed(); }\nconsumer();\n"
        },
        "after": {
            "lib.js": "class Box {}\nfunction changed() { Box(); return 1; }\nfunction consumer() { return changed(); }\nconsumer();\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(inferred-return-contract,outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-js-suppression-removed",
        "lang": "js",
        "base": {
            "lib.js": "// @ts-check\n/** @param {number} value */\nfunction compute(value) { return value; }\nfunction changed() {\n // @ts-ignore\n compute();\n return 0;\n}\nfunction consumer() { return changed(); }\n"
        },
        "after": {
            "lib.js": "// @ts-check\n/** @param {number} value */\nfunction compute(value) { return value; }\nfunction changed() {\n compute();\n return 0;\n}\nfunction consumer() { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-ts-file-pragma-removed",
        "lang": "ts",
        "base": {
            "lib.ts": "// @ts-nocheck\nfunction compute(value: number): number { return value; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review2-family-overload-result-change",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: 1): number;\nfunction compute(x: number): string;\nfunction compute(x: number): number | string { return x === 1 ? 1 : \"other\"; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: 1): number;\nfunction compute(x: number): string;\nfunction compute(x: number): number | string { return x === 1 ? 1 : \"other\"; }\nfunction changed(): number { return compute(2); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-family-return-expression-context",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: number): number { return x; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: number): number { return x; }\nfunction changed(): number { return \"\" + compute(2); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-family-new-zeroarg-clean",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(): number { return 1; }\nfunction changed(): number { return 1; }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(): number { return 1; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-family-pragma-order",
        "lang": "ts",
        "base": {
            "lib.ts": "// @ts-check\n// @ts-nocheck\nfunction compute(x: number): number { return x; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "// @ts-nocheck\n// @ts-check\nfunction compute(x: number): number { return x; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review2-family-pragma-moved",
        "lang": "ts",
        "base": {
            "lib.ts": "// @ts-nocheck\nfunction marker(): void {}\nfunction compute(x: number): number { return x; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function marker(): void {}\n// @ts-nocheck\nfunction compute(x: number): number { return x; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review2-family-external-star-literal",
        "lang": "py",
        "base": {
            "lib.py": "from shadow import *\n\ndef compute(value: str) -> int:\n    return 1\n\ndef changed() -> int:\n    return compute(\"ok\")\n\ndef consumer() -> int:\n    return changed()\n",
            "vendor/shadow.py": "from typing import Literal\nstr = Literal[\"ok\"]\n",
            "pyrightconfig.json": "{\"extraPaths\":[\"vendor\"]}",
            ".ucn.json": "{\"outsideProject\":[\"vendor/**\"]}"
        },
        "after": {
            "lib.py": "from shadow import *\n\ndef compute(value: str) -> int:\n    return 1\n\ndef changed() -> int:\n    return compute(\"bad\")\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review2-family-outside-line-directive",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: number): number { return x; }\n// @ts-ignore\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: number): number { return x; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review2-family-line-directive-block-barrier",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(x: number): number { return x; }\nfunction changed(): number {\n // @ts-ignore\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(x: number): number { return x; }\nfunction changed(): number {\n // @ts-ignore\n /* This interrupts the directive. */\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=ready (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-cpp-overload-deleted-target",
        "lang": "cpp",
        "base": {
            "lib.cpp": "int compute(bool value) { return 1; }\nint compute(int value) = delete;\nint changed() { return compute(true); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "after": {
            "lib.cpp": "int compute(bool value) { return 1; }\nint compute(int value) = delete;\nint changed() { return compute(1); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-cpp-overload-private-target",
        "lang": "cpp",
        "base": {
            "lib.cpp": "class Box { static int compute(int value) { return value; } public: static int compute(bool value) { return 1; } };\nint changed() { return Box::compute(true); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "after": {
            "lib.cpp": "class Box { static int compute(int value) { return value; } public: static int compute(bool value) { return 1; } };\nint changed() { return Box::compute(1); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-cpp-overload-ambiguous-target",
        "lang": "cpp",
        "base": {
            "lib.cpp": "int compute(bool value) { return 1; }\nint compute(long value) { return 1; }\nint compute(unsigned value) { return 1; }\nint changed() { return compute(true); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "after": {
            "lib.cpp": "int compute(bool value) { return 1; }\nint compute(long value) { return 1; }\nint compute(unsigned value) { return 1; }\nint changed() { return compute(1); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-cpp-literal-valid-control",
        "lang": "cpp",
        "base": {
            "lib.cpp": "int compute(int value) { return value; }\nint changed() { return compute(1); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "after": {
            "lib.cpp": "int compute(int value) { return value; }\nint changed() { return compute(2); }\nint consumer() { return changed(); }\n\nint main() { return 0; }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-cs-overload-ref-target",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo { static int compute(bool value) { return 1; } static int compute(ref int value) { return value; } static int changed() { return compute(true); } public static int consumer() { return changed(); } }\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "public class Demo { static int compute(bool value) { return 1; } static int compute(ref int value) { return value; } static int changed() { return compute(1); } public static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-cs-overload-obsolete-target",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo { static int compute(bool value) { return 1; } [System.Obsolete(\"forbidden\", true)] static int compute(int value) { return value; } static int changed() { return compute(true); } public static int consumer() { return changed(); } }\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "public class Demo { static int compute(bool value) { return 1; } [System.Obsolete(\"forbidden\", true)] static int compute(int value) { return value; } static int changed() { return compute(1); } public static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-cs-literal-valid-control",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo { static int compute(int value) { return value; } static int changed() { return compute(1); } public static int consumer() { return changed(); } }\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>"
        },
        "after": {
            "Demo.cs": "public class Demo { static int compute(int value) { return value; } static int changed() { return compute(2); } public static int consumer() { return changed(); } }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-java-overload-checked-throws",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo { static int compute(boolean value) { return 1; } static int compute(int value) throws Exception { return value; } static int changed() { return compute(true); } static int consumer() { return changed(); } }\n"
        },
        "after": {
            "Demo.java": "class Demo { static int compute(boolean value) { return 1; } static int compute(int value) throws Exception { return value; } static int changed() { return compute(1); } static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-java-overload-generic-throws",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo { static int compute(boolean value) { return 1; } static <E extends Exception> int compute(int value) throws E { return value; } static int changed() { return Demo.<Exception>compute(true); } static int consumer() { return changed(); } }\n"
        },
        "after": {
            "Demo.java": "class Demo { static int compute(boolean value) { return 1; } static <E extends Exception> int compute(int value) throws E { return value; } static int changed() { return Demo.<Exception>compute(1); } static int consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-java-literal-valid-control",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo { static int compute(int value) { return value; } static int changed() { return compute(1); } static int consumer() { return changed(); } }\n"
        },
        "after": {
            "Demo.java": "class Demo { static int compute(int value) { return value; } static int changed() { return compute(2); } static int consumer() { return changed(); } }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-ts-leading-line-ignore-removed",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\n// @ts-ignore\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-ts-leading-line-ignore-moved",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\n// @ts-ignore\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number { return compute(); }\n// @ts-ignore\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-ts-block-comment-breaks-suppression",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n // @ts-ignore\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n // @ts-ignore\n /* explanation */\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=ready (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-ts-line-comment-preserves-suppression",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n // @ts-ignore\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n // @ts-ignore\n // explanation\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-ts-blank-preserves-suppression",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n // @ts-ignore\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number {\n // @ts-ignore\n\n return compute();\n}\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-ts-order-comments-valid-control",
        "lang": "ts",
        "base": {
            "lib.ts": "// @ts-nocheck\n// @ts-check\nfunction compute(value: number): number { return value; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "// @ts-nocheck\n// @ts-check: reason\nfunction compute(value: number): number { return value; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-ts-file-directive-order-change",
        "lang": "ts",
        "base": {
            "lib.ts": "// @ts-check\n// @ts-nocheck\nfunction compute(value: number): number { return value; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "// @ts-nocheck\n// @ts-check\nfunction compute(value: number): number { return value; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-ts-file-directive-after-code",
        "lang": "ts",
        "base": {
            "lib.ts": "// @ts-nocheck\nfunction compute(value: number): number { return value; }\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\n// @ts-nocheck\nfunction changed(): number { return compute(); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-ts-literal-valid-control",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number { return compute(2); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-ts-literal-plus-comment-valid-control",
        "lang": "ts",
        "base": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number { return compute(1); }\nfunction consumer(): number { return changed(); }\n"
        },
        "after": {
            "lib.ts": "function compute(value: number): number { return value; }\nfunction changed(): number { /* explanation */ return compute(2); }\nfunction consumer(): number { return changed(); }\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-js-leading-line-ignore-removed",
        "lang": "js",
        "base": {
            "lib.js": "// @ts-check\n/** @param {number} value */\nfunction compute(value) { return value; }\n// @ts-ignore\nfunction changed() { return compute(); }\nfunction consumer() { return changed(); }\n"
        },
        "after": {
            "lib.js": "// @ts-check\n/** @param {number} value */\nfunction compute(value) { return value; }\nfunction changed() { return compute(); }\nfunction consumer() { return changed(); }\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-js-staged-literal-control",
        "lang": "js",
        "base": {
            "lib.js": "function compute(value) { return value; }\nfunction changed() { compute(1); return 1; }\nfunction consumer() { return changed(); }\nconsumer();\n"
        },
        "after": {
            "lib.js": "function compute(value) { return value; }\nfunction changed() { compute(2); return 1; }\nfunction consumer() { return changed(); }\nconsumer();\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-review3-py-one-line-ignore-removed",
        "lang": "py",
        "base": {
            "lib.py": "def compute(value: int) -> int:\n    return value\n\ndef changed() -> int: return compute() # type: ignore\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "def compute(value: int) -> int:\n    return value\n\ndef changed() -> int: return compute()\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=ready (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-review3-java-external-inherited-overload-target",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo extends java.util.ArrayList<String> { boolean add(int value) throws Exception { return true; } boolean changed() { return add(\"ok\"); } boolean consumer() { return changed(); } }\n"
        },
        "after": {
            "Demo.java": "class Demo extends java.util.ArrayList<String> { boolean add(int value) throws Exception { return true; } boolean changed() { return add(1); } boolean consumer() { return changed(); } }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-review3-cpp-external-inherited-deleted-target",
        "lang": "cpp",
        "base": {
            "lib.cpp": "#include \"vendor/base.hpp\"\nstruct Demo : Base { using Base::at; int at(bool) = delete; int changed() { return at(0UL); } int consumer() { return changed(); } };\n\nint main() { return 0; }\n",
            "vendor/base.hpp": "struct Base { int at(unsigned long value) { return 1; } };\n",
            ".ucn.json": "{\"outsideProject\":[\"vendor/**\"]}"
        },
        "after": {
            "lib.cpp": "#include \"vendor/base.hpp\"\nstruct Demo : Base { using Base::at; int at(bool) = delete; int changed() { return at(true); } int consumer() { return changed(); } };\n\nint main() { return 0; }\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-inert-go-discard-assignments",
        "lang": "go",
        "base": {
            "lib.go": "package fixture\nfunc pair() (int, int) { return 1, 2 }\nfunc consume(value int) int { return value }\nfunc changed() int {\n _, value := pair()\n return consume(value)\n}\n",
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n"
        },
        "after": {
            "lib.go": "package fixture\nfunc pair() (int, int) { return 1, 2 }\nfunc consume(value int) int { return value }\nfunc changed() int {\n _ = 0\n // An independent discarded value.\n _ = 2\n _, value := pair()\n return consume(value)\n}\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert-go-named-argument-binding",
        "lang": "go",
        "base": {
            "lib.go": "package fixture\nfunc consume(value int) int { return value }\nfunc changed() int {\n _value := 1\n return consume(_value)\n}\n",
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n"
        },
        "after": {
            "lib.go": "package fixture\nfunc consume(value int) int { return value }\nfunc changed() int {\n _value := \"wrong\"\n return consume(_value)\n}\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-inert-go-new-discarded-call-is-still-checked",
        "lang": "go",
        "base": {
            "lib.go": "package fixture\nfunc consume(value int) int { return value }\nfunc changed() int {\n return 1\n}\n",
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n"
        },
        "after": {
            "lib.go": "package fixture\nfunc consume(value int) int { return value }\nfunc changed() int {\n _ = consume()\n return 1\n}\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "changed:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "outgoing-inert-py-underscore-is-a-real-argument-binding",
        "lang": "py",
        "base": {
            "lib.py": "def consume(value: int) -> int:\n    return value\n\ndef changed() -> int:\n    _ = 1\n    return consume(_)\n"
        },
        "after": {
            "lib.py": "def consume(value: int) -> int:\n    return value\n\ndef changed() -> int:\n    _ = \"wrong\"\n    return consume(_)\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-inert-js-underscore-is-a-real-argument-binding",
        "lang": "js",
        "base": {
            "lib.js": "// @ts-check\n/** @param {number} value */\nfunction consume(value) { return value; }\nfunction changed() {\n const _ = 1;\n return consume(_);\n}\n"
        },
        "after": {
            "lib.js": "// @ts-check\n/** @param {number} value */\nfunction consume(value) { return value; }\nfunction changed() {\n const _ = \"wrong\";\n return consume(_);\n}\n"
        },
        "name": "changed",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "outgoing-inert-py-unrelated-body-before-a-later-inline-directive",
        "lang": "py",
        "base": {
            "lib.py": "def changed() -> int:\n    \"\"\"Documentation.\"\"\"\n    return 1\n\ndef consume(value: int) -> int:\n    return value\n\ndef later() -> int:\n    return consume(\"wrong\")  # pyright: ignore\n"
        },
        "after": {
            "lib.py": "def changed() -> int:\n    pass\n    \"\"\"Documentation.\"\"\"\n    return 1\n\ndef consume(value: int) -> int:\n    return value\n\ndef later() -> int:\n    return consume(\"wrong\")  # pyright: ignore\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert-ts-unrelated-body-before-a-later-line-directive",
        "lang": "ts",
        "base": {
            "lib.ts": "function changed(): number {\n return 1;\n}\nfunction consume(value: number): number { return value; }\nfunction later(): number {\n // @ts-ignore\n return consume(\"wrong\");\n}\n"
        },
        "after": {
            "lib.ts": "function changed(): number {\n ;\n return 1;\n}\nfunction consume(value: number): number { return value; }\nfunction later(): number {\n // @ts-ignore\n return consume(\"wrong\");\n}\n"
        },
        "name": "changed",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert-py-moved-trailing-type-ignore-is-local",
        "lang": "py",
        "base": {
            "lib.py": "bad: int = \"wrong\"  # type: ignore\ngood: int = 1\n"
        },
        "after": {
            "lib.py": "bad: int = \"wrong\"\ngood: int = 1  # type: ignore\n"
        },
        "name": "(module)",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-ts-same-scope-earlier-inert",
        "lang": "ts",
        "base": {
            "lib.ts": "function consume(value: number): void {}\nfunction changed(): void {\n // @ts-ignore\n consume(\"bad\");\n}\n"
        },
        "after": {
            "lib.ts": "function consume(value: number): void {}\nfunction changed(): void {\n void 0;\n // @ts-ignore\n consume(\"bad\");\n}\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert2-py-nested-comment-type-ignore-removal",
        "lang": "py",
        "base": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"  # explanation # type: ignore\n"
        },
        "after": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-py-nested-comment-pyright-ignore-removal",
        "lang": "py",
        "base": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"  # explanation # pyright: ignore\n"
        },
        "after": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-py-file-setting-moved-inline",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportAssignmentType=false\nsentinel = 1\nbad: int = \"bad\"\n"
        },
        "after": {
            "lib.py": "sentinel = 1  # pyright: reportAssignmentType=false\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-ts-block-before-directive",
        "lang": "ts",
        "base": {
            "lib.ts": "function consume(value: number): void {}\nfunction changed(): void {\n // @ts-ignore\n consume(\"bad\");\n}\n"
        },
        "after": {
            "lib.ts": "function consume(value: number): void {}\nfunction changed(): void {\n /* independent */\n // @ts-ignore\n consume(\"bad\");\n}\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert2-ts-block-after-target",
        "lang": "ts",
        "base": {
            "lib.ts": "function consume(value: number): void {}\nfunction changed(): void {\n // @ts-ignore\n consume(\"bad\");\n}\n"
        },
        "after": {
            "lib.ts": "function consume(value: number): void {}\nfunction changed(): void {\n // @ts-ignore\n consume(\"bad\");\n /* independent */\n}\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert2-ts-block-other-scope",
        "lang": "ts",
        "base": {
            "lib.ts": "function consume(value: number): void {}\nfunction changed(): void {\n // @ts-ignore\n consume(\"bad\");\n}\n"
        },
        "after": {
            "lib.ts": "function consume(value: number): void { /* independent */ }\nfunction changed(): void {\n // @ts-ignore\n consume(\"bad\");\n}\n"
        },
        "expect": "clean",
        "name": "consume",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "consume:modified=ready"
    },
    {
        "id": "outgoing-inert2-py-type-annotation-assignment",
        "lang": "py",
        "base": {
            "lib.py": "value = \"bad\"  # type: str\n"
        },
        "after": {
            "lib.py": "value = \"bad\"  # type: int\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-py-type-annotation-function",
        "lang": "py",
        "base": {
            "lib.py": "def changed(value):\n    # type: (str) -> str\n    return value\n\nchanged(\"good\")\n"
        },
        "after": {
            "lib.py": "def changed(value):\n    # type: (int) -> str\n    return value\n\nchanged(\"good\")\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=ready (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-py-embedded-type-bracketed",
        "lang": "py",
        "base": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"  # explanation # type: ignore[reportAssignmentType]\n"
        },
        "after": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-py-embedded-pyright-bracketed",
        "lang": "py",
        "base": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"  # explanation # pyright: ignore[reportAssignmentType]\n"
        },
        "after": {
            "lib.py": "sentinel = 1\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert2-py-directive-words-in-prose",
        "lang": "py",
        "base": {
            "lib.py": "def changed() -> None:\n    pass  # explanation type: ignore and pyright: ignore\n"
        },
        "after": {
            "lib.py": "def changed() -> None:\n    pass\n    pass\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert3-py-file-setting-spaces",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "after": {
            "lib.py": "    # pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert3-py-file-setting-tab",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "after": {
            "lib.py": "\t# pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert3-py-file-setting-bom",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "after": {
            "lib.py": "\ufeff# pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert3-py-file-setting-function-indent",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "after": {
            "lib.py": "def changed() -> None:\n    # pyright: reportAssignmentType=false\n    pass\nbad: int = \"bad\"\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=ready (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert3-py-file-setting-column-zero-inside",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportAssignmentType=false\ndef changed() -> None:\n    pass\nbad: int = \"bad\"\n"
        },
        "after": {
            "lib.py": "def changed() -> None:\n# pyright: reportAssignmentType=false\n    pass\nbad: int = \"bad\"\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "changed:modified=ready"
    },
    {
        "id": "outgoing-inert3-py-inline-setting-still-suppresses-call",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportCallIssue=false\nsentinel = 0\ndef compute(value: int) -> int:\n    return value\ndef changed() -> int:\n    return compute()\n"
        },
        "after": {
            "lib.py": "sentinel = 0  # pyright: reportCallIssue=false\ndef compute(value: int) -> int:\n    return value\ndef changed() -> int:\n    return compute(1, 2)\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(site-not-checked) (module):module=review(checking-context-changed)"
    },
    {
        "id": "outgoing-inert3-py-ordinary-prefix-does-not-set-rule",
        "lang": "py",
        "base": {
            "lib.py": "# pyright: reportCallIssue=false\nsentinel = 0\ndef compute(value: int) -> int:\n    return value\ndef changed() -> int:\n    return compute()\n"
        },
        "after": {
            "lib.py": "# explanation # pyright: reportCallIssue=false\nsentinel = 0\ndef compute(value: int) -> int:\n    return value\ndef changed() -> int:\n    return compute()\n"
        },
        "expect": "break",
        "name": "(module)",
        "answer": "REVIEW_REQUIRED",
        "detail": "(module):module=review(checking-context-changed)"
    }
];
