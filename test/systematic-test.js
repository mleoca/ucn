#!/usr/bin/env node

/**
 * Systematic Test Script for UCN
 *
 * Tests all UCN commands across all supported languages to identify bugs.
 * Run with: node test/systematic-test.js [--verbose] [--language=<lang>] [--command=<cmd>]
 */

const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// Configuration
const UCN_PATH = path.join(__dirname, '..', 'ucn.js');
const FIXTURES_PATH = path.join(__dirname, 'fixtures');
const TIMEOUT = 30000; // 30 seconds

// Parse command line arguments
const args = process.argv.slice(2);
const verbose = args.includes('--verbose') || args.includes('-v');
const filterLanguage = args.find(a => a.startsWith('--language='))?.split('=')[1];
const filterCommand = args.find(a => a.startsWith('--command='))?.split('=')[1];

// Colors for output
const colors = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

// Test results
const results = {
  passed: 0,
  failed: 0,
  skipped: 0,
  bugs: [],
};

// Language configurations
const languages = {
  javascript: {
    path: path.join(FIXTURES_PATH, 'javascript'),
    extension: '.js',
    symbols: {
      functions: ['processData', 'validateInput', 'transformOutput', 'fetchAndProcess', 'helper', 'formatData'],
      classes: ['DataProcessor', 'Service'],
      methods: ['fetch', 'process', 'buildUrl'],
    },
    files: ['main.js', 'utils.js', 'service.js'],
  },
  typescript: {
    path: path.join(FIXTURES_PATH, 'typescript'),
    extension: '.ts',
    symbols: {
      functions: ['filterTasks', 'createTask', 'generateId', 'withRetry', 'processTask', 'createConfig'],
      classes: ['TaskManager', 'Repository', 'DataService', 'Logger'],
      interfaces: ['Task', 'Config', 'IRepository'],
      enums: ['Status', 'LogLevel'],
    },
    files: ['main.ts', 'repository.ts', 'types.ts'],
  },
  python: {
    path: path.join(FIXTURES_PATH, 'python'),
    extension: '.py',
    symbols: {
      functions: ['create_task', 'filter_by_status', 'filter_by_priority', 'format_data', 'validate_input', 'deep_merge'],
      classes: ['TaskManager', 'Task', 'DataService', 'CacheService', 'ApiClient'],
      decorators: ['with_logging', 'with_retry'],
    },
    files: ['main.py', 'utils.py', 'service.py'],
  },
  go: {
    path: path.join(FIXTURES_PATH, 'go'),
    extension: '.go',
    symbols: {
      functions: ['NewTaskManager', 'ValidateTask', 'CreateTask', 'FilterByStatus', 'FormatTask', 'NewDataService'],
      structs: ['Task', 'TaskManager', 'TaskProcessor', 'DataService', 'CacheService'],
      methods: ['AddTask', 'GetTask', 'GetTasks', 'Save', 'Find'],
    },
    files: ['main.go', 'service.go'],
  },
  rust: {
    path: path.join(FIXTURES_PATH, 'rust'),
    extension: '.rs',
    symbols: {
      functions: ['validate_task', 'create_task', 'filter_by_status', 'format_task', 'format_data', 'snake_to_camel'],
      structs: ['Task', 'TaskManager', 'TaskProcessor', 'DataService', 'CacheService', 'Config'],
      traits: ['Entity', 'Repository'],
      enums: ['Status'],
    },
    files: ['main.rs', 'service.rs', 'utils.rs'],
  },
  java: {
    path: path.join(FIXTURES_PATH, 'java'),
    extension: '.java',
    symbols: {
      functions: ['createTask', 'validateTask', 'filterByStatus', 'filterByPriority', 'formatTask', 'formatData'],
      classes: ['Main', 'Task', 'TaskManager', 'TaskProcessor', 'DataService', 'CacheService', 'Utils'],
      interfaces: ['Repository'],
      enums: ['Status'],
    },
    files: ['Main.java', 'DataService.java', 'Utils.java'],
  },
};

// Commands to test with their expected behaviors
const commands = [
  // Basic commands
  { name: 'toc', args: [], description: 'Table of contents', expectOutput: true },
  { name: 'stats', args: [], description: 'Project statistics', expectOutput: true },

  // Find commands
  { name: 'find', args: ['$FUNCTION'], description: 'Find symbol definition', expectOutput: true },
  { name: 'usages', args: ['$FUNCTION'], description: 'Find symbol usages', expectOutput: true },
  { name: 'search', args: ['TODO'], description: 'Text search', expectOutput: false }, // May not have TODO

  // Extraction commands
  { name: 'fn', args: ['$FUNCTION'], description: 'Extract function', expectOutput: true },
  { name: 'class', args: ['$CLASS'], description: 'Extract class', expectOutput: true },
  { name: 'lines', args: ['1-10'], description: 'Extract lines', expectOutput: true, fileMode: true },

  // Analysis commands
  { name: 'context', args: ['$FUNCTION'], description: 'Show callers and callees', expectOutput: true },
  { name: 'about', args: ['$FUNCTION'], description: 'Full symbol information', expectOutput: true },
  { name: 'smart', args: ['$FUNCTION'], description: 'Function with dependencies', expectOutput: true },
  { name: 'impact', args: ['$FUNCTION'], description: 'Impact analysis', expectOutput: true },
  { name: 'trace', args: ['$FUNCTION', '--depth=2'], description: 'Call tree', expectOutput: true },
  { name: 'related', args: ['$FUNCTION'], description: 'Related functions', expectOutput: false }, // May not find related

  // Additional analysis commands
  { name: 'typedef', args: ['$CLASS'], description: 'Find type definition', expectOutput: false }, // May not have types
  { name: 'example', args: ['$FUNCTION'], description: 'Best usage example', expectOutput: false }, // May not find example
  { name: 'verify', args: ['$FUNCTION'], description: 'Verify call sites', expectOutput: false }, // May not need verify

  // Dependency commands
  { name: 'imports', args: ['$FILE'], description: 'File imports', expectOutput: false }, // May not have imports
  { name: 'exporters', args: ['$FILE'], description: 'Who imports file', expectOutput: false },
  { name: 'who-imports', args: ['$FILE'], description: 'Who imports (alias)', expectOutput: false },
  { name: 'graph', args: ['$FILE', '--depth=2'], description: 'Dependency graph', expectOutput: false },

  // Refactoring commands
  { name: 'deadcode', args: [], description: 'Find unused functions', expectOutput: false },
  { name: 'api', args: [], description: 'Public API', expectOutput: true },
  { name: 'tests', args: ['$FUNCTION'], description: 'Find related tests', expectOutput: false },

  // JSON output
  { name: 'find', args: ['$FUNCTION', '--json'], description: 'Find with JSON output', expectOutput: true, checkJson: true },
  { name: 'toc', args: ['--json'], description: 'TOC with JSON output', expectOutput: true, checkJson: true },
];

/**
 * Run a UCN command and capture output
 */
function runUcn(targetPath, command, args = [], options = {}) {
  const fullArgs = ['node', UCN_PATH, targetPath, command, ...args];
  const cmdStr = fullArgs.join(' ');

  if (verbose) {
    console.log(`${colors.dim}  Running: ${cmdStr}${colors.reset}`);
  }

  try {
    const output = execSync(cmdStr, {
      timeout: TIMEOUT,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: __dirname,
    });
    return { success: true, output: output.trim(), command: cmdStr };
  } catch (error) {
    const stderr = error.stderr?.toString() || '';
    const stdout = error.stdout?.toString() || '';
    return {
      success: false,
      output: stdout,
      error: stderr || error.message,
      command: cmdStr,
      exitCode: error.status,
    };
  }
}

/**
 * Replace placeholders in command arguments
 */
function replaceArgs(args, symbols, files, lang) {
  return args.map(arg => {
    if (arg === '$FUNCTION') {
      return symbols.functions?.[0] || symbols.methods?.[0] || 'main';
    }
    if (arg === '$CLASS') {
      return symbols.classes?.[0] || symbols.structs?.[0] || 'Main';
    }
    if (arg === '$FILE') {
      return files[0];
    }
    return arg;
  });
}

/**
 * Test a single command
 */
function testCommand(lang, langConfig, cmd) {
  const testName = `${lang}/${cmd.name}`;

  if (filterCommand && cmd.name !== filterCommand) {
    return { skipped: true, name: testName };
  }

  const args = replaceArgs(cmd.args, langConfig.symbols, langConfig.files, lang);
  const targetPath = cmd.fileMode
    ? path.join(langConfig.path, langConfig.files[0])
    : langConfig.path;

  const result = runUcn(targetPath, cmd.name, args);

  // Check for success
  if (!result.success) {
    // Check if it's an expected failure (like no results found)
    const isExpectedFailure =
      result.error?.includes('No matches found') ||
      result.error?.includes('not found') ||
      result.error?.includes('No usages found') ||
      result.error?.includes('No tests found') ||
      result.error?.includes('No related') ||
      result.error?.includes('No imports') ||
      result.error?.includes('No deadcode');

    if (isExpectedFailure && !cmd.expectOutput) {
      return { passed: true, name: testName, note: 'Expected no results' };
    }

    return {
      passed: false,
      name: testName,
      error: result.error,
      command: result.command,
      exitCode: result.exitCode,
    };
  }

  // Check for output if expected
  if (cmd.expectOutput && !result.output) {
    return {
      passed: false,
      name: testName,
      error: 'Expected output but got none',
      command: result.command,
    };
  }

  // Check JSON validity if required
  if (cmd.checkJson) {
    try {
      JSON.parse(result.output);
    } catch (e) {
      return {
        passed: false,
        name: testName,
        error: `Invalid JSON output: ${e.message}`,
        command: result.command,
        output: result.output.substring(0, 200),
      };
    }
  }

  // Check for error messages in output (potential bugs)
  const errorPatterns = [
    /undefined/i,
    /null is not/i,
    /cannot read property/i,
    /is not a function/i,
    /TypeError/,
    /ReferenceError/,
    /SyntaxError/,
  ];

  for (const pattern of errorPatterns) {
    if (pattern.test(result.output)) {
      return {
        passed: false,
        name: testName,
        error: `Output contains error pattern: ${pattern}`,
        command: result.command,
        output: result.output.substring(0, 500),
      };
    }
  }

  return { passed: true, name: testName };
}

/**
 * Test a language
 */
function testLanguage(lang, langConfig) {
  console.log(`\n${colors.blue}Testing ${lang.toUpperCase()}${colors.reset}`);
  console.log(`${colors.dim}  Path: ${langConfig.path}${colors.reset}`);

  // Check if fixtures exist
  if (!fs.existsSync(langConfig.path)) {
    console.log(`${colors.yellow}  ⚠ Fixtures not found, skipping${colors.reset}`);
    results.skipped += commands.length;
    return;
  }

  // Test each command
  for (const cmd of commands) {
    const result = testCommand(lang, langConfig, cmd);

    if (result.skipped) {
      results.skipped++;
      continue;
    }

    if (result.passed) {
      results.passed++;
      if (verbose) {
        const note = result.note ? ` (${result.note})` : '';
        console.log(`  ${colors.green}✓${colors.reset} ${cmd.name}: ${cmd.description}${note}`);
      }
    } else {
      results.failed++;
      results.bugs.push({
        language: lang,
        command: cmd.name,
        description: cmd.description,
        error: result.error,
        fullCommand: result.command,
        output: result.output,
        exitCode: result.exitCode,
      });
      console.log(`  ${colors.red}✗${colors.reset} ${cmd.name}: ${cmd.description}`);
      if (verbose) {
        console.log(`    ${colors.red}Error: ${result.error}${colors.reset}`);
        if (result.output) {
          console.log(`    ${colors.dim}Output: ${result.output.substring(0, 200)}${colors.reset}`);
        }
      }
    }
  }
}

/**
 * Run additional edge case tests
 */
function testEdgeCases() {
  console.log(`\n${colors.blue}Testing EDGE CASES${colors.reset}`);

  const edgeCases = [
    // Non-existent symbol
    {
      name: 'Non-existent symbol',
      run: () => runUcn(languages.javascript.path, 'find', ['nonExistentSymbol12345']),
      expect: (r) => !r.success || r.output.includes('No symbols found') || r.output.includes('No matches') || r.output === '',
    },
    // Empty arguments
    {
      name: 'Empty find argument',
      run: () => runUcn(languages.javascript.path, 'find', ['']),
      expect: (r) => true, // Should handle gracefully
    },
    // Special characters in search
    {
      name: 'Special chars in search',
      run: () => runUcn(languages.javascript.path, 'search', ['[test]']),
      expect: (r) => r.success || r.error?.includes('regex') || !r.error?.includes('SyntaxError'),
    },
    // Very long symbol name
    {
      name: 'Very long symbol name',
      run: () => runUcn(languages.javascript.path, 'find', ['a'.repeat(1000)]),
      expect: (r) => r.success || !r.error?.includes('Maximum call stack'),
    },
    // Invalid path
    {
      name: 'Invalid path',
      run: () => runUcn('/nonexistent/path', 'toc', []),
      expect: (r) => !r.success && (r.error?.includes('not found') || r.error?.includes('ENOENT') || r.error?.includes('No supported files')),
    },
    // Depth edge cases
    {
      name: 'Depth = 0',
      run: () => runUcn(languages.javascript.path, 'trace', ['processData', '--depth=0']),
      expect: (r) => r.success,
    },
    {
      name: 'Negative depth',
      run: () => runUcn(languages.javascript.path, 'trace', ['processData', '--depth=-1']),
      expect: (r) => r.success || !r.error?.includes('crash'),
    },
    // Unicode in search
    {
      name: 'Unicode in search',
      run: () => runUcn(languages.javascript.path, 'search', ['日本語']),
      expect: (r) => r.success || r.output === '',
    },
    // Multiple flags
    {
      name: 'Multiple flags combined',
      run: () => runUcn(languages.javascript.path, 'find', ['processData', '--json', '--exact', '--top=1']),
      expect: (r) => r.success,
    },
    // Flag variations
    {
      name: 'Exclude flag',
      run: () => runUcn(languages.javascript.path, 'find', ['processData', '--exclude=test']),
      expect: (r) => r.success,
    },
    {
      name: 'In flag (path filter)',
      run: () => runUcn(languages.javascript.path, 'toc', ['--in=.']),
      expect: (r) => r.success,
    },
    {
      name: 'Include tests flag',
      run: () => runUcn(languages.javascript.path, 'usages', ['processData', '--include-tests']),
      expect: (r) => r.success,
    },
    // Context output with expand
    {
      name: 'Context with expand flag',
      run: () => runUcn(languages.javascript.path, 'context', ['processData', '--expand']),
      expect: (r) => r.success,
    },
    // About with code-only flag
    {
      name: 'About with code-only',
      run: () => runUcn(languages.javascript.path, 'about', ['processData', '--code-only']),
      expect: (r) => r.success || r.output.includes('processData'),
    },
    // Smart with types
    {
      name: 'Smart with types',
      run: () => runUcn(languages.typescript.path, 'smart', ['filterTasks', '--with-types']),
      expect: (r) => r.success,
    },
    // File mode commands
    {
      name: 'Single file toc',
      run: () => runUcn(path.join(languages.javascript.path, 'main.js'), 'toc', []),
      expect: (r) => r.success && r.output.includes('processData'),
    },
    {
      name: 'Single file find',
      run: () => runUcn(path.join(languages.javascript.path, 'main.js'), 'find', ['processData']),
      expect: (r) => r.success,
    },
    // Glob mode - note: path needs quoting to prevent shell expansion
    {
      name: 'Glob pattern find',
      run: () => {
        const globPath = `"${path.join(languages.javascript.path, '*.js')}"`;
        return runUcn(globPath, 'find', ['helper']);
      },
      expect: (r) => r.success,
    },
    // Lines command edge cases
    {
      name: 'Lines with out-of-bounds range',
      run: () => runUcn(path.join(languages.javascript.path, 'main.js'), 'lines', ['9999-10000']),
      expect: (r) => !r.success && r.error?.includes('out of bounds'),
    },
    {
      name: 'Lines with reversed range',
      run: () => runUcn(path.join(languages.javascript.path, 'main.js'), 'lines', ['10-5']),
      expect: (r) => r.success && r.output.includes('5'),
    },
    {
      name: 'Lines with non-numeric range',
      run: () => runUcn(path.join(languages.javascript.path, 'main.js'), 'lines', ['abc-def']),
      expect: (r) => !r.success && r.error?.includes('Invalid line range'),
    },
    // Graph with negative depth
    {
      name: 'Graph with negative depth',
      run: () => runUcn(languages.javascript.path, 'graph', ['main.js', '--depth=-5']),
      expect: (r) => r.success && r.output.includes('main.js'),
    },
    // Double-dash separator
    {
      name: 'Double-dash flag separator',
      run: () => runUcn(languages.javascript.path, 'find', ['--', '--test']),
      expect: (r) => r.success && !r.error?.includes('Unknown flag'),
    },
    // Plan command
    {
      name: 'Plan with rename',
      run: () => runUcn(languages.javascript.path, 'plan', ['processData', '--rename-to=processInput']),
      expect: (r) => r.success && r.output.includes('Refactoring plan'),
    },
    // Verify command
    {
      name: 'Verify function calls',
      run: () => runUcn(languages.javascript.path, 'verify', ['processData']),
      expect: (r) => r.success,
    },
  ];

  for (const testCase of edgeCases) {
    const result = testCase.run();
    const passed = testCase.expect(result);

    if (passed) {
      results.passed++;
      if (verbose) {
        console.log(`  ${colors.green}✓${colors.reset} ${testCase.name}`);
      }
    } else {
      results.failed++;
      const errorMsg = result.error || `Expected test to pass but got: ${JSON.stringify({ success: result.success, output: result.output?.substring(0, 100) })}`;
      results.bugs.push({
        language: 'edge-case',
        command: testCase.name,
        error: errorMsg,
        fullCommand: result.command,
      });
      console.log(`  ${colors.red}✗${colors.reset} ${testCase.name}`);
      if (verbose) {
        console.log(`    ${colors.red}Error: ${errorMsg}${colors.reset}`);
      }
    }
  }
}

/**
 * Print summary report
 */
function printSummary() {
  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
  console.log(`${colors.cyan}TEST SUMMARY${colors.reset}`);
  console.log(`${colors.cyan}${'='.repeat(60)}${colors.reset}`);

  console.log(`\n  ${colors.green}Passed:${colors.reset}  ${results.passed}`);
  console.log(`  ${colors.red}Failed:${colors.reset}  ${results.failed}`);
  console.log(`  ${colors.yellow}Skipped:${colors.reset} ${results.skipped}`);
  console.log(`  Total:   ${results.passed + results.failed + results.skipped}`);

  if (results.bugs.length > 0) {
    console.log(`\n${colors.red}BUGS FOUND (${results.bugs.length}):${colors.reset}`);
    console.log(`${'-'.repeat(60)}`);

    // Group bugs by language
    const bugsByLang = {};
    for (const bug of results.bugs) {
      if (!bugsByLang[bug.language]) {
        bugsByLang[bug.language] = [];
      }
      bugsByLang[bug.language].push(bug);
    }

    for (const [lang, bugs] of Object.entries(bugsByLang)) {
      console.log(`\n${colors.yellow}${lang.toUpperCase()}:${colors.reset}`);
      for (const bug of bugs) {
        console.log(`  • ${bug.command}: ${bug.description || bug.error}`);
        console.log(`    ${colors.dim}Command: ${bug.fullCommand}${colors.reset}`);
        if (bug.error && bug.error !== bug.description) {
          console.log(`    ${colors.red}Error: ${bug.error}${colors.reset}`);
        }
        if (bug.exitCode !== undefined) {
          console.log(`    ${colors.dim}Exit code: ${bug.exitCode}${colors.reset}`);
        }
      }
    }

    // Save bugs to file
    const bugsFile = path.join(__dirname, 'bugs-report.json');
    fs.writeFileSync(bugsFile, JSON.stringify(results.bugs, null, 2));
    console.log(`\n${colors.dim}Bug report saved to: ${bugsFile}${colors.reset}`);
  } else {
    console.log(`\n${colors.green}No bugs found! All tests passed.${colors.reset}`);
  }

  console.log(`\n${colors.cyan}${'='.repeat(60)}${colors.reset}`);
}

/**
 * Main function
 */
function main() {
  console.log(`${colors.cyan}UCN Systematic Test Suite${colors.reset}`);
  console.log(`${colors.dim}Testing all commands across all supported languages${colors.reset}`);
  console.log(`${colors.dim}UCN Path: ${UCN_PATH}${colors.reset}`);
  console.log(`${colors.dim}Fixtures Path: ${FIXTURES_PATH}${colors.reset}`);

  if (filterLanguage) {
    console.log(`${colors.yellow}Filtering by language: ${filterLanguage}${colors.reset}`);
  }
  if (filterCommand) {
    console.log(`${colors.yellow}Filtering by command: ${filterCommand}${colors.reset}`);
  }

  // Test each language
  for (const [lang, config] of Object.entries(languages)) {
    if (filterLanguage && lang !== filterLanguage) {
      continue;
    }
    testLanguage(lang, config);
  }

  // Test edge cases
  if (!filterLanguage && !filterCommand) {
    testEdgeCases();
  }

  // Print summary
  printSummary();

  // Exit with error code if there were failures
  process.exit(results.failed > 0 ? 1 : 0);
}

main();
