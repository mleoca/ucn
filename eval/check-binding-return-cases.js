/**
 * What a callable held by a typed binding returns, one edit each (fix #509).
 *
 * `const handle: Handler = (c) => {..}`: callers see the binding's type,
 * and the checker holds the callable's own result to it at the binding, a
 * line a body edit does not write. A changed result is settled when the
 * binding's one call signature returns a keyword type and every result of
 * the changed body is a value of it by its syntax alone; beside each such
 * edit, the twin that returns a value of another type, and the shapes the
 * proof leaves to review (a changed statement the result is made of, a
 * literal union, a type parameter, several signatures, an extended
 * interface, an async callable, a changed binding type, a body that
 * returns no value, a statement the results are made of that left the
 * body or the derivation).
 * `expect` is the toolchain's verdict (eval/run-check-matrix.js);
 * `answer` and `detail` are the check's.
 */
'use strict';

module.exports = [
    {
        "id": "bindret-ts-alias-string-concat",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path + \"/\";\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-alias-string-literal",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return \"b\";\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-alias-template-string",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return `${prefix}/${c.size}`;\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-interface-call-signature",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Callback } from \"./types\";\n\nexport const handle: Callback = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Callback } from \"./types\";\n\nexport const handle: Callback = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path + \"/\";\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-number-literal",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return 1;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return -2;\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-boolean-comparison",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Check } from \"./types\";\n\nexport const handle: Check = (c) => {\n    return c.size > 1;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Check } from \"./types\";\n\nexport const handle: Check = (c) => {\n    return c.path === \"a\";\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-boolean-negation",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Check } from \"./types\";\n\nexport const handle: Check = (c) => {\n    return c.size > 1;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Check } from \"./types\";\n\nexport const handle: Check = (c) => {\n    return !c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-void-any-result",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Notify } from \"./types\";\n\nexport const handle: Notify = (c) => {\n    return c.size;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Notify } from \"./types\";\n\nexport const handle: Notify = (c) => {\n    return c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-unknown-any-result",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Inspect } from \"./types\";\n\nexport const handle: Inspect = (c) => {\n    return c.size;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Inspect } from \"./types\";\n\nexport const handle: Inspect = (c) => {\n    return c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-inline-function-type",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context } from \"./types\";\n\nexport const handle: (c: Context) => string = (c) => {\n    return c.path;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context } from \"./types\";\n\nexport const handle: (c: Context) => string = (c) => {\n    return c.path + \"/\";\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-class-field",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport class Router {\n    handle: Handler = (c) => {\n        return c.path;\n    };\n}\n\nexport function run(): string {\n    return new Router().handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport class Router {\n    handle: Handler = (c) => {\n        return \"/\" + c.path;\n    };\n}\n\nexport function run(): string {\n    return new Router().handle({ path: \"x\", size: 1 });\n}\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-expression-body",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) =>\n    c.path;\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) =>\n    \"/\" + c.path;\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-alias-member-of-other-type",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return c.size;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-alias-number-literal",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return 1;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-number-gets-template",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return 1;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return `${c.size}`;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-number-gets-concat",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return 1;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return c.size + \"/\";\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-number-gets-bigint",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return 1;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Count } from \"./types\";\n\nexport const handle: Count = (c) => {\n    return 1n;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-string-gets-boolean",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return c.size > 1;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-boolean-gets-typeof",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Check } from \"./types\";\n\nexport const handle: Check = (c) => {\n    return c.size > 1;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Check } from \"./types\";\n\nexport const handle: Check = (c) => {\n    return typeof c.size;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-interface-member-of-other-type",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Callback } from \"./types\";\n\nexport const handle: Callback = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Callback } from \"./types\";\n\nexport const handle: Callback = (c) => {\n    const prefix = \"a\";\n    return c.size;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-local-retyped",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = 1;\n    return prefix;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-local-changed",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"a\";\n    return prefix + c.path;\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const prefix = \"b\";\n    return prefix + c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-end-removed",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    if (c.size > 1) {\n        return \"big\";\n    }\n    return \"small\";\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    if (c.size > 1) {\n        return \"big\";\n    }\n    console.log(c.path);\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract,path-end-changed)"
    },
    {
        "id": "bindret-ts-result-under-new-condition",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    return \"a\";\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    if (c.size > 1) {\n        return \"a\";\n    }\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract,path-end-changed)"
    },
    {
        "id": "bindret-ts-literal-union-return",
        "lang": "ts",
        "base": {
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n\nexport type Mode = (c: Context) => \"a\" | \"b\";\n",
            "lib.ts": "import { Context, Mode } from \"./types\";\n\nexport const handle: Mode = (c) => {\n    return \"a\";\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Mode } from \"./types\";\n\nexport const handle: Mode = (c) => {\n    return \"c\";\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-generic-return",
        "lang": "ts",
        "base": {
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n\nexport type Make<R> = (c: Context) => R;\n",
            "lib.ts": "import { Context, Make } from \"./types\";\n\nexport const handle: Make<string> = (c) => {\n    return c.path;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Make } from \"./types\";\n\nexport const handle: Make<string> = (c) => {\n    return \"/\" + c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-two-signatures",
        "lang": "ts",
        "base": {
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n\nexport interface Either {\n    (c: Context): string;\n    (c: Context, n: number): string;\n}\n",
            "lib.ts": "import { Context, Either } from \"./types\";\n\nexport const handle: Either = (c) => {\n    return c.path;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Either } from \"./types\";\n\nexport const handle: Either = (c) => {\n    return \"/\" + c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-extended-interface",
        "lang": "ts",
        "base": {
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n\nexport interface Named extends Callback {\n    label?: string;\n}\n",
            "lib.ts": "import { Context, Named } from \"./types\";\n\nexport const handle: Named = (c) => {\n    return c.path;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Named } from \"./types\";\n\nexport const handle: Named = (c) => {\n    return \"/\" + c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-async-arrow",
        "lang": "ts",
        "base": {
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n\nexport type Later = (c: Context) => Promise<string>;\n",
            "lib.ts": "import { Context, Later } from \"./types\";\n\nexport const handle: Later = async (c) => {\n    return c.path;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Later } from \"./types\";\n\nexport const handle: Later = async (c) => {\n    return \"/\" + c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-type-return-changed",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    return \"a\";\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => number;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "Handler:modified=review(declaration-change)"
    },
    {
        "id": "bindret-ts-type-and-result-changed",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    return \"a\";\n};\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n"
        },
        "after": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => number;\n\nexport interface Callback {\n    (c: Context): string;\n}\n\nexport type Count = (c: Context) => number;\n\nexport type Check = (c: Context) => boolean;\n\nexport type Notify = (c: Context) => void;\n\nexport type Inspect = (c: Context) => unknown;\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    return 1;\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=ready Handler:modified=review(declaration-change)"
    },
    {
        "id": "bindret-ts-expression-body-to-statement",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport type Notify = (c: Context) => void;\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) =>\n    c.path;\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    c.path;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-expression-body-to-return",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport type Notify = (c: Context) => void;\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) =>\n    c.path;\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    return \"/\" + c.path;\n};\n"
        },
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "handle:modified=ready"
    },
    {
        "id": "bindret-ts-only-return-removed",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport type Notify = (c: Context) => void;\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    return c.path;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    console.log(c.path);\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract,path-end-changed)"
    },
    {
        "id": "bindret-ts-void-return-removed",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport type Notify = (c: Context) => void;\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context, Notify } from \"./types\";\n\nexport const handle: Notify = (c) => {\n    return c.size;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Notify } from \"./types\";\n\nexport const handle: Notify = (c) => {\n    console.log(c.path);\n};\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract,path-end-changed)"
    },
    {
        "id": "bindret-ts-narrowing-deleted",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n    maybe?: string;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport function assertText(value: unknown): asserts value is string {\n    if (typeof value !== \"string\") throw new Error(\"text\");\n}\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context, Handler, assertText } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    let p = c.maybe;\n    if (!p) {\n        p = \"\";\n    }\n    return \"n\" + p.length;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler, assertText } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    let p = c.maybe;\n    return \"n\" + p.length;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract)"
    },
    {
        "id": "bindret-ts-assertion-call-deleted",
        "lang": "ts",
        "base": {
            "types.ts": "export interface Context {\n    path: string;\n    size: number;\n    maybe?: string;\n}\n\nexport type Handler = (c: Context) => string;\n\nexport function assertText(value: unknown): asserts value is string {\n    if (typeof value !== \"string\") throw new Error(\"text\");\n}\n",
            "use.ts": "import { handle } from \"./lib\";\n\nexport function run(): unknown {\n    return handle({ path: \"x\", size: 1 });\n}\n",
            "lib.ts": "import { Context, Handler, assertText } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const p: unknown = c.maybe;\n    assertText(p);\n    return \"n\" + p.length;\n};\n"
        },
        "after": {
            "lib.ts": "import { Context, Handler, assertText } from \"./types\";\n\nexport const handle: Handler = (c) => {\n    const p: unknown = c.maybe;\n    return \"n\" + p.length;\n};\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "handle:modified=review(inferred-return-contract,path-end-changed)"
    }
];
