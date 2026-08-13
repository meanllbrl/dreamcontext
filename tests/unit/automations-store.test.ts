import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { join, relative } from 'node:path';
import { tmpdir } from 'node:os';
import {
  automationCachePath,
  automationPath,
  automationsDir,
  createAutomation,
  defaultGitTrackedCheck,
  deriveFlowFromManifest,
  extractSection,
  getAutomation,
  isSafeAutomationSlug,
  listAutomations,
  lockPathFor,
  outputDirFor,
  outputRootDir,
  parseEffort,
  parseFlowSection,
  readAutomationCache,
  readAutomationFile,
  readRunSidecar,
  recordRun,
  removeAutomation,
  resolveOutputDir,
  setAutomationEnabled,
  setAutomationShared,
  shareStateFor,
  sidecarPathFor,
  validateAutomationForWrite,
  writeFlowSection,
  writeAutomationCache,
  writeRunSidecar,
  clearRunSidecar,
  type GitTrackedCheck,
} from '../../src/lib/automations/store.js';
import {
  AutomationError,
  AUTOMATIONS_GITIGNORE_ENTRIES,
  AUTOMATIONS_GITIGNORE_ENTRIES_ROOT,
  EFFORT_LEVELS,
  HISTORY_LIMIT,
  sharedSlugNegations,
  type AutomationCache,
  type AutomationManifest,
  type RunEvent,
  type RunSidecar,
} from '../../src/lib/automations/types.js';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-automations-store-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// ─── test fixtures ───────────────────────────────────────────────────────────

function fakeManifest(overrides: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    slug: 'x',
    id: 'auto_xxxxxxxx',
    title: 'X',
    enabled: true,
    schedule: { days: 'daily', at: '18:00' },
    model: null,
    effort: null,
    timeoutMinutes: 15,
    catchupHours: 6,
    outputDir: null,
    shared: false,
    prompt: 'do the thing',
    outputInstructions: '',
    path: '/nonexistent.md',
    body: '',
    ...overrides,
  };
}

function fakeRunEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    firedAt: '2026-07-25T18:00:00.000Z',
    startedAt: '2026-07-25T18:00:01.000Z',
    finishedAt: '2026-07-25T18:00:05.000Z',
    status: 'ok',
    durationMs: 4000,
    outputPath: '/out.md',
    error: null,
    exitCode: 0,
    sessionId: 'sess_1',
    costUsd: 0.01,
    numTurns: 3,
    permissionDenials: 0,
    ...overrides,
  };
}

function validSidecar(overrides: Partial<RunSidecar> = {}): RunSidecar {
  return {
    slug: 'x',
    runnerPid: 100,
    childPid: 200,
    childPgid: 200,
    fireAt: '2026-07-25T18:00:00.000Z',
    startedAt: '2026-07-25T18:00:01.000Z',
    timeoutAt: '2026-07-25T18:15:01.000Z',
    ...overrides,
  };
}

// ─── slug safety ─────────────────────────────────────────────────────────────

describe('isSafeAutomationSlug', () => {
  it('accepts kebab-case slugs', () => {
    expect(isSafeAutomationSlug('eod-digest')).toBe(true);
    expect(isSafeAutomationSlug('weekly-report-2')).toBe(true);
  });

  it('rejects the reserved sibling-directory names', () => {
    expect(isSafeAutomationSlug('cache')).toBe(false);
    expect(isSafeAutomationSlug('output')).toBe(false);
  });

  it('rejects uppercase, double-dash, trailing dash, and a leading dash', () => {
    expect(isSafeAutomationSlug('EOD-Digest')).toBe(false);
    expect(isSafeAutomationSlug('eod--digest')).toBe(false);
    expect(isSafeAutomationSlug('eod-digest-')).toBe(false);
    expect(isSafeAutomationSlug('-eod-digest')).toBe(false);
  });
});

// ─── extractSection ──────────────────────────────────────────────────────────

describe('extractSection', () => {
  it('extracts a section body between its heading and the next ## heading', () => {
    const body = '## Prompt\n\nDo the thing.\n\n## Output instructions\n\nBe terse.\n';
    expect(extractSection(body, 'Prompt')).toBe('Do the thing.');
    expect(extractSection(body, 'Output instructions')).toBe('Be terse.');
  });

  it('returns the rest of the document when the heading is the last section', () => {
    const body = '## Prompt\n\nOnly section.\n';
    expect(extractSection(body, 'Prompt')).toBe('Only section.');
  });

  it('returns an empty string when the heading is absent', () => {
    expect(extractSection('## Other\n\nx\n', 'Prompt')).toBe('');
  });
});

// ─── parseEffort — lenient (fail-safe: anything not a real level ⇒ null) ────

describe('parseEffort', () => {
  it.each(EFFORT_LEVELS)('round-trips the valid level %j', (level) => {
    expect(parseEffort(level)).toBe(level);
  });

  it.each(['ultra', '', 7, null, undefined, 'LOW', 'Max', {}, []])(
    'reads %j as null — let claude pick its own default, never guess',
    (v) => {
      expect(parseEffort(v)).toBeNull();
    },
  );
});

// ─── resolveOutputDir containment ───────────────────────────────────────────

describe('resolveOutputDir', () => {
  it('defaults to automations/output/<slug> when raw is null', () => {
    expect(resolveOutputDir(contextRoot, null, 'eod')).toBe(join(outputRootDir(contextRoot), 'eod'));
  });

  it('accepts a plain relative subdirectory and a dot-segment path that normalizes inside the root', () => {
    expect(resolveOutputDir(contextRoot, 'reports', 'eod')).toBe(join(contextRoot, 'reports'));
    expect(resolveOutputDir(contextRoot, 'a/./b', 'eod')).toBe(join(contextRoot, 'a', 'b'));
  });

  it.each(['', '.', './', '..', '/etc', '../../etc'])('rejects %j — escapes or equals the brain root', (raw) => {
    expect(() => resolveOutputDir(contextRoot, raw, 'eod')).toThrow(AutomationError);
  });
});

describe('outputDirFor', () => {
  it('resolves a valid manifest outputDir with no degrade', () => {
    const m = fakeManifest({ outputDir: 'reports' });
    const { dir, degradeReason } = outputDirFor(contextRoot, m);
    expect(dir).toBe(join(contextRoot, 'reports'));
    expect(degradeReason).toBeNull();
  });

  it('degrades a hand-tampered escaping outputDir to the default, with a fixed non-empty reason containing no path', () => {
    const m = fakeManifest({ slug: 'tampered', outputDir: '../../etc' });
    const { dir, degradeReason } = outputDirFor(contextRoot, m);
    expect(dir).toBe(join(outputRootDir(contextRoot), 'tampered'));
    expect(degradeReason).toBeTruthy();
    expect(degradeReason).not.toContain('etc');
    expect(degradeReason).not.toContain(contextRoot);
    expect(degradeReason).not.toContain('../../etc');
  });
});

// ─── validateAutomationForWrite ──────────────────────────────────────────────

describe('validateAutomationForWrite', () => {
  const base = { slug: 'eod-digest', title: 'EOD Digest', days: 'daily' as const, at: '18:00' };

  it('accepts a valid input', () => {
    expect(() => validateAutomationForWrite(base)).not.toThrow();
  });

  it.each(['cache', 'output', 'Not-Valid', 'a--b', 'a-'])('rejects the bad slug %j', (slug) => {
    expect(() => validateAutomationForWrite({ ...base, slug })).toThrow(AutomationError);
  });

  it('rejects a missing/blank title', () => {
    expect(() => validateAutomationForWrite({ ...base, title: '' })).toThrow(AutomationError);
    expect(() => validateAutomationForWrite({ ...base, title: '   ' })).toThrow(AutomationError);
  });

  it('rejects an invalid schedule (bad day, bad time, empty day list)', () => {
    expect(() => validateAutomationForWrite({ ...base, days: ['someday'] as never })).toThrow(AutomationError);
    expect(() => validateAutomationForWrite({ ...base, at: '25:00' })).toThrow(AutomationError);
    expect(() => validateAutomationForWrite({ ...base, days: [] })).toThrow(AutomationError);
  });

  it('rejects an invalid model', () => {
    expect(() => validateAutomationForWrite({ ...base, model: 'not a model!' })).toThrow(AutomationError);
  });

  it('rejects an invalid effort — STRICT, unlike the lenient read path', () => {
    expect(() => validateAutomationForWrite({ ...base, effort: 'ultra' as never })).toThrow(AutomationError);
  });

  it('accepts every valid effort, a null effort, and an omitted (undefined) effort', () => {
    for (const level of EFFORT_LEVELS) {
      expect(() => validateAutomationForWrite({ ...base, effort: level })).not.toThrow();
    }
    expect(() => validateAutomationForWrite({ ...base, effort: null })).not.toThrow();
    expect(() => validateAutomationForWrite({ ...base })).not.toThrow();
  });

  it('rejects out-of-range timeout_minutes and catchup_hours', () => {
    expect(() => validateAutomationForWrite({ ...base, timeoutMinutes: 0 })).toThrow(AutomationError);
    expect(() => validateAutomationForWrite({ ...base, timeoutMinutes: 61 })).toThrow(AutomationError);
    expect(() => validateAutomationForWrite({ ...base, catchupHours: 0 })).toThrow(AutomationError);
    expect(() => validateAutomationForWrite({ ...base, catchupHours: 169 })).toThrow(AutomationError);
  });
});

// ─── createAutomation / read / list ──────────────────────────────────────────

describe('createAutomation', () => {
  it('scaffolds a manifest with defaults and a Prompt / Output instructions body', () => {
    const m = createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD Digest', days: 'daily', at: '18:00' });
    expect(m.slug).toBe('eod-digest');
    expect(m.title).toBe('EOD Digest');
    expect(m.enabled).toBe(true);
    expect(m.schedule).toEqual({ days: 'daily', at: '18:00' });
    expect(m.model).toBeNull();
    expect(m.effort).toBeNull();
    expect(m.timeoutMinutes).toBe(15);
    expect(m.catchupHours).toBe(6);
    expect(m.outputDir).toBeNull();
    expect(m.shared).toBe(false); // private by default
    expect(m.body).toContain('## Prompt');
    expect(m.body).toContain('## Output instructions');
    expect(existsSync(automationPath(contextRoot, 'eod-digest'))).toBe(true);
  });

  it('persists explicit effort and shared, reading them back', () => {
    const m = createAutomation(contextRoot, {
      slug: 'effort-shared',
      title: 'Effort + Shared',
      days: 'daily',
      at: '18:00',
      effort: 'max',
      shared: true,
    });
    expect(m.effort).toBe('max');
    expect(m.shared).toBe(true);
    const reread = getAutomation(contextRoot, 'effort-shared')!;
    expect(reread.effort).toBe('max');
    expect(reread.shared).toBe(true);
  });

  it('persists explicit model/timeout/catchup/outputDir/enabled and reads them back', () => {
    const m = createAutomation(contextRoot, {
      slug: 'weekly',
      title: 'Weekly',
      days: ['fri'],
      at: '17:00',
      model: 'sonnet-5',
      timeoutMinutes: 30,
      catchupHours: 12,
      outputDir: 'reports',
      enabled: false,
      prompt: 'Summarize the week.',
      outputInstructions: 'Markdown only.',
    });
    expect(m.model).toBe('sonnet-5');
    expect(m.timeoutMinutes).toBe(30);
    expect(m.catchupHours).toBe(12);
    expect(m.outputDir).toBe('reports');
    expect(m.enabled).toBe(false);
    expect(m.prompt).toBe('Summarize the week.');
    expect(m.outputInstructions).toBe('Markdown only.');
  });

  it('throws on a duplicate slug', () => {
    createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD Digest', days: 'daily', at: '18:00' });
    expect(() =>
      createAutomation(contextRoot, { slug: 'eod-digest', title: 'Again', days: 'daily', at: '19:00' }),
    ).toThrow(AutomationError);
  });

  it.each(['cache', 'output'])('rejects the reserved slug %j before any write', (slug) => {
    expect(() => createAutomation(contextRoot, { slug, title: 'X', days: 'daily', at: '18:00' })).toThrow(
      AutomationError,
    );
    expect(existsSync(automationPath(contextRoot, slug))).toBe(false);
  });

  it('throws (and writes nothing) when outputDir escapes the brain', () => {
    expect(() =>
      createAutomation(contextRoot, {
        slug: 'escapee',
        title: 'X',
        days: 'daily',
        at: '18:00',
        outputDir: '../../etc',
      }),
    ).toThrow(AutomationError);
    expect(existsSync(automationPath(contextRoot, 'escapee'))).toBe(false);
  });

  it('ensures BOTH governing .gitignore files before the first write', () => {
    createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD Digest', days: 'daily', at: '18:00' });
    const contextGitignore = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');
    expect(contextGitignore).toContain('automations/cache/*.lock');
    expect(contextGitignore).toContain('automations/cache/*.run.json');
    // The sidecar's own write-then-rename .tmp intermediate must be covered too —
    // *.run.json alone does not match a literal ...run.json.tmp suffix.
    expect(contextGitignore).toContain('automations/cache/*.run.json.tmp');
    const projectGitignore = readFileSync(join(projectRoot, '.gitignore'), 'utf-8');
    expect(projectGitignore).toContain('_dream_context/automations/cache/*.lock');
    expect(projectGitignore).toContain('_dream_context/automations/cache/*.run.json');
    expect(projectGitignore).toContain('_dream_context/automations/cache/*.run.json.tmp');
  });

  it('the sidecar\'s real .tmp write-then-rename filename is git-ignored (verified with real `git check-ignore`, not string matching)', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD Digest', days: 'daily', at: '18:00' });

    // Mirrors store.ts's own construction exactly: `const tmp = \`${path}.tmp\`;`
    // in writeRunSidecar — this is the literal path the running code produces,
    // not a hand-typed guess at its shape.
    const sidecarTmpPath = `${sidecarPathFor(contextRoot, 'eod-digest')}.tmp`;

    const checkIgnored = (absPath: string): number | null =>
      spawnSync('git', ['check-ignore', '--quiet', relative(projectRoot, absPath)], { cwd: projectRoot }).status;

    // git check-ignore exits 0 when the path IS ignored, 1 when it is not.
    expect(checkIgnored(sidecarTmpPath)).toBe(0);
    // Regression coverage for the two paths that were already correctly ignored.
    expect(checkIgnored(sidecarPathFor(contextRoot, 'eod-digest'))).toBe(0);
    expect(checkIgnored(lockPathFor(contextRoot, 'eod-digest'))).toBe(0);
  });
});

describe('readAutomationFile — lenient (never throws on a malformed sub-block)', () => {
  it('degrades every malformed field to a safe default instead of throwing', () => {
    const path = automationPath(contextRoot, 'busted');
    mkdirSync(automationsDir(contextRoot), { recursive: true });
    writeFileSync(
      path,
      [
        '---',
        'id: 12345', // not a string
        'title: null',
        'enabled: "yes"', // not a boolean literal false — treated as enabled
        'schedule:',
        '  days: [nope, way, off]', // invalid weekdays
        '  at: "25:99"',
        'model: 123',
        'effort: ultra-mega', // not a real EFFORT_LEVELS member
        'timeout_minutes: -5',
        'catchup_hours: not-a-number',
        'output:',
        '  dir: 42',
        'shared: "yes"', // not the literal boolean true — must read as private
        'notify: "no"', // not the literal boolean false — must read as NOTIFY
        '---',
        '',
        'no headings at all',
        '',
      ].join('\n'),
      'utf-8',
    );

    expect(() => readAutomationFile(path)).not.toThrow();
    const m = readAutomationFile(path);
    expect(m.id).toBe(''); // non-string id degrades to ''
    expect(m.title).toBe('busted'); // falls back to the slug
    expect(m.enabled).toBe(true); // anything but literal false ⇒ enabled
    expect(m.schedule).toBeNull(); // invalid weekdays/time ⇒ no schedule
    expect(m.model).toBe('123'); // coerced to a string, not regex-revalidated on read
    expect(m.effort).toBeNull(); // not a real level ⇒ null, never guessed
    expect(m.timeoutMinutes).toBe(15); // non-positive ⇒ default
    expect(m.catchupHours).toBe(6); // non-numeric ⇒ default
    expect(m.outputDir).toBe('42'); // coerced to a string
    expect(m.shared).toBe(false); // anything but the literal boolean true ⇒ private
    // The two boolean flags fail toward OPPOSITE states, deliberately: an
    // over-share is a leak, an un-announced run is a silent loss. So the same
    // malformed-string shape that silences `shared` must NOT silence `notify`.
    expect(m.notify).toBe(true); // anything but the literal boolean false ⇒ notify
    expect(m.prompt).toBe('');
    expect(m.outputInstructions).toBe('');
  });

  it("a malformed review mode degrades to 'off', not to a gate nobody is watching", () => {
    // Third direction in the fail-safe family, and the reasoning is its own:
    // `shared` fails closed because an over-share is a leak, `notify` fails open
    // because a silent run is a loss — and `review` fails OPEN (off) because a
    // scheduler that silently stops to await a card nobody was told about is a
    // job that quietly never completes. The typo is visible in `list`; a wedged
    // automation is not.
    const path = automationPath(contextRoot, 'typo-review');
    mkdirSync(automationsDir(contextRoot), { recursive: true });
    writeFileSync(path, '---\ntitle: T\nreview: agnet\n---\n\n## Prompt\n\ndo it\n', 'utf-8');
    expect(readAutomationFile(path).review).toBe('off');
  });

  it.each(['agent', 'output', 'off'] as const)('reads review: %s verbatim', (mode) => {
    const path = automationPath(contextRoot, `review-${mode}`);
    mkdirSync(automationsDir(contextRoot), { recursive: true });
    writeFileSync(path, `---\ntitle: T\nreview: ${mode}\n---\n\n## Prompt\n\ndo it\n`, 'utf-8');
    expect(readAutomationFile(path).review).toBe(mode);
  });

  it("a manifest written before the field existed reads 'off'", () => {
    const path = automationPath(contextRoot, 'legacy');
    mkdirSync(automationsDir(contextRoot), { recursive: true });
    writeFileSync(path, '---\ntitle: Legacy\n---\n\n## Prompt\n\ndo it\n', 'utf-8');
    expect(readAutomationFile(path).review).toBe('off');
  });

  it('getAutomation returns null (never throws) for a file with unparseable frontmatter', () => {
    const path = automationPath(contextRoot, 'unparseable');
    mkdirSync(automationsDir(contextRoot), { recursive: true });
    writeFileSync(path, '---\nthis: [is, not\n  valid: yaml::::\n---\nbody\n', 'utf-8');
    // Single call, captured once: gray-matter (4.0.3) caches its pre-parse file
    // object keyed by raw content BEFORE the YAML parse attempt completes, so a
    // second call with byte-identical malformed content would return that stale
    // cache entry instead of re-parsing/re-throwing — an unrelated library
    // artifact, not something to encode into this test twice.
    let result: ReturnType<typeof getAutomation> = undefined as unknown as ReturnType<typeof getAutomation>;
    expect(() => {
      result = getAutomation(contextRoot, 'unparseable');
    }).not.toThrow();
    expect(result).toBeNull();
  });

  it('getAutomation returns null for a missing file or an unsafe/reserved slug', () => {
    expect(getAutomation(contextRoot, 'nope')).toBeNull();
    expect(getAutomation(contextRoot, 'cache')).toBeNull();
    expect(getAutomation(contextRoot, 'Not Valid')).toBeNull();
  });
});

describe('listAutomations', () => {
  it('returns [] when the automations directory does not exist', () => {
    expect(listAutomations(contextRoot)).toEqual([]);
  });

  it('lists created automations, sorted by slug, skipping an unparseable file', () => {
    createAutomation(contextRoot, { slug: 'b-weekly', title: 'B', days: 'daily', at: '18:00' });
    createAutomation(contextRoot, { slug: 'a-eod', title: 'A', days: 'daily', at: '18:00' });
    writeFileSync(automationPath(contextRoot, 'z-broken'), '---\n[[[not yaml\n---\n', 'utf-8');

    const slugs = listAutomations(contextRoot).map((m) => m.slug);
    expect(slugs).toEqual(['a-eod', 'b-weekly']);
  });
});

describe('setAutomationEnabled', () => {
  it('toggles enabled and persists it', () => {
    createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    const disabled = setAutomationEnabled(contextRoot, 'eod-digest', false);
    expect(disabled.enabled).toBe(false);
    expect(getAutomation(contextRoot, 'eod-digest')!.enabled).toBe(false);
    const enabled = setAutomationEnabled(contextRoot, 'eod-digest', true);
    expect(enabled.enabled).toBe(true);
  });

  it('throws for a nonexistent automation', () => {
    expect(() => setAutomationEnabled(contextRoot, 'nope', true)).toThrow(AutomationError);
  });
});

describe('removeAutomation', () => {
  it('deletes the manifest, cache, lock, and sidecar', () => {
    createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    recordRun(contextRoot, 'eod-digest', fakeRunEvent());
    writeRunSidecar(contextRoot, 'eod-digest', validSidecar({ slug: 'eod-digest' }));
    writeFileSync(lockPathFor(contextRoot, 'eod-digest'), '{"pid":1,"at":0}\n', 'utf-8');

    removeAutomation(contextRoot, 'eod-digest');

    expect(existsSync(automationPath(contextRoot, 'eod-digest'))).toBe(false);
    expect(existsSync(automationCachePath(contextRoot, 'eod-digest'))).toBe(false);
    expect(existsSync(lockPathFor(contextRoot, 'eod-digest'))).toBe(false);
    expect(existsSync(sidecarPathFor(contextRoot, 'eod-digest'))).toBe(false);
  });

  it('removing an automation with no cache/lock/sidecar yet does not throw', () => {
    createAutomation(contextRoot, { slug: 'fresh', title: 'Fresh', days: 'daily', at: '18:00' });
    expect(() => removeAutomation(contextRoot, 'fresh')).not.toThrow();
  });

  it('purgeOutput removes the resolved output directory', () => {
    const m = createAutomation(contextRoot, {
      slug: 'eod-digest',
      title: 'EOD',
      days: 'daily',
      at: '18:00',
      outputDir: 'reports',
    });
    const { dir } = outputDirFor(contextRoot, m);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '2026-07-25.md'), 'output', 'utf-8');

    removeAutomation(contextRoot, 'eod-digest', { purgeOutput: true });
    expect(existsSync(dir)).toBe(false);
  });

  it('throws for a nonexistent automation', () => {
    expect(() => removeAutomation(contextRoot, 'nope')).toThrow(AutomationError);
  });
});

// ─── cache (atomic) + recordRun (watermark) ─────────────────────────────────

describe('automation cache — atomic read/write', () => {
  it('round-trips a cache record and leaves no leftover temp file', () => {
    const cache: AutomationCache = {
      slug: 'eod-digest',
      lastRunAt: '2026-07-25T18:00:00.000Z',
      lastFireAt: '2026-07-25T18:00:00.000Z',
      status: 'ok',
      durationMs: 1000,
      outputPath: '/out.md',
      error: null,
      exitCode: 0,
      history: [],
    };
    writeAutomationCache(contextRoot, 'eod-digest', cache);
    expect(readAutomationCache(contextRoot, 'eod-digest')).toEqual(cache);
    expect(existsSync(`${automationCachePath(contextRoot, 'eod-digest')}.tmp`)).toBe(false);
  });

  it('readAutomationCache returns null for a missing or malformed cache file', () => {
    expect(readAutomationCache(contextRoot, 'nope')).toBeNull();
    mkdirSync(join(automationsDir(contextRoot), 'cache'), { recursive: true });
    writeFileSync(automationCachePath(contextRoot, 'garbage'), '{not valid json', 'utf-8');
    expect(readAutomationCache(contextRoot, 'garbage')).toBeNull();
    writeFileSync(automationCachePath(contextRoot, 'array'), '[]', 'utf-8');
    expect(readAutomationCache(contextRoot, 'array')).toBeNull();
  });
});

describe('recordRun', () => {
  it('advances the watermark by default and mirrors the event at the top level', () => {
    const cache = recordRun(contextRoot, 'eod-digest', fakeRunEvent({ firedAt: '2026-07-25T18:00:00.000Z' }));
    expect(cache.lastFireAt).toBe('2026-07-25T18:00:00.000Z');
    expect(cache.status).toBe('ok');
    expect(cache.history).toHaveLength(1);
  });

  it('does NOT advance the watermark when advanceWatermark is false, but still records history and top-level status', () => {
    recordRun(contextRoot, 'eod-digest', fakeRunEvent({ firedAt: '2026-07-25T18:00:00.000Z' }));
    const cache = recordRun(
      contextRoot,
      'eod-digest',
      fakeRunEvent({ firedAt: '2026-07-25T18:00:00.000Z', status: 'blocked', error: 'not approved' }),
      { advanceWatermark: false },
    );
    expect(cache.lastFireAt).toBe('2026-07-25T18:00:00.000Z'); // unchanged from the prior advance
    expect(cache.status).toBe('blocked'); // top-level still mirrors the latest event
    expect(cache.error).toBe('not approved');
    expect(cache.history).toHaveLength(2);
  });

  it('leaves lastFireAt null when the FIRST recorded event does not advance the watermark', () => {
    const cache = recordRun(contextRoot, 'eod-digest', fakeRunEvent({ status: 'deferred' }), {
      advanceWatermark: false,
    });
    expect(cache.lastFireAt).toBeNull();
  });

  it('bounds history to HISTORY_LIMIT, newest first', () => {
    for (let i = 0; i < HISTORY_LIMIT + 5; i++) {
      recordRun(contextRoot, 'eod-digest', fakeRunEvent({ sessionId: `sess_${i}` }));
    }
    const cache = readAutomationCache(contextRoot, 'eod-digest')!;
    expect(cache.history).toHaveLength(HISTORY_LIMIT);
    expect(cache.history[0].sessionId).toBe(`sess_${HISTORY_LIMIT + 4}`); // most recent first
    expect(cache.history[HISTORY_LIMIT - 1].sessionId).toBe('sess_5'); // the oldest 5 dropped off
  });
});

// ─── run sidecar — content validation is the safety property ───────────────

describe('run sidecar — write/read/clear', () => {
  it('round-trips a valid sidecar', () => {
    writeRunSidecar(contextRoot, 'eod-digest', validSidecar({ slug: 'eod-digest' }));
    expect(readRunSidecar(contextRoot, 'eod-digest')).toEqual(validSidecar({ slug: 'eod-digest' }));
  });

  it('returns null for a missing sidecar', () => {
    expect(readRunSidecar(contextRoot, 'nope')).toBeNull();
  });

  it('clearRunSidecar is idempotent (safe whether or not one exists)', () => {
    expect(() => clearRunSidecar(contextRoot, 'nope')).not.toThrow();
    writeRunSidecar(contextRoot, 'eod-digest', validSidecar({ slug: 'eod-digest' }));
    clearRunSidecar(contextRoot, 'eod-digest');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
    expect(() => clearRunSidecar(contextRoot, 'eod-digest')).not.toThrow();
  });

  it('rejects a sidecar whose slug field does not match the requested slug', () => {
    writeRunSidecar(contextRoot, 'right-slug', validSidecar({ slug: 'wrong-slug' }));
    expect(readRunSidecar(contextRoot, 'right-slug')).toBeNull();
  });

  it('accepts a large-but-sane childPgid (sanity check alongside the rejection matrix below)', () => {
    writeRunSidecar(
      contextRoot,
      'eod-digest',
      validSidecar({ slug: 'eod-digest', childPgid: 99999, runnerPid: 88888 }),
    );
    expect(readRunSidecar(contextRoot, 'eod-digest')?.childPgid).toBe(99999);
  });
});

describe('readRunSidecar — childPgid content validation (load-bearing safety)', () => {
  // A corrupt/planted sidecar must be INERT, never a lethal negative-PID kill
  // target: on a failed spawn `child.pid` is `undefined`, which JSON.stringify
  // drops, and the value round-trips as `null` — `-null` is `-0`, which
  // `process.kill(-0, …)` resolves to the CALLER'S OWN PROCESS GROUP. `1`
  // negated is `-1`, which broadcasts to every process the caller may signal.
  // Every case below must produce `null` from readRunSidecar.

  function writeRawSidecarField(fieldJson: string): void {
    mkdirSync(join(automationsDir(contextRoot), 'cache'), { recursive: true });
    const path = sidecarPathFor(contextRoot, 'eod-digest');
    const text =
      '{"slug":"eod-digest","runnerPid":100,"childPid":200,' +
      fieldJson +
      ',"fireAt":"2026-07-25T18:00:00.000Z","startedAt":"2026-07-25T18:00:01.000Z","timeoutAt":"2026-07-25T18:15:01.000Z"}';
    writeFileSync(path, text, 'utf-8');
  }

  it('absent (key omitted entirely)', () => {
    mkdirSync(join(automationsDir(contextRoot), 'cache'), { recursive: true });
    writeFileSync(
      sidecarPathFor(contextRoot, 'eod-digest'),
      '{"slug":"eod-digest","runnerPid":100,"childPid":200,"fireAt":"2026-07-25T18:00:00.000Z","startedAt":"2026-07-25T18:00:01.000Z","timeoutAt":"2026-07-25T18:15:01.000Z"}',
      'utf-8',
    );
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('null — the exact "-null is -0, own process group" danger case', () => {
    writeRawSidecarField('"childPgid":null');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('0', () => {
    writeRawSidecarField('"childPgid":0');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('1 — negated is -1, "every process the caller may signal"', () => {
    writeRawSidecarField('"childPgid":1');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('-1', () => {
    writeRawSidecarField('"childPgid":-1');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('1.5 (non-integer)', () => {
    writeRawSidecarField('"childPgid":1.5');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('"123" (string, not a number)', () => {
    writeRawSidecarField('"childPgid":"123"');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('NaN — not valid JSON syntax; the outer parse failure alone must still yield null', () => {
    // `NaN` is not a JSON literal — JSON.parse throws SyntaxError here, which
    // readRunSidecar's own try/catch must turn into null, same as any other
    // corrupt file. This exercises that catch-all, not the field validator.
    writeRawSidecarField('"childPgid":NaN');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });

  it('Infinity — valid JSON (1e400 overflows to Infinity), exercising Number.isInteger directly', () => {
    // Unlike the bare `Infinity` token (invalid JSON syntax), `1e400` IS valid
    // JSON and parses to the JS value `Infinity`, so this genuinely reaches
    // the content validator rather than a parse-error shortcut.
    writeRawSidecarField('"childPgid":1e400');
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });
});

describe('readRunSidecar — runnerPid gets the same guard', () => {
  it('rejects a runnerPid of 1 (same broadcast danger, symmetric with childPgid)', () => {
    mkdirSync(join(automationsDir(contextRoot), 'cache'), { recursive: true });
    writeFileSync(
      sidecarPathFor(contextRoot, 'eod-digest'),
      '{"slug":"eod-digest","runnerPid":1,"childPid":200,"childPgid":200,"fireAt":"2026-07-25T18:00:00.000Z","startedAt":"2026-07-25T18:00:01.000Z","timeoutAt":"2026-07-25T18:15:01.000Z"}',
      'utf-8',
    );
    expect(readRunSidecar(contextRoot, 'eod-digest')).toBeNull();
  });
});

// ─── setAutomationShared — frontmatter only, NEVER touches .gitignore ───────

describe('setAutomationShared', () => {
  it('toggles the flag and persists it, leaving .gitignore byte-identical', () => {
    createAutomation(contextRoot, { slug: 'togglable', title: 'Togglable', days: 'daily', at: '18:00' });
    const before = readFileSync(join(contextRoot, '.gitignore'), 'utf-8');

    const shared = setAutomationShared(contextRoot, 'togglable', true);
    expect(shared.shared).toBe(true);
    expect(getAutomation(contextRoot, 'togglable')!.shared).toBe(true);
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).toBe(before); // untouched

    const unshared = setAutomationShared(contextRoot, 'togglable', false);
    expect(unshared.shared).toBe(false);
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).toBe(before); // still untouched
  });

  it('throws for a nonexistent automation', () => {
    expect(() => setAutomationShared(contextRoot, 'nope', true)).toThrow(AutomationError);
  });
});

// ─── shareStateFor — the five-state detector (order-aware, defence in depth) ─

describe('shareStateFor', () => {
  function appendToGitignore(...lines: string[]): void {
    const path = join(contextRoot, '.gitignore');
    const existing = existsSync(path) ? readFileSync(path, 'utf-8') : '';
    writeFileSync(path, `${existing}\n${lines.join('\n')}\n`, 'utf-8');
  }

  it('private: flag false, no negations anywhere, not tracked', () => {
    const m = createAutomation(contextRoot, { slug: 'p1', title: 'P1', days: 'daily', at: '18:00' });
    expect(shareStateFor(contextRoot, m, { gitTracked: () => [] })).toBe('private');
  });

  it('shared: flag true, and negations correctly appended AFTER the base wildcards', () => {
    const m = createAutomation(contextRoot, {
      slug: 's1', title: 'S1', days: 'daily', at: '18:00', shared: true,
    });
    appendToGitignore(...sharedSlugNegations('s1'));
    expect(shareStateFor(contextRoot, m, { gitTracked: () => [] })).toBe('shared');
  });

  it('drifted-flag-only: flag true but no negations were ever appended', () => {
    const m = createAutomation(contextRoot, {
      slug: 'd1', title: 'D1', days: 'daily', at: '18:00', shared: true,
    });
    expect(shareStateFor(contextRoot, m, { gitTracked: () => [] })).toBe('drifted-flag-only');
  });

  it('drifted-flag-only ALSO fires when the negation is present but positioned BEFORE its base wildcard (F2 — silently dropped by git)', () => {
    const m = createAutomation(contextRoot, {
      slug: 'd2', title: 'D2', days: 'daily', at: '18:00', shared: true,
    });
    // Overwrite with the negation ABOVE the wildcard it is meant to override —
    // the exact shape negationIsEffective exists to catch. Presence alone must
    // NOT be read as "shared".
    writeFileSync(
      join(contextRoot, '.gitignore'),
      [...sharedSlugNegations('d2'), 'automations/*.md'].join('\n') + '\n',
      'utf-8',
    );
    expect(shareStateFor(contextRoot, m, { gitTracked: () => [] })).toBe('drifted-flag-only');
  });

  it('drifted-ignore-only: flag false but effective negations are present — does NOT fail safe', () => {
    const m = createAutomation(contextRoot, { slug: 'd3', title: 'D3', days: 'daily', at: '18:00' });
    appendToGitignore(...sharedSlugNegations('d3'));
    expect(shareStateFor(contextRoot, m, { gitTracked: () => [] })).toBe('drifted-ignore-only');
  });

  it('tracked-despite-private: flag false, already tracked in git despite .gitignore (S1)', () => {
    const m = createAutomation(contextRoot, { slug: 't1', title: 'T1', days: 'daily', at: '18:00' });
    const fakeGitTracked: GitTrackedCheck = (_root, relPaths) =>
      relPaths.filter((p) => p === 'automations/t1.md');
    expect(shareStateFor(contextRoot, m, { gitTracked: fakeGitTracked })).toBe('tracked-despite-private');
  });

  it('tracked-despite-private takes priority over drifted-ignore-only (already-tracked is the more urgent fact)', () => {
    const m = createAutomation(contextRoot, { slug: 't2', title: 'T2', days: 'daily', at: '18:00' });
    appendToGitignore(...sharedSlugNegations('t2')); // would otherwise read as drifted-ignore-only
    const fakeGitTracked: GitTrackedCheck = (_root, relPaths) =>
      relPaths.filter((p) => p === 'automations/t2.md');
    expect(shareStateFor(contextRoot, m, { gitTracked: fakeGitTracked })).toBe('tracked-despite-private');
  });

  it('defaults to defaultGitTrackedCheck (a real `git ls-files`) when no override is passed', () => {
    execFileSync('git', ['init', '--quiet'], { cwd: projectRoot });
    const m = createAutomation(contextRoot, { slug: 'real-git', title: 'Real git', days: 'daily', at: '18:00' });
    // Never staged/committed — a fresh repo has nothing tracked yet.
    expect(shareStateFor(contextRoot, m)).toBe('private');
    expect(defaultGitTrackedCheck(contextRoot, ['automations/real-git.md'])).toEqual([]);
  });

  it('does not import sharing.ts (a same-wave sibling module) and does not import/call gitignoreCovers', () => {
    const source = readFileSync(join(__dirname, '../../src/lib/automations/store.ts'), 'utf-8');
    expect(source).not.toMatch(/from ['"][^'"]*sharing(\.js)?['"]/);
    // `gitignoreCovers` is named in a doc comment explaining why it must NOT
    // be used here — this asserts it is never actually IMPORTED or CALLED,
    // not merely absent as a string (a bare substring check would trip on
    // that very comment).
    expect(source).not.toMatch(/\bgitignoreCovers\s*\(/);
    expect(source).not.toMatch(/import\s*\{[^}]*\bgitignoreCovers\b[^}]*\}/);
  });
});

describe('review on the WRITE path', () => {
  it("defaults a new automation to review: 'off' — review is opted into, never inherited", () => {
    // Defaulting review ON would make every scheduled job a chore and train the
    // reflexive approval the gate exists to prevent. Written explicitly all the
    // same, so the field is discoverable in the manifest.
    const m = createAutomation(contextRoot, { slug: 'plain', title: 'Plain', days: 'daily', at: '18:00' });
    expect(m.review).toBe('off');
    // js-yaml QUOTES it on the way out (`review: 'off'`) — `off` is a YAML 1.1
    // boolean, and quoting is what keeps this a mode rather than a `false`. The
    // read side is safe either way (js-yaml 4 parses bare `off` as the string,
    // and anything non-mode degrades to 'off'), so the assertion admits both
    // forms rather than pinning a serializer detail.
    expect(readFileSync(m.path, 'utf-8')).toMatch(/^review: '?off'?$/m);
    expect(readAutomationFile(m.path).review).toBe('off');
  });

  it.each(['agent', 'output'] as const)('round-trips review: %s through create → read', (mode) => {
    const m = createAutomation(contextRoot, {
      slug: `gated-${mode}`, title: 'Gated', days: 'daily', at: '18:00', review: mode,
    });
    expect(readAutomationFile(m.path).review).toBe(mode);
  });

  it('REFUSES an invalid review mode on write, even though the read path degrades it', () => {
    // The asymmetry is the point: a typo already on disk must not wedge the
    // automation, but one being created must not silently become a gate the
    // owner believes they installed and did not.
    expect(() =>
      createAutomation(contextRoot, {
        slug: 'typo', title: 'Typo', days: 'daily', at: '18:00',
        review: 'agnet' as unknown as 'agent',
      }),
    ).toThrow(/Invalid review mode/);
  });

  it('ignores the question directory from the moment an automation can exist', () => {
    // A question holds a resumable session id — it must be uncommittable before
    // the directory can be created, the same ordering guarantee the lock and the
    // sidecar get. This asserted `automations/review/` until wave 9 replaced the
    // review card with the question store; the GUARANTEE is unchanged, only the
    // directory it covers.
    createAutomation(contextRoot, { slug: 'ignored', title: 'Ignored', days: 'daily', at: '18:00' });
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).toContain('automations/hitl/');
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('_dream_context/automations/hitl/');
  });

  it('no longer writes the stale review entry — S7, so the covered directory is the one that exists', () => {
    // `ensureGitignoreEntries` only ever APPENDS, so a line it stops emitting is
    // not a line it removes. Proving the new value is emitted alone is what makes
    // `removeGitignoreEntries` (runner.ts step 6) the only thing that has to clean
    // up the projects that already carry the old one.
    createAutomation(contextRoot, { slug: 'fresh', title: 'Fresh', days: 'daily', at: '18:00' });
    expect(readFileSync(join(contextRoot, '.gitignore'), 'utf-8')).not.toContain('automations/review/');
  });

  it('does not add review to the share-negation base set (it would false-alarm every negation)', () => {
    // See AUTOMATIONS_REVIEW_GITIGNORE_ENTRIES: negationIsEffective treats ANY
    // base entry appearing after a negation as having killed it, so a new base
    // wildcard appended to an existing .gitignore would report every share
    // negation as broken. Review has no shareable direction, so it stays out.
    expect(AUTOMATIONS_GITIGNORE_ENTRIES.some((e) => e.includes('review'))).toBe(false);
    expect(AUTOMATIONS_GITIGNORE_ENTRIES_ROOT.some((e) => e.includes('review'))).toBe(false);
  });

  it("reserves 'review' as a slug, like cache and output", () => {
    expect(() =>
      createAutomation(contextRoot, { slug: 'review', title: 'Review', days: 'daily', at: '18:00' }),
    ).toThrow(/reserved/i);
  });
});

// ─── The `## Flow` graph ─────────────────────────────────────────────────────
//
// The graph is approval-hashed, so the read has one rule above all others:
// degrade to ABSENT, never to a partial graph. A half-parsed graph hashes
// differently from both "no graph" and "the graph the author wrote", so a typo
// in a manifest would block the automation — and a blocked run tells nobody.

/** The `## Flow` section as it is actually written: fenced JSON. */
function flowSection(json: string): string {
  return ['## Flow', '', '```json', json, '```', ''].join('\n');
}

const VALID_FLOW = JSON.stringify({
  version: 'automation-flow/v1',
  nodes: [
    { id: 'trigger', kind: 'trigger', label: 'Every weekday 18:00', config: { source: 'schedule' } },
    { id: 'gather', kind: 'agent', label: "Read today's commits" },
    { id: 'ask', kind: 'hitl', label: 'Send the digest?' },
    { id: 'out', kind: 'report', label: 'Daily digest' },
  ],
  edges: [
    { from: 'trigger', to: 'gather' },
    { from: 'gather', to: 'ask' },
    { from: 'ask', to: 'out', label: 'send' },
  ],
});

describe('parseFlowSection', () => {
  it('reads a fenced JSON graph', () => {
    const flow = parseFlowSection(flowSection(VALID_FLOW));
    expect(flow).not.toBeNull();
    expect(flow!.nodes.map((n) => n.id)).toEqual(['trigger', 'gather', 'ask', 'out']);
    expect(flow!.edges).toHaveLength(3);
    expect(flow!.nodes[0].config).toEqual({ source: 'schedule' });
  });

  it('reads an UNFENCED graph too — a hand-edited manifest is still a manifest', () => {
    expect(parseFlowSection(['## Flow', '', VALID_FLOW, ''].join('\n'))).not.toBeNull();
  });

  it('reads a bare ``` fence with no language tag', () => {
    expect(parseFlowSection(['## Flow', '', '```', VALID_FLOW, '```'].join('\n'))).not.toBeNull();
  });

  it('tolerates an unclosed fence rather than losing the whole graph', () => {
    expect(parseFlowSection(['## Flow', '', '```json', VALID_FLOW].join('\n'))).not.toBeNull();
  });

  it.each([
    ['no section at all', '## Prompt\n\nDo the thing.\n'],
    ['an empty section', '## Flow\n\n'],
    ['an empty fence', flowSection('')],
    ['malformed JSON', flowSection('{ not json !!')],
    ['a bare array', flowSection('[]')],
    ['a future version', flowSection(JSON.stringify({ version: 'automation-flow/v2', nodes: [{ id: 'a', kind: 'agent' }], edges: [] }))],
    ['no version', flowSection(JSON.stringify({ nodes: [{ id: 'a', kind: 'agent' }], edges: [] }))],
    ['nodes: []', flowSection(JSON.stringify({ version: 'automation-flow/v1', nodes: [], edges: [] }))],
    ['nodes not an array', flowSection(JSON.stringify({ version: 'automation-flow/v1', nodes: {}, edges: [] }))],
    ['every node unusable', flowSection(JSON.stringify({ version: 'automation-flow/v1', nodes: [{ id: 'NOPE!' }], edges: [] }))],
  ])('%s ⇒ null, never a partial graph', (_label, content) => {
    expect(parseFlowSection(content)).toBeNull();
  });

  it('a FUTURE version reads as absent, so a newer manifest still runs here', () => {
    // Not an error and not a partial read: an automation authored by a newer
    // dreamcontext must keep working on this one, just without its diagram.
    const content = flowSection(JSON.stringify({ version: 'automation-flow/v9', nodes: [{ id: 'a', kind: 'agent' }], edges: [] }));
    expect(() => parseFlowSection(content)).not.toThrow();
    expect(parseFlowSection(content)).toBeNull();
  });

  it('drops an unusable node but keeps its usable siblings', () => {
    const flow = parseFlowSection(flowSection(JSON.stringify({
      version: 'automation-flow/v1',
      nodes: [
        { id: 'ok', kind: 'agent' },
        { id: 'Bad Id', kind: 'agent' },
        { id: 'nokind' },
        'not an object',
        { id: 'ok2', kind: 'report' },
      ],
      edges: [],
    })));
    expect(flow!.nodes.map((n) => n.id)).toEqual(['ok', 'ok2']);
  });

  it('keeps the FIRST of two nodes sharing an id — the later one is the accident', () => {
    const flow = parseFlowSection(flowSection(JSON.stringify({
      version: 'automation-flow/v1',
      nodes: [{ id: 'a', kind: 'agent', label: 'first' }, { id: 'a', kind: 'report', label: 'second' }],
      edges: [],
    })));
    expect(flow!.nodes).toHaveLength(1);
    expect(flow!.nodes[0].label).toBe('first');
  });

  it('drops an edge naming a node that does not exist — a wire from nowhere', () => {
    const flow = parseFlowSection(flowSection(JSON.stringify({
      version: 'automation-flow/v1',
      nodes: [{ id: 'a', kind: 'agent' }, { id: 'b', kind: 'report' }],
      edges: [{ from: 'a', to: 'b' }, { from: 'a', to: 'ghost' }, { from: 'ghost', to: 'b' }],
    })));
    expect(flow!.edges).toEqual([{ from: 'a', to: 'b' }]);
  });

  it('truncates an over-long label rather than dropping the node', () => {
    const flow = parseFlowSection(flowSection(JSON.stringify({
      version: 'automation-flow/v1',
      nodes: [{ id: 'a', kind: 'agent', label: 'x'.repeat(200) }],
      edges: [],
    })));
    expect(flow!.nodes[0].label!.length).toBe(80);
  });

  it('refuses a graph with more nodes than the cap', () => {
    const nodes = Array.from({ length: 25 }, (_, i) => ({ id: `n${i}`, kind: 'agent' }));
    expect(parseFlowSection(flowSection(JSON.stringify({ version: 'automation-flow/v1', nodes, edges: [] })))).toBeNull();
  });

  it('drops an empty config so two graphs that hash the same also READ the same', () => {
    const flow = parseFlowSection(flowSection(JSON.stringify({
      version: 'automation-flow/v1',
      nodes: [{ id: 'a', kind: 'agent', config: {} }],
      edges: [],
    })));
    expect(flow!.nodes[0].config).toBeUndefined();
  });

  it('stops at the next heading — a `## Flow` block cannot swallow the prompt', () => {
    const content = [flowSection(VALID_FLOW), '## Prompt', '', 'Do the thing.'].join('\n');
    expect(parseFlowSection(content)!.nodes).toHaveLength(4);
    expect(extractSection(content, 'Prompt')).toBe('Do the thing.');
  });
});

describe('flow on the manifest', () => {
  it('is null — NEVER undefined — when the manifest has no `## Flow`', () => {
    // The byte-identity guarantee: `canonicalApprovalPayload` omits the field
    // via `flow !== null`, which is TRUE for undefined, so an undefined leaking
    // out of the read would re-hash and block every legacy automation at once.
    const m = createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    expect(m.flow).toBeNull();
    expect(Object.prototype.hasOwnProperty.call(m, 'flow')).toBe(true);
  });

  it('round-trips a graph written with writeFlowSection', () => {
    createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    const graph = parseFlowSection(flowSection(VALID_FLOW))!;
    const updated = writeFlowSection(contextRoot, 'eod-digest', graph);
    expect(updated.flow).toEqual(graph);
    expect(getAutomation(contextRoot, 'eod-digest')!.flow).toEqual(graph);
  });

  it('writing a flow leaves the approval-hashed prompt byte-identical', () => {
    // `upsertSection` is surgical by contract, and this is the case that proves
    // it matters: rewriting the prompt while adding a diagram would block the
    // automation on its next run for a reason nobody could see.
    const m = createAutomation(contextRoot, {
      slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00',
      prompt: 'Line one.\n\n\nLine two after a real gap.',
    });
    const before = m.prompt;
    const after = writeFlowSection(contextRoot, 'eod-digest', parseFlowSection(flowSection(VALID_FLOW))!);
    expect(after.prompt).toBe(before);
  });

  it('replaces an existing flow rather than appending a second one', () => {
    createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    const graph = parseFlowSection(flowSection(VALID_FLOW))!;
    writeFlowSection(contextRoot, 'eod-digest', graph);
    const smaller = { ...graph, nodes: graph.nodes.slice(0, 2), edges: graph.edges.slice(0, 1) };
    const updated = writeFlowSection(contextRoot, 'eod-digest', smaller);
    expect(updated.flow!.nodes).toHaveLength(2);
    expect(readFileSync(automationPath(contextRoot, 'eod-digest'), 'utf-8').match(/^## Flow$/gm)).toHaveLength(1);
  });

  it('refuses to write a flow for an automation that does not exist', () => {
    expect(() => writeFlowSection(contextRoot, 'nope', parseFlowSection(flowSection(VALID_FLOW))!)).toThrow(/No such automation/);
  });
});

describe('deriveFlowFromManifest', () => {
  it('gives a flow-less automation the graph it already implies', () => {
    // Every automation IS a flow — fires, runs, maybe asks, writes. A manifest
    // written before the section existed simply never said so, and an empty
    // canvas would need explaining where a derived one does not.
    const m = createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD Digest', days: 'daily', at: '18:00' });
    const g = deriveFlowFromManifest(m);
    expect(g.nodes.map((n) => n.kind)).toEqual(['trigger', 'agent', 'report']);
    expect(g.nodes[0].label).toBe('every day at 18:00');
    expect(g.nodes[1].label).toBe('EOD Digest');
    expect(g.edges).toEqual([{ from: 'trigger', to: 'run' }, { from: 'run', to: 'report' }]);
  });

  it('draws a hitl node when the manifest asks for review, wired in between', () => {
    const m = createAutomation(contextRoot, {
      slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00', review: 'output',
    });
    const g = deriveFlowFromManifest(m);
    expect(g.nodes.map((n) => n.kind)).toEqual(['trigger', 'agent', 'hitl', 'report']);
    expect(g.edges).toEqual([
      { from: 'trigger', to: 'run' },
      { from: 'run', to: 'ask' },
      { from: 'ask', to: 'report' },
    ]);
  });

  it('is PURE and deterministic — the same manifest derives the same graph', () => {
    const m = createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    expect(JSON.stringify(deriveFlowFromManifest(m))).toBe(JSON.stringify(deriveFlowFromManifest(m)));
  });

  it('never throws on a manifest with no schedule', () => {
    const m = createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    const g = deriveFlowFromManifest({ ...m, schedule: null });
    expect(g.nodes[0].label).toBe('no schedule');
  });

  it('is NEVER written to disk — the manifest keeps flow: null and its approval', () => {
    // The derived graph is for DISPLAY. Persisting it would change the hash of
    // every legacy automation, which is precisely the outage the null case
    // exists to avoid.
    const m = createAutomation(contextRoot, { slug: 'eod-digest', title: 'EOD', days: 'daily', at: '18:00' });
    deriveFlowFromManifest(m);
    expect(getAutomation(contextRoot, 'eod-digest')!.flow).toBeNull();
    expect(readFileSync(automationPath(contextRoot, 'eod-digest'), 'utf-8')).not.toContain('## Flow');
  });
});
