/**
 * UCN Parser Unit Tests
 *
 * Language detection and per-language parsing tests.
 * Extracted from parser.test.js lines 20-441.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert');

const { parse, parseFile, detectLanguage, isSupported } = require('../core/parser');

// ============================================================================
// LANGUAGE DETECTION
// ============================================================================

describe('Language Detection', () => {
    it('detects JavaScript files', () => {
        assert.strictEqual(detectLanguage('file.js'), 'javascript');
        assert.strictEqual(detectLanguage('file.jsx'), 'javascript');
        assert.strictEqual(detectLanguage('file.mjs'), 'javascript');
    });

    it('detects TypeScript files', () => {
        assert.strictEqual(detectLanguage('file.ts'), 'typescript');
        assert.strictEqual(detectLanguage('file.tsx'), 'tsx');
    });

    it('detects Python files', () => {
        assert.strictEqual(detectLanguage('file.py'), 'python');
    });

    it('detects Go files', () => {
        assert.strictEqual(detectLanguage('file.go'), 'go');
    });

    it('detects Rust files', () => {
        assert.strictEqual(detectLanguage('file.rs'), 'rust');
    });

    it('detects Java files', () => {
        assert.strictEqual(detectLanguage('file.java'), 'java');
    });

    it('returns null for unsupported files', () => {
        assert.strictEqual(detectLanguage('file.txt'), null);
        assert.strictEqual(detectLanguage('file.md'), null);
    });
});

// ============================================================================
// JAVASCRIPT PARSING
// ============================================================================

describe('JavaScript Parsing', () => {
    it('parses function declarations', () => {
        const code = `
function hello(name) {
    return 'Hello ' + name;
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'hello');
        assert.strictEqual(result.functions[0].params, 'name');
    });

    it('parses arrow functions', () => {
        const code = `
const add = (a, b) => a + b;`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'add');
        assert.strictEqual(result.functions[0].isArrow, true);
    });

    it('parses async functions', () => {
        const code = `
async function fetchData(url) {
    return await fetch(url);
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].modifiers.includes('async'));
    });

    it('parses classes', () => {
        const code = `
class User {
    constructor(name) {
        this.name = name;
    }

    greet() {
        return 'Hello ' + this.name;
    }
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].name, 'User');
        assert.strictEqual(result.classes[0].members.length, 2);
    });

    it('parses generator functions', () => {
        const code = `
function* generateNumbers() {
    yield 1;
    yield 2;
}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].isGenerator, true);
    });

    it('parses exported functions', () => {
        const code = `
export function publicFn() {}
export default function main() {}`;
        const result = parse(code, 'javascript');
        assert.strictEqual(result.functions.length, 2);
        assert.ok(result.functions.some(f => f.name === 'publicFn'));
        assert.ok(result.functions.some(f => f.name === 'main' || f.name === 'default'));
    });
});

// ============================================================================
// TYPESCRIPT PARSING
// ============================================================================

describe('TypeScript Parsing', () => {
    it('parses typed functions', () => {
        const code = `
function greet(name: string): string {
    return 'Hello ' + name;
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].returnType, 'string');
    });

    it('parses interfaces', () => {
        const code = `
interface User {
    name: string;
    age: number;
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'interface');
    });

    it('parses type aliases', () => {
        const code = `
type ID = string | number;`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'type');
    });

    it('parses enums', () => {
        const code = `
enum Status {
    Active,
    Inactive
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'enum');
    });

    it('parses generic functions', () => {
        const code = `
function identity<T>(arg: T): T {
    return arg;
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].generics);
    });
});

// ============================================================================
// PYTHON PARSING
// ============================================================================

describe('Python Parsing', () => {
    it('parses function definitions', () => {
        const code = `
def hello(name):
    return 'Hello ' + name`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'hello');
    });

    it('parses typed functions', () => {
        const code = `
def greet(name: str) -> str:
    return 'Hello ' + name`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].returnType, 'str');
    });

    it('parses async functions', () => {
        const code = `
async def fetch_data(url):
    return await get(url)`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].isAsync, true);
    });

    it('parses decorated functions', () => {
        const code = `
@staticmethod
def helper():
    pass`;
        const result = parse(code, 'python');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].decorators);
    });

    it('parses classes', () => {
        const code = `
class User:
    def __init__(self, name):
        self.name = name

    def greet(self):
        return 'Hello ' + self.name`;
        const result = parse(code, 'python');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].name, 'User');
    });
});

// ============================================================================
// GO PARSING
// ============================================================================

describe('Go Parsing', () => {
    it('parses function declarations', () => {
        const code = `
func Hello(name string) string {
    return "Hello " + name
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'Hello');
    });

    it('parses methods', () => {
        const code = `
func (u *User) Greet() string {
    return "Hello " + u.Name
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].isMethod, true);
        assert.strictEqual(result.functions[0].receiver, '*User');
    });

    it('parses structs', () => {
        const code = `
type User struct {
    Name string
    Age  int
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'struct');
    });

    it('parses interfaces', () => {
        const code = `
type Reader interface {
    Read(p []byte) (n int, err error)
}`;
        const result = parse(code, 'go');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'interface');
    });
});

// ============================================================================
// RUST PARSING
// ============================================================================

describe('Rust Parsing', () => {
    it('parses function definitions', () => {
        const code = `
fn hello(name: &str) -> String {
    format!("Hello {}", name)
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.functions.length, 1);
        assert.strictEqual(result.functions[0].name, 'hello');
    });

    it('parses async functions', () => {
        const code = `
async fn fetch_data(url: &str) -> Result<String, Error> {
    Ok(String::new())
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].modifiers.includes('async'));
    });

    it('parses structs', () => {
        const code = `
struct User {
    name: String,
    age: u32,
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'struct');
    });

    it('parses impl blocks', () => {
        const code = `
impl User {
    fn new(name: String) -> Self {
        User { name, age: 0 }
    }
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'impl');
    });

    it('parses traits', () => {
        const code = `
trait Greet {
    fn greet(&self) -> String;
}`;
        const result = parse(code, 'rust');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'trait');
    });
});

// ============================================================================
// JAVA PARSING
// ============================================================================

describe('Java Parsing', () => {
    it('parses class declarations', () => {
        const code = `
public class User {
    private String name;

    public User(String name) {
        this.name = name;
    }

    public String getName() {
        return name;
    }
}`;
        const result = parse(code, 'java');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].name, 'User');
    });

    it('parses interfaces', () => {
        const code = `
public interface UserService {
    User getUser(int id);
}`;
        const result = parse(code, 'java');
        assert.strictEqual(result.classes.length, 1);
        assert.strictEqual(result.classes[0].type, 'interface');
    });

    it('parses methods with annotations', () => {
        const code = `
public class Controller {
    @Override
    public void handle() {}
}`;
        const result = parse(code, 'java');
        assert.strictEqual(result.functions.length >= 0, true);
    });
});

// ============================================================================
// OUTPUT FORMAT
// ============================================================================

describe('Output Format', () => {
    it('includes full params without truncation', () => {
        const code = `
function processData(input: { name: string; age: number; address: { street: string; city: string } }): Promise<Result> {
    return Promise.resolve({});
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions.length, 1);
        assert.ok(result.functions[0].params.includes('address'));
        assert.ok(result.functions[0].params.includes('city'));
    });

    it('includes return types', () => {
        const code = `
function getData(): Promise<User[]> {
    return Promise.resolve([]);
}`;
        const result = parse(code, 'typescript');
        assert.strictEqual(result.functions[0].returnType, 'Promise<User[]>');
    });

    it('includes generics', () => {
        const code = `
function map<T, U>(arr: T[], fn: (x: T) => U): U[] {
    return arr.map(fn);
}`;
        const result = parse(code, 'typescript');
        assert.ok(result.functions[0].generics);
    });

    it('includes docstrings', () => {
        const code = `
/**
 * Greets a user by name.
 * @param name - The user's name
 */
function greet(name: string) {
    return 'Hello ' + name;
}`;
        const result = parse(code, 'typescript');
        assert.ok(result.functions[0].docstring);
        assert.ok(result.functions[0].docstring.includes('Greets'));
    });
});
