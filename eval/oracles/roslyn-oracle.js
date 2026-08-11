/**
 * C# compiler oracle backed by Roslyn from the installed .NET SDK.
 *
 * The persistent helper builds one semantic compilation over the repository,
 * then resolves definitions and references with Roslyn symbols. It shares no
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
// path — every dotnet invocation below runs from the helper directory so its
// SDK pin (9.x band; see the csproj comment) governs even when a newer SDK is
// installed alongside (CI runners preinstall the latest .NET).
const HELPER_DIR = path.dirname(HELPER_PROJECT);

const roslynOracle = {
    name: 'roslyn',
    languages: ['csharp'],

    async prepare(repoDir) {
        resolveDotnet();
        const projectConfig = prepareProjectConfig(repoDir);
        // MSBuild writes its errors to STDOUT, so both streams must be
        // captured — an ignored stdout once reduced a real CI build failure
        // to a wrong guess about the SDK version.
        const build = spawnSync('dotnet', [
            'build', HELPER_PROJECT,
            '--configuration', 'Release',
            '--nologo',
            '--verbosity', 'quiet',
        ], {
            cwd: HELPER_DIR,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
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
            timeoutMs: 300000,
        });
        const banner = JSON.parse(await helper.expectLine());
        if (!banner.ok) {
            throw new Error(`Roslyn helper failed to start: ${banner.error}`);
        }
        const version = spawnSync('dotnet', ['--version'], {
            cwd: HELPER_DIR,
            stdio: 'pipe',
        }).stdout?.toString().trim() || 'unknown';
        process.stdout.write(
            `  Roslyn via dotnet ${version} ` +
            `(${banner.files} files, ${banner.compileErrors} compilation diagnostics` +
            `${banner.targetFramework ? `, ${banner.targetFramework}` : ', syntax-only fallback'})\n`);
        return {
            helper,
            root: repoDir,
            configPath: projectConfig?.path || null,
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

function resolveDotnet() {
    const result = spawnSync('dotnet', ['--version'], { stdio: 'pipe' });
    if (result.status === 0) return 'dotnet';
    throw new Error(
        'dotnet not found — install the .NET 9+ SDK to run the Roslyn oracle');
}

function prepareProjectConfig(repoDir) {
    const project = findProject(repoDir);
    if (!project) return null;

    const projectProperties = runMsbuildJson(project, [
        '-getProperty:TargetFramework',
        '-getProperty:TargetFrameworks',
    ]);
    const targetFramework = chooseTargetFramework(
        projectProperties.Properties?.TargetFramework,
        projectProperties.Properties?.TargetFrameworks);
    if (!targetFramework) return null;

    const restore = spawnSync('dotnet', [
        'restore', project,
        `-property:TargetFrameworks=${targetFramework}`,
        '-property:Configuration=Release',
        '--nologo',
        '--verbosity', 'quiet',
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
    });
    if (restore.status !== 0) {
        throw new Error(
            `Roslyn oracle restore failed for ${path.basename(project)}: ` +
            `${restore.stderr || restore.stdout}`.trim());
    }

    const evaluated = runMsbuildJson(project, [
        `-property:TargetFramework=${targetFramework}`,
        '-property:Configuration=Release',
        '-target:ResolveReferences',
        '-getProperty:DefineConstants',
        '-getProperty:LangVersion',
        '-getProperty:Nullable',
        '-getItem:Compile',
        '-getItem:ReferencePath',
    ]);
    const files = (evaluated.Items?.Compile || [])
        .map(item => item.Identity
            ? path.resolve(path.dirname(project), item.Identity)
            : item.FullPath)
        .filter(file => file.endsWith('.cs') && fs.existsSync(file));
    const references = (evaluated.Items?.ReferencePath || [])
        .map(item => item.FullPath || item.Identity)
        .filter(file => file && fs.existsSync(file));
    if (files.length === 0 || references.length === 0) return null;

    const config = {
        project,
        targetFramework,
        files,
        references,
        defines: String(evaluated.Properties?.DefineConstants || '')
            .split(/[;,]/)
            .map(value => value.trim())
            .filter(Boolean),
        languageVersion: evaluated.Properties?.LangVersion || 'latest',
        nullable: evaluated.Properties?.Nullable || 'enable',
    };
    const configPath = path.join(
        os.tmpdir(),
        `ucn-roslyn-${process.pid}-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(configPath, JSON.stringify(config));
    return { path: configPath, project, targetFramework };
}

function runMsbuildJson(project, options) {
    const result = spawnSync('dotnet', [
        'msbuild', project,
        ...options,
        '-verbosity:quiet',
    ], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 128 * 1024 * 1024,
    });
    if (result.status !== 0) {
        throw new Error(
            `Roslyn oracle MSBuild evaluation failed for ${path.basename(project)}: ` +
            `${result.stderr || result.stdout}`.trim());
    }
    const start = result.stdout.indexOf('{');
    if (start < 0) throw new Error('MSBuild did not return its JSON evaluation');
    return JSON.parse(result.stdout.slice(start));
}

function chooseTargetFramework(single, plural) {
    if (single) return single;
    const choices = String(plural || '').split(';').map(value => value.trim()).filter(Boolean);
    const modern = choices
        .filter(value => /^net\d+\.\d+$/.test(value))
        .sort((a, b) => Number(b.match(/^net(\d+)/)?.[1] || 0) -
            Number(a.match(/^net(\d+)/)?.[1] || 0));
    return modern[0] || choices[0] || null;
}

function findProject(root) {
    const queue = [root];
    const projects = [];
    while (queue.length > 0) {
        const dir = queue.shift();
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.name.startsWith('.') ||
                ['bin', 'obj', 'node_modules', 'TestResults'].includes(entry.name)) {
                continue;
            }
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) queue.push(full);
            else if (entry.isFile() && entry.name.endsWith('.csproj')) projects.push(full);
        }
    }
    projects.sort((a, b) => {
        const depth = file => path.relative(root, file).split(path.sep).length;
        return depth(a) - depth(b) || a.localeCompare(b);
    });
    return projects[0] || null;
}

module.exports = { roslynOracle };
