import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execSync } from 'node:child_process';
import matter from 'gray-matter';

const CLI = join(__dirname, '..', '..', 'dist', 'index.js');

function makeTmpDir(): string {
  const raw = join(tmpdir(), `ac-taxfix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  return realpathSync(raw);
}

function run(cmd: string, cwd: string): string {
  try {
    return execSync(`node ${CLI} ${cmd} 2>&1`, { cwd, encoding: 'utf-8', timeout: 20000 });
  } catch (e: any) {
    return (e.stdout ?? '') + (e.stderr ?? '');
  }
}

/** Read a knowledge file's frontmatter tags. */
function tagsOf(file: string): string[] {
  const data = matter(readFileSync(file, 'utf-8')).data as { tags?: string[] };
  return data.tags ?? [];
}

describe('taxonomy audit --fix (integration)', () => {
  let tmpDir: string;
  let knowledgeFile: string;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    run('init --yes --name "Test" --description "d" --stack "Node" --priority "p"', tmpDir);

    // Seed the project vocab so `excalidraw` resolves to a canonical faceted tag.
    run('taxonomy add topic:excalidraw', tmpDir);
    run('taxonomy alias excalidraw topic:excalidraw', tmpDir);

    // Drop a knowledge file with drifted tags written RAW into frontmatter:
    //   excalidraw   → alias of topic:excalidraw  (rewrite)
    //   search       → DEFAULT alias of topic:recall (rewrite)
    //   architecture → canonical bare tag           (keep)
    //   P2           → orphan, no alias             (keep, unresolved)
    knowledgeFile = join(tmpDir, '_dream_context', 'knowledge', 'drifted.md');
    const body = matter.stringify('Body.\n', {
      id: 'know_test',
      name: 'drifted',
      description: 'drifted tags',
      tags: ['excalidraw', 'search', 'architecture', 'P2'],
    });
    writeFileSync(knowledgeFile, body, 'utf-8');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--fix --dry-run previews rewrites but writes NOTHING', () => {
    const before = readFileSync(knowledgeFile, 'utf-8');
    const out = run('taxonomy audit --fix --dry-run', tmpDir);

    expect(out).toContain('dry-run');
    expect(out).toContain('excalidraw');
    expect(out).toContain('topic:excalidraw');
    // File is byte-identical — dry run never mutates.
    expect(readFileSync(knowledgeFile, 'utf-8')).toBe(before);
  });

  it('--fix rewrites alias/normalizable tags and leaves canonical + orphan tags intact', () => {
    run('taxonomy audit --fix', tmpDir);

    const tags = tagsOf(knowledgeFile);
    expect(tags).toContain('topic:excalidraw'); // excalidraw rewritten
    expect(tags).toContain('topic:recall');     // search rewritten
    expect(tags).toContain('architecture');     // canonical — untouched
    expect(tags).toContain('P2');               // orphan — untouched
    expect(tags).not.toContain('excalidraw');
    expect(tags).not.toContain('search');
  });

  it('reports the orphan as needing a vocab decision', () => {
    const out = run('taxonomy audit --fix --dry-run', tmpDir);
    expect(out).toContain('vocab decision');
    expect(out).toContain('P2');
  });

  it('is idempotent — a second --fix finds nothing to rewrite', () => {
    run('taxonomy audit --fix', tmpDir);
    const afterFirst = readFileSync(knowledgeFile, 'utf-8');

    const out = run('taxonomy audit --fix', tmpDir);
    expect(out).toContain('nothing to fix');
    // Second run is a no-op on disk.
    expect(readFileSync(knowledgeFile, 'utf-8')).toBe(afterFirst);
  });

  it('--fix --json emits a machine-readable plan for sleep agents', () => {
    const out = run('taxonomy audit --fix --dry-run --json', tmpDir);
    const json = JSON.parse(out) as {
      applied: boolean;
      totalRewrites: number;
      files: Array<{ rewrites: Array<{ from: string; to: string }> }>;
    };
    expect(json.applied).toBe(false); // dry-run
    expect(json.totalRewrites).toBeGreaterThanOrEqual(2);
    const allRewrites = json.files.flatMap((f) => f.rewrites);
    expect(allRewrites).toContainEqual({ from: 'search', to: 'topic:recall' });
  });
});
