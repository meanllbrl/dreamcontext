/** Sub-agents never run on Fable (plan super-cocuk-tasarruf D5, criterion 8, the pure parts). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDefinitionModel, parentModelFrom, pinSubagentModel } from '../../src/lib/agent-model-pin.js';

let cwd: string;
let home: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'dc-pin-cwd-'));
  home = mkdtempSync(join(tmpdir(), 'dc-pin-home-'));
  mkdirSync(join(cwd, '.claude', 'agents'), { recursive: true });
  mkdirSync(join(home, '.claude', 'agents'), { recursive: true });
});
afterEach(() => { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); });

const agent = (dir: string, name: string, model: string | null) => writeFileSync(join(dir, '.claude', 'agents', `${name}.md`),
  `---\nname: ${name}\ndescription: x\n${model === null ? '' : `model: ${model}\n`}---\nbody\n`);

describe('agentDefinitionModel', () => {
  it('project first, then the user; inherit and no model read none; built-ins none; plugin and unknown types unknown', () => {
    agent(cwd, 'reviewer', 'opus');
    agent(home, 'reviewer', 'haiku');
    agent(home, 'scout', 'sonnet');
    agent(cwd, 'heir', 'inherit');
    agent(cwd, 'bare', null);
    expect(agentDefinitionModel('reviewer', cwd, home)).toBe('opus');
    expect(agentDefinitionModel('scout', cwd, home)).toBe('sonnet');
    expect(agentDefinitionModel('heir', cwd, home)).toBe('none');
    expect(agentDefinitionModel('bare', cwd, home)).toBe('none');
    expect(agentDefinitionModel('general-purpose', cwd, home)).toBe('none');
    expect(agentDefinitionModel('Explore', cwd, home)).toBe('none');
    expect(agentDefinitionModel('', cwd, home)).toBe('none');
    expect(agentDefinitionModel('vercel:ai-architect', cwd, home)).toBe('unknown');
    expect(agentDefinitionModel('no-such-agent', cwd, home)).toBe('unknown');
    expect(agentDefinitionModel('../etc/passwd', cwd, home)).toBe('unknown');
  });

  it('a definition reached through a symlink is not read', () => {
    const real = join(cwd, 'real.md');
    writeFileSync(real, '---\nmodel: fable\n---\n');
    symlinkSync(real, join(cwd, '.claude', 'agents', 'linked.md'));
    expect(agentDefinitionModel('linked', cwd, home)).toBe('unknown');
  });
});

describe('pinSubagentModel', () => {
  it('explicit Fable -> opus; explicit opus/sonnet/haiku untouched', () => {
    expect(pinSubagentModel({ requested: 'fable', definition: 'none', parentModel: null })).toBe('opus');
    expect(pinSubagentModel({ requested: 'claude-fable-5-2', definition: 'opus', parentModel: 'claude-opus-5-5' })).toBe('opus');
    for (const m of ['opus', 'sonnet', 'haiku']) expect(pinSubagentModel({ requested: m, definition: 'none', parentModel: 'claude-fable-5-2' })).toBeNull();
  });

  it('no model under a Fable parent: opus only for an agent with no model of its own', () => {
    expect(pinSubagentModel({ requested: null, definition: 'none', parentModel: 'claude-fable-5-2' })).toBe('opus');
    expect(pinSubagentModel({ requested: '', definition: 'none', parentModel: 'claude-fable-5-2' })).toBe('opus');
    expect(pinSubagentModel({ requested: null, definition: 'sonnet', parentModel: 'claude-fable-5-2' })).toBeNull();
    expect(pinSubagentModel({ requested: null, definition: 'unknown', parentModel: 'claude-fable-5-2' })).toBeNull();
  });

  it('a non-Fable or unknown parent: untouched', () => {
    expect(pinSubagentModel({ requested: null, definition: 'none', parentModel: 'claude-opus-5-5' })).toBeNull();
    expect(pinSubagentModel({ requested: null, definition: 'none', parentModel: 'claude-sonnet-5-5' })).toBeNull();
    expect(pinSubagentModel({ requested: null, definition: 'none', parentModel: null })).toBeNull();
  });
});

describe('parentModelFrom', () => {
  it('the last main-chain assistant model; sidechain and synthetic records skipped', () => {
    expect(parentModelFrom([
      { type: 'assistant', message: { model: 'claude-opus-5-5' } },
      { type: 'assistant', message: { model: 'claude-fable-5-2' } },
      { type: 'assistant', isSidechain: true, message: { model: 'claude-haiku-5-5' } },
      { type: 'assistant', message: { model: '<synthetic>' } },
      { type: 'user', message: {} },
    ])).toBe('claude-fable-5-2');
    expect(parentModelFrom([])).toBeNull();
  });
});
