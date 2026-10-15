#!/usr/bin/env python3
"""eval/oracles/jedi-helper.py - persistent jedi query server for jedi-oracle.js.

Protocol: one JSON request per stdin line, one JSON response per stdout line.
On startup prints a ready banner line: {"ok": true, "ready": true, ...}.

Ops:
  {"op": "list_symbols"}
      -> {"ok": true, "symbols": [{"name", "file", "line", "kind"}]}
         file: relative to root; kind: function|method|class.
         line follows UCN's convention: the FIRST DECORATOR line for decorated
         defs (tree-sitter decorated_definition start), so the runner's
         file:line:name handles pin UCN resolution exactly.
         Dunder defs (__init__, __eq__, ...) are skipped: their call sites are
         constructor syntax / operators / protocol dispatch, which no reference
         oracle sees — and ts-morph's getMethods() likewise excludes
         constructors, so the symbol universes match across oracles.
  {"op": "find_references", "file": rel, "line": n, "name": s}
      -> {"ok": true, "refs": [{"file", "line", "kind"}]}
         kind: call|import|definition|reference. line/name are the values
         list_symbols returned (decorator-inclusive); the def-name position is
         recovered from the AST before asking jedi. File paths are relative to
         root and may climb out of it (../tests/x.py): symbols are enumerated
         under root only, but references resolve across the whole detected
         project (see below) so callers in sibling dirs (tests/) are visible —
         UCN indexes from the project root, and the eval's file universes must
         align or every out-of-target UCN edge counts as a precision miss.
  {"op": "shutdown"} -> exits.

The jedi project is rooted at the nearest ancestor of root with a Python
project marker (pyproject.toml / setup.py / setup.cfg / .git), mirroring the
ts-morph oracle's tsconfig walk; with no marker the root itself is used.

Symbol enumeration and call classification use the stdlib ast module (exact
callee positions); jedi provides only the cross-file reference resolution.
"""
import ast
import json
import os
import re
import sys

# Lazy: the ast-based ops (list_symbols / name_position / classify_ref) serve
# the pyright oracle too, which must work without jedi installed. Only
# find_references requires jedi.
try:
    import jedi
except ImportError:
    jedi = None

ROOT = os.path.abspath(sys.argv[1])

PROJECT_MARKERS = ("pyproject.toml", "setup.py", "setup.cfg", ".git")


def detect_project_root(start):
    current = start
    for _ in range(5):
        if any(os.path.exists(os.path.join(current, m)) for m in PROJECT_MARKERS):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            break
        current = parent
    return start


PROJECT_ROOT = detect_project_root(ROOT)
PROJECT = jedi.Project(PROJECT_ROOT) if jedi else None

DUNDER_RE = re.compile(r"^__\w+__$")

_file_cache = {}   # abs_path -> dict with lines / symbols / callees / import_spans
_script_cache = {}  # abs_path -> jedi.Script


def byte_to_char(line_text, byte_offset):
    """ast col offsets are utf-8 byte offsets; jedi columns are char offsets."""
    raw = line_text.encode("utf-8")
    return len(raw[:byte_offset].decode("utf-8", errors="replace"))


def analyze_file(abs_path):
    """Parse a file once: symbol table, callee positions, import spans."""
    cached = _file_cache.get(abs_path)
    if cached is not None:
        return cached
    info = {"lines": [], "symbols": [], "name_pos": {}, "callees": set(), "import_spans": []}
    _file_cache[abs_path] = info
    try:
        with open(abs_path, encoding="utf-8", errors="replace") as f:
            source = f.read()
        tree = ast.parse(source)
    except (OSError, SyntaxError, ValueError):
        return info
    lines = source.split("\n")
    info["lines"] = lines

    def name_col(node):
        """Char column of the def/class name on node.lineno. None if not found."""
        if node.lineno < 1 or node.lineno > len(lines):
            return None
        text = lines[node.lineno - 1]
        m = re.search(r"(?:def|class)\s+(%s)\b" % re.escape(node.name), text)
        if m:
            return m.start(1)
        m = re.search(r"\b%s\b" % re.escape(node.name), text)
        return m.start() if m else None

    def visit(node, class_depth):
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                start = child.decorator_list[0].lineno if child.decorator_list else child.lineno
                if isinstance(child, ast.ClassDef):
                    kind = "class"
                else:
                    kind = "method" if class_depth > 0 else "function"
                col = name_col(child)
                if col is not None and not (kind != "class" and DUNDER_RE.match(child.name)):
                    info["symbols"].append({"name": child.name, "line": start, "kind": kind})
                    info["name_pos"][(start, child.name)] = (child.lineno, col)
                visit(child, class_depth + 1 if isinstance(child, ast.ClassDef) else 0)
            else:
                visit(child, class_depth)

    visit(tree, 0)

    for node in ast.walk(tree):
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Name):
                col = byte_to_char(lines[func.lineno - 1], func.col_offset) \
                    if func.lineno <= len(lines) else func.col_offset
                info["callees"].add((func.lineno, col))
            elif isinstance(func, ast.Attribute) and func.end_lineno is not None:
                end_line = func.end_lineno
                if end_line <= len(lines):
                    end_col = byte_to_char(lines[end_line - 1], func.end_col_offset)
                    info["callees"].add((end_line, end_col - len(func.attr)))
        elif isinstance(node, (ast.Import, ast.ImportFrom)):
            info["import_spans"].append((node.lineno, node.end_lineno or node.lineno))
    return info


def list_symbols():
    symbols = []
    for dirpath, dirnames, filenames in os.walk(ROOT):
        dirnames[:] = sorted(
            d for d in dirnames
            if not d.startswith(".") and d not in ("__pycache__", "node_modules"))
        for filename in sorted(filenames):
            if not filename.endswith(".py"):
                continue
            abs_path = os.path.join(dirpath, filename)
            rel = os.path.relpath(abs_path, ROOT)
            for sym in analyze_file(abs_path)["symbols"]:
                symbols.append({"name": sym["name"], "file": rel,
                                "line": sym["line"], "kind": sym["kind"]})
    return {"ok": True, "symbols": symbols}


def classify(info, line, column, is_definition):
    """Order: import span -> exact callee position -> definition -> reference."""
    for start, end in info["import_spans"]:
        if start <= line <= end:
            return "import"
    if (line, column) in info["callees"]:
        return "call"
    if is_definition:
        return "definition"
    return "reference"


def char_to_utf16(text, char_col):
    return len(text[:char_col].encode("utf-16-le")) // 2


def utf16_to_char(text, units):
    count = 0
    for i, ch in enumerate(text):
        if count >= units:
            return i
        count += len(ch.encode("utf-16-le")) // 2
    return len(text)


def resolve_name_position(rel_file, line, name):
    """Shared (file, line, name) → (def_line, char_col) recovery."""
    abs_path = os.path.join(ROOT, rel_file)
    info = analyze_file(abs_path)
    pos = info["name_pos"].get((line, name))
    if pos is not None:
        return abs_path, info, pos, None
    if not info["lines"] or line < 1 or line > len(info["lines"]):
        return abs_path, info, None, "no definition at %s:%d" % (rel_file, line)
    m = re.search(r"\b%s\b" % re.escape(name), info["lines"][line - 1])
    if not m:
        return abs_path, info, None, "name %r not on line %s:%d" % (name, rel_file, line)
    return abs_path, info, (line, m.start()), None


def name_position(rel_file, line, name):
    """LSP-ready position of the def name (0-based line, utf-16 column)."""
    abs_path, info, pos, err = resolve_name_position(rel_file, line, name)
    if err:
        return {"ok": False, "error": err}
    text = info["lines"][pos[0] - 1] if pos[0] <= len(info["lines"]) else ""
    return {"ok": True, "line": pos[0], "utf16Col": char_to_utf16(text, pos[1])}


def classify_ref(rel_file, line, utf16_col, name):
    """Classify an LSP reference location with the same ast machinery jedi
    references use, so the two oracles' kind taxonomies match exactly."""
    abs_path = os.path.join(ROOT, rel_file)
    info = analyze_file(abs_path)
    text = info["lines"][line - 1] if (info["lines"] and 1 <= line <= len(info["lines"])) else ""
    char_col = utf16_to_char(text, utf16_col)
    is_definition = any(
        key[1] == name and value == (line, char_col)
        for key, value in info["name_pos"].items())
    return {"ok": True, "kind": classify(info, line, char_col, is_definition)}


def find_references(rel_file, line, name):
    if jedi is None:
        return {"ok": False, "error": "jedi not importable in %s" % sys.executable}
    abs_path = os.path.join(ROOT, rel_file)
    info = analyze_file(abs_path)
    pos = info["name_pos"].get((line, name))
    if pos is None:
        # Fallback: the name's own word-boundary position on the given line
        # (covers symbols listed by a different enumerator than list_symbols).
        if not info["lines"] or line < 1 or line > len(info["lines"]):
            return {"ok": False, "error": "no definition at %s:%d" % (rel_file, line)}
        m = re.search(r"\b%s\b" % re.escape(name), info["lines"][line - 1])
        if not m:
            return {"ok": False, "error": "name %r not on line %s:%d" % (name, rel_file, line)}
        pos = (line, m.start())

    script = _script_cache.get(abs_path)
    if script is None:
        script = jedi.Script(path=abs_path, project=PROJECT)
        _script_cache[abs_path] = script
    refs = script.get_references(line=pos[0], column=pos[1])

    out = []
    for ref in refs:
        if ref.module_path is None:
            continue
        ref_abs = os.path.abspath(str(ref.module_path))
        if not ref_abs.startswith(PROJECT_ROOT + os.sep):
            continue  # outside the detected project — not in either universe
        ref_info = analyze_file(ref_abs)
        out.append({
            "file": os.path.relpath(ref_abs, ROOT),
            "line": ref.line,
            "kind": classify(ref_info, ref.line, ref.column, ref.is_definition()),
        })
    return {"ok": True, "refs": out}


def main():
    sys.stdout.write(json.dumps({
        "ok": True, "ready": True,
        "jedi": jedi.__version__ if jedi else None,
        "python": sys.version.split()[0],
        "projectRoot": PROJECT_ROOT,
    }) + "\n")
    sys.stdout.flush()
    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
            op = req.get("op")
            if op == "list_symbols":
                resp = list_symbols()
            elif op == "find_references":
                resp = find_references(req["file"], req["line"], req["name"])
            elif op == "name_position":
                resp = name_position(req["file"], req["line"], req["name"])
            elif op == "classify_ref":
                resp = classify_ref(req["file"], req["line"], req["utf16_col"], req["name"])
            elif op == "shutdown":
                break
            else:
                resp = {"ok": False, "error": "unknown op: %r" % op}
        except Exception as exc:  # protocol must survive any per-request failure
            resp = {"ok": False, "error": "%s: %s" % (type(exc).__name__, exc)}
        sys.stdout.write(json.dumps(resp) + "\n")
        sys.stdout.flush()


if __name__ == "__main__":
    main()
