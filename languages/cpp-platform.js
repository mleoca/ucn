'use strict';

// Qualified standard-library contracts. Name lookup belongs to cpp-scope;
// none of these facts apply to a project declaration with the same name.
const STRING_ALIASES = new Map([
    ['string', 'char'], ['wstring', 'wchar_t'], ['u8string', 'char8_t'],
    ['u16string', 'char16_t'], ['u32string', 'char32_t'],
]);
const CHARACTERS = new Set(['char', 'wchar_t', 'char8_t', 'char16_t', 'char32_t']);

function standardStringType(qualified, arguments_ = []) {
    if (!qualified?.startsWith('std::')) return null;
    const name = qualified.slice(5);
    const view = name.endsWith('_view');
    const alias = view ? name.slice(0, -5) : name;
    if (STRING_ALIASES.has(alias) && arguments_.length === 0) {
        return { family: view ? 'view' : 'string', character: STRING_ALIASES.get(alias) };
    }
    if (!['basic_string', 'basic_string_view'].includes(name) || !CHARACTERS.has(arguments_[0])) return null;
    // A specialization with custom traits or allocator is outside this
    // small platform model, as is a project-provided specialization.
    if (arguments_.length > 1) return null;
    return { family: name === 'basic_string' ? 'string' : 'view', character: arguments_[0] };
}

module.exports = { standardStringType, CHARACTERS };
