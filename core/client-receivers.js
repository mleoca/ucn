'use strict';

// Request verbs and receiver names discover candidates; only the value's
// origin can confirm HTTP. Shared by positional and configuration requests.
const rg = require('./route-graph');
const { RequestHelperProof, PY_HTTP_MODULES, pyImportedFunction } = require('./request-helpers');
const { PythonClientResolver } = require('./inprocess-clients');
const { field, namedChildren, unwrap, findDecl } = rg;

const PY_CLIENT_MODULES = [...PY_HTTP_MODULES, 'fastapi.testclient',
    'starlette.testclient', 'flask.testing', 'werkzeug.test', 'django.test'];
const PY_FACTORIES = new Set(['Session', 'Client', 'AsyncClient', 'TestClient',
    'FlaskClient', 'ClientSession', 'AsyncSession', 'HTTPConnection', 'HTTPSConnection',
    'PoolManager']);
const NOMINAL_CLIENTS = {
    go: ['net/http.Client', 'net/http'],
    rust: ['reqwest.Client', 'reqwest.blocking.Client', 'reqwest'],
    java: ['org.springframework.web.client.RestTemplate',
        'org.springframework.web.reactive.function.client.WebClient', 'java.net.http.HttpClient'],
    csharp: ['System.Net.Http.HttpClient'],
};
const HTTP_FRAMEWORK = { go: 'go-http', rust: 'reqwest', java: 'spring-client', csharp: 'dotnet-httpclient' };
const MAX_DEPTH = 12;

class ClientReceiverProof {
    constructor(index, sess) {
        this.index = index;
        this.sess = sess;
        this.helpers = new RequestHelperProof(index, sess);
        this.python = new PythonClientResolver(index, sess, () => new Set());
        this.memo = new Map();
    }

    classify(file, call) {
        const lang = this.sess.lang(file);
        if (['javascript', 'typescript', 'tsx'].includes(lang)) {
            if (!this.helpers.classify(file, call).proven) return null;
            const binding = this.helpers.jsBinding(file, call.receiver);
            const decl = call.receiver && findDecl(this.sess, file, call.receiver,
                this.sess.root(file)?.descendantForIndex(call.callStart, call.callStart));
            const module = binding?.binding.module || this.helpers.requireSpecOf(decl);
            return ['axios', 'ky', 'got'].includes(module) ? module : 'http-client';
        }
        if (lang === 'python') {
            const root = this.sess.root(file);
            const start = call.callSite?.start;
            if (!root || start == null) return null;
            let node = root.descendantForIndex(start, start);
            while (node && node.type !== 'call') node = node.parent;
            const fn = node && field(node, 'function');
            const receiver = fn?.type === 'attribute' ? unwrap(field(fn, 'object')) : null;
            if (!receiver) return null;
            if (PY_HTTP_MODULES.includes(this.pyModule(file, receiver))) return 'requests';
            const values = this.python.clientValues(file, call.line, call.receiver, call.name);
            if (!values?.length || !values.every(v => this.pyValue(v.file, v.expr, 0))) return null;
            return findDecl(this.sess, file, receiver.text, receiver)?.kind === 'param'
                ? 'pytest-client-fixture' : 'python-client';
        }
        return this.nominal(file, call, lang);
    }

    pyModule(file, expr) {
        if (expr?.type === 'identifier' && !findDecl(this.sess, file, expr.text, expr)) {
            const entry = this.sess.entry(file);
            const candidates = (entry?.importBindings || []).filter(b => (b.alias || b.name) === expr.text);
            const visible = candidates.filter(binding => {
                if (!binding.deferred) return true;
                const row = binding.line - 1;
                const imports = this.sess.root(file)?.descendantsOfType(
                    ['import_statement', 'import_from_statement'],
                    { row, column: 0 }, { row, column: 1 << 20 }) || [];
                return imports.some(node => {
                    let scope = node.parent;
                    while (scope && scope.type !== 'function_definition' && scope.type !== 'class_definition') scope = scope.parent;
                    return scope?.type === 'function_definition' && scope.startIndex <= expr.startIndex &&
                        scope.endIndex >= expr.endIndex;
                });
            });
            if (!visible.length || new Set(visible.map(b => `${b.kind}:${b.module}:${b.name}`)).size !== 1) return null;
            const binding = visible[0];
            if (entry.moduleResolved?.[binding.module]) return null;
            const module = binding.module;
            return PY_CLIENT_MODULES.includes(module)
                ? (binding.kind === 'from' ? `${module}.${binding.name}` : module) : null;
        }
        if (expr?.type === 'attribute') {
            const parent = this.pyModule(file, unwrap(field(expr, 'object')));
            return parent ? `${parent}.${field(expr, 'attribute')?.text}` : null;
        }
        return null;
    }

    pyValue(file, expr, depth) {
        const e = unwrap(expr);
        if (!e || depth > MAX_DEPTH) return false;
        const key = `${file}:${e.startIndex}:${e.endIndex}`;
        if (this.memo.has(key)) return this.memo.get(key);
        this.memo.set(key, false); // cycles cannot prove an origin
        let proven = false;
        if (e.type === 'identifier') {
            let fn = e.parent;
            while (fn && fn.type !== 'function_definition') fn = fn.parent;
            const value = this.python.followBinding(file, fn, e, 0);
            if (value && (value.file !== file || value.expr?.startIndex !== e.startIndex)) {
                proven = this.pyValue(value.file, value.expr, depth + 1);
            } else {
                const decl = findDecl(this.sess, file, e.text, e);
                if (decl?.count === 1 && decl.valueNode) proven = this.pyValue(file, decl.valueNode, depth + 1);
            }
        } else if (e.type === 'call') {
            const callee = unwrap(field(e, 'function'));
            const identity = this.pyModule(file, callee);
            if (identity && PY_FACTORIES.has(identity.split('.').pop())) proven = true;
            if (!proven) {
                // A helper must RETURN a proven client; merely performing
                // HTTP somewhere in its body does not type its return value.
                const decl = callee?.type === 'identifier' && findDecl(this.sess, file, callee.text, callee);
                let target = decl?.kind === 'function'
                    ? { kind: 'function', file, node: decl.valueNode }
                    : !decl && callee?.type === 'identifier' ? pyImportedFunction(this.sess, file, callee.text, 0) : null;
                if (decl?.kind === 'param') {
                    const fixture = this.python.fixtureDef(file, callee.text, decl.scope);
                    const provided = fixture && this.python.fixtureValue(fixture.file, fixture.fnNode, 0);
                    if (provided?.expr?.type === 'function_definition') {
                        target = { kind: 'function', file: provided.file, node: provided.expr };
                    } else if (provided?.expr?.type === 'call') {
                        const fn = field(provided.expr, 'function');
                        // functools.partial(Client) still constructs the
                        // imported client when the fixture is called.
                        const binding = fn?.type === 'attribute' &&
                            this.helpers.pyBinding(provided.file, field(fn, 'object')?.text);
                        if (binding?.module === 'functools' && field(fn, 'attribute')?.text === 'partial') {
                            const ctor = namedChildren(field(provided.expr, 'arguments'))[0];
                            const identity = this.pyModule(provided.file, ctor);
                            proven = !!identity && PY_FACTORIES.has(identity.split('.').pop());
                        }
                    }
                }
                if (target?.kind === 'function') {
                    const fnNode = target.node || target.decl?.valueNode;
                    const value = fnNode && this.python.fixtureValue(target.file, fnNode, 0);
                    if (value) proven = this.pyValue(value.file, value.expr, depth + 1);
                }
            }
        }
        this.memo.set(key, proven);
        return proven;
    }

    nominal(file, call, lang) {
        const known = NOMINAL_CLIENTS[lang];
        if (!known || call.localShadow || (call.isPathCall && call.receiverScopeBinding)) return null;
        const entry = this.sess.entry(file);
        const bindings = entry?.importBindings || [];
        const qualifies = name => {
            if (!name) return false;
            const normalized = name.replace(/::/g, '.').replace(/^[*&]+/, '');
            if (known.includes(normalized)) return true;
            return bindings.some(b => {
                const local = b.alias || b.name;
                const module = String(b.module || '').replace(/::/g, '.');
                return (normalized === local && (known.includes(module) || known.includes(`${module}.${b.name}`))) ||
                    (normalized.startsWith(local + '.') && known.includes(module + normalized.slice(local.length)));
            });
        };
        if (!call.receiverLocalBinding && !call.isMethod && qualifies(call.receiver)) return HTTP_FRAMEWORK[lang];
        if (call.isPathCall && qualifies(call.receiver)) return HTTP_FRAMEWORK[lang];
        const qualifier = call.receiverTypeQualifier || call.receiverTypeNamespace;
        const type = qualifier ? `${qualifier}.${call.receiverType}` : call.receiverType;
        if (qualifies(type)) return HTTP_FRAMEWORK[lang];
        // Java field receivers carry the enclosing owner rather than the
        // field type in the call record. Read the declared field's AST type.
        if (lang === 'java' && call.receiverRootType && call.receiverField) {
            const root = this.sess.root(file);
            for (const declaration of root?.descendantsOfType('field_declaration') || []) {
                let owner = declaration.parent;
                while (owner && owner.type !== 'class_declaration') owner = owner.parent;
                if (field(owner, 'name')?.text !== call.receiverRootType) continue;
                if (namedChildren(declaration).some(n => n.type === 'variable_declarator' &&
                    field(n, 'name')?.text === call.receiverField) && qualifies(field(declaration, 'type')?.text)) {
                    return HTTP_FRAMEWORK[lang];
                }
            }
        }
        return null;
    }
}

module.exports = { ClientReceiverProof };
