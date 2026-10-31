/**
 * C# compiler oracle backed by Roslyn from the installed .NET SDK.
 *
 * The persistent helper builds one semantic compilation per project unit
 * (every .csproj under the target at one target framework, plus the project
 * references they reach at the framework MSBuild selects for them), then
 * resolves definitions and references with Roslyn symbols. It shares no
 * parsing or resolution code with UCN.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { makeHelperHandle } = require('./jsonl-helper');

const HELPER_PROJECT = path.join(
    __dirname, 'roslyn-helper', 'RoslynHelper.csproj');
// dotnet resolves global.json from the WORKING DIRECTORY, not the project
// path. Every dotnet invocation below runs from the helper directory, so one
// SDK (the newest installed at or above the helper's floor) builds the
// helper, restores the target and evaluates it: the helper targets that
// SDK's runtime and references that SDK's own compiler assemblies.
const HELPER_DIR = path.dirname(HELPER_PROJECT);
const PROJECT_EXCLUDED_DIRS = new Set(['bin', 'obj', 'node_modules', 'TestResults']);

const roslynOracle = {
    name: 'roslyn',
    languages: ['csharp'],

    async prepare(repoDir) {
        // MSBuild canonicalizes project references. Keep the roots, source
        // files and project-unit keys in that same physical-path identity,
        // including when the caller reached the repository through a link.
        repoDir = fs.realpathSync(repoDir);
        resolveDotnet();
        const sdk = sdkVersion();
        const projectConfig = prepareProjectConfig(repoDir, sdk);
        // MSBuild writes its errors to STDOUT, so both streams must be
        // captured — an ignored stdout once reduced a real CI build failure
        // to a wrong guess about the SDK version.
        const build = runDotnet([
            'build', HELPER_PROJECT,
            '--configuration', 'Release',
            '--nologo',
            '--verbosity', 'quiet',
        ]);
        if (build.status !== 0) {
            const detail = [build.stdout, build.stderr, build.error?.message]
                .filter(Boolean).join('\n').trim();
            const tail = detail.split('\n').slice(-15).join('\n');
            throw new Error(`Roslyn helper build failed (exit ${build.status})` +
                (tail ? `:\n${tail}` : ''));
        }
        const child = spawn('dotnet', [
            'run',
            '--project', HELPER_PROJECT,
            '--configuration', 'Release',
            '--no-build',
            '--',
            repoDir,
            ...(projectConfig ? [projectConfig.path] : []),
        ], {
            cwd: HELPER_DIR,
            stdio: ['pipe', 'pipe', 'inherit'],
        });
        const helper = makeHelperHandle(child, {
            label: 'Roslyn helper',
            timeoutMs: 600000,
        });
        const banner = JSON.parse(await helper.expectLine());
        if (!banner.ok) {
            throw new Error(`Roslyn helper failed to start: ${banner.error}`);
        }
        const frameworks = [...new Set((banner.units || [])
            .map(unit => unit.targetFramework).filter(Boolean))].sort();
        process.stdout.write(
            `  Roslyn via dotnet ${sdk.version} ` +
            `(${banner.files} files, ${(banner.units || []).length} project unit(s)` +
            `${frameworks.length ? ` [${frameworks.join(', ')}]` : ', syntax-only fallback'}, ` +
            `${banner.compileErrors} compilation diagnostics)\n`);
        for (const unloaded of projectConfig?.unloadable || []) {
            process.stdout.write(`  ⚠ Roslyn oracle cannot load ${unloaded.project}: ${unloaded.reason} ` +
                '(its files are outside the oracle projection)\n');
        }
        return {
            helper,
            root: repoDir,
            configPath: projectConfig?.path || null,
            projection: {
                sdk: sdk.version,
                units: (banner.units || []).map(unit => ({
                    name: unit.name, targetFramework: unit.targetFramework,
                    files: unit.files, errors: unit.errors,
                })),
                unloadable: projectConfig?.unloadable || [],
            },
        };
    },

    async listSymbols(handle, { kinds, limit } = {}) {
        const response = await handle.helper.request({
            op: 'list_symbols',
        });
        let symbols = response.symbols || [];
        if (kinds) {
            const wanted = new Set(kinds);
            symbols = symbols.filter(symbol => wanted.has(symbol.kind));
        }
        return limit ? symbols.slice(0, limit) : symbols;
    },

    async findReferences(handle, { name, file, line }) {
        const response = await handle.helper.request({
            op: 'find_references',
            name,
            file,
            line,
        });
        return response.refs || [];
    },

    async resolveDefinition(handle, { name, file, line, column }) {
        const response = await handle.helper.request({
            op: 'resolve_definition',
            name,
            file,
            line,
            ...(Number.isInteger(column) && { column }),
        });
        return response.definitions || [];
    },

    /** A member reached through a contract declared outside the
     *  compilation (external override or interface implementation): its
     *  callers through that contract are invisible to reference search. */
    async referenceBlindness(handle, { name, file, line }) {
        const response = await handle.helper.request({ op: 'reference_blindness', name, file, line });
        return response.blind ? { reason: response.reason, detail: response.detail } : null;
    },

    async isConfigurationGated(handle, { file, line }) {
        const response = await handle.helper.request({
            op: 'source_status',
            file,
            line,
        });
        if (!response.ok) {
            throw new Error(response.error || `Roslyn source status failed: ${file}:${line}`);
        }
        return !!response.configurationGated;
    },

    async dispose(handle) {
        try {
            await handle.helper.request({ op: 'shutdown' });
        } catch {
            try { handle.helper.child.kill(); } catch { /* gone */ }
        } finally {
            if (handle.configPath) {
                try { fs.unlinkSync(handle.configPath); } catch { /* already gone */ }
            }
        }
    },
};

function runDotnet(args, options = {}) {
    return spawnSync('dotnet', args, {
        cwd: HELPER_DIR,
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
        env: {
            ...process.env,
            DOTNET_CLI_TELEMETRY_OPTOUT: '1',
            DOTNET_NOLOGO: '1',
            // A shared MSBuild node or build server can outlive the oracle
            // and keep a stale SDK/assembly view between runs.
            MSBUILDDISABLENODEREUSE: '1',
            DOTNET_CLI_DO_NOT_USE_MSBUILD_SERVER: '1',
            UseSharedCompilation: 'false',
        },
        ...options,
    });
}

function resolveDotnet() {
    const result = spawnSync('dotnet', ['--version'], { cwd: HELPER_DIR, stdio: 'pipe' });
    if (result.status === 0) return 'dotnet';
    throw new Error(
        'dotnet not found — install the .NET 9+ SDK to run the Roslyn oracle');
}

/** The SDK the helper directory selects (its global.json floor, newest
 *  installed band): it builds the helper and evaluates the target. */
function sdkVersion() {
    const result = runDotnet(['--version']);
    const version = String(result.stdout || '').trim();
    const major = Number(version.match(/^(\d+)\./)?.[1]);
    if (result.status !== 0 || !Number.isInteger(major)) {
        throw new Error(`dotnet --version failed: ${result.stderr || result.stdout}`.trim());
    }
    return { version, major };
}

/**
 * Every project unit the oracle compiles: each .csproj under the target at
 * its newest framework the SDK can build, and the project references those
 * units reach at the framework MSBuild selects for each reference
 * (NearestTargetFramework). A project the SDK cannot build or restore is
 * reported, never silently dropped.
 */
function prepareProjectConfig(repoDir, sdk) {
    const projects = findProjects(repoDir);
    if (projects.length === 0) return null;
    const unloadable = [];
    const units = new Map();
    const queue = [];
    const restored = new Set();
    const restore = (project, frameworks, chosen) => {
        if (restored.has(project)) return true;
        restored.add(project);
        // Restore every declared framework when the SDK can build all of
        // them (references resolve at their own nearest framework); a project
        // with a framework newer than the SDK restores only the chosen one.
        const needsCap = frameworks.some(framework => !frameworkBuildable(framework, sdk.major));
        const attempt = cap => runDotnet([
            'restore', project,
            ...(cap ? [`-property:TargetFrameworks=${chosen}`] : []),
            '-property:Configuration=Release',
            // Vulnerability and other restore warnings are not errors for an
            // oracle that only reads the compilation.
            '-property:TreatWarningsAsErrors=false',
            '-property:NuGetAudit=false',
            '--nologo',
            '--verbosity', 'quiet',
        ]);
        let result = attempt(needsCap);
        // A framework the host cannot restore (old reference packs offline)
        // must not cost the project: restore the compiled framework alone.
        if (result.status !== 0 && !needsCap) result = attempt(true);
        if (result.status !== 0) {
            unloadable.push({ project: path.relative(repoDir, project),
                reason: `restore failed: ${firstError(result)}` });
            return false;
        }
        return true;
    };
    for (const project of projects) {
        let properties;
        try {
            properties = runMsbuildJson(project, [
                '-getProperty:TargetFramework',
                '-getProperty:TargetFrameworks',
            ]).Properties || {};
        } catch (error) {
            unloadable.push({ project: path.relative(repoDir, project), reason: error.message.split('\n')[0] });
            continue;
        }
        const frameworks = declaredFrameworks(properties.TargetFramework, properties.TargetFrameworks);
        if (frameworks.length === 0) continue; // traversal/no-target project: no sources
        const chosen = chooseTargetFramework(properties.TargetFramework, properties.TargetFrameworks, sdk.major);
        if (!chosen) {
            unloadable.push({ project: path.relative(repoDir, project),
                reason: `no target framework the .NET ${sdk.version} SDK can build (${frameworks.join(';')})` });
            continue;
        }
        if (!restore(project, frameworks, chosen)) continue;
        queue.push({ project, framework: chosen });
    }
    while (queue.length > 0) {
        const { project, framework } = queue.shift();
        const name = unitName(repoDir, project, framework);
        if (units.has(name)) continue;
        let evaluated;
        try {
            evaluated = runMsbuildJson(project, [
                `-property:TargetFramework=${framework}`,
                '-property:Configuration=Release',
                '-property:BuildProjectReferences=false',
                '-target:ResolveReferences',
                '-getProperty:DefineConstants',
                '-getProperty:LangVersion',
                '-getProperty:AssemblyName',
                '-getProperty:AllowUnsafeBlocks',
                '-getItem:Compile',
                '-getItem:ReferencePath',
                '-getItem:Using',
            ]);
        } catch (error) {
            unloadable.push({ project: path.relative(repoDir, project),
                reason: `${framework} evaluation failed: ${error.message.split('\n')[0]}` });
            units.set(name, null);
            continue;
        }
        const files = (evaluated.Items?.Compile || [])
            .map(item => item.FullPath || path.resolve(path.dirname(project), item.Identity))
            .filter(file => file.endsWith('.cs') && fs.existsSync(file))
            .map(file => fs.realpathSync(file));
        const references = [];
        const projectReferences = [];
        for (const item of evaluated.Items?.ReferencePath || []) {
            if (item.ReferenceSourceTarget === 'ProjectReference' && item.MSBuildSourceProjectFile) {
                const dependency = fs.realpathSync(item.MSBuildSourceProjectFile);
                const dependencyFramework = item.NearestTargetFramework ||
                    String(item.SetTargetFramework || '').replace(/^TargetFramework=/, '');
                if (!dependencyFramework) continue;
                if (!restored.has(dependency)) {
                    // A reference outside the target: restore it like a root.
                    let dependencyProperties;
                    try {
                        dependencyProperties = runMsbuildJson(dependency, [
                            '-getProperty:TargetFramework', '-getProperty:TargetFrameworks',
                        ]).Properties || {};
                    } catch (error) {
                        restored.add(dependency);
                        unloadable.push({ project: path.relative(repoDir, dependency), reason: error.message.split('\n')[0] });
                        continue;
                    }
                    if (!restore(dependency, declaredFrameworks(dependencyProperties.TargetFramework,
                        dependencyProperties.TargetFrameworks), dependencyFramework)) continue;
                }
                projectReferences.push(unitName(repoDir, dependency, dependencyFramework));
                queue.push({ project: dependency, framework: dependencyFramework });
                continue;
            }
            const file = item.FullPath || item.Identity;
            if (file && fs.existsSync(file)) references.push(file);
        }
        if (files.length === 0) {
            units.set(name, null);
            continue;
        }
        units.set(name, {
            name,
            project: path.relative(repoDir, project),
            assemblyName: evaluated.Properties?.AssemblyName || path.basename(project, '.csproj'),
            targetFramework: framework,
            files,
            references,
            projectReferences,
            defines: String(evaluated.Properties?.DefineConstants || '')
                .split(/[;,]/)
                .map(value => value.trim())
                .filter(Boolean),
            languageVersion: evaluated.Properties?.LangVersion || 'latest',
            allowUnsafe: /^true$/i.test(String(evaluated.Properties?.AllowUnsafeBlocks || '')),
            usings: (evaluated.Items?.Using || []).map(item => ({
                name: item.Identity,
                static: /^true$/i.test(String(item.Static || '')),
                alias: item.Alias || null,
            })),
        });
    }
    const loaded = [...units.values()].filter(Boolean);
    for (const unit of loaded) {
        unit.projectReferences = unit.projectReferences.filter(name => units.get(name));
    }
    if (loaded.length === 0) {
        throw new Error('Roslyn oracle loaded no project under the target: ' +
            unloadable.map(entry => `${entry.project} (${entry.reason})`).join('; '));
    }
    const config = { units: loaded };
    const configPath = path.join(
        os.tmpdir(),
        `ucn-roslyn-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config));
    return { path: configPath, unloadable };
}

function unitName(repoDir, project, framework) {
    return `${path.relative(repoDir, project).replace(/\\/g, '/')}|${framework}`;
}

function firstError(result) {
    const text = `${result.stdout || ''}\n${result.stderr || ''}`;
    const line = text.split('\n').find(entry => /\berror\b/i.test(entry)) ||
        text.split('\n').find(entry => entry.trim()) || `exit ${result.status}`;
    return line.trim().slice(0, 300);
}

function runMsbuildJson(project, options) {
    const result = runDotnet([
        'msbuild', project,
        ...options,
        '-verbosity:quiet',
    ]);
    if (result.status !== 0) {
        throw new Error(
            `Roslyn oracle MSBuild evaluation failed for ${path.basename(project)}: ` +
            `${firstError(result)}`);
    }
    const start = result.stdout.indexOf('{');
    if (start < 0) throw new Error('MSBuild did not return its JSON evaluation');
    return JSON.parse(result.stdout.slice(start));
}

function declaredFrameworks(single, plural) {
    if (single) return [String(single).trim()];
    return String(plural || '').split(';').map(value => value.trim()).filter(Boolean);
}

/**
 * The newest framework among a project's declared frameworks that the SDK
 * can build (fix #429): `netN.M` needs SDK major >= N; .NET Standard, .NET
 * Core 1-3 and .NET Framework reference packs build on any supported SDK.
 * Plain frameworks rank above platform-specific ones (`net8.0-windows`
 * needs a platform targeting pack), modern .NET above .NET Core above
 * .NET Standard above .NET Framework. null when the SDK can build none.
 */
function chooseTargetFramework(single, plural, sdkMajor = Infinity) {
    const choices = declaredFrameworks(single, plural);
    const ranked = choices
        .map(framework => ({ framework, rank: frameworkRank(framework) }))
        .filter(entry => frameworkBuildable(entry.framework, sdkMajor))
        .sort((a, b) => b.rank - a.rank || (a.framework < b.framework ? -1 : 1));
    return ranked[0]?.framework || null;
}

function frameworkParts(framework) {
    const text = String(framework || '').toLowerCase();
    const platform = text.includes('-');
    const base = text.split('-')[0];
    let match;
    if ((match = base.match(/^net(\d+)\.(\d+)$/)) && Number(match[1]) >= 5) {
        return { family: 'net', major: Number(match[1]), minor: Number(match[2]), platform };
    }
    if ((match = base.match(/^netcoreapp(\d+)\.(\d+)$/))) {
        return { family: 'netcoreapp', major: Number(match[1]), minor: Number(match[2]), platform };
    }
    if ((match = base.match(/^netstandard(\d+)\.(\d+)$/))) {
        return { family: 'netstandard', major: Number(match[1]), minor: Number(match[2]), platform };
    }
    if ((match = base.match(/^net(\d)(\d)(\d)?$/))) {
        return { family: 'netfx', major: Number(match[1]), minor: Number(match[2]) * 10 + Number(match[3] || 0), platform };
    }
    return { family: 'unknown', major: 0, minor: 0, platform };
}

function frameworkBuildable(framework, sdkMajor) {
    const parts = frameworkParts(framework);
    if (parts.family === 'net') return parts.major <= sdkMajor;
    return parts.family !== 'unknown';
}

function frameworkRank(framework) {
    const parts = frameworkParts(framework);
    const family = { net: 4, netcoreapp: 3, netstandard: 2, netfx: 1, unknown: 0 }[parts.family];
    return (parts.platform ? 0 : 10000) + family * 1000 + parts.major * 100 + parts.minor;
}

/** Every .csproj under the target (fix #429: tests, samples, benchmarks
 *  and tools are part of the universe UCN indexes). */
function findProjects(root) {
    const queue = [root];
    const projects = [];
    while (queue.length > 0) {
        const dir = queue.shift();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') || PROJECT_EXCLUDED_DIRS.has(entry.name)) continue;
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) queue.push(full);
            else if (entry.isFile() && entry.name.endsWith('.csproj')) projects.push(full);
        }
    }
    return projects.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

module.exports = { roslynOracle, chooseTargetFramework, frameworkBuildable, findProjects };
