import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  automationsRegistryPath,
  dispatcherHeartbeatPath,
  readAutomationsRegistry,
  writeAutomationsRegistry,
  registerProject,
  unregisterProject,
  listRegisteredProjects,
  canonicalApprovalPayload,
  manifestHash,
  approvalFields,
  checkApproval,
  approveAutomation,
  revokeApproval,
  getApproval,
  readDispatcherHeartbeat,
  recordTickStarted,
  recordTickCompleted,
  type AutomationsRegistry,
  type ApprovalEntry,
} from '../../src/lib/automations/registry.js';
import {
  EFFORT_LEVELS,
  APPROVAL_DIFF_FIELDS,
  AUTOMATIONS_GITIGNORE_ENTRIES,
  AUTOMATIONS_GITIGNORE_ENTRIES_ROOT,
  sharedSlugNegations,
  sharedSlugNegationsRoot,
  negationIsEffective,
  shareOrderingProblems,
  type AutomationManifest,
} from '../../src/lib/automations/types.js';

/** Fixed, injected — never Date.now() in assertions. */
const NOW = new Date('2026-07-25T18:00:00.000Z');
const LATER = new Date('2026-07-25T18:05:00.000Z');

let home: string;
const PROJECT_A = '/Users/tester/projects/alpha';
const PROJECT_B = '/Users/tester/projects/beta';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-automations-registry-'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** A minimal, valid AutomationManifest literal — no filesystem manifest needed
 *  (registry.ts is types-only, so this file never touches store.ts). */
function makeManifest(overrides: Partial<AutomationManifest> = {}): AutomationManifest {
  return {
    slug: 'eod-digest',
    id: 'auto_test1234',
    title: 'End of day digest',
    enabled: true,
    schedule: { days: 'daily', at: '18:00' },
    model: null,
    effort: null,
    timeoutMinutes: 15,
    catchupHours: 6,
    outputDir: null,
    shared: false,
    prompt: 'Summarize what happened today.',
    outputInstructions: '',
    path: '/tmp/whatever/_dream_context/automations/eod-digest.md',
    body: '## Prompt\n\nSummarize what happened today.\n',
    ...overrides,
  };
}

function tmpFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith('.tmp'));
}

// ─── Paths ───────────────────────────────────────────────────────────────────

describe('paths', () => {
  it('automationsRegistryPath is <home>/.dreamcontext/automations.json', () => {
    expect(automationsRegistryPath(home)).toBe(join(home, '.dreamcontext', 'automations.json'));
  });

  it('dispatcherHeartbeatPath is <home>/.dreamcontext/automations-tick.json — a DIFFERENT file', () => {
    expect(dispatcherHeartbeatPath(home)).toBe(join(home, '.dreamcontext', 'automations-tick.json'));
    expect(dispatcherHeartbeatPath(home)).not.toBe(automationsRegistryPath(home));
  });
});

// ─── readAutomationsRegistry — never throws, sanitizes ──────────────────────

describe('readAutomationsRegistry', () => {
  it('missing file ⇒ { projects: {} }', () => {
    expect(readAutomationsRegistry(home)).toEqual({ projects: {} });
  });

  it('never throws on unparseable JSON ⇒ { projects: {} }', () => {
    const p = automationsRegistryPath(home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(p, '{ not valid json !!', 'utf-8');
    expect(() => readAutomationsRegistry(home)).not.toThrow();
    expect(readAutomationsRegistry(home)).toEqual({ projects: {} });
  });

  it.each([
    ['a bare array', '[]'],
    ['a bare string', '"hello"'],
    ['a bare number', '42'],
    ['null', 'null'],
    ['an object with no projects key', '{}'],
    ['projects: null', '{"projects":null}'],
    ['projects: an array', '{"projects":[]}'],
  ])('%s ⇒ { projects: {} }, never throws', (_label, raw) => {
    const p = automationsRegistryPath(home);
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(p, raw, 'utf-8');
    expect(() => readAutomationsRegistry(home)).not.toThrow();
    expect(readAutomationsRegistry(home)).toEqual({ projects: {} });
  });

  it('drops a project whose approvals is not a plain object, keeps a valid sibling', () => {
    const good: ApprovalEntry = { manifestSha256: 'a'.repeat(64), approvedAt: NOW.toISOString(), payloadVersion: 'automation-approval/v1' };
    const raw: unknown = {
      projects: {
        [PROJECT_A]: { approvals: 'not-an-object' },
        [PROJECT_B]: { approvals: { slug1: good } },
      },
    };
    writeAutomationsRegistry(raw as AutomationsRegistry, home);
    const reg = readAutomationsRegistry(home);
    expect(reg.projects[PROJECT_A]).toBeUndefined();
    expect(reg.projects[PROJECT_B]).toEqual({ approvals: { slug1: good } });
  });

  it('drops a malformed approval entry, keeps a valid sibling slug', () => {
    const good: ApprovalEntry = { manifestSha256: 'b'.repeat(64), approvedAt: NOW.toISOString(), payloadVersion: 'automation-approval/v1' };
    const raw: unknown = {
      projects: {
        [PROJECT_A]: {
          approvals: {
            broken: { manifestSha256: '', approvedAt: NOW.toISOString(), payloadVersion: 'automation-approval/v1' }, // empty hash — invalid
            missingField: { manifestSha256: 'c'.repeat(64), approvedAt: NOW.toISOString() }, // no payloadVersion
            fine: good,
          },
        },
      },
    };
    writeAutomationsRegistry(raw as AutomationsRegistry, home);
    const reg = readAutomationsRegistry(home);
    expect(reg.projects[PROJECT_A].approvals).toEqual({ fine: good });
  });

  it('injected home fully isolates one registry from another', () => {
    const home2 = mkdtempSync(join(tmpdir(), 'dc-automations-registry-'));
    try {
      registerProject(PROJECT_A, home);
      expect(listRegisteredProjects(home)).toEqual([PROJECT_A]);
      expect(listRegisteredProjects(home2)).toEqual([]);
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});

// ─── writeAutomationsRegistry — atomic ───────────────────────────────────────

describe('writeAutomationsRegistry', () => {
  it('round-trips exactly what was written', () => {
    const reg: AutomationsRegistry = {
      projects: { [PROJECT_A]: { approvals: { slug1: { manifestSha256: 'd'.repeat(64), approvedAt: NOW.toISOString(), payloadVersion: 'automation-approval/v1' } } } },
    };
    writeAutomationsRegistry(reg, home);
    expect(readAutomationsRegistry(home)).toEqual(reg);
  });

  it('leaves no leftover .tmp file behind', () => {
    writeAutomationsRegistry({ projects: {} }, home);
    expect(tmpFilesIn(join(home, '.dreamcontext'))).toEqual([]);
  });
});

// ─── registerProject / unregisterProject / listRegisteredProjects ───────────

describe('project registration', () => {
  it('registerProject creates an empty approvals bucket', () => {
    registerProject(PROJECT_A, home);
    expect(readAutomationsRegistry(home).projects[PROJECT_A]).toEqual({ approvals: {} });
  });

  it('registerProject is idempotent — never clobbers existing approvals', () => {
    const m = makeManifest();
    approveAutomation(PROJECT_A, m, NOW, home);
    registerProject(PROJECT_A, home);
    expect(getApproval(PROJECT_A, m.slug, home)?.manifestSha256).toBe(manifestHash(m));
  });

  it('unregisterProject removes the project and returns true; false when absent', () => {
    registerProject(PROJECT_A, home);
    expect(unregisterProject(PROJECT_A, home)).toBe(true);
    expect(readAutomationsRegistry(home).projects[PROJECT_A]).toBeUndefined();
    expect(unregisterProject(PROJECT_A, home)).toBe(false);
  });

  it('listRegisteredProjects reflects current state', () => {
    registerProject(PROJECT_A, home);
    registerProject(PROJECT_B, home);
    expect(listRegisteredProjects(home).sort()).toEqual([PROJECT_A, PROJECT_B].sort());
  });
});

// ─── canonicalApprovalPayload / manifestHash — the tripwire's core claim ────

describe('canonicalApprovalPayload / manifestHash', () => {
  it('is stable across a CRLF vs LF difference in the prompt', () => {
    const a = makeManifest({ prompt: 'Line one\nLine two' });
    const b = makeManifest({ prompt: 'Line one\r\nLine two' });
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it('is stable across trailing blank lines in the prompt', () => {
    const a = makeManifest({ prompt: 'Do the thing.' });
    const b = makeManifest({ prompt: 'Do the thing.\n\n\n' });
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it('is stable across edits to fields that are NOT hashed (title/enabled/catchupHours/body — proxies for an updated_at bump, a YAML re-order, a Changelog append)', () => {
    const a = makeManifest({ title: 'Original title', enabled: true, catchupHours: 6, body: '## Prompt\n\noriginal body\n' });
    const b = makeManifest({ title: 'Retitled', enabled: false, catchupHours: 12, body: '## Prompt\n\noriginal body\n\n### Changelog\n- did a thing\n' });
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it('is stable across edits to `shared` (a visibility flag, never hashed — two machines may legitimately disagree about local publishing intent)', () => {
    const a = makeManifest({ shared: false });
    const b = makeManifest({ shared: true });
    expect(manifestHash(a)).toBe(manifestHash(b));
  });

  it.each([
    ['prompt', { prompt: 'a different prompt entirely' }],
    ['outputInstructions', { outputInstructions: 'save as a table' }],
    ['model', { model: 'opus' }],
    ['effort', { effort: 'high' }],
    ['timeoutMinutes', { timeoutMinutes: 30 }],
    ['outputDir', { outputDir: 'automations/output/custom' }],
  ] as const)('CHANGES when %s changes (the rest held constant)', (_field, override) => {
    const base = makeManifest();
    const changed = makeManifest(override as Partial<AutomationManifest>);
    expect(manifestHash(changed)).not.toBe(manifestHash(base));
  });

  it('embeds the payload version as a prefix distinct from the JSON body', () => {
    const payload = canonicalApprovalPayload(makeManifest());
    expect(payload.startsWith('automation-approval/v1\n')).toBe(true);
  });

  it('fixes key order regardless of override order (JSON.stringify preserves literal insertion order)', () => {
    const m = makeManifest();
    expect(canonicalApprovalPayload(m)).toContain('"prompt":"Summarize what happened today.","outputInstructions":"","model":null,"timeoutMinutes":15,"outputDir":null');
  });

  it('places a non-null effort between model and timeoutMinutes in the literal', () => {
    const m = makeManifest({ effort: 'high' });
    expect(canonicalApprovalPayload(m)).toContain('"model":null,"effort":"high","timeoutMinutes":15');
  });

  it('is BYTE-IDENTICAL to the pre-effort payload when effort is null — the null case is never gratuitously invalidated', () => {
    const m = makeManifest({ effort: null });
    const payload = canonicalApprovalPayload(m);
    expect(payload).toBe(
      'automation-approval/v1\n{"prompt":"Summarize what happened today.","outputInstructions":"","model":null,"timeoutMinutes":15,"outputDir":null}',
    );
    expect(payload).not.toContain('effort');
  });

  it('effort produces three distinct hashes across null / low / max', () => {
    const hashes = new Set([
      manifestHash(makeManifest({ effort: null })),
      manifestHash(makeManifest({ effort: 'low' })),
      manifestHash(makeManifest({ effort: 'max' })),
    ]);
    expect(hashes.size).toBe(3);
  });
});

describe('approvalFields', () => {
  it('returns exactly the raw (non-normalized) hashed fields', () => {
    const m = makeManifest({
      prompt: 'Raw\r\ntext\n\n',
      model: 'sonnet',
      effort: 'medium',
      timeoutMinutes: 20,
      outputDir: 'automations/output/x',
      outputInstructions: 'be terse',
    });
    expect(approvalFields(m)).toEqual({
      prompt: 'Raw\r\ntext\n\n',
      outputInstructions: 'be terse',
      model: 'sonnet',
      effort: 'medium',
      timeoutMinutes: 20,
      outputDir: 'automations/output/x',
    });
  });

  it('includes effort: null explicitly (unlike the hash payload, this shape is for display, not byte-identity)', () => {
    expect(approvalFields(makeManifest({ effort: null })).effort).toBeNull();
  });
});

describe('APPROVAL_DIFF_FIELDS', () => {
  it('is prompt/outputInstructions/model/effort/timeoutMinutes/outputDir, in that exact order', () => {
    expect(APPROVAL_DIFF_FIELDS).toEqual(['prompt', 'outputInstructions', 'model', 'effort', 'timeoutMinutes', 'outputDir']);
    expect(APPROVAL_DIFF_FIELDS.length).toBe(6);
  });
});

// ─── checkApproval / approveAutomation / revokeApproval / getApproval ───────

describe('checkApproval', () => {
  it('never-approved when nothing has been recorded', () => {
    const m = makeManifest();
    const verdict = checkApproval(PROJECT_A, m, home);
    expect(verdict).toEqual({ approved: false, reason: 'never-approved', expected: null, actual: manifestHash(m) });
  });

  it('approved: true immediately after approveAutomation, unchanged manifest', () => {
    const m = makeManifest();
    const entry = approveAutomation(PROJECT_A, m, NOW, home);
    expect(checkApproval(PROJECT_A, m, home)).toEqual({ approved: true, entry });
  });

  it('manifest-changed after editing any hashed field post-approval', () => {
    const m = makeManifest();
    approveAutomation(PROJECT_A, m, NOW, home);
    const edited = makeManifest({ timeoutMinutes: 60 }); // e.g. a teammate's synced edit
    const verdict = checkApproval(PROJECT_A, edited, home);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) {
      expect(verdict.reason).toBe('manifest-changed');
      expect(verdict.expected).toBe(manifestHash(m));
      expect(verdict.actual).toBe(manifestHash(edited));
    }
  });

  it('manifest-changed after editing effort specifically — not just the legacy fields', () => {
    const m = makeManifest({ effort: 'low' });
    approveAutomation(PROJECT_A, m, NOW, home);
    const edited = makeManifest({ effort: 'max' }); // e.g. a teammate cranking cost/autonomy on an approved prompt
    const verdict = checkApproval(PROJECT_A, edited, home);
    expect(verdict.approved).toBe(false);
    if (!verdict.approved) {
      expect(verdict.reason).toBe('manifest-changed');
      expect(verdict.expected).toBe(manifestHash(m));
      expect(verdict.actual).toBe(manifestHash(edited));
    }
  });

  it('is stable (stays approved) across a cosmetic-only edit post-approval', () => {
    const m = makeManifest();
    approveAutomation(PROJECT_A, m, NOW, home);
    const cosmetic = makeManifest({ title: 'New title', catchupHours: 24 });
    expect(checkApproval(PROJECT_A, cosmetic, home).approved).toBe(true);
  });

  it('payload-format-changed takes precedence over hash comparison — even when the stored hash would otherwise match', () => {
    const m = makeManifest();
    const trueHash = manifestHash(m);
    // Hand-construct a registry entry with the CURRENT correct hash but a STALE
    // payloadVersion, proving the version check runs before any hash comparison.
    writeAutomationsRegistry(
      { projects: { [PROJECT_A]: { approvals: { [m.slug]: { manifestSha256: trueHash, approvedAt: NOW.toISOString(), payloadVersion: 'automation-approval/v0' } } } } },
      home,
    );
    const verdict = checkApproval(PROJECT_A, m, home);
    expect(verdict).toEqual({ approved: false, reason: 'payload-format-changed', expected: trueHash, actual: trueHash });
  });
});

describe('approveAutomation / getApproval / revokeApproval', () => {
  it('approveAutomation records hash, timestamp, and the current payload version', () => {
    const m = makeManifest();
    const entry = approveAutomation(PROJECT_A, m, NOW, home);
    expect(entry).toEqual({ manifestSha256: manifestHash(m), approvedAt: NOW.toISOString(), payloadVersion: 'automation-approval/v1' });
    expect(getApproval(PROJECT_A, m.slug, home)).toEqual(entry);
  });

  it('getApproval returns null when absent', () => {
    expect(getApproval(PROJECT_A, 'nope', home)).toBeNull();
  });

  it('re-approving updates approvedAt/hash without disturbing a sibling slug', () => {
    const m1 = makeManifest({ slug: 'slug-one' });
    const m2 = makeManifest({ slug: 'slug-two' });
    approveAutomation(PROJECT_A, m1, NOW, home);
    approveAutomation(PROJECT_A, m2, NOW, home);
    const edited = makeManifest({ slug: 'slug-one', prompt: 'updated prompt' });
    approveAutomation(PROJECT_A, edited, LATER, home);
    expect(getApproval(PROJECT_A, 'slug-one', home)?.approvedAt).toBe(LATER.toISOString());
    expect(getApproval(PROJECT_A, 'slug-two', home)?.approvedAt).toBe(NOW.toISOString());
  });

  it('revokeApproval removes one slug, leaves the project and sibling approvals intact; false when absent', () => {
    const m1 = makeManifest({ slug: 'slug-one' });
    const m2 = makeManifest({ slug: 'slug-two' });
    approveAutomation(PROJECT_A, m1, NOW, home);
    approveAutomation(PROJECT_A, m2, NOW, home);
    expect(revokeApproval(PROJECT_A, 'slug-one', home)).toBe(true);
    expect(getApproval(PROJECT_A, 'slug-one', home)).toBeNull();
    expect(getApproval(PROJECT_A, 'slug-two', home)).not.toBeNull();
    expect(readAutomationsRegistry(home).projects[PROJECT_A]).toBeDefined(); // project entry survives
    expect(revokeApproval(PROJECT_A, 'slug-one', home)).toBe(false);
  });
});

// ─── Dispatcher heartbeat ────────────────────────────────────────────────────

describe('dispatcher heartbeat', () => {
  it('missing file ⇒ all null', () => {
    expect(readDispatcherHeartbeat(home)).toEqual({ lastTickStartedAt: null, lastTickCompletedAt: null, lastTickDurationMs: null });
  });

  it('never throws on unparseable JSON ⇒ all null', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(dispatcherHeartbeatPath(home), '{{{not json', 'utf-8');
    expect(() => readDispatcherHeartbeat(home)).not.toThrow();
    expect(readDispatcherHeartbeat(home)).toEqual({ lastTickStartedAt: null, lastTickCompletedAt: null, lastTickDurationMs: null });
  });

  it('sanitizes a wrong-typed field to null while keeping valid sibling fields', () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(
      dispatcherHeartbeatPath(home),
      JSON.stringify({ lastTickStartedAt: NOW.toISOString(), lastTickCompletedAt: 12345, lastTickDurationMs: 'oops' }),
      'utf-8',
    );
    expect(readDispatcherHeartbeat(home)).toEqual({ lastTickStartedAt: NOW.toISOString(), lastTickCompletedAt: null, lastTickDurationMs: null });
  });

  it('recordTickStarted sets only lastTickStartedAt', () => {
    recordTickStarted(NOW, home);
    expect(readDispatcherHeartbeat(home)).toEqual({ lastTickStartedAt: NOW.toISOString(), lastTickCompletedAt: null, lastTickDurationMs: null });
  });

  it('recordTickCompleted sets completion fields and preserves the prior start time', () => {
    recordTickStarted(NOW, home);
    recordTickCompleted(LATER, 4200, home);
    expect(readDispatcherHeartbeat(home)).toEqual({
      lastTickStartedAt: NOW.toISOString(),
      lastTickCompletedAt: LATER.toISOString(),
      lastTickDurationMs: 4200,
    });
  });

  it('leaves no leftover .tmp file behind', () => {
    recordTickStarted(NOW, home);
    recordTickCompleted(LATER, 100, home);
    expect(tmpFilesIn(join(home, '.dreamcontext'))).toEqual([]);
  });

  it('REGRESSION: a heartbeat write never touches automations.json — the race this design removes by construction', () => {
    const m = makeManifest();
    approveAutomation(PROJECT_A, m, NOW, home);
    const regPath = automationsRegistryPath(home);
    const before = readFileSync(regPath, 'utf-8');

    recordTickStarted(NOW, home);
    recordTickCompleted(LATER, 999, home);

    const after = readFileSync(regPath, 'utf-8');
    expect(after).toBe(before); // byte-for-byte unchanged
    expect(getApproval(PROJECT_A, m.slug, home)).not.toBeNull(); // and the approval is still there
  });

  it('injected home isolates the heartbeat the same way as the registry', () => {
    const home2 = mkdtempSync(join(tmpdir(), 'dc-automations-registry-'));
    try {
      recordTickStarted(NOW, home);
      expect(readDispatcherHeartbeat(home2)).toEqual({ lastTickStartedAt: null, lastTickCompletedAt: null, lastTickDurationMs: null });
    } finally {
      rmSync(home2, { recursive: true, force: true });
    }
  });
});

// ─── EFFORT_LEVELS ────────────────────────────────────────────────────────────

describe('EFFORT_LEVELS', () => {
  it('is exactly the effort levels the claude CLI accepts, in order', () => {
    expect(EFFORT_LEVELS).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
  });
});

// ─── AUTOMATIONS_GITIGNORE_ENTRIES — Change B private-by-default base block ─

describe('AUTOMATIONS_GITIGNORE_ENTRIES', () => {
  it('brain-relative entries include the private-by-default base block', () => {
    expect(AUTOMATIONS_GITIGNORE_ENTRIES).toEqual([
      'automations/cache/*.lock',
      'automations/cache/*.run.json',
      'automations/cache/*.run.json.tmp',
      'automations/*.md',
      'automations/cache/*.json',
      'automations/output/*/*',
    ]);
  });

  it('root-relative entries mirror the brain-relative ones, _dream_context/-prefixed', () => {
    expect(AUTOMATIONS_GITIGNORE_ENTRIES_ROOT).toEqual([
      '_dream_context/automations/cache/*.lock',
      '_dream_context/automations/cache/*.run.json',
      '_dream_context/automations/cache/*.run.json.tmp',
      '_dream_context/automations/*.md',
      '_dream_context/automations/cache/*.json',
      '_dream_context/automations/output/*/*',
    ]);
  });
});

// ─── sharedSlugNegations / sharedSlugNegationsRoot ──────────────────────────

describe('sharedSlugNegations / sharedSlugNegationsRoot', () => {
  it('produces the three negation lines, brain-relative', () => {
    expect(sharedSlugNegations('eod-digest')).toEqual([
      '!automations/eod-digest.md',
      '!automations/cache/eod-digest.json',
      '!automations/output/eod-digest/*',
    ]);
  });

  it('produces the three negation lines, project-root-relative', () => {
    expect(sharedSlugNegationsRoot('eod-digest')).toEqual([
      '!_dream_context/automations/eod-digest.md',
      '!_dream_context/automations/cache/eod-digest.json',
      '!_dream_context/automations/output/eod-digest/*',
    ]);
  });
});

// ─── negationIsEffective / shareOrderingProblems — the F2 predicate ────────

describe('negationIsEffective / shareOrderingProblems', () => {
  const BASE = AUTOMATIONS_GITIGNORE_ENTRIES_ROOT;
  const NEG = '!_dream_context/automations/shared-one.md';

  it('returns false when the negation is placed ABOVE its wildcard (silently dropped by git)', () => {
    const text = [NEG, ...BASE].join('\n');
    expect(negationIsEffective(text, NEG, BASE)).toBe(false);
  });

  it('returns true when the negation is placed BELOW the full base block', () => {
    const text = [...BASE, NEG].join('\n');
    expect(negationIsEffective(text, NEG, BASE)).toBe(true);
  });

  it('returns false when the negation is absent entirely', () => {
    const text = BASE.join('\n');
    expect(negationIsEffective(text, NEG, BASE)).toBe(false);
  });

  it('ignores comments and blank lines when locating order (still misordered)', () => {
    const text = ['# a comment', '', NEG, '', ...BASE].join('\n');
    expect(negationIsEffective(text, NEG, BASE)).toBe(false);
  });

  it('ignores comments and blank lines when locating order (still well-formed)', () => {
    const text = ['# a comment', '', ...BASE, '', NEG].join('\n');
    expect(negationIsEffective(text, NEG, BASE)).toBe(true);
  });

  it('shareOrderingProblems is empty for a well-formed file (base block, then negation)', () => {
    const text = [...BASE, NEG].join('\n');
    expect(shareOrderingProblems(text, BASE)).toEqual([]);
  });

  it('shareOrderingProblems reports the misordered negation (non-empty)', () => {
    const text = [NEG, ...BASE].join('\n');
    const problems = shareOrderingProblems(text, BASE);
    expect(problems.length).toBe(1);
    expect(problems[0]).toContain(NEG);
  });

  it('shareOrderingProblems ignores negations outside the automations namespace (no false positive)', () => {
    // A misplaced, UNRELATED negation (e.g. Lab's credentials example) must
    // never be reported as an automations ordering problem.
    const text = ['!lab/credentials.example.json', ...BASE].join('\n');
    expect(shareOrderingProblems(text, BASE)).toEqual([]);
  });

  it('shareOrderingProblems returns empty for an empty gitignore', () => {
    expect(shareOrderingProblems('', BASE)).toEqual([]);
  });
});
