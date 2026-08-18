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
const { findProjectRoot } = require('../../core/discovery');

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
        // ProjectIndex roots at the nearest manifest so imports and callers
        // in sibling source/test directories remain visible even when the
        // requested target is a nested src directory. Mirror that universe;
        // otherwise the oracle sees declarations but silently misses tests.
        const projectRoot = findProjectRoot(repoDir);
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
            path.join(projectRoot, '**/*.ts'),
            path.join(projectRoot, '**/*.tsx'),
            '!' + path.join(projectRoot, '**/node_modules/**'),
            '!' + path.join(projectRoot, '**/*.d.ts'),
        ];
        if (!tsConfigPath) {
            globs.push(
                path.join(projectRoot, '**/*.js'),
                path.join(projectRoot, '**/*.mjs'),
                path.join(projectRoot, '**/*.cjs'),
                path.join(projectRoot, '**/*.jsx'));
        }
        project.addSourceFilesAtPaths(globs);
        // No tsconfig = plain-JavaScript oracle mode: reference search still
        // works through the language service, but definition lookup mostly
        // returns [] (an explicit abstention). Declare that capability so the
        // coverage gate can contextualize the definition-unresolved ratio
        // instead of failing every plain-JS repo on oracle blindness
        // (fix #286h, dayjs-measured: 54% unresolved, every engine gate green).
        return { project, root: projectRoot, ts, isJsProject: !tsConfigPath,
            definitionLookupWeak: !tsConfigPath,
            // dayjs-measured at 54%. Keep an explicit ceiling so declaring a
            // weaker capability never turns total oracle blindness into a
            // passing release board.
            ...(!tsConfigPath && { definitionUnresolvedRatioCeiling: 0.60 }) };
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
                const reach = kind === 'call'
                    ? methodCallMayReach(handle, decl, node, SyntaxKind)
                    : 'resolved';
                if (reach === false) continue;
                refs.push({
                    file: rel,
                    line: node.getStartLineNumber(),
                    column: node.getStart() - node.getStartLinePos(),
                    kind,
                    ...(kind === 'call' && {
                        oracleResolution: reach === 'unresolved'
                            ? 'unresolved' : 'may-reach',
                    }),
                });
            }
        }

        // TypeScript's rename-oriented findReferences can return no call
        // references for a declaration-only class whose runtime methods are
        // installed through `Type.prototype.method = function`. Preact
        // Signals is a real example: the class declaration is the public type
        // surface, while the ES5 prototype assignment is the implementation.
        // Recover those sites from compiler-resolved call expressions. This is
        // not a name-only fallback: methodCallMayReach still requires the
        // resolved receiver/signature to be the exact owner, a base/interface
        // dispatch capable of reaching it, or unresolved (oracle uncertainty).
        if (decl.getKind() === SyntaxKind.MethodDeclaration) {
            for (const node of methodCallCandidates(handle, name, SyntaxKind)) {
                const reach = methodCallMayReach(handle, decl, node, SyntaxKind);
                if (reach === false) continue;
                const rel = path.relative(handle.root, node.getSourceFile().getFilePath());
                if (rel.startsWith('..')) continue;
                refs.push({
                    file: rel,
                    line: node.getStartLineNumber(),
                    column: node.getStart() - node.getStartLinePos(),
                    kind: 'call',
                    oracleResolution: reach === 'unresolved'
                        ? 'unresolved' : 'may-reach',
                });
            }
        }

        return dedupeReferences(refs);
    },

    /**
     * Resolve the declaration selected at an exact reference occurrence.
     *
     * TypeScript's findReferences is rename-oriented and deliberately expands
     * structural method families. Definition lookup is therefore required to
     * distinguish an exact runtime edge from a broad family member. Plain JS
     * often has no resolvable definition; returning [] is an explicit oracle
     * abstention, never evidence for the sampled target.
     */
    async resolveDefinition(handle, { name, file, line, column }) {
        const sf = handle.project.getSourceFile(path.join(handle.root, file));
        if (!sf) return [];
        const { SyntaxKind } = require('ts-morph');
        let nodes = sf.getDescendantsOfKind(SyntaxKind.Identifier)
            .filter(node => node.getText() === name &&
                node.getStartLineNumber() === line);
        if (Number.isInteger(column)) {
            nodes = nodes.filter(node =>
                node.getStart() - node.getStartLinePos() === column);
        }
        const defs = new Map();
        for (const node of nodes) {
            let definitionNodes;
            try {
                definitionNodes = node.getDefinitionNodes();
            } catch {
                continue;
            }
            for (const def of expandAliasDefinitions(definitionNodes, SyntaxKind)) {
                const defFile = def.getSourceFile().getFilePath();
                const defLine = def.getStartLineNumber();
                const insideRoot = defFile === handle.root ||
                    defFile.startsWith(handle.root + path.sep);
                const entry = insideRoot
                    ? { file: path.relative(handle.root, defFile), line: defLine }
                    : { file: defFile, line: defLine, external: true };
                defs.set(`${entry.external ? 'external:' : ''}${entry.file}:${entry.line}`, entry);
            }
        }
        return [...defs.values()];
    },
};

/**
 * Follow compiler-resolved, value-preserving const aliases. A definition
 * lookup at `alias()` normally stops on `const alias = target`; for call
 * identity the initializer's definition is equally authoritative. Only
 * direct identifier aliases (optionally parenthesized/cast) are followed.
 */
function expandAliasDefinitions(initial, SyntaxKind) {
    const out = [];
    const queue = (initial || []).map(node => ({ node, depth: 0 }));
    const seen = new Set();
    while (queue.length > 0) {
        const { node, depth } = queue.shift();
        const key = `${node.getSourceFile().getFilePath()}:${node.getStart()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(node);
        if (depth >= 4 || node.getKind() !== SyntaxKind.VariableDeclaration) continue;
        let value = node.getInitializer?.();
        while (value && [
            SyntaxKind.ParenthesizedExpression,
            SyntaxKind.AsExpression,
            SyntaxKind.TypeAssertionExpression,
            SyntaxKind.SatisfiesExpression,
        ].includes(value.getKind())) {
            value = value.getExpression?.();
        }
        if (!value || value.getKind() !== SyntaxKind.Identifier) continue;
        let next;
        try {
            next = value.getDefinitionNodes();
        } catch {
            next = [];
        }
        for (const target of next) queue.push({ node: target, depth: depth + 1 });
    }
    return out;
}

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
    if (targetDecl.getKind() !== SyntaxKind.MethodDeclaration) return 'resolved';
    const targetOwner = targetDecl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    if (!targetOwner) return 'unresolved';

    let call = null;
    const parent = referenceNode.getParent();
    if (parent?.getKind() === SyntaxKind.CallExpression && parent.getExpression() === referenceNode) {
        call = parent;
    } else if (parent?.getKind() === SyntaxKind.PropertyAccessExpression &&
        parent.getNameNode() === referenceNode) {
        const grand = parent.getParent();
        if (grand?.getKind() === SyntaxKind.CallExpression && grand.getExpression() === parent) call = grand;
    }
    if (!call) return 'resolved';

    let signatureDecl;
    try {
        signatureDecl = handle.project.getTypeChecker().getResolvedSignature(call)?.getDeclaration();
    } catch (e) {
        return 'unresolved';
    }
    if (!signatureDecl) return 'unresolved';
    const sigInterface = signatureDecl.getFirstAncestorByKind(SyntaxKind.InterfaceDeclaration);
    const sigOwner = signatureDecl.getFirstAncestorByKind(SyntaxKind.ClassDeclaration);
    // A concrete call may resolve to a standalone function installed as a
    // class field (`RegExpRouter.match = match`). TypeScript's rename-oriented
    // findReferences still groups that call with sibling class declarations,
    // but runtime dispatch cannot reach those declarations. A declaration we
    // cannot classify stays conservative; an actual function declaration is
    // definitive negative ownership evidence.
    if (!sigOwner) {
        if (sigInterface) {
            const receiverVerdict = receiverTypeMayReachTarget(
                handle, call, targetOwner, SyntaxKind);
            if (receiverVerdict === true ||
                interfaceShapeMayReachTarget(sigInterface, targetOwner)) {
                return 'resolved';
            }
            return receiverVerdict === null ? 'unresolved' : false;
        }
        return signatureDecl.getKind() === SyntaxKind.FunctionDeclaration
            ? false : 'unresolved';
    }
    if (sameDeclarationOwner(targetOwner, sigOwner)) return 'resolved';

    // A call resolved to a base declaration may execute the target override.
    // A call resolved to a different concrete sibling cannot.
    let base = targetOwner.getBaseClass();
    const visited = new Set();
    while (base) {
        const key = `${base.getSourceFile().getFilePath()}:${base.getStart()}`;
        if (visited.has(key)) break;
        visited.add(key);
        if (sameDeclarationOwner(base, sigOwner)) return 'resolved';
        base = base.getBaseClass();
    }
    return false;
}

function interfaceShapeMayReachTarget(interfaceDecl, targetOwner) {
    // Generic target declarations are not always considered assignable to a
    // concrete interface instantiation (`Signal<T>` vs
    // `ReadonlySignal<number>`) even though some runtime instantiation can
    // satisfy it. For a MAY-dispatch reference oracle, complete structural
    // member coverage is sufficient potential evidence. Concrete sibling
    // owners never enter this branch, so this cannot merge two unrelated
    // class implementations merely because one method name matches.
    try {
        const required = interfaceDecl.getType().getProperties()
            .map(property => property.getName());
        const available = new Set(targetOwner.getType().getProperties()
            .map(property => property.getName()));
        return required.length > 0 && required.every(name => available.has(name));
    } catch {
        return false;
    }
}

function receiverTypeMayReachTarget(handle, call, targetOwner, SyntaxKind) {
    // Rename-oriented references may group universal/repeated interface
    // methods even when the receiver can never be the target owner. Check
    // both assignability directions: an interface/base receiver may dispatch
    // to the target subtype, while a concrete subtype may inherit a target
    // method. Unresolved/any/unknown receivers remain conservative.
    try {
        const access = call.getExpression();
        if (access?.getKind() !== SyntaxKind.PropertyAccessExpression) return null;
        const receiverType = handle.project.getTypeChecker()
            .getTypeAtLocation(access.getExpression());
        if (receiverType.isAny?.() || receiverType.isUnknown?.()) return null;
        const targetType = targetOwner.getType();
        return targetType.isAssignableTo(receiverType) ||
            receiverType.isAssignableTo(targetType);
    } catch {
        return null;
    }
}

function sameDeclarationOwner(a, b) {
    return a.getSourceFile().getFilePath() === b.getSourceFile().getFilePath() &&
        a.getStart() === b.getStart();
}

/**
 * Cache property-call name nodes once per prepared project. The fallback above
 * may be used for many sampled methods; rescanning every AST for every symbol
 * would turn a correctness repair into an avoidable evaluation bottleneck.
 */
function methodCallCandidates(handle, name, SyntaxKind) {
    if (!handle.methodCallCandidatesByName) {
        const byName = new Map();
        for (const sf of handle.project.getSourceFiles()) {
            for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
                const expression = call.getExpression();
                if (expression?.getKind() !== SyntaxKind.PropertyAccessExpression) continue;
                const nameNode = expression.getNameNode();
                const calledName = nameNode?.getText();
                if (!calledName) continue;
                if (!byName.has(calledName)) byName.set(calledName, []);
                byName.get(calledName).push(nameNode);
            }
        }
        handle.methodCallCandidatesByName = byName;
    }
    return handle.methodCallCandidatesByName.get(name) || [];
}

function dedupeReferences(refs) {
    const seen = new Set();
    return refs.filter(ref => {
        const key = `${ref.file}:${ref.line}:${ref.column ?? '*'}:${ref.kind}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
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
