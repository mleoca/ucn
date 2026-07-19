// eval/oracles/rust-ast-helper - persistent Rust ast query server for the
// rust-analyzer oracle (same JSON-lines protocol as go-ast-helper.go /
// jedi-helper.py). Built on syn + proc-macro2 span-locations, so symbol
// enumeration and reference CLASSIFICATION are independent of UCN's
// tree-sitter parsers; reference RESOLUTION stays rust-analyzer's.
//
// Ops:
//
//   {"op": "list_symbols"}
//       -> {"ok": true, "symbols": [{"name", "file", "line", "kind"}]}
//          kind: function (fn items, incl. mod-nested) | method (impl fns) |
//          class (struct/enum). Lines are the first declaration token
//          (pub/const/async/unsafe/extern/fn/struct/enum) — attributes and
//          doc comments excluded, matching UCN's tree-sitter convention so
//          file:line:name handles pin exactly. Trait declaration methods and
//          macro_rules! are recorded as definition positions but not listed
//          (dispatch/expansion behave like the constructor-equivalents other
//          oracles exclude).
//   {"op": "name_position", "file": rel, "line": n, "name": s}
//       -> {"ok": true, "line": defLine, "utf16Col": c}   (LSP-ready position)
//   {"op": "classify_ref", "file": rel, "line": n, "utf16_col": c, "name": s}
//       -> {"ok": true, "kind": "call"|"import"|"definition"|"reference"}
//          call positions: ExprCall path callees, ExprMethodCall method
//          idents, ExprStruct paths (X { .. } is constructor syntax — parity
//          with Go composite literals), macro invocation paths, and
//          ident-followed-by-(...) inside macro token trees (mirrors UCN's
//          fix #201 token-tree convention, independently implemented on
//          proc-macro2 token streams).
//   {"op": "source_status", "file": rel, "line": n}
//       -> {"ok": true, "configurationGated": bool}
//          True when the line is inside a syn-parsed file/item/local carrying
//          #[cfg(...)]. This exposes rust-analyzer's single-configuration
//          coverage gaps without pretending they are engine false positives.
//   {"op": "shutdown"} -> exits.
//
// Symbol enumeration walks the prepared root only; classification reads any
// file under the workspace (refs may live in sibling crates).

use std::collections::{HashMap, HashSet};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};

use proc_macro2::{Delimiter, TokenStream, TokenTree};
use serde_json::{json, Value};
use syn::spanned::Spanned;
use syn::visit::{self, Visit};

#[derive(Default)]
struct FileInfo {
    lines: Vec<String>,
    symbols: Vec<(String, usize, &'static str)>, // (name, declLine, kind)
    name_pos: HashMap<(usize, String), (usize, usize)>, // (declLine, name) -> (nameLine, charCol)
    callee_pos: HashSet<(usize, usize)>,         // (line, charCol 0-based)
    def_pos: HashMap<(usize, usize), String>,    // decl-name positions -> name
    imports: Vec<(usize, usize)>,                // use-item line spans
    cfg_spans: Vec<(usize, usize)>,              // #[cfg] owner line spans
}

struct Collector<'a> {
    info: &'a mut FileInfo,
}

impl<'a> Collector<'a> {
    fn mark_cfg<T: Spanned>(&mut self, attrs: &[syn::Attribute], node: &T) {
        if attrs.iter().any(|a| a.path().is_ident("cfg")) {
            let span = node.span();
            self.info
                .cfg_spans
                .push((span.start().line, span.end().line));
        }
    }

    fn record(&mut self, decl_line: usize, ident: &proc_macro2::Ident, kind: &'static str) {
        let np = ident.span().start();
        let name = ident.to_string();
        self.info.symbols.push((name.clone(), decl_line, kind));
        self.info
            .name_pos
            .insert((decl_line, name.clone()), (np.line, np.column));
        self.info.def_pos.insert((np.line, np.column), name);
    }

    fn record_def_only(&mut self, ident: &proc_macro2::Ident) {
        let np = ident.span().start();
        self.info
            .def_pos
            .insert((np.line, np.column), ident.to_string());
    }

    fn mark_path_callee(&mut self, path: &syn::Path) {
        if let Some(seg) = path.segments.last() {
            let p = seg.ident.span().start();
            self.info.callee_pos.insert((p.line, p.column));
        }
    }

    /// Macro bodies are token soup to syn — mirror UCN's token-tree call
    /// convention: an ident immediately followed by a (...) group is a call.
    fn scan_tokens(&mut self, ts: TokenStream) {
        let tokens: Vec<TokenTree> = ts.into_iter().collect();
        for i in 0..tokens.len() {
            match &tokens[i] {
                TokenTree::Group(g) => self.scan_tokens(g.stream()),
                TokenTree::Ident(id) => {
                    if let Some(TokenTree::Group(g)) = tokens.get(i + 1) {
                        if g.delimiter() == Delimiter::Parenthesis {
                            let p = id.span().start();
                            self.info.callee_pos.insert((p.line, p.column));
                        }
                    }
                }
                _ => {}
            }
        }
    }
}

fn vis_line(vis: &syn::Visibility) -> Option<usize> {
    match vis {
        syn::Visibility::Public(t) => Some(t.span.start().line),
        syn::Visibility::Restricted(r) => Some(r.pub_token.span.start().line),
        syn::Visibility::Inherited => None,
    }
}

/// First declaration-token line of a fn signature (UCN's function_item start:
/// pub/default/const/async/unsafe/extern/fn — never attributes).
fn fn_decl_line(
    vis: Option<&syn::Visibility>,
    defaultness: Option<&syn::token::Default>,
    sig: &syn::Signature,
) -> usize {
    let mut line = sig.fn_token.span().start().line;
    if let Some(v) = vis {
        if let Some(l) = vis_line(v) {
            line = line.min(l);
        }
    }
    if let Some(d) = defaultness {
        line = line.min(d.span().start().line);
    }
    if let Some(c) = &sig.constness {
        line = line.min(c.span().start().line);
    }
    if let Some(a) = &sig.asyncness {
        line = line.min(a.span().start().line);
    }
    if let Some(u) = &sig.unsafety {
        line = line.min(u.span().start().line);
    }
    if let Some(abi) = &sig.abi {
        line = line.min(abi.extern_token.span().start().line);
    }
    line
}

impl<'a, 'ast> Visit<'ast> for Collector<'a> {
    fn visit_item(&mut self, i: &'ast syn::Item) {
        let attrs: &[syn::Attribute] = match i {
            syn::Item::Const(x) => &x.attrs,
            syn::Item::Enum(x) => &x.attrs,
            syn::Item::ExternCrate(x) => &x.attrs,
            syn::Item::Fn(x) => &x.attrs,
            syn::Item::ForeignMod(x) => &x.attrs,
            syn::Item::Impl(x) => &x.attrs,
            syn::Item::Macro(x) => &x.attrs,
            syn::Item::Mod(x) => &x.attrs,
            syn::Item::Static(x) => &x.attrs,
            syn::Item::Struct(x) => &x.attrs,
            syn::Item::Trait(x) => &x.attrs,
            syn::Item::TraitAlias(x) => &x.attrs,
            syn::Item::Type(x) => &x.attrs,
            syn::Item::Union(x) => &x.attrs,
            syn::Item::Use(x) => &x.attrs,
            _ => &[],
        };
        self.mark_cfg(attrs, i);
        visit::visit_item(self, i);
    }

    fn visit_impl_item(&mut self, i: &'ast syn::ImplItem) {
        let attrs: &[syn::Attribute] = match i {
            syn::ImplItem::Const(x) => &x.attrs,
            syn::ImplItem::Fn(x) => &x.attrs,
            syn::ImplItem::Type(x) => &x.attrs,
            syn::ImplItem::Macro(x) => &x.attrs,
            _ => &[],
        };
        self.mark_cfg(attrs, i);
        visit::visit_impl_item(self, i);
    }

    fn visit_trait_item(&mut self, i: &'ast syn::TraitItem) {
        let attrs: &[syn::Attribute] = match i {
            syn::TraitItem::Const(x) => &x.attrs,
            syn::TraitItem::Fn(x) => &x.attrs,
            syn::TraitItem::Type(x) => &x.attrs,
            syn::TraitItem::Macro(x) => &x.attrs,
            _ => &[],
        };
        self.mark_cfg(attrs, i);
        visit::visit_trait_item(self, i);
    }

    fn visit_local(&mut self, i: &'ast syn::Local) {
        self.mark_cfg(&i.attrs, i);
        visit::visit_local(self, i);
    }

    fn visit_item_fn(&mut self, i: &'ast syn::ItemFn) {
        let line = fn_decl_line(Some(&i.vis), None, &i.sig);
        self.record(line, &i.sig.ident, "function");
        visit::visit_item_fn(self, i);
    }

    fn visit_impl_item_fn(&mut self, i: &'ast syn::ImplItemFn) {
        let line = fn_decl_line(Some(&i.vis), i.defaultness.as_ref(), &i.sig);
        self.record(line, &i.sig.ident, "method");
        visit::visit_impl_item_fn(self, i);
    }

    fn visit_trait_item_fn(&mut self, i: &'ast syn::TraitItemFn) {
        self.record_def_only(&i.sig.ident);
        visit::visit_trait_item_fn(self, i);
    }

    fn visit_item_struct(&mut self, i: &'ast syn::ItemStruct) {
        let mut line = i.struct_token.span().start().line;
        if let Some(l) = vis_line(&i.vis) {
            line = line.min(l);
        }
        self.record(line, &i.ident, "class");
        visit::visit_item_struct(self, i);
    }

    fn visit_item_enum(&mut self, i: &'ast syn::ItemEnum) {
        let mut line = i.enum_token.span().start().line;
        if let Some(l) = vis_line(&i.vis) {
            line = line.min(l);
        }
        self.record(line, &i.ident, "class");
        visit::visit_item_enum(self, i);
    }

    fn visit_item_trait(&mut self, i: &'ast syn::ItemTrait) {
        self.record_def_only(&i.ident);
        visit::visit_item_trait(self, i);
    }

    fn visit_item_macro(&mut self, i: &'ast syn::ItemMacro) {
        if let Some(ident) = &i.ident {
            self.record_def_only(ident); // macro_rules! name
        }
        visit::visit_item_macro(self, i);
    }

    fn visit_item_use(&mut self, i: &'ast syn::ItemUse) {
        let start = i.use_token.span().start().line;
        let end = i.semi_token.span().start().line;
        self.info.imports.push((start, end));
        // no recursion needed — use-tree idents are import refs by span
    }

    fn visit_expr_call(&mut self, e: &'ast syn::ExprCall) {
        if let syn::Expr::Path(p) = &*e.func {
            self.mark_path_callee(&p.path);
        }
        visit::visit_expr_call(self, e);
    }

    fn visit_expr_method_call(&mut self, e: &'ast syn::ExprMethodCall) {
        let p = e.method.span().start();
        self.info.callee_pos.insert((p.line, p.column));
        visit::visit_expr_method_call(self, e);
    }

    fn visit_expr_struct(&mut self, e: &'ast syn::ExprStruct) {
        // X { .. } — Rust's record-constructor syntax
        self.mark_path_callee(&e.path);
        visit::visit_expr_struct(self, e);
    }

    fn visit_macro(&mut self, m: &'ast syn::Macro) {
        self.mark_path_callee(&m.path);
        self.scan_tokens(m.tokens.clone());
        visit::visit_macro(self, m);
    }
}

struct Server {
    root: PathBuf,
    cache: HashMap<PathBuf, FileInfo>,
}

impl Server {
    fn analyze(&mut self, abs: &Path) -> &FileInfo {
        if !self.cache.contains_key(abs) {
            let mut info = FileInfo::default();
            if let Ok(src) = std::fs::read_to_string(abs) {
                info.lines = src.split('\n').map(|s| s.to_string()).collect();
                if let Ok(file) = syn::parse_file(&src) {
                    let mut c = Collector { info: &mut info };
                    if file.attrs.iter().any(|a| a.path().is_ident("cfg")) {
                        c.info.cfg_spans.push((1, c.info.lines.len().max(1)));
                    }
                    c.visit_file(&file);
                }
                // parse failure: lines-only info — every ref classifies as
                // "reference" (conservative, never invents a call)
            }
            self.cache.insert(abs.to_path_buf(), info);
        }
        self.cache.get(abs).unwrap()
    }

    fn line_text(info: &FileInfo, line: usize) -> &str {
        if line >= 1 && line <= info.lines.len() {
            &info.lines[line - 1]
        } else {
            ""
        }
    }

    fn list_symbols(&mut self) -> Value {
        let mut files = Vec::new();
        walk_rs(&self.root, &mut files);
        files.sort();
        let mut symbols = Vec::new();
        for abs in files {
            let rel = abs
                .strip_prefix(&self.root)
                .unwrap_or(&abs)
                .to_string_lossy()
                .replace('\\', "/");
            let info = self.analyze(&abs);
            let mut entries: Vec<_> = info.symbols.clone();
            entries.sort_by(|a, b| a.1.cmp(&b.1).then(a.0.cmp(&b.0)));
            for (name, line, kind) in entries {
                symbols.push(json!({"name": name, "file": rel, "line": line, "kind": kind}));
            }
        }
        json!({"ok": true, "symbols": symbols})
    }

    fn name_position(&mut self, rel: &str, line: usize, name: &str) -> Value {
        let abs = self.root.join(rel);
        let info = self.analyze(&abs);
        if let Some(&(name_line, char_col)) = info.name_pos.get(&(line, name.to_string())) {
            let text = Self::line_text(info, name_line);
            return json!({"ok": true, "line": name_line, "utf16Col": utf16_col(text, char_col)});
        }
        // Fallback: word search on the given line
        let text = Self::line_text(info, line);
        match index_of_word(text, name) {
            Some(char_idx) => {
                json!({"ok": true, "line": line, "utf16Col": utf16_col(text, char_idx)})
            }
            None => json!({"ok": false, "error": format!("name not found at {}:{}", rel, line)}),
        }
    }

    fn classify_ref(&mut self, rel: &str, line: usize, u16col: usize, name: &str) -> Value {
        let abs = self.root.join(rel);
        let info = self.analyze(&abs);
        let col = char_col_from_utf16(Self::line_text(info, line), u16col);
        let mut kind = "reference";
        for &(start, end) in &info.imports {
            if line >= start && line <= end {
                kind = "import";
            }
        }
        if kind == "reference" {
            if info.callee_pos.contains(&(line, col)) {
                kind = "call";
            } else if info.def_pos.get(&(line, col)).map(|s| s.as_str()) == Some(name) {
                kind = "definition";
            }
        }
        json!({"ok": true, "kind": kind})
    }

    fn source_status(&mut self, rel: &str, line: usize) -> Value {
        let abs = self.root.join(rel);
        let info = self.analyze(&abs);
        let configuration_gated = info
            .cfg_spans
            .iter()
            .any(|&(start, end)| line >= start && line <= end);
        json!({"ok": true, "configurationGated": configuration_gated})
    }
}

fn walk_rs(dir: &Path, out: &mut Vec<PathBuf>) {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for entry in entries.flatten() {
        let p = entry.path();
        let base = entry.file_name().to_string_lossy().to_string();
        if p.is_dir() {
            if base.starts_with('.')
                || base == "target"
                || base == "node_modules"
                || base == "testdata"
                || base == "vendor"
            {
                continue;
            }
            walk_rs(&p, out);
        } else if base.ends_with(".rs") {
            out.push(p);
        }
    }
}

fn utf16_col(line_text: &str, char_col: usize) -> usize {
    line_text
        .chars()
        .take(char_col)
        .map(|c| c.len_utf16())
        .sum()
}

fn char_col_from_utf16(line_text: &str, u16col: usize) -> usize {
    let mut units = 0;
    let mut chars = 0;
    for c in line_text.chars() {
        if units >= u16col {
            return chars;
        }
        units += c.len_utf16();
        chars += 1;
    }
    chars
}

fn is_word_char(c: char) -> bool {
    c == '_' || c.is_alphanumeric()
}

/// Word-boundary search; returns the CHAR index of the match start.
fn index_of_word(text: &str, name: &str) -> Option<usize> {
    let chars: Vec<char> = text.chars().collect();
    let needle: Vec<char> = name.chars().collect();
    if needle.is_empty() || chars.len() < needle.len() {
        return None;
    }
    for i in 0..=(chars.len() - needle.len()) {
        if chars[i..i + needle.len()] != needle[..] {
            continue;
        }
        let before_ok = i == 0 || !is_word_char(chars[i - 1]);
        let after_idx = i + needle.len();
        let after_ok = after_idx >= chars.len() || !is_word_char(chars[after_idx]);
        if before_ok && after_ok {
            return Some(i);
        }
    }
    None
}

fn get_str<'v>(req: &'v Value, key: &str) -> &'v str {
    req.get(key).and_then(|v| v.as_str()).unwrap_or("")
}

fn get_usize(req: &Value, key: &str) -> usize {
    req.get(key).and_then(|v| v.as_u64()).unwrap_or(0) as usize
}

fn main() {
    let root = std::env::args()
        .nth(1)
        .expect("usage: rust-ast-helper <root>");
    let root = std::fs::canonicalize(&root).unwrap_or_else(|_| PathBuf::from(&root));
    let mut server = Server {
        root,
        cache: HashMap::new(),
    };

    let stdout = std::io::stdout();
    let mut out = stdout.lock();
    writeln!(out, "{}", json!({"ok": true, "ready": true, "rust": true})).unwrap();
    out.flush().unwrap();

    let stdin = std::io::stdin();
    for line in stdin.lock().lines() {
        let raw = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let raw = raw.trim();
        if raw.is_empty() {
            continue;
        }
        let resp = match serde_json::from_str::<Value>(raw) {
            Err(e) => json!({"ok": false, "error": e.to_string()}),
            Ok(req) => match req.get("op").and_then(|v| v.as_str()) {
                Some("list_symbols") => server.list_symbols(),
                Some("name_position") => server.name_position(
                    get_str(&req, "file"),
                    get_usize(&req, "line"),
                    get_str(&req, "name"),
                ),
                Some("classify_ref") => server.classify_ref(
                    get_str(&req, "file"),
                    get_usize(&req, "line"),
                    get_usize(&req, "utf16_col"),
                    get_str(&req, "name"),
                ),
                Some("source_status") => {
                    server.source_status(get_str(&req, "file"), get_usize(&req, "line"))
                }
                Some("shutdown") => return,
                _ => json!({"ok": false, "error": "unknown op"}),
            },
        };
        writeln!(out, "{}", resp).unwrap();
        out.flush().unwrap();
    }
}
