'use strict';

/**
 * languages/java-platform.js - JDK contracts the Java overload, conversion
 * and receiver rules read (fix #421: moved out of core/callers.js). Each
 * table is a specification-level fact of the Java platform (JLS conversions,
 * final value types, java.lang interface members, factory return types), not
 * knowledge about any project. A platform type outside these tables has
 * unknown members and supertypes: the engine's answer through it stays open
 * (unverified with a reason), never closed by assumption.
 */

const JAVA_FINAL_REFERENCE_TYPES = new Set([
    'String', 'Class', 'Boolean', 'Byte', 'Character', 'Short',
    'Integer', 'Long', 'Float', 'Double', 'Void',
]);

// Complete reference-supertype sets for JDK value types (fix #299D): these
// types are final (or effectively closed) with a fixed, fully-known
// ancestry, so an argument statically typed as one of them can bind ONLY a
// parameter type in this list (plus Object/generics, handled earlier). A
// project class shadowing one of these simple names disables the denial —
// the guard is tDefs.length === 0 at the use site. Modern-JDK marker
// interfaces (Constable, ConstantDesc) are included so their params never
// get falsely denied.
const JAVA_PLATFORM_VALUE_ANCESTRY = new Map([
    ['Integer', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Long', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Short', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Byte', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Float', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Double', ['Number', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['Character', ['Comparable', 'Serializable', 'Constable']],
    ['Boolean', ['Comparable', 'Serializable', 'Constable']],
    ['String', ['CharSequence', 'Comparable', 'Serializable', 'Constable', 'ConstantDesc']],
    ['BigInteger', ['Number', 'Comparable', 'Serializable']],
    ['BigDecimal', ['Number', 'Comparable', 'Serializable']],
]);

// Unboxing is defined for exactly these wrapper types (JLS 5.1.8).
const JAVA_WRAPPER_PRIMITIVES = new Map([
    ['Integer', 'int'], ['Long', 'long'], ['Short', 'short'], ['Byte', 'byte'],
    ['Character', 'char'], ['Boolean', 'boolean'],
    ['Float', 'float'], ['Double', 'double'],
]);

// Declared types of the JDK numeric-constant fields (fix #299D): exact
// compiler contracts, consulted only when no project field shadows the
// owner/field pair.
const JAVA_PLATFORM_FIELD_TYPES = new Map([
    ['Float.NaN', 'float'], ['Float.POSITIVE_INFINITY', 'float'],
    ['Float.NEGATIVE_INFINITY', 'float'], ['Float.MIN_VALUE', 'float'],
    ['Float.MAX_VALUE', 'float'], ['Float.MIN_NORMAL', 'float'],
    ['Double.NaN', 'double'], ['Double.POSITIVE_INFINITY', 'double'],
    ['Double.NEGATIVE_INFINITY', 'double'], ['Double.MIN_VALUE', 'double'],
    ['Double.MAX_VALUE', 'double'], ['Double.MIN_NORMAL', 'double'],
    ['Integer.MAX_VALUE', 'int'], ['Integer.MIN_VALUE', 'int'],
    ['Long.MAX_VALUE', 'long'], ['Long.MIN_VALUE', 'long'],
    ['Short.MAX_VALUE', 'short'], ['Short.MIN_VALUE', 'short'],
    ['Byte.MAX_VALUE', 'byte'], ['Byte.MIN_VALUE', 'byte'],
    ['Character.MAX_VALUE', 'char'], ['Character.MIN_VALUE', 'char'],
    ['Boolean.TRUE', 'Boolean'], ['Boolean.FALSE', 'Boolean'],
]);

// Small, authoritative platform surface used only when the parser preserved
// the imported owner. These are JDK interface/method declarations, not
// name-based guesses. They close the common portable-AST gap where overload
// resolution depends on the return type of a library call.
const JAVA_PLATFORM_METHOD_RETURNS = new Map([
    // Exact JDK factory contracts (fix #299D): valueOf on the boxed and
    // arbitrary-precision types returns the owner type itself.
    ['java.math.BigInteger#valueOf', 'java.math.BigInteger'],
    ['java.math.BigDecimal#valueOf', 'java.math.BigDecimal'],
    ['java.lang.Integer#valueOf', 'java.lang.Integer'],
    ['java.lang.Long#valueOf', 'java.lang.Long'],
    ['java.lang.Short#valueOf', 'java.lang.Short'],
    ['java.lang.Byte#valueOf', 'java.lang.Byte'],
    ['java.lang.Float#valueOf', 'java.lang.Float'],
    ['java.lang.Double#valueOf', 'java.lang.Double'],
    ['java.lang.Boolean#valueOf', 'java.lang.Boolean'],
    ['java.lang.Character#valueOf', 'java.lang.Character'],
    ['java.lang.String#valueOf', 'java.lang.String'],
    ['java.lang.Object#getClass', 'java.lang.Class'],
    ['java.lang.Class#getEnclosingClass', 'java.lang.Class'],
    ['java.lang.Class#getDeclaringClass', 'java.lang.Class'],
    ['java.lang.Class#getDeclaredMethod', 'java.lang.reflect.Method'],
    ['java.lang.Enum#getDeclaringClass', 'java.lang.Class'],
    ['java.lang.reflect.Method#getReturnType', 'java.lang.Class'],
    ['java.lang.reflect.Constructor#getDeclaringClass', 'java.lang.Class'],
    ['java.lang.annotation.Annotation#annotationType', 'java.lang.Class'],
    ['java.lang.reflect.Method#getGenericReturnType', 'java.lang.reflect.Type'],
    ['java.lang.reflect.Method#getParameterTypes', 'java.lang.Class[]'],
    ['java.lang.reflect.Method#getGenericParameterTypes', 'java.lang.reflect.Type[]'],
    ['javax.lang.model.element.Element#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.TypeElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.TypeParameterElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.VariableElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.ExecutableElement#asType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.ExecutableElement#getReturnType', 'javax.lang.model.type.TypeMirror'],
    ['javax.lang.model.element.AnnotationMirror#getElementValues', 'java.util.Map'],
    ['javax.lang.model.element.Element#getAnnotationMirrors', 'java.util.List'],
    ['javax.lang.model.element.TypeElement#getAnnotationMirrors', 'java.util.List'],
    ['javax.lang.model.element.TypeElement#getEnclosedElements', 'java.util.List'],
    ['javax.lang.model.element.ExecutableElement#getParameters', 'java.util.List'],
    ['javax.lang.model.util.ElementFilter#methodsIn', 'java.util.List'],
    ['javax.lang.model.util.Types#getPrimitiveType', 'javax.lang.model.type.PrimitiveType'],
    ['javax.lang.model.util.Types#getArrayType', 'javax.lang.model.type.ArrayType'],
    ['javax.lang.model.util.Types#getDeclaredType', 'javax.lang.model.type.DeclaredType'],
    ['javax.lang.model.util.Types#getWildcardType', 'javax.lang.model.type.WildcardType'],
    ['javax.lang.model.util.Types#getNoType', 'javax.lang.model.type.NoType'],
    ['javax.lang.model.util.Types#getNullType', 'javax.lang.model.type.NullType'],
    // JDK collection factories (fix #428): `with(Arrays.asList(..))` passes a
    // List, never the element type of a sibling varargs overload.
    ['java.util.Arrays#asList', 'java.util.List'],
    ['java.util.List#of', 'java.util.List'], ['java.util.List#copyOf', 'java.util.List'],
    ['java.util.Set#of', 'java.util.Set'], ['java.util.Set#copyOf', 'java.util.Set'],
    ['java.util.Map#of', 'java.util.Map'], ['java.util.Map#copyOf', 'java.util.Map'],
    ['java.util.Collections#emptyList', 'java.util.List'], ['java.util.Collections#singletonList', 'java.util.List'],
    ['java.util.Collections#unmodifiableList', 'java.util.List'],
    ['java.util.Collections#emptySet', 'java.util.Set'], ['java.util.Collections#singleton', 'java.util.Set'],
    ['java.util.Collections#unmodifiableSet', 'java.util.Set'],
    ['java.util.Collections#emptyMap', 'java.util.Map'], ['java.util.Collections#singletonMap', 'java.util.Map'],
    ['java.util.Collections#unmodifiableMap', 'java.util.Map'],
]);

// Complete inherited member-name surfaces of these JDK contracts. None declares
// a member type. A contract is usable only after the written supertype has
// resolved to this qualified SDK identity; an external namesake is unknown.
const JAVA_PLATFORM_ANCESTOR_MEMBERS = new Map([
    ['java.lang.Object', new Set(['getClass', 'hashCode', 'equals', 'clone',
        'toString', 'notify', 'notifyAll', 'wait', 'finalize'])],
    ['java.lang.Comparable', new Set(['compareTo'])],
    ['java.lang.Iterable', new Set(['iterator', 'forEach', 'spliterator'])],
    ['java.lang.AutoCloseable', new Set(['close'])],
    ['java.io.Closeable', new Set(['close'])],
    ['java.util.Map.Entry', new Set(['getKey', 'getValue', 'setValue', 'equals', 'hashCode'])],
    ['java.lang.Runnable', new Set(['run'])],
    ['java.lang.Cloneable', new Set()],
    ['java.io.Serializable', new Set()],
]);

const JAVA_PLATFORM_SUPERTYPES = new Map([
    ['java.lang.reflect.Type', ['java.lang.Object']],
    ['java.lang.reflect.ParameterizedType', ['java.lang.Object', 'java.lang.reflect.Type']],
    ['java.lang.reflect.GenericArrayType', ['java.lang.Object', 'java.lang.reflect.Type']],
    ['java.lang.reflect.TypeVariable', ['java.lang.Object', 'java.lang.reflect.Type',
        'java.lang.reflect.AnnotatedElement']],
    ['java.lang.reflect.WildcardType', ['java.lang.Object', 'java.lang.reflect.Type']],
    ['java.lang.Class', ['java.lang.Object', 'java.lang.reflect.Type', 'java.io.Serializable',
        'java.lang.reflect.GenericDeclaration', 'java.lang.reflect.AnnotatedElement',
        'java.lang.invoke.TypeDescriptor.OfField', 'java.lang.invoke.TypeDescriptor',
        'java.lang.constant.Constable']],
    ['javax.lang.model.type.ArrayType', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.DeclaredType', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.ErrorType', ['javax.lang.model.type.DeclaredType',
        'javax.lang.model.type.ReferenceType', 'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.ExecutableType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.IntersectionType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.NoType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.NullType', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.PrimitiveType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.TypeVariable', ['javax.lang.model.type.ReferenceType',
        'javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.UnionType', ['javax.lang.model.type.TypeMirror']],
    ['javax.lang.model.type.WildcardType', ['javax.lang.model.type.TypeMirror']],
    // JDK collections (fix #391): their declared supertypes, so a
    // `new LinkedHashMap<>()` argument proves a Map parameter applicable.
    ...[
        ['ArrayList', ['List', 'Collection', 'Iterable', 'RandomAccess', 'AbstractList',
            'AbstractCollection', 'SequencedCollection', 'Cloneable', 'Serializable']],
        ['LinkedList', ['List', 'Deque', 'Queue', 'Collection', 'Iterable', 'AbstractSequentialList',
            'AbstractList', 'AbstractCollection', 'SequencedCollection', 'Cloneable', 'Serializable']],
        ['ArrayDeque', ['Deque', 'Queue', 'Collection', 'Iterable', 'AbstractCollection',
            'SequencedCollection', 'Cloneable', 'Serializable']],
        // The collection interfaces themselves (fix #428).
        ['List', ['SequencedCollection', 'Collection', 'Iterable']],
        ['Set', ['Collection', 'Iterable']],
        ['Collection', ['Iterable']],
        ['Map', []],
        ['HashMap', ['Map', 'AbstractMap', 'Cloneable', 'Serializable']],
        ['LinkedHashMap', ['HashMap', 'Map', 'SequencedMap', 'AbstractMap', 'Cloneable', 'Serializable']],
        ['TreeMap', ['NavigableMap', 'SortedMap', 'SequencedMap', 'Map', 'AbstractMap', 'Cloneable',
            'Serializable']],
        ['HashSet', ['Set', 'Collection', 'Iterable', 'AbstractSet', 'AbstractCollection', 'Cloneable',
            'Serializable']],
        ['LinkedHashSet', ['HashSet', 'SequencedSet', 'SequencedCollection', 'Set', 'Collection', 'Iterable',
            'AbstractSet', 'AbstractCollection', 'Cloneable', 'Serializable']],
        ['TreeSet', ['NavigableSet', 'SortedSet', 'SequencedSet', 'SequencedCollection', 'Set', 'Collection',
            'Iterable', 'AbstractSet', 'AbstractCollection', 'Cloneable', 'Serializable']],
    ].map(([type, supertypes]) => [`java.util.${type}`, supertypes.map(name =>
        (name === 'Iterable' || name === 'Cloneable' ? `java.lang.${name}`
            : name === 'Serializable' ? 'java.io.Serializable' : `java.util.${name}`))]),
]);

const JAVA_MODELED_PLATFORM_TYPES = new Set([
    ...JAVA_PLATFORM_ANCESTOR_MEMBERS.keys(),
    ...JAVA_PLATFORM_METHOD_RETURNS.keys()].map(name => name.split('#')[0]));
for (const type of JAVA_PLATFORM_METHOD_RETURNS.values()) JAVA_MODELED_PLATFORM_TYPES.add(type.replace(/\[\]$/, ''));
for (const [type, parents] of JAVA_PLATFORM_SUPERTYPES) {
    JAVA_MODELED_PLATFORM_TYPES.add(type);
    for (const parent of parents) JAVA_MODELED_PLATFORM_TYPES.add(parent);
}

function platformAssignable(actualType, expectedSimple) {
    if (!actualType?.includes('.')) return null;
    const actualSimple = actualType.split('.').pop();
    if (actualSimple === expectedSimple) return true;
    const known = JAVA_PLATFORM_SUPERTYPES.get(actualType);
    if (known) return known.some(type => type.split('.').pop() === expectedSimple);
    if (actualType === 'java.lang.Class') {
        return ['Type', 'Serializable', 'GenericDeclaration', 'AnnotatedElement',
            'Object'].includes(expectedSimple);
    }
    // An unmodeled actual type may implement any of these interfaces.
    // Knowing only the expected type cannot disprove the conversion.
    return null;
}

module.exports = {
    JAVA_FINAL_REFERENCE_TYPES, JAVA_PLATFORM_VALUE_ANCESTRY, JAVA_WRAPPER_PRIMITIVES, JAVA_PLATFORM_FIELD_TYPES,
    JAVA_PLATFORM_METHOD_RETURNS, JAVA_PLATFORM_ANCESTOR_MEMBERS, JAVA_PLATFORM_SUPERTYPES,
    JAVA_MODELED_PLATFORM_TYPES, platformAssignable,
};
