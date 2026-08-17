import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  deriveCode, buildDoctorReport, checkCoreFileSizes, checkJson,
  type CheckResult,
} from '../../src/cli/commands/doctor.js';
import { CORE_FILE_CHAR_CEILING, CORE_FILE_LINE_CEILING } from '../../src/lib/core-index.js';

/**
 * The diagnostic contract behind `doctor --json`: every reported check carries
 * a stable `code`, and annotated checks add `subject` (what is broken),
 * `evidence` (measured proof), and `supportedFixes` (repairs a consumer picks
 * from instead of guessing). See knowledge/patterns/diagnostic-repair-loop.md.
 */

describe('deriveCode', () => {
  it('kebab-cases the check name under the doctor/ namespace', () => {
    expect(deriveCode('Core file size')).toBe('doctor/core-file-size');
    expect(deriveCode('Task↔feature links')).toBe('doctor/task-feature-links');
    expect(deriveCode('Sleep debt')).toBe('doctor/sleep-debt');
  });

  it('never returns an empty slug', () => {
    expect(deriveCode('↔↔')).toBe('doctor/check');
    expect(deriveCode('')).toBe('doctor/check');
  });

  it('is stable — same name, same code', () => {
    expect(deriveCode('Objectives')).toBe(deriveCode('Objectives'));
  });
});

describe('buildDoctorReport', () => {
  const results: CheckResult[] = [
    { name: 'Core directory', status: 'ok', message: 'core' },
    { name: 'Soul file', status: 'warn', message: 'Contains placeholder content: core/0.soul.md', code: 'doctor/placeholder-content' },
    { name: 'Changelog', status: 'error', message: 'Malformed JSON: core/CHANGELOG.json', code: 'doctor/malformed-json' },
  ];

  it('reports version 1 and a summary that matches the checks', () => {
    const report = buildDoctorReport(results);
    expect(report.version).toBe(1);
    expect(report.summary).toEqual({ ok: 1, warn: 1, error: 1 });
    expect(report.checks).toHaveLength(3);
  });

  it('gives every check a code — explicit codes preserved, missing ones derived', () => {
    const report = buildDoctorReport(results);
    expect(report.checks[0].code).toBe('doctor/core-directory');
    expect(report.checks[1].code).toBe('doctor/placeholder-content');
    expect(report.checks[2].code).toBe('doctor/malformed-json');
    for (const check of report.checks) expect(check.code).toMatch(/^doctor\//);
  });

  it('does not mutate the input results', () => {
    const before = JSON.stringify(results);
    buildDoctorReport(results);
    expect(JSON.stringify(results)).toBe(before);
  });
});

describe('annotated checks carry the full diagnostic contract', () => {
  let projectRoot: string;
  let root: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-doctor-json-'));
    root = join(projectRoot, '_dream_context');
    mkdirSync(join(root, 'core'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('core-file-ceiling: subject names the file, evidence carries the measurements, fixes are concrete', () => {
    const big = '---\nname: Big\ntype: soul\n---\n\n' + 'x'.repeat(CORE_FILE_CHAR_CEILING + 1000);
    writeFileSync(join(root, 'core', '0.soul.md'), big, 'utf-8');

    const over = checkCoreFileSizes(root).filter((r) => r.status === 'warn');
    expect(over.length).toBeGreaterThan(0);
    const soul = over.find((r) => String(r.subject?.file).endsWith('core/0.soul.md'));
    expect(soul).toBeDefined();
    expect(soul!.code).toBe('doctor/core-file-ceiling');
    expect(soul!.evidence).toMatchObject({
      charCeiling: CORE_FILE_CHAR_CEILING,
      lineCeiling: CORE_FILE_LINE_CEILING,
    });
    expect(typeof soul!.evidence!.chars).toBe('number');
    expect((soul!.evidence!.chars as number)).toBeGreaterThan(CORE_FILE_CHAR_CEILING);
    expect(soul!.supportedFixes!.length).toBeGreaterThan(0);
  });
});

/**
 * `checkJson` validates SHAPE, not just parseability. A hand-scaffolded
 * `{"entries": []}` / `{"releases": []}` parses fine but is not what
 * `readJsonArray()` wants — the parse-only check reported OK while
 * `core releases add` failed loudly and the snapshot's recent-changelog
 * section came back empty in silence.
 */
describe('checkJson — shape validation, not just parseability', () => {
  let projectRoot: string;
  let root: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'dc-doctor-shape-'));
    root = join(projectRoot, '_dream_context');
    mkdirSync(join(root, 'core'), { recursive: true });
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function write(rel: string, content: string): void {
    writeFileSync(join(root, rel), content, 'utf-8');
  }

  it('passes a bare array where an array is expected', () => {
    write('core/RELEASES.json', '[]\n');
    const r = checkJson(root, 'core/RELEASES.json', 'Releases', 'array');
    expect(r.status).toBe('ok');
  });

  it('warns — not OK — on the {"releases": []} wrapper the bug reported', () => {
    write('core/RELEASES.json', '{"releases": []}\n');
    const r = checkJson(root, 'core/RELEASES.json', 'Releases', 'array');

    expect(r.status).toBe('warn');
    expect(r.code).toBe('doctor/json-wrapped-array');
    expect(r.subject).toMatchObject({ file: 'core/RELEASES.json', expected: 'array' });
    expect(r.evidence).toMatchObject({ wrapperKey: 'releases', items: 0 });
    expect(r.supportedFixes!.length).toBeGreaterThan(0);
  });

  it('warns on the {"entries": [...]} CHANGELOG wrapper and counts what is inside', () => {
    write('core/CHANGELOG.json', '{"entries": [{"date": "2026-06-23"}, {"date": "2026-06-24"}]}\n');
    const r = checkJson(root, 'core/CHANGELOG.json', 'Changelog', 'array');

    expect(r.status).toBe('warn');
    expect(r.code).toBe('doctor/json-wrapped-array');
    expect(r.evidence).toMatchObject({ wrapperKey: 'entries', items: 2 });
  });

  it('errors when the array file holds a shape no reader can unwrap', () => {
    write('core/CHANGELOG.json', '{"date": "2026-06-23", "type": "chore"}\n');
    const r = checkJson(root, 'core/CHANGELOG.json', 'Changelog', 'array');

    expect(r.status).toBe('error');
    expect(r.code).toBe('doctor/json-not-array');
    expect(r.evidence).toMatchObject({ actual: 'object' });
  });

  it('errors when an object file holds an array', () => {
    write('core/taxonomy.json', '[]\n');
    const r = checkJson(root, 'core/taxonomy.json', 'Taxonomy vocabulary', 'object');

    expect(r.status).toBe('error');
    expect(r.code).toBe('doctor/json-not-object');
    expect(r.evidence).toMatchObject({ actual: 'array' });
  });

  it('passes an object file holding an object', () => {
    write('core/taxonomy.json', '{"version": 1}\n');
    expect(checkJson(root, 'core/taxonomy.json', 'Taxonomy vocabulary', 'object').status).toBe('ok');
  });

  it('still reports unparseable JSON as malformed, ahead of any shape check', () => {
    write('core/RELEASES.json', 'not json at all');
    const r = checkJson(root, 'core/RELEASES.json', 'Releases', 'array');

    expect(r.status).toBe('error');
    expect(r.code).toBe('doctor/malformed-json');
    expect(r.evidence!.parseError).toBeTruthy();
  });

  it('still reports a missing file as missing', () => {
    const r = checkJson(root, 'core/RELEASES.json', 'Releases', 'array');
    expect(r.status).toBe('error');
    expect(r.code).toBe('doctor/missing-file');
  });
});

describe('skill docs pin the verb (regression lock for the wiring)', () => {
  it('cli-reference.md documents doctor --json and the supportedFixes contract', () => {
    const ref = readFileSync(join(__dirname, '../../skill/references/cli-reference.md'), 'utf-8');
    expect(ref).toContain('doctor --json');
    expect(ref).toContain('supportedFixes');
  });

  it('cli-reference.md pins the two JSON shape codes doctor can now emit', () => {
    const ref = readFileSync(join(__dirname, '../../skill/references/cli-reference.md'), 'utf-8');
    expect(ref).toContain('doctor/json-wrapped-array');
    expect(ref).toContain('doctor/json-not-array');
  });
});
