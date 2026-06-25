import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { LocalTaskBackend } from '../../src/lib/task-backend/local.js';

/**
 * Create-from-override (task_9F8-ubNd, acceptance criterion 2).
 *
 * `overrides/task.md` carries a custom_fields schema in its FRONTMATTER and the
 * task body shape in its BODY (an `## Agent Instructions` tail is stripped).
 * When present, BOTH create surfaces — the CLI (`variant: 'cli'`) and the
 * dashboard (`variant: 'dashboard'`) — must scaffold from that shape, AND the
 * scaffolded task must still carry the canonical frontmatter (id/status/…) — the
 * override frontmatter is the field schema, not a task header. Absent the file,
 * both surfaces stay byte-identical to the shipped defaults (golden-pinned
 * elsewhere; sanity-checked here).
 */

let projectRoot: string;
let contextRoot: string;
let stateDir: string;

const OVERRIDE = [
  '---',
  'custom_fields:',
  '  - { name: "Story Points", key: story_points, type: number, required: true }',
  '  - { name: "Sprint", type: text }',
  '---',
  '## Sprint Goal',
  '{{WHY}}',
  '',
  '## Definition of Done',
  '- [ ] Ships behind a flag',
  '',
  '## Changelog',
  '',
  '### {{DATE}} - Created',
  '- Task created.',
  '',
  '## Agent Instructions',
  'Always set Story Points before starting.',
  '',
].join('\n');

function writeOverride(body: string): void {
  mkdirSync(join(contextRoot, 'overrides'), { recursive: true });
  writeFileSync(join(contextRoot, 'overrides', 'task.md'), body, 'utf-8');
}

function rawTask(slug: string): string {
  return readFileSync(join(stateDir, `${slug}.md`), 'utf-8');
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-create-ov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  projectRoot = realpathSync(raw);
  contextRoot = join(projectRoot, '_dream_context');
  stateDir = join(contextRoot, 'state');
  mkdirSync(stateDir, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('create from override — custom body shape', () => {
  for (const variant of ['cli', 'dashboard'] as const) {
    it(`${variant} create scaffolds the override body sections, not the defaults`, async () => {
      writeOverride(OVERRIDE);
      const backend = new LocalTaskBackend(stateDir);
      const task = await backend.create({ name: `Ship ${variant}`, why: 'because it matters', variant });

      // Body follows the OVERRIDE layout…
      expect(task.sections).toContain('Sprint Goal');
      expect(task.sections).toContain('Definition of Done');
      expect(task.body).toContain('because it matters'); // {{WHY}} substituted
      // …not the shipped defaults.
      expect(task.sections).not.toContain('User Stories');
      expect(task.body).not.toContain('## Acceptance Criteria');
      // The `## Agent Instructions` tail is meta — never scaffolded into a task.
      expect(rawTask(task.slug)).not.toContain('Agent Instructions');
      // Every placeholder is resolved (no `{{TOKEN}}` leaks through).
      expect(rawTask(task.slug)).not.toContain('{{');
    });

    it(`${variant} create from override still writes a VALID frontmatter (id/status/name)`, async () => {
      // Regression: the override BODY has no frontmatter, so scaffolding from it
      // verbatim produced a header-less, id-less task. The shipped frontmatter
      // contract must be grafted on.
      writeOverride(OVERRIDE);
      const backend = new LocalTaskBackend(stateDir);
      const task = await backend.create({ name: `Valid ${variant}`, variant });

      expect(task.id).toMatch(/^task_/);
      expect(task.id.length).toBeGreaterThan(5);
      expect(task.name).toBe(`Valid ${variant}`);
      expect(task.status).toBe('todo');
      const raw = rawTask(task.slug);
      expect(raw.startsWith('---\n')).toBe(true);
      // quoting is normalized when the field schema is seeded — assert the value, not the quotes
      expect(raw).toMatch(/\nid:\s*["']?task_/);
      expect(raw).toMatch(/\nstatus:\s*["']?todo["']?/);
    });

    it(`${variant} create seeds every declared custom field to null`, async () => {
      writeOverride(OVERRIDE);
      const backend = new LocalTaskBackend(stateDir);
      const task = await backend.create({ name: `Fields ${variant}`, variant });
      expect(task.custom_fields).toEqual({ story_points: null, sprint: null });
    });
  }

  it('a custom_fields-only override (no body) falls back to the shipped template', async () => {
    writeOverride(['---', 'custom_fields:', '  - { name: "Sprint", type: text }', '---', ''].join('\n'));
    const backend = new LocalTaskBackend(stateDir);
    const task = await backend.create({ name: 'No Body', variant: 'cli' });
    // Shipped shape (override declared fields only, no custom body).
    expect(task.sections).toContain('User Stories');
    expect(task.sections).toContain('Acceptance Criteria');
    expect(task.custom_fields).toEqual({ sprint: null });
  });
});

describe('no override — surfaces stay on the shipped shape', () => {
  it('cli create uses the shipped full template (Workflow + User Stories)', async () => {
    const backend = new LocalTaskBackend(stateDir);
    const task = await backend.create({ name: 'Plain CLI', variant: 'cli' });
    expect(task.sections).toContain('User Stories');
    expect(rawTask(task.slug)).toContain('## Workflow');
    expect(task.custom_fields).toEqual({});
  });

  it('dashboard create uses the compact skeleton, unchanged', async () => {
    const backend = new LocalTaskBackend(stateDir);
    const task = await backend.create({ name: 'Plain Dash', variant: 'dashboard' });
    // The compact skeleton's exact user-story line — proves the no-override
    // dashboard path was not disturbed by the override branch.
    expect(rawTask(task.slug)).toContain('As a [user], I want [action] so that [outcome]');
    expect(rawTask(task.slug)).not.toContain('## Workflow');
    expect(task.custom_fields).toEqual({});
  });
});
