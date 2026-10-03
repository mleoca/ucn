'use strict';

/**
 * Configuration items of dynamically configured scopes (fix #398F).
 *
 * A Python name bound in one scope only in mutually exclusive branches
 * (`if sys.platform == "win32": def getchar` / `else: def getchar`, `try:
 * from ._speedups import f` / `except ImportError: def f`) is one item with
 * an alternative per configuration. The parser records each item
 * (`fileEntry.configurationItems`): its sites (def, class, import or value),
 * each site's branch path, and the line range of every clause on those paths.
 *
 * Reachability of an alternative from a line: code inside another exclusive
 * clause of a statement on the site's branch path runs only in a
 * configuration without that site. Code anywhere else may run in either.
 */

const { branchClausesExclusive } = require('../languages/utils');

const NO_ITEMS = Object.freeze([]);

function configurationItemsOf(index, file) {
    return index.files.get(file)?.configurationItems || NO_ITEMS;
}

const DEFINITION_KINDS = new Set(['def', 'class']);

/** The item a def/class definition is an alternative of, with its site. */
function itemOfDefinition(index, definition) {
    if (!definition?.file || definition.startLine == null) return null;
    for (const item of configurationItemsOf(index, definition.file)) {
        if (item.name !== definition.name) continue;
        const site = item.sites.find(s => DEFINITION_KINDS.has(s.kind) && s.line === definition.startLine);
        if (site) return { item, site };
    }
    return null;
}

/** Two definitions are alternatives of one configuration item. */
function sameConfigurationItem(index, a, b) {
    if (!a || !b || a === b || a.file !== b.file || a.name !== b.name) return false;
    const found = itemOfDefinition(index, a);
    return !!found && found.item.sites.some(s => DEFINITION_KINDS.has(s.kind) && s.line === b.startLine &&
        s !== found.site);
}

/** The module-scope item of `name` in `file`, if any. */
function moduleItemNamed(index, file, name) {
    return configurationItemsOf(index, file).find(item => item.scope === 0 && item.name === name) || null;
}

/** Items of `name` in `file` (any scope). */
function itemsNamed(index, file, name) {
    return configurationItemsOf(index, file).filter(item => item.name === name);
}

/**
 * Code at `line` never reaches `site`: the line lies inside another
 * exclusive clause of a statement on the site's branch path.
 */
function siteExcludedAt(item, site, line) {
    if (!Number.isInteger(line)) return false;
    for (const [statement, tag] of site.branch) {
        const clauses = item.clauses.find(([at]) => at === statement)?.[1];
        if (!clauses) continue;
        const holder = clauses.find(([, start, end]) => start <= line && line <= end);
        if (holder && holder[0] !== tag && branchClausesExclusive(holder[0], tag)) return true;
    }
    return false;
}

/** The sites of `item` code at `line` may reach. */
function sitesReachableAt(item, line) {
    return item.sites.filter(site => !siteExcludedAt(item, site, line));
}

module.exports = {
    DEFINITION_KINDS,
    configurationItemsOf,
    itemOfDefinition,
    sameConfigurationItem,
    moduleItemNamed,
    itemsNamed,
    siteExcludedAt,
    sitesReachableAt,
};
