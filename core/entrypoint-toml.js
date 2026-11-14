'use strict';

// A data-only TOML reader for the PEP 621 entrypoint subtree. Other values
// remain opaque; malformed or nonliteral entrypoint values return unknown.
function entrypointToml(source) {
    const tokens = [];
    let line = 1;
    let offset = 0;
    while (offset < source.length) {
        const ch = source[offset];
        if (ch === '\n') { tokens.push({ kind: 'newline', line }); offset++; line++; continue; }
        if (/\s/.test(ch)) { offset++; continue; }
        if (ch === '#') { while (offset < source.length && source[offset] !== '\n') offset++; continue; }
        if ('[]=.,{}'.includes(ch)) { tokens.push({ kind: ch, line }); offset++; continue; }
        if (ch === '"' || ch === "'") {
            const startLine = line;
            const triple = source.slice(offset, offset + 3) === ch.repeat(3);
            const delimiter = triple ? ch.repeat(3) : ch;
            offset += delimiter.length;
            let value = '';
            let valid = true;
            let closed = false;
            while (offset < source.length) {
                if (source.slice(offset, offset + delimiter.length) === delimiter) {
                    offset += delimiter.length; closed = true; break;
                }
                const current = source[offset++];
                if (current === '\n') line++;
                if (current !== '\\' || ch === "'") { value += current; continue; }
                const escaped = source[offset++];
                const simple = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\' };
                if (Object.hasOwn(simple, escaped)) value += simple[escaped];
                else if (escaped === 'u' || escaped === 'U') {
                    const width = escaped === 'u' ? 4 : 8;
                    const digits = source.slice(offset, offset + width);
                    if (!/^[0-9a-fA-F]+$/.test(digits) || digits.length !== width || parseInt(digits, 16) > 0x10ffff) valid = false;
                    else value += String.fromCodePoint(parseInt(digits, 16));
                    offset += width;
                } else if (triple && /\s/.test(escaped || '')) {
                    if (escaped === '\n') line++;
                    while (offset < source.length && /\s/.test(source[offset])) {
                        if (source[offset++] === '\n') line++;
                    }
                } else valid = false;
            }
            tokens.push({ kind: 'string', value: valid && closed ? value.replace(/^\n/, '') : null, line: startLine });
            continue;
        }
        const start = offset;
        while (offset < source.length && !/[\s[\]=.,{}#]/.test(source[offset])) offset++;
        if (offset === start) offset++;
        tokens.push({ kind: 'bare', value: source.slice(start, offset), line });
    }
    const rows = [];
    let at = 0;
    let section = [];
    const keys = () => {
        const parts = [];
        while (tokens[at] && ['bare', 'string'].includes(tokens[at].kind)) {
            parts.push(tokens[at++].value);
            if (tokens[at]?.kind !== '.') break;
            at++;
        }
        return parts;
    };
    const entryPath = parts => parts[0] === 'project' &&
        (['scripts', 'gui-scripts'].includes(parts[1]) || parts[1] === 'entry-points');
    const readValue = (parts, depth = 0) => {
        const token = tokens[at++];
        if (!token || depth > 32) { if (entryPath(parts)) rows.push({ unknown: true, line: token?.line }); return; }
        if (token.kind === '{') {
            while (tokens[at] && tokens[at].kind !== '}') {
                if (['newline', ','].includes(tokens[at].kind)) { at++; continue; }
                const nested = keys();
                if (!nested.length || tokens[at++]?.kind !== '=') { if (entryPath(parts)) rows.push({ unknown: true, line: token.line }); break; }
                readValue([...parts, ...nested], depth + 1);
            }
            if (tokens[at]?.kind === '}') at++;
        } else if (token.kind === '[') {
            let balance = 1;
            while (tokens[at] && balance) {
                const item = tokens[at++];
                if (item.kind === '[') balance++;
                if (item.kind === ']') balance--;
                if (parts.join('.') === 'project.dynamic' && item.kind === 'string' &&
                    ['scripts', 'gui-scripts', 'entry-points'].includes(item.value)) rows.push({ unknown: true, line: item.line });
            }
            if (entryPath(parts)) rows.push({ unknown: true, line: token.line });
        } else if (entryPath(parts)) {
            rows.push(token.kind === 'string' && token.value != null
                ? { value: token.value, line: token.line } : { unknown: true, line: token.line });
        }
    };
    while (at < tokens.length) {
        if (tokens[at].kind === 'newline') { at++; continue; }
        if (tokens[at].kind === '[') {
            at++;
            section = keys();
            while (tokens[at] && ![']', 'newline'].includes(tokens[at].kind)) at++;
            if (tokens[at]?.kind === ']') at++;
            continue;
        }
        const parts = keys();
        if (parts.length && tokens[at]?.kind === '=') { at++; readValue([...section, ...parts]); }
        else while (tokens[at] && tokens[at].kind !== 'newline') at++;
    }
    return rows;
}

module.exports = { entrypointToml };
