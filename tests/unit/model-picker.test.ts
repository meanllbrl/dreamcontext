import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from '../../dashboard/node_modules/react/index.js';
import { renderToStaticMarkup } from '../../dashboard/node_modules/react-dom/server.node.js';
import { ModelPicker, type ModelPickerProps } from '../../dashboard/src/components/sleepy/chat/model-picker/ModelPicker';
import {
  blockerOf, claudeState, codexState, favouriteKey, favouriteModels, searchModels, shortcutFor,
  splitByVersion, toggleFavourite, type ToolReadiness,
} from '../../dashboard/src/components/sleepy/chat/model-picker/pickerModel';
import type { ModelConfig } from '../../dashboard/src/lib/agentComposer';

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
    const tools = [claudeState(CONFIG, 'opus'), codexState(codex())];
    expect(searchModels(tools, 'LUNA').map((m) => m.id)).toEqual(['gpt-6.1-luna']);
    expect(searchModels(tools, 'o').map((m) => m.tool)[0]).toBe('claude');
    expect(searchModels(tools, '   ')).toEqual([]);
  });

  it('favourites are tool:model, survive a toggle, and drop a model that left the list', () => {
    const tools = [claudeState(CONFIG, 'opus'), codexState(codex())];
    const opus = tools[0]!.current[0]!;
    const on = toggleFavourite([], opus);
    expect(on).toEqual([favouriteKey(opus)]);
    expect(toggleFavourite(on, opus)).toEqual([]);
    expect(favouriteModels(tools, ['codex:gone', 'codex:gpt-5.5']).map((m) => m.id)).toEqual(['gpt-5.5']);
  });

  it('numbers the first nine rows only', () => {
    expect(shortcutFor(0)).toBe('⌘1');
    expect(shortcutFor(8)).toBe('⌘9');
    expect(shortcutFor(9)).toBeNull();
  });
});

describe('settings mode (the Settings window chip)', () => {
  const tools = [claudeState(CONFIG, 'opus'), codexState(codex())];
  const base: ModelPickerProps = {
    tools, currentTool: 'claude', model: 'opus', effort: 'high',
    onModelChange: () => {}, onEffortChange: () => {}, onCrossTool: () => {},
    accounts: [{ id: 'a', email: 'ada@example.com', state: 'ok', sessionPercent: 10 } as never],
    activeAccountId: 'a', favourites: [], onFavouritesChange: () => {}, onOpenSettings: () => {}, close: () => {},
  };
  const html = (over: Partial<ModelPickerProps> = {}) => renderToStaticMarkup(createElement(ModelPicker, { ...base, ...over }));

  it('the composer keeps its account chip and Models ›', () => {
    const out = html();
    expect(out).toContain('model-picker-account-chip');
    expect(out).toContain('Models ›');
  });

  it('a target draws no account chip and no Models ›', () => {
    const out = html({ target: {} });
    expect(out).not.toContain('model-picker-account-chip');
    expect(out).not.toContain('Models ›');
    expect(out).not.toContain('Opens a new');
  });

  it('a locked tool is passive in the rail and says why', () => {
    const out = html({ target: { lockedTools: { codex: 'The Super Agent runs on Claude Code only.' } } });
    expect(out).toContain('aria-label="Codex (The Super Agent runs on Claude Code only.)"');
    expect(out).toMatch(/aria-disabled="true"[^>]*data-tool="codex"|data-tool="codex"[^>]*aria-disabled="true"/);
  });

  it('a locked tool\'s models can never be picked, even from search', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'chat', 'model-picker', 'ModelPicker.tsx'), 'utf-8');
    expect(src).toMatch(/const usable = \(m: PickerModel\): boolean => !locked\(m\.tool\) &&/);
  });

  it('the job\'s own efforts replace the tool\'s', () => {
    // The effort chip reads the job's list: Sleep has no xhigh even where Claude does.
    const src = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'sleepy', 'chat', 'model-picker', 'ModelPicker.tsx'), 'utf-8');
    expect(src).toMatch(/const ownEfforts = p\.target\?\.efforts \?\? own\?\.efforts \?\? \[\];/);
    expect(src).toMatch(/\{ownEfforts\.map\(\(lvl\) =>/);
    expect(html({ target: { efforts: [] } })).not.toContain('Effort</span>');
    expect(html({ target: { efforts: ['low', 'medium', 'high'] } })).toContain('Effort</span>');
  });
});
