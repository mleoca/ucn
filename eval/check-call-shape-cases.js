/**
 * What a call-shaped expression is, one edit each (fix #506c).
 *
 * A valid change that the count check must not call a break, beside the
 * wrong count that must stay one: a call of a chain (each call is counted
 * with its own arguments, whichever call the chain starts with), a tuple
 * struct or tuple variant constructed with one value per field, a type
 * name converting one value, a callee the enclosing function binds
 * locally, a module function beside members of the same name, a callable
 * whose call interface is the written type of the binding that holds it.
 * And what a namespace-qualified call reaches (fix #506d): the module's
 * own exported binding of the name, never a function the module assigns
 * to a member of some other value.
 * `expect` is the toolchain's verdict (eval/run-check-matrix.js);
 * `answer` and `detail` are the check's.
 */
'use strict';

module.exports = [
    {
        "id": "callshape-go-chain-receiver-call",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\ntype Command struct {\n    parent *Command\n    Deep bool\n}\n\nfunc (c *Command) Root() *Command {\n    if c.parent != nil {\n        return c.parent.Root()\n    }\n    return c\n}\n\nfunc (c *Command) Traverse(args []string) (*Command, []string, error) {\n    return c, args, nil\n}\n\nfunc Complete(c *Command, args []string) (*Command, error) {\n    var final *Command\n    var err error\n    if c.Root().Deep {\n        final, _, err = c.Traverse(args)\n    }\n    return final, err\n}\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Command struct {\n    parent *Command\n    Deep bool\n}\n\nfunc (c *Command) Root() *Command {\n    if c.parent != nil {\n        return c.parent.Root()\n    }\n    return c\n}\n\nfunc (c *Command) Traverse(args []string) (*Command, []string, error) {\n    return c, args, nil\n}\n\nfunc Complete(c *Command, args []string) (*Command, error) {\n    var final *Command\n    var err error\n    if c.Root().Deep {\n        final, _, err = c.Root().Traverse(args)\n    }\n    return final, err\n}\n"
        },
        "name": "Complete",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-chain-receiver-call-wrong-count",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\ntype Command struct {\n    parent *Command\n    Deep bool\n}\n\nfunc (c *Command) Root() *Command {\n    if c.parent != nil {\n        return c.parent.Root()\n    }\n    return c\n}\n\nfunc (c *Command) Traverse(args []string) (*Command, []string, error) {\n    return c, args, nil\n}\n\nfunc Complete(c *Command, args []string) (*Command, error) {\n    var final *Command\n    var err error\n    if c.Root().Deep {\n        final, _, err = c.Traverse(args)\n    }\n    return final, err\n}\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Command struct {\n    parent *Command\n    Deep bool\n}\n\nfunc (c *Command) Root() *Command {\n    if c.parent != nil {\n        return c.parent.Root()\n    }\n    return c\n}\n\nfunc (c *Command) Traverse(args []string) (*Command, []string, error) {\n    return c, args, nil\n}\n\nfunc Complete(c *Command, args []string) (*Command, error) {\n    var final *Command\n    var err error\n    if c.Root().Deep {\n        final, _, err = c.Root().Traverse()\n    }\n    return final, err\n}\n"
        },
        "name": "Complete",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Complete:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-go-chain-inner-wrong-count",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\ntype Command struct {\n    parent *Command\n    Deep bool\n}\n\nfunc (c *Command) Root() *Command {\n    if c.parent != nil {\n        return c.parent.Root()\n    }\n    return c\n}\n\nfunc (c *Command) Traverse(args []string) (*Command, []string, error) {\n    return c, args, nil\n}\n\nfunc Complete(c *Command, args []string) (*Command, error) {\n    var final *Command\n    var err error\n    if c.Root().Deep {\n        final, _, err = c.Traverse(args)\n    }\n    return final, err\n}\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Command struct {\n    parent *Command\n    Deep bool\n}\n\nfunc (c *Command) Root() *Command {\n    if c.parent != nil {\n        return c.parent.Root()\n    }\n    return c\n}\n\nfunc (c *Command) Traverse(args []string) (*Command, []string, error) {\n    return c, args, nil\n}\n\nfunc Complete(c *Command, args []string) (*Command, error) {\n    var final *Command\n    var err error\n    if c.Root().Deep {\n        final, _, err = c.Root(args).Traverse(args)\n    }\n    return final, err\n}\n"
        },
        "name": "Complete",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Complete:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-go-conversion-to-named-type",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\"}\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    sort.Sort(byName(out))\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\"}\n}\n"
        },
        "name": "Sorted",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Sorted:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-conversion-two-values",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\"}\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    sort.Sort(byName(out, out))\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\"}\n}\n"
        },
        "name": "Sorted",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Sorted:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-go-conversion-to-alias",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\"}\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\", Label(\"b\"), Join(\"c\", \"d\")}\n}\n"
        },
        "name": "Labels",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Labels:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-function-beside-alias-wrong-count",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\"}\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"sort\"\n\ntype Item struct {\n    Name string\n}\n\ntype byName []*Item\n\nfunc (s byName) Len() int           { return len(s) }\nfunc (s byName) Swap(i, j int)      { s[i], s[j] = s[j], s[i] }\nfunc (s byName) Less(i, j int) bool { return s[i].Name < s[j].Name }\n\ntype Label = string\n\nfunc Join(a string, b string) Label {\n    return a + b\n}\n\nfunc Sorted(items []*Item) []*Item {\n    out := items\n    return out\n}\n\nfunc Names(names []string) []string {\n    sort.Strings(names)\n    return names\n}\n\nfunc Labels() []string {\n    return []string{\"a\", Label(\"b\"), Join(\"c\")}\n}\n"
        },
        "name": "Labels",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Labels:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-go-local-callee-of-method-result",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"io\"\n\ntype Command struct {\n    out io.Writer\n}\n\nfunc (c *Command) render() func(w io.Writer, data interface{}) error {\n    return func(w io.Writer, data interface{}) error {\n        return nil\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc (c *Command) Show() error {\n    return nil\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"io\"\n\ntype Command struct {\n    out io.Writer\n}\n\nfunc (c *Command) render() func(w io.Writer, data interface{}) error {\n    return func(w io.Writer, data interface{}) error {\n        return nil\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc (c *Command) Show() error {\n    fn := c.render()\n    return fn(c.out, c)\n}\n"
        },
        "name": "Show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-package-function-wrong-count",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nimport \"io\"\n\ntype Command struct {\n    out io.Writer\n}\n\nfunc (c *Command) render() func(w io.Writer, data interface{}) error {\n    return func(w io.Writer, data interface{}) error {\n        return nil\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc (c *Command) Show() error {\n    return nil\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nimport \"io\"\n\ntype Command struct {\n    out io.Writer\n}\n\nfunc (c *Command) render() func(w io.Writer, data interface{}) error {\n    return func(w io.Writer, data interface{}) error {\n        return nil\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc (c *Command) Show() error {\n    _ = fn(c.out, c)\n    return nil\n}\n"
        },
        "name": "Show",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Show:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-tuple-variant-construction",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Literal(text)\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-tuple-variant-two-values",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    Strategy::Literal(text, 1)\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "pick:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-tuple-variant-pair",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Pair(text, 1)\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "pick",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "pick:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-tuple-variant-pair-one-value",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    Strategy::Pair(text)\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "pick",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "pick:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-tuple-struct-construction",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    Meters(1.0).0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "far",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "far:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-tuple-struct-two-values",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    Meters(1.0, 2.0).0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "far",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "far:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-builder-chain",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().require_git(false).build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "configured",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "configured:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-builder-chain-wrong-count",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().require_git().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "name": "configured",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "configured:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-function-path-argument-in-chain",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = find(glob, on).map(Hit::of);\n    false\n}\n"
        },
        "name": "hits",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "hits:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-chain-method-wrong-count",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = (glob, on);\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Glob {\n    pub text: String,\n}\n\npub enum Strategy {\n    Literal(String),\n    Pair(String, usize),\n    Regex,\n}\n\npub struct Meters(pub f64);\n\npub struct Hit<'a> {\n    pub glob: &'a Glob,\n}\n\nimpl<'a> Hit<'a> {\n    fn of(glob: &'a Glob) -> Hit<'a> {\n        Hit { glob }\n    }\n}\n\npub enum Found<T> {\n    None,\n    Some(T),\n}\n\nimpl<T> Found<T> {\n    pub fn map<U, F: FnOnce(T) -> U>(self, f: F) -> Found<U> {\n        match self {\n            Found::None => Found::None,\n            Found::Some(t) => Found::Some(f(t)),\n        }\n    }\n}\n\npub struct Builder {\n    git: bool,\n}\n\nimpl Builder {\n    pub fn new() -> Builder {\n        Builder { git: true }\n    }\n\n    pub fn require_git(&mut self, yes: bool) -> &mut Builder {\n        self.git = yes;\n        self\n    }\n\n    pub fn build(&self) -> bool {\n        self.git\n    }\n}\n\npub fn find<'a>(glob: &'a Glob, on: bool) -> Found<&'a Glob> {\n    if on {\n        Found::Some(glob)\n    } else {\n        Found::None\n    }\n}\n\npub fn pick(text: String) -> Strategy {\n    let _ = text;\n    Strategy::Regex\n}\n\npub fn far() -> f64 {\n    1.0\n}\n\npub fn configured() -> bool {\n    Builder::new().build()\n}\n\npub fn hits<'a>(glob: &'a Glob, on: bool) -> bool {\n    let _ = find(glob, on).map(Hit::of, on);\n    false\n}\n"
        },
        "name": "hits",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "hits:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-py-module-function-beside-namesake-methods",
        "lang": "py",
        "base": {
            "compat.py": "import typing as t\n\n\nclass Wrapper:\n    def __init__(self, stream: t.IO[str]) -> None:\n        self.stream = stream\n\n    def isatty(self) -> bool:\n        return self.stream.isatty()\n\n\nclass Other:\n    def isatty(self) -> bool:\n        return False\n\n\ndef isatty(stream: t.IO[str]) -> bool:\n    try:\n        return stream.isatty()\n    except Exception:\n        return False\n",
            "lib.py": "import sys\n\nfrom compat import isatty\n\n\ndef pager(color: bool) -> bool:\n    stdout = sys.stdout\n    if color:\n        return True\n    return False\n"
        },
        "after": {
            "lib.py": "import sys\n\nfrom compat import isatty\n\n\ndef pager(color: bool) -> bool:\n    stdout = sys.stdout\n    if not isatty(sys.stdin) or not isatty(stdout):\n        return False\n    if color:\n        return True\n    return False\n"
        },
        "name": "pager",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "pager:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-py-module-function-wrong-count",
        "lang": "py",
        "base": {
            "compat.py": "import typing as t\n\n\nclass Wrapper:\n    def __init__(self, stream: t.IO[str]) -> None:\n        self.stream = stream\n\n    def isatty(self) -> bool:\n        return self.stream.isatty()\n\n\nclass Other:\n    def isatty(self) -> bool:\n        return False\n\n\ndef isatty(stream: t.IO[str]) -> bool:\n    try:\n        return stream.isatty()\n    except Exception:\n        return False\n",
            "lib.py": "import sys\n\nfrom compat import isatty\n\n\ndef pager(color: bool) -> bool:\n    stdout = sys.stdout\n    if color:\n        return True\n    return False\n"
        },
        "after": {
            "lib.py": "import sys\n\nfrom compat import isatty\n\n\ndef pager(color: bool) -> bool:\n    stdout = sys.stdout\n    if not isatty(sys.stdin, stdout):\n        return False\n    if color:\n        return True\n    return False\n"
        },
        "name": "pager",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "pager:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-ts-variable-typed-callable-optional-parameter",
        "lang": "ts",
        "base": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "after": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? './';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "name": "toSite",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "toSite:modified=review(inferred-return-contract)"
    },
    {
        "id": "callshape-ts-variable-typed-callable-call-added",
        "lang": "ts",
        "base": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "after": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    await toSite('a', 'b');\n    return toSite('a', 'b', { dir: 'c' });\n}\n"
        },
        "name": "run",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-ts-variable-typed-callable-call-wrong-count",
        "lang": "ts",
        "base": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "after": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a');\n}\n"
        },
        "name": "run",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "run:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-ts-variable-typed-callable-fewer-parameters",
        "lang": "ts",
        "base": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "after": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs) => {\n    return app + fs;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "name": "toSite",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "toSite:modified=review(header,inferred-return-contract)"
    },
    {
        "id": "callshape-ts-variable-typed-callable-parameter-added",
        "lang": "ts",
        "base": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "after": {
            "lib.ts": "export interface Options {\n    dir?: string;\n}\n\nexport interface ToSite {\n    (app: string, fs: string, options?: Options): Promise<string>;\n}\n\nexport const toSite: ToSite = async (app, fs, options, extra) => {\n    const dir = options?.dir ?? '.';\n    return app + fs + dir;\n};\n\nexport async function run(): Promise<string> {\n    return toSite('a', 'b');\n}\n"
        },
        "name": "toSite",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "toSite:modified=review(header)"
    },
    {
        "id": "callshape-ts-chain-receiver-call",
        "lang": "ts",
        "base": {
            "lib.ts": "export class Node {\n    parent: Node | null = null;\n    root(): Node {\n        return this.parent ? this.parent.root() : this;\n    }\n    walk(args: string[]): string[] {\n        return args;\n    }\n}\nexport function complete(node: Node, args: string[]): string[] {\n    return node.walk(args);\n}\n"
        },
        "after": {
            "lib.ts": "export class Node {\n    parent: Node | null = null;\n    root(): Node {\n        return this.parent ? this.parent.root() : this;\n    }\n    walk(args: string[]): string[] {\n        return args;\n    }\n}\nexport function complete(node: Node, args: string[]): string[] {\n    return node.root().walk(args);\n}\n"
        },
        "name": "complete",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-ts-chain-receiver-call-wrong-count",
        "lang": "ts",
        "base": {
            "lib.ts": "export class Node {\n    parent: Node | null = null;\n    root(): Node {\n        return this.parent ? this.parent.root() : this;\n    }\n    walk(args: string[]): string[] {\n        return args;\n    }\n}\nexport function complete(node: Node, args: string[]): string[] {\n    return node.walk(args);\n}\n"
        },
        "after": {
            "lib.ts": "export class Node {\n    parent: Node | null = null;\n    root(): Node {\n        return this.parent ? this.parent.root() : this;\n    }\n    walk(args: string[]): string[] {\n        return args;\n    }\n}\nexport function complete(node: Node, args: string[]): string[] {\n    return node.root().walk();\n}\n"
        },
        "name": "complete",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "complete:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-py-chain-receiver-call",
        "lang": "py",
        "base": {
            "lib.py": "class Node:\n    def __init__(self) -> None:\n        self.parent: \"Node | None\" = None\n\n    def root(self) -> \"Node\":\n        return self.parent.root() if self.parent else self\n\n    def walk(self, args: list[str]) -> list[str]:\n        return args\n\n\ndef complete(node: Node, args: list[str]) -> list[str]:\n    return node.walk(args)\n"
        },
        "after": {
            "lib.py": "class Node:\n    def __init__(self) -> None:\n        self.parent: \"Node | None\" = None\n\n    def root(self) -> \"Node\":\n        return self.parent.root() if self.parent else self\n\n    def walk(self, args: list[str]) -> list[str]:\n        return args\n\n\ndef complete(node: Node, args: list[str]) -> list[str]:\n    return node.root().walk(args)\n"
        },
        "name": "complete",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-py-chain-receiver-call-wrong-count",
        "lang": "py",
        "base": {
            "lib.py": "class Node:\n    def __init__(self) -> None:\n        self.parent: \"Node | None\" = None\n\n    def root(self) -> \"Node\":\n        return self.parent.root() if self.parent else self\n\n    def walk(self, args: list[str]) -> list[str]:\n        return args\n\n\ndef complete(node: Node, args: list[str]) -> list[str]:\n    return node.walk(args)\n"
        },
        "after": {
            "lib.py": "class Node:\n    def __init__(self) -> None:\n        self.parent: \"Node | None\" = None\n\n    def root(self) -> \"Node\":\n        return self.parent.root() if self.parent else self\n\n    def walk(self, args: list[str]) -> list[str]:\n        return args\n\n\ndef complete(node: Node, args: list[str]) -> list[str]:\n    return node.root().walk()\n"
        },
        "name": "complete",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "complete:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-java-chain-receiver-call",
        "lang": "java",
        "base": {
            "Demo.java": "import java.util.List;\nclass Node {\n    Node parent;\n    Node root() {\n        return parent != null ? parent.root() : this;\n    }\n    List<String> walk(List<String> args) {\n        return args;\n    }\n}\nclass Demo {\n    static List<String> complete(Node node, List<String> args) {\n        return node.walk(args);\n    }\n}\n"
        },
        "after": {
            "Demo.java": "import java.util.List;\nclass Node {\n    Node parent;\n    Node root() {\n        return parent != null ? parent.root() : this;\n    }\n    List<String> walk(List<String> args) {\n        return args;\n    }\n}\nclass Demo {\n    static List<String> complete(Node node, List<String> args) {\n        return node.root().walk(args);\n    }\n}\n"
        },
        "name": "complete",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-java-chain-receiver-call-wrong-count",
        "lang": "java",
        "base": {
            "Demo.java": "import java.util.List;\nclass Node {\n    Node parent;\n    Node root() {\n        return parent != null ? parent.root() : this;\n    }\n    List<String> walk(List<String> args) {\n        return args;\n    }\n}\nclass Demo {\n    static List<String> complete(Node node, List<String> args) {\n        return node.walk(args);\n    }\n}\n"
        },
        "after": {
            "Demo.java": "import java.util.List;\nclass Node {\n    Node parent;\n    Node root() {\n        return parent != null ? parent.root() : this;\n    }\n    List<String> walk(List<String> args) {\n        return args;\n    }\n}\nclass Demo {\n    static List<String> complete(Node node, List<String> args) {\n        return node.root().walk();\n    }\n}\n"
        },
        "name": "complete",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cs-chain-receiver-call",
        "lang": "cs",
        "base": {
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n",
            "Demo.cs": "using System.Collections.Generic;\npublic class Node {\n    public Node? Parent;\n    public Node Root() {\n        return Parent != null ? Parent.Root() : this;\n    }\n    public List<string> Walk(List<string> args) {\n        return args;\n    }\n}\npublic static class Demo {\n    public static List<string> Complete(Node node, List<string> args) {\n        return node.Walk(args);\n    }\n}\n"
        },
        "after": {
            "Demo.cs": "using System.Collections.Generic;\npublic class Node {\n    public Node? Parent;\n    public Node Root() {\n        return Parent != null ? Parent.Root() : this;\n    }\n    public List<string> Walk(List<string> args) {\n        return args;\n    }\n}\npublic static class Demo {\n    public static List<string> Complete(Node node, List<string> args) {\n        return node.Root().Walk(args);\n    }\n}\n"
        },
        "name": "Complete",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cs-chain-receiver-call-wrong-count",
        "lang": "cs",
        "base": {
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n",
            "Demo.cs": "using System.Collections.Generic;\npublic class Node {\n    public Node? Parent;\n    public Node Root() {\n        return Parent != null ? Parent.Root() : this;\n    }\n    public List<string> Walk(List<string> args) {\n        return args;\n    }\n}\npublic static class Demo {\n    public static List<string> Complete(Node node, List<string> args) {\n        return node.Walk(args);\n    }\n}\n"
        },
        "after": {
            "Demo.cs": "using System.Collections.Generic;\npublic class Node {\n    public Node? Parent;\n    public Node Root() {\n        return Parent != null ? Parent.Root() : this;\n    }\n    public List<string> Walk(List<string> args) {\n        return args;\n    }\n}\npublic static class Demo {\n    public static List<string> Complete(Node node, List<string> args) {\n        return node.Root().Walk();\n    }\n}\n"
        },
        "name": "Complete",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "Complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cpp-chain-receiver-call",
        "lang": "cpp",
        "base": {
            "main.cpp": "struct Node {\n    Node* parent = nullptr;\n    Node& root() { return parent ? parent->root() : *this; }\n    int walk(int args) { return args; }\n};\nint complete(Node& node, int args) {\n    return node.walk(args);\n}\nint main() { Node n; return complete(n, 0); }\n"
        },
        "after": {
            "main.cpp": "struct Node {\n    Node* parent = nullptr;\n    Node& root() { return parent ? parent->root() : *this; }\n    int walk(int args) { return args; }\n};\nint complete(Node& node, int args) {\n    return node.root().walk(args);\n}\nint main() { Node n; return complete(n, 0); }\n"
        },
        "name": "complete",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "complete:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cpp-chain-receiver-call-wrong-count",
        "lang": "cpp",
        "base": {
            "main.cpp": "struct Node {\n    Node* parent = nullptr;\n    Node& root() { return parent ? parent->root() : *this; }\n    int walk(int args) { return args; }\n};\nint complete(Node& node, int args) {\n    return node.walk(args);\n}\nint main() { Node n; return complete(n, 0); }\n"
        },
        "after": {
            "main.cpp": "struct Node {\n    Node* parent = nullptr;\n    Node& root() { return parent ? parent->root() : *this; }\n    int walk(int args) { return args; }\n};\nint complete(Node& node, int args) {\n    return node.root().walk();\n}\nint main() { Node n; return complete(n, 0); }\n"
        },
        "name": "complete",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "complete:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-ts-module-function-beside-namesake-methods",
        "lang": "ts",
        "base": {
            "compat.ts": "export class Wrapper {\n    isatty(): boolean {\n        return true;\n    }\n}\nexport class Other {\n    isatty(): boolean {\n        return false;\n    }\n}\nexport function isatty(stream: { fd: number }): boolean {\n    return stream.fd >= 0;\n}\n",
            "lib.ts": "import { isatty } from './compat';\nexport function pager(color: boolean): boolean {\n    if (color) {\n        return true;\n    }\n    return false;\n}\n"
        },
        "after": {
            "lib.ts": "import { isatty } from './compat';\nexport function pager(color: boolean): boolean {\n    if (!isatty({ fd: 0 })) {\n        return false;\n    }\n    if (color) {\n        return true;\n    }\n    return false;\n}\n"
        },
        "name": "pager",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "pager:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-ts-module-function-wrong-count",
        "lang": "ts",
        "base": {
            "compat.ts": "export class Wrapper {\n    isatty(): boolean {\n        return true;\n    }\n}\nexport class Other {\n    isatty(): boolean {\n        return false;\n    }\n}\nexport function isatty(stream: { fd: number }): boolean {\n    return stream.fd >= 0;\n}\n",
            "lib.ts": "import { isatty } from './compat';\nexport function pager(color: boolean): boolean {\n    if (color) {\n        return true;\n    }\n    return false;\n}\n"
        },
        "after": {
            "lib.ts": "import { isatty } from './compat';\nexport function pager(color: boolean): boolean {\n    if (!isatty({ fd: 0 }, 1)) {\n        return false;\n    }\n    if (color) {\n        return true;\n    }\n    return false;\n}\n"
        },
        "name": "pager",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "pager:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-function-beside-namesake-methods",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Wrapper;\n\nimpl Wrapper {\n    pub fn isatty(&self) -> bool {\n        true\n    }\n}\n\npub struct Other;\n\nimpl Other {\n    pub fn isatty(&self) -> bool {\n        false\n    }\n}\n\npub fn isatty(fd: i32) -> bool {\n    fd >= 0\n}\n\npub fn pager(color: bool) -> bool {\n    if color {\n        return true;\n    }\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Wrapper;\n\nimpl Wrapper {\n    pub fn isatty(&self) -> bool {\n        true\n    }\n}\n\npub struct Other;\n\nimpl Other {\n    pub fn isatty(&self) -> bool {\n        false\n    }\n}\n\npub fn isatty(fd: i32) -> bool {\n    fd >= 0\n}\n\npub fn pager(color: bool) -> bool {\n    if !isatty(0) {\n        return false;\n    }\n    if color {\n        return true;\n    }\n    false\n}\n"
        },
        "name": "pager",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "pager:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-function-beside-namesake-methods-wrong-count",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Wrapper;\n\nimpl Wrapper {\n    pub fn isatty(&self) -> bool {\n        true\n    }\n}\n\npub struct Other;\n\nimpl Other {\n    pub fn isatty(&self) -> bool {\n        false\n    }\n}\n\npub fn isatty(fd: i32) -> bool {\n    fd >= 0\n}\n\npub fn pager(color: bool) -> bool {\n    if color {\n        return true;\n    }\n    false\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Wrapper;\n\nimpl Wrapper {\n    pub fn isatty(&self) -> bool {\n        true\n    }\n}\n\npub struct Other;\n\nimpl Other {\n    pub fn isatty(&self) -> bool {\n        false\n    }\n}\n\npub fn isatty(fd: i32) -> bool {\n    fd >= 0\n}\n\npub fn pager(color: bool) -> bool {\n    if !isatty(0, 1) {\n        return false;\n    }\n    if color {\n        return true;\n    }\n    false\n}\n"
        },
        "name": "pager",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "pager:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-go-function-beside-namesake-methods",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\ntype Wrapper struct{}\n\nfunc (w Wrapper) isatty() bool {\n    return true\n}\n\ntype Other struct{}\n\nfunc (o Other) isatty() bool {\n    return false\n}\n\nfunc isatty(fd int) bool {\n    return fd >= 0\n}\n\nfunc Pager(color bool) bool {\n    if color {\n        return true\n    }\n    return false\n}\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Wrapper struct{}\n\nfunc (w Wrapper) isatty() bool {\n    return true\n}\n\ntype Other struct{}\n\nfunc (o Other) isatty() bool {\n    return false\n}\n\nfunc isatty(fd int) bool {\n    return fd >= 0\n}\n\nfunc Pager(color bool) bool {\n    if !isatty(0) {\n        return false\n    }\n    if color {\n        return true\n    }\n    return false\n}\n"
        },
        "name": "Pager",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Pager:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-function-beside-namesake-methods-wrong-count",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\ntype Wrapper struct{}\n\nfunc (w Wrapper) isatty() bool {\n    return true\n}\n\ntype Other struct{}\n\nfunc (o Other) isatty() bool {\n    return false\n}\n\nfunc isatty(fd int) bool {\n    return fd >= 0\n}\n\nfunc Pager(color bool) bool {\n    if color {\n        return true\n    }\n    return false\n}\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Wrapper struct{}\n\nfunc (w Wrapper) isatty() bool {\n    return true\n}\n\ntype Other struct{}\n\nfunc (o Other) isatty() bool {\n    return false\n}\n\nfunc isatty(fd int) bool {\n    return fd >= 0\n}\n\nfunc Pager(color bool) bool {\n    if !isatty(0, 1) {\n        return false\n    }\n    if color {\n        return true\n    }\n    return false\n}\n"
        },
        "name": "Pager",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Pager:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-cpp-functional-cast-to-alias",
        "lang": "cpp",
        "base": {
            "main.cpp": "typedef double Meters;\nenum Color { Red, Green };\ndouble far() {\n    return 1.0;\n}\nint shade() {\n    return 0;\n}\nint main() { return (int)far() + shade() - 1; }\n"
        },
        "after": {
            "main.cpp": "typedef double Meters;\nenum Color { Red, Green };\ndouble far() {\n    return Meters(1.0);\n}\nint shade() {\n    return 0;\n}\nint main() { return (int)far() + shade() - 1; }\n"
        },
        "name": "far",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "far:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cpp-functional-cast-to-enum",
        "lang": "cpp",
        "base": {
            "main.cpp": "typedef double Meters;\nenum Color { Red, Green };\ndouble far() {\n    return 1.0;\n}\nint shade() {\n    return 0;\n}\nint main() { return (int)far() + shade() - 1; }\n"
        },
        "after": {
            "main.cpp": "typedef double Meters;\nenum Color { Red, Green };\ndouble far() {\n    return 1.0;\n}\nint shade() {\n    return Color(1) == Green ? 0 : 1;\n}\nint main() { return (int)far() + shade() - 1; }\n"
        },
        "name": "shade",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "shade:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cpp-functional-cast-to-enum-two-values",
        "lang": "cpp",
        "base": {
            "main.cpp": "typedef double Meters;\nenum Color { Red, Green };\ndouble far() {\n    return 1.0;\n}\nint shade() {\n    return 0;\n}\nint main() { return (int)far() + shade() - 1; }\n"
        },
        "after": {
            "main.cpp": "typedef double Meters;\nenum Color { Red, Green };\ndouble far() {\n    return 1.0;\n}\nint shade() {\n    return Color(1, 2) == Green ? 0 : 1;\n}\nint main() { return (int)far() + shade() - 1; }\n"
        },
        "name": "shade",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "shade:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-java-anonymous-interface",
        "lang": "java",
        "base": {
            "Demo.java": "interface Shape {\n    int area();\n}\nclass Demo {\n    static int size() {\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "interface Shape {\n    int area();\n}\nclass Demo {\n    static int size() {\n        Shape s = new Shape() {\n            public int area() {\n                return 1;\n            }\n        };\n        return s.area();\n    }\n}\n"
        },
        "name": "size",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "size:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cs-delegate-construction",
        "lang": "cs",
        "base": {
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n",
            "Demo.cs": "public delegate int Op(int a);\npublic static class Demo {\n    public static int Twice(int a) {\n        return a * 2;\n    }\n    public static int Run() {\n        return 1;\n    }\n}\n"
        },
        "after": {
            "Demo.cs": "public delegate int Op(int a);\npublic static class Demo {\n    public static int Twice(int a) {\n        return a * 2;\n    }\n    public static int Run() {\n        Op op = new Op(Twice);\n        return op(1);\n    }\n}\n"
        },
        "name": "Run",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-py-alias-of-class",
        "lang": "py",
        "base": {
            "lib.py": "from typing import NewType\n\nUserId = NewType(\"UserId\", int)\n\n\nclass Wrapper:\n    def __init__(self, value: int) -> None:\n        self.value = value\n\n\nAlias = Wrapper\n\n\ndef make() -> int:\n    return 1\n\n\ndef user() -> int:\n    return 1\n"
        },
        "after": {
            "lib.py": "from typing import NewType\n\nUserId = NewType(\"UserId\", int)\n\n\nclass Wrapper:\n    def __init__(self, value: int) -> None:\n        self.value = value\n\n\nAlias = Wrapper\n\n\ndef make() -> int:\n    return Alias(1).value\n\n\ndef user() -> int:\n    return 1\n"
        },
        "name": "make",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "make:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-py-newtype",
        "lang": "py",
        "base": {
            "lib.py": "from typing import NewType\n\nUserId = NewType(\"UserId\", int)\n\n\nclass Wrapper:\n    def __init__(self, value: int) -> None:\n        self.value = value\n\n\nAlias = Wrapper\n\n\ndef make() -> int:\n    return 1\n\n\ndef user() -> int:\n    return 1\n"
        },
        "after": {
            "lib.py": "from typing import NewType\n\nUserId = NewType(\"UserId\", int)\n\n\nclass Wrapper:\n    def __init__(self, value: int) -> None:\n        self.value = value\n\n\nAlias = Wrapper\n\n\ndef make() -> int:\n    return 1\n\n\ndef user() -> int:\n    return UserId(1)\n"
        },
        "name": "user",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "user:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-function-typed-field",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\ntype Command struct {\n    handler func(a int) int\n}\n\nfunc (c *Command) Run() int {\n    return 1\n}\n"
        },
        "after": {
            "main.go": "package probe\n\ntype Command struct {\n    handler func(a int) int\n}\n\nfunc (c *Command) Run() int {\n    return c.handler(1)\n}\n"
        },
        "name": "Run",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-function-typed-field",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Command {\n    pub handler: fn(i32) -> i32,\n}\n\nimpl Command {\n    pub fn run(&self) -> i32 {\n        1\n    }\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Command {\n    pub handler: fn(i32) -> i32,\n}\n\nimpl Command {\n    pub fn run(&self) -> i32 {\n        (self.handler)(1)\n    }\n}\n"
        },
        "name": "run",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "run:modified=ready"
    },
    {
        "id": "callshape-ts-function-typed-field",
        "lang": "ts",
        "base": {
            "lib.ts": "export class Command {\n    handler: (a: number) => number = (a) => a;\n    run(): number {\n        return 1;\n    }\n}\n"
        },
        "after": {
            "lib.ts": "export class Command {\n    handler: (a: number) => number = (a) => a;\n    run(): number {\n        return this.handler(1);\n    }\n}\n"
        },
        "name": "run",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "run:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-local-callee-from-call",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc render() func(a int, b int) int {\n    return func(a int, b int) int {\n        return a + b\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc Show() int {\n    return fn()\n}\n\nfunc Var() int {\n    return 0\n}\n\nfunc Param(fn func(a int, b int) int) int {\n    return 0\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc render() func(a int, b int) int {\n    return func(a int, b int) int {\n        return a + b\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc Show() int {\n    fn := render()\n    return fn(1, 2)\n}\n\nfunc Var() int {\n    return 0\n}\n\nfunc Param(fn func(a int, b int) int) int {\n    return 0\n}\n"
        },
        "name": "Show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-local-callee-declared",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc render() func(a int, b int) int {\n    return func(a int, b int) int {\n        return a + b\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc Show() int {\n    return fn()\n}\n\nfunc Var() int {\n    return 0\n}\n\nfunc Param(fn func(a int, b int) int) int {\n    return 0\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc render() func(a int, b int) int {\n    return func(a int, b int) int {\n        return a + b\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc Show() int {\n    return fn()\n}\n\nfunc Var() int {\n    var fn func(a int, b int) int = render()\n    return fn(1, 2)\n}\n\nfunc Param(fn func(a int, b int) int) int {\n    return 0\n}\n"
        },
        "name": "Var",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Var:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-parameter-callee",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc render() func(a int, b int) int {\n    return func(a int, b int) int {\n        return a + b\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc Show() int {\n    return fn()\n}\n\nfunc Var() int {\n    return 0\n}\n\nfunc Param(fn func(a int, b int) int) int {\n    return 0\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc render() func(a int, b int) int {\n    return func(a int, b int) int {\n        return a + b\n    }\n}\n\nfunc fn() int {\n    return 1\n}\n\nfunc Show() int {\n    return fn()\n}\n\nfunc Var() int {\n    return 0\n}\n\nfunc Param(fn func(a int, b int) int) int {\n    return fn(1, 2)\n}\n"
        },
        "name": "Param",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "Param:modified=ready"
    },
    {
        "id": "callshape-rs-local-callee-from-call",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn render() -> fn(i32, i32) -> i32 {\n    fn add(a: i32, b: i32) -> i32 {\n        a + b\n    }\n    add\n}\n\npub fn run() -> i32 {\n    1\n}\n\npub fn show() -> i32 {\n    run()\n}\n\npub fn param(run: fn(i32, i32) -> i32) -> i32 {\n    let _ = run;\n    0\n}\n"
        },
        "after": {
            "lib.rs": "pub fn render() -> fn(i32, i32) -> i32 {\n    fn add(a: i32, b: i32) -> i32 {\n        a + b\n    }\n    add\n}\n\npub fn run() -> i32 {\n    1\n}\n\npub fn show() -> i32 {\n    let run = render();\n    run(1, 2)\n}\n\npub fn param(run: fn(i32, i32) -> i32) -> i32 {\n    let _ = run;\n    0\n}\n"
        },
        "name": "show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-parameter-callee",
        "lang": "rs",
        "base": {
            "lib.rs": "pub fn render() -> fn(i32, i32) -> i32 {\n    fn add(a: i32, b: i32) -> i32 {\n        a + b\n    }\n    add\n}\n\npub fn run() -> i32 {\n    1\n}\n\npub fn show() -> i32 {\n    run()\n}\n\npub fn param(run: fn(i32, i32) -> i32) -> i32 {\n    let _ = run;\n    0\n}\n"
        },
        "after": {
            "lib.rs": "pub fn render() -> fn(i32, i32) -> i32 {\n    fn add(a: i32, b: i32) -> i32 {\n        a + b\n    }\n    add\n}\n\npub fn run() -> i32 {\n    1\n}\n\npub fn show() -> i32 {\n    run()\n}\n\npub fn param(run: fn(i32, i32) -> i32) -> i32 {\n    run(1, 2)\n}\n"
        },
        "name": "param",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "param:modified=ready"
    },
    {
        "id": "callshape-py-local-callee-from-call",
        "lang": "py",
        "base": {
            "lib.py": "from typing import Callable\n\n\ndef render() -> Callable[[int, int], int]:\n    def add(a: int, b: int) -> int:\n        return a + b\n    return add\n\n\ndef run() -> int:\n    return 1\n\n\ndef show() -> int:\n    return run()\n\n\ndef param(run: Callable[[int, int], int]) -> int:\n    return 0\n"
        },
        "after": {
            "lib.py": "from typing import Callable\n\n\ndef render() -> Callable[[int, int], int]:\n    def add(a: int, b: int) -> int:\n        return a + b\n    return add\n\n\ndef run() -> int:\n    return 1\n\n\ndef show() -> int:\n    run = render()\n    return run(1, 2)\n\n\ndef param(run: Callable[[int, int], int]) -> int:\n    return 0\n"
        },
        "name": "show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-py-parameter-callee",
        "lang": "py",
        "base": {
            "lib.py": "from typing import Callable\n\n\ndef render() -> Callable[[int, int], int]:\n    def add(a: int, b: int) -> int:\n        return a + b\n    return add\n\n\ndef run() -> int:\n    return 1\n\n\ndef show() -> int:\n    return run()\n\n\ndef param(run: Callable[[int, int], int]) -> int:\n    return 0\n"
        },
        "after": {
            "lib.py": "from typing import Callable\n\n\ndef render() -> Callable[[int, int], int]:\n    def add(a: int, b: int) -> int:\n        return a + b\n    return add\n\n\ndef run() -> int:\n    return 1\n\n\ndef show() -> int:\n    return run()\n\n\ndef param(run: Callable[[int, int], int]) -> int:\n    return run(1, 2)\n"
        },
        "name": "param",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "param:modified=ready"
    },
    {
        "id": "callshape-ts-local-callee-from-call",
        "lang": "ts",
        "base": {
            "lib.ts": "export function render(): (a: number, b: number) => number {\n    return (a, b) => a + b;\n}\nexport function run(): number {\n    return 1;\n}\nexport function show(): number {\n    return run();\n}\nexport function param(run: (a: number, b: number) => number): number {\n    return 0;\n}\n"
        },
        "after": {
            "lib.ts": "export function render(): (a: number, b: number) => number {\n    return (a, b) => a + b;\n}\nexport function run(): number {\n    return 1;\n}\nexport function show(): number {\n    const run = render();\n    return run(1, 2);\n}\nexport function param(run: (a: number, b: number) => number): number {\n    return 0;\n}\n"
        },
        "name": "show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-ts-parameter-callee",
        "lang": "ts",
        "base": {
            "lib.ts": "export function render(): (a: number, b: number) => number {\n    return (a, b) => a + b;\n}\nexport function run(): number {\n    return 1;\n}\nexport function show(): number {\n    return run();\n}\nexport function param(run: (a: number, b: number) => number): number {\n    return 0;\n}\n"
        },
        "after": {
            "lib.ts": "export function render(): (a: number, b: number) => number {\n    return (a, b) => a + b;\n}\nexport function run(): number {\n    return 1;\n}\nexport function show(): number {\n    return run();\n}\nexport function param(run: (a: number, b: number) => number): number {\n    return run(1, 2);\n}\n"
        },
        "name": "param",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "param:modified=ready"
    },
    {
        "id": "callshape-cs-local-callee-from-call",
        "lang": "cs",
        "base": {
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n",
            "Demo.cs": "using System;\npublic static class Demo {\n    public static Func<int, int, int> Render() {\n        return (a, b) => a + b;\n    }\n    public static int run() {\n        return 1;\n    }\n    public static int Show() {\n        return run();\n    }\n    public static int Param(Func<int, int, int> run) {\n        return 0;\n    }\n}\n"
        },
        "after": {
            "Demo.cs": "using System;\npublic static class Demo {\n    public static Func<int, int, int> Render() {\n        return (a, b) => a + b;\n    }\n    public static int run() {\n        return 1;\n    }\n    public static int Show() {\n        var run = Render();\n        return run(1, 2);\n    }\n    public static int Param(Func<int, int, int> run) {\n        return 0;\n    }\n}\n"
        },
        "name": "Show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cs-parameter-callee",
        "lang": "cs",
        "base": {
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n",
            "Demo.cs": "using System;\npublic static class Demo {\n    public static Func<int, int, int> Render() {\n        return (a, b) => a + b;\n    }\n    public static int run() {\n        return 1;\n    }\n    public static int Show() {\n        return run();\n    }\n    public static int Param(Func<int, int, int> run) {\n        return 0;\n    }\n}\n"
        },
        "after": {
            "Demo.cs": "using System;\npublic static class Demo {\n    public static Func<int, int, int> Render() {\n        return (a, b) => a + b;\n    }\n    public static int run() {\n        return 1;\n    }\n    public static int Show() {\n        return run();\n    }\n    public static int Param(Func<int, int, int> run) {\n        return run(1, 2);\n    }\n}\n"
        },
        "name": "Param",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "Param:modified=ready"
    },
    {
        "id": "callshape-cpp-local-callee-from-call",
        "lang": "cpp",
        "base": {
            "main.cpp": "typedef int (*adder)(int, int);\nstatic int add(int a, int b) { return a + b; }\nadder render() { return add; }\nint run() { return 1; }\nint show() {\n    return run();\n}\nint param(adder run) {\n    return 0;\n}\nint main() { return show() + param(add) - 1; }\n"
        },
        "after": {
            "main.cpp": "typedef int (*adder)(int, int);\nstatic int add(int a, int b) { return a + b; }\nadder render() { return add; }\nint run() { return 1; }\nint show() {\n    adder run = render();\n    return run(1, 2) - 2;\n}\nint param(adder run) {\n    return 0;\n}\nint main() { return show() + param(add) - 1; }\n"
        },
        "name": "show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cpp-parameter-callee",
        "lang": "cpp",
        "base": {
            "main.cpp": "typedef int (*adder)(int, int);\nstatic int add(int a, int b) { return a + b; }\nadder render() { return add; }\nint run() { return 1; }\nint show() {\n    return run();\n}\nint param(adder run) {\n    return 0;\n}\nint main() { return show() + param(add) - 1; }\n"
        },
        "after": {
            "main.cpp": "typedef int (*adder)(int, int);\nstatic int add(int a, int b) { return a + b; }\nadder render() { return add; }\nint run() { return 1; }\nint show() {\n    return run();\n}\nint param(adder run) {\n    return run(0, 0);\n}\nint main() { return show() + param(add) - 1; }\n"
        },
        "name": "param",
        "expect": "clean",
        "answer": "READY_FOR_TOOLCHAIN",
        "detail": "param:modified=ready"
    },
    {
        "id": "callshape-java-local-lambda-beside-method",
        "lang": "java",
        "base": {
            "Demo.java": "import java.util.function.IntBinaryOperator;\nclass Demo {\n    static IntBinaryOperator render() {\n        return (a, b) -> a + b;\n    }\n    static int run() {\n        return 1;\n    }\n    static int show() {\n        return run();\n    }\n}\n"
        },
        "after": {
            "Demo.java": "import java.util.function.IntBinaryOperator;\nclass Demo {\n    static IntBinaryOperator render() {\n        return (a, b) -> a + b;\n    }\n    static int run() {\n        return 1;\n    }\n    static int show() {\n        IntBinaryOperator run = render();\n        return run.applyAsInt(1, 2);\n    }\n}\n"
        },
        "name": "show",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "show:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-two-calls-of-a-name-on-a-line",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return 0\n}\n\nfunc Boxes() int {\n    return 0\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return add(one(1), one(2)) + add(1, add(2, 3))\n}\n\nfunc Boxes() int {\n    return 0\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "name": "Sum",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Sum:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-two-calls-on-a-line-second-wrong-count",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return 0\n}\n\nfunc Boxes() int {\n    return 0\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return add(1, 2) + add(1)\n}\n\nfunc Boxes() int {\n    return 0\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "name": "Sum",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Sum:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-go-same-name-twice-in-a-chain",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return 0\n}\n\nfunc Boxes() int {\n    return 0\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return 0\n}\n\nfunc Boxes() int {\n    return Box{}.With(1).With(2).n\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "name": "Boxes",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Boxes:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-go-same-name-twice-in-a-chain-second-wrong-count",
        "lang": "go",
        "base": {
            "go.mod": "module example.invalid/probe\n\ngo 1.20\n",
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return 0\n}\n\nfunc Boxes() int {\n    return 0\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "after": {
            "main.go": "package probe\n\nfunc add(a int, b int) int {\n    return a + b\n}\n\nfunc one(a int) int {\n    return a\n}\n\nfunc Map[T any](items []T, f func(T) T) []T {\n    return items\n}\n\ntype Box struct {\n    n int\n}\n\nfunc (b Box) With(n int) Box {\n    return Box{n: n}\n}\n\nfunc Sum() int {\n    return 0\n}\n\nfunc Boxes() int {\n    return Box{}.With(1).With().n\n}\n\nfunc Gen() int {\n    return 0\n}\n"
        },
        "name": "Boxes",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Boxes:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-two-calls-of-a-name-on-a-line",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Meters(pub f64);\n\nimpl Meters {\n    pub fn zero() -> Self {\n        Meters(0.0)\n    }\n\n    pub fn with(self, value: f64) -> Self {\n        let _ = value;\n        self\n    }\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn one(a: i32) -> i32 {\n    a\n}\n\npub fn sum() -> i32 {\n    0\n}\n\npub fn far() -> f64 {\n    0.0\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Meters(pub f64);\n\nimpl Meters {\n    pub fn zero() -> Self {\n        Meters(0.0)\n    }\n\n    pub fn with(self, value: f64) -> Self {\n        let _ = value;\n        self\n    }\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn one(a: i32) -> i32 {\n    a\n}\n\npub fn sum() -> i32 {\n    add(one(1), one(2)) + add(1, add(2, 3))\n}\n\npub fn far() -> f64 {\n    0.0\n}\n"
        },
        "name": "sum",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "sum:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-rs-two-calls-on-a-line-second-wrong-count",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Meters(pub f64);\n\nimpl Meters {\n    pub fn zero() -> Self {\n        Meters(0.0)\n    }\n\n    pub fn with(self, value: f64) -> Self {\n        let _ = value;\n        self\n    }\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn one(a: i32) -> i32 {\n    a\n}\n\npub fn sum() -> i32 {\n    0\n}\n\npub fn far() -> f64 {\n    0.0\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Meters(pub f64);\n\nimpl Meters {\n    pub fn zero() -> Self {\n        Meters(0.0)\n    }\n\n    pub fn with(self, value: f64) -> Self {\n        let _ = value;\n        self\n    }\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn one(a: i32) -> i32 {\n    a\n}\n\npub fn sum() -> i32 {\n    add(1, 2) + add(1)\n}\n\npub fn far() -> f64 {\n    0.0\n}\n"
        },
        "name": "sum",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "sum:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-rs-self-tuple-constructor-chain",
        "lang": "rs",
        "base": {
            "lib.rs": "pub struct Meters(pub f64);\n\nimpl Meters {\n    pub fn zero() -> Self {\n        Meters(0.0)\n    }\n\n    pub fn with(self, value: f64) -> Self {\n        let _ = value;\n        self\n    }\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn one(a: i32) -> i32 {\n    a\n}\n\npub fn sum() -> i32 {\n    0\n}\n\npub fn far() -> f64 {\n    0.0\n}\n"
        },
        "after": {
            "lib.rs": "pub struct Meters(pub f64);\n\nimpl Meters {\n    pub fn zero() -> Self {\n        Meters(0.0)\n    }\n\n    pub fn with(self, value: f64) -> Self {\n        let _ = value;\n        self\n    }\n}\n\npub fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n\npub fn one(a: i32) -> i32 {\n    a\n}\n\npub fn sum() -> i32 {\n    0\n}\n\npub fn far() -> f64 {\n    Meters::zero().with(1.0).with(2.0).0\n}\n"
        },
        "name": "far",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "far:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-ts-two-calls-of-a-name-on-a-line",
        "lang": "ts",
        "base": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return 0;\n}\nexport function boxes(): number {\n    return 0;\n}\n"
        },
        "after": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return add(one(1), one(2)) + add(1, add(2, 3));\n}\nexport function boxes(): number {\n    return 0;\n}\n"
        },
        "name": "sum",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "sum:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-ts-two-calls-on-a-line-second-wrong-count",
        "lang": "ts",
        "base": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return 0;\n}\nexport function boxes(): number {\n    return 0;\n}\n"
        },
        "after": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return add(1, 2) + add(1);\n}\nexport function boxes(): number {\n    return 0;\n}\n"
        },
        "name": "sum",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "sum:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-ts-same-name-twice-in-a-chain",
        "lang": "ts",
        "base": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return 0;\n}\nexport function boxes(): number {\n    return 0;\n}\n"
        },
        "after": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return 0;\n}\nexport function boxes(): number {\n    return new Box().with(1).with(2).n;\n}\n"
        },
        "name": "boxes",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "boxes:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-ts-same-name-twice-in-a-chain-second-wrong-count",
        "lang": "ts",
        "base": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return 0;\n}\nexport function boxes(): number {\n    return 0;\n}\n"
        },
        "after": {
            "lib.ts": "export function add(a: number, b: number): number {\n    return a + b;\n}\nexport function one(a: number): number {\n    return a;\n}\nexport class Box {\n    n = 0;\n    with(n: number): Box {\n        this.n = n;\n        return this;\n    }\n}\nexport function sum(): number {\n    return 0;\n}\nexport function boxes(): number {\n    return new Box().with(1).with().n;\n}\n"
        },
        "name": "boxes",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "boxes:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-java-record-construction",
        "lang": "java",
        "base": {
            "Demo.java": "record Point(int x, int y) {}\nclass Demo {\n    static int add(int a, int b) {\n        return a + b;\n    }\n    static int one(int a) {\n        return a;\n    }\n    static int sum() {\n        return 0;\n    }\n    static int origin() {\n        return 0;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "record Point(int x, int y) {}\nclass Demo {\n    static int add(int a, int b) {\n        return a + b;\n    }\n    static int one(int a) {\n        return a;\n    }\n    static int sum() {\n        return 0;\n    }\n    static int origin() {\n        return new Point(1, 2).x();\n    }\n}\n"
        },
        "name": "origin",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "origin:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cs-record-construction",
        "lang": "cs",
        "base": {
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n",
            "Demo.cs": "public record Point(int X, int Y);\npublic static class Demo {\n    public static int Add(int a, int b) {\n        return a + b;\n    }\n    public static int One(int a) {\n        return a;\n    }\n    public static int Sum() {\n        return 0;\n    }\n    public static int Origin() {\n        return 0;\n    }\n}\n"
        },
        "after": {
            "Demo.cs": "public record Point(int X, int Y);\npublic static class Demo {\n    public static int Add(int a, int b) {\n        return a + b;\n    }\n    public static int One(int a) {\n        return a;\n    }\n    public static int Sum() {\n        return 0;\n    }\n    public static int Origin() {\n        return new Point(1, 2).X;\n    }\n}\n"
        },
        "name": "Origin",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "Origin:modified=review(outgoing-call-unverified)"
    },
    {
        "id": "callshape-cs-record-construction-wrong-count",
        "lang": "cs",
        "base": {
            "Demo.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"><PropertyGroup><TargetFramework>net9.0</TargetFramework></PropertyGroup></Project>\n",
            "NuGet.Config": "<configuration><packageSources><clear /></packageSources></configuration>\n",
            "Demo.cs": "public record Point(int X, int Y);\npublic static class Demo {\n    public static int Add(int a, int b) {\n        return a + b;\n    }\n    public static int One(int a) {\n        return a;\n    }\n    public static int Sum() {\n        return 0;\n    }\n    public static int Origin() {\n        return 0;\n    }\n}\n"
        },
        "after": {
            "Demo.cs": "public record Point(int X, int Y);\npublic static class Demo {\n    public static int Add(int a, int b) {\n        return a + b;\n    }\n    public static int One(int a) {\n        return a;\n    }\n    public static int Sum() {\n        return 0;\n    }\n    public static int Origin() {\n        return new Point(1).X;\n    }\n}\n"
        },
        "name": "Origin",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "Origin:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-java-record-construction-wrong-count",
        "lang": "java",
        "base": {
            "Demo.java": "record Point(int x, int y) {}\nclass Demo {\n    static int add(int a, int b) {\n        return a + b;\n    }\n    static int one(int a) {\n        return a;\n    }\n    static int sum() {\n        return 0;\n    }\n    static int origin() {\n        return 0;\n    }\n}\n"
        },
        "after": {
            "Demo.java": "record Point(int x, int y) {}\nclass Demo {\n    static int add(int a, int b) {\n        return a + b;\n    }\n    static int one(int a) {\n        return a;\n    }\n    static int sum() {\n        return 0;\n    }\n    static int origin() {\n        return new Point(1).x();\n    }\n}\n"
        },
        "name": "origin",
        "expect": "break",
        "answer": "BLOCKED",
        "detail": "origin:modified=blocked(outgoing-signature-mismatch)"
    },
    {
        "id": "callshape-ts-member-assigned-beside-namespace-export",
        "lang": "ts",
        "base": {
            "core/parse.ts": "function makeParse() {\n  return (schema: unknown, data: unknown, params?: unknown, options?: unknown) => data;\n}\n\nexport const parse = makeParse();\n",
            "core/schemas.ts": "export interface Internals {\n  parse: (payload: unknown, ctx: unknown) => unknown;\n}\n\nexport function init(inst: { _zod: Internals }): void {\n  inst._zod.parse = (payload, _ctx) => {\n    return payload;\n  };\n}\n\nexport function runOne(inst: { _zod: Internals }): unknown {\n  return inst._zod.parse(1, {});\n}\n",
            "core/index.ts": "export * from \"./parse\";\nexport * from \"./schemas\";\n",
            "mini/parse.ts": "export { parse } from \"../core/index\";\n",
            "mini/schemas.ts": "import * as parse from \"./parse\";\n\nexport function run(data: unknown): unknown {\n  return parse.parse(null, data, undefined, { callee: run });\n}\n",
            "app.ts": "import * as z from \"./core/index\";\n\nexport const value = z.parse(1, 2);\n"
        },
        "after": {
            "core/schemas.ts": "export interface Internals {\n  parse: (payload: unknown, ctx: unknown) => unknown;\n}\n\nexport function init(inst: { _zod: Internals }): void {\n  inst._zod.parse = (payload) => {\n    return payload;\n  };\n}\n\nexport function runOne(inst: { _zod: Internals }): unknown {\n  return inst._zod.parse(1, {});\n}\n"
        },
        "name": "parse",
        "expect": "clean",
        "answer": "REVIEW_REQUIRED",
        "detail": "parse:modified=review(header)"
    },
    {
        "id": "callshape-ts-member-assigned-own-receiver-wrong-count",
        "lang": "ts",
        "base": {
            "core/parse.ts": "function makeParse() {\n  return (schema: unknown, data: unknown, params?: unknown, options?: unknown) => data;\n}\n\nexport const parse = makeParse();\n",
            "core/schemas.ts": "export interface Internals {\n  parse: (payload: unknown, ctx: unknown) => unknown;\n}\n\nexport function init(inst: { _zod: Internals }): void {\n  inst._zod.parse = (payload, _ctx) => {\n    return payload;\n  };\n}\n\nexport function runOne(inst: { _zod: Internals }): unknown {\n  return inst._zod.parse(1, {});\n}\n",
            "core/index.ts": "export * from \"./parse\";\nexport * from \"./schemas\";\n",
            "mini/parse.ts": "export { parse } from \"../core/index\";\n",
            "mini/schemas.ts": "import * as parse from \"./parse\";\n\nexport function run(data: unknown): unknown {\n  return parse.parse(null, data, undefined, { callee: run });\n}\n",
            "app.ts": "import * as z from \"./core/index\";\n\nexport const value = z.parse(1, 2);\n"
        },
        "after": {
            "core/schemas.ts": "export interface Internals {\n  parse: (payload: unknown, ctx: unknown, extra: unknown) => unknown;\n}\n\nexport function init(inst: { _zod: Internals }): void {\n  inst._zod.parse = (payload, _ctx, _extra) => {\n    return payload;\n  };\n}\n\nexport function runOne(inst: { _zod: Internals }): unknown {\n  return inst._zod.parse(1, {});\n}\n"
        },
        "name": "parse",
        "expect": "break",
        "answer": "REVIEW_REQUIRED",
        "detail": "parse:modified=review(header) Internals:modified=review(declaration-change) parse:modified=review(value-change)"
    }
];
