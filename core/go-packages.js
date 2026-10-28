/**
 * core/go-packages.js - Go package identity and build configurations.
 *
 * A Go package is the set of files of one directory that share a package
 * clause: `package x` files (test files included, for `go test`) and the
 * external test package `package x_test` of the same directory are two
 * packages, and a non-test file never sees a `_test.go` declaration. One
 * package-level identifier denotes one entity in a build configuration; files
 * that declare it under different `//go:build` constraints (or GOOS/GOARCH
 * file-name suffixes) are configuration alternatives of one item (fix #425).
 */

'use strict';

const path = require('path');

const GO_OS = new Set(['aix', 'android', 'darwin', 'dragonfly', 'freebsd', 'hurd', 'illumos', 'ios', 'js',
    'linux', 'nacl', 'netbsd', 'openbsd', 'plan9', 'solaris', 'wasip1', 'windows', 'zos']);
const GO_ARCH = new Set(['386', 'amd64', 'amd64p32', 'arm', 'arm64', 'arm64be', 'armbe', 'loong64', 'mips',
    'mips64', 'mips64le', 'mips64p32', 'mips64p32le', 'mipsle', 'ppc', 'ppc64', 'ppc64le', 'riscv', 'riscv64',
    's390', 's390x', 'sparc', 'sparc64', 'wasm']);

// Package-level type kinds a method set belongs to.
const GO_TYPE_KINDS = new Set(['struct', 'interface', 'type', 'class', 'enum']);

/**
 * The build configurations a Go file belongs to (fix #399): its
 * `//go:build` expression plus the GOOS/GOARCH its file name implies
 * (`x_linux.go`, `x_windows_amd64_test.go`); '' when every build compiles it.
 */
function goFileConstraint(index, file) {
    const memo = index._opMemo?.('goFileConstraint', () => new Map());
    const cached = memo?.get(file);
    if (cached !== undefined) return cached;
    const constraint = goFileConstraintUncached(index, file);
    memo?.set(file, constraint);
    return constraint;
}

function goFileConstraintUncached(index, file) {
    const tag = index.files.get(file)?.buildConstraint || '';
    const parts = path.basename(file, '.go').replace(/_test$/, '').split('_');
    let implied = '';
    if (parts.length >= 3 && GO_OS.has(parts[parts.length - 2]) && GO_ARCH.has(parts[parts.length - 1])) {
        implied = `${parts[parts.length - 2]}/${parts[parts.length - 1]}`;
    } else if (parts.length >= 2 && (GO_OS.has(parts[parts.length - 1]) || GO_ARCH.has(parts[parts.length - 1]))) {
        implied = parts[parts.length - 1];
    }
    return tag || implied ? `${tag}|${implied}` : '';
}

const isTestFile = file => file.endsWith('_test.go');

/**
 * Does a package-level declaration of `declFile` belong to the package a
 * bare name in `siteFile` is resolved in? Same directory, same package
 * clause (`x` and `x_test` are two packages), and a `_test.go` declaration
 * only for a test file. A file whose clause is unknown keeps the directory
 * rule.
 */
function goSamePackage(index, siteFile, declFile) {
    if (!siteFile || !declFile) return false;
    if (siteFile === declFile) return true;
    if (path.dirname(siteFile) !== path.dirname(declFile)) return false;
    const site = index.files.get(siteFile)?.packageName;
    const decl = index.files.get(declFile)?.packageName;
    if (site && decl && site !== decl) return false;
    return isTestFile(siteFile) || !isTestFile(declFile);
}

/**
 * The directories of the project packages `siteFile` dot-imports
 * (`import . "p"`), whose exported package-level names its file block holds.
 */
function goDotImportDirs(index, siteFile) {
    const memo = index._opMemo?.('goDotImportDirs', () => new Map());
    if (memo?.has(siteFile)) return memo.get(siteFile);
    const entry = index.files.get(siteFile);
    let dirs = null;
    for (const detail of entry?.importDetails || []) {
        if (detail.type !== 'dot-import' || !detail.module) continue;
        const rel = entry.moduleResolved?.[detail.module];
        if (!rel) continue;
        const abs = path.isAbsolute(rel) ? rel : path.join(index.root, rel);
        (dirs || (dirs = new Set())).add(path.dirname(abs));
    }
    memo?.set(siteFile, dirs);
    return dirs;
}

/**
 * Does a bare name in `siteFile` reach the package-level declaration `def`?
 * Its own package's declarations (goSamePackage), or an exported non-test
 * declaration of a package the file dot-imports (Go spec, Import
 * declarations: the external test package `x_test` that dot-imports `x` sees
 * x's exported names unqualified).
 */
function goBareNameReaches(index, siteFile, def) {
    if (!def?.file) return false;
    if (goSamePackage(index, siteFile, def.file)) return true;
    if (isTestFile(def.file) || !/^\p{Lu}/u.test(def.name || '')) return false;
    const dirs = goDotImportDirs(index, siteFile);
    if (!dirs || !dirs.has(path.dirname(def.file))) return false;
    // The imported package is the directory's non-test package.
    return !String(index.files.get(def.file)?.packageName || '').endsWith('_test');
}

/**
 * Are two declarations configuration alternatives of one Go item? Files of
 * one package that both declare a package-level name compile together only
 * in a program that does not build (the name would be redeclared), so two
 * such declarations under different file constraints are one item in two
 * build configurations: same name, same receiver type, one package, one
 * test side, and at least one constrained file.
 */
function goBuildAlternatives(index, a, b) {
    if (!a || !b || a === b || a.file === b.file || a.name !== b.name) return false;
    if (path.dirname(a.file) !== path.dirname(b.file)) return false;
    if (isTestFile(a.file) !== isTestFile(b.file)) return false;
    const pa = index.files.get(a.file)?.packageName;
    const pb = index.files.get(b.file)?.packageName;
    if (!pa || pa !== pb) return false;
    if (a.lexicalScopeStartLine != null || b.lexicalScopeStartLine != null) return false;
    if (a.isNested || b.isNested) return false;
    const ownerOf = d => String(d.receiver || d.className || '').replace(/^\*/, '').replace(/\[.*$/, '') || null;
    if (ownerOf(a) !== ownerOf(b)) return false;
    // A function and a type of one name are not alternatives of one item.
    if (GO_TYPE_KINDS.has(a.type) !== GO_TYPE_KINDS.has(b.type)) return false;
    const ca = goFileConstraint(index, a.file);
    const cb = goFileConstraint(index, b.file);
    return ca !== cb && !!(ca || cb);
}

/**
 * The alternatives of one item a site in `siteFile` reaches: a site in a
 * file whose constraint is one alternative's own compiles only with that
 * alternative (the site's file and that alternative's file build together,
 * so no other alternative does); any other site reaches each of them.
 */
function goAlternativesAt(index, siteFile, alternatives) {
    if (!siteFile || alternatives.length < 2) return alternatives;
    const own = alternatives.filter(d => d.file === siteFile);
    if (own.length > 0) return own;
    const site = goFileConstraint(index, siteFile);
    if (!site) return alternatives;
    const same = alternatives.filter(d => goFileConstraint(index, d.file) === site);
    return same.length > 0 ? same : alternatives;
}

/**
 * Package-level types named `name` the package of `siteFile` declares
 * (fix #425): what a receiver no local binds (`T.M`, `(*T).M`) denotes when
 * the package declares a type of that name.
 */
function goPackageTypes(index, siteFile, name) {
    if (!name) return [];
    return (index.symbols.get(name) || []).filter(d => d.file && GO_TYPE_KINDS.has(d.type) &&
        d.lexicalScopeStartLine == null && !d.className && !d.receiver &&
        index.files.get(d.file)?.language === 'go' && goSamePackage(index, siteFile, d.file));
}

module.exports = {
    goFileConstraint,
    goSamePackage,
    goDotImportDirs,
    goBareNameReaches,
    goBuildAlternatives,
    goAlternativesAt,
    goPackageTypes,
    GO_TYPE_KINDS,
};
