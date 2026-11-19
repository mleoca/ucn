/**
 * A function that is not a member, whose first parameter is named like a
 * receiver, one edit each (fix #509).
 *
 * `def helper(self, x)` at module level is called `helper(a, b)`: where the
 * receiver is a parameter named by convention, only a member of a type is
 * called with it implicitly. Each header change of such a function beside
 * the same change to a method, so the receiver a method's call passes is
 * still left out of its count, and to such a function applied as a class
 * decorator or held as a class attribute. A method called through its
 * class's name is the unbound function, so that call writes the receiver
 * as its first argument (fix #513).
 * `expect` is the toolchain's verdict (eval/run-check-matrix.js);
 * `answer` and `detail` are the check's.
 */
'use strict';

module.exports = [
    {
        "id": "selfparam-py-nonmember-self-parameter-renamed",
        "lang": "py",
        "base": {
            "lib.py": "def helper(self, x):\n    return x\n",
            "use.py": "from lib import helper\n\n\ndef run() -> int:\n    return helper(1, 2)\n"
        },
        "after": {
            "lib.py": "def helper(self, value):\n    return value\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "helper:modified=review(header,inferred-return-contract)"
    },
    {
        "id": "selfparam-py-nonmember-self-parameter-added",
        "lang": "py",
        "base": {
            "lib.py": "def helper(self, x):\n    return x\n",
            "use.py": "from lib import helper\n\n\ndef run() -> int:\n    return helper(1, 2)\n"
        },
        "after": {
            "lib.py": "def helper(self, x, y):\n    return x + y\n"
        },
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "helper:modified=blocked(signature-mismatch,header,inferred-return-contract)"
    },
    {
        "id": "selfparam-py-nonmember-cls-parameter-optional-added",
        "lang": "py",
        "base": {
            "lib.py": "def helper(cls, x):\n    return x\n",
            "use.py": "from lib import helper\n\n\ndef run() -> int:\n    return helper(1, 2)\n"
        },
        "after": {
            "lib.py": "def helper(cls, x, y=0):\n    return x + y\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "helper:modified=review(header,inferred-return-contract)"
    },
    {
        "id": "selfparam-py-nonmember-self-parameter-removed",
        "lang": "py",
        "base": {
            "lib.py": "def helper(self, x):\n    return x\n",
            "use.py": "from lib import helper\n\n\ndef run() -> int:\n    return helper(1, 2)\n"
        },
        "after": {
            "lib.py": "def helper(x):\n    return x\n"
        },
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "helper:modified=blocked(signature-mismatch,header)"
    },
    {
        "id": "selfparam-py-method-self-parameter-added",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def helper(self, x):\n        return x\n",
            "use.py": "from lib import Box\n\n\ndef run() -> int:\n    return Box().helper(1)\n"
        },
        "after": {
            "lib.py": "class Box:\n    def helper(self, x, y):\n        return x + y\n"
        },
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "helper:modified=blocked(signature-mismatch,header,inferred-return-contract)"
    },
    {
        "id": "selfparam-py-method-self-parameter-renamed",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def helper(self, x):\n        return x\n",
            "use.py": "from lib import Box\n\n\ndef run() -> int:\n    return Box().helper(1)\n"
        },
        "after": {
            "lib.py": "class Box:\n    def helper(self, value):\n        return value\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "helper:modified=review(header,inferred-return-contract)"
    },
    {
        "id": "selfparam-py-decorator-parameter-added",
        "lang": "py",
        "base": {
            "lib.py": "REGISTRY = []\n\n\ndef register(cls):\n    REGISTRY.append(cls)\n    return cls\n",
            "use.py": "from lib import register\n\n\n@register\nclass Box:\n    pass\n"
        },
        "after": {
            "lib.py": "REGISTRY = []\n\n\ndef register(cls, tag=None):\n    REGISTRY.append(cls)\n    return cls\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "register:modified=review(header)"
    },
    {
        "id": "selfparam-py-decorator-required-added",
        "lang": "py",
        "base": {
            "lib.py": "REGISTRY = []\n\n\ndef register(cls):\n    REGISTRY.append(cls)\n    return cls\n",
            "use.py": "from lib import register\n\n\n@register\nclass Box:\n    pass\n"
        },
        "after": {
            "lib.py": "REGISTRY = []\n\n\ndef register(cls, tag):\n    REGISTRY.append(cls)\n    return cls\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "register:modified=review(header)"
    },
    {
        "id": "selfparam-py-attached-function-optional-added",
        "lang": "py",
        "base": {
            "lib.py": "def helper(self, x):\n    return x\n\n\nclass Box:\n    helper = helper\n",
            "use.py": "from lib import Box\n\n\ndef run() -> int:\n    return Box().helper(1)\n"
        },
        "after": {
            "lib.py": "def helper(self, x, y=0):\n    return x + y\n\n\nclass Box:\n    helper = helper\n"
        },
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "helper:modified=review(header,inferred-return-contract)"
    },
    {
        "id": "selfparam-py-attached-function-required-added",
        "lang": "py",
        "base": {
            "lib.py": "def helper(self, x):\n    return x\n\n\nclass Box:\n    helper = helper\n",
            "use.py": "from lib import Box\n\n\ndef run() -> int:\n    return Box().helper(1)\n"
        },
        "after": {
            "lib.py": "def helper(self, x, y):\n    return x + y\n\n\nclass Box:\n    helper = helper\n"
        },
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "helper:modified=review(header,inferred-return-contract)"
    },
    {
        "id": "selfparam-py-unbound-call-writes-receiver",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box().compute(1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box.compute(Box(), 1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "selfparam-py-unbound-call-writes-receiver-and-keyword",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box().compute(1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box.compute(Box(), value=1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "clean",
        "name": "changed",
        "answer": "REVIEW_REQUIRED",
        "detail": "changed:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "selfparam-py-unbound-call-without-arguments",
        "lang": "py",
        "base": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box().compute(1)\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "after": {
            "lib.py": "class Box:\n    def compute(self, value: int) -> int:\n        return value\n\ndef changed() -> int:\n    return Box.compute()\n\ndef consumer() -> int:\n    return changed()\n"
        },
        "expect": "break",
        "name": "changed",
        "answer": "BLOCKED",
        "detail": "changed:modified=blocked(outgoing-signature-mismatch)"
    }
];
