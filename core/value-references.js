'use strict';

const { langTraits, LANGUAGES, getParser, safeParse } = require('../languages');
const { sameNode, visitNameNodes } = require('../languages/utils');
const { referenceScope } = require('../languages/lexical-scope');
const { TypeReferenceResolver, referenceRole, referenceBindingScope, referenceTypeParameterScope,
    typeReferenceSites, referenceImportVerdict } = require('./type-references');
const { ownerRefOf, classDefsNamed, findDeclaringClass, relationToTargets,
    parentRefsOf, lexicalClassRefOf, completeForwardDeclaration } = require('./class-identity');
const { isValueDefinition } = require('./shared');
const TYPE_BODIES = new Set(['class_declaration', 'class_definition', 'class',
    'abstract_class_declaration', 'struct_specifier', 'class_specifier', 'union_specifier',
    'struct_item', 'enum_item', 'enum_declaration', 'enum_specifier',
    'struct_declaration', 'record_declaration', 'interface_declaration', 'union_item', 'type_spec',
    'annotation_type_declaration', 'record_struct_declaration']);
const MEMBER_NODES = new Set(['attribute', 'member_expression', 'member_access_expression',
    'member_binding_expression', 'field_expression', 'field_access', 'selector_expression']);
const ROOTS = new Set(['program', 'module', 'source_file', 'translation_unit', 'compilation_unit']);
const TYPE_NAMES = new Set(['identifier', 'type_identifier', 'namespace_identifier']);
const TYPE_WRAPPERS = new Set(['type', 'type_annotation', 'reference_type', 'pointer_type',
    'nullable_type', 'parenthesized_type', 'type_descriptor']);
const DECLARATIONS = new Set(['parameter', 'formal_parameter', 'spread_parameter',
    'required_parameter', 'optional_parameter', 'typed_parameter', 'parameter_declaration',
    'variable_declarator', 'let_declaration', 'assignment', 'var_spec', 'const_spec',
    'declaration', 'local_declaration_statement', 'field_declaration',
    'field_definition', 'public_field_definition']);
const GRAMMAR_LANGUAGES = new Map(Object.values(LANGUAGES).map(config =>
    [config.treeSitterLang, config.name]));
const TYPE_KINDS = new Set(['class', 'struct', 'interface', 'trait', 'enum', 'record',
    'union', 'type', 'namespace', 'impl']);
const FUNCTION_NODES = new Set(['function', 'function_expression', 'function_declaration',
    'generator_function', 'generator_function_declaration']);
const CALLABLE_SCOPES = new Set([...FUNCTION_NODES, 'function_definition', 'method_definition',
    'method_declaration', 'constructor_declaration', 'lambda', 'lambda_expression',
    'arrow_function', 'closure_expression', 'function_item']);
const WRITE_EXPRESSIONS = new Set(['assignment', 'assignment_expression', 'assignment_statement',
    'augmented_assignment', 'augmented_assignment_expression', 'compound_assignment_expr',
    'update_expression', 'inc_statement', 'dec_statement']);

function declarationTrees(index, file, content, language) {
    const memo = index.isProvenanceFactIndex ? null
        : index._opMemo?.('valueDeclarationTrees', () => new Map());
    if (memo?.has(file)) return memo.get(file);
    const parser = getParser(language);
    const literal = index._getParsedTree(file, content, language) || safeParse(parser, content);
    const entry = index.files.get(file);
    let recovered = null;
    if (langTraits(language)?.textualIncludes &&
        (literal?.rootNode.hasError || entry?.recoveryBlanks?.length)) {
        const blanks = Array.isArray(entry?.recoveryBlanks) && entry.hash &&
            require('crypto').createHash('md5').update(content).digest('hex') === entry.hash
            ? entry.recoveryBlanks : null;
        const module = LANGUAGES[language]?.module();
        if (module?.recoveredTree) recovered = module.recoveredTree(content, parser, blanks);
    }
    const trees = [recovered, literal].filter(Boolean);
    memo?.set(file, trees);
    return trees;
}

function isWrittenBinding(node) {
    for (let current = node; current?.parent; current = current.parent) {
        const parent = current.parent;
        if (MEMBER_NODES.has(parent.type) || parent.type === 'scoped_identifier') return false;
        if (WRITE_EXPRESSIONS.has(parent.type)) {
            const left = parent.childForFieldName('left') || parent.childForFieldName('argument');
            return left ? contains(left, node) : parent.namedChildCount === 1;
        }
        if (!['expression_list', 'object_pattern', 'array_pattern', 'pair_pattern',
            'parenthesized_expression', 'tuple_pattern'].includes(parent.type)) return false;
    }
    return false;
}

function contains(scope, node) {
    return !scope || scope.startIndex <= node.startIndex && scope.endIndex >= node.endIndex;
}

function typeSyntax(node) {
    if (!node) return null;
    if (TYPE_NAMES.has(node.type)) return { name: node.text, node };
    if (node.type === 'qualified_identifier') {
        const tail = typeSyntax(node.childForFieldName('name'));
        const scope = node.childForFieldName('scope');
        if (!tail) return null;
        if (!scope) return node.children.some(child => child.type === '::')
            ? { ...tail, qualifierText: `::${tail.qualifierText || ''}` } : tail;
        return { ...tail, qualifier: tail.qualifier || scope,
            qualifierText: [scope.text, tail.qualifierText].filter(Boolean).join('::') };
    }
    if (TYPE_WRAPPERS.has(node.type)) {
        return typeSyntax(node.childForFieldName('type') || node.namedChild(0));
    }
    if (node.type === 'generic_type' || node.type === 'generic_name') {
        return typeSyntax(node.childForFieldName('type') || node.childForFieldName('name') || node.namedChild(0));
    }
    const name = node.childForFieldName('name') || (node.type === 'scoped_type_identifier'
        ? node.namedChild(node.namedChildCount - 1) : null);
    const qualifier = node.childForFieldName('scope') || node.childForFieldName('qualifier') ||
        node.childForFieldName('package') || node.childForFieldName('module') ||
        node.childForFieldName('path') || (node.type === 'scoped_type_identifier' ? node.namedChild(0) : null);
    if (name && TYPE_NAMES.has(name.type)) return {
        name: name.text, node: name,
        ...(qualifier && { qualifier, qualifierText: qualifier.text }),
    };
    return null;
}

function declarationType(binding) {
    for (let node = binding; node; node = node.parent) {
        if (!DECLARATIONS.has(node.type)) continue;
        const type = node.childForFieldName('type');
        if (type) return { syntax: typeSyntax(type), origin: 'annotation' };
        const value = node.childForFieldName('value') || node.childForFieldName('right');
        if (value?.type === 'new_expression' || value?.type === 'object_creation_expression') {
            return { syntax: typeSyntax(value.childForFieldName('constructor') ||
                value.childForFieldName('type')), origin: 'constructor' };
        }
        if (value?.type === 'struct_expression' || value?.type === 'composite_literal') {
            return { syntax: typeSyntax(value.childForFieldName('name') ||
                value.childForFieldName('type')), origin: 'constructor' };
        }
        if (node.type === 'variable_declarator' && node.parent?.childForFieldName('type')) {
            return { syntax: typeSyntax(node.parent.childForFieldName('type')), origin: 'annotation' };
        }
        if (node.type !== 'variable_declarator') break;
    }
    return null;
}

function memberReceiver(node, role) {
    if (role.role === 'member' && role.receiver) return role.receiver;
    const parent = node.parent;
    if (!MEMBER_NODES.has(parent?.type)) return null;
    const name = parent.childForFieldName('field') || parent.childForFieldName('property') ||
        parent.childForFieldName('name') || parent.childForFieldName('attribute');
    if (!sameNode(name, node)) return null;
    return parent.childForFieldName('object') || parent.childForFieldName('value') ||
        parent.childForFieldName('argument') || parent.childForFieldName('operand') ||
        parent.childForFieldName('expression');
}

function enclosingEnum(node) {
    for (let parent = node.parent; parent; parent = parent.parent) {
        if (parent.type === 'enum_specifier') return parent;
    }
    return null;
}

function enumValueBindingInfo(index, definition) {
    const memo = index._opMemo?.('enumValueBindingInfo', () => new WeakMap());
    if (memo?.has(definition)) return memo.get(definition);
    if (definition.className && ownerRefOf(index, definition)?.def?.type !== 'enum') return null;
    const file = definition.file, content = index._readFile(file);
    const language = index.files.get(file)?.language;
    const tree = index._getParsedTree(file, content, language) || safeParse(getParser(language), content);
    const matches = [];
    if (tree) visitNameNodes(tree, content, definition.name, node => {
        if (node.text !== definition.name || node.startPosition.row + 1 !==
            (definition.nameLine || definition.startLine) || node.parent?.type !== 'enumerator' ||
            !sameNode(node.parent.childForFieldName('name'), node)) return true;
        let owner = node.parent;
        while (owner && owner.type !== 'enum_specifier') owner = owner.parent;
        if (owner) {
            matches.push({ node, enumNode: owner,
                scope: referenceBindingScope(node, language, referenceRole(node, language)),
                unscoped: !owner.children.some(child => child.type === 'class' || child.type === 'struct') });
        }
        return true;
    });
    const result = matches.length === 1 ? matches[0] : null;
    memo?.set(definition, result);
    return result;
}

class ValueReferenceResolver extends TypeReferenceResolver {
    constructor(index, def, name) {
        super(index, def, name);
        this.family = langTraits(this.language)?.nameReferenceFamily || this.family;
        this.declarationKinds = new Set(['state', 'constant']);
        this.all = (index.symbols.get(name) || []).filter(d => isValueDefinition(d) &&
            (def.className || !d.className));
        this.group = new Set([def]);
        this.valueReferences = true;
        this.owner = def.className ? ownerRefOf(index, def) : null;
        this.references = [];
        this.syntaxMemo = new Map();
        this.lexicalScopeMemos = new WeakMap();
        this.typeMemo = new Map();
        this.memberMemo = new Map();
        this.enumMemo = new Map();
        this.scopeMemo = new Map();
        this.localFileModes = new Map();
        this.enumReferenceSyntax = this.owner?.def?.type === 'enum' &&
            langTraits(this.language)?.staticEnumReferenceSyntax
            ? new (require('./enum-reference-syntax').EnumReferenceSyntax)(this) : null;
        this.patternConstant = false;
        this.selectedDeclarations = 0;
        this.declarationStorages = new Set();
        this.declarationRegions = new Set();
        if (langTraits(this.language)?.valuePatternConstants) {
            const content = index._readFile(def.file);
            const tree = index._getParsedTree(def.file, content, this.language) ||
                safeParse(getParser(this.language), content);
            if (tree) visitNameNodes(tree, content, name, node => {
                if (node.startPosition.row + 1 === (def.nameLine || def.startLine) &&
                    ['const_item', 'enum_variant'].includes(node.parent?.type)) this.patternConstant = true;
                return true;
            });
        }
        this.members = (index.symbols.get(name) || []).filter(d => d.className &&
            !TYPE_KINDS.has(d.type) &&
            (!langTraits(this.language)?.fieldsAndMethodsSeparate || isValueDefinition(d)));
        this.targetStorage = this.valueStorage(def);
        this.memberCandidates = langTraits(this.language)?.separateStaticStorage
            ? this.members.filter(member => this.valueStorage(member) === this.targetStorage) : this.members;
    }

    sourceLocalBinding(file, binding, reference = binding.node) {
        if (!binding.scope || ROOTS.has(binding.scope.type) || TYPE_BODIES.has(binding.scope.type) ||
            ['class_body', 'declaration_list', 'field_declaration_list'].includes(binding.scope.type) ||
            binding.role?.role === 'import') return false;
        const traits = langTraits(this.index.files.get(file)?.language);
        if (traits.assignmentDeclaresLocal && !referenceScope(reference,
            this.index.files.get(file)?.language, new Map(), this.name)?.local) return false;
        if (traits.textualIncludes && binding.role?.why === 'function') return false;
        for (let parent = binding.node.parent; parent; parent = parent.parent) {
            if (parent.type === 'ERROR' || TYPE_BODIES.has(parent.type) || ROOTS.has(parent.type) ||
                ['using_declaration', 'using_directive', 'namespace_alias_declaration'].includes(parent.type)) return false;
            if (parent.type === 'declaration' && parent.namedChildren.some(child =>
                child.type === 'storage_class_specifier' && child.text === 'extern')) return false;
            if (CALLABLE_SCOPES.has(parent.type) ||
                ['accessor_declaration', 'local_function_statement', 'func_literal'].includes(parent.type)) return true;
        }
        return false;
    }

    readLocalFile(file, entry, language, rows, content) {
        const enumSyntax = this.enumReferenceSyntax?.read(file, entry, language, rows, content);
        if (enumSyntax) return enumSyntax;
        if (file === this.def.file || this.patternConstant || !entry.hash ||
            !this.index._usageResultCache || this.index.isProvenanceFactIndex) return null;
        const crypto = require('crypto');
        const { indexedContent, syntaxMode } = require('./source-memo');
        if (!indexedContent(this.index, file, entry, content)) return null;
        // Source generations also cover macro definitions in other files.
        // These facts never retain a project-dependent ownership verdict.
        const generation = this.index._opMemo('valueLocalSourceGeneration', () => {
            const hash = crypto.createHash('sha256');
            for (const [path, source] of [...this.index.files].sort((a, b) =>
                require('./shared').codeUnitCompare(a[0], b[0]))) hash.update(path + '\0' + source.hash + '\0' + source.language + '\0');
            return hash.update(JSON.stringify(this.index.config)).digest('hex');
        });
        const mode = syntaxMode('valueLocal', [generation, language,
            entry.recoveryBlanks, entry.conditionalViews, entry.externalMacroKey, rows]);
        this.localFileModes.set(file, { mode, referenceStart: this.references.length });
        const value = require('./cache').getUsageResult(this.index, file, this.name, mode);
        if (!Array.isArray(value)) return null;
        const lines = new Map(), references = [], wanted = new Set(rows);
        for (const record of value) {
            if (!Array.isArray(record) || !wanted.has(record[1])) return null;
            if (record[0] === 'line') {
                const [, line, skips, columns, text, tokens] = record;
                if (lines.has(line) || !Number.isInteger(skips) || !Number.isInteger(tokens) ||
                    !Array.isArray(columns) || columns.some(c => !Number.isInteger(c) || c < 0) ||
                    typeof text !== 'boolean') return null;
                lines.set(line, { edits: [], reviews: [], skips, skipColumns: columns.slice(), text, tokens, macroBody: false });
            } else if (record[0] === 'reference') {
                const [, line, column, accessKind, reason, receiver] = record;
                if (!Number.isInteger(column) || column < 0 || typeof accessKind !== 'string' ||
                    typeof reason !== 'string' || receiver != null && typeof receiver !== 'string') return null;
                references.push({ file: entry.relativePath, absoluteFile: file, line, column,
                    expression: this.index.getLineContent(file, line).trim(), accessKind,
                    verdict: 'no', reason, ...(receiver != null && { receiver }) });
            } else return null;
        }
        if (lines.size !== rows.length) return null;
        this.references.push(...references);
        return lines;
    }

    rememberLocalFile(file, lines, localOnly) {
        this.enumReferenceSyntax?.remember(file, lines);
        const state = this.localFileModes.get(file);
        if (!state || !localOnly || [...lines.values()].some(slot =>
            slot.edits.length || slot.reviews.length || slot.macroBody || slot.stringAnnotation)) return;
        const references = this.references.slice(state.referenceStart);
        if (references.some(ref => ref.absoluteFile !== file || ref.verdict !== 'no')) return;
        const value = [...lines].map(([line, slot]) =>
            ['line', line, slot.skips, slot.skipColumns.slice(), slot.text, slot.tokens]);
        for (const ref of references) value.push(['reference', ref.line, ref.column,
            ref.accessKind, ref.reason, ref.receiver ?? null]);
        require('./cache').storeUsageResult(this.index, file, this.name, state.mode, value);
    }

    siteArity() { return null; }

    valueScope(file, line, column = null) {
        const language = this.index.files.get(file)?.language;
        const reader = langTraits(language)?.valueScopes;
        if (!reader) return null;
        if (!this.scopeMemo.has(file)) this.scopeMemo.set(file,
            reader(this.index._readFile(file), getParser(language)));
        const scopes = this.scopeMemo.get(file).filter(scope => line - 1 >= scope.startRow &&
            line - 1 <= scope.endRow && (column == null ||
                (line - 1 !== scope.startRow || column >= scope.startCol) &&
                (line - 1 !== scope.endRow || column < scope.endCol)));
        const identities = new Set(scopes.map(scope => scope.module
            ? `module:${scope.startRow}:${scope.startCol}` : 'classic'));
        return identities.size === 1 ? [...identities][0] : 'unknown';
    }

    scopeRelation(file, definitionLine, node, definitionColumn = null) {
        const declared = this.valueScope(file, definitionLine, definitionColumn);
        if (declared == null) return 'yes';
        const referenced = this.valueScope(file, node.startPosition.row + 1, node.startPosition.column);
        if (declared === 'unknown' || referenced === 'unknown') return 'unknown';
        if (declared === referenced) return 'yes';
        return declared === 'classic' ? 'unknown' : 'no';
    }

    valueStorage(definition) {
        return definition.modifiers?.includes('static') ||
            ownerRefOf(this.index, definition)?.def?.type === 'enum' ? 'class' : 'instance';
    }

    thisStorage(node) {
        for (let scope = node.parent; scope; scope = scope.parent) {
            if (scope.type === 'class_static_block') return 'class';
            if (['method_definition', 'field_definition', 'public_field_definition'].includes(scope.type) &&
                scope.parent?.type === 'class_body') {
                return scope.children.some(child => child.type === 'static') ? 'class' : 'instance';
            }
        }
        return null;
    }

    patternReference(file, node, role) {
        if (!this.patternConstant || !role.binding) return null;
        for (let current = node; current?.parent; current = current.parent) {
            const parent = current.parent;
            const pattern = parent.childForFieldName('pattern');
            if (pattern && contains(pattern, node)) {
                return this.resolveName(file, node.startPosition.row + 1);
            }
            if (CALLABLE_SCOPES.has(parent.type) || ROOTS.has(parent.type)) break;
        }
        return null;
    }

    enumInfo(definition) {
        if (this.enumMemo.has(definition)) return this.enumMemo.get(definition);
        const result = enumValueBindingInfo(this.index, definition);
        this.enumMemo.set(definition, result);
        return result;
    }

    fileTypes(file, name = this.name) {
        return (this.index.symbols.get(name) || []).filter(d => d.file === file &&
            isValueDefinition(d) && !d.className && (!this.siteNode ||
                this.scopeRelation(file, d.nameLine || d.startLine, this.siteNode) !== 'no'));
    }

    syntaxNodes(file, tree, name) {
        const key = `${file}\0${tree.rootNode.id}\0${name}`;
        if (this.syntaxMemo.has(key)) return this.syntaxMemo.get(key);
        const language = GRAMMAR_LANGUAGES.get(tree.language?.name) || this.index.files.get(file)?.language;
        const source = typeof tree.input === 'string' ? tree.input : this.index._readFile(file);
        const nodes = [];
        visitNameNodes(tree, source, name, node => {
            if (node.text !== name) return true;
            const role = referenceRole(node, language);
            const declarationName = role.binding && role.why === 'function' &&
                CALLABLE_SCOPES.has(node.parent?.type);
            // Ordinary references need their token and role; only a binding
            // needs the scope in which it declares the name.
            let scope = role.binding
                ? referenceBindingScope(declarationName ? node.parent : node, language, role) : null;
            if (role.genericParameter) scope = referenceTypeParameterScope(node);
            if (role.binding && node.parent?.parent?.type === 'template_parameter_list') {
                scope = node.parent.parent.parent;
            }
            nodes.push({ node, role, scope });
            return true;
        });
        this.syntaxMemo.set(key, nodes);
        return nodes;
    }

    enumSyntaxFact(file, entry, token, receiver, qualifier, position, shape) {
        const { node, role } = token;
        if (['macro', 'template'].includes(role.role)) return {
            line: node.startPosition.row + 1, column: node.startPosition.column, at: node.startIndex,
            kind: 'opaque', sourceRole: role.role, accessKind: this.references.at(-1).accessKind,
        };
        const syntax = receiver || qualifier;
        if (position || shape?.uncertainRole || shape?.kind === 'initializer' ||
            !syntax || !TYPE_NAMES.has(syntax.type) ||
            !(receiver && role.role === 'member' || qualifier && role.role === 'value')) return null;
        for (let scope = node; scope; scope = scope.parent) {
            if (scope.type === 'ERROR' || CALLABLE_SCOPES.has(scope.type) && scope.hasError) return null;
        }
        if (receiver && this.localBinding(file, syntax, syntax.text, true)) return null;
        if (this.syntaxNodes(file, node.tree, syntax.text).some(binding => binding.role.typeParam &&
            contains(referenceTypeParameterScope(binding.node), syntax))) return null;
        let owner = null;
        for (let parent = syntax.parent; parent; parent = parent.parent) {
            if (!TYPE_BODIES.has(parent.type)) continue;
            const name = parent.childForFieldName('name');
            if (!name || !TYPE_NAMES.has(name.type)) return null;
            owner = { name: name.text, startLine: parent.startPosition.row + 1,
                endLine: parent.endPosition.row + 1 };
            break;
        }
        const context = langTraits(entry.language).enumReferenceContext?.(syntax) || null;
        return { line: node.startPosition.row + 1, column: node.startPosition.column,
            at: node.startIndex, receiver: syntax.text, kind: receiver ? 'member' : 'type', owner, context,
            accessKind: this.references.at(-1).accessKind };
    }

    selectedBinding(file, node) {
        if (this.owner || file !== this.def.file || node.startPosition.row + 1 !==
            (this.def.nameLine || this.def.startLine)) return false;
        const bindings = this.syntaxNodes(file, node.tree, this.name).filter(token =>
            token.node.startPosition.row === node.startPosition.row && token.role.binding &&
            token.role.why !== 'parameter' && !TYPE_BODIES.has(token.scope?.type) &&
            !['class_body', 'declaration_list', 'field_declaration_list'].includes(token.scope?.type));
        return bindings.length === 1 && sameNode(bindings[0].node, node);
    }

    localBinding(file, node, name, includeModule = false, contextualValue = false) {
        const language = this.index.files.get(file)?.language;
        let memo = this.lexicalScopeMemos.get(node.tree);
        if (!memo) { memo = new Map(); this.lexicalScopeMemos.set(node.tree, memo); }
        const lexical = referenceScope(node, language, memo, name);
        if (lexical === 'none' && !contextualValue) return { verdict: 'no', reason: 'non-value-position' };
        const bindings = this.syntaxNodes(file, node.tree, name).filter(binding =>
            binding.role.binding &&
            this.scopeRelation(file, binding.node.startPosition.row + 1, node,
                binding.node.startPosition.column) !== 'no' &&
            !(name === this.name && this.patternReference(file, binding.node, binding.role)?.verdict === 'yes') &&
            (includeModule || binding.scope && !ROOTS.has(binding.scope.type)) &&
            (binding.role.genericParameter || !TYPE_BODIES.has(binding.scope?.type)) &&
            !['class_body', 'declaration_list', 'field_declaration_list'].includes(binding.scope?.type) &&
            contains(binding.scope, node)).map(binding => ({ ...binding,
            scope: binding.scope || node.tree.rootNode }));
        if (!bindings.length) {
            if (lexical?.local && name === this.name && langTraits(language)?.moduleValueLookup &&
                this.resolveName(file, node.startPosition.row + 1).verdict === 'yes') return null;
            return lexical === 'unknown' || lexical?.local
                ? { verdict: 'unknown', reason: 'lexical-binding-unresolved' } : null;
        }
        bindings.sort((a, b) => (a.scope.endIndex - a.scope.startIndex) -
            (b.scope.endIndex - b.scope.startIndex) || b.node.startIndex - a.node.startIndex);
        const nearest = bindings[0];
        if (this.scopeRelation(file, nearest.node.startPosition.row + 1, node,
            nearest.node.startPosition.column) === 'unknown') {
            return { verdict: 'unknown', reason: 'script-binding-scope' };
        }
        if (name === this.name && this.patternReference(file, nearest.node, nearest.role)?.verdict === 'unknown') {
            return { verdict: 'unknown', reason: 'constant-pattern-binding' };
        }
        const sameScope = bindings.filter(binding => sameNode(binding.scope, nearest.scope));
        if (sameScope.length !== 1 || nearest.node.startIndex >= node.startIndex) {
            return { verdict: 'unknown', reason: 'lexical-binding-unresolved' };
        }
        return { binding: nearest,
            ...(name === this.name && this.selectedBinding(file, nearest.node) && { pin: true }) };
    }

    declarationNode(definition) {
        const file = definition.file, source = this.index._readFile(file);
        const language = this.index.files.get(file)?.language;
        for (const tree of declarationTrees(this.index, file, source, language)) {
            const declarations = this.syntaxNodes(file, tree, definition.name).filter(token =>
                token.node.startPosition.row + 1 === (definition.nameLine || definition.startLine) &&
                (token.role.role === 'decl' || token.role.binding ||
                    ['field-name', 'member-name', 'property-name'].includes(token.role.why)));
            if (declarations.length > 1) return null;
            if (declarations.length === 1) return declarations[0].role.declNode || declarations[0].node.parent;
        }
        return null;
    }

    typeVerdict(file, syntax, definition, useFile = file) {
        const resolver = new TypeReferenceResolver(this.index, definition, syntax.name);
        if (langTraits(this.index.files.get(file)?.language)?.textualIncludes &&
            TYPE_KINDS.has(definition.type) && !definition.aliasOf) {
            const canonical = completeForwardDeclaration(this.index, definition, useFile);
            resolver.group = new Set([canonical]);
            for (const other of resolver.all) {
                if (other.forwardDeclaration &&
                    completeForwardDeclaration(this.index, other, useFile) === canonical) resolver.group.add(other);
            }
            resolver.pinFiles = new Set([...resolver.group].map(d => d.file));
        }
        resolver.siteNode = syntax.node;
        resolver.siteFile = file;
        return langTraits(this.index.files.get(file)?.language)?.textualIncludes
            ? resolver.resolveCFamily(file, syntax.node.startPosition.row + 1,
                syntax.name, syntax.qualifierText || null,
                referenceRole(syntax.node, this.index.files.get(file)?.language))
            : syntax.qualifierText
            ? resolver.resolveQualified(file, syntax.node.startPosition.row + 1,
                syntax.qualifier, syntax.qualifierText, { role: 'type' })
            : resolver.resolveName(file, syntax.node.startPosition.row + 1, syntax.name);
    }

    classForType(file, syntax, runtime = false, useFile = file) {
        if (!syntax) return null;
        const unit = langTraits(this.language)?.textualIncludes ? useFile : '';
        const key = `${file}\0${syntax.node.startIndex}\0${syntax.name}\0${syntax.qualifierText || ''}\0${runtime}\0${unit}`;
        if (this.typeMemo.has(key)) return this.typeMemo.get(key);
        this.typeMemo.set(key, null); // Alias cycles never prove an owner.
        if (runtime && langTraits(this.index.files.get(file)?.language)?.typeSystem === 'structural') {
            if (this.localBinding(file, syntax.node, syntax.name, true)) return null;
            const rebound = this.syntaxNodes(file, syntax.node.tree, syntax.name).some(token =>
                isWrittenBinding(token.node) && !this.localBinding(file, token.node, syntax.name, true));
            if (rebound) return null;
        }
        const parameters = this.syntaxNodes(file, syntax.node.tree, syntax.name).some(token =>
            token.role.typeParam && contains(referenceTypeParameterScope(token.node), syntax.node));
        const matches = [];
        let uncertain = parameters;
        if (this.ambiguousClassFamily({ name: syntax.name })) uncertain = true;
        if (!parameters) for (const entry of classDefsNamed(this.index, syntax.name).entries) {
            if (entry.def.file === file && this.scopeRelation(file,
                entry.def.nameLine || entry.def.startLine, syntax.node) !== 'yes') {
                uncertain = true;
                continue;
            }
            const verdict = this.typeVerdict(file, syntax, entry.def, useFile);
            if (entry.def.forwardDeclaration && verdict.verdict !== 'no') this.sawForwardDeclaration = true;
            if (verdict.verdict === 'yes') {
                const complete = completeForwardDeclaration(this.index, entry.def, useFile);
                const resolved = complete === entry.def ? entry :
                    classDefsNamed(this.index, complete.name).entries.find(candidate => candidate.def === complete);
                if (resolved) matches.push(resolved);
                else uncertain = true;
            }
            if (verdict.verdict === 'unknown') uncertain = true;
        }
        if (!parameters) for (const alias of (this.index.symbols.get(syntax.name) || []).filter(d => d.type === 'type')) {
            const verdict = this.typeVerdict(file, syntax, alias, useFile);
            if (verdict.verdict === 'unknown') uncertain = true;
            if (verdict.verdict !== 'yes') continue;
            const declaration = this.declarationNode(alias);
            const target = declaration?.childForFieldName('type') || declaration?.childForFieldName('right');
            const owner = this.classForType(alias.file, typeSyntax(target), false, useFile);
            if (owner) matches.push(owner);
            else uncertain = true;
        }
        const keys = new Set(matches.map(entry => entry.key));
        const result = !uncertain && keys.size === 1
            ? { name: matches[0].def.name, key: matches[0].key, def: matches[0].def } : null;
        this.typeMemo.set(key, result);
        return result;
    }

    enclosingOwner(file, node, fallback = true) {
        for (let current = node.parent; current; current = current.parent) {
            if (!TYPE_BODIES.has(current.type)) continue;
            const nameNode = current.childForFieldName('name');
            const name = typeSyntax(nameNode)?.name || nameNode?.text;
            if (!name) {
                // Anonymous typedef records and class expressions acquire
                // their indexed name from the declaration that binds them.
                // Only the exact indexed body span proves their owner.
                const owners = this.members.filter(member => member.file === file &&
                    member.startLine >= current.startPosition.row + 1 &&
                    member.endLine <= current.endPosition.row + 1)
                    .map(member => ownerRefOf(this.index, member)).filter(owner =>
                        owner?.def?.startLine === current.startPosition.row + 1 &&
                        owner.def.endLine === current.endPosition.row + 1);
                if (new Set(owners.map(owner => owner.key)).size === 1) return { ...owners[0], node: current };
                continue;
            }
            const matches = classDefsNamed(this.index, name).entries.filter(entry =>
                entry.def.file === file && entry.def.startLine <= current.startPosition.row + 1 &&
                entry.def.endLine >= current.endPosition.row + 1);
            if (new Set(matches.map(entry => entry.key)).size === 1) return {
                name, key: matches[0].key, def: matches[0].def, node: current,
            };
            return null;
        }
        if (!fallback) return null;
        const member = this.index.findEnclosingFunction(file, node.startPosition.row + 1, true);
        return member?.className ? ownerRefOf(this.index, member) : null;
    }

    declarationOwner(file, node) {
        for (let current = node.parent; current; current = current.parent) {
            if (CALLABLE_SCOPES.has(current.type)) return null;
            if (current.type === 'object_type' || current.type === 'struct_type' &&
                current.parent?.type !== 'type_spec') return null;
            if (TYPE_BODIES.has(current.type)) return this.enclosingOwner(file, node);
        }
        return null;
    }

    privateValueAt(file, node) {
        let position = node;
        const visited = new Set();
        while (position) {
            const owner = this.enclosingOwner(file, position, false);
            if (!owner?.key || !owner.node || visited.has(owner.node.startIndex)) break;
            visited.add(owner.node.startIndex);
            const declared = this.members.filter(member => ownerRefOf(this.index, member)?.key === owner.key);
            if (declared.length) return this.judge(declared, 'other-private-owner');
            position = owner.node;
        }
        return { verdict: 'unknown', reason: 'private-member-owner-unresolved' };
    }

    memberAt(owner) {
        if (langTraits(this.language)?.typeArgumentValues === 'ordinary') return this.cppMemberAt(owner);
        if (!owner?.key || !this.owner?.key) return { verdict: 'unknown', reason: 'member-owner-unresolved' };
        if (this.ambiguousClassFamily(owner)) return { verdict: 'unknown', reason: 'value-owner-alternatives' };
        if (langTraits(this.language)?.separateStaticStorage && owner.valueStorage &&
            owner.valueStorage !== this.targetStorage) return { verdict: 'no', reason: 'other-value-storage' };
        if (this.memberMemo.has(owner.key)) return this.memberMemo.get(owner.key);
        const declaring = findDeclaringClass(this.index, owner, this.memberCandidates);
        if (!declaring || declaring.uncertain) return { verdict: 'unknown', reason: 'member-owner-unresolved' };
        if (declaring.members.length !== 1) return { verdict: 'unknown', reason: 'ambiguous-value-declaration' };
        const result = this.group.has(declaring.members[0]) ? { verdict: 'yes' }
            : langTraits(this.language)?.typeSystem === 'structural' &&
                (relationToTargets(this.index, owner, [this.def]) !== 'unrelated' ||
                 relationToTargets(this.index, this.owner, declaring.members) !== 'unrelated')
                ? { verdict: 'unknown', reason: 'inherited-value-shadow' }
            : { verdict: 'no', reason: 'other-member-owner' };
        this.memberMemo.set(owner.key, result);
        return result;
    }

    receiverOwner(file, receiver) {
        if (!receiver) return null;
        const traits = langTraits(this.index.files.get(file)?.language);
        if (receiver.type === 'base' || receiver.type === 'super') {
            if (traits.separateStaticStorage) return null;
            const owner = this.enclosingOwner(file, receiver);
            const bases = owner && parentRefsOf(this.index, owner).filter(ref =>
                ref.key && ['class', 'struct', 'record'].includes(ref.def?.type));
            return bases?.length === 1 ? bases[0] : null;
        }
        if (receiver.type === 'this' || traits.selfParam?.includes(receiver.text)) {
            if (traits.typeSystem === 'structural' && receiver.type === 'this') {
                for (let scope = receiver.parent; scope && scope.type !== 'class_body'; scope = scope.parent) {
                    if (FUNCTION_NODES.has(scope.type) ||
                        scope.type === 'method_definition' && scope.parent?.type !== 'class_body') return null;
                }
            }
            const owner = this.enclosingOwner(file, receiver);
            if (traits.separateStaticStorage) {
                const storage = this.thisStorage(receiver);
                return owner && storage ? { ...owner, valueStorage: storage } : null;
            }
            return owner;
        }
        if (receiver.type !== 'identifier' && receiver.type !== 'type_identifier') return null;
        const local = this.localBinding(file, receiver, receiver.text, true);
        if (local?.binding) {
            const type = declarationType(local.binding.node);
            if (!type?.syntax) return null;
            if (type.origin === 'constructor' && this.syntaxNodes(file, receiver.tree, receiver.text)
                .some(token => isWrittenBinding(token.node) && sameNode(
                    this.localBinding(file, token.node, receiver.text, true)?.binding?.node,
                    local.binding.node))) return null;
            const owner = this.classForType(file, type.syntax, type.origin === 'constructor');
            return owner && traits.separateStaticStorage ? { ...owner, valueStorage: 'instance' } : owner;
        }
        if (local) return null;
        if (traits.bareCallReachesMethods) {
            const owner = this.enclosingOwner(file, receiver);
            const members = (this.index.symbols.get(receiver.text) || []).filter(d => d.className);
            if (owner && findDeclaringClass(this.index, owner, members)) return null;
        }
        const owner = this.classForType(file, { name: receiver.text, node: receiver }, true);
        return owner && traits.separateStaticStorage ? { ...owner, valueStorage: 'class' } : owner;
    }

    ambiguousClassFamily(owner) {
        if (langTraits(this.language)?.typeArgumentValues !== 'ordinary' || !owner?.name) return false;
        const info = classDefsNamed(this.index, owner.name);
        return info.unique && info.entries.length > 1;
    }

    classValueMembers() {
        if (this._classValueMembers) return this._classValueMembers;
        const members = [], originals = new Map(), unresolved = [];
        for (const definition of this.index.symbols.get(this.name) || []) {
            if (TYPE_KINDS.has(definition.type) ||
                langTraits(this.index.files.get(definition.file)?.language)?.typeArgumentValues !== 'ordinary') continue;
            const info = isValueDefinition(definition) && this.enumInfo(definition);
            if (definition.className) members.push(definition);
            if (info?.unscoped) {
                if (info.scope?.type !== 'field_declaration_list') continue;
                let parent = this.enclosingOwner(definition.file, info.scope);
                if (!parent) parent = lexicalClassRefOf(this.index, ownerRefOf(this.index, definition)?.def);
                const body = info.scope.parent;
                if (!parent?.def || parent.def.startLine > body.startPosition.row + 1 ||
                    parent.def.endLine < body.endPosition.row + 1) {
                    unresolved.push(definition);
                    continue;
                }
                const member = { ...definition, className: parent.name, namespace: parent.def.namespace };
                members.push(member);
                originals.set(member, definition);
            }
        }
        this._classValueMembers = { members, originals, unresolved };
        return this._classValueMembers;
    }

    classBindingsVerdict(members, originals) {
        const definitions = members.map(member => originals.get(member) || member);
        if (!this.owner && !definitions.some(definition => this.group.has(definition)) &&
            !this.declarationNode(this.def)) return { verdict: 'unknown', reason: 'member-declaration-identity' };
        return this.judge(definitions, 'other-member-owner');
    }

    cppMemberAt(owner) {
        if (!owner?.key || this.ambiguousClassFamily(owner)) return { verdict: 'unknown', reason: 'member-owner-unresolved' };
        const bindings = this.classValueMembers();
        const declaring = findDeclaringClass(this.index, owner, bindings.members);
        return !declaring || declaring.uncertain ? { verdict: 'unknown', reason: 'member-owner-unresolved' }
            : this.classBindingsVerdict(declaring.members, bindings.originals);
    }

    qualifiedValueAt(file, qualifier, role) {
        const scopes = [];
        let global = false;
        for (let current = this.siteNode; current?.parent?.type === 'qualified_identifier' &&
            sameNode(current.parent.childForFieldName('name'), current); current = current.parent) {
            const scope = current.parent.childForFieldName('scope');
            if (scope) scopes.unshift(scope);
            else if (current.parent.children.some(child => child.type === '::')) global = true;
        }
        let syntax = typeSyntax(qualifier), text = qualifier.text;
        if (scopes.length && sameNode(scopes[scopes.length - 1], qualifier)) {
            text = `${global ? '::' : ''}${scopes.map(scope => scope.text).join('::')}`;
            if (syntax && (global || scopes.length > 1)) syntax = { ...syntax,
                qualifier: syntax.qualifier || scopes[scopes.length - 2],
                qualifierText: `${global ? '::' : ''}${[...scopes.slice(0, -1).map(scope => scope.text),
                    syntax.qualifierText].filter(Boolean).join('::')}` };
        }
        const owner = this.classForType(file, syntax);
        return owner ? this.cppMemberAt(owner)
            : this.resolveQualified(file, this.siteNode.startPosition.row + 1, qualifier, text, role);
    }

    classValueAt(file, node) {
        let owner = this.enclosingOwner(file, node);
        if (!owner) {
            for (let scope = node.parent; scope; scope = scope.parent) {
                if (TYPE_BODIES.has(scope.type)) return { verdict: 'unknown', reason: 'member-owner-unresolved' };
            }
            return null;
        }
        const bindings = this.classValueMembers();
        if (bindings.unresolved.length) {
            const visible = require('./cpp-scope').includeClosure(this.index, file);
            if (bindings.unresolved.some(definition => definition.file === file || visible.has(definition.file))) {
                return { verdict: 'unknown', reason: 'enum-member-owner-unresolved' };
            }
        }
        const lexical = new Set();
        while (owner) {
            if (!owner.key || lexical.has(owner.key) || this.ambiguousClassFamily(owner)) {
                return { verdict: 'unknown', reason: 'value-owner-alternatives' };
            }
            lexical.add(owner.key);
            const declaring = findDeclaringClass(this.index, owner, bindings.members);
            if (declaring?.uncertain) return { verdict: 'unknown', reason: 'member-owner-unresolved' };
            if (declaring?.members.length) return this.classBindingsVerdict(declaring.members, bindings.originals);
            const queue = [owner], visited = new Set();
            while (queue.length) {
                const current = queue.pop();
                if (visited.has(current.key)) continue;
                visited.add(current.key);
                for (const parent of parentRefsOf(this.index, current)) {
                    if (!parent.key || parent.external ||
                        langTraits(this.index.files.get(parent.def?.file)?.language)?.typeArgumentValues !== 'ordinary') {
                        return { verdict: 'unknown', reason: 'open-value-owner' };
                    }
                    queue.push(parent);
                }
            }
            const body = owner.node || this.declarationNode(owner.def);
            const sourceFile = owner.def.file;
            let outer = body && TYPE_BODIES.has(body.type) ? this.enclosingOwner(sourceFile, body, false) : null;
            if (!outer && body) {
                const qualifier = typeSyntax(body.childForFieldName('name'))?.qualifier;
                if (qualifier) outer = this.classForType(sourceFile, typeSyntax(qualifier));
            }
            if (!outer && owner.def.enclosingType) return { verdict: 'unknown', reason: 'member-owner-unresolved' };
            owner = outer;
        }
        return null;
    }

    localUsingAt(file, node) {
        if (!this._usingMemo) this._usingMemo = new Map();
        const key = `${file}\0${node.tree.rootNode.id}`;
        if (!this._usingMemo.has(key)) this._usingMemo.set(key, node.tree.rootNode.descendantsOfType('using_declaration'));
        const visible = this._usingMemo.get(key).filter(declaration => declaration.startIndex < node.startIndex)
            .map(declaration => ({ declaration, scope: referenceBindingScope(declaration,
                this.index.files.get(file)?.language, { role: 'import' }) }))
            .filter(({ scope }) => scope && !ROOTS.has(scope.type) &&
                scope.type !== 'field_declaration_list' && contains(scope, node))
            .sort((a, b) => (a.scope.endIndex - a.scope.startIndex) -
                (b.scope.endIndex - b.scope.startIndex) || b.declaration.startIndex - a.declaration.startIndex);
        for (const { declaration } of visible) {
            const syntax = typeSyntax(declaration.namedChild(0));
            if (declaration.children.some(child => child.type === 'enum')) {
                const owner = this.classForType(file, syntax);
                if (!owner || owner.def.type !== 'enum') return { verdict: 'unknown', reason: 'using-enum-binding' };
                const declared = (this.index.symbols.get(this.name) || []).filter(definition =>
                    isValueDefinition(definition) && ownerRefOf(this.index, definition)?.key === owner.key);
                if (declared.length) return this.judge(declared);
            } else if (syntax?.name === this.name) {
                if (this.ordinaryArgumentPosition(file, declaration.namedChild(0)) !== 'value') {
                    return { verdict: 'unknown', reason: 'using-declaration-binding' };
                }
                return syntax.qualifier ? this.qualifiedValueAt(file, syntax.qualifier, { role: 'qualified' })
                    : { verdict: 'unknown', reason: 'using-declaration-binding' };
            }
        }
        return null;
    }

    globalAt(file, node, contextualValue = false) {
        const traits = langTraits(this.index.files.get(file)?.language);
        const scope = file === this.def.file && this.scopeRelation(file,
            this.def.nameLine || this.def.startLine, node);
        if (scope && scope !== 'yes') return { verdict: scope === 'no' ? 'no' : 'unknown',
            reason: 'script-binding-scope' };
        const local = this.localBinding(file, node, this.name, false, contextualValue);
        if (local) return local.pin ? { verdict: 'yes' }
            : local.binding ? { verdict: 'no', reason: 'local-binding' } : local;
        if (traits.typeArgumentValues === 'ordinary') {
            const imported = this.localUsingAt(file, node);
            if (imported) return imported;
        }
        if (traits.textualIncludes) {
            const enumScope = enclosingEnum(node);
            if (enumScope) {
                const earlier = (this.index.symbols.get(this.name) || []).filter(definition => {
                    if (definition.file !== file || !isValueDefinition(definition)) return false;
                    const info = this.enumInfo(definition);
                    return info && sameNode(info.enumNode, enumScope) && info.node.startIndex < node.startIndex;
                });
                return earlier.length ? this.judge(earlier)
                    : { verdict: 'unknown', reason: 'enum-initializer-binding' };
            }
            const locals = (this.index.symbols.get(this.name) || []).filter(definition =>
                isValueDefinition(definition) && definition.file === file)
                .map(definition => ({ definition, info: this.enumInfo(definition) }))
                .filter(choice => choice.info?.unscoped && choice.info.scope &&
                    !ROOTS.has(choice.info.scope.type) && choice.info.scope.type !== 'field_declaration_list' &&
                    contains(choice.info.scope, node) && choice.info.node.startIndex < node.startIndex);
            if (locals.length) {
                const width = choice => choice.info.scope.endIndex - choice.info.scope.startIndex;
                const closest = Math.min(...locals.map(width));
                return this.judge(locals.filter(choice => width(choice) === closest).map(choice => choice.definition));
            }
        }
        if (traits.typeArgumentValues === 'ordinary') {
            return this.classValueAt(file, node) || this.resolveName(file, node.startPosition.row + 1);
        }
        if (traits.bareCallReachesMethods) {
            const owner = this.enclosingOwner(file, node);
            const members = (this.index.symbols.get(this.name) || []).filter(d => d.className);
            if (owner && findDeclaringClass(this.index, owner, members)) {
                return { verdict: 'no', reason: 'member-binding' };
            }
        }
        const ownEnum = this.enumInfo(this.def)?.unscoped;
        const localEnums = traits.textualIncludes ? (this.index.symbols.get(this.name) || []).filter(definition =>
            isValueDefinition(definition) && definition.file === file)
            .map(definition => ({ definition, info: this.enumInfo(definition) }))
            .filter(choice => choice.info && !ROOTS.has(choice.info.scope?.type) &&
                contains(choice.info.scope, node) && choice.info.node.startIndex < node.startIndex) : [];
        if (ownEnum || localEnums.length) {
            const choices = ownEnum ? this.all.filter(definition => definition.file === file)
                .map(definition => ({ definition, info: this.enumInfo(definition) }))
                .filter(choice => choice.info && contains(choice.info.scope, node) &&
                    choice.info.node.startIndex < node.startIndex) : localEnums;
            if (!choices.length) return { verdict: 'unknown', reason: 'enum-value-scope' };
            const width = choice => choice.info.scope
                ? choice.info.scope.endIndex - choice.info.scope.startIndex : Infinity;
            const closest = Math.min(...choices.map(width));
            return this.judge(choices.filter(choice => width(choice) === closest).map(choice => choice.definition));
        }
        if (traits?.moduleValueLookup || traits?.textualIncludes) {
            return this.resolveName(file, node.startPosition.row + 1);
        }
        const visible = this.visibleInFile(file, node.startPosition.row + 1);
        if (visible.length) return this.judge(visible);
        return this.resolveName(file, node.startPosition.row + 1);
    }

    staticImportAt(file, node, sourceToken = false) {
        const traits = langTraits(this.index.files.get(file)?.language);
        const imports = traits.staticValueImportSyntax?.(node.tree) || [];
        const verdicts = [];
        for (const imported of imports) {
            if (imported.member !== '*' && imported.member !== this.name) continue;
            if (sourceToken && imported.token && !sameNode(imported.token, node)) continue;
            const owner = this.classForType(file, typeSyntax(imported.type));
            if (!owner) { verdicts.push({ verdict: 'unknown', reason: 'static-value-import' }); continue; }
            const declaring = findDeclaringClass(this.index, owner, this.members);
            if (!declaring) continue;
            if (!declaring.members.every(member => member.type === 'constant' ||
                ['enum', 'interface'].includes(declaring.ref?.def?.type) ||
                member.modifiers?.some(modifier => modifier === 'static' || modifier === 'const'))) continue;
            verdicts.push(this.memberAt(owner));
        }
        return verdicts.length ? this.combine(verdicts) : null;
    }

    enumCaseAt(file, node) {
        if (!langTraits(this.index.files.get(file)?.language)?.implicitEnumCaseLabels) return null;
        let label = node.parent;
        while (label && label.type !== 'switch_label' && label.type !== 'block') label = label.parent;
        if (label?.type !== 'switch_label') return null;
        let statement = label.parent;
        while (statement && !['switch_expression', 'switch_statement'].includes(statement.type)) statement = statement.parent;
        let selector = statement?.childForFieldName('condition') || statement?.childForFieldName('value');
        while (selector?.type === 'parenthesized_expression') selector = selector.namedChild(0);
        const owner = selector && this.receiverOwner(file, selector);
        return owner?.def?.type === 'enum' ? this.memberAt(owner)
            : { verdict: 'unknown', reason: 'enum-selector-type' };
    }

    ordinaryArgumentPosition(file, argument) {
        const syntax = typeSyntax(argument);
        if (!syntax) return 'unknown';
        for (const definition of (this.index.symbols.get(this.name) || []).filter(d => TYPE_KINDS.has(d.type) &&
            langTraits(this.index.files.get(d.file)?.language)?.nameReferenceFamily === 'c')) {
            if (this.typeVerdict(file, syntax, definition).verdict !== 'no') return 'unknown';
        }
        return 'value';
    }

    initializerArgumentPosition(file, node, argument, role) {
        const parameter = argument.parent;
        if (parameter?.type !== 'parameter_declaration' || parameter.childForFieldName('declarator') ||
            !sameNode(parameter.childForFieldName('type'), argument)) return null;
        const fn = parameter.parent?.parent;
        if (parameter.parent?.type !== 'parameter_list' || fn?.type !== 'function_declarator') return null;
        let name = fn.childForFieldName('declarator');
        while (name?.type === 'parenthesized_declarator' && name.namedChildCount === 1) name = name.namedChild(0);
        if (!['identifier', 'qualified_identifier'].includes(name?.type)) return null;
        let declarator = fn;
        while (['pointer_declarator', 'reference_declarator', 'parenthesized_declarator',
            'attributed_declarator'].includes(declarator.parent?.type)) declarator = declarator.parent;
        const declaration = declarator.parent;
        if (declaration?.type !== 'declaration') return null;
        const head = declaration.childForFieldName('type');
        if (head?.type === 'primitive_type' && head.text === 'void' && sameNode(declarator, fn)) return null;
        const syntax = typeSyntax(argument);
        if (!syntax || !sameNode(syntax.node, node)) return null;
        const binding = syntax.qualifier
            ? this.qualifiedValueAt(file, syntax.qualifier, role) : this.globalAt(file, node, true);
        if (binding.verdict === 'no') return 'value';
        return binding.verdict === 'yes' && this.ordinaryArgumentPosition(file, argument) === 'value'
            ? 'value' : 'initializer-unknown';
    }

    typePosition(file, node, role) {
        const traits = langTraits(this.index.files.get(file)?.language);
        let argument = node;
        while (['qualified_identifier', 'scoped_type_identifier', 'type_descriptor'].includes(argument.parent?.type)) {
            const parent = argument.parent;
            if (parent.type === 'type_descriptor' && parent.namedChildCount !== 1) break;
            argument = parent;
        }
        const list = argument.parent;
        if (traits.typeArgumentValues === 'ordinary') {
            const initializer = this.initializerArgumentPosition(file, node, argument, role);
            if (initializer) return initializer;
        }
        if (traits.valuePatternConstants && this.def.type === 'variant' &&
            ['struct_expression', 'struct_pattern'].includes(list?.type) &&
            ['name', 'type'].some(field => {
                const part = list.childForFieldName(field);
                return part && contains(part, argument);
            })) return 'value';
        if (traits.typeArgumentValues === 'ordinary' &&
            ['sizeof_expression', 'alignof_expression', 'typeid_expression'].includes(list?.type)) {
            return this.ordinaryArgumentPosition(file, argument);
        }
        if (traits.typeArgumentValues && ['template_argument_list', 'type_arguments'].includes(list?.type)) {
            if (this.syntaxNodes(file, node.tree, this.name).some(token => token.role.typeParam &&
                contains(referenceTypeParameterScope(token.node), node))) return 'type';
            if (traits.typeArgumentValues === 'ordinary') {
                // A class/typedef hidden in the ordinary lookup can make
                // this grammar's type-like template argument a type.
                // Unsettled collisions remain review items.
                return this.ordinaryArgumentPosition(file, argument);
            }
            const head = list.parent;
            const syntax = typeSyntax(head?.childForFieldName('type') || head?.childForFieldName('function'));
            if (!syntax) return 'unknown';
            let definition = this.classForType(file, syntax)?.def;
            if (!definition && head.type === 'generic_function') {
                const functions = (this.index.symbols.get(syntax.name) || []).filter(d => d.type === 'function' && !d.className);
                const matches = [];
                let uncertain = false;
                for (const candidate of functions) {
                    const resolver = new TypeReferenceResolver(this.index, candidate, syntax.name);
                    resolver.all = functions;
                    resolver.group = new Set([candidate]);
                    resolver.declarationKinds = new Set(['function']);
                    resolver.siteNode = syntax.node;
                    resolver.siteFile = file;
                    const verdict = syntax.qualifierText
                        ? resolver.resolveQualified(file, node.startPosition.row + 1,
                            syntax.qualifier, syntax.qualifierText, { role: 'value' })
                        : resolver.resolveName(file, node.startPosition.row + 1, syntax.name);
                    if (verdict.verdict === 'yes') matches.push(candidate);
                    if (verdict.verdict === 'unknown') uncertain = true;
                }
                if (!uncertain && matches.length === 1) definition = matches[0];
            }
            if (!definition) return 'unknown';
            const parameters = this.declarationNode(definition)?.childForFieldName('type_parameters')?.namedChildren
                .filter(parameter => parameter.type !== 'lifetime_parameter');
            const args = list.namedChildren.filter(arg => arg.type !== 'lifetime');
            const at = args.findIndex(arg => sameNode(arg, argument));
            const parameter = at >= 0 && parameters?.[at];
            return parameter ? parameter.type === 'const_parameter' ? 'value' : 'type' : 'unknown';
        }
        if (traits.typeArgumentValues === 'ordinary' && role.cppQualified && !role.qualifierSegment) {
            const parent = argument.parent;
            if (parent?.type === 'using_declaration') return this.ordinaryArgumentPosition(file, argument);
            const declaredType = parent?.childForFieldName('type');
            if (declaredType && contains(declaredType, argument)) return 'type';
            if (parent && (parent.childForFieldName('value') && contains(parent.childForFieldName('value'), argument) ||
                parent.childForFieldName('default_value') && contains(parent.childForFieldName('default_value'), argument) ||
                ['return_statement', 'argument_list', 'binary_expression', 'assignment_expression',
                    'conditional_expression', 'unary_expression', 'expression_statement', 'initializer_list',
                    'case_statement', 'for_range_loop'].includes(parent.type) || parent.type.endsWith('_expression'))) return 'value';
            if (parent?.type === 'call_expression' && sameNode(parent.childForFieldName('function'), argument)) return 'value';
            return 'unknown';
        }
        return 'type';
    }

    declarationRegion(file, node, role) {
        if (this.owner) {
            const owner = this.declarationOwner(file, node);
            if (owner?.node) return `type:${owner.node.startIndex}:${owner.node.endIndex}`;
        }
        const namespaces = [];
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (CALLABLE_SCOPES.has(parent.type) || TYPE_BODIES.has(parent.type)) break;
            if (parent.type === 'namespace_definition' || parent.type === 'mod_item') {
                namespaces.unshift(parent.childForFieldName('name')?.text || '<anonymous>');
            }
        }
        if (namespaces.length) return `namespace:${namespaces.join('::')}`;
        const scope = referenceBindingScope(node, this.index.files.get(file)?.language, role) || node.tree.rootNode;
        return `scope:${scope.type}:${scope.startIndex}:${scope.endIndex}`;
    }

    decideToken(file, entry, token) {
        const { node } = token;
        let { role } = token;
        const position = role.role === 'type' ? this.typePosition(file, node, role) : null;
        const contextualValue = position === 'value';
        if (contextualValue) role = { ...role, role: 'value' };
        const receiver = memberReceiver(node, role);
        let declaration = false;
        let verdict;
        const parent = node.parent;
        const privateToken = node.type === 'private_property_identifier';
        const privateDeclaration = privateToken &&
            ['field_definition', 'public_field_definition', 'method_definition'].includes(parent?.type) &&
            sameNode(parent.childForFieldName('name') || parent.childForFieldName('property'), node);
        const pattern = ['field_initializer', 'field_pattern', 'shorthand_field_initializer',
            'field_designator'].includes(parent?.type);
        const objectKey = (parent?.type === 'pair' || parent?.type === 'pair_pattern') &&
            sameNode(parent.childForFieldName('key'), node);
        const shorthand = ['shorthand_property_identifier_pattern',
            'shorthand_property_identifier', 'shorthand_field_identifier'].includes(node.type);
        const declarationRole = role.role === 'skip' &&
            (role.binding || ['field-name', 'member-name', 'property-name', 'enumerator',
                'enum-constant', 'enum-member', 'variant'].includes(role.why));
        const callableValue = role.role === 'skip' && role.why === 'method-call' &&
            !langTraits(entry.language)?.fieldsAndMethodsSeparate;
        const qualifier = role.qualifier || (parent?.type === 'qualified_identifier' &&
            sameNode(parent.childForFieldName('name'), node) && parent.childForFieldName('scope'));
        const shape = this.owner && !declarationRole
            ? langTraits(entry.language)?.accessorReferenceShape?.(node.tree, {
                line: node.startPosition.row + 1, column: node.startPosition.column, usageType: 'reference',
            }) : null;
        const patternReference = this.patternReference(file, node, role);
        const scriptScope = file === this.def.file && this.scopeRelation(file,
            this.def.nameLine || this.def.startLine, node);
        if (privateToken) {
            declaration = privateDeclaration;
            verdict = this.privateValueAt(file, node);
        } else if (position === 'type' || role.role === 'decl') {
            verdict = { verdict: 'no', reason: 'non-value-position' };
        } else if (position === 'unknown' || position === 'initializer-unknown') {
            verdict = { verdict: 'unknown', reason: position === 'initializer-unknown'
                ? 'initializer-argument-binding' : 'generic-argument-namespace' };
        } else if (!this.owner && scriptScope === 'no') {
            declaration = declarationRole;
            verdict = { verdict: 'no', reason: 'other-script-scope' };
        } else if (scriptScope === 'unknown' && node.startPosition.row + 1 ===
            (this.def.nameLine || this.def.startLine)) {
            verdict = { verdict: 'unknown', reason: 'script-binding-scope' };
        } else if (patternReference && patternReference.verdict !== 'no') {
            verdict = patternReference;
        } else if (shorthand) {
            verdict = { verdict: 'unknown', reason: 'value-key-binding' };
        } else if (pattern || objectKey) {
            verdict = this.owner ? { verdict: 'unknown', reason: 'value-initializer-owner-unresolved' }
                : { verdict: 'no', reason: 'object-key' };
        } else if (shape?.uncertainRole) {
            verdict = { verdict: 'unknown', reason: 'value-role-unresolved' };
        } else if (shape?.kind === 'initializer') {
            verdict = this.memberAt(this.classForType(file, shape.type));
        } else if (receiver) {
            verdict = langTraits(entry.language)?.typeArgumentValues === 'ordinary'
                ? this.cppMemberAt(this.receiverOwner(file, receiver))
                : this.owner ? this.memberAt(this.receiverOwner(file, receiver))
                : this.resolveQualified(file, node.startPosition.row + 1, receiver,
                    receiver.text, { role: 'member' });
        } else if (qualifier && role.role !== 'import') {
            verdict = langTraits(entry.language)?.typeArgumentValues === 'ordinary'
                ? this.qualifiedValueAt(file, qualifier, role)
                : this.owner ? this.memberAt(this.classForType(file, typeSyntax(qualifier)))
                : this.resolveQualified(file, node.startPosition.row + 1, qualifier,
                    qualifier.text, role);
        } else if (role.role === 'qualified') {
            verdict = { verdict: 'unknown', reason: 'qualified-value-unresolved' };
        } else if (role.role === 'import' && this.owner) {
            verdict = this.staticImportAt(file, node, true) ||
                { verdict: 'unknown', reason: 'value-import-unresolved' };
        } else if (role.role === 'import') {
            verdict = referenceImportVerdict(this, file, entry, token);
        } else if (!callableValue && (role.role === 'skip' || role.role === 'decl')) {
            if (!declarationRole) verdict = { verdict: 'no', reason: 'non-value-position' };
            else {
                declaration = true;
                const selectedLine = this.def.nameLine || this.def.startLine;
                const sameOwner = this.owner && this.declarationOwner(file, node)?.key === this.owner.key;
                const sameDeclaration = file === this.def.file && node.startPosition.row + 1 === selectedLine;
                const enumDeclaration = this.enumInfo(this.def)?.node;
                const selectedEnum = enumDeclaration && sameDeclaration &&
                    node.startPosition.column === enumDeclaration.startPosition.column;
                const scope = referenceBindingScope(node, entry.language, role);
                const globalDeclaration = !this.owner && !this.declarationOwner(file, node) &&
                    (!scope || ROOTS.has(scope.type));
                const otherOwner = this.owner && this.declarationOwner(file, node);
                const related = otherOwner && langTraits(this.language)?.typeSystem === 'structural' &&
                    (relationToTargets(this.index, otherOwner, [this.def]) !== 'unrelated' ||
                        relationToTargets(this.index, this.owner, this.members.filter(member =>
                            ownerRefOf(this.index, member)?.key === otherOwner.key)) !== 'unrelated');
                verdict = sameDeclaration && (globalDeclaration || sameOwner || selectedEnum ||
                    this.selectedBinding(file, node))
                    ? { verdict: 'yes' } : { verdict: 'no', reason: 'other-declaration' };
                const declaredStorage = langTraits(this.language)?.separateStaticStorage && this.thisStorage(node);
                if (sameDeclaration && sameOwner && declaredStorage) this.declarationStorages.add(declaredStorage);
                if (verdict.verdict === 'no' && declaredStorage && declaredStorage !== this.targetStorage) {
                    verdict = { verdict: 'no', reason: 'other-value-storage' };
                } else if (verdict.verdict === 'no' && sameOwner) {
                    verdict = { verdict: 'unknown', reason: 'value-declaration-identity' };
                    declaration = false;
                } else if (verdict.verdict === 'no' && related) {
                    verdict = { verdict: 'unknown', reason: 'inherited-value-shadow' };
                    declaration = false;
                } else if (verdict.verdict === 'no' && this.owner && !otherOwner &&
                    ['field-name', 'member-name', 'property-name'].includes(role.why)) {
                    verdict = { verdict: 'unknown', reason: 'value-member-owner-unresolved' };
                    declaration = false;
                } else if (verdict.verdict === 'no' && !this.owner &&
                    (sameDeclaration || globalDeclaration && file === this.def.file)) {
                    const traits = langTraits(entry.language);
                    const lookup = traits.moduleValueLookup || traits.textualIncludes
                        ? this.resolveName(file, node.startPosition.row + 1) : null;
                    if (lookup?.verdict !== 'no') {
                        verdict = { verdict: 'unknown', reason: 'value-declaration-identity' };
                        declaration = false;
                    }
                }
            }
        } else if (callableValue || role.role === 'value' || role.role === 'pin-binding' || role.role === 'dunder-all') {
            const local = this.localBinding(file, node, this.name, false, contextualValue);
            if (local) verdict = local.pin ? { verdict: 'yes' }
                : local.binding ? { verdict: 'no', reason: 'local-binding',
                    fileLocalOnly: this.sourceLocalBinding(file, local.binding, node) } : local;
            else if (langTraits(entry.language)?.textualIncludes && enclosingEnum(node)) {
                verdict = this.globalAt(file, node, contextualValue);
            }
            else if (langTraits(entry.language)?.typeArgumentValues === 'ordinary') {
                verdict = this.globalAt(file, node, contextualValue);
            }
            else if (this.enumInfo(this.def)?.unscoped) verdict = this.globalAt(file, node, contextualValue);
            else if (this.owner) {
                verdict = this.enumCaseAt(file, node);
                if (!verdict) {
                    const owner = this.enclosingOwner(file, node);
                    verdict = langTraits(entry.language)?.bareCallReachesMethods
                        ? this.memberAt(owner) : null;
                    if ((!verdict || verdict.verdict === 'unknown') &&
                        (!owner || !findDeclaringClass(this.index, owner, this.members))) {
                        verdict = this.staticImportAt(file, node) || verdict;
                    }
                }
                verdict ||= { verdict: 'unknown', reason: 'implicit-value-owner-unresolved' };
            }
            else verdict = this.globalAt(file, node, contextualValue);
        } else verdict = role.role === 'type'
            ? { verdict: 'no', reason: 'non-value-position' }
            : { verdict: 'unknown', reason: 'value-binding-unresolved' };
        if (declaration && verdict.verdict === 'yes') {
            this.selectedDeclarations++;
            if (privateToken) this.privateIdentifier = true;
            this.declarationRegions.add(this.declarationRegion(file, node, role));
        }
        if (!declaration) {
            const line = node.startPosition.row + 1;
            this.references.push({ file: entry.relativePath, absoluteFile: file, line,
                column: node.startPosition.column, expression: this.index.getLineContent(file, line).trim(),
                ...(receiver && { receiver: receiver.text }),
                accessKind: require('./accessors').referenceAccessKind(node.tree,
                    { line, column: node.startPosition.column }, node),
                verdict: verdict.verdict, reason: verdict.reason });
            if (this.enumReferenceSyntax?.collecting(file)) {
                this.enumReferenceSyntax.capture(file,
                    this.enumSyntaxFact(file, entry, token, receiver, qualifier, position, shape));
            }
        }
        if (verdict.verdict === 'no' && role.binding &&
            this.sourceLocalBinding(file, { node, role,
                scope: referenceBindingScope(node, entry.language, role) })) verdict.fileLocalOnly = true;
        return verdict;
    }
}

function valueReferenceSites(index, def, name, groundSet) {
    if (!isValueDefinition(def)) return null;
    const resolver = new ValueReferenceResolver(index, def, name);
    const result = typeReferenceSites(index, def, name, groundSet, resolver);
    // A line handle cannot distinguish declarations in separate indexed
    // scopes, even when lookup has selected one of their owners internally.
    const selectedLine = def.nameLine || def.startLine;
    const indexedScopes = new Set((index.symbols.get(name) || []).filter(candidate =>
        isValueDefinition(candidate) && candidate.file === def.file &&
        (candidate.nameLine || candidate.startLine) === selectedLine &&
        (candidate.className || null) === (def.className || null))
        .map(candidate => JSON.stringify([candidate.namespace || null, candidate.enclosingType || null,
            candidate.lexicalScopeStartLine ?? null, candidate.lexicalScopeEndLine ?? null])));
    const ambiguityReason = resolver.declarationStorages.size > 1 ? 'storage'
        : resolver.declarationRegions.size > 1 || indexedScopes.size > 1 ? 'scope' : null;
    const ambiguousDeclaration = ambiguityReason !== null;
    if (ambiguousDeclaration) {
        for (const info of result.files.values()) for (const slot of info.lines.values()) {
            for (const column of slot.edits) slot.reviews.push({ column, reason: 'ambiguous-value-declaration' });
            slot.edits = [];
        }
        for (const reference of resolver.references) {
            if (reference.verdict === 'yes' || reference.reason === 'other-value-storage') {
                reference.verdict = 'unknown';
                reference.reason = 'ambiguous-value-declaration';
            }
        }
    }
    if (!resolver.selectedDeclarations) {
        const line = def.nameLine || def.startLine;
        const info = result.files.get(def.file);
        const slot = info?.lines.get(line);
        if (slot && !slot.reviews.some(review => review.reason === 'value-declaration-identity')) {
            slot.reviews.push({ column: null, reason: 'value-declaration-identity' });
        }
    }
    return { ...result, ambiguousDeclaration, ambiguityReason,
        privateIdentifier: resolver.privateIdentifier === true, references: resolver.references };
}

function findValueReferences(index, name, def, options = {}) {
    if (!isValueDefinition(def)) return null;
    const { computeGroundSet } = require('./account');
    const result = valueReferenceSites(index, def, name, computeGroundSet(index, name));
    const byFile = new Map(), unverifiedSites = [], excluded = [];
    const compare = require('./shared').codeUnitCompare;
    const references = result.references.slice().sort((a, b) => compare(a.file, b.file) ||
        a.line - b.line || a.column - b.column);
    for (const ref of references) {
        if (!index.matchesFilters(ref.file, options)) continue;
        const { verdict, absoluteFile, ...site } = ref;
        if (options.files && !options.files.has(absoluteFile)) continue;
        if (verdict === 'yes') {
            if (!byFile.has(site.file)) byFile.set(site.file, []);
            byFile.get(site.file).push({ ...site, tier: 'confirmed' });
        } else if (verdict === 'unknown') unverifiedSites.push({ ...site, tier: 'unverified' });
        else excluded.push(site);
    }
    const sorted = [...byFile].sort((a, b) => compare(a[0], b[0]))
        .map(([file, sites]) => ({ file, count: sites.length, sites }));
    return { confirmedCount: sorted.reduce((n, group) => n + group.count, 0),
        unverifiedCount: unverifiedSites.length,
        totalCandidates: sorted.reduce((n, group) => n + group.count, 0) + unverifiedSites.length,
        byFile: sorted, unverifiedSites, excluded: { total: excluded.length,
            byReason: excluded.reduce((out, site) => {
                out[site.reason] = (out[site.reason] || 0) + 1; return out;
            }, {}) } };
}

/** The class a field annotation denotes, completed only in this use's unit. */
function declaredFieldOwner(index, field, useFile) {
    const memo = index.isProvenanceFactIndex ? null
        : index._opMemo?.('declaredValueFieldOwners', () => new WeakMap());
    let byFile = memo?.get(field);
    if (byFile?.has(useFile)) return byFile.get(useFile);
    const resolver = new ValueReferenceResolver(index, field, field.name);
    const declaration = resolver.declarationNode(field);
    const type = declaration && declarationType(declaration);
    const owner = type?.syntax
        ? resolver.classForType(field.file, type.syntax, false, useFile || field.file) : null;
    const result = { owner, forward: !!resolver.sawForwardDeclaration };
    if (memo) {
        if (!byFile) memo.set(field, byFile = new Map());
        byFile.set(useFile, result);
    }
    return result;
}

/** A literal function body declares callable code at this value binding.
 * Reading another value, including a function pointer, proves no such body. */
function hasCallableInitializer(index, definition) {
    const memo = index._opMemo?.('valueCallableInitializers', () => new WeakMap());
    if (memo?.has(definition)) return memo.get(definition);
    const file = definition.file, source = index._readFile(file);
    const language = index.files.get(file)?.language;
    const tree = index._getParsedTree(file, source, language) || safeParse(getParser(language), source);
    const declarations = [];
    const literals = new Set(['function', 'function_expression', 'arrow_function',
        'generator_function', 'func_literal', 'lambda', 'closure_expression', 'lambda_expression']);
    if (tree) visitNameNodes(tree, source, definition.name, node => {
        if (node.startPosition.row + 1 !== (definition.nameLine || definition.startLine)) return true;
        for (let parent = node.parent; parent; parent = parent.parent) {
            if (['variable_declarator', 'assignment', 'var_spec', 'const_spec',
                'const_item', 'static_item', 'init_declarator'].includes(parent.type)) {
                const name = parent.childForFieldName('name') || parent.childForFieldName('left') ||
                    parent.childForFieldName('declarator');
                if (!name || !contains(name, node)) break;
                let value = parent.childForFieldName('value') || parent.childForFieldName('right');
                while (['expression_list', 'parenthesized_expression'].includes(value?.type) &&
                    value.namedChildCount === 1) value = value.namedChild(0);
                declarations.push(literals.has(value?.type));
                break;
            }
            if (CALLABLE_SCOPES.has(parent.type) || ROOTS.has(parent.type)) break;
        }
        return true;
    });
    const result = declarations.length === 1 && declarations[0];
    memo?.set(definition, result);
    return result;
}

module.exports = { isValueDefinition, valueReferenceSites, findValueReferences, hasCallableInitializer,
    enumValueBindingInfo, declaredFieldOwner };
