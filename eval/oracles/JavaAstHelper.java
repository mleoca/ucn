// eval/oracles/JavaAstHelper.java - persistent Java ast query server for the
// jdtls oracle (same JSON-lines protocol as go-ast-helper.go / rust-ast-helper).
// Built on the JDK's own javac tree API (com.sun.source) — parse-only, no
// classpath resolution, no third-party deps — so symbol enumeration and
// reference CLASSIFICATION are independent of UCN's tree-sitter parsers;
// reference RESOLUTION stays jdtls's.
//
// Ops:
//   {"op": "list_symbols"}
//       -> {"ok": true, "symbols": [{"name", "file", "line", "kind"}]}
//          kind: method (class/enum/record methods, incl. static) |
//          class (class/enum/record declarations, incl. nested named).
//          Interfaces, annotation types, constructors, and anonymous-class
//          members are excluded (dispatch/constructor-equivalents — same
//          exclusions the other oracles apply). Lines are ANNOTATION-INCLUSIVE
//          declaration starts, matching UCN's tree-sitter convention so
//          file:line:name handles pin exactly.
//   {"op": "name_position", "file": rel, "line": n, "name": s}
//       -> {"ok": true, "line": defLine, "utf16Col": c}   (LSP-ready position)
//   {"op": "classify_ref", "file": rel, "line": n, "utf16_col": c, "name": s}
//       -> {"ok": true, "kind": "call"|"import"|"definition"|"reference"}
//          call positions: method-invocation select identifiers and
//          new-class identifiers (constructor parity with Go composite
//          literals / Rust struct expressions).
//   {"op": "shutdown"} -> exits.
//
// Run: java JavaAstHelper.java <root>   (JDK 17+, single-file source launch)

import com.sun.source.tree.*;
import com.sun.source.util.*;
import javax.tools.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;

public class JavaAstHelper {

    static Path root;
    static final Map<String, FileInfo> cache = new HashMap<>();

    static class FileInfo {
        List<String> lines = new ArrayList<>();
        List<long[]> symbolEntries = new ArrayList<>(); // unused; symbols below
        List<Map<String, Object>> symbols = new ArrayList<>();
        Map<String, long[]> namePos = new HashMap<>();   // "declLine:name" -> {nameLine, utf16Col}
        Set<Long> calleePos = new HashSet<>();           // (line << 32) | utf16Col
        Map<Long, String> defPos = new HashMap<>();      // name-position -> name
        List<int[]> imports = new ArrayList<>();         // {startLine, endLine}
    }

    static long key(long line, long col) { return (line << 32) | col; }

    static FileInfo analyze(Path abs) {
        String k = abs.toString();
        FileInfo cached = cache.get(k);
        if (cached != null) return cached;
        FileInfo info = new FileInfo();
        cache.put(k, info);
        String src;
        try {
            src = new String(Files.readAllBytes(abs), StandardCharsets.UTF_8);
        } catch (IOException e) {
            return info;
        }
        info.lines = Arrays.asList(src.split("\n", -1));

        JavaCompiler compiler = ToolProvider.getSystemJavaCompiler();
        DiagnosticListener<JavaFileObject> quiet = d -> {};
        try (StandardJavaFileManager fm = compiler.getStandardFileManager(quiet, null, StandardCharsets.UTF_8)) {
            Iterable<? extends JavaFileObject> units = fm.getJavaFileObjects(abs);
            // -Xjcov: keep the end-position table — without it
            // getEndPosition returns NOPOS and callee positions
            // (MemberSelect end - name length) can never be computed.
            JavacTask task = (JavacTask) compiler.getTask(
                new PrintWriter(Writer.nullWriter()), fm, quiet,
                List.of("-proc:none", "-Xjcov"), null, units);
            SourcePositions pos = Trees.instance(task).getSourcePositions();
            for (CompilationUnitTree unit : task.parse()) {
                scan(unit, pos, info, src);
            }
        } catch (Throwable t) {
            // parse failure: lines-only info — refs classify as "reference"
        }
        return info;
    }

    static void scan(CompilationUnitTree unit, SourcePositions pos, FileInfo info, String src) {
        LineMap lm = unit.getLineMap();

        for (ImportTree imp : unit.getImports()) {
            long s = pos.getStartPosition(unit, imp);
            long e = pos.getEndPosition(unit, imp);
            if (s >= 0 && e >= 0) {
                info.imports.add(new int[]{(int) lm.getLineNumber(s), (int) lm.getLineNumber(e)});
            }
        }

        new TreeScanner<Void, Boolean>() {
            // second param: inside an enumerable (named, non-interface) class

            private void recordDef(String name, long namePosition) {
                if (namePosition < 0) return;
                long line = lm.getLineNumber(namePosition);
                long col = lm.getColumnNumber(namePosition) - 1; // 1-based char col -> 0-based utf16
                info.defPos.put(key(line, col), name);
            }

            private void recordSymbol(Tree decl, String name, String kind, long namePosition) {
                long declStart = pos.getStartPosition(unit, decl);
                if (declStart < 0 || namePosition < 0) return;
                long declLine = lm.getLineNumber(declStart);
                long nameLine = lm.getLineNumber(namePosition);
                long nameCol = lm.getColumnNumber(namePosition) - 1;
                Map<String, Object> sym = new LinkedHashMap<>();
                sym.put("name", name);
                sym.put("line", declLine);
                sym.put("kind", kind);
                info.symbols.add(sym);
                info.namePos.put(declLine + ":" + name, new long[]{nameLine, nameCol});
                recordDef(name, namePosition);
            }

            /** Find the name token position by word-boundary scan from `from`. */
            private long findName(long from, String name) {
                if (from < 0) return -1;
                int i = (int) from;
                while (i >= 0 && i < src.length()) {
                    i = src.indexOf(name, i);
                    if (i < 0) return -1;
                    boolean beforeOk = i == 0 || !isWord(src.charAt(i - 1));
                    int after = i + name.length();
                    boolean afterOk = after >= src.length() || !isWord(src.charAt(after));
                    if (beforeOk && afterOk) return i;
                    i = after;
                }
                return -1;
            }

            private boolean isWord(char c) {
                return c == '_' || c == '$' || Character.isLetterOrDigit(c);
            }

            @Override
            public Void visitClass(ClassTree node, Boolean inClass) {
                String name = node.getSimpleName() == null ? "" : node.getSimpleName().toString();
                Tree.Kind kindOf = node.getKind();
                boolean named = !name.isEmpty();
                boolean enumerable = named &&
                    (kindOf == Tree.Kind.CLASS || kindOf == Tree.Kind.ENUM || kindOf == Tree.Kind.RECORD);
                if (named) {
                    // name token follows the class/enum/record/interface keyword
                    long bodyStart = pos.getStartPosition(unit, node);
                    long namePosition = findName(bodyStart, name);
                    if (enumerable) {
                        recordSymbol(node, name, "class", namePosition);
                    } else {
                        recordDef(name, namePosition);
                    }
                }
                return super.visitClass(node, enumerable);
            }

            @Override
            public Void visitMethod(MethodTree node, Boolean inClass) {
                String name = node.getName().toString();
                if (!"<init>".equals(name)) {
                    // name token follows the return type (methods always have one;
                    // <init> constructors are skipped)
                    long scanFrom = node.getReturnType() != null
                        ? pos.getEndPosition(unit, node.getReturnType())
                        : pos.getStartPosition(unit, node);
                    long namePosition = findName(scanFrom, name);
                    if (Boolean.TRUE.equals(inClass) && node.getBody() != null) {
                        recordSymbol(node, name, "method", namePosition);
                    } else {
                        recordDef(name, namePosition);
                    }
                }
                return super.visitMethod(node, false); // anonymous/local members not enumerated
            }

            @Override
            public Void visitVariable(VariableTree node, Boolean inClass) {
                // field/variable declarator names are definition positions
                long scanFrom = node.getType() != null
                    ? pos.getEndPosition(unit, node.getType())
                    : pos.getStartPosition(unit, node);
                recordDef(node.getName().toString(), findName(scanFrom, node.getName().toString()));
                return super.visitVariable(node, inClass);
            }

            @Override
            public Void visitMethodInvocation(MethodInvocationTree node, Boolean inClass) {
                ExpressionTree select = node.getMethodSelect();
                long p = -1;
                String mName = null;
                if (select instanceof MemberSelectTree ms) {
                    mName = ms.getIdentifier().toString();
                    long end = pos.getEndPosition(unit, ms);
                    if (end >= 0) p = end - mName.length();
                } else if (select instanceof IdentifierTree id) {
                    mName = id.getName().toString();
                    p = pos.getStartPosition(unit, select);
                }
                if (p >= 0 && mName != null) {
                    long line = lm.getLineNumber(p);
                    long col = lm.getColumnNumber(p) - 1;
                    info.calleePos.add(key(line, col));
                }
                return super.visitMethodInvocation(node, inClass);
            }

            @Override
            public Void visitNewClass(NewClassTree node, Boolean inClass) {
                // new Foo(...) — constructor call = class usage parity
                Tree id = node.getIdentifier();
                long s = pos.getStartPosition(unit, id);
                long e = pos.getEndPosition(unit, id);
                if (s >= 0) {
                    // strip generics / qualified prefix: take last identifier start
                    String text = e > s && e <= src.length() ? src.substring((int) s, (int) e) : "";
                    int lt = text.indexOf('<');
                    if (lt >= 0) text = text.substring(0, lt);
                    int dot = text.lastIndexOf('.');
                    long idStart = s + (dot >= 0 ? dot + 1 : 0);
                    long line = lm.getLineNumber(idStart);
                    long col = lm.getColumnNumber(idStart) - 1;
                    info.calleePos.add(key(line, col));
                }
                return super.visitNewClass(node, inClass);
            }
        }.scan(unit, Boolean.FALSE);
    }

    // ---- protocol ----

    public static void main(String[] args) throws Exception {
        root = Paths.get(args[0]).toAbsolutePath().normalize();
        PrintStream out = new PrintStream(new FileOutputStream(FileDescriptor.out), true, StandardCharsets.UTF_8);
        out.println("{\"ok\": true, \"ready\": true, \"java\": true}");

        BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
        String line;
        while ((line = in.readLine()) != null) {
            line = line.trim();
            if (line.isEmpty()) continue;
            Map<String, String> req = parseFlatJson(line);
            String op = req.getOrDefault("op", "");
            String resp;
            try {
                switch (op) {
                    case "list_symbols": resp = listSymbols(); break;
                    case "name_position":
                        resp = namePosition(req.get("file"), Long.parseLong(req.getOrDefault("line", "0")), req.get("name"));
                        break;
                    case "classify_ref":
                        resp = classifyRef(req.get("file"), Long.parseLong(req.getOrDefault("line", "0")),
                            Long.parseLong(req.getOrDefault("utf16_col", "0")), req.get("name"));
                        break;
                    case "shutdown": return;
                    default: resp = "{\"ok\": false, \"error\": \"unknown op\"}";
                }
            } catch (Throwable t) {
                resp = "{\"ok\": false, \"error\": " + quote(String.valueOf(t)) + "}";
            }
            out.println(resp);
        }
    }

    static String listSymbols() throws IOException {
        List<Path> files = new ArrayList<>();
        Files.walkFileTree(root, new SimpleFileVisitor<>() {
            @Override
            public FileVisitResult preVisitDirectory(Path dir, java.nio.file.attribute.BasicFileAttributes a) {
                String base = dir.getFileName() == null ? "" : dir.getFileName().toString();
                if (base.startsWith(".") || base.equals("target") || base.equals("build") || base.equals("node_modules")) {
                    return FileVisitResult.SKIP_SUBTREE;
                }
                return FileVisitResult.CONTINUE;
            }
            @Override
            public FileVisitResult visitFile(Path f, java.nio.file.attribute.BasicFileAttributes a) {
                if (f.toString().endsWith(".java")) files.add(f);
                return FileVisitResult.CONTINUE;
            }
        });
        Collections.sort(files);
        StringBuilder sb = new StringBuilder("{\"ok\": true, \"symbols\": [");
        boolean first = true;
        for (Path f : files) {
            String rel = root.relativize(f).toString().replace('\\', '/');
            FileInfo info = analyze(f);
            List<Map<String, Object>> sorted = new ArrayList<>(info.symbols);
            sorted.sort(Comparator.comparingLong(m -> (Long) m.get("line")));
            for (Map<String, Object> s : sorted) {
                if (!first) sb.append(", ");
                first = false;
                sb.append("{\"name\": ").append(quote((String) s.get("name")))
                  .append(", \"file\": ").append(quote(rel))
                  .append(", \"line\": ").append(s.get("line"))
                  .append(", \"kind\": ").append(quote((String) s.get("kind"))).append("}");
            }
        }
        return sb.append("]}").toString();
    }

    static String lineText(FileInfo info, long line) {
        if (line < 1 || line > info.lines.size()) return "";
        return info.lines.get((int) line - 1);
    }

    static String namePosition(String rel, long line, String name) {
        FileInfo info = analyze(root.resolve(rel).normalize());
        long[] np = info.namePos.get(line + ":" + name);
        if (np != null) {
            return "{\"ok\": true, \"line\": " + np[0] + ", \"utf16Col\": " + np[1] + "}";
        }
        // Fallback: word search on the given line
        String text = lineText(info, line);
        int idx = indexOfWord(text, name);
        if (idx < 0) return "{\"ok\": false, \"error\": " + quote("name not found at " + rel + ":" + line) + "}";
        return "{\"ok\": true, \"line\": " + line + ", \"utf16Col\": " + idx + "}";
    }

    static String classifyRef(String rel, long line, long col, String name) {
        FileInfo info = analyze(root.resolve(rel).normalize());
        String kind = "reference";
        for (int[] span : info.imports) {
            if (line >= span[0] && line <= span[1]) kind = "import";
        }
        if (kind.equals("reference")) {
            if (info.calleePos.contains(key(line, col))) kind = "call";
            else if (name != null && name.equals(info.defPos.get(key(line, col)))) kind = "definition";
        }
        return "{\"ok\": true, \"kind\": \"" + kind + "\"}";
    }

    static int indexOfWord(String text, String name) {
        int from = 0;
        while (true) {
            int i = text.indexOf(name, from);
            if (i < 0) return -1;
            boolean beforeOk = i == 0 || !isWordCh(text.charAt(i - 1));
            int after = i + name.length();
            boolean afterOk = after >= text.length() || !isWordCh(text.charAt(after));
            if (beforeOk && afterOk) return i;
            from = after;
        }
    }

    static boolean isWordCh(char c) {
        return c == '_' || c == '$' || Character.isLetterOrDigit(c);
    }

    /** Minimal flat-JSON object parser — request fields are strings/numbers only. */
    static Map<String, String> parseFlatJson(String s) {
        Map<String, String> out = new HashMap<>();
        int i = 0, n = s.length();
        while (i < n) {
            int kq = s.indexOf('"', i);
            if (kq < 0) break;
            StringBuilder kb = new StringBuilder();
            int ke = readString(s, kq, kb);
            if (ke < 0) break;
            int colon = s.indexOf(':', ke);
            if (colon < 0) break;
            int v = colon + 1;
            while (v < n && Character.isWhitespace(s.charAt(v))) v++;
            if (v < n && s.charAt(v) == '"') {
                StringBuilder vb = new StringBuilder();
                int ve = readString(s, v, vb);
                if (ve < 0) break;
                out.put(kb.toString(), vb.toString());
                i = ve;
            } else {
                int e = v;
                while (e < n && (Character.isDigit(s.charAt(e)) || s.charAt(e) == '-' || s.charAt(e) == '.')) e++;
                out.put(kb.toString(), s.substring(v, e));
                i = e + 1;
            }
        }
        return out;
    }

    /** Read a JSON string starting at the opening quote; returns index past closing quote. */
    static int readString(String s, int start, StringBuilder sb) {
        int i = start + 1;
        while (i < s.length()) {
            char c = s.charAt(i);
            if (c == '\\' && i + 1 < s.length()) {
                char e = s.charAt(i + 1);
                switch (e) {
                    case 'n': sb.append('\n'); break;
                    case 't': sb.append('\t'); break;
                    case 'r': sb.append('\r'); break;
                    case 'u':
                        if (i + 5 < s.length()) {
                            sb.append((char) Integer.parseInt(s.substring(i + 2, i + 6), 16));
                            i += 4;
                        }
                        break;
                    default: sb.append(e);
                }
                i += 2;
            } else if (c == '"') {
                return i + 1;
            } else {
                sb.append(c);
                i++;
            }
        }
        return -1;
    }

    static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }
}
