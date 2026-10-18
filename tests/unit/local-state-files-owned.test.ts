/**
 * The three machine-local task-system state files are written only by the
 * module that owns each one (orchestrator addition 5 to plan r4).
 *
 * Each owner calls `ensureLocalStateIgnored` before its first write, so the
 * file can never be committed and pushed. A second writer elsewhere would not
 * be bound by that, so the path constants stay inside their own modules and
 * the literal paths appear only in the owner and in the ignore lists.
 *
 * The constants for C7's two files land with C7 (W3); until then the scan
 * simply finds no other reference, which is the property it guards.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

const SRC = join(__dirname, '..', '..', 'src');

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(SRC).map((p) => ({ rel: relative(SRC, p).split(sep).join('/'), text: readFileSync(p, 'utf-8') }));

const OWNED = [
  { constant: 'TASK_AUDIT_REL', owner: 'lib/task-audit.ts', path: 'state/.task-audit.json' },
  { constant: 'OWNER_CORRECTIONS_REL', owner: 'lib/owner-corrections.ts', path: 'state/.owner-corrections.json' },
  { constant: 'LEARNED_REL', owner: 'lib/learned-patterns.ts', path: 'state/.learned-patterns.json' },
] as const;

/**
 * Where the literal path may also appear: the shared list and its ensure
 * (task-audit.ts), the full-repo and generated ignore lists, and the 0.33.0
 * migration step that brings existing vaults' ignores up to date.
 */
const LITERAL_ALLOWED = ['lib/task-audit.ts', 'lib/git-sync/brain-repo.ts', 'migrations/0.33.0.ts'];

describe('local state files are owned by one module each', () => {
  for (const o of OWNED) {
    it(`${o.constant} is referenced only in ${o.owner}`, () => {
      const re = new RegExp(`\\b${o.constant}\\b`);
      const users = files.filter((f) => re.test(f.text)).map((f) => f.rel);
      expect(users.filter((u) => u !== o.owner)).toEqual([]);
    });

    it(`the literal ${o.path} appears only in its owner and the ignore lists`, () => {
      const users = files.filter((f) => f.text.includes(o.path)).map((f) => f.rel);
      expect(users.filter((u) => u !== o.owner && !LITERAL_ALLOWED.includes(u))).toEqual([]);
    });
  }

  it('the audit constant exists where it is owned', () => {
    const owner = files.find((f) => f.rel === 'lib/task-audit.ts');
    expect(owner?.text).toMatch(/\bTASK_AUDIT_REL\b/);
  });
});
