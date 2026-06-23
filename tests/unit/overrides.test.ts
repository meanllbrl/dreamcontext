import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  loadTaskOverride,
  hasTaskOverride,
  fieldKey,
  customFieldsFor,
  taskOverridePath,
  upsertCustomField,
  removeCustomField,
  readTaskOverrideRaw,
  writeTaskOverrideDoc,
  renderOverrideBriefing,
} from '../../src/lib/overrides.js';

/**
 * Project-local task format & custom-field overrides (task_dlhc0fFQ).
 * Pure parse/validate behaviour — no backend, no network.
 */

let root: string;

function writeOverride(body: string): void {
  mkdirSync(join(root, 'overrides'), { recursive: true });
  writeFileSync(taskOverridePath(root), body, 'utf-8');
}

beforeEach(() => {
  const raw = join(tmpdir(), `dc-ov-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(raw, { recursive: true });
  root = realpathSync(raw);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('fieldKey', () => {
  it('snake_cases ascii, folds accents + Turkish chars', () => {
    expect(fieldKey('Story Points')).toBe('story_points');
    expect(fieldKey('Team')).toBe('team');
    expect(fieldKey('Çalışma Süresi')).toBe('calisma_suresi');
    expect(fieldKey('  Mixed--Sep__arators  ')).toBe('mixed_sep_arators');
  });
});

describe('loadTaskOverride', () => {
  it('returns null when there is no override file', () => {
    expect(hasTaskOverride(root)).toBe(false);
    expect(loadTaskOverride(root)).toBeNull();
  });

  it('parses a valid custom_fields schema with defaults', () => {
    writeOverride(
      [
        '---',
        'custom_fields:',
        '  - { name: "Team", type: select, options: [platform, growth], sync: [clickup, github] }',
        '  - { name: "Story Points", type: number }',
        '  - { name: "Sprint", type: text, sync: [github] }',
        '---',
        '## Why',
        '{{WHY}}',
        '',
        '## Agent Instructions',
        'Fill Team from the owning squad.',
        '',
      ].join('\n'),
    );

    const ov = loadTaskOverride(root);
    expect(ov).not.toBeNull();
    expect(ov!.warnings).toEqual([]);
    expect(ov!.customFields).toEqual([
      { name: 'Team', key: 'team', type: 'select', required: false, options: ['platform', 'growth'], sync: ['clickup', 'github'] },
      // sync omitted → defaults to both
      { name: 'Story Points', key: 'story_points', type: 'number', required: false, sync: ['clickup', 'github'] },
      { name: 'Sprint', key: 'sprint', type: 'text', required: false, sync: ['github'] },
    ]);
  });

  it('parses required:true and defaults required to false', () => {
    writeOverride(
      [
        '---',
        'custom_fields:',
        '  - { name: "Team", type: text, required: true }',
        '  - { name: "Notes", type: text }',
        '---',
      ].join('\n'),
    );
    const ov = loadTaskOverride(root)!;
    expect(ov.customFields.find((f) => f.key === 'team')?.required).toBe(true);
    expect(ov.customFields.find((f) => f.key === 'notes')?.required).toBe(false);
  });

  it('parses ask:true and omits it (undefined) when absent', () => {
    writeOverride(
      [
        '---',
        'custom_fields:',
        '  - { name: "Time estimate", key: time_estimate, type: text, ask: true }',
        '  - { name: "Notes", type: text }',
        '---',
      ].join('\n'),
    );
    const ov = loadTaskOverride(root)!;
    expect(ov.customFields.find((f) => f.key === 'time_estimate')?.ask).toBe(true);
    expect(ov.customFields.find((f) => f.key === 'notes')?.ask).toBeUndefined();
  });

  it('splits the template from the Agent Instructions section', () => {
    writeOverride(
      ['---', 'custom_fields: []', '---', '## Why', 'body here', '', '## Agent Instructions', 'do the thing', ''].join('\n'),
    );
    const ov = loadTaskOverride(root)!;
    expect(ov.template).toContain('## Why');
    expect(ov.template).toContain('body here');
    expect(ov.template).not.toContain('Agent Instructions');
    expect(ov.template).not.toContain('do the thing');
    expect(ov.agentInstructions).toBe('do the thing');
  });

  it('keeps the whole body as the template when there is no Agent Instructions section', () => {
    writeOverride(['---', 'custom_fields: []', '---', '## Why', 'just a template', ''].join('\n'));
    const ov = loadTaskOverride(root)!;
    expect(ov.template).toContain('just a template');
    expect(ov.agentInstructions).toBeNull();
  });

  it('warns (never throws) on an unknown field type and skips it', () => {
    writeOverride(
      ['---', 'custom_fields:', '  - { name: "Bad", type: rainbow }', '  - { name: "Good", type: text }', '---', 'body'].join('\n'),
    );
    const ov = loadTaskOverride(root)!;
    expect(ov.customFields.map((f) => f.key)).toEqual(['good']);
    expect(ov.warnings.join(' ')).toMatch(/unknown type "rainbow"/);
  });

  it('warns + drops duplicate field keys', () => {
    writeOverride(
      ['---', 'custom_fields:', '  - { name: "Team", type: text }', '  - { name: "team", type: text }', '---', 'body'].join('\n'),
    );
    const ov = loadTaskOverride(root)!;
    expect(ov.customFields).toHaveLength(1);
    expect(ov.warnings.join(' ')).toMatch(/duplicate field key "team"/);
  });

  it('warns when custom_fields is not a list', () => {
    writeOverride(['---', 'custom_fields: not-a-list', '---', 'body'].join('\n'));
    const ov = loadTaskOverride(root)!;
    expect(ov.customFields).toEqual([]);
    expect(ov.warnings.join(' ')).toMatch(/must be a list/);
  });

  it('warns on a select field with no options but still keeps it', () => {
    writeOverride(['---', 'custom_fields:', '  - { name: "Env", type: select }', '---', 'body'].join('\n'));
    const ov = loadTaskOverride(root)!;
    expect(ov.customFields.map((f) => f.key)).toEqual(['env']);
    expect(ov.warnings.join(' ')).toMatch(/has no options/);
  });
});

describe('per-field prompt + explicit key', () => {
  it('parses a per-field system prompt and an explicit field id', () => {
    writeOverride(
      [
        '---',
        'custom_fields:',
        '  - { name: "Owning Team", key: team, type: select, options: [a, b], prompt: "Set to the squad that owns the files." }',
        '---',
        'body',
      ].join('\n'),
    );
    const ov = loadTaskOverride(root)!;
    expect(ov.customFields).toHaveLength(1);
    const f = ov.customFields[0];
    expect(f.key).toBe('team'); // explicit key wins over the name-derived "owning_team"
    expect(f.prompt).toBe('Set to the squad that owns the files.');
  });
});

describe('upsertCustomField / removeCustomField', () => {
  it('creates the override file (frontmatter-only) when none exists', () => {
    expect(hasTaskOverride(root)).toBe(false);
    const ov = upsertCustomField(root, { name: 'Team', type: 'select', options: ['platform', 'growth'], prompt: 'pick the squad' });
    expect(hasTaskOverride(root)).toBe(true);
    expect(ov.customFields.map((f) => f.key)).toEqual(['team']);
    expect(ov.customFields[0].prompt).toBe('pick the squad');
    expect(ov.template).toBeNull(); // no body → CLI falls back to the shipped template
  });

  it('updates an existing field by id (no duplicate) and preserves the body', () => {
    writeOverride(['---', 'custom_fields:', '  - { name: Team, key: team, type: text }', '---', '## Why', 'keep me'].join('\n'));
    const ov = upsertCustomField(root, { name: 'Team', key: 'team', type: 'select', options: ['x', 'y'] });
    expect(ov.customFields).toHaveLength(1);
    expect(ov.customFields[0].type).toBe('select');
    expect(readTaskOverrideRaw(root)).toContain('keep me'); // body preserved
  });

  it('appends a second field and removes one by id', () => {
    upsertCustomField(root, { name: 'Team', type: 'text' });
    upsertCustomField(root, { name: 'Story Points', type: 'number' });
    expect(loadTaskOverride(root)!.customFields.map((f) => f.key)).toEqual(['team', 'story_points']);
    const after = removeCustomField(root, 'story_points')!;
    expect(after.customFields.map((f) => f.key)).toEqual(['team']);
  });
});

describe('writeTaskOverrideDoc + renderOverrideBriefing', () => {
  it('writes raw markdown verbatim and reloads it', () => {
    const raw = ['---', 'custom_fields:', '  - { name: Sprint, type: text }', '---', '## Why', 'x'].join('\n');
    const ov = writeTaskOverrideDoc(root, raw)!;
    expect(ov.customFields.map((f) => f.key)).toEqual(['sprint']);
    expect(readTaskOverrideRaw(root)).toBe(raw);
  });

  it('renders an agent briefing including each field id, type, and prompt', () => {
    writeOverride(
      [
        '---',
        'custom_fields:',
        '  - { name: Team, key: team, type: select, options: [a, b], prompt: "owning squad" }',
        '  - { name: Owner, key: owner, type: text, required: true }',
        '---',
        '## Why',
        'x',
        '',
        '## Agent Instructions',
        'follow the format',
      ].join('\n'),
    );
    const briefing = renderOverrideBriefing(loadTaskOverride(root)!);
    expect(briefing).toContain('overrides/task.md');
    expect(briefing).toContain('id `team`');
    expect(briefing).toContain('owning squad');
    expect(briefing).toContain('follow the format');
    // a required field is flagged [REQUIRED] and triggers the mandatory rule line
    expect(briefing).toContain('[REQUIRED]');
    expect(briefing).toContain('`owner`');
  });

  it('flags ask fields [ASK THE USER] and emits the ASK-FIRST behavioral rule', () => {
    writeOverride(
      [
        '---',
        'custom_fields:',
        '  - { name: "Time estimate", key: time_estimate, type: text, ask: true, prompt: "how long?" }',
        '  - { name: Sprint, type: text }',
        '---',
      ].join('\n'),
    );
    const briefing = renderOverrideBriefing(loadTaskOverride(root)!);
    expect(briefing).toContain('[ASK THE USER]');
    expect(briefing).toContain('ASK-FIRST');
    expect(briefing).toContain('`time_estimate`');
    // a field with no ask flag must not pull in the behavioral rule for itself
    expect(briefing).not.toMatch(/ASK-FIRST[^\n]*`sprint`/);
  });

  it('upserts a field with ask:true (dashboard path) and round-trips it', () => {
    const ov = upsertCustomField(root, { name: 'Time estimate', type: 'text', ask: true, required: true });
    const f = ov.customFields.find((x) => x.key === 'time_estimate');
    expect(f?.ask).toBe(true);
    expect(f?.required).toBe(true);
    // reloads identically from disk
    expect(loadTaskOverride(root)!.customFields.find((x) => x.key === 'time_estimate')?.ask).toBe(true);
  });
});

describe('customFieldsFor', () => {
  it('filters by sync target', () => {
    const defs = [
      { name: 'A', key: 'a', type: 'text' as const, sync: ['clickup' as const] },
      { name: 'B', key: 'b', type: 'text' as const, sync: ['github' as const] },
      { name: 'C', key: 'c', type: 'text' as const, sync: ['clickup' as const, 'github' as const] },
    ];
    expect(customFieldsFor(defs, 'clickup').map((d) => d.key)).toEqual(['a', 'c']);
    expect(customFieldsFor(defs, 'github').map((d) => d.key)).toEqual(['b', 'c']);
  });
});
