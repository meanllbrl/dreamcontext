import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkLab } from '../../src/cli/commands/doctor.js';
import { createInsight } from '../../src/lib/lab/store.js';
import { createObjective } from '../../src/lib/objectives-store.js';
import { writeCredential } from '../../src/lib/lab/credentials.js';

let projectRoot: string;
let root: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-lab-doctor-'));
  root = join(projectRoot, '_dream_context');
  mkdirSync(join(root, 'core'), { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('checkLab — silent when empty', () => {
  it('returns [] when lab/insights/ is empty and no credentials.json exists', () => {
    expect(checkLab(root)).toEqual([]);
  });
});

describe('checkLab — credentials coverage FAIL (self-heal net)', () => {
  it('FAILS when lab/credentials.json exists but is not covered by the mode-appropriate .gitignore', () => {
    // Simulate a pre-Lab brain repo: hand-place credentials.json with no gitignore
    // coverage at all (bypassing writeCredential's own ordering).
    mkdirSync(join(root, 'lab'), { recursive: true });
    writeFileSync(join(root, 'lab', 'credentials.json'), '{"key":"secret"}', 'utf-8');
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'error')).toBe(true);
  });

  it('does NOT fail when credentials.json was written via writeCredential (properly covered)', () => {
    writeCredential(projectRoot, root, 'apiKey', 'sk-test');
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'error')).toBe(false);
  });
});

describe('checkLab — WARN branches', () => {
  it('WARNS when a manifest credentials_used key is absent from credentials.json', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const path = join(root, 'lab', 'insights', 'wau.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('credentials_used: []', 'credentials_used:\n  - apiKey'), 'utf-8');

    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('apiKey'))).toBe(true);
  });

  it('WARNS when binding.objective does not resolve', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const path = join(root, 'lab', 'insights', 'wau.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('binding: null', 'binding:\n  objective: does-not-exist\n  value: latest'), 'utf-8');

    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('does-not-exist'))).toBe(true);
  });

  it('does not warn about binding when the objective resolves', () => {
    createObjective(root, { slug: 'mrr', title: 'MRR' });
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const path = join(root, 'lab', 'insights', 'wau.md');
    const raw = readFileSync(path, 'utf-8');
    writeFileSync(path, raw.replace('binding: null', 'binding:\n  objective: mrr\n  value: latest'), 'utf-8');

    const results = checkLab(root);
    expect(results.some((r) => r.message.includes('does not resolve'))).toBe(false);
  });

  it('WARNS on an insight slug that is not kebab-case', () => {
    mkdirSync(join(root, 'lab', 'insights'), { recursive: true });
    writeFileSync(
      join(root, 'lab', 'insights', 'Bad_Slug.md'),
      '---\ntitle: Bad\nrender: number\nsource:\n  adapter: http\n  http:\n    endpoint: https://x\n    method: GET\n    headers: {}\n    body: null\n    extract:\n      seriesPath: data\n      seriesKey: null\n      x: t\n      y: v\n      agg: last\ntweaks: []\nbinding: null\ncredentials_used: []\n---\n## Meaning\n',
      'utf-8',
    );
    const results = checkLab(root);
    expect(results.some((r) => r.status === 'warn' && r.message.includes('kebab-case'))).toBe(true);
  });
});

describe('checkLab — ok summary', () => {
  it('reports ok with the insight count when nothing is wrong', () => {
    createInsight(root, { slug: 'wau', title: 'WAU' });
    const results = checkLab(root);
    expect(results).toEqual([{ name: 'Lab', status: 'ok', message: expect.stringContaining('1 insight') }]);
  });
});
