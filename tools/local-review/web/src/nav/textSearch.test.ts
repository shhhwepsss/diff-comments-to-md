import { describe, expect, it } from 'vitest';
import { declarationPattern, findDeclarations, findWord, languageOf, MAX_DECLARATION_LINE, MAX_HITS, type TextFile } from './textSearch';

const at = (list: { path: string | null; line: number; character: number }[]) => list.map((l) => `${l.path}:${l.line}:${l.character}`);

describe('declarationPattern', () => {
  const declares = (path: string, word: string, line: string) => declarationPattern(word, path).test(line);

  it('TypeScript / JavaScript', () => {
    for (const line of [
      'export function helper() {',
      'function* helper() {',
      'export default class helper {',
      'interface helper {',
      'export type helper = string;',
      'enum helper { A }',
      'const helper = () => 1;',
      'let helper;',
      'var helper = 1',
      'const { a, helper } = obj;',
      '  async helper(a: string): Promise<void> {',
      '  private static helper<T>(x: T) {',
      '  get helper() { return 1; }',
      '  helper: string;',
      '  readonly helper?: number = 1;',
    ]) {
      expect(declares('a.ts', 'helper', line), line).toBe(true);
    }
    for (const line of [
      '  helper();',
      'return helper(x);',
      'const x = helper();',
      'foo(helper, () => {',
      '// the helper function',
      'const helperX = 1;',
      'const x = { helper }',
      'if (helper(a)) {',
    ]) {
      expect(declares('a.tsx', 'helper', line), line).toBe(false);
    }
  });

  it('a name with $', () => {
    expect(declares('a.js', '$el', 'const $el = document.body;')).toBe(true);
    expect(declares('a.js', '$el', 'const $element = 1;')).toBe(false);
  });

  it('Python', () => {
    expect(declares('m.py', 'run', 'def run(self):')).toBe(true);
    expect(declares('m.py', 'run', '    async def run():')).toBe(true);
    expect(declares('m.py', 'Run', 'class Run(Base):')).toBe(true);
    expect(declares('m.py', 'LIMIT', 'LIMIT: int = 3')).toBe(true);
    expect(declares('m.py', 'run', '    self.run()')).toBe(false);
    expect(declares('m.py', 'LIMIT', 'if LIMIT == 3:')).toBe(false);
  });

  it('Go', () => {
    expect(declares('m.go', 'Serve', 'func (s *Server) Serve(l net.Listener) error {')).toBe(true);
    expect(declares('m.go', 'Server', 'type Server struct {')).toBe(true);
    expect(declares('m.go', 'Serve', '\treturn s.Serve(l)')).toBe(false);
  });

  it('Java', () => {
    expect(declares('A.java', 'area', '    public abstract double area();')).toBe(false); // a prototype ends with `;`
    expect(declares('A.java', 'area', '    public double area() {')).toBe(true);
    expect(declares('A.java', 'area', '    List<String> area(int x) {')).toBe(true);
    expect(declares('A.java', 'Shape', 'public interface Shape {')).toBe(true);
    expect(declares('A.java', 'area', '        return area();')).toBe(false);
    expect(declares('A.java', 'Shape', '        Shape s = new Shape();')).toBe(false);
  });

  it('Rust, Kotlin, Ruby, PHP, C', () => {
    expect(declares('a.rs', 'parse', 'pub fn parse(input: &str) -> Result<()> {')).toBe(true);
    expect(declares('a.rs', 'Token', 'pub(crate) struct Token {')).toBe(true);
    expect(declares('a.kt', 'run', 'fun <T> List<T>.run() {')).toBe(true);
    expect(declares('a.rb', 'call', '  def self.call(env)')).toBe(true);
    expect(declares('a.php', 'handle', 'public function handle($request)')).toBe(true);
    expect(declares('a.c', 'parse', 'static int parse(const char *s) {')).toBe(true);
    expect(declares('a.c', 'MAX', '#define MAX 10')).toBe(true);
    expect(declares('a.c', 'parse', '  return parse(s);')).toBe(false);
  });

  it('an unknown language gets the common keywords', () => {
    expect(languageOf('script.lua')).toBe('other');
    expect(declares('script.lua', 'helper', 'function helper()')).toBe(true);
    expect(declares('script.lua', 'helper', 'helper()')).toBe(false);
  });

  it('regexp characters in the word are literal', () => {
    expect(() => declarationPattern('a.b', 'x.ts')).not.toThrow();
    expect(declares('x.ts', 'a.b', 'const aXb = 1')).toBe(false);
  });
});

const files: TextFile[] = [
  { path: 'src/b.ts', text: 'export function helper() {\n  return 1;\n}\n' },
  { path: 'src/a.ts', text: "import { helper } from './b';\r\nexport const value = helper() + helper(); // helper\r\n" },
  { path: 'lib/c.py', text: 'def helper():\n    pass\n' },
];

describe('findDeclarations', () => {
  it('finds the declaring lines in every file, the name as the place', () => {
    const found = findDeclarations(files, 'helper');
    expect(at(found)).toEqual(['src/b.ts:0:16', 'lib/c.py:0:4']);
    expect(found[0]).toMatchObject({ endLine: 0, endCharacter: 22, preview: { text: 'export function helper() {', start: 0 } });
  });

  it('the name, not an earlier mention on the line', () => {
    const found = findDeclarations([{ path: 'x.ts', text: '/* helper */ const helper = 1;\n' }], 'helper');
    expect(at(found)).toEqual(['x.ts:0:19']);
  });

  it('nothing for an empty word or no match', () => {
    expect(findDeclarations(files, '')).toEqual([]);
    expect(findDeclarations(files, 'value2')).toEqual([]);
  });
});

describe('findWord', () => {
  it('every whole-word occurrence, comments included, across \\r\\n lines', () => {
    expect(at(findWord(files, 'helper'))).toEqual([
      'src/b.ts:0:16',
      'src/a.ts:0:9',
      'src/a.ts:1:21',
      'src/a.ts:1:32',
      'src/a.ts:1:45',
      'lib/c.py:0:4',
    ]);
  });

  it('not inside a longer name', () => {
    expect(findWord([{ path: 'x.ts', text: 'helperX helper_ $helper helper$' }], 'helper')).toEqual([]);
  });

  it('a preview starts at the indent, or near a word far along a long line', () => {
    const long = `  ${'x'.repeat(300)} helper`;
    const [hit] = findWord([{ path: 'x.ts', text: long }], 'helper');
    expect(hit.preview?.start).toBe(hit.character - 60);
    expect(hit.preview?.text.startsWith('x')).toBe(true);
    const [short] = findWord([{ path: 'x.ts', text: '    helper()' }], 'helper');
    expect(short.preview).toEqual({ text: 'helper()', start: 4 });
  });

  it('stops at MAX_HITS', () => {
    const text = 'a '.repeat(MAX_HITS + 50);
    expect(findWord([{ path: 'x.ts', text }], 'a')).toHaveLength(MAX_HITS);
  });
});

describe('Unicode names', () => {
  it('a Cyrillic name is whole only between non-letters', () => {
    expect(at(findWord([{ path: 'x.ts', text: 'моеимя имя имя2 _имя имя;' }], 'имя'))).toEqual(['x.ts:0:7', 'x.ts:0:21']);
  });

  it('declarations of Unicode names, also with Unicode types', () => {
    const files: TextFile[] = [
      { path: 'a.ts', text: 'const имя = 1;\nconst моеимя = 2;' },
      { path: 'B.java', text: '  public Тип имя(int x) {' },
    ];
    expect(at(findDeclarations(files, 'имя'))).toEqual(['a.ts:0:6', 'B.java:0:13']);
  });

  it('a word with regex characters is taken literally', () => {
    expect(at(findWord([{ path: 'x.js', text: '$a.b $a $ab a' }], '$a'))).toEqual(['x.js:0:0', 'x.js:0:5']);
    expect(declarationPattern('$a', 'x.js').test('const $a = 1')).toBe(true);
    expect(declarationPattern('$a', 'x.js').test('const xa = 1')).toBe(false);
  });
});

describe('long lines', () => {
  it('no catastrophic backtracking on a pathological line', () => {
    // Each of these made a declaration pattern backtrack quadratically or worse.
    const n = 20000;
    const lines = [
      `const { ${'a '.repeat(n)}`,
      `${'const {a '.repeat(n / 10)}`,
      `a${' '.repeat(n)}x`,
      `  public ${'List<'.repeat(n / 5)} a`,
      `int ${'a '.repeat(n)}`,
      `fun ${'a.'.repeat(n)}`,
    ];
    for (const [path, line] of lines.flatMap((l) => ['x.ts', 'X.java', 'x.c', 'x.kt'].map((p) => [p, l] as const))) {
      const started = performance.now();
      // findDeclarations skips such lines; the pattern itself must stay fast on a capped one too.
      findDeclarations([{ path, text: line }], 'a');
      declarationPattern('a', path).test(line.slice(0, MAX_DECLARATION_LINE));
      expect(performance.now() - started, `${path}: ${line.slice(0, 20)}`).toBeLessThan(250);
    }
  });

  it('a declaration on an over-long line is not looked for, a use still is', () => {
    const text = `const a = 1; ${'x'.repeat(MAX_DECLARATION_LINE)}`;
    expect(findDeclarations([{ path: 'x.ts', text }], 'a')).toEqual([]);
    expect(findWord([{ path: 'x.ts', text }], 'a')).toHaveLength(1);
  });

  it('300 files are searched quickly', () => {
    const text = Array.from({ length: 400 }, (_, i) => `export function f${i}(a: number) {\n  return helper(a) + ${i};\n}`).join('\n');
    const files: TextFile[] = Array.from({ length: 300 }, (_, i) => ({ path: `src/f${i}.ts`, text }));
    const started = performance.now();
    expect(findDeclarations(files, 'f399')).toHaveLength(300);
    expect(findWord(files, 'helper')).toHaveLength(MAX_HITS);
    expect(performance.now() - started).toBeLessThan(2000);
  });
});
