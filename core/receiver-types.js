'use strict';

// Shared by receiver resolution and the pure provenance validator.
const BUILTIN_RECEIVER_TYPES = new Set([
    'dict', 'list', 'set', 'tuple', 'str', 'int', 'float', 'bool', 'bytes', 'frozenset',
    'Mapping', 'MutableMapping', 'Sequence', 'MutableSequence',
    'Collection', 'Iterable', 'Iterator', 'KeysView', 'ValuesView', 'ItemsView',
    'IO', 'TextIO', 'BinaryIO', 'StringIO', 'BytesIO',
    'ZlibCompress', 'ZlibDecompress',
    'AsyncEvent',
    'Generator', 'AsyncGenerator', 'ContextManager', 'AsyncContextManager',
    'Array', 'String', 'Object', 'RegExp', 'Number', 'Boolean', 'Map', 'Set', 'Promise',
    'WeakMap', 'WeakSet',
    'string', 'number', 'boolean', 'bigint', 'symbol',
    'object', 'dynamic', 'decimal', 'byte', 'sbyte', 'char',
    'short', 'ushort', 'uint', 'long', 'ulong', 'double',
    'List', 'Dictionary', 'HashSet', 'Queue', 'Stack',
    'Task', 'ValueTask', 'IEnumerable', 'ICollection', 'IList',
]);

function isProvenanceBuiltinReceiver(type, language) {
    return BUILTIN_RECEIVER_TYPES.has(type) ||
        (language === 'rust' && ['Option', 'Result', 'Vec'].includes(type));
}

module.exports = { BUILTIN_RECEIVER_TYPES, isProvenanceBuiltinReceiver };
