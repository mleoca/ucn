/**
 * Where the paths of a body end, one edit each (fix #506b).
 *
 * A statement that ends a path was removed or replaced under a written
 * result type (a `return`, a `raise` or `throw`, a call of a function
 * declared never to return, an assertion), or one was added where it opens
 * a path (a `break` in an endless loop, an end before statements where the
 * toolchain rejects unreachable code): the toolchain's diagnostic is on a
 * line the change did not write. Beside each, the edits that leave every
 * path where it was. C++ accepts each of these with a warning, so it has
 * clean cases only. `expect` is the toolchain's verdict
 * (eval/run-check-matrix.js); `answer` and `detail` are the check's.
 */
'use strict';

module.exports = [
    {
        "id": "pathend-py-never-call-swapped-at-end",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    warn()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-never-call-removed-at-end",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    pass\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-never-call-swapped-under-condition",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        warn()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "read",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "read:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-never-call-removed-under-condition",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        pass\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "read",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "read:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-raise-replaced",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    print(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "pick_raise",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick_raise:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-return-replaced",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    key = \"c\"\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "branch",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "branch:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-outside-exit-call-removed",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    pass\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "pick_exit",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick_exit:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-assert-removed",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    pass\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "read_assert",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "read_assert:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-unit-result-narrowed-read",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        warn()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "show",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "show:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-unannotated-narrowed-read",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        warn()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "show_untyped",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "show_untyped:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-break-added-in-endless-loop",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n        break\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "spin",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "spin:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-endless-loop-gets-condition",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while key:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "spin",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "spin:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-manager-replaced-around-return",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with suppress(ValueError):\n        return len(key)\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "held",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "held:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-py-returning-call-removed",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    return 1\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-py-returning-call-replaced",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    print(\"x\")\n    return 1\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-py-arguments-of-bare-call-changed",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key, key)\n    sys.exit(2)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "tail",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "tail:modified=ready"
    },
    {
        "id": "pathend-py-call-added",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    print(\"x\")\n    return 1\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-py-outside-call-added",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    sys.stdout.flush()\n    return 1\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-py-never-call-to-raise",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "pathend-py-raise-to-never-call",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "pick_raise",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick_raise:modified=ready"
    },
    {
        "id": "pathend-py-last-exit-removed-unit-result",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "tail",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "tail:modified=ready"
    },
    {
        "id": "pathend-py-guard-return-added",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    if key == \"z\":\n        return 0\n    warn()\n    return 1\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-py-manager-arguments-changed",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key, \"r\") as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "held",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "held:modified=ready"
    },
    {
        "id": "pathend-py-outside-member-call-removed",
        "lang": "py",
        "base": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    seen.append(key)\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "after": {
            "lib.py": "import sys\nfrom contextlib import suppress\nfrom typing import NoReturn\n\n\ndef fail() -> NoReturn:\n    raise ValueError(\"no\")\n\n\ndef warn() -> None:\n    print(\"warn\")\n\n\ndef pick(key: str) -> int:\n    if key == \"a\":\n        return 1\n    fail()\n\n\ndef pick_raise(key: str) -> int:\n    if key == \"a\":\n        return 1\n    raise ValueError(key)\n\n\ndef pick_exit(key: str) -> int:\n    if key == \"a\":\n        return 1\n    sys.exit(1)\n\n\ndef branch(key: str) -> int:\n    if key == \"a\":\n        return 1\n    return 2\n\n\ndef read(value: int | None) -> int:\n    if value is None:\n        fail()\n    return value\n\n\ndef read_assert(value: int | None) -> int:\n    assert value is not None\n    return value\n\n\ndef show(value: int | None) -> None:\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef show_untyped(value: int | None):\n    if value is None:\n        fail()\n    print(value + 1)\n\n\ndef spin(key: str) -> int:\n    while True:\n        if key == \"a\":\n            return 1\n\n\ndef held(key: str) -> int:\n    with open(key) as handle:\n        return len(handle.read())\n\n\ndef gather(key: str) -> int:\n    seen: list[str] = []\n    return len(seen)\n\n\ndef tail(key: str) -> None:\n    print(key)\n    sys.exit(1)\n\n\ndef plain(key: str) -> int:\n    warn()\n    return 1\n"
        },
        "name": "gather",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "gather:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-never-call-swapped-at-end",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    warn();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-never-call-removed-at-end",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-never-call-swapped-under-condition",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        warn();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "read",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "read:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-never-call-removed-under-condition",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "read",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "read:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-throw-replaced",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    console.log(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "pickThrow",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pickThrow:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-return-replaced",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    key = 'c';\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "branch",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "branch:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-declared-only-never-call-removed",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "pickQuit",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pickQuit:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-unit-result-narrowed-read",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        warn();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "show",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "show:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-definite-assignment-branch-end-removed",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        warn();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "assign",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "assign:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-break-added-in-endless-loop",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n        break;\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "spin",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "spin:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-ts-returning-call-removed",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    return 1;\n}\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-ts-returning-call-replaced",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    console.log('x');\n    return 1;\n}\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-ts-call-added",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    console.log('x');\n    return 1;\n}\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-ts-never-call-to-throw",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "pathend-ts-throw-to-never-call",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "pickThrow",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pickThrow:modified=ready"
    },
    {
        "id": "pathend-ts-last-exit-removed-unit-result",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "tail",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "tail:modified=ready"
    },
    {
        "id": "pathend-ts-outside-member-call-removed",
        "lang": "ts",
        "base": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    seen.push(key);\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "after": {
            "lib.ts": "declare function quit(code: number): never;\nexport function fail(): never {\n    throw new Error('no');\n}\nexport function warn(): void {\n    console.log('warn');\n}\nexport function pick(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    fail();\n}\nexport function pickThrow(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    throw new Error(key);\n}\nexport function pickQuit(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    quit(1);\n}\nexport function branch(key: string): number {\n    if (key === 'a') {\n        return 1;\n    }\n    return 2;\n}\nexport function read(value: number | null): number {\n    if (value === null) {\n        fail();\n    }\n    return value;\n}\nexport function show(value: number | null): void {\n    if (value === null) {\n        fail();\n    }\n    console.log(value + 1);\n}\nexport function assign(ok: boolean): number {\n    let v: number;\n    if (ok) {\n        v = 1;\n    } else {\n        fail();\n    }\n    return v;\n}\nexport function spin(key: string): number {\n    while (true) {\n        if (key === 'a') {\n            return 1;\n        }\n    }\n}\nexport function gather(key: string): number {\n    const seen: string[] = [];\n    return seen.length;\n}\nexport function tail(key: string): void {\n    console.log(key);\n    quit(1);\n}\nexport function plain(key: string): number {\n    warn();\n    return 1;\n}\n"
        },
        "name": "gather",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "gather:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-rs-never-call-removed-at-end",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "after": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-rs-diverging-macro-replaced",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "after": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    println!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "name": "pick_macro",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick_macro:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-rs-return-removed",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "after": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "name": "branch",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "branch:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-rs-definite-assignment-branch-end-removed",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "after": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "name": "assign",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "assign:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-rs-returning-call-removed",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "after": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    1\n}\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-rs-last-never-call-removed-unit-result",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "after": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "name": "tail",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "tail:modified=ready"
    },
    {
        "id": "pathend-rs-diverging-macro-to-diverging-macro",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    panic!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "after": {
            "lib.rs": "pub fn fail() -> ! { panic!(\"no\") }\npub fn warn() { println!(\"warn\"); }\npub fn pick(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    fail();\n}\npub fn pick_macro(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    unreachable!(\"no\");\n}\npub fn branch(key: &str) -> i32 {\n    if key == \"a\" {\n        return 1;\n    }\n    return 2;\n}\npub fn assign(ok: bool) -> i32 {\n    let v: i32;\n    if ok {\n        v = 1;\n    } else {\n        fail();\n    }\n    v\n}\npub fn tail(key: &str) {\n    println!(\"{}\", key);\n    fail();\n}\npub fn plain(key: &str) -> i32 {\n    warn();\n    1\n}\n"
        },
        "name": "pick_macro",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick_macro:modified=ready"
    },
    {
        "id": "pathend-go-panic-removed-at-end",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-go-return-replaced",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tkey = \"c\"\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "name": "branch",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "branch:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-go-break-added-in-endless-loop",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t\tbreak\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "name": "spin",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "spin:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-go-panic-added-before-statements",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\tpanic(\"x\")\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "name": "plain",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "plain:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-go-exit-call-replaced",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tkey = \"x\"\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "name": "quit",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "quit:modified=ready"
    },
    {
        "id": "pathend-go-returning-call-removed",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\twarn()\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"os\"\n\nfunc warn() { println(\"warn\") }\n\nfunc pick(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tpanic(\"no\")\n}\n\nfunc branch(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\treturn 2\n}\n\nfunc spin(key string) int {\n\tfor {\n\t\tif key == \"a\" {\n\t\t\treturn 1\n\t\t}\n\t}\n}\n\nfunc quit(key string) int {\n\tif key == \"a\" {\n\t\treturn 1\n\t}\n\tos.Exit(1)\n\treturn 0\n}\n\nfunc plain(key string) int {\n\treturn 1\n}\n\nfunc env() string { return os.Getenv(\"X\") }\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-java-throw-replaced",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        key = \"b\";\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-java-return-replaced",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        key = \"c\";\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "branch",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "branch:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-java-definite-assignment-branch-end-removed",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            ok = true;\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "assign",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "assign:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-java-break-added-in-endless-loop",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n            break;\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "spin",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "spin:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-java-throw-added-before-statements",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        throw new IllegalStateException(\"x\");\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "plain",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "plain:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-java-returning-call-removed",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        return 1;\n    }\n}\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-java-last-throw-removed-unit-result",
        "lang": "java",
        "base": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n        throw new IllegalStateException(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "class Demo {\n    static void warn() { System.out.println(\"warn\"); }\n    static int pick(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        throw new IllegalStateException(\"no\");\n    }\n    static int branch(String key) {\n        if (key.equals(\"a\")) {\n            return 1;\n        }\n        return 2;\n    }\n    static int assign(boolean ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new IllegalStateException(\"no\");\n        }\n        return v;\n    }\n    static int spin(String key) {\n        while (true) {\n            if (key.equals(\"a\")) {\n                return 1;\n            }\n        }\n    }\n    static void halt(String key) {\n        System.out.println(key);\n    }\n    static int plain(String key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "halt",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "halt:modified=ready"
    },
    {
        "id": "pathend-cs-throw-replaced",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo {\n    static void warn() { System.Console.WriteLine(\"warn\"); }\n    public static int pick(string key) {\n        if (key == \"a\") {\n            return 1;\n        }\n        throw new System.InvalidOperationException(\"no\");\n    }\n    public static int assign(bool ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new System.InvalidOperationException(\"no\");\n        }\n        return v;\n    }\n    public static int plain(string key) {\n        warn();\n        return 1;\n    }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Demo {\n    static void warn() { System.Console.WriteLine(\"warn\"); }\n    public static int pick(string key) {\n        if (key == \"a\") {\n            return 1;\n        }\n        key = \"b\";\n    }\n    public static int assign(bool ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new System.InvalidOperationException(\"no\");\n        }\n        return v;\n    }\n    public static int plain(string key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-cs-definite-assignment-branch-end-removed",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo {\n    static void warn() { System.Console.WriteLine(\"warn\"); }\n    public static int pick(string key) {\n        if (key == \"a\") {\n            return 1;\n        }\n        throw new System.InvalidOperationException(\"no\");\n    }\n    public static int assign(bool ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new System.InvalidOperationException(\"no\");\n        }\n        return v;\n    }\n    public static int plain(string key) {\n        warn();\n        return 1;\n    }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Demo {\n    static void warn() { System.Console.WriteLine(\"warn\"); }\n    public static int pick(string key) {\n        if (key == \"a\") {\n            return 1;\n        }\n        throw new System.InvalidOperationException(\"no\");\n    }\n    public static int assign(bool ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            ok = true;\n        }\n        return v;\n    }\n    public static int plain(string key) {\n        warn();\n        return 1;\n    }\n}\n"
        },
        "name": "assign",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "assign:modified=review(path-end-changed)"
    },
    {
        "id": "pathend-cs-returning-call-removed",
        "lang": "cs",
        "base": {
            "Demo.cs": "public class Demo {\n    static void warn() { System.Console.WriteLine(\"warn\"); }\n    public static int pick(string key) {\n        if (key == \"a\") {\n            return 1;\n        }\n        throw new System.InvalidOperationException(\"no\");\n    }\n    public static int assign(bool ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new System.InvalidOperationException(\"no\");\n        }\n        return v;\n    }\n    public static int plain(string key) {\n        warn();\n        return 1;\n    }\n}\n",
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n"
        },
        "after": {
            "Demo.cs": "public class Demo {\n    static void warn() { System.Console.WriteLine(\"warn\"); }\n    public static int pick(string key) {\n        if (key == \"a\") {\n            return 1;\n        }\n        throw new System.InvalidOperationException(\"no\");\n    }\n    public static int assign(bool ok) {\n        int v;\n        if (ok) {\n            v = 1;\n        } else {\n            throw new System.InvalidOperationException(\"no\");\n        }\n        return v;\n    }\n    public static int plain(string key) {\n        return 1;\n    }\n}\n"
        },
        "name": "plain",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "plain:modified=ready"
    },
    {
        "id": "pathend-cpp-throw-replaced",
        "lang": "cpp",
        "base": {
            "main.cpp": "void warn() {}\n[[noreturn]] void fail() { throw 1; }\nint pick(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    throw 1;\n}\nint pick_call(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    fail();\n}\nint branch(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    return 2;\n}\nint main() { return pick(1) + pick_call(1) + branch(1); }\n"
        },
        "after": {
            "main.cpp": "void warn() {}\n[[noreturn]] void fail() { throw 1; }\nint pick(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    key = 2;\n}\nint pick_call(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    fail();\n}\nint branch(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    return 2;\n}\nint main() { return pick(1) + pick_call(1) + branch(1); }\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick:modified=ready"
    },
    {
        "id": "pathend-cpp-noreturn-call-removed",
        "lang": "cpp",
        "base": {
            "main.cpp": "void warn() {}\n[[noreturn]] void fail() { throw 1; }\nint pick(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    throw 1;\n}\nint pick_call(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    fail();\n}\nint branch(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    return 2;\n}\nint main() { return pick(1) + pick_call(1) + branch(1); }\n"
        },
        "after": {
            "main.cpp": "void warn() {}\n[[noreturn]] void fail() { throw 1; }\nint pick(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    throw 1;\n}\nint pick_call(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    key = 2;\n}\nint branch(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    return 2;\n}\nint main() { return pick(1) + pick_call(1) + branch(1); }\n"
        },
        "name": "pick_call",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "pick_call:modified=ready"
    },
    {
        "id": "pathend-cpp-return-replaced",
        "lang": "cpp",
        "base": {
            "main.cpp": "void warn() {}\n[[noreturn]] void fail() { throw 1; }\nint pick(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    throw 1;\n}\nint pick_call(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    fail();\n}\nint branch(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    return 2;\n}\nint main() { return pick(1) + pick_call(1) + branch(1); }\n"
        },
        "after": {
            "main.cpp": "void warn() {}\n[[noreturn]] void fail() { throw 1; }\nint pick(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    throw 1;\n}\nint pick_call(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    fail();\n}\nint branch(int key) {\n    if (key == 1) {\n        return 1;\n    }\n    key = 2;\n}\nint main() { return pick(1) + pick_call(1) + branch(1); }\n"
        },
        "name": "branch",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "branch:modified=ready"
    }
];
