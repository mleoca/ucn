#!/usr/bin/env node

/**
 * Public Repository Test Script for UCN
 *
 * Tests UCN against real public repositories to find edge cases and bugs.
 * Run with: node test/public-repos-test.js [--verbose] [--keep]
 */

const { execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Configuration
const UCN_PATH = path.join(__dirname, '..', 'ucn.js');
const TEMP_DIR = path.join(os.tmpdir(), 'ucn-test-repos');
const TIMEOUT = 60000; // 60 seconds

// Parse args
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const keepRepos = args.includes('--keep');

// Colors
const c = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

// Results tracking
const results = {
  passed: 0,
  failed: 0,
  bugs: [],
};

// Public repositories to test - small, well-known repos
const repos = {
  javascript: [
    {
      name: 'preact-signals',
      url: 'https://github.com/preactjs/signals',
      dir: 'packages/core/src',
      symbols: ['signal', 'computed', 'effect', 'batch'],
    },
  ],
  typescript: [
    {
      name: 'zod',
      url: 'https://github.com/colinhacks/zod',
      dir: 'src',
      symbols: ['ZodType', 'string', 'parse', 'safeParse'],
    },
  ],
  python: [
    {
      name: 'httpx',
      url: 'https://github.com/encode/httpx',
      dir: 'httpx',
      symbols: ['Client', 'get', 'post', 'request'],
    },
  ],
  go: [
    {
      name: 'cobra',
      url: 'https://github.com/spf13/cobra',
      dir: '.',
      symbols: ['Command', 'Execute', 'AddCommand', 'Flags'],
    },
  ],
  rust: [
    {
      name: 'ripgrep',
      url: 'https://github.com/BurntSushi/ripgrep',
      dir: 'crates/core',
      symbols: ['Searcher', 'search', 'new', 'build'],
    },
  ],
  java: [
    {
      name: 'gson',
      url: 'https://github.com/google/gson',
      dir: 'gson/src/main/java/com/google/gson',
      symbols: ['Gson', 'toJson', 'fromJson', 'JsonElement'],
    },
  ],
};

// Commands to test
const commands = [
  { name: 'toc', args: [] },
  { name: 'stats', args: [] },
  { name: 'find', args: ['$SYM'] },
  { name: 'usages', args: ['$SYM'] },
  { name: 'context', args: ['$SYM'] },
  { name: 'about', args: ['$SYM'] },
  { name: 'smart', args: ['$SYM'] },
  { name: 'impact', args: ['$SYM'] },
  { name: 'trace', args: ['$SYM', '--depth=2'] },
  { name: 'api', args: [] },
  { name: 'deadcode', args: [] },
  { name: 'find', args: ['$SYM', '--json'], id: 'find-json' },
  { name: 'toc', args: ['--json'], id: 'toc-json' },
  { name: 'search', args: ['TODO'] },
  { name: 'fn', args: ['$SYM'] },
];

/**
 * Clone a repository
 */
function cloneRepo(url, name) {
  const repoPath = path.join(TEMP_DIR, name);

  if (fs.existsSync(repoPath)) {
    if (verbose) console.log(`${c.dim}  Using cached: ${name}${c.reset}`);
    return repoPath;
  }

  console.log(`${c.dim}  Cloning: ${name}...${c.reset}`);
  try {
    execSync(`git clone --depth 1 ${url} ${repoPath}`, {
      stdio: verbose ? 'inherit' : 'pipe',
      timeout: 120000,
    });
    return repoPath;
  } catch (e) {
    console.log(`${c.yellow}  ⚠ Failed to clone ${name}: ${e.message}${c.reset}`);
    return null;
  }
}

/**
 * Run UCN command
 */
function runUcn(targetPath, command, args = []) {
  const fullArgs = ['node', UCN_PATH, targetPath, command, ...args, '--no-cache'];
  const cmdStr = fullArgs.join(' ');

  if (verbose) {
    console.log(`${c.dim}    Running: ${cmdStr}${c.reset}`);
  }

  try {
    const result = spawnSync('node', [UCN_PATH, targetPath, command, ...args, '--no-cache'], {
      timeout: TIMEOUT,
      encoding: 'utf8',
      maxBuffer: 50 * 1024 * 1024, // 50MB buffer
    });

    if (result.error) {
      return { success: false, error: result.error.message, command: cmdStr };
    }

    if (result.status !== 0) {
      const stderr = result.stderr || '';
      // Check for expected "no results" type errors
      const isExpectedNoResult =
        stderr.includes('No matches found') ||
        stderr.includes('not found') ||
        stderr.includes('No usages found') ||
        stderr.includes('No tests found') ||
        stderr.includes('No deadcode') ||
        stderr.includes('No imports');

      return {
        success: isExpectedNoResult,
        output: result.stdout,
        error: stderr,
        command: cmdStr,
        exitCode: result.status,
        isExpectedNoResult,
      };
    }

    return { success: true, output: result.stdout, command: cmdStr };
  } catch (e) {
    return { success: false, error: e.message, command: cmdStr };
  }
}

/**
 * Check for error patterns in output
 */
function checkForErrors(output) {
  if (!output) return null;

  const patterns = [
    { pattern: /TypeError: .+/g, name: 'TypeError' },
    { pattern: /ReferenceError: .+/g, name: 'ReferenceError' },
    { pattern: /SyntaxError: .+/g, name: 'SyntaxError' },
    { pattern: /Cannot read propert(y|ies) .+ of (undefined|null)/gi, name: 'Property access on null/undefined' },
    { pattern: /is not a function/gi, name: 'Not a function' },
    { pattern: /undefined is not/gi, name: 'Undefined error' },
    { pattern: /FATAL ERROR/gi, name: 'Fatal error' },
    { pattern: /Maximum call stack/gi, name: 'Stack overflow' },
    { pattern: /heap out of memory/gi, name: 'Memory error' },
  ];

  for (const { pattern, name } of patterns) {
    const match = output.match(pattern);
    if (match) {
      return { type: name, match: match[0] };
    }
  }

  return null;
}

/**
 * Test a repository
 */
function testRepo(lang, repo) {
  console.log(`\n${c.blue}Testing ${lang}/${repo.name}${c.reset}`);

  const repoPath = cloneRepo(repo.url, repo.name);
  if (!repoPath) {
    results.failed++;
    results.bugs.push({
      language: lang,
      repo: repo.name,
      error: 'Failed to clone repository',
    });
    return;
  }

  const targetPath = path.join(repoPath, repo.dir);
  if (!fs.existsSync(targetPath)) {
    console.log(`${c.yellow}  ⚠ Directory not found: ${repo.dir}${c.reset}`);
    return;
  }

  // Test each command
  for (const cmd of commands) {
    const cmdArgs = cmd.args.map(a => (a === '$SYM' ? repo.symbols[0] : a));
    const testId = cmd.id || `${cmd.name}(${cmdArgs.join(',')})`;

    const result = runUcn(targetPath, cmd.name, cmdArgs);

    // Check for crashes/errors
    const errorInOutput = checkForErrors(result.output);
    const errorInStderr = checkForErrors(result.error);
    const foundError = errorInOutput || errorInStderr;

    if (foundError) {
      results.failed++;
      results.bugs.push({
        language: lang,
        repo: repo.name,
        command: cmd.name,
        args: cmdArgs,
        error: `${foundError.type}: ${foundError.match}`,
        fullCommand: result.command,
      });
      console.log(`  ${c.red}✗${c.reset} ${testId}: ${foundError.type}`);
      if (verbose) {
        console.log(`    ${c.red}${foundError.match}${c.reset}`);
      }
      continue;
    }

    // Check for non-zero exit without expected "no results"
    if (!result.success && !result.isExpectedNoResult) {
      results.failed++;
      results.bugs.push({
        language: lang,
        repo: repo.name,
        command: cmd.name,
        args: cmdArgs,
        error: result.error || 'Command failed',
        fullCommand: result.command,
        exitCode: result.exitCode,
      });
      console.log(`  ${c.red}✗${c.reset} ${testId}`);
      if (verbose) {
        console.log(`    ${c.red}${result.error || 'Failed'}${c.reset}`);
      }
      continue;
    }

    // Check JSON validity for JSON commands
    if (cmd.args.includes('--json') && result.output) {
      try {
        JSON.parse(result.output);
      } catch (e) {
        results.failed++;
        results.bugs.push({
          language: lang,
          repo: repo.name,
          command: cmd.name,
          args: cmdArgs,
          error: `Invalid JSON: ${e.message}`,
          fullCommand: result.command,
          output: result.output.substring(0, 200),
        });
        console.log(`  ${c.red}✗${c.reset} ${testId}: Invalid JSON`);
        continue;
      }
    }

    results.passed++;
    if (verbose) {
      console.log(`  ${c.green}✓${c.reset} ${testId}`);
    }
  }
}

/**
 * Additional stress tests
 */
function runStressTests() {
  console.log(`\n${c.blue}Running STRESS TESTS${c.reset}`);

  const jsFixture = path.join(__dirname, 'fixtures', 'javascript');

  const tests = [
    // Large depth values
    {
      name: 'Very large depth',
      run: () => runUcn(jsFixture, 'trace', ['processData', '--depth=100']),
      check: r => !checkForErrors(r.output) && !checkForErrors(r.error),
    },
    // Many concurrent operations simulation (sequential but rapid)
    {
      name: 'Rapid sequential commands',
      run: () => {
        for (let i = 0; i < 10; i++) {
          const r = runUcn(jsFixture, 'toc', []);
          if (!r.success) return r;
        }
        return { success: true };
      },
      check: r => r.success,
    },
    // Large symbol names in search
    {
      name: 'Pattern-like symbol',
      run: () => runUcn(jsFixture, 'find', ['.*']),
      check: r => !checkForErrors(r.output),
    },
    // Empty string searches
    {
      name: 'Empty search',
      run: () => runUcn(jsFixture, 'search', ['']),
      check: r => !checkForErrors(r.output),
    },
    // Newlines in search
    {
      name: 'Newline in search',
      run: () => runUcn(jsFixture, 'search', ['test\ntest']),
      check: r => !checkForErrors(r.output),
    },
    // Null bytes
    {
      name: 'Null byte in search',
      run: () => runUcn(jsFixture, 'search', ['test\x00test']),
      check: r => !checkForErrors(r.output),
    },
  ];

  for (const test of tests) {
    const result = test.run();
    const passed = test.check(result);

    if (passed) {
      results.passed++;
      if (verbose) {
        console.log(`  ${c.green}✓${c.reset} ${test.name}`);
      }
    } else {
      results.failed++;
      results.bugs.push({
        language: 'stress',
        command: test.name,
        error: result.error || 'Test failed',
        fullCommand: result.command,
      });
      console.log(`  ${c.red}✗${c.reset} ${test.name}`);
    }
  }
}

/**
 * Print summary
 */
function printSummary() {
  console.log(`\n${c.cyan}${'='.repeat(60)}${c.reset}`);
  console.log(`${c.cyan}PUBLIC REPO TEST SUMMARY${c.reset}`);
  console.log(`${c.cyan}${'='.repeat(60)}${c.reset}`);

  console.log(`\n  ${c.green}Passed:${c.reset}  ${results.passed}`);
  console.log(`  ${c.red}Failed:${c.reset}  ${results.failed}`);
  console.log(`  Total:   ${results.passed + results.failed}`);

  if (results.bugs.length > 0) {
    console.log(`\n${c.red}BUGS FOUND (${results.bugs.length}):${c.reset}`);
    console.log(`${'-'.repeat(60)}`);

    // Group by language
    const byLang = {};
    for (const bug of results.bugs) {
      const key = bug.repo ? `${bug.language}/${bug.repo}` : bug.language;
      if (!byLang[key]) byLang[key] = [];
      byLang[key].push(bug);
    }

    for (const [key, bugs] of Object.entries(byLang)) {
      console.log(`\n${c.yellow}${key}:${c.reset}`);
      for (const bug of bugs) {
        console.log(`  • ${bug.command}: ${bug.error}`);
        if (bug.fullCommand) {
          console.log(`    ${c.dim}${bug.fullCommand}${c.reset}`);
        }
      }
    }

    // Save to file
    const bugsFile = path.join(__dirname, 'public-repos-bugs.json');
    fs.writeFileSync(bugsFile, JSON.stringify(results.bugs, null, 2));
    console.log(`\n${c.dim}Bug report saved to: ${bugsFile}${c.reset}`);
  } else {
    console.log(`\n${c.green}No bugs found!${c.reset}`);
  }

  console.log(`${c.cyan}${'='.repeat(60)}${c.reset}`);
}

/**
 * Cleanup
 */
function cleanup() {
  if (!keepRepos && fs.existsSync(TEMP_DIR)) {
    console.log(`\n${c.dim}Cleaning up temp directory...${c.reset}`);
    fs.rmSync(TEMP_DIR, { recursive: true, force: true });
  }
}

/**
 * Main
 */
async function main() {
  console.log(`${c.cyan}UCN Public Repository Test Suite${c.reset}`);
  console.log(`${c.dim}Testing against real-world repositories${c.reset}`);

  // Create temp directory
  if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR, { recursive: true });
  }

  // Test each language
  for (const [lang, repoList] of Object.entries(repos)) {
    for (const repo of repoList) {
      testRepo(lang, repo);
    }
  }

  // Run stress tests
  runStressTests();

  // Print summary
  printSummary();

  // Cleanup
  cleanup();

  process.exit(results.failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error(`${c.red}Fatal error: ${e.message}${c.reset}`);
  process.exit(1);
});
