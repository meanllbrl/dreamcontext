import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyzeTranscript, scoreFromChangeCount, scoreFromToolCount,
  isJsTsFile, findFormatterConfig, findTsconfig, findProjectConfig,
} from '../../src/cli/commands/hook.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-hook-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function toolUseLine(name: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', name, input: {} }] },
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('scoreFromChangeCount', () => {
  it('returns 0 for 0 changes', () => {
    expect(scoreFromChangeCount(0)).toBe(0);
  });

  it('returns 0 for negative', () => {
    expect(scoreFromChangeCount(-1)).toBe(0);
  });

  it('returns 1 for 1 change', () => {
    expect(scoreFromChangeCount(1)).toBe(1);
  });

  it('returns 1 for 3 changes', () => {
    expect(scoreFromChangeCount(3)).toBe(1);
  });

  it('returns 2 for 4 changes', () => {
    expect(scoreFromChangeCount(4)).toBe(2);
  });

  it('returns 2 for 8 changes', () => {
    expect(scoreFromChangeCount(8)).toBe(2);
  });

  it('returns 3 for 9 changes', () => {
    expect(scoreFromChangeCount(9)).toBe(3);
  });

  it('returns 3 for 50 changes', () => {
    expect(scoreFromChangeCount(50)).toBe(3);
  });
});

describe('scoreFromToolCount', () => {
  it('returns 0 for 0 tools', () => {
    expect(scoreFromToolCount(0)).toBe(0);
  });

  it('returns 0 for negative', () => {
    expect(scoreFromToolCount(-1)).toBe(0);
  });

  it('returns 1 for 1 tool call', () => {
    expect(scoreFromToolCount(1)).toBe(1);
  });

  it('returns 1 for 15 tool calls', () => {
    expect(scoreFromToolCount(15)).toBe(1);
  });

  it('returns 2 for 16 tool calls', () => {
    expect(scoreFromToolCount(16)).toBe(2);
  });

  it('returns 2 for 40 tool calls', () => {
    expect(scoreFromToolCount(40)).toBe(2);
  });

  it('returns 3 for 41 tool calls', () => {
    expect(scoreFromToolCount(41)).toBe(3);
  });

  it('returns 3 for 100 tool calls', () => {
    expect(scoreFromToolCount(100)).toBe(3);
  });
});

describe('analyzeTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns zeros for non-existent file', () => {
    const result = analyzeTranscript(join(tmpDir, 'nope.jsonl'));
    expect(result.changeCount).toBe(0);
    expect(result.toolCount).toBe(0);
  });

  it('returns zeros for empty file', () => {
    const f = join(tmpDir, 'empty.jsonl');
    writeFileSync(f, '');
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(0);
    expect(result.toolCount).toBe(0);
  });

  it('counts Write tool uses', () => {
    const f = join(tmpDir, 'transcript.jsonl');
    writeFileSync(f, [toolUseLine('Write'), toolUseLine('Write')].join('\n'));
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(2);
    expect(result.toolCount).toBe(2);
  });

  it('counts Edit tool uses', () => {
    const f = join(tmpDir, 'transcript.jsonl');
    writeFileSync(f, toolUseLine('Edit'));
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(1);
    expect(result.toolCount).toBe(1);
  });

  it('counts Write/Edit for changeCount, all tools for toolCount', () => {
    const f = join(tmpDir, 'transcript.jsonl');
    const lines = [
      toolUseLine('Write'),
      toolUseLine('Edit'),
      toolUseLine('Read'),
      toolUseLine('Bash'),
      toolUseLine('Glob'),
    ];
    writeFileSync(f, lines.join('\n'));
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(2);
    expect(result.toolCount).toBe(5);
  });

  it('handles "name": "Write" with space after colon', () => {
    const f = join(tmpDir, 'spaced.jsonl');
    const line = '{"type":"assistant","message":{"content":[{"type":"tool_use","name": "Write","input":{}}]}}';
    writeFileSync(f, line);
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(1);
    expect(result.toolCount).toBe(1);
  });

  it('does not false-positive on user text mentioning Write', () => {
    const f = join(tmpDir, 'user.jsonl');
    const line = JSON.stringify({
      type: 'human',
      message: { content: [{ type: 'text', text: 'Please use the "name":"Write" tool' }] },
    });
    writeFileSync(f, line);
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(0);
    expect(result.toolCount).toBe(0);
  });

  it('counts multiple tool uses on one line', () => {
    const f = join(tmpDir, 'multi.jsonl');
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'Write', input: {} },
          { type: 'tool_use', name: 'Edit', input: {} },
        ],
      },
    });
    writeFileSync(f, line);
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(2);
    expect(result.toolCount).toBe(2);
  });

  it('counts Bash and Read in toolCount but not changeCount', () => {
    const f = join(tmpDir, 'bash-only.jsonl');
    const lines = [
      toolUseLine('Bash'),
      toolUseLine('Read'),
      toolUseLine('Glob'),
      toolUseLine('Grep'),
      toolUseLine('Bash'),
    ];
    writeFileSync(f, lines.join('\n'));
    const result = analyzeTranscript(f);
    expect(result.changeCount).toBe(0);
    expect(result.toolCount).toBe(5);
  });

  // ─── Task slug extraction ───────────────────────────────────────────────────

  it('extracts task slugs from dreamcontext tasks log commands', () => {
    const f = join(tmpDir, 'tasks.jsonl');
    const content = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"dreamcontext tasks log fix-auth-bug \\"Implemented token refresh\\""}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"dreamcontext tasks insert my-task notes \\"some note\\""}}]}}',
    ].join('\n');
    writeFileSync(f, content);
    const result = analyzeTranscript(f);
    expect(result.taskSlugs).toContain('fix-auth-bug');
    expect(result.taskSlugs).toContain('my-task');
  });

  it('extracts task slugs from _dream_context/state/*.md file paths', () => {
    const f = join(tmpDir, 'reads.jsonl');
    const content = '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/home/user/project/_dream_context/state/web-dashboard.md"}}]}}';
    writeFileSync(f, content);
    const result = analyzeTranscript(f);
    expect(result.taskSlugs).toContain('web-dashboard');
  });

  it('deduplicates task slugs from multiple sources', () => {
    const f = join(tmpDir, 'dupes.jsonl');
    const content = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"_dream_context/state/my-task.md"}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"dreamcontext tasks log my-task \\"did stuff\\""}}]}}',
    ].join('\n');
    writeFileSync(f, content);
    const result = analyzeTranscript(f);
    expect(result.taskSlugs).toEqual(['my-task']);
  });

  it('returns empty taskSlugs when no task references found', () => {
    const f = join(tmpDir, 'no-tasks.jsonl');
    writeFileSync(f, toolUseLine('Write'));
    const result = analyzeTranscript(f);
    expect(result.taskSlugs).toEqual([]);
  });

  it('extracts from dreamcontext tasks complete and create commands', () => {
    const f = join(tmpDir, 'complete.jsonl');
    const content = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"dreamcontext tasks complete fix-bug \\"All done\\""}}]}}',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"dreamcontext tasks create new-feature --status todo"}}]}}',
    ].join('\n');
    writeFileSync(f, content);
    const result = analyzeTranscript(f);
    expect(result.taskSlugs).toContain('fix-bug');
    expect(result.taskSlugs).toContain('new-feature');
  });

  it('does not extract task slugs from prose text about commands', () => {
    const f = join(tmpDir, 'prose.jsonl');
    // Agent text mentioning commands in prose (not in tool input)
    const content = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{
          type: 'text',
          text: 'You can use dreamcontext tasks log my-task to record progress. ' +
            'Also dreamcontext tasks complete and create are useful commands.',
        }],
      },
    });
    writeFileSync(f, content);
    const result = analyzeTranscript(f);
    expect(result.taskSlugs).toEqual([]);
  });
});

// ─── isJsTsFile ──────────────────────────────────────────────────────────────

describe('isJsTsFile', () => {
  it('returns true for .ts', () => expect(isJsTsFile('foo.ts')).toBe(true));
  it('returns true for .tsx', () => expect(isJsTsFile('foo.tsx')).toBe(true));
  it('returns true for .js', () => expect(isJsTsFile('foo.js')).toBe(true));
  it('returns true for .jsx', () => expect(isJsTsFile('foo.jsx')).toBe(true));
  it('returns true for .mjs', () => expect(isJsTsFile('foo.mjs')).toBe(true));
  it('returns true for .cjs', () => expect(isJsTsFile('foo.cjs')).toBe(true));
  it('returns true for .mts', () => expect(isJsTsFile('foo.mts')).toBe(true));
  it('returns true for .cts', () => expect(isJsTsFile('foo.cts')).toBe(true));
  it('returns false for .py', () => expect(isJsTsFile('foo.py')).toBe(false));
  it('returns false for .md', () => expect(isJsTsFile('foo.md')).toBe(false));
  it('returns false for .css', () => expect(isJsTsFile('foo.css')).toBe(false));
  it('returns false for no extension', () => expect(isJsTsFile('Makefile')).toBe(false));
  it('handles paths with directories', () => expect(isJsTsFile('/foo/bar/baz.ts')).toBe(true));
  it('is case-insensitive', () => expect(isJsTsFile('foo.TS')).toBe(true));
});

// ─── findFormatterConfig ─────────────────────────────────────────────────────

describe('findFormatterConfig', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when no config found', () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    const filePath = join(tmpDir, 'src', 'index.ts');
    writeFileSync(filePath, '');
    expect(findFormatterConfig(filePath)).toBeNull();
  });

  it('finds biome.json in same directory', () => {
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    const filePath = join(tmpDir, 'index.ts');
    writeFileSync(filePath, '');
    const result = findFormatterConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('biome');
  });

  it('finds biome.jsonc', () => {
    writeFileSync(join(tmpDir, 'biome.jsonc'), '{}');
    const filePath = join(tmpDir, 'index.ts');
    writeFileSync(filePath, '');
    const result = findFormatterConfig(filePath);
    expect(result!.type).toBe('biome');
  });

  it('finds .prettierrc in parent directory', () => {
    writeFileSync(join(tmpDir, '.prettierrc'), '{}');
    mkdirSync(join(tmpDir, 'src'), { recursive: true });
    const filePath = join(tmpDir, 'src', 'index.ts');
    writeFileSync(filePath, '');
    const result = findFormatterConfig(filePath);
    expect(result).not.toBeNull();
    expect(result!.type).toBe('prettier');
  });

  it('prefers biome over prettier when both exist', () => {
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    writeFileSync(join(tmpDir, '.prettierrc'), '{}');
    const filePath = join(tmpDir, 'index.ts');
    writeFileSync(filePath, '');
    const result = findFormatterConfig(filePath);
    expect(result!.type).toBe('biome');
  });

  it('walks up multiple levels', () => {
    writeFileSync(join(tmpDir, 'biome.json'), '{}');
    mkdirSync(join(tmpDir, 'a', 'b', 'c'), { recursive: true });
    const filePath = join(tmpDir, 'a', 'b', 'c', 'index.ts');
    writeFileSync(filePath, '');
    const result = findFormatterConfig(filePath);
    expect(result!.type).toBe('biome');
    expect(result!.projectRoot).toBe(tmpDir);
  });

  it('finds prettier.config.js', () => {
    writeFileSync(join(tmpDir, 'prettier.config.js'), 'module.exports = {};');
    const filePath = join(tmpDir, 'index.ts');
    writeFileSync(filePath, '');
    const result = findFormatterConfig(filePath);
    expect(result!.type).toBe('prettier');
  });
});

// ─── findTsconfig ────────────────────────────────────────────────────────────

describe('findTsconfig', () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

  it('returns null when no tsconfig.json found', () => {
    const filePath = join(tmpDir, 'index.ts');
    writeFileSync(filePath, '');
    expect(findTsconfig(filePath)).toBeNull();
  });

  it('finds tsconfig.json in same directory', () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}');
    const filePath = join(tmpDir, 'index.ts');
    writeFileSync(filePath, '');
    expect(findTsconfig(filePath)).toBe(join(tmpDir, 'tsconfig.json'));
  });

  it('walks up to find tsconfig.json', () => {
    writeFileSync(join(tmpDir, 'tsconfig.json'), '{}');
    mkdirSync(join(tmpDir, 'src', 'lib'), { recursive: true });
    const filePath = join(tmpDir, 'src', 'lib', 'utils.ts');
    writeFileSync(filePath, '');
    expect(findTsconfig(filePath)).toBe(join(tmpDir, 'tsconfig.json'));
  });
});
