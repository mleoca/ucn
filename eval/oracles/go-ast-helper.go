// eval/oracles/go-ast-helper.go - persistent Go ast query server for the
// gopls oracle (same JSON-lines protocol as jedi-helper.py).
//
// Ops:
//
//	{"op": "list_symbols"}
//	    -> {"ok": true, "symbols": [{"name", "file", "line", "kind"}]}
//	       kind: function|method|class (structs map to class). Lines are the
//	       func/type keyword line — matching UCN's tree-sitter convention so
//	       file:line:name handles pin exactly.
//	{"op": "name_position", "file": rel, "line": n, "name": s}
//	    -> {"ok": true, "line": defLine, "utf16Col": c}   (LSP-ready position)
//	{"op": "classify_ref", "file": rel, "line": n, "utf16_col": c, "name": s}
//	    -> {"ok": true, "kind": "call"|"import"|"definition"|"reference"}
//	       call positions come from ast.CallExpr callees and composite-literal
//	       types (X{...} is Go's constructor syntax — parity with `new X()`).
//	{"op": "shutdown"} -> exits.
//
// Symbol enumeration walks the prepared root only; classification reads any
// file under the module (refs may live in sibling dirs).
package main

import (
	"bufio"
	"encoding/json"
	"go/ast"
	"go/build"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"unicode/utf16"
)

type symbolEntry struct {
	Name string `json:"name"`
	File string `json:"file"`
	Line int    `json:"line"`
	Kind string `json:"kind"`
}

type fileInfo struct {
	lines     []string
	symbols   []symbolEntry
	namePos   map[string][2]int // "declLine:name" -> {nameLine, byteCol(0-based)}
	calleePos map[[2]int]bool   // {line, byteCol(0-based)} of call/composite-lit names
	defPos    map[[2]int]string // decl-name positions -> name
	imports   [][2]int          // {startLine, endLine} spans
}

var root string
var cache = map[string]*fileInfo{}

func analyze(absPath string) *fileInfo {
	if info, ok := cache[absPath]; ok {
		return info
	}
	info := &fileInfo{
		namePos:   map[string][2]int{},
		calleePos: map[[2]int]bool{},
		defPos:    map[[2]int]string{},
	}
	cache[absPath] = info
	src, err := os.ReadFile(absPath)
	if err != nil {
		return info
	}
	info.lines = strings.Split(string(src), "\n")
	fset := token.NewFileSet()
	f, err := parser.ParseFile(fset, absPath, src, parser.SkipObjectResolution)
	if err != nil || f == nil {
		return info
	}

	record := func(declPos, namePos token.Pos, name, kind string) {
		dp := fset.Position(declPos)
		np := fset.Position(namePos)
		info.symbols = append(info.symbols, symbolEntry{Name: name, Line: dp.Line, Kind: kind})
		key := keyOf(dp.Line, name)
		info.namePos[key] = [2]int{np.Line, np.Column - 1}
		info.defPos[[2]int{np.Line, np.Column - 1}] = name
	}

	for _, decl := range f.Decls {
		switch d := decl.(type) {
		case *ast.FuncDecl:
			if d.Name == nil {
				continue
			}
			kind := "function"
			if d.Recv != nil && len(d.Recv.List) > 0 {
				kind = "method"
			}
			record(d.Pos(), d.Name.Pos(), d.Name.Name, kind)
		case *ast.GenDecl:
			for _, spec := range d.Specs {
				if ts, ok := spec.(*ast.TypeSpec); ok && ts.Name != nil {
					if _, isStruct := ts.Type.(*ast.StructType); isStruct {
						record(ts.Pos(), ts.Name.Pos(), ts.Name.Name, "class")
					}
				}
			}
		}
	}

	markCallee := func(expr ast.Expr) {
		switch fn := expr.(type) {
		case *ast.Ident:
			p := fset.Position(fn.Pos())
			info.calleePos[[2]int{p.Line, p.Column - 1}] = true
		case *ast.SelectorExpr:
			if fn.Sel != nil {
				p := fset.Position(fn.Sel.Pos())
				info.calleePos[[2]int{p.Line, p.Column - 1}] = true
			}
		}
	}
	ast.Inspect(f, func(n ast.Node) bool {
		switch node := n.(type) {
		case *ast.CallExpr:
			markCallee(node.Fun)
		case *ast.CompositeLit:
			// X{...} / pkg.X{...} — Go's constructor syntax
			markCallee(node.Type)
		case *ast.ImportSpec:
			start := fset.Position(node.Pos()).Line
			end := fset.Position(node.End()).Line
			info.imports = append(info.imports, [2]int{start, end})
		}
		return true
	})
	return info
}

func keyOf(line int, name string) string {
	return strconv.Itoa(line) + ":" + name
}

func utf16Col(lineText string, byteCol int) int {
	if byteCol > len(lineText) {
		byteCol = len(lineText)
	}
	return len(utf16.Encode([]rune(lineText[:byteCol])))
}

func byteCol(lineText string, u16 int) int {
	count := 0
	for i, r := range lineText {
		if count >= u16 {
			return i
		}
		count += len(utf16.Encode([]rune{r}))
	}
	return len(lineText)
}

func lineText(info *fileInfo, line int) string {
	if line < 1 || line > len(info.lines) {
		return ""
	}
	return info.lines[line-1]
}

func listSymbols() map[string]any {
	var symbols []map[string]any
	filepath.Walk(root, func(p string, fi os.FileInfo, err error) error {
		if err != nil {
			return nil
		}
		base := filepath.Base(p)
		if fi.IsDir() {
			if strings.HasPrefix(base, ".") || base == "vendor" || base == "testdata" || base == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		if !strings.HasSuffix(base, ".go") {
			return nil
		}
		rel, _ := filepath.Rel(root, p)
		for _, s := range analyze(p).symbols {
			symbols = append(symbols, map[string]any{
				"name": s.Name, "file": rel, "line": s.Line, "kind": s.Kind,
			})
		}
		return nil
	})
	sort.Slice(symbols, func(i, j int) bool {
		fi, fj := symbols[i]["file"].(string), symbols[j]["file"].(string)
		if fi != fj {
			return fi < fj
		}
		return symbols[i]["line"].(int) < symbols[j]["line"].(int)
	})
	return map[string]any{"ok": true, "symbols": symbols}
}

func namePosition(rel string, line int, name string) map[string]any {
	info := analyze(filepath.Join(root, rel))
	if pos, ok := info.namePos[keyOf(line, name)]; ok {
		return map[string]any{
			"ok": true, "line": pos[0],
			"utf16Col": utf16Col(lineText(info, pos[0]), pos[1]),
		}
	}
	// Fallback: word search on the given line
	text := lineText(info, line)
	idx := indexOfWord(text, name)
	if idx < 0 {
		return map[string]any{"ok": false, "error": "name not found at " + rel}
	}
	return map[string]any{"ok": true, "line": line, "utf16Col": utf16Col(text, idx)}
}

func indexOfWord(text, name string) int {
	for from := 0; ; {
		i := strings.Index(text[from:], name)
		if i < 0 {
			return -1
		}
		i += from
		beforeOk := i == 0 || !isWordByte(text[i-1])
		afterIdx := i + len(name)
		afterOk := afterIdx >= len(text) || !isWordByte(text[afterIdx])
		if beforeOk && afterOk {
			return i
		}
		from = i + 1
	}
}

func isWordByte(b byte) bool {
	return b == '_' || (b >= '0' && b <= '9') || (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z')
}

func classifyRef(rel string, line int, u16 int, name string) map[string]any {
	info := analyze(filepath.Join(root, rel))
	col := byteCol(lineText(info, line), u16)
	kind := "reference"
	for _, span := range info.imports {
		if line >= span[0] && line <= span[1] {
			kind = "import"
		}
	}
	if kind == "reference" {
		if info.calleePos[[2]int{line, col}] {
			kind = "call"
		} else if info.defPos[[2]int{line, col}] == name {
			kind = "definition"
		}
	}
	return map[string]any{"ok": true, "kind": kind}
}

func sourceStatus(rel string) map[string]any {
	clean := filepath.Clean(rel)
	for _, segment := range strings.Split(clean, string(filepath.Separator)) {
		if segment == "testdata" || strings.HasPrefix(segment, ".") || strings.HasPrefix(segment, "_") {
			return map[string]any{"ok": true, "gated": true, "reason": "ignored-directory"}
		}
	}
	abs := filepath.Join(root, clean)
	match, err := build.Default.MatchFile(filepath.Dir(abs), filepath.Base(abs))
	if err != nil {
		return map[string]any{"ok": false, "error": err.Error()}
	}
	return map[string]any{"ok": true, "gated": !match, "reason": "build-constraints"}
}

func main() {
	abs, _ := filepath.Abs(os.Args[1])
	root = abs
	out := bufio.NewWriter(os.Stdout)
	enc := json.NewEncoder(out)
	banner := map[string]any{"ok": true, "ready": true, "go": true}
	enc.Encode(banner)
	out.Flush()

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 1024*1024), 16*1024*1024)
	for scanner.Scan() {
		raw := strings.TrimSpace(scanner.Text())
		if raw == "" {
			continue
		}
		var req map[string]any
		var resp map[string]any
		if err := json.Unmarshal([]byte(raw), &req); err != nil {
			resp = map[string]any{"ok": false, "error": err.Error()}
		} else {
			switch req["op"] {
			case "list_symbols":
				resp = listSymbols()
			case "name_position":
				resp = namePosition(req["file"].(string), int(req["line"].(float64)), req["name"].(string))
			case "classify_ref":
				resp = classifyRef(req["file"].(string), int(req["line"].(float64)),
					int(req["utf16_col"].(float64)), req["name"].(string))
			case "source_status":
				resp = sourceStatus(req["file"].(string))
			case "shutdown":
				return
			default:
				resp = map[string]any{"ok": false, "error": "unknown op"}
			}
		}
		enc.Encode(resp)
		out.Flush()
	}
}
