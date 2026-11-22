import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import matter from 'gray-matter';
import {
  loadPatterns,
  matchPatterns,
  syncPatternShims,
  syncPatternShimsIfStale,
  commandsDir,
} from '../../src/lib/patterns.js';

/**
 * The `/` pattern shims stay in the user's menu and leave the model's skill listing
 * (task her-oturumun-sabit-girdisi-kuculur…, owner 2026-11-23: "Yalnız ölçülen ikisini uygula").
 * Measured on a bare Claude Code session holding 63 shims: +4,484 first-call input tokens
 * without `disable-model-invocation`, +2 with it, and `/pattern-…` still expands.
 *
 * With the shims gone from the model's view, the prompt hook is the ONE channel that brings a
 * pattern in by itself. So the guard is: every pattern of a vault fires on its own name, and a
 * pattern that cannot fire is red. Run it on a real vault with
 * `DREAMCONTEXT_PATTERN_VAULT=<path to _dream_context> npx vitest run <this file>`.
 */

let PROJECT: string;
let ROOT: string;

function writePattern(dir: string, slug: string, frontmatter: string, body = ''): void {
  mkdirSync(join(dir, 'knowledge', 'patterns'), { recursive: true });
  writeFileSync(join(dir, 'knowledge', 'patterns', `${slug}.md`), `---\n${frontmatter}\n---\n\n${body}\n`, 'utf-8');
}

/** A spread of fictional patterns shaped like real ones: English and Turkish names, an H1 that
 *  differs from the slug, authored triggers, names that share words with each other. */
const FIXTURE: Array<[string, string, string]> = [
  ['surface-briefing-pattern', 'name: Surface Briefing Pattern\ndescription: Brief a spawned agent about the surface it renders into.', '# Surface Briefing Pattern\n'],
  ['mirror-with-drift-test', 'name: Mirror-With-Drift-Test Pattern\ndescription: A copied constant carries a test that fails when the copies differ.', ''],
  ['pid-lockfile-concurrent-json', 'name: PID lockfile for concurrent CLI subcommand\ndescription: Serialize writers of one JSON file with an O_EXCL lockfile.', ''],
  ['kiracı-sınırı', 'name: Kiracı sınırı\ntriggers: [tenant, çok kiracılı]\ndescription: Her sorgu kurum kimliğiyle süzülür.', '# Kiracı sınırı\n'],
  ['plan-ozeti-nasil-anlatilir', 'name: plan-ozeti-nasil-anlatilir\ndescription: Plan sunma kalıbı.', '# Plan özeti nasıl anlatılır\n'],
  ['runtime-measurement', 'name: Runtime Measurement Verification\ndescription: Measure the rendered artifact in a real browser.', ''],
  ['multi-reviewer-pattern', 'name: Multi-Reviewer Pattern\ndescription: Route a diff to specialists.', ''],
  ['sub-agent-iterative-reviewer-pattern', 'name: Sub-Agent with Iterative Reviewer Pattern\ndescription: Loop a reviewer.', ''],
  ['every-store-key-needs-a-death', 'name: Every store key needs a death\ndescription: A module-level store keyed by id needs a teardown per key.', ''],
];

beforeAll(() => {
  PROJECT = mkdtempSync(join(tmpdir(), 'dc-pattern-shims-'));
  ROOT = join(PROJECT, '_dream_context');
  for (const [slug, fm, body] of FIXTURE) writePattern(ROOT, slug, fm, body);
});

afterAll(() => { rmSync(PROJECT, { recursive: true, force: true }); });

/** The patterns of `root` that do not fire when the prompt is their own name. */
function silentPatterns(root: string): string[] {
  const patterns = loadPatterns(root).filter((p) => !p.generated);
  return patterns
    .filter((p) => !matchPatterns(p.name, patterns).some((h) => h.pattern.slug === p.slug))
    .map((p) => `${p.slug} ("${p.name}")`);
}

describe('pattern shims: in the "/" menu, out of the model\'s listing', () => {
  it('every shim carries disable-model-invocation: true and keeps its menu description', () => {
    syncPatternShims(PROJECT, ROOT);
    const shims = readdirSync(commandsDir(PROJECT)).filter((n) => n.startsWith('pattern-'));
    expect(shims.length).toBe(FIXTURE.length);
    for (const name of shims) {
      const fm = matter(readFileSync(join(commandsDir(PROJECT), name), 'utf-8')).data as Record<string, unknown>;
      expect(fm['disable-model-invocation'], name).toBe(true);
      // `user-invocable: false` would take it out of the menu too: the owner's feature.
      expect(fm['user-invocable'], name).toBeUndefined();
      expect(typeof fm.description === 'string' && fm.description.length > 0, name).toBe(true);
    }
  });

  it('a shim an older version wrote (no field) is rewritten: by `update`, and by the next stale session', () => {
    const dir = commandsDir(PROJECT);
    const name = readdirSync(dir).find((n) => n.startsWith('pattern-'))!;
    const strip = () => writeFileSync(join(dir, name), readFileSync(join(dir, name), 'utf-8').replace('disable-model-invocation: true\n', ''), 'utf-8');
    // `dreamcontext update` / setup: syncPatternShims runs unconditionally.
    strip();
    expect(syncPatternShims(PROJECT, ROOT).written).toEqual([name]);
    // The hook's session sync: an older version's cache fingerprint (no `shim-format` part)
    // never equals today's, so the first session after the upgrade rewrites the shims.
    strip();
    mkdirSync(join(ROOT, 'state'), { recursive: true });
    writeFileSync(join(ROOT, 'state', '.patterns-shims.json'), JSON.stringify({ fingerprint: 'cached-by-an-older-version' }), 'utf-8');
    expect(syncPatternShimsIfStale(PROJECT, ROOT)?.written).toEqual([name]);
    expect(readFileSync(join(dir, name), 'utf-8')).toContain('disable-model-invocation: true');
    expect(syncPatternShimsIfStale(PROJECT, ROOT)).toBeNull();
  });

  it('two projects sharing one vault through a symlink each get their own shims rewritten', () => {
    // The owner's code repo: `_dream_context` is a symlink to the brain's vault, so both
    // projects see the same patterns, the same shim names and the same cache file.
    const second = mkdtempSync(join(tmpdir(), 'dc-pattern-second-'));
    try {
      symlinkSync(ROOT, join(second, '_dream_context'));
      const secondRoot = join(second, '_dream_context');
      syncPatternShims(second, secondRoot);
      syncPatternShimsIfStale(PROJECT, ROOT);
      syncPatternShimsIfStale(second, secondRoot);
      // An older version left BOTH projects' shims without the field.
      for (const project of [PROJECT, second]) {
        for (const n of readdirSync(commandsDir(project))) {
          const f = join(commandsDir(project), n);
          writeFileSync(f, readFileSync(f, 'utf-8').replace('disable-model-invocation: true\n', ''), 'utf-8');
        }
      }
      writeFileSync(join(ROOT, 'state', '.patterns-shims.json'), JSON.stringify({ fingerprint: 'cached-by-an-older-version' }), 'utf-8');
      expect(syncPatternShimsIfStale(PROJECT, ROOT)?.written.length).toBe(FIXTURE.length);
      expect(syncPatternShimsIfStale(second, secondRoot)?.written.length).toBe(FIXTURE.length);
      for (const project of [PROJECT, second]) {
        for (const n of readdirSync(commandsDir(project))) {
          expect(readFileSync(join(commandsDir(project), n), 'utf-8'), `${project} ${n}`).toContain('disable-model-invocation: true');
        }
      }
      // And then both are in sync: no rewrite on the next session of either.
      expect(syncPatternShimsIfStale(PROJECT, ROOT)).toBeNull();
      expect(syncPatternShimsIfStale(second, secondRoot)).toBeNull();
    } finally { rmSync(second, { recursive: true, force: true }); }
  });
});

describe('with the shims off the model\'s list, the hook brings every pattern in by its own words', () => {
  it('every fixture pattern fires on its own name', () => {
    expect(silentPatterns(ROOT)).toEqual([]);
  });

  it('a pattern that cannot fire is red', () => {
    // A name made only of words that name the CATEGORY leaves the pattern no key of its own.
    const dir = mkdtempSync(join(tmpdir(), 'dc-pattern-silent-'));
    try {
      writePattern(dir, 'ledger-gate', 'name: Ledger Gate\ndescription: x');
      writePattern(dir, 'pattern-rules', 'name: Pattern rules\ndescription: y');
      expect(silentPatterns(dir)).toEqual(['pattern-rules ("Pattern rules")']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  const real = process.env.DREAMCONTEXT_PATTERN_VAULT;
  it.skipIf(!real)('every pattern of the vault in DREAMCONTEXT_PATTERN_VAULT fires on its own name', () => {
    expect(loadPatterns(real!).length).toBeGreaterThan(0);
    expect(silentPatterns(real!)).toEqual([]);
  });
});
