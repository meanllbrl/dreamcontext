import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkTheses } from '../../src/cli/commands/doctor.js';
import { createThesis, addEvidence } from '../../src/lib/theses/store.js';

let projectRoot: string;
let root: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-theses-doctor-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('checkTheses — silent when disabled and never used', () => {
  it('returns [] when the layer is disabled (default, no config) and theses/ does not exist', () => {
    expect(checkTheses(root)).toEqual([]);
  });
});

describe('checkTheses — ok summary', () => {
  it('reports ok with the thesis count when everything is clean', () => {
    createThesis(root, {
      claim: 'Compressing memories improves recall',
      predictions: ['Recall@3 improves by 5%'],
      open: true,
    });
    addEvidence(root, 'compressing-memories-improves-recall', {
      verdict: 'supports',
      source: 'insight',
      note: 'wau up',
    });

    const results = checkTheses(root);
    expect(results).toEqual([{ name: 'Theses', status: 'ok', message: expect.stringContaining('1 thesis') }]);
  });
});

describe('checkTheses — WARN branches', () => {
  it('WARNS on a dangling linked insight', () => {
    createThesis(root, { claim: 'Test claim' });
    const path = join(root, 'theses', 'test-claim.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('insights: []', 'insights:\n  - does-not-exist'), 'utf-8');

    const results = checkTheses(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('does-not-exist'))).toBe(true);
  });

  it('WARNS on a raw status outside the enum (never coerced silently)', () => {
    createThesis(root, { claim: 'Test claim' });
    const path = join(root, 'theses', 'test-claim.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('status: draft', 'status: bogus'), 'utf-8');

    const results = checkTheses(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('bogus'))).toBe(true);
  });

  it('WARNS when persisted confidence drifts from the evidence-derived value', () => {
    createThesis(root, { claim: 'Test claim', predictions: ['pred'], open: true });
    addEvidence(root, 'test-claim', { verdict: 'supports', source: 'insight' });
    const path = join(root, 'theses', 'test-claim.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace(/confidence: [\d.]+/, 'confidence: 0.01'), 'utf-8');

    const results = checkTheses(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('drifted'))).toBe(true);
  });

  it('WARNS when status is open with zero pre-registered predictions', () => {
    createThesis(root, { claim: 'Test claim' }); // draft, no predictions
    const path = join(root, 'theses', 'test-claim.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('status: draft', 'status: open'), 'utf-8');

    const results = checkTheses(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('zero pre-registered predictions'))).toBe(true);
  });

  it('WARNS when blocked_on_instrumentation is set without a blocked_metric', () => {
    createThesis(root, { claim: 'Test claim' });
    const path = join(root, 'theses', 'test-claim.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('blocked_on_instrumentation: false', 'blocked_on_instrumentation: true'), 'utf-8');

    const results = checkTheses(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('blocked_metric'))).toBe(true);
  });

  it('never reports status "error" for a malformed thesis file', () => {
    mkdirSync(join(root, 'theses'), { recursive: true });
    writeFileSync(
      join(root, 'theses', 'broken.md'),
      '---\nclaim: broken\nstatus: nonsense\nkind: nonsense\nevidence:\n  - verdict: maybe\n    source: mystery\n---\n',
      'utf-8',
    );

    const results = checkTheses(root);
    expect(results.every((r) => r.status !== 'error')).toBe(true);
  });
});
