/**
 * The Super Agent knows which tools on this Mac can run a child, and which models each takes
 * (task super-agent-bu-mac-teki-araclari-ve-modelleri-bilir-…, owner 2026-11-02: "run a Gemini
 * model" was not understood; a Gemini child's card showed no model):
 *  - the block lists only READY tools' models and names the delegate flag; a tool that is not
 *    ready says the one step the owner takes, never its models;
 *  - it rides an owner message only when it changed, never a `/` command;
 *  - the briefing maps Gemini to antigravity and GPT to codex;
 *  - the record keeps a child's tool (and a pool row's), so `super state`, the card and resume see it;
 *  - the card chip names a Codex or Antigravity model as its vendor does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  renderToolsBlock, superOwnerToolsBlock, stripSuperToolsBlocks, toolsBlockFingerprint, notReadyFix,
} from '../../src/lib/super/tools-block.js';
import type { ToolInfo } from '../../src/lib/t3-bridge/registry.js';
import { superBriefing } from '../../src/server/chat-modes.js';
import { sanitizeSuperState } from '../../src/lib/super/store.js';
import { SUPER_STATE_VERSION, emptySuperState } from '../../src/lib/super/types.js';
import { chipFromPickerLabel, modelChip, modelChipParts } from '../../dashboard/src/components/sleepy/super/superHandover.js';
import { codexStartModel } from '../../src/lib/t3-bridge/registry.js';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const claude: ToolInfo = { tool: 'claude', label: 'Claude', installed: true, signedIn: true, nodeOk: true, ready: true, defaultModel: null, models: [] };
const codex: ToolInfo = {
  tool: 'codex', label: 'Codex', installed: true, signedIn: true, nodeOk: true, ready: true, runs: true, outdated: false, defaultModel: 'gpt-5.5',
  models: [
    { id: 'gpt-5.5', label: 'GPT-5.5', efforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', efforts: ['low', 'medium'], defaultEffort: 'low' },
  ],
};
const agyModels = [
  { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', efforts: [], defaultEffort: null },
  { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)', efforts: [], defaultEffort: null },
];
const agyReady: ToolInfo = { tool: 'antigravity', label: 'Antigravity', installed: true, signedIn: true, nodeOk: true, ready: true, defaultModel: 'gemini-3.8-flash-high', models: agyModels };
const agyOut: ToolInfo = { ...agyReady, signedIn: false, ready: false };
const codexMissing: ToolInfo = { ...codex, installed: false, runs: false, signedIn: false, ready: false };

describe('the "Tools on this Mac" block', () => {
  it('names the delegate flag and every ready tool with its models and default', () => {
    const b = renderToolsBlock([claude, codex, agyReady]);
    expect(b.split('\n')[0]).toMatch(/^## Tools on this Mac <!-- fp=[0-9a-f]{12} -->$/);
    expect(b).toContain('dreamcontext super delegate --tool <tool> --model <id>');
    expect(b).toMatch(/"Gemini" or Google = antigravity/);
    expect(b).toMatch(/"GPT", OpenAI or ChatGPT = codex/);
    expect(b).toMatch(/`codex`[^\n]*ready\. Models: gpt-5\.5 \(default\), gpt-5\.5-mini/);
    expect(b).toMatch(/`antigravity`[^\n]*ready\. Models: gemini-3\.8-flash-high \(default\), gemini-3\.8-flash-low/);
    expect(b).toMatch(/`claude`[^\n]*ready\. Models: opus, sonnet, haiku, fable/);
    // A few lines: it rides every Super spawn.
    expect(b.length).toBeLessThan(1800);
  });

  it('offers only ready tools: one that is not ready says the owner\'s step, never its models', () => {
    const b = renderToolsBlock([claude, codexMissing, agyOut]);
    expect(b).not.toContain('gemini-3.8-flash-high');
    expect(b).not.toContain('gpt-5.5');
    expect(b).toMatch(/`antigravity`[^\n]*signed out: the owner signs in to Antigravity[^\n]*Do not start a child on it\./);
    expect(b).toMatch(/`codex`[^\n]*not installed: the owner installs Codex[^\n]*Do not start a child on it\./);
    expect(notReadyFix({ ...codex, ready: false, outdated: true })).toMatch(/too old/);
  });

  it('a change in readiness is a new fingerprint; the same Mac is the same one', () => {
    const a = toolsBlockFingerprint(renderToolsBlock([claude, codex, agyReady]));
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(toolsBlockFingerprint(renderToolsBlock([claude, codex, agyReady]))).toBe(a);
    expect(toolsBlockFingerprint(renderToolsBlock([claude, codex, agyOut]))).not.toBe(a);
  });

  it('rides an owner message only when it changed, and never a slash command', () => {
    const block = renderToolsBlock([claude, codex, agyReady]);
    const fp = toolsBlockFingerprint(block)!;
    const first = superOwnerToolsBlock({ text: 'run a Gemini model', block, delivered: null });
    expect(first.block).toMatch(new RegExp(`^<super-tools fp=${fp}>\\n## Tools on this Mac`));
    expect(first.block!.endsWith('</super-tools>')).toBe(true);
    expect(first.delivered).toBe(fp);
    expect(superOwnerToolsBlock({ text: 'again', block, delivered: fp })).toEqual({ block: null, delivered: fp });
    expect(superOwnerToolsBlock({ text: '/clear', block, delivered: null })).toEqual({ block: null, delivered: null });
    // Recall never reads it.
    expect(stripSuperToolsBlocks(`hi\n${first.block}\nthere`)).toBe('hi\nthere');
  });
});

describe('the briefing tells the Super how to pick a tool', () => {
  it('names --tool and maps Gemini and GPT', () => {
    const b = superBriefing();
    expect(b).toContain('`--tool codex|antigravity --model <id>`');
    expect(b).toContain('"Gemini" = antigravity');
    expect(b).toContain('"GPT"/OpenAI = codex');
    expect(b).toContain('## Tools on this Mac');
  });

  it('the spawn appends the block and an owner turn carries <super-tools> (agent-chat.ts)', () => {
    const src = readFileSync(join(__dirname, '../../src/server/routes/agent-chat.ts'), 'utf-8');
    expect(src).toMatch(/\[ownBrief, subagents\?\.roster \?\? '', superTeamBlock, superToolsSpawn\]/);
    expect(src).toMatch(/superOwnerToolsBlock\(\{ text, block: toolsBlockNow\(\), delivered: superTools\.delivered \}\)/);
  });
});

describe('the record keeps the tool a child runs on', () => {
  it('a child and a pool row keep codex/antigravity; anything else is dropped', () => {
    const base = emptySuperState();
    const sid = '11111111-1111-4111-8111-111111111111';
    const sid2 = '22222222-2222-4222-8222-222222222222';
    const s = sanitizeSuperState({
      ...base, v: SUPER_STATE_VERSION,
      children: {
        [sid]: { sessionId: sid, brief: 'b', adopted: false, startedAt: 1, tool: 'antigravity', model: 'gemini-3.8-flash-high' },
        [sid2]: { sessionId: sid2, brief: 'b', adopted: false, startedAt: 1, tool: 'opencode' },
      },
      pool: [{ id: 'p-abc123', title: 't', prompt: 'do it', hash: 'x', createdAt: 1, tool: 'codex', model: 'gpt-5.5' }],
    });
    expect(s.children[sid]!.tool).toBe('antigravity');
    expect(s.children[sid]!.model).toBe('gemini-3.8-flash-high');
    expect(s.children[sid2]!.tool).toBeUndefined();
    expect(s.pool[0]?.tool).toBe('codex');
  });

  it('the model a child really runs on reaches the record from its own init, and super state shows tool and model', () => {
    const route = readFileSync(join(__dirname, '../../src/server/routes/super.ts'), 'utf-8');
    expect(route).toMatch(/tool: ch\.tool \?\? 'claude',\n\s+model: ch\.model \?\? 'default',/);
    // Antigravity gets no effort of ours: its model id carries it.
    expect(route).toContain("jobIn.effort || jobIn.tool === 'antigravity' ? jobIn");
    const chat = readFileSync(join(__dirname, '../../src/server/routes/agent-chat.ts'), 'utf-8');
    expect(chat).toMatch(/!isSuper && obj\.type === 'system' && obj\.subtype === 'init'[\s\S]{0,300}noteChildModel\(chatRegistryId, m\)\.then\(\(\) => \{ notedChildModel = m; \}/);
    // Only what `super resume` takes back: a `[1m]` id is never written.
    const inbox = readFileSync(join(__dirname, '../../src/lib/super/inbox.ts'), 'utf-8');
    expect(inbox).toContain('if (!root || model.length > 60 || sanitizeModel(model) !== model) return;');
    // A turn never runs a tool: it reads the block the background refresh rendered.
    expect(chat).toContain('superOwnerToolsBlock({ text, block: toolsBlockNow(), delivered: superTools.delivered })');
    expect(chat).toContain("const superToolsSpawn = isSuper ? toolsBlockNow() : '';");
  });

  it('the ACP adapter reports the model a session really runs on to the bridge (patch 02), and the bridge puts it in init', () => {
    const adapter = readFileSync(join(__dirname, '../../src/vendor/t3/packages/provider-acp/src/server/adapter.ts'), 'utf-8');
    expect(adapter).toContain('const runsOn = appliedModel ?? startResult.sessionSetupResult.models?.currentModelId;');
    expect(adapter).toContain('if (runsOn) bridgeOnModel?.(runsOn);');
    const patch = readFileSync(join(__dirname, '../../src/vendor/t3/patches/02-acp-bridge-mcp-servers.patch'), 'utf-8');
    expect(patch).toContain('+          if (runsOn) bridgeOnModel?.(runsOn);');
    const session = readFileSync(join(__dirname, '../../src/lib/t3-bridge/session.ts'), 'utf-8');
    expect(session).toMatch(/const runsOn = \(model: string\): void => \{[^\n]*this\.wire\.setModel\(model\)/);
    expect(session).toContain('onModel: runsOn,');
  });
});

describe('the card chip names a Codex or Antigravity model', () => {
  it('as its vendor does, the effort from the id for Antigravity', () => {
    expect(modelChip('gemini-3.8-flash-high', 'medium', 'antigravity')).toBe('Gemini 3.8 Flash · high');
    expect(modelChip('gemini-pro-agent', null, 'antigravity')).toBe('Gemini Pro Agent');
    expect(modelChip('gpt-5.5', 'high', 'codex')).toBe('GPT-5.5 · high');
    expect(modelChip('gpt-5.5-mini', '', 'codex')).toBe('GPT-5.5-mini');
    // Claude unchanged.
    expect(modelChip('claude-opus-5-5', 'medium', 'claude')).toBe('Opus · medium');
    expect(modelChip('', 'high', 'antigravity')).toBeNull();
  });

  it('in two parts: name and level', () => {
    expect(modelChipParts('gemini-3.8-flash-high', 'medium', 'antigravity')).toEqual({ name: 'Gemini 3.8 Flash', level: 'high' });
    expect(modelChipParts('gpt-5.5', 'high', 'codex')).toEqual({ name: 'GPT-5.5', level: 'high' });
  });

  it('the card and the tile draw the tool mark always, also before the model is known, and say it in words', () => {
    const src = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/super/AgentCard.tsx'), 'utf-8');
    expect(src.match(/<ChildModelChip session=\{session\} child=\{child\} \/>/g)?.length).toBe(2);
    expect(src).toContain("{chip || tool !== 'claude'");
    // The name comes from the model picker's own rows, never a second map.
    expect(src).toContain('activeRow(own, model)');
    expect(src).toContain('[claudeState(modelConfig), ...(codexInfo ? [codexState(codexInfo)] : []), ...(antigravityInfo ? [codexState(antigravityInfo)] : [])]');
    expect(src).toContain("{tool !== 'claude' && <ToolMark tool={tool} />}");
    expect(src).toContain('title={words} aria-label={words}');
    expect(src).toMatch(/return session\?\.tool \|\| child\?\.tool \|\| 'claude';/);
  });
});

describe('the card names the model with the picker\'s words, never cut (owner 2026-11-02: "Gemini Flash mı, Luna mı")', () => {
  it('a picker label: Antigravity\'s level from its label, a Codex or Claude model keeps the effort', () => {
    expect(chipFromPickerLabel('Gemini 3.8 Flash (High)', 'gemini-3.8-flash-high', 'medium', 'antigravity')).toEqual({ name: 'Gemini 3.8 Flash', level: 'high' });
    expect(chipFromPickerLabel('Gemini 3.1 Pro (High)', 'gemini-pro-agent', null, 'antigravity')).toEqual({ name: 'Gemini 3.1 Pro', level: 'high' });
    expect(chipFromPickerLabel('GPT-6 Luna', 'gpt-6-luna', 'High', 'codex')).toEqual({ name: 'GPT-6 Luna', level: 'high' });
    expect(chipFromPickerLabel('Opus 5', 'claude-opus-5-5', 'xhigh', 'claude')).toEqual({ name: 'Opus 5', level: 'xhigh' });
  });

  it('an id the picker does not list: the raw id, never nothing; no id and no label: null', () => {
    expect(chipFromPickerLabel(null, 'gpt-9-preview', 'low', 'codex')).toEqual({ name: 'gpt-9-preview', level: 'low' });
    expect(chipFromPickerLabel(undefined, 'gemini-x', 'low', 'antigravity')).toEqual({ name: 'gemini-x', level: '' });
    expect(chipFromPickerLabel('', '', 'low', 'codex')).toBeNull();
  });

  it('the name never ellipsises: the chip wraps onto its own line, the level under the name', () => {
    const css = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/super/SuperSurface.css'), 'utf-8');
    const chip = /\.super-tile-model \{([^}]*)\}/.exec(css)![1]!;
    expect(chip).toContain('flex-wrap: wrap;');
    expect(chip).toContain('max-width: 100%;');
    expect(chip).not.toContain('text-overflow');
    expect(chip).not.toMatch(/(^|\s)height: 18px/);
    const name = /\.super-tile-model-name \{([^}]*)\}/.exec(css)![1]!;
    expect(name).not.toContain('ellipsis');
    expect(name).not.toContain('overflow: hidden');
    expect(css).toMatch(/\.super-tile-top \{[^}]*flex-wrap: wrap;/);
    expect(css).toMatch(/\.super-card-tags \{[^}]*flex-wrap: wrap;/);
  });
});

describe('a Codex child started with no model is recorded with the one it runs', () => {
  it('codexStartModel: the account default, else the first cached model, else gpt-5.5; the bridge uses the same', () => {
    const home = mkdtempSync(join(tmpdir(), 'dc-codexstart-'));
    try {
      expect(codexStartModel(home)).toBe('gpt-5.5');
      mkdirSync(join(home, '.codex'));
      writeFileSync(join(home, '.codex', 'models_cache.json'), JSON.stringify({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6 Luna' }] }));
      expect(codexStartModel(home)).toBe('gpt-6-luna');
      writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-6-sol"\n');
      expect(codexStartModel(home)).toBe('gpt-6-sol');
    } finally { rmSync(home, { recursive: true, force: true }); }
    const main = readFileSync(join(__dirname, '../../src/lib/t3-bridge/main.ts'), 'utf-8');
    expect(main).toContain("o.tool === 'claude' ? 'sonnet' : codexStartModel()");
    const sup = readFileSync(join(__dirname, '../../src/server/routes/super.ts'), 'utf-8');
    expect(sup).toContain("const recordModel = job.model || (job.tool === 'codex' ? safeCodexStartModel() : '');");
    expect(sup).toContain('...(recordModel ? { model: recordModel } : {})');
  });
});
