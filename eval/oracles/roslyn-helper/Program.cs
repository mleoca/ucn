// Compiler-backed C# semantic oracle for UCN's release evaluation.
//
// This helper deliberately uses Roslyn from the installed .NET SDK, not
// UCN/tree-sitter. It builds one semantic compilation per evaluated project
// unit (a project at one target framework), links project references as
// compilation references, and serves exact symbol/reference/definition
// queries over JSONL.
//
// Symbol identity is the declaration location: a source file that several
// units compile (strong-name twins, linked files, multi-target references)
// yields one symbol per compilation, and all of them are one identity.

using System.Collections.Immutable;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

internal sealed record SymbolRow(
    string Name,
    string File,
    int Line,
    string Kind,
    string Identity,
    int Column);

internal sealed record ReferenceRow(
    string File,
    int Line,
    int Column,
    string Kind,
    bool Unresolved);

internal sealed record UsingItem(
    string Name,
    bool Static,
    string? Alias);

internal sealed record UnitConfig(
    string Name,
    string? Project,
    string? AssemblyName,
    string? TargetFramework,
    string[] Files,
    string[] References,
    string[]? ProjectReferences,
    string[]? Defines,
    string? LanguageVersion,
    bool AllowUnsafe,
    UsingItem[]? Usings);

internal sealed record OracleConfig(
    UnitConfig[] Units);

internal sealed class Unit
{
    internal required UnitConfig Config { get; init; }
    internal required CSharpCompilation Compilation { get; set; }
    internal Dictionary<SyntaxTree, SemanticModel> Models { get; } = new();
    internal Dictionary<string, SyntaxTree> TreesByFile { get; } = new(StringComparer.Ordinal);
}

internal sealed class RoslynOracle
{
    private static readonly HashSet<string> ExcludedDirectories =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ".git", ".svn", "bin", "obj", "node_modules", "TestResults",
        };

    private readonly string _root;
    private readonly List<Unit> _units = new();
    private readonly List<SymbolRow> _symbols = new();
    private readonly Dictionary<string, string> _parent = new(StringComparer.Ordinal);
    private readonly Dictionary<string, List<ReferenceRow>> _referenceIndex =
        new(StringComparer.Ordinal);

    internal RoslynOracle(string root, string? configPath = null)
    {
        _root = Path.GetFullPath(root);
        OracleConfig? config = null;
        if (!string.IsNullOrWhiteSpace(configPath))
        {
            config = JsonSerializer.Deserialize<OracleConfig>(
                File.ReadAllText(configPath),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
        }
        var units = config?.Units?.Length > 0
            ? config.Units
            : new[]
            {
                new UnitConfig("source-tree", null, null, null,
                    EnumerateFiles(_root).ToArray(), Array.Empty<string>(),
                    null, null, null, true, null),
            };
        BuildUnits(units);
        IndexSymbols();
        BuildReferenceIndex();
    }

    private void BuildUnits(UnitConfig[] configs)
    {
        var byName = configs.ToDictionary(unit => unit.Name, StringComparer.Ordinal);
        var built = new Dictionary<string, Unit>(StringComparer.Ordinal);
        var visiting = new HashSet<string>(StringComparer.Ordinal);
        var textCache = new Dictionary<string, string>(StringComparer.Ordinal);
        Unit Build(UnitConfig unit)
        {
            if (built.TryGetValue(unit.Name, out var existing)) return existing;
            if (!visiting.Add(unit.Name))
            {
                throw new InvalidOperationException($"project reference cycle at {unit.Name}");
            }
            var compilationReferences = new List<MetadataReference>();
            foreach (var reference in unit.ProjectReferences ?? Array.Empty<string>())
            {
                if (!byName.TryGetValue(reference, out var dependency)) continue;
                compilationReferences.Add(Build(dependency).Compilation.ToMetadataReference());
            }
            var languageVersion = LanguageVersion.Latest;
            if (!string.IsNullOrWhiteSpace(unit.LanguageVersion) &&
                LanguageVersionFacts.TryParse(unit.LanguageVersion, out var parsed))
            {
                languageVersion = parsed;
            }
            var parseOptions = CSharpParseOptions.Default
                .WithLanguageVersion(languageVersion)
                .WithDocumentationMode(DocumentationMode.Parse)
                .WithPreprocessorSymbols(unit.Defines ?? Array.Empty<string>());
            var trees = new List<SyntaxTree>();
            foreach (var file in unit.Files.Distinct(StringComparer.Ordinal))
            {
                if (!textCache.TryGetValue(file, out var text))
                {
                    text = File.ReadAllText(file);
                    textCache[file] = text;
                }
                trees.Add(CSharpSyntaxTree.ParseText(text, parseOptions, path: file));
            }
            // SDK implicit usings are generated at build time
            // (obj/*.GlobalUsings.g.cs) and are not Compile items before
            // CoreCompile; the evaluated Using items carry the same set.
            var usings = unit.Usings ?? Array.Empty<UsingItem>();
            if (usings.Length > 0)
            {
                var lines = usings.Select(item =>
                    item.Static ? $"global using static global::{item.Name};" :
                    !string.IsNullOrWhiteSpace(item.Alias)
                        ? $"global using {item.Alias} = global::{item.Name};"
                        : $"global using global::{item.Name};");
                trees.Add(CSharpSyntaxTree.ParseText(
                    string.Join("\n", lines), parseOptions,
                    path: Path.Combine(_root, "obj", $"ucn-oracle-{unit.Name}.GlobalUsings.g.cs")));
            }
            var metadata = unit.References.Length > 0
                ? unit.References
                    .Distinct(StringComparer.OrdinalIgnoreCase)
                    .Where(File.Exists)
                    .Select(file => (MetadataReference)MetadataReference.CreateFromFile(file))
                : TrustedPlatformReferences();
            var compilation = CSharpCompilation.Create(
                string.IsNullOrWhiteSpace(unit.AssemblyName) ? unit.Name : unit.AssemblyName,
                trees,
                metadata.Concat(compilationReferences),
                new CSharpCompilationOptions(
                    OutputKind.DynamicallyLinkedLibrary,
                    allowUnsafe: true,
                    nullableContextOptions: NullableContextOptions.Enable));
            var result = new Unit { Config = unit, Compilation = compilation };
            foreach (var tree in compilation.SyntaxTrees)
            {
                result.Models[tree] = compilation.GetSemanticModel(tree, ignoreAccessibility: true);
                result.TreesByFile[Relative(tree.FilePath)] = tree;
            }
            visiting.Remove(unit.Name);
            built[unit.Name] = result;
            _units.Add(result);
            return result;
        }
        foreach (var unit in configs) Build(unit);
    }

    internal object Ready()
    {
        var errors = _units.Sum(unit => unit.Compilation.GetDiagnostics()
            .Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error));
        var files = _units.SelectMany(unit => unit.TreesByFile.Keys)
            .Where(file => File.Exists(Path.Combine(_root, file)))
            .Distinct(StringComparer.Ordinal).Count();
        return new
        {
            ok = true,
            ready = true,
            roslyn = true,
            files,
            compileErrors = errors,
            units = _units.Select(unit => new
            {
                name = unit.Config.Name,
                targetFramework = unit.Config.TargetFramework,
                files = unit.Compilation.SyntaxTrees.Count(),
                errors = unit.Compilation.GetDiagnostics()
                    .Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error),
            }),
        };
    }

    internal object ListSymbols()
    {
        return new
        {
            ok = true,
            symbols = _symbols.Select(row => new
            {
                name = row.Name,
                file = row.File,
                line = row.Line,
                kind = row.Kind,
            }),
        };
    }

    internal object FindReferences(string file, int line, string name)
    {
        var target = FindTarget(file, line, name);
        if (target is null)
        {
            return new { ok = false, error = $"no declaration at {file}:{line}:{name}" };
        }

        var refs = new Dictionary<string, object>(StringComparer.Ordinal);
        AddReference(refs, target.File, target.Line, target.Column, "definition", false);
        if (_referenceIndex.TryGetValue(Find(target.Identity), out var indexed))
        {
            foreach (var reference in indexed)
            {
                AddReference(refs, reference.File, reference.Line, reference.Column,
                    reference.Kind, reference.Unresolved);
            }
        }
        return new { ok = true, refs = refs.Values };
    }

    internal object ResolveDefinition(string file, int line, string name, int? column)
    {
        var located = UnitsWithFile(file).ToList();
        if (located.Count == 0)
        {
            // No loaded build compiles the file: outside the oracle's
            // projection (source_status reports it configuration-gated).
            return new { ok = true, definitions = Array.Empty<object>(), outsideProjection = true };
        }
        var definitions = new Dictionary<string, object>(StringComparer.Ordinal);
        void AddLocations(ISymbol? symbol)
        {
            if (NormalizeSymbol(symbol) is not ISymbol normalized) return;
            foreach (var location in normalized.Locations.Where(loc => loc.IsInSource))
            {
                var span = location.GetLineSpan();
                var rel = Relative(span.Path);
                var defLine = span.StartLinePosition.Line + 1;
                definitions[$"{rel}:{defLine}"] = new { file = rel, line = defLine };
            }
        }
        foreach (var (unit, tree) in located)
        {
            var source = tree.GetText();
            if (line < 1 || line > source.Lines.Count)
            {
                return new { ok = false, error = $"line outside file: {file}:{line}" };
            }
            var lineText = source.Lines[line - 1];
            var positions = new List<int>();
            if (column is int explicitColumn)
            {
                positions.Add(Math.Min(lineText.End, lineText.Start + explicitColumn));
            }
            else
            {
                var text = lineText.ToString();
                for (var from = 0; from <= text.Length - name.Length;)
                {
                    var at = text.IndexOf(name, from, StringComparison.Ordinal);
                    if (at < 0) break;
                    if (WordBoundary(text, at, name.Length)) positions.Add(lineText.Start + at);
                    from = at + Math.Max(1, name.Length);
                }
            }
            var model = unit.Models[tree];
            foreach (var position in positions)
            {
                var node = tree.GetRoot().FindToken(position).Parent;
                // Declaration identifiers are tokens directly owned by the
                // declaration, not SimpleNameSyntax expressions. A partial
                // type's declaration resolves to all its compiler-owned parts.
                var declared = node switch
                {
                    BaseTypeDeclarationSyntax declaration when declaration.Identifier.Span.Contains(position)
                        => model.GetDeclaredSymbol(declaration),
                    MethodDeclarationSyntax declaration when declaration.Identifier.Span.Contains(position)
                        => model.GetDeclaredSymbol(declaration),
                    ConstructorDeclarationSyntax declaration when declaration.Identifier.Span.Contains(position)
                        => model.GetDeclaredSymbol(declaration),
                    PropertyDeclarationSyntax declaration when declaration.Identifier.Span.Contains(position)
                        => model.GetDeclaredSymbol(declaration),
                    VariableDeclaratorSyntax declaration when declaration.Identifier.Span.Contains(position)
                        => model.GetDeclaredSymbol(declaration),
                    _ => (ISymbol?)null,
                };
                if (declared is not null)
                {
                    AddLocations(declared);
                    if (declared is IMethodSymbol method)
                    {
                        AddLocations(method.PartialDefinitionPart);
                        AddLocations(method.PartialImplementationPart);
                    }
                    if (declared is IPropertySymbol property)
                    {
                        AddLocations(property.PartialDefinitionPart);
                        AddLocations(property.PartialImplementationPart);
                    }
                    continue;
                }
                var ancestors = node?.AncestorsAndSelf().ToArray() ?? Array.Empty<SyntaxNode>();
                // Prefer the complete call expression. Querying the nested
                // SimpleNameSyntax returns an overload group and
                // CandidateSymbols order is not semantic overload selection.
                SyntaxNode? expression = ancestors
                    .OfType<InvocationExpressionSyntax>()
                    .FirstOrDefault(candidate =>
                        NameToken(candidate.Expression).Span.Contains(position));
                expression ??= ancestors
                    .OfType<ObjectCreationExpressionSyntax>()
                    .FirstOrDefault(candidate => candidate.Type.Span.Contains(position));
                expression ??= ancestors
                    .OfType<ConstructorInitializerSyntax>()
                    .FirstOrDefault(candidate => candidate.ThisOrBaseKeyword.Span.Contains(position));
                expression ??= ancestors.OfType<SimpleNameSyntax>().FirstOrDefault();
                if (expression is null) continue;
                var info = expression switch
                {
                    InvocationExpressionSyntax invocation => model.GetSymbolInfo(invocation.Expression),
                    _ => model.GetSymbolInfo(expression),
                };
                // A failed overload resolution, an ambiguity or a late-bound
                // (dynamic) call has no compiler answer: abstain instead of
                // taking the first candidate. A method group (`nameof(M)`)
                // names every member of the group.
                foreach (var resolved in ExactSymbols(info))
                {
                    var symbol = resolved;
                    if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor &&
                        expression is not ObjectCreationExpressionSyntax &&
                        expression is not ConstructorInitializerSyntax)
                    {
                        symbol = constructor.ContainingType;
                    }
                    AddLocations(symbol);
                    // A construction names both its type and the selected
                    // constructor (fix #429): the class target and the
                    // constructor target each resolve here.
                    if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } created)
                    {
                        AddLocations(created.ContainingType);
                    }
                }
            }
        }
        return new { ok = true, definitions = definitions.Values };
    }

    // Members the runtime reaches through a contract declared outside the
    // compilation (an override of an external virtual member, the
    // implementation of an external interface member): calls through that
    // contract are not references of this declaration (fix #429).
    internal object ReferenceBlindness(string file, int line, string name)
    {
        var target = FindTarget(file, line, name);
        if (target is null)
        {
            return new { ok = false, error = $"no declaration at {file}:{line}:{name}" };
        }
        foreach (var (unit, tree) in UnitsWithFile(file))
        {
            var model = unit.Models[tree];
            foreach (var node in tree.GetRoot().DescendantNodes().OfType<MemberDeclarationSyntax>())
            {
                if (DeclarationStartLine(node) != line) continue;
                var declared = node switch
                {
                    MethodDeclarationSyntax method => model.GetDeclaredSymbol(method) as ISymbol,
                    PropertyDeclarationSyntax property => model.GetDeclaredSymbol(property),
                    EventDeclarationSyntax @event => model.GetDeclaredSymbol(@event),
                    _ => null,
                };
                if (declared is null || declared.Name != name) continue;
                var contract = ExternalContract(declared);
                if (contract is not null)
                {
                    return new { ok = true, blind = true, reason = "external-contract", detail = contract };
                }
            }
        }
        return new { ok = true, blind = false };
    }

    private static string? ExternalContract(ISymbol symbol)
    {
        static bool External(ISymbol member) => !member.Locations.Any(location => location.IsInSource);
        for (var overridden = Overridden(symbol); overridden is not null; overridden = Overridden(overridden))
        {
            if (External(overridden)) return overridden.ToDisplayString();
        }
        var type = symbol.ContainingType;
        if (type is null) return null;
        foreach (var contract in type.AllInterfaces)
        {
            foreach (var member in contract.GetMembers(symbol.Name))
            {
                var implementation = type.FindImplementationForInterfaceMember(member);
                if (implementation is not null &&
                    SymbolEqualityComparer.Default.Equals(implementation.OriginalDefinition, symbol.OriginalDefinition) &&
                    External(member))
                {
                    return member.ToDisplayString();
                }
            }
        }
        return null;
    }

    private static ISymbol? Overridden(ISymbol symbol) => symbol switch
    {
        IMethodSymbol method => method.OverriddenMethod,
        IPropertySymbol property => property.OverriddenProperty,
        IEventSymbol @event => @event.OverriddenEvent,
        _ => null,
    };

    internal object SourceStatus(string file, int line)
    {
        var located = UnitsWithFile(file).ToList();
        if (located.Count == 0)
        {
            return new { ok = true, configurationGated = true, outsideProjection = true };
        }
        // Gated only when every build that compiles the file leaves the line
        // out (its #if branch is disabled under that unit's defines).
        var gated = true;
        foreach (var (_, tree) in located)
        {
            var source = tree.GetText();
            if (line < 1 || line > source.Lines.Count)
            {
                return new { ok = false, error = $"line outside file: {file}:{line}" };
            }
            var span = source.Lines[line - 1].Span;
            var disabled = tree.GetRoot()
                .DescendantTrivia(descendIntoTrivia: true)
                .Any(trivia => trivia.IsKind(SyntaxKind.DisabledTextTrivia) &&
                    trivia.Span.IntersectsWith(span));
            if (!disabled)
            {
                gated = false;
                break;
            }
        }
        return new { ok = true, configurationGated = gated };
    }

    private IEnumerable<(Unit Unit, SyntaxTree Tree)> UnitsWithFile(string file)
    {
        var normalized = file.Replace('\\', '/');
        foreach (var unit in _units)
        {
            if (unit.TreesByFile.TryGetValue(normalized, out var tree)) yield return (unit, tree);
        }
    }

    private void IndexSymbols()
    {
        var seen = new HashSet<string>(StringComparer.Ordinal);
        void Add(string name, SyntaxTree tree, CSharpSyntaxNode declaration, string kind, ISymbol? symbol, SyntaxToken identifier)
        {
            if (symbol is null || identifier.IsMissing || string.IsNullOrEmpty(name)) return;
            var file = Relative(tree.FilePath);
            if (file.StartsWith("../", StringComparison.Ordinal) ||
                !File.Exists(Path.Combine(_root, file))) return;
            var line = DeclarationStartLine(declaration);
            var identity = Identity(symbol);
            if (identity is null) return;
            if (!seen.Add($"{file}:{line}:{name}:{kind}")) return;
            var column = identifier.GetLocation().GetLineSpan().StartLinePosition.Character;
            _symbols.Add(new SymbolRow(name, file, line, kind, identity, column));
        }
        foreach (var unit in _units)
        {
            foreach (var tree in unit.Compilation.SyntaxTrees)
            {
                var model = unit.Models[tree];
                var root = tree.GetRoot();
                foreach (var node in root.DescendantNodes())
                {
                    switch (node)
                    {
                        case InterfaceDeclarationSyntax:
                            break;
                        case TypeDeclarationSyntax type:
                            Add(type.Identifier.Text, tree, type, "class",
                                model.GetDeclaredSymbol(type), type.Identifier);
                            break;
                        // Bodied, interface, abstract, partial-definition and
                        // extern methods are all callable declarations.
                        case MethodDeclarationSyntax method:
                            Add(method.Identifier.Text, tree, method, "method",
                                model.GetDeclaredSymbol(method), method.Identifier);
                            break;
                        case ConstructorDeclarationSyntax constructor
                            when !constructor.Modifiers.Any(SyntaxKind.StaticKeyword):
                            Add(constructor.Identifier.Text, tree, constructor, "constructor",
                                model.GetDeclaredSymbol(constructor), constructor.Identifier);
                            break;
                        case LocalFunctionStatementSyntax local:
                            Add(local.Identifier.Text, tree, local, "function",
                                model.GetDeclaredSymbol(local), local.Identifier);
                            break;
                        // Value members: accessed, never called.
                        case PropertyDeclarationSyntax property:
                            Add(property.Identifier.Text, tree, property, "property",
                                model.GetDeclaredSymbol(property), property.Identifier);
                            break;
                        case EnumMemberDeclarationSyntax member:
                            Add(member.Identifier.Text, tree, member, "enum-member",
                                model.GetDeclaredSymbol(member), member.Identifier);
                            break;
                        case FieldDeclarationSyntax field:
                            foreach (var variable in field.Declaration.Variables)
                            {
                                Add(variable.Identifier.Text, tree, variable,
                                    field.Modifiers.Any(SyntaxKind.ConstKeyword) ? "constant" : "field",
                                    model.GetDeclaredSymbol(variable), variable.Identifier);
                            }
                            break;
                    }
                }
            }
        }
        _symbols.Sort((left, right) =>
        {
            var byFile = StringComparer.Ordinal.Compare(left.File, right.File);
            if (byFile != 0) return byFile;
            var byLine = left.Line.CompareTo(right.Line);
            if (byLine != 0) return byLine;
            var byName = StringComparer.Ordinal.Compare(left.Name, right.Name);
            return byName != 0 ? byName : StringComparer.Ordinal.Compare(left.Kind, right.Kind);
        });
    }

    private void BuildReferenceIndex()
    {
        foreach (var unit in _units)
        {
            foreach (var tree in unit.Compilation.SyntaxTrees)
            {
                var model = unit.Models[tree];
                var root = tree.GetRoot();

                foreach (var invocation in root.DescendantNodes()
                    .OfType<InvocationExpressionSyntax>())
                {
                    AddResolved(model.GetSymbolInfo(invocation.Expression), tree,
                        NameToken(invocation.Expression).SpanStart, "call", constructorAsType: false);
                }

                foreach (var initializer in root.DescendantNodes()
                    .OfType<ConstructorInitializerSyntax>())
                {
                    AddConstruction(model.GetSymbolInfo(initializer), tree,
                        initializer.ThisOrBaseKeyword.SpanStart);
                }

                foreach (var creation in root.DescendantNodes()
                    .OfType<ObjectCreationExpressionSyntax>())
                {
                    AddConstruction(model.GetSymbolInfo(creation), tree,
                        NameToken(creation.Type).SpanStart);
                }
                foreach (var creation in root.DescendantNodes()
                    .OfType<ImplicitObjectCreationExpressionSyntax>())
                {
                    AddConstruction(model.GetSymbolInfo(creation), tree,
                        creation.NewKeyword.SpanStart);
                }

                foreach (var nameNode in root.DescendantNodes()
                    .OfType<SimpleNameSyntax>())
                {
                    if (IsDeclarationName(nameNode)) continue;
                    if (nameNode.Ancestors().OfType<InvocationExpressionSyntax>()
                        .Any(invocation =>
                            NameToken(invocation.Expression).Span == nameNode.Identifier.Span))
                    {
                        continue;
                    }
                    if (nameNode.Ancestors()
                        .OfType<ObjectCreationExpressionSyntax>()
                        .Any(creation => creation.Type.Span.Contains(nameNode.Span)))
                    {
                        continue;
                    }
                    AddResolved(model.GetSymbolInfo(nameNode), tree,
                        nameNode.Identifier.SpanStart, "reference", constructorAsType: true);
                }
            }
        }
    }

    // A construction is a reference of its type (UCN's class-usage contract)
    // and a call of the selected constructor (fix #429: constructor targets).
    private void AddConstruction(SymbolInfo info, SyntaxTree tree, int position)
    {
        var (symbols, unresolved) = Bound(info);
        foreach (var symbol in symbols)
        {
            if (symbol is not IMethodSymbol method) continue;
            AddIndexedReference(method.ContainingType, tree, position, "call", unresolved);
            if (method.MethodKind == MethodKind.Constructor)
            {
                AddIndexedReference(method, tree, position, "call", unresolved);
            }
        }
    }

    private void AddResolved(SymbolInfo info, SyntaxTree tree, int position, string kind, bool constructorAsType)
    {
        var (symbols, unresolved) = Bound(info);
        foreach (var bound in symbols)
        {
            var symbol = bound;
            if (constructorAsType &&
                symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor)
            {
                symbol = constructor.ContainingType;
            }
            AddIndexedReference(symbol, tree, position, kind, unresolved);
        }
    }

    // The compiler's binding of a site: its symbol, the members of a method
    // group, or (unresolved) the candidates of a failed resolution.
    private static (IEnumerable<ISymbol> Symbols, bool Unresolved) Bound(SymbolInfo info)
    {
        if (info.Symbol is not null) return (new[] { info.Symbol }, false);
        if (info.CandidateSymbols.Length == 0) return (Array.Empty<ISymbol>(), false);
        if (info.CandidateReason == CandidateReason.MemberGroup) return (info.CandidateSymbols, false);
        return (info.CandidateSymbols, true);
    }

    private static IEnumerable<ISymbol> ExactSymbols(SymbolInfo info)
    {
        if (info.Symbol is not null) return new[] { info.Symbol };
        return info.CandidateReason == CandidateReason.MemberGroup
            ? info.CandidateSymbols : Array.Empty<ISymbol>();
    }

    private void AddIndexedReference(
        ISymbol? symbol,
        SyntaxTree tree,
        int position,
        string kind,
        bool unresolved)
    {
        var identity = Identity(symbol);
        if (identity is null) return;
        var span = tree.GetLineSpan(new Microsoft.CodeAnalysis.Text.TextSpan(position, 0));
        if (!_referenceIndex.TryGetValue(identity, out var entries))
        {
            entries = new List<ReferenceRow>();
            _referenceIndex[identity] = entries;
        }
        entries.Add(new ReferenceRow(
            Relative(tree.FilePath),
            span.StartLinePosition.Line + 1,
            span.StartLinePosition.Character,
            kind,
            unresolved));
    }

    // Declaration-location identity, unified across compilations and across
    // the parts of one declaration (partial types and partial members).
    private string? Identity(ISymbol? symbol)
    {
        var normalized = NormalizeSymbol(symbol);
        if (normalized is null) return null;
        var locations = new List<Location>();
        void Collect(ISymbol? part)
        {
            if (part is null) return;
            locations.AddRange(part.Locations.Where(location => location.IsInSource));
        }
        Collect(normalized);
        if (normalized is IMethodSymbol method)
        {
            Collect(method.PartialDefinitionPart);
            Collect(method.PartialImplementationPart);
        }
        if (normalized is IPropertySymbol property)
        {
            Collect(property.PartialDefinitionPart);
            Collect(property.PartialImplementationPart);
        }
        if (locations.Count == 0) return null;
        var keys = locations
            .Select(location => $"{normalized.Kind}:{Relative(location.SourceTree!.FilePath)}:{location.SourceSpan.Start}")
            .Distinct(StringComparer.Ordinal)
            .ToList();
        // Rebuild with a fresh root for unmerged reference bookkeeping.
        var root = Find(keys[0]);
        foreach (var key in keys.Skip(1)) root = Union(root, Find(key));
        return root;
    }

    private string Find(string key)
    {
        if (!_parent.TryGetValue(key, out var parent))
        {
            _parent[key] = key;
            return key;
        }
        if (parent == key) return key;
        var root = Find(parent);
        _parent[key] = root;
        return root;
    }

    private string Union(string left, string right)
    {
        if (left == right) return left;
        // Deterministic root: the ordinal-smaller key.
        var (keep, drop) = StringComparer.Ordinal.Compare(left, right) <= 0 ? (left, right) : (right, left);
        _parent[drop] = keep;
        if (_referenceIndex.TryGetValue(drop, out var moved))
        {
            if (!_referenceIndex.TryGetValue(keep, out var target))
            {
                target = new List<ReferenceRow>();
                _referenceIndex[keep] = target;
            }
            target.AddRange(moved);
            _referenceIndex.Remove(drop);
        }
        return keep;
    }

    private SymbolRow? FindTarget(string file, int line, string name)
    {
        var normalized = file.Replace('\\', '/');
        return _symbols.FirstOrDefault(row =>
            row.File == normalized && row.Line == line && row.Name == name);
    }

    private static ISymbol? NormalizeSymbol(ISymbol? symbol)
    {
        if (symbol is IMethodSymbol { ReducedFrom: not null } reduced)
        {
            symbol = reduced.ReducedFrom;
        }
        return symbol?.OriginalDefinition;
    }

    private static void AddReference(
        Dictionary<string, object> refs,
        string file,
        int line,
        int column,
        string kind,
        bool unresolved)
    {
        var key = $"{file}:{line}:{column}:{kind}";
        // One site compiled by several units keeps its resolved reading.
        if (unresolved && refs.ContainsKey(key)) return;
        refs[key] = unresolved
            ? new
            {
                file,
                line,
                column,
                kind,
                oracleResolution = "unresolved",
                uncertaintyClass = "oracle-unresolved",
            }
            : new { file, line, column, kind };
    }

    private static SyntaxToken NameToken(ExpressionSyntax expression)
    {
        return expression switch
        {
            MemberAccessExpressionSyntax member => member.Name.Identifier,
            MemberBindingExpressionSyntax binding => binding.Name.Identifier,
            SimpleNameSyntax simple => simple.Identifier,
            _ => expression.GetLastToken(),
        };
    }

    private static SyntaxToken NameToken(TypeSyntax type)
    {
        return type switch
        {
            QualifiedNameSyntax qualified => qualified.Right.Identifier,
            AliasQualifiedNameSyntax alias => alias.Name.Identifier,
            SimpleNameSyntax simple => simple.Identifier,
            _ => type.GetLastToken(),
        };
    }

    private static bool IsDeclarationName(SimpleNameSyntax node)
    {
        var token = node.Identifier;
        return node.Parent switch
        {
            TypeDeclarationSyntax declaration => declaration.Identifier == token,
            MethodDeclarationSyntax declaration => declaration.Identifier == token,
            LocalFunctionStatementSyntax declaration => declaration.Identifier == token,
            _ => false,
        };
    }

    private static int DeclarationStartLine(CSharpSyntaxNode node)
    {
        var attributes = node switch
        {
            MemberDeclarationSyntax member => member.AttributeLists,
            LocalFunctionStatementSyntax local => local.AttributeLists,
            _ => default,
        };
        var start = attributes.Count > 0 ? attributes[0].SpanStart : node.SpanStart;
        return node.SyntaxTree.GetLineSpan(
            new Microsoft.CodeAnalysis.Text.TextSpan(start, 0))
            .StartLinePosition.Line + 1;
    }

    private string Relative(string file)
    {
        return Path.GetRelativePath(_root, file).Replace('\\', '/');
    }

    private static bool WordBoundary(string text, int start, int length)
    {
        static bool IsWord(char ch) => char.IsLetterOrDigit(ch) || ch == '_';
        return (start == 0 || !IsWord(text[start - 1])) &&
            (start + length >= text.Length || !IsWord(text[start + length]));
    }

    private static IEnumerable<string> EnumerateFiles(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            foreach (var child in Directory.EnumerateDirectories(directory)
                .OrderByDescending(value => value, StringComparer.Ordinal))
            {
                if (!ExcludedDirectories.Contains(Path.GetFileName(child)))
                {
                    pending.Push(child);
                }
            }
            foreach (var file in Directory.EnumerateFiles(directory, "*.cs")
                .OrderBy(value => value, StringComparer.Ordinal))
            {
                yield return file;
            }
        }
    }

    private static ImmutableArray<MetadataReference> TrustedPlatformReferences()
    {
        var trusted = AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string;
        if (string.IsNullOrWhiteSpace(trusted))
        {
            throw new InvalidOperationException(
                "TRUSTED_PLATFORM_ASSEMBLIES is unavailable");
        }
        return trusted.Split(Path.PathSeparator)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .Select(path =>
                (MetadataReference)MetadataReference.CreateFromFile(path))
            .ToImmutableArray();
    }
}

internal static class Program
{
    private static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
    };

    private static void Write(object value)
    {
        Console.WriteLine(JsonSerializer.Serialize(value, JsonOptions));
        Console.Out.Flush();
    }

    public static int Main(string[] args)
    {
        if (args.Length is < 1 or > 2)
        {
            Console.Error.WriteLine(
                "usage: RoslynHelper <repository-root> [msbuild-config.json]");
            return 2;
        }

        RoslynOracle oracle;
        try
        {
            oracle = new RoslynOracle(
                args[0],
                args.Length > 1 ? args[1] : null);
            Write(oracle.Ready());
        }
        catch (Exception error)
        {
            Write(new { ok = false, error = error.ToString() });
            return 1;
        }

        string? line;
        while ((line = Console.ReadLine()) is not null)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var document = JsonDocument.Parse(line);
                var root = document.RootElement;
                var operation = root.GetProperty("op").GetString();
                switch (operation)
                {
                    case "list_symbols":
                        Write(oracle.ListSymbols());
                        break;
                    case "find_references":
                        Write(oracle.FindReferences(
                            root.GetProperty("file").GetString()!,
                            root.GetProperty("line").GetInt32(),
                            root.GetProperty("name").GetString()!));
                        break;
                    case "resolve_definition":
                        Write(oracle.ResolveDefinition(
                            root.GetProperty("file").GetString()!,
                            root.GetProperty("line").GetInt32(),
                            root.GetProperty("name").GetString()!,
                            root.TryGetProperty("column", out var column)
                                ? column.GetInt32()
                                : null));
                        break;
                    case "reference_blindness":
                        Write(oracle.ReferenceBlindness(
                            root.GetProperty("file").GetString()!,
                            root.GetProperty("line").GetInt32(),
                            root.GetProperty("name").GetString()!));
                        break;
                    case "source_status":
                        Write(oracle.SourceStatus(
                            root.GetProperty("file").GetString()!,
                            root.GetProperty("line").GetInt32()));
                        break;
                    case "shutdown":
                        Write(new { ok = true });
                        return 0;
                    default:
                        Write(new { ok = false, error = $"unknown op: {operation}" });
                        break;
                }
            }
            catch (Exception error)
            {
                Write(new { ok = false, error = error.Message });
            }
        }
        return 0;
    }
}
