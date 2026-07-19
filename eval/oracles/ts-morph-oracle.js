/**
 * eval/oracles/ts-morph-oracle.js - TypeScript oracle via ts-morph.
 *
 * Ground truth from the TypeScript language service: listSymbols enumerates
 * exported function/method/class declarations; findReferences classifies each
 * reference by its AST position (call / import / definition / reference).
 *
 * devDependency only — never loaded at runtime by UCN itself.
 */

'use strict';

const path = require('path');
const fs = require('fs');

const SYMBOL_KINDS = { function: 'function', method: 'method', class: 'class' };

const tsMorphOracle = {
    name: 'ts-morph',
    languages: ['typescript', 'javascript'],

    /**
     * @param {string} repoDir - the analysis target directory (same dir UCN indexes)
     * @returns {{ project, root, SyntaxKind }}
     */
    async prepare(repoDir) {
        const { Project } = require('ts-morph');
        const ts = require('typescript');
        const tsConfigPath = findTsConfig(repoDir);
        let project;
        if (tsConfigPath) {
            project = new Project({
                tsConfigFilePath: tsConfigPath,
                skipAddingFilesFromTsConfig: true,
            });
        } else {
            project = new Project({
                compilerOptions: { allowJs: true, checkJs: false, target: 99, module: 199 },
            });
        }
        // Add exactly the files UCN would index under the target dir, so the
        // file universes align (normalization happens again at scoring time).
        // No tsconfig = plain-JavaScript project (express): add the JS
        // extensions UCN indexes. Gated on the tsconfig check so TS repos'
        // symbol universes (and therefore their historical samples) stay
        // byte-stable.
        const globs = [
            path.join(repoDir, '**/*.ts'),
            path.join(repoDir, '**/*.tsx'),
            '!' + path.join(repoDir, '**/node_modules/**'),
            '!' + path.join(repoDir, '**/*.d.ts'),
        ];
        if (!tsConfigPath) {
            globs.push(
                path.join(repoDir, '**/*.js'),
                path.join(repoDir, '**/*.mjs'),
                path.join(repoDir, '**/*.cjs'),
                path.join(repoDir, '**/*.jsx'));
        }
        project.addSourceFilesAtPaths(globs);
        return { project, root: repoDir, ts, isJsProject: !tsConfigPath };
    },

    /**
     * Exported function/method/class declarations.
     */
    async listSymbols(handle, { kinds, limit } = {}) {
        const wanted = new Set(kinds || Object.values(SYMBOL_KINDS));
        const out = [];
        for (const sf of handle.project.getSourceFiles()) {
            const rel = path.relative(handle.root, sf.getFilePath());
            if (rel.startsWith('..')) continue;
            for (const fn of sf.getFunctions()) {
                if (!wanted.has('function') || !fn.getName()) continue;
                out.push({ name: fn.getName(), file: rel, line: fn.getStartLineNumber(), kind: 'function' });
            }
            for (const cls of sf.getClasses()) {
                const clsName = cls.getName();
                if (wanted.has('class') && clsName) {
                    out.push({ name: clsName, file: rel, line: cls.getStartLineNumber(), kind: 'class' });
                }
                if (wanted.has('method')) {
                    for (const m of cls.getMethods()) {
                        out.push({ name: m.getName(), file: rel, line: m.getStartLineNumber(), kind: 'method' });
                    }
                }
            }
            // Plain-JS projects define most callables in CJS shapes invisible
            // to getFunctions(): `const f = () => {}`, `proto.use = function
            // use() {}`, `exports.query = function () {}`. Enumerate them with
            // UCN's naming rules (named fn expression wins, else the assigned
            // property/variable name) so the symbol universes align. Gated to
            // JS projects so TS repos' historical samples stay byte-stable.
            if (handle.isJsProject && wanted.has('function')) {
                for (const { name, line } of jsAssignedFunctions(sf)) {
                    out.push({ name, file: rel, line, kind: 'function' });
                }
            }
            if (limit && out.length >= limit) return out.slice(0, limit);
        }
        return limit ? out.slice(0, limit) : out;
    },

    /**
     * All references to the symbol declared at (file, line), classified by the
     * reference node's syntactic position.
     */
    async findReferences(handle, { name, file, line }) {
        const sf = handle.project.getSourceFile(path.join(handle.root, file));
        if (!sf) return [];
        const decl = findDeclarationAt(sf, name, line);
        if (!decl) return [];

        const { SyntaxKind } = require('ts-morph');
        const refs = [];
        let refSymbols;
        try {
            refSymbols = decl.findReferences();
        } catch (e) {
            return [];
        }
        for (const refSymbol of refSymbols) {
            for (const ref of refSymbol.getReferences()) {
                const refSf = ref.getSourceFile();
                const rel = path.relative(handle.root, refSf.getFilePath());
                if (rel.startsWith('..')) continue;
                const node = ref.getNode();
                const kind = classifyReference(node, SyntaxKind, ref.isDefinition());
                // TypeScript findReferences deliberately groups related
                // structural methods. That is useful for rename, but not an
                // exact runtime-call oracle: RegExpRouter.add() appeared as a
                // reference to sibling SmartRouter.add(). For method call
                // edges, retain exact-owner calls plus calls resolved through
                // an interface/base that the target may override; reject
                // concrete sibling owners.
                if (kind === 'call' && !methodCallMayReach(handle, decl, node, SyntaxKind)) continue;
                refs.push({
                    file: rel,
                    line: node.getStartLineNumber(),
                    kind,
                });
            }
        }
        return refs;
    },
};

function findTsConfig(dir) {
    // Walk up from the target dir to the repo root looking for tsconfig.json
    let current = dir;
    for (let i = 0; i < 5; i++) {
        const candidate = path.join(current, 'tsconfig.json');
        if (fs.existsSync(candidate)) return candidate;
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return null;
}

function methodCallMayReach(handle, targetDecl, referenceNode, SyntaxKind) {
    if (targetDecl.getKind() !== SyntaxKind.MethodDeclaration) return true;
    const targetOwner = targetDecl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    if (!targetOwner) return true;

    let call = null;
    const parent = referenceNode.getParent();
    if (parent?.getKind() === SyntaxKind.CallExpression && parent.getExpression() === referenceNode) {
        call = parent;
    } else if (parent?.getKind() === SyntaxKind.PropertyAccessExpression &&
        parent.getNameNode() === referenceNode) {
        const grand = parent.getParent();
        if (grand?.getKind() === SyntaxKind.CallExpression && grand.getExpression() === parent) call = grand;
    }
    if (!call) return true;

    let signatureDecl;
    try {
        signatureDecl = handle.project.getTypeChecker().getResolvedSignature(call)?.getDeclaration();
    } catch (e) {
        return true; // oracle uncertainty must not become a false negative
    }
    if (!signatureDecl) return true;
    const sigInterface = signatureDecl.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration);
    if (sigInterface) return true; // a target implementation may receive interface dispatch
    const sigOwner = signatureDecl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    // A concrete call may resolve to a standalone function installed as a
    // class field (`RegExpRouter.match = match`). TypeScript's rename-oriented
    // findReferences still groups that call with sibling class declarations,
    // but runtime dispatch cannot reach those declarations. A declaration we
    // cannot classify stays conservative; an actual function declaration is
    // definitive negative ownership evidence.
    if (!sigOwner) {
        return signatureDecl.getKind() !== SyntaxKind.FunctionDeclaration;
    }
    if (sameDeclarationOwner(targetOwner, sigOwner)) return true;

    // A call resolved to a base declaration may execute the target override.
    // A call resolved to a different concrete sibling cannot.
    let base = targetOwner.getBaseClass();
    const visited = new Set();
    while (base) {
        const key = `${base.getSourceFile().getFilePath()}:${base.getStart()}`;
        if (visited.has(key)) break;
        visited.add(key);
        if (sameDeclarationOwner(base, sigOwner)) return true;
        base = base.getBaseClass();
    }
    return false;
}

function sameDeclarationOwner(a, b) {
    return a.getSourceFile().getFilePath() === b.getSourceFile().getFilePath() &&
        a.getStart() === b.getStart();
}

/**
 * CJS/assigned function shapes with UCN's naming rules: a named function
 * expression keeps its own name, an anonymous one takes the assigned
 * property/variable name (`proto.listen = function () {}` → `listen`).
 * `anchor` is a node findReferences() accepts (Identifier or named fn).
 */
function jsAssignedFunctions(sf) {
    const { SyntaxKind } = require('ts-morph');
    const out = [];
    for (const v of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        const init = v.getInitializer();
        if (!init) continue;
        const k = init.getKind();
        if ((k === SyntaxKind.ArrowFunction || k === SyntaxKind.FunctionExpression) &&
            v.getNameNode().getKind() === SyntaxKind.Identifier) {
            out.push({ name: v.getName(), line: v.getStartLineNumber(), anchor: v });
        }
    }
    for (const bin of sf.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
        if (bin.getOperatorToken().getKind() !== SyntaxKind.EqualsToken) continue;
        const lhs = bin.getLeft();
        const rhs = bin.getRight();
        if (lhs.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
        const rk = rhs.getKind();
        if (rk !== SyntaxKind.FunctionExpression && rk !== SyntaxKind.ArrowFunction) continue;
        const fnName = rk === SyntaxKind.FunctionExpression ? (rhs.getName ? rhs.getName() : null) : null;
        const name = fnName || lhs.getNameNode().getText();
        if (!name) continue;
        const anchor = fnName ? rhs : lhs.getNameNode();
        out.push({ name, line: bin.getStartLineNumber(), anchor });
    }
    return out;
}

function findDeclarationAt(sf, name, line) {
    for (const fn of sf.getFunctions()) {
        if (fn.getName() === name && fn.getStartLineNumber() === line) return fn;
    }
    for (const cls of sf.getClasses()) {
        if (cls.getName() === name && cls.getStartLineNumber() === line) return cls;
        for (const m of cls.getMethods()) {
            if (m.getName() === name && m.getStartLineNumber() === line) return m;
        }
    }
    // Arrow-function consts (`export const f = () => ...`) and anything nested
    // in a namespace — getFunctions()/getClasses() are top-level only, so walk
    // descendants. Needed by the deadcode eval, whose claims come from UCN's
    // symbol table rather than this oracle's listSymbols.
    const { SyntaxKind } = require('ts-morph');
    for (const v of sf.getDescendantsOfKind(SyntaxKind.VariableDeclaration)) {
        if (v.getName() === name && v.getStartLineNumber() === line) return v;
    }
    // Interfaces, enums, type aliases, namespaces, and accessors — the
    // deadcode eval claims these kinds (class-kind audit + accessor audit)
    // and they were all "declaration not found" before (32 unpinnable zod
    // exported-arm claims).
    const NAMED_DECL_KINDS = [
        SyntaxKind.InterfaceDeclaration, SyntaxKind.EnumDeclaration,
        SyntaxKind.TypeAliasDeclaration, SyntaxKind.ModuleDeclaration,
        SyntaxKind.GetAccessor, SyntaxKind.SetAccessor,
    ];
    for (const kind of NAMED_DECL_KINDS) {
        for (const d of sf.getDescendantsOfKind(kind)) {
            if (d.getName && d.getName() === name && d.getStartLineNumber() === line) return d;
        }
    }
    // CJS property-assigned functions (`proto.use = function use() {}`)
    for (const af of jsAssignedFunctions(sf)) {
        if (af.name === name && af.line === line) return af.anchor;
    }
    // Fallback: match by name only (line drift)
    for (const fn of sf.getFunctions()) if (fn.getName() === name) return fn;
    for (const cls of sf.getClasses()) {
        if (cls.getName() === name) return cls;
        for (const m of cls.getMethods()) if (m.getName() === name) return m;
    }
    for (const kind of NAMED_DECL_KINDS) {
        for (const d of sf.getDescendantsOfKind(kind)) {
            if (d.getName && d.getName() === name) return d;
        }
    }
    return null;
}

/** Classify a reference node: call / import / definition / reference. */
function classifyReference(node, SyntaxKind, isDefinition) {
    if (isDefinition) return 'definition';
    const parent = node.getParent();
    if (!parent) return 'reference';
    const pk = parent.getKind();

    // someName(...) — identifier is the callee
    if (pk === SyntaxKind.CallExpression && parent.getExpression() === node) return 'call';
    // new SomeName(...)
    if (pk === SyntaxKind.NewExpression && parent.getExpression() === node) return 'call';
    // obj.someName(...) — property access whose parent call uses it as callee
    if (pk === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === node) {
        const grand = parent.getParent();
        if (grand && grand.getKind() === SyntaxKind.CallExpression && grand.getExpression() === parent) {
            return 'call';
        }
        return 'reference';
    }
    // import { someName } / import someName from / export { someName }
    if (pk === SyntaxKind.ImportSpecifier || pk === SyntaxKind.ImportClause ||
        pk === SyntaxKind.ExportSpecifier || pk === SyntaxKind.NamespaceImport) {
        return 'import';
    }
    return 'reference';
}

module.exports = { tsMorphOracle };
