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
        project.addSourceFilesAtPaths([
            path.join(repoDir, '**/*.ts'),
            path.join(repoDir, '**/*.tsx'),
            '!' + path.join(repoDir, '**/node_modules/**'),
            '!' + path.join(repoDir, '**/*.d.ts'),
        ]);
        return { project, root: repoDir, ts };
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
                refs.push({
                    file: rel,
                    line: node.getStartLineNumber(),
                    kind: classifyReference(node, SyntaxKind, ref.isDefinition()),
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
    // Fallback: match by name only (line drift)
    for (const fn of sf.getFunctions()) if (fn.getName() === name) return fn;
    for (const cls of sf.getClasses()) {
        if (cls.getName() === name) return cls;
        for (const m of cls.getMethods()) if (m.getName() === name) return m;
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
