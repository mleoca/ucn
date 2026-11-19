'use strict';

/**
 * Where a file's string literals are, as its syntax tree says: the offsets
 * whose innermost string-or-interpolation node is a string (an f-string's
 * `{...}` is code; a string inside it is a string again). A parser records
 * them at index time (`fileEntry.stringRegions`), so a reader that asks
 * whether an offset lies in a string answers without parsing the file again.
 *
 * Offsets are the tree's: UTF-16 code units, as JS string indexes. A region
 * holds an offset when start <= offset < end, the containment the tree's own
 * descent uses, so a lookup answers what walking up from the deepest node
 * at that offset would.
 *
 * Encoding: one string of `gap,length` pairs in base 36, `;`-separated,
 * where `gap` is the start's distance from the previous region's end (from
 * 0 for the first). Regions are sorted, disjoint and never adjacent.
 */

/**
 * @param {Array<{string: boolean, start: number, end: number}>} nodes - the
 *   string and interpolation nodes of one tree in preorder (each node before
 *   its descendants, siblings in source order)
 * @returns {string}
 */
function encodeStringRegions(nodes) {
    const regions = [];
    const stack = [];
    let open = -1; // start of the region being built, -1 when none
    const innermostIsString = () => stack.length > 0 && stack[stack.length - 1].string;
    const close = (at) => {
        if (open >= 0 && open < at) {
            const last = regions[regions.length - 1];
            if (last && last[1] === open) last[1] = at;
            else regions.push([open, at]);
        }
        open = -1;
    };
    // The innermost node changes at a boundary: a region opens when it
    // becomes a string and closes when it stops being one.
    const changed = (wasString, at) => {
        const isString = innermostIsString();
        if (wasString && !isString) close(at);
        else if (!wasString && isString) open = at;
    };
    const popUntil = (at) => {
        while (stack.length > 0 && stack[stack.length - 1].end <= at) {
            const wasString = innermostIsString();
            const node = stack.pop();
            changed(wasString, node.end);
        }
    };
    for (const node of nodes) {
        popUntil(node.start);
        const wasString = innermostIsString();
        stack.push(node);
        changed(wasString, node.start);
    }
    popUntil(Infinity);
    let previousEnd = 0;
    const parts = [];
    for (const [start, end] of regions) {
        parts.push(`${(start - previousEnd).toString(36)},${(end - start).toString(36)}`);
        previousEnd = end;
    }
    return parts.join(';');
}

/**
 * @param {string} encoded - encodeStringRegions output
 * @returns {(offset: number) => boolean} whether the offset lies in a string
 */
function stringRegionLookup(encoded) {
    const starts = [];
    const ends = [];
    let previousEnd = 0;
    if (encoded) {
        for (const part of encoded.split(';')) {
            const comma = part.indexOf(',');
            const start = previousEnd + parseInt(part.slice(0, comma), 36);
            const end = start + parseInt(part.slice(comma + 1), 36);
            starts.push(start);
            ends.push(end);
            previousEnd = end;
        }
    }
    return (offset) => {
        // The last region starting at or before the offset is the only one
        // that can hold it.
        let lo = 0;
        let hi = starts.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (starts[mid] <= offset) lo = mid + 1; else hi = mid;
        }
        return lo > 0 && offset < ends[lo - 1];
    };
}

module.exports = { encodeStringRegions, stringRegionLookup };
