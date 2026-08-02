// Compiler-backed C# semantic oracle for UCN's release evaluation.
//
// This helper deliberately uses Roslyn from the installed .NET SDK, not
// UCN/tree-sitter. It builds one in-memory compilation over the repository's
// C# sources and serves exact symbol/reference/definition queries over JSONL.

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
    ISymbol Symbol);

internal sealed record ReferenceRow(
    string File,
    int Line,
    int Column,
    string Kind);

internal sealed record OracleConfig(
    string[] Files,
    string[] References,
    string[] Defines,
    string? LanguageVersion,
    string? Nullable,
    string? TargetFramework);

internal sealed class RoslynOracle
{
    private static readonly HashSet<string> ExcludedDirectories =
        new(StringComparer.OrdinalIgnoreCase)
        {
            ".git", ".svn", "bin", "obj", "node_modules", "TestResults",
        };

    private readonly string _root;
    private readonly CSharpCompilation _compilation;
    private readonly Dictionary<SyntaxTree, SemanticModel> _models = new();
    private readonly List<SymbolRow> _symbols = new();
    private readonly Dictionary<ISymbol, List<ReferenceRow>> _referenceIndex =
        new(SymbolEqualityComparer.Default);
    private readonly string? _targetFramework;

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
        var languageVersion = LanguageVersion.Latest;
        if (!string.IsNullOrWhiteSpace(config?.LanguageVersion))
        {
            if (LanguageVersionFacts.TryParse(
                config.LanguageVersion,
                out var parsedLanguageVersion))
            {
                languageVersion = parsedLanguageVersion;
            }
        }
        var parseOptions = CSharpParseOptions.Default
            .WithLanguageVersion(languageVersion)
            .WithDocumentationMode(DocumentationMode.Parse)
            .WithPreprocessorSymbols(config?.Defines ?? Array.Empty<string>());
        var sourceFiles = config?.Files?.Length > 0
            ? config.Files
            : EnumerateFiles(_root);
        var trees = sourceFiles
            .Select(file => CSharpSyntaxTree.ParseText(
                File.ReadAllText(file),
                parseOptions,
                path: file))
            .ToArray();
        ImmutableArray<MetadataReference> references = config?.References?.Length > 0
            ? config.References
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select(file => (MetadataReference)MetadataReference.CreateFromFile(file))
                .ToImmutableArray()
            : TrustedPlatformReferences();
        _targetFramework = config?.TargetFramework;
        _compilation = CSharpCompilation.Create(
            "UcnRoslynOracle",
            trees,
            references,
            new CSharpCompilationOptions(
                OutputKind.DynamicallyLinkedLibrary,
                allowUnsafe: true,
                nullableContextOptions: NullableContextOptions.Enable));
        foreach (var tree in trees)
        {
            _models[tree] = _compilation.GetSemanticModel(
                tree,
                ignoreAccessibility: true);
        }
        IndexSymbols();
        BuildReferenceIndex();
    }

    internal object Ready()
    {
        var errors = _compilation.GetDiagnostics()
            .Count(diagnostic => diagnostic.Severity == DiagnosticSeverity.Error);
        return new
        {
            ok = true,
            ready = true,
            roslyn = true,
            files = _compilation.SyntaxTrees.Count(),
            compileErrors = errors,
            targetFramework = _targetFramework,
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
        AddReference(
            refs,
            target.File,
            target.Line,
            DeclarationColumn(target.Symbol),
            "definition");
        var normalized = NormalizeSymbol(target.Symbol);
        if (normalized is not null &&
            _referenceIndex.TryGetValue(normalized, out var indexed))
        {
            foreach (var reference in indexed)
            {
                AddReference(
                    refs,
                    reference.File,
                    reference.Line,
                    reference.Column,
                    reference.Kind);
            }
        }

        return new { ok = true, refs = refs.Values };
    }

    internal object ResolveDefinition(string file, int line, string name, int? column)
    {
        var tree = FindTree(file);
        if (tree is null)
        {
            return new { ok = false, error = $"file not in compilation: {file}" };
        }
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
                if (WordBoundary(text, at, name.Length))
                {
                    positions.Add(lineText.Start + at);
                }
                from = at + Math.Max(1, name.Length);
            }
        }

        var model = _models[tree];
        var definitions = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var position in positions)
        {
            var node = tree.GetRoot().FindToken(position).Parent;
            var ancestors = node?.AncestorsAndSelf().ToArray() ??
                Array.Empty<SyntaxNode>();
            // Prefer the complete call expression. Querying the nested
            // SimpleNameSyntax returns an overload group and CandidateSymbols
            // order is not semantic overload selection.
            SyntaxNode? expression = ancestors
                .OfType<InvocationExpressionSyntax>()
                .FirstOrDefault(candidate =>
                    NameToken(candidate.Expression).Span.Contains(position));
            expression ??= ancestors
                .OfType<ObjectCreationExpressionSyntax>()
                .FirstOrDefault(candidate => candidate.Type.Span.Contains(position));
            expression ??= ancestors.OfType<SimpleNameSyntax>().FirstOrDefault();
            if (expression is null) continue;
            var symbol = expression switch
            {
                InvocationExpressionSyntax invocation =>
                    BestSymbol(model.GetSymbolInfo(invocation.Expression)),
                ObjectCreationExpressionSyntax creation =>
                    BestSymbol(model.GetSymbolInfo(creation)),
                _ => BestSymbol(model.GetSymbolInfo(expression)),
            };
            if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor)
            {
                symbol = constructor.ContainingType;
            }
            if (symbol is null) continue;
            foreach (var location in symbol.OriginalDefinition.Locations.Where(loc => loc.IsInSource))
            {
                var span = location.GetLineSpan();
                var rel = Relative(span.Path);
                var defLine = span.StartLinePosition.Line + 1;
                definitions[$"{rel}:{defLine}"] = new
                {
                    file = rel,
                    line = defLine,
                };
            }
        }
        return new { ok = true, definitions = definitions.Values };
    }

    internal object SourceStatus(string file, int line)
    {
        var tree = FindTree(file);
        if (tree is null)
        {
            return new { ok = false, error = $"file not in compilation: {file}" };
        }
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
        return new { ok = true, configurationGated = disabled };
    }

    private void IndexSymbols()
    {
        foreach (var tree in _compilation.SyntaxTrees)
        {
            var model = _models[tree];
            var root = tree.GetRoot();
            foreach (var declaration in root.DescendantNodes().OfType<TypeDeclarationSyntax>())
            {
                if (declaration is InterfaceDeclarationSyntax) continue;
                var symbol = model.GetDeclaredSymbol(declaration);
                if (symbol is null || declaration.Identifier.IsMissing) continue;
                _symbols.Add(new SymbolRow(
                    declaration.Identifier.Text,
                    Relative(tree.FilePath),
                    DeclarationStartLine(declaration),
                    "class",
                    symbol));
            }
            foreach (var declaration in root.DescendantNodes().OfType<MethodDeclarationSyntax>())
            {
                if (declaration.Body is null && declaration.ExpressionBody is null) continue;
                var symbol = model.GetDeclaredSymbol(declaration);
                if (symbol is null || declaration.Identifier.IsMissing) continue;
                _symbols.Add(new SymbolRow(
                    declaration.Identifier.Text,
                    Relative(tree.FilePath),
                    DeclarationStartLine(declaration),
                    "method",
                    symbol));
            }
            foreach (var declaration in root.DescendantNodes().OfType<LocalFunctionStatementSyntax>())
            {
                var symbol = model.GetDeclaredSymbol(declaration);
                if (symbol is null || declaration.Identifier.IsMissing) continue;
                _symbols.Add(new SymbolRow(
                    declaration.Identifier.Text,
                    Relative(tree.FilePath),
                    DeclarationStartLine(declaration),
                    "function",
                    symbol));
            }
        }
        _symbols.Sort((left, right) =>
        {
            var byFile = StringComparer.Ordinal.Compare(left.File, right.File);
            if (byFile != 0) return byFile;
            var byLine = left.Line.CompareTo(right.Line);
            return byLine != 0
                ? byLine
                : StringComparer.Ordinal.Compare(left.Name, right.Name);
        });
    }

    private void BuildReferenceIndex()
    {
        foreach (var tree in _compilation.SyntaxTrees)
        {
            var model = _models[tree];
            var root = tree.GetRoot();

            foreach (var invocation in root.DescendantNodes()
                .OfType<InvocationExpressionSyntax>())
            {
                var symbol = BestSymbol(model.GetSymbolInfo(invocation.Expression));
                var token = NameToken(invocation.Expression);
                AddIndexedReference(symbol, tree, token.SpanStart, "call");
            }

            foreach (var creation in root.DescendantNodes()
                .OfType<ObjectCreationExpressionSyntax>())
            {
                var constructor = BestSymbol(model.GetSymbolInfo(creation));
                var type = constructor is IMethodSymbol method
                    ? method.ContainingType
                    : null;
                AddIndexedReference(
                    type,
                    tree,
                    NameToken(creation.Type).SpanStart,
                    "call");
            }
            foreach (var creation in root.DescendantNodes()
                .OfType<ImplicitObjectCreationExpressionSyntax>())
            {
                var constructor = BestSymbol(model.GetSymbolInfo(creation));
                var type = constructor is IMethodSymbol method
                    ? method.ContainingType
                    : null;
                AddIndexedReference(
                    type,
                    tree,
                    creation.NewKeyword.SpanStart,
                    "call");
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
                var symbol = BestSymbol(model.GetSymbolInfo(nameNode));
                if (symbol is IMethodSymbol { MethodKind: MethodKind.Constructor } constructor)
                {
                    symbol = constructor.ContainingType;
                }
                AddIndexedReference(
                    symbol,
                    tree,
                    nameNode.Identifier.SpanStart,
                    "reference");
            }
        }
    }

    private void AddIndexedReference(
        ISymbol? symbol,
        SyntaxTree tree,
        int position,
        string kind)
    {
        var normalized = NormalizeSymbol(symbol);
        if (normalized is null ||
            !normalized.Locations.Any(location => location.IsInSource))
        {
            return;
        }
        var span = tree.GetLineSpan(
            new Microsoft.CodeAnalysis.Text.TextSpan(position, 0));
        if (!_referenceIndex.TryGetValue(normalized, out var entries))
        {
            entries = new List<ReferenceRow>();
            _referenceIndex[normalized] = entries;
        }
        entries.Add(new ReferenceRow(
            Relative(tree.FilePath),
            span.StartLinePosition.Line + 1,
            span.StartLinePosition.Character,
            kind));
    }

    private SymbolRow? FindTarget(string file, int line, string name)
    {
        var normalized = file.Replace('\\', '/');
        return _symbols.FirstOrDefault(row =>
            row.File == normalized && row.Line == line && row.Name == name);
    }

    private SyntaxTree? FindTree(string file)
    {
        var normalized = file.Replace('\\', '/');
        return _compilation.SyntaxTrees.FirstOrDefault(tree =>
            Relative(tree.FilePath) == normalized);
    }

    private static ISymbol? BestSymbol(SymbolInfo info)
    {
        return info.Symbol ?? info.CandidateSymbols.FirstOrDefault();
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
        string kind)
    {
        refs[$"{file}:{line}:{column}:{kind}"] = new
        {
            file,
            line,
            column,
            kind,
        };
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
        var start = node switch
        {
            TypeDeclarationSyntax type when type.AttributeLists.Count > 0 =>
                type.AttributeLists[0].SpanStart,
            MethodDeclarationSyntax method when method.AttributeLists.Count > 0 =>
                method.AttributeLists[0].SpanStart,
            LocalFunctionStatementSyntax local when local.AttributeLists.Count > 0 =>
                local.AttributeLists[0].SpanStart,
            _ => node.SpanStart,
        };
        return node.SyntaxTree.GetLineSpan(
            new Microsoft.CodeAnalysis.Text.TextSpan(start, 0))
            .StartLinePosition.Line + 1;
    }

    private int DeclarationColumn(ISymbol symbol)
    {
        var location = symbol.Locations.FirstOrDefault(loc => loc.IsInSource);
        return location?.GetLineSpan().StartLinePosition.Character ?? 0;
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
