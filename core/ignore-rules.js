/**
 * core/ignore-rules.js - .gitignore rules compiled once, matched with git's
 * own semantics (gitignore(5); wildmatch with WM_PATHNAME).
 *
 * Every .gitignore file is one SCOPE: the directory it sits in (root-relative,
 * '/'-separated, '' for the project root) and its rules in file order. A path
 * is decided by the scopes of its ancestor directories, deepest first; within
 * a scope the LAST matching rule wins, so a `!negation` re-includes. A rule
 * with no slash (other than a trailing one) matches the basename at any depth
 * below its scope; any other rule matches the path relative to the scope
 * directory (a leading slash only anchors). A trailing slash restricts the
 * rule to directories. Discovery walks top-down and never admits an untracked
 * path below an excluded directory: git cannot re-include a file whose parent
 * directory is excluded.
 *
 * Matching is compiled per scope: literal basenames sit in a map, `*suffix`
 * rules in a list, path rules in buckets by slash depth (without `**` a rule
 * with k slashes can only match a path with k slashes). A query does no path
 * arithmetic per rule; each scope derives the scope-relative path once.
 *
 * Not modeled (same as before this module): .git/info/exclude, the user's
 * core.excludesFile, core.ignorecase, and .gitignore files above the project
 * root (an enclosing repository's rules; a home-directory repository that
 * ignores `*` must not empty every project below it).
 */

'use strict';

const GLOB_SPECIAL = /[*?[\\]/;

const POSIX_CLASSES = {
    alnum: 'A-Za-z0-9',
    alpha: 'A-Za-z',
    blank: ' \\t',
    cntrl: '\\x00-\\x1f\\x7f',
    digit: '0-9',
    graph: '\\x21-\\x7e',
    lower: 'a-z',
    print: '\\x20-\\x7e',
    punct: '!-\\/:-@\\[-`{-~',
    space: ' \\t\\n\\v\\f\\r',
    upper: 'A-Z',
    xdigit: '0-9A-Fa-f',
};

function escapeClassChar(ch) {
    const code = ch.charCodeAt(0);
    return '\\u' + code.toString(16).padStart(4, '0');
}

function escapeRegexChar(ch) {
    return /[\\^$.|?*+()[\]{}/]/.test(ch) ? '\\' + ch : ch;
}

/**
 * A wildmatch bracket expression starting at pattern[start] === '['.
 * Returns { source, end } (end = index after the closing bracket) or null
 * when the expression is malformed: wildmatch aborts the whole match then,
 * so the rule can never match.
 */
function compileBracket(pattern, start) {
    const n = pattern.length;
    let p = start + 1;
    let negated = false;
    if (pattern[p] === '!' || pattern[p] === '^') {
        negated = true;
        p++;
    }
    const members = [];
    let prev = null; // previous literal member (range low end), or null
    // do { ... } while (next char is not ']'): the first member may be ']'.
    for (;;) {
        if (p >= n) return null;
        const ch = pattern[p];
        let literal;
        if (ch === '\\') {
            p++;
            if (p >= n) return null;
            literal = pattern[p];
        } else if (ch === '-' && prev !== null && p + 1 < n && pattern[p + 1] !== ']') {
            p++;
            let hi = pattern[p];
            if (hi === '\\') {
                p++;
                if (p >= n) return null;
                hi = pattern[p];
            }
            // A reversed range matches nothing (wildmatch compares codes).
            if (prev <= hi) members.push(escapeClassChar(prev) + '-' + escapeClassChar(hi));
            prev = null;
            p++;
            if (p >= n) return null;
            if (pattern[p] === ']') break;
            continue;
        } else if (ch === '[' && pattern[p + 1] === ':') {
            const s = p + 2;
            let q = s;
            while (q < n && pattern[q] !== ']') q++;
            if (q >= n) return null;
            if (q - s - 1 < 0 || pattern[q - 1] !== ':') {
                // No ":]": the '[' is an ordinary member and scanning
                // resumes at the ':'.
                literal = '[';
            } else {
                const cls = POSIX_CLASSES[pattern.slice(s, q - 1)];
                if (!cls) return null; // malformed [:class:]
                members.push(cls);
                prev = null;
                p = q + 1;
                if (p >= n) return null;
                if (pattern[p] === ']') break;
                continue;
            }
        } else {
            literal = ch;
        }
        members.push(escapeClassChar(literal));
        prev = literal;
        p++;
        if (p >= n) return null;
        if (pattern[p] === ']') break;
    }
    const end = p + 1;
    const body = members.join('');
    // Under WM_PATHNAME a bracket never matches '/'.
    if (negated) return { source: `[^/${body}]`, end };
    return { source: body ? `(?!/)[${body}]` : '(?!)', end };
}

/**
 * Regex source for a wildmatch pattern with WM_PATHNAME semantics, or null
 * when the pattern can never match (malformed bracket, dangling escape).
 */
function wildmatchSource(pattern) {
    let out = '';
    const n = pattern.length;
    let i = 0;
    while (i < n) {
        const ch = pattern[i];
        if (ch === '\\') {
            if (i + 1 >= n) return null;
            out += escapeRegexChar(pattern[i + 1]);
            i += 2;
        } else if (ch === '?') {
            out += '[^/]';
            i++;
        } else if (ch === '*') {
            let j = i;
            while (j < n && pattern[j] === '*') j++;
            if (j - i >= 2 && (i === 0 || pattern[i - 1] === '/')) {
                if (j === n) { out += '.*'; i = j; continue; }
                if (pattern[j] === '/') { out += '(?:.*/)?'; i = j + 1; continue; }
                if (pattern[j] === '\\' && pattern[j + 1] === '/') { out += '.*'; i = j; continue; }
            }
            out += '[^/]*';
            i = j;
        } else if (ch === '[') {
            const bracket = compileBracket(pattern, i);
            if (!bracket) return null;
            out += bracket.source;
            i = bracket.end;
        } else {
            out += escapeRegexChar(ch);
            i++;
        }
    }
    return out;
}

/**
 * Number of '/' a path rule requires (bracket expressions never match '/'),
 * or -1 when `**` may span directories.
 */
function slashDepth(pattern) {
    let depth = 0;
    for (let i = 0; i < pattern.length; i++) {
        const ch = pattern[i];
        if (ch === '\\') {
            if (pattern[i + 1] === '/') depth++;
            i++;
        } else if (ch === '[') {
            const bracket = compileBracket(pattern, i);
            if (!bracket) return -1;
            i = bracket.end - 1;
        } else if (ch === '*' && pattern[i + 1] === '*') {
            return -1;
        } else if (ch === '/') {
            depth++;
        }
    }
    return depth;
}

/** Git's simple_length: characters before the first glob-special one. */
function literalPrefixLength(pattern) {
    const match = GLOB_SPECIAL.exec(pattern);
    return match ? match.index : pattern.length;
}

/** Git's trim_trailing_spaces: unescaped trailing spaces only. */
function trimTrailingSpaces(line) {
    let lastSpace = -1;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (ch === ' ') {
            if (lastSpace < 0) lastSpace = i;
        } else if (ch === '\\') {
            i++;
            if (i >= line.length) return line;
            lastSpace = -1;
        } else {
            lastSpace = -1;
        }
    }
    return lastSpace >= 0 ? line.slice(0, lastSpace) : line;
}

/**
 * Parse one .gitignore body into rules (git's add_patterns_from_buffer and
 * parse_path_pattern). Each rule: { index, text, negative, mustBeDir,
 * basename, literal, suffix, regex, depth, never }.
 */
function parseRules(content) {
    if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
    const rules = [];
    for (let line of content.split('\n')) {
        if (!line || line[0] === '#') continue;
        if (line.endsWith('\r')) line = line.slice(0, -1);
        line = trimTrailingSpaces(line);
        if (!line) continue;
        const text = line;
        let body = line;
        const negative = body[0] === '!';
        if (negative) body = body.slice(1);
        const mustBeDir = body.endsWith('/');
        if (mustBeDir) body = body.slice(0, -1);
        if (!body) continue;
        const basename = !body.includes('/');
        let pattern = body;
        if (!basename && pattern[0] === '/') pattern = pattern.slice(1);
        const rule = {
            index: rules.length, text, negative, mustBeDir, basename,
            literal: null, suffix: null, regex: null, depth: 0, never: false,
        };
        if (!GLOB_SPECIAL.test(pattern)) {
            rule.literal = pattern;
            if (!basename) rule.depth = slashDepth(pattern);
        } else if (basename && pattern[0] === '*' && !GLOB_SPECIAL.test(pattern.slice(1))) {
            rule.suffix = pattern.slice(1);
        } else if (basename) {
            // match_basename: the whole pattern against the basename.
            const source = wildmatchSource(pattern);
            if (source === null) rule.never = true;
            else rule.regex = new RegExp('^' + source + '$');
        } else {
            // match_pathname compares the literal prefix, then wildmatches
            // the REST from its own start, so a `**` right after the prefix
            // counts as leading (`a**/b` matches `ab`, as git does).
            const prefix = literalPrefixLength(pattern);
            const source = wildmatchSource(pattern.slice(prefix));
            if (source === null) rule.never = true;
            else {
                let literal = '';
                for (const ch of pattern.slice(0, prefix)) literal += escapeRegexChar(ch);
                rule.regex = new RegExp('^' + literal + source + '$');
            }
            rule.depth = slashDepth(pattern);
        }
        rules.push(rule); // never-matching rules keep file-order indices
    }
    return rules;
}

class IgnoreScope {
    /**
     * @param {string} base - directory of the .gitignore, root-relative ('' = root)
     * @param {object[]} rules - parseRules() output
     */
    constructor(base, rules) {
        this.base = base;
        this.rules = rules;
        this.names = new Map();      // literal basename -> rules (ascending index)
        this.suffixes = [];          // `*literal` basename rules
        this.basenameGlobs = [];     // other basename rules
        this.pathByDepth = new Map(); // slash depth -> path rules
        this.pathAnyDepth = [];      // path rules with `**`
        for (const rule of rules) {
            if (rule.never) continue;
            if (rule.basename) {
                if (rule.literal !== null) {
                    let list = this.names.get(rule.literal);
                    if (!list) { list = []; this.names.set(rule.literal, list); }
                    list.push(rule);
                } else if (rule.suffix !== null) {
                    this.suffixes.push(rule);
                } else {
                    this.basenameGlobs.push(rule);
                }
            } else if (rule.depth < 0) {
                this.pathAnyDepth.push(rule);
            } else {
                let list = this.pathByDepth.get(rule.depth);
                if (!list) { list = []; this.pathByDepth.set(rule.depth, list); }
                list.push(rule);
            }
        }
    }

    /**
     * The last rule of this scope matching `sub` (the path relative to the
     * scope directory, `depth` slashes) with basename `name`, or null.
     */
    lastMatch(sub, depth, name, isDir) {
        let best = null;
        const named = this.names.get(name);
        if (named) best = lastIn(named, null, isDir, NAME_TEST, name);
        if (this.suffixes.length) best = lastIn(this.suffixes, best, isDir, SUFFIX_TEST, name);
        if (this.basenameGlobs.length) best = lastIn(this.basenameGlobs, best, isDir, GLOB_TEST, name);
        const atDepth = this.pathByDepth.get(depth);
        if (atDepth) best = lastIn(atDepth, best, isDir, PATH_TEST, sub);
        if (this.pathAnyDepth.length) best = lastIn(this.pathAnyDepth, best, isDir, PATH_TEST, sub);
        return best;
    }
}

const NAME_TEST = 0;
const SUFFIX_TEST = 1;
const GLOB_TEST = 2;
const PATH_TEST = 3;

/** The last rule of `list` (ascending index) matching `text`, if it beats `best`. */
function lastIn(list, best, isDir, kind, text) {
    for (let i = list.length - 1; i >= 0; i--) {
        const rule = list[i];
        if (best && rule.index < best.index) return best;
        if (rule.mustBeDir && !isDir) continue;
        let hit;
        if (kind === NAME_TEST) hit = true;
        else if (kind === SUFFIX_TEST) hit = text.endsWith(rule.suffix);
        else if (kind === GLOB_TEST) hit = rule.regex.test(text);
        else hit = rule.literal !== null ? rule.literal === text : rule.regex.test(text);
        if (hit) return rule;
    }
    return best;
}

class IgnoreRules {
    /**
     * @param {{base: string, content: string}[]} files - parent before child
     */
    constructor(files) {
        this.scopes = new Map();
        this.order = [];
        for (const { base, content } of files) {
            const rules = parseRules(content);
            if (rules.length === 0) continue;
            let scope = this.scopes.get(base);
            if (scope) {
                // Same directory listed twice: keep one scope in file order.
                scope = new IgnoreScope(base, [...scope.rules, ...rules.map((rule, i) => ({
                    ...rule, index: scope.rules.length + i,
                }))]);
            } else {
                scope = new IgnoreScope(base, rules);
                this.order.push(base);
            }
            this.scopes.set(base, scope);
        }
        this.size = [...this.scopes.values()].reduce((sum, scope) => sum + scope.rules.length, 0);
    }

    /** Stable text for the discovery fingerprint (cache staleness). */
    fingerprint() {
        const parts = [];
        for (const base of this.order) {
            parts.push(`@${base}`);
            for (const rule of this.scopes.get(base).rules) parts.push(rule.text);
        }
        return parts.join('\0');
    }

    /** Scope chain for a directory, given its parent's chain. */
    scopesFor(parentScopes, dirRel) {
        const own = this.scopes.get(dirRel);
        return own ? [...parentScopes, own] : parentScopes;
    }

    /** Scope chain for a directory from scratch. */
    chainFor(dirRel) {
        let chain = [];
        const root = this.scopes.get('');
        if (root) chain = [root];
        if (!dirRel) return chain;
        const parts = dirRel.split('/');
        for (let i = 1; i <= parts.length; i++) {
            chain = this.scopesFor(chain, parts.slice(0, i).join('/'));
        }
        return chain;
    }

    /**
     * Decide one path from the scopes of its parent directory (deepest
     * wins). True = excluded, false = not excluded or re-included.
     * @param {IgnoreScope[]} scopes - chain for the path's parent directory
     * @param {string} rel - root-relative path, '/'-separated
     * @param {number} relDepth - number of '/' in rel
     * @param {string} name - basename of rel
     */
    decide(scopes, rel, relDepth, name, isDir) {
        for (let s = scopes.length - 1; s >= 0; s--) {
            const scope = scopes[s];
            let sub = rel;
            let depth = relDepth;
            if (scope.base) {
                sub = rel.slice(scope.base.length + 1);
                depth = relDepth - scope.baseDepth();
            }
            const rule = scope.lastMatch(sub, depth, name, isDir);
            if (rule) return !rule.negative;
        }
        return false;
    }

    /**
     * Full git answer for one root-relative path: excluded when the path or
     * any of its parent directories is excluded.
     */
    isIgnored(rel, isDir = false) {
        const parts = rel.split('/').filter(Boolean);
        let chain = this.chainFor('');
        let prefix = '';
        for (let i = 0; i < parts.length; i++) {
            const last = i === parts.length - 1;
            const current = prefix ? `${prefix}/${parts[i]}` : parts[i];
            if (this.decide(chain, current, i, parts[i], last ? isDir : true)) return true;
            if (!last) chain = this.scopesFor(chain, current);
            prefix = current;
        }
        return false;
    }
}

IgnoreScope.prototype.baseDepth = function baseDepth() {
    if (this._baseDepth === undefined) {
        let depth = 0;
        for (let i = 0; i < this.base.length; i++) if (this.base.charCodeAt(i) === 47) depth++;
        this._baseDepth = depth + 1;
    }
    return this._baseDepth;
};

module.exports = {
    IgnoreRules,
    parseRules,
    wildmatchSource,
};
