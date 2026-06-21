import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  classifyBrain,
  isUntouchedTemplateCore,
  knowledgeIsEmpty,
  featuresAreZero,
  hasProjectSignal,
  detectMigrateIntent,
  detectIngestIntent,
  extractCandidatePaths,
  detectSessionStartTrigger,
  detectPromptTrigger,
  renderOffer,
  MASS_SOURCE_MIN_DOCS,
  type InitTrigger,
} from '../../src/lib/initializer-detect.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeTmpDir(): string {
  const dir = join(tmpdir(), `ac-init-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// Stub core files exactly as `dreamcontext init` writes them (tokens replaced, but
// the parenthetical template placeholder prose still present).
const STUB_SOUL = [
  '---', 'name: "myproj"', 'type: soul', '---', '',
  '## Core Principles', '', "- (Add your project's guiding principles here)", '',
  '## Constraints', '', '- (Add known constraints, limitations, or non-negotiables)', '',
  '## Agent Behaviors & Rules', '', '- (Project-specific behaviors: "Always run tests before committing")',
].join('\n');
const STUB_USER = [
  '---', 'name: user-preferences', 'type: user', '---', '',
  '## User Preferences', '', '- (Decision-making patterns, priorities, review preferences)', '',
  '## Communication Style', '', '- (How the user prefers to interact: concise? detailed? technical?)',
].join('\n');
const STUB_MEMORY = [
  '---', 'name: active-decisions', 'type: memory', '---', '',
  '## Technical Decisions', '', '- (Key technical choices and their rationale)', '',
  '## Known Issues', '', '- (Open issues and their status)',
].join('\n');

/** A `_dream_context/` that is the untouched init shell. Returns the ctx path. */
function buildSparseBrain(root: string): string {
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'knowledge', 'data-structures'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(join(ctx, 'core', '0.soul.md'), STUB_SOUL);
  writeFileSync(join(ctx, 'core', '1.user.md'), STUB_USER);
  writeFileSync(join(ctx, 'core', '2.memory.md'), STUB_MEMORY);
  // init seeds a data-structures stub — must NOT count as authored knowledge.
  writeFileSync(
    join(ctx, 'knowledge', 'data-structures', 'default.md'),
    'Document schemas, models, and API contracts here.',
  );
  return ctx;
}

/** A genuinely-started brain (real soul + a feature + a knowledge file). */
function buildHealthyBrain(root: string): string {
  const ctx = join(root, '_dream_context');
  mkdirSync(join(ctx, 'core', 'features'), { recursive: true });
  mkdirSync(join(ctx, 'knowledge'), { recursive: true });
  mkdirSync(join(ctx, 'state'), { recursive: true });
  writeFileSync(
    join(ctx, 'core', '0.soul.md'),
    '---\nname: myproj\ntype: soul\n---\n## Project Identity\nA real shipped project.\n## Core Principles\n- Ship small.',
  );
  writeFileSync(join(ctx, 'core', 'features', 'login.md'), '---\nstatus: active\n---\n## Why\nUsers log in.');
  writeFileSync(join(ctx, 'knowledge', 'architecture.md'), '---\nname: arch\ndescription: arch\n---\n# Arch\nReal.');
  return ctx;
}

// ─── classifyBrain ──────────────────────────────────────────────────────────────

describe('classifyBrain', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('returns "missing" for a null root', () => {
    expect(classifyBrain(null)).toBe('missing');
  });

  it('returns "sparse" for the untouched init shell', () => {
    const ctx = buildSparseBrain(tmp);
    expect(classifyBrain(ctx)).toBe('sparse');
  });

  it('returns "healthy" for a started brain', () => {
    const ctx = buildHealthyBrain(tmp);
    expect(classifyBrain(ctx)).toBe('healthy');
  });

  it('a real soul alone flips sparse → healthy (untouched-core signal lost)', () => {
    const ctx = buildSparseBrain(tmp);
    writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: x\n---\n## Identity\nReal identity prose, not a stub.');
    writeFileSync(join(ctx, 'core', '1.user.md'), '---\nname: u\n---\n## Preferences\nReal prefs, not a stub.');
    expect(classifyBrain(ctx)).toBe('healthy');
  });

  it('a single authored knowledge file flips sparse → healthy', () => {
    const ctx = buildSparseBrain(tmp);
    writeFileSync(join(ctx, 'knowledge', 'decision-x.md'), '---\nname: d\n---\n# Decision\nReal.');
    expect(classifyBrain(ctx)).toBe('healthy');
  });

  it('a single feature flips sparse → healthy', () => {
    const ctx = buildSparseBrain(tmp);
    writeFileSync(join(ctx, 'core', 'features', 'f.md'), '---\nstatus: planning\n---\n## Why\nReal.');
    expect(classifyBrain(ctx)).toBe('healthy');
  });
});

// ─── sub-signals ─────────────────────────────────────────────────────────────

describe('isUntouchedTemplateCore', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('true when ≥2 core files carry template placeholder prose', () => {
    const ctx = buildSparseBrain(tmp);
    expect(isUntouchedTemplateCore(ctx)).toBe(true);
  });

  it('true when any core file has an unreplaced {{TOKEN}}', () => {
    const ctx = join(tmp, '_dream_context');
    mkdirSync(join(ctx, 'core'), { recursive: true });
    writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "{{PROJECT_NAME}}"\n---\nbody');
    writeFileSync(join(ctx, 'core', '1.user.md'), '---\nname: u\n---\nreal user content here');
    expect(isUntouchedTemplateCore(ctx)).toBe(true);
  });

  it('false when only one core file is a stub (the rest authored)', () => {
    const ctx = buildSparseBrain(tmp);
    writeFileSync(join(ctx, 'core', '1.user.md'), '---\nname: u\n---\nReal authored prefs.');
    writeFileSync(join(ctx, 'core', '2.memory.md'), '---\nname: m\n---\nReal authored memory.');
    expect(isUntouchedTemplateCore(ctx)).toBe(false);
  });

  it('false when core files are absent', () => {
    const ctx = join(tmp, '_dream_context');
    mkdirSync(ctx, { recursive: true });
    expect(isUntouchedTemplateCore(ctx)).toBe(false);
  });
});

describe('knowledgeIsEmpty', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('true when only the data-structures stub exists', () => {
    const ctx = buildSparseBrain(tmp);
    expect(knowledgeIsEmpty(ctx)).toBe(true);
  });

  it('true when the knowledge dir is absent', () => {
    const ctx = join(tmp, '_dream_context');
    mkdirSync(ctx, { recursive: true });
    expect(knowledgeIsEmpty(ctx)).toBe(true);
  });

  it('false when a top-level authored knowledge file exists', () => {
    const ctx = buildSparseBrain(tmp);
    writeFileSync(join(ctx, 'knowledge', 'x.md'), '# X');
    expect(knowledgeIsEmpty(ctx)).toBe(false);
  });

  it('false when a foldered authored knowledge file exists', () => {
    const ctx = buildSparseBrain(tmp);
    mkdirSync(join(ctx, 'knowledge', 'architecture'), { recursive: true });
    writeFileSync(join(ctx, 'knowledge', 'architecture', 'x.md'), '# X');
    expect(knowledgeIsEmpty(ctx)).toBe(false);
  });

  it('ignores products/ and .archive/ stubs', () => {
    const ctx = buildSparseBrain(tmp);
    mkdirSync(join(ctx, 'knowledge', 'products'), { recursive: true });
    mkdirSync(join(ctx, 'knowledge', '.archive'), { recursive: true });
    writeFileSync(join(ctx, 'knowledge', 'products', 'web.md'), '# web stub');
    writeFileSync(join(ctx, 'knowledge', '.archive', 'old.md'), '# archived');
    expect(knowledgeIsEmpty(ctx)).toBe(true);
  });
});

describe('featuresAreZero', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('true for an empty features dir', () => {
    const ctx = buildSparseBrain(tmp);
    expect(featuresAreZero(ctx)).toBe(true);
  });

  it('true when the features dir is absent', () => {
    const ctx = join(tmp, '_dream_context');
    mkdirSync(ctx, { recursive: true });
    expect(featuresAreZero(ctx)).toBe(true);
  });

  it('false when a feature file exists', () => {
    const ctx = buildSparseBrain(tmp);
    writeFileSync(join(ctx, 'core', 'features', 'f.md'), '---\nstatus: active\n---\nWhy');
    expect(featuresAreZero(ctx)).toBe(false);
  });
});

// ─── hasProjectSignal ──────────────────────────────────────────────────────────

describe('hasProjectSignal', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('false for an empty directory', () => {
    expect(hasProjectSignal(tmp)).toBe(false);
  });

  it('true when a .git dir is present', () => {
    mkdirSync(join(tmp, '.git'), { recursive: true });
    expect(hasProjectSignal(tmp)).toBe(true);
  });

  it('true when a package.json is present', () => {
    writeFileSync(join(tmp, 'package.json'), '{}');
    expect(hasProjectSignal(tmp)).toBe(true);
  });

  it('true when a docs/ dir is present', () => {
    mkdirSync(join(tmp, 'docs'), { recursive: true });
    expect(hasProjectSignal(tmp)).toBe(true);
  });

  it('true when a README.md is present', () => {
    writeFileSync(join(tmp, 'README.md'), '# hi');
    expect(hasProjectSignal(tmp)).toBe(true);
  });
});

// ─── intent detection ──────────────────────────────────────────────────────────

describe('detectMigrateIntent', () => {
  it('matches migration phrasing', () => {
    for (const p of [
      'please migrate my old project',
      'I want to move my notes over to this repo',
      'can you bring this over into the brain',
      'switch from my previous setup',
      'this is coming from my old project',
      'port over my existing docs',
    ]) {
      expect(detectMigrateIntent(p)).toBe(true);
    }
  });

  it('does not match ordinary prompts', () => {
    for (const p of ['fix the login bug', 'add a new endpoint', 'refactor the parser']) {
      expect(detectMigrateIntent(p)).toBe(false);
    }
  });
});

describe('detectIngestIntent', () => {
  it('matches ingestion phrasing', () => {
    for (const p of [
      'ingest my docs folder',
      'please onboard these notes',
      'load the wiki into context',
      'set up dreamcontext from ./docs',
      'bootstrap the brain from this folder',
    ]) {
      expect(detectIngestIntent(p)).toBe(true);
    }
  });

  it('does not match ordinary prompts', () => {
    for (const p of ['run the tests', 'open the dashboard', 'show me the status']) {
      expect(detectIngestIntent(p)).toBe(false);
    }
  });
});

// ─── extractCandidatePaths ─────────────────────────────────────────────────────

describe('extractCandidatePaths', () => {
  it('extracts quoted, relative, absolute, and tilde paths', () => {
    const got = extractCandidatePaths('ingest "./my docs" and ../old and /Users/x/notes and ~/wiki please');
    expect(got).toContain('./my docs');
    expect(got).toContain('../old');
    expect(got).toContain('/Users/x/notes');
    expect(got).toContain('~/wiki');
  });

  it('extracts slash-bearing bare tokens', () => {
    const got = extractCandidatePaths('look at docs/architecture and src/lib');
    expect(got).toContain('docs/architecture');
    expect(got).toContain('src/lib');
  });

  it('extracts bare known-source words', () => {
    const got = extractCandidatePaths('please ingest the docs and the wiki');
    expect(got).toContain('docs');
    expect(got).toContain('wiki');
  });

  it('ignores ordinary words with no path shape', () => {
    const got = extractCandidatePaths('fix the bug and run the tests now');
    expect(got).toEqual([]);
  });

  it('returns [] for non-string input', () => {
    // @ts-expect-error testing defensive path
    expect(extractCandidatePaths(null)).toEqual([]);
  });
});

// ─── detectSessionStartTrigger ─────────────────────────────────────────────────

describe('detectSessionStartTrigger', () => {
  let tmp: string;
  beforeEach(() => { tmp = makeTmpDir(); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('no-brain when root is null and cwd is a real project', () => {
    writeFileSync(join(tmp, 'package.json'), '{}');
    expect(detectSessionStartTrigger(tmp, null)).toEqual({ condition: 'no-brain' });
  });

  it('silent when root is null and cwd is an empty dir', () => {
    expect(detectSessionStartTrigger(tmp, null)).toBeNull();
  });

  it('sparse-brain for the untouched init shell', () => {
    const ctx = buildSparseBrain(tmp);
    expect(detectSessionStartTrigger(tmp, ctx)).toEqual({ condition: 'sparse-brain' });
  });

  it('silent for a healthy brain', () => {
    const ctx = buildHealthyBrain(tmp);
    expect(detectSessionStartTrigger(tmp, ctx)).toBeNull();
  });
});

// ─── detectPromptTrigger ───────────────────────────────────────────────────────

describe('detectPromptTrigger', () => {
  let proj: string;     // cwd (project root)
  let ctx: string;      // healthy _dream_context
  let externalRoot: string;

  beforeEach(() => {
    proj = makeTmpDir();
    ctx = buildHealthyBrain(proj);
    externalRoot = makeTmpDir();
  });
  afterEach(() => {
    rmSync(proj, { recursive: true, force: true });
    rmSync(externalRoot, { recursive: true, force: true });
  });

  it('fires migrate-from-folder for an existing Obsidian/notes corpus', () => {
    const notes = join(externalRoot, 'mynotes');
    mkdirSync(join(notes, '.obsidian'), { recursive: true });
    writeFileSync(join(notes, 'n.md'), '# note');
    const t = detectPromptTrigger(`migrate my notes from ${notes} into this project`, { cwd: proj, root: ctx });
    expect(t?.condition).toBe('migrate-from-folder');
    expect(t?.path).toBe(notes);
  });

  it('fires migrate-from-folder for a folder that contains a _dream_context', () => {
    const old = join(externalRoot, 'oldproj');
    mkdirSync(join(old, '_dream_context', 'core'), { recursive: true });
    writeFileSync(join(old, '_dream_context', 'core', '0.soul.md'), 'old');
    const t = detectPromptTrigger(`please move the brain from ${old} over to here`, { cwd: proj, root: ctx });
    expect(t?.condition).toBe('migrate-from-folder');
  });

  it('fires mass-new-source for a sizable docs folder into a healthy brain', () => {
    const docs = join(proj, 'docs');
    mkdirSync(docs, { recursive: true });
    for (let i = 0; i < MASS_SOURCE_MIN_DOCS + 1; i++) writeFileSync(join(docs, `d${i}.md`), `# ${i}`);
    const t = detectPromptTrigger('please ingest ./docs into the brain', { cwd: proj, root: ctx });
    expect(t?.condition).toBe('mass-new-source');
    expect(t?.docCount).toBeGreaterThanOrEqual(MASS_SOURCE_MIN_DOCS);
  });

  it('migrate takes priority over mass when both could match', () => {
    const notes = join(externalRoot, 'team-notes');
    mkdirSync(notes, { recursive: true });
    for (let i = 0; i < MASS_SOURCE_MIN_DOCS + 1; i++) writeFileSync(join(notes, `d${i}.md`), `# ${i}`);
    const t = detectPromptTrigger(`ingest the notes from ${notes}`, { cwd: proj, root: ctx });
    expect(t?.condition).toBe('migrate-from-folder');
  });

  it('silent when there is intent but no existing path', () => {
    expect(detectPromptTrigger('please ingest all of my documentation now', { cwd: proj, root: ctx })).toBeNull();
  });

  it('silent when there is a path but no intent', () => {
    const docs = join(proj, 'docs');
    mkdirSync(docs, { recursive: true });
    for (let i = 0; i < MASS_SOURCE_MIN_DOCS + 1; i++) writeFileSync(join(docs, `d${i}.md`), `# ${i}`);
    expect(detectPromptTrigger('summarize the files in ./docs for me', { cwd: proj, root: ctx })).toBeNull();
  });

  it('silent for a normal coding prompt that references a code path', () => {
    expect(detectPromptTrigger('fix the bug in src/lib/recall.ts and run tests', { cwd: proj, root: ctx })).toBeNull();
  });

  it('does not treat the project root / own brain as a source', () => {
    // Intent + a path pointing at the project itself must not fire.
    expect(detectPromptTrigger(`ingest everything from ${proj}`, { cwd: proj, root: ctx })).toBeNull();
  });

  it('mass-new-source requires a healthy brain (sparse → silent)', () => {
    const sparseProj = makeTmpDir();
    const sparseCtx = buildSparseBrain(sparseProj);
    const docs = join(sparseProj, 'docs');
    mkdirSync(docs, { recursive: true });
    for (let i = 0; i < MASS_SOURCE_MIN_DOCS + 1; i++) writeFileSync(join(docs, `d${i}.md`), `# ${i}`);
    expect(detectPromptTrigger('ingest ./docs into the brain', { cwd: sparseProj, root: sparseCtx })).toBeNull();
    rmSync(sparseProj, { recursive: true, force: true });
  });

  it('a small docs folder is not "mass"', () => {
    const docs = join(proj, 'tiny');
    mkdirSync(docs, { recursive: true });
    writeFileSync(join(docs, 'only.md'), '# one');
    expect(detectPromptTrigger('ingest ./tiny into the brain', { cwd: proj, root: ctx })).toBeNull();
  });

  it('returns null for a too-short prompt', () => {
    expect(detectPromptTrigger('go', { cwd: proj, root: ctx })).toBeNull();
  });
});

// ─── renderOffer ───────────────────────────────────────────────────────────────

describe('renderOffer', () => {
  it('no-brain offer names the initializer and the missing brain', () => {
    const out = renderOffer({ condition: 'no-brain' });
    expect(out).toContain('no brain here yet');
    expect(out).toContain('`initializer` skill');
  });

  it('sparse offer names the initializer and the stub state', () => {
    const out = renderOffer({ condition: 'sparse-brain' });
    expect(out).toContain('sparse/unstarted');
    expect(out).toContain('`initializer` skill');
  });

  it('migrate offer includes the path and MIGRATE framing', () => {
    const out = renderOffer({ condition: 'migrate-from-folder', path: '/x/notes' });
    expect(out).toContain('/x/notes');
    expect(out).toContain('MIGRATE');
    expect(out).toContain('`initializer` skill');
  });

  it('mass offer includes the path and doc count', () => {
    const out = renderOffer({ condition: 'mass-new-source', path: '/x/docs', docCount: 42 });
    expect(out).toContain('/x/docs');
    expect(out).toContain('42 docs');
    expect(out).toContain('`initializer` skill');
  });
});

// ─── robustness (never throws) ─────────────────────────────────────────────────

describe('detection is total (never throws)', () => {
  it('handles a non-existent root', () => {
    expect(() => classifyBrain('/no/such/path/_dream_context')).not.toThrow();
    expect(classifyBrain('/no/such/path/_dream_context')).toBe('healthy'); // uncertain → never nag
  });

  it('handles garbage prompts', () => {
    const bad: InitTrigger | null = detectPromptTrigger('  "" `` //// ~~~', {
      cwd: '/no/such/cwd',
      root: null,
    });
    expect(bad).toBeNull();
  });

  it('handles a null root in detectPromptTrigger without throwing', () => {
    expect(() => detectPromptTrigger('migrate from /x/y', { cwd: '/tmp', root: null })).not.toThrow();
  });
});
