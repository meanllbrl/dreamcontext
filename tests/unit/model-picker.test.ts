import { describe, expect, it } from 'vitest';
import {
  activeRow, blockerFix, blockerOf, claudeState, codexState, effortsFor, searchModels, shortcutFor,
  splitByVersion, type ToolReadiness,
} from '../../dashboard/src/components/sleepy/chat/model-picker/pickerModel';
import type { ModelConfig } from '../../dashboard/src/lib/agentComposer';
import { LEGACY_MODEL_OPTIONS, modelOptionsFrom, modelPickerId } from '../../src/lib/model-list';
import { spawnModelFor } from '../../src/server/routes/agent-chat';
import { modelLabelFor } from '../../dashboard/src/lib/agentComposer';

const CONFIG = {
  models: [{ id: 'opus', label: 'Opus' }, { id: 'sonnet', label: 'Sonnet' }, { id: 'haiku', label: 'Haiku' }],
  efforts: ['low', 'high'],
  defaultModel: 'opus',
  defaultEffort: 'high',
} as unknown as ModelConfig;

const codex = (over: Partial<ToolReadiness> = {}): ToolReadiness => ({
  tool: 'codex', label: 'Codex', ready: true, installed: true, signedIn: true, nodeOk: true,
  models: [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', efforts: ['low', 'high'] },
    { id: 'gpt-6.1-luna', label: 'GPT-6.1 Luna', efforts: ['high', 'max'] },
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low'] },
  ],
  ...over,
});

describe('r29 model picker data', () => {
  it('splits Codex by version family: the newest is current, the rest Legacy', () => {
    const s = codexState(codex());
    expect(s.current.map((m) => m.id)).toEqual(['gpt-6.1-sol', 'gpt-6.1-luna']);
    expect(s.legacy.map((m) => m.id)).toEqual(['gpt-5.5']);
    expect(s.efforts).toEqual(['low', 'high', 'max']);
  });

  it('keeps a list with no version all current', () => {
    expect(splitByVersion([{ id: 'alpha', label: 'Alpha' }], 'codex')).toEqual({ current: [{ tool: 'codex', id: 'alpha', label: 'Alpha' }], legacy: [] });
  });

  it('a signed-out tool is not ready and says why', () => {
    const s = codexState(codex({ ready: false, signedIn: false }));
    expect(s.ready).toBe(false);
    expect(s.blocker).toBe('signed-out');
    expect(blockerOf({ installed: false, signedIn: false })).toBe('not-installed');
    expect(blockerOf({ installed: true, signedIn: true, nodeOk: false })).toBe('needs-node');
  });

  it('searches across tools, by label and by id, in rail order', () => {
    const tools = [claudeState(CONFIG), codexState(codex())];
    expect(searchModels(tools, 'LUNA').map((m) => m.id)).toEqual(['gpt-6.1-luna']);
    expect(searchModels(tools, 'o').map((m) => m.tool)[0]).toBe('claude');
    expect(searchModels(tools, '   ')).toEqual([]);
  });

  const real = { ...CONFIG, models: modelOptionsFrom(null), legacyModels: LEGACY_MODEL_OPTIONS.map((m) => ({ ...m })) } as ModelConfig;

  it('Fable and Haiku are not legacy: current families carry their version, most capable first', () => {
    const s = claudeState(real);
    expect(s.current.map((m) => m.label)).toEqual(['Fable 5.1', 'Opus 5.5', 'Sonnet 5.5', 'Haiku 5.5']);
    expect(s.legacy.map((m) => m.id)).not.toContain('fable');
    expect(s.legacy.map((m) => m.id)).not.toContain('haiku');
    expect(shortcutFor(s.current.findIndex((m) => m.id === 'fable'))).toBe('⌘1');
  });

  it('legacy lists real older versions by exact id; none named, no group', () => {
    expect(claudeState(real).legacy.map((m) => m.id)).toEqual([
      'claude-opus-5', 'claude-opus-4-8', 'claude-opus-4-7', 'claude-opus-4-6', 'claude-opus-4-5',
      'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-sonnet-4-5', 'claude-haiku-4-5',
    ]);
    expect(claudeState(CONFIG).legacy).toEqual([]);
  });

  it('a chat on an older version finds its own row, its label and its efforts', () => {
    const s = claudeState(real);
    expect(activeRow(s, 'claude-opus-4-8')?.label).toBe('Opus 4.8');
    expect(activeRow(s, 'claude-opus-4-8[1m]')?.label).toBe('Opus 4.8');
    expect(activeRow(s, 'claude-opus-5-5')?.id).toBe('opus');
    expect(activeRow(s, 'claude-opus-4-1')).toBeNull();
    expect(modelLabelFor(real, 'claude-opus-4-8-20260101')).toBe('Opus 4.8');
    expect(modelLabelFor(real, 'claude-opus-5-5')).toBe('Opus 5.5');
    expect(effortsFor(s, 'claude-opus-4-6')).toEqual(['low', 'medium', 'high', 'max']);
    expect(effortsFor(s, 'claude-haiku-4-5')).toEqual([]);
    expect(effortsFor(s, 'opus')).toEqual(CONFIG.efforts);
  });

  it('a transcript keeps a legacy id; the current generation folds to its alias', () => {
    expect(modelPickerId('claude-opus-4-7[1m]')).toBe('claude-opus-4-7');
    expect(modelPickerId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
    expect(modelPickerId('claude-opus-5-5')).toBe('opus');
  });

  it('the picked id goes to the spawn as it is', () => {
    expect(spawnModelFor({ isAssistant: false, urlModel: 'claude-opus-4-8' })).toBe('claude-opus-4-8');
  });

  it('numbers the first nine rows only', () => {
    expect(shortcutFor(0)).toBe('⌘1');
    expect(shortcutFor(8)).toBe('⌘9');
    expect(shortcutFor(9)).toBeNull();
  });
});

describe('Codex blockers come in the order they can be fixed', () => {
  const base = { installed: true, runs: true, signedIn: false, nodeOk: true, outdated: false };
  it('an old install signed out gets Update, not a Sign in the server refuses', () => {
    expect(blockerOf({ ...base, outdated: true })).toBe('outdated');
    expect(blockerFix('outdated')).toBe('codex-update');
  });
  it('no bridge Node comes before the sign-in too', () => {
    expect(blockerOf({ ...base, nodeOk: false })).toBe('needs-node');
    expect(blockerFix('needs-node')).toBe('codex-update');
  });
  it('ready with no model list still offers a row', () => {
    const t = codexState({ tool: 'codex', label: 'Codex', ready: true, installed: true, signedIn: true, models: [] });
    expect(t.current.map((m) => m.label)).toEqual(['Codex default model']);
  });
  it('signed out alone gets Sign in, missing gets Install', () => {
    expect(blockerFix(blockerOf(base))).toBe('codex-signin');
    expect(blockerFix(blockerOf({ ...base, installed: false }))).toBe('codex-install');
  });
});

describe('Antigravity in the picker (Track T W5)', () => {
  const base = { tool: 'antigravity' as const, label: 'Antigravity', ready: false, installed: false, signedIn: false, nodeOk: true, models: [{ id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', efforts: [] }, { id: 'gemini-3.7-flash-high', label: 'Gemini 3.7 Flash (High)', efforts: [] }] };

  it('walks install, sign in and ready', () => {
    expect(codexState(base)).toMatchObject({ tool: 'antigravity', ready: false, blocker: 'not-installed' });
    expect(blockerFix('not-installed', 'antigravity')).toBe('antigravity-install');
    expect(codexState({ ...base, installed: true })).toMatchObject({ blocker: 'signed-out' });
    expect(blockerFix('signed-out', 'antigravity')).toBe('antigravity-signin');
    expect(codexState({ ...base, installed: true, signedIn: true, ready: true })).toMatchObject({ ready: true, blocker: '' });
  });

  it('shows the newest Gemini family as current and the rest as legacy, under the tool\'s own name', () => {
    const s = codexState({ ...base, installed: true, signedIn: true, ready: true });
    expect(s.current.map((m) => m.id)).toEqual(['gemini-3.8-flash-high']);
    expect(s.legacy.map((m) => m.id)).toEqual(['gemini-3.7-flash-high']);
    expect(s.current[0]!.tool).toBe('antigravity');
  });

  it('offers no Codex fix on this row: a Node too old is not Antigravity\'s to fix', () => {
    expect(blockerFix('needs-node', 'antigravity')).toBeNull();
    expect(blockerFix('needs-node')).toBe('codex-update');
  });
});
