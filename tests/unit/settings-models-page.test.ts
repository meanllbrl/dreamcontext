/**
 * Settings window → Models (task settings-konuya-gore-17-menuye…, wave 3): one chip per job on
 * its existing key, sleep helpers that follow the Sleep line until pinned, one tab per tool with
 * its own accounts and limit rules, and no select anywhere.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { thresholdChoices } from '../../dashboard/src/components/settings/window/ToolRules';

const read = (rel: string) => readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', rel), 'utf-8');
const chip = read('components/settings/window/ModelChip.tsx');
const jobs = read('components/settings/window/JobChip.tsx');
const page = read('components/settings/window/pages/ModelsPage.tsx');
const rules = read('components/settings/window/ToolRules.tsx');
const win = read('components/settings/window/SettingsWindow.tsx');

describe('one chip per job', () => {
  it('every job writes its existing key', () => {
    // Chat: the tool and that tool's own default.
    expect(jobs).toMatch(/\{ chatDefaultTool: 'codex', codexDefaultModel: model \}/);
    expect(jobs).toMatch(/\{ chatDefaultTool: '', chatDefaultModel: model \}/);
    expect(jobs).toMatch(/onCodex \? \{ codexDefaultEffort: effort \} : \{ chatDefaultEffort: effort \}/);
    expect(jobs).toMatch(/write\(\{ superModel: model \}\)/);
    expect(jobs).toMatch(/write\(\{ superEffort: effort \}\)/);
    expect(jobs).toMatch(/saveProfile\(patch\)/);
    // Sleep: the line, through /api/config.
    expect(jobs).toMatch(/update\.mutateAsync\(\{ sleep: patch \}\)/);
  });

  it('Super, Assistant and Sleep show Codex passive with the reason', () => {
    expect(jobs).toMatch(/lockedTools: \{ codex: t\('shell\.sw\.locked\.super'\) \}/);
    expect(jobs).toMatch(/lockedTools: \{ codex: t\('shell\.sw\.locked\.assistant'\) \}/);
    expect(jobs.match(/lockedTools: \{ codex: t\('shell\.sw\.locked\.sleep'\) \}/g)?.length).toBe(2);
    expect(jobs).toMatch(/efforts: \[\.\.\.SLEEP_EFFORT_OPTIONS\]/);
  });

  it('a pick writes a saved default only: no chat is touched and no select is drawn', () => {
    for (const src of [chip, jobs, page, rules]) {
      expect(src).not.toMatch(/<select/);
      expect(src).not.toMatch(/setModel\(|onModelChange=\{onModelChange\}|pickTool\(/);
    }
    expect(chip).toMatch(/target=\{target \?\? \{\}\}/);
  });

  it('Esc closes the picker only: the window steps aside for `.sw-popover`', () => {
    expect(chip).toMatch(/className="sw-popover"/);
    const at = chip.indexOf("if (e.key !== 'Escape') return;");
    expect(chip.slice(at, at + 200)).toMatch(/e\.stopPropagation\(\);\s*setOpen\(false\);/);
    expect(win).toMatch(/document\.querySelector\('\.sw-popover, \[data-sw-modal\], \.sw \.ss-pop'\)/);
  });

  it('every page\'s model row is the same chip', () => {
    expect(win).toMatch(/<JobChip job=\{job\}/);
  });
});

describe('sleep helpers', () => {
  it('follow the line until pinned, and ↺ returns them', () => {
    expect(jobs).toMatch(/model: config\?\.sleep\?\.model \?\? shipped\?\.\[name\]\?\.model \?\? ''/);
    expect(jobs).toMatch(/inherited=\{!pinned\}/);
    expect(jobs).toMatch(/update\.mutateAsync\(\{ sleep: \{ specialists: \{ \[name\]: patch \} \} \}\)/);
    expect(jobs).toMatch(/onClick=\{\(\) => write\(null\)\}/);
  });
});

describe('tool tabs', () => {
  it('Defaults, Claude Code, Codex, Antigravity, OpenCode, in that order', () => {
    const ids = [...page.matchAll(/\{ id: '([a-z]+)', name: /g)].map((m) => m[1]);
    expect(ids).toEqual(['defaults', 'claude', 'codex', 'antigravity', 'opencode']);
  });

  it('each tool tab: whether it is used, its accounts, its own limit rules', () => {
    expect(page).toMatch(/<ClaudeAccounts policy=\{false\} \/>/);
    expect(page).toMatch(/<ToolRules tool="claude"/);
    expect(page).toMatch(/<CodexAccounts \/>/);
    expect(page).toMatch(/<ToolRules tool="codex"/);
    // Claude is always on; Codex shows its state, never a "Use Codex" toggle.
    expect(page).not.toMatch(/<Toggle/);
  });

  it('Antigravity and OpenCode are passive and say why, with no accounts', () => {
    const later = page.slice(page.indexOf('function LaterTab'));
    expect(later).toMatch(/why=\{t\('shell\.sw\.models\.later\.why'\)\}/);
    expect(later).not.toMatch(/Accounts|ToolRules/);
  });

  it('every group carries its tab, so a search hit jumps there', () => {
    expect(page).toMatch(/<SettingGroup tab="defaults">/);
    expect(page).toMatch(/<SettingGroup tab=\{tool\}>/);
    expect(rules).toMatch(/<SettingGroup tab=\{tool\} title=\{t\('shell\.sw\.rules'\)\}>/);
  });
});

describe('limit rules', () => {
  it('write one tool at a time through the rules route', () => {
    expect(rules).toMatch(/api\.post<RulesResponse>\('\/agent\/accounts\/rules', \{ tool, patch \}\)/);
    for (const k of ['autoSwitch: v', 'strategy: v', 'agentThreshold: Number(v)', 'onExhausted: v']) expect(rules).toContain(`post({ ${k} })`);
  });

  it('When every account is out defaults to Stop', () => {
    expect(rules).toMatch(/value=\{r\?\.onExhausted \?\? 'stop'\}/);
  });

  it('a weight commits only itself', () => {
    expect(rules).toMatch(/onSave\(\{ \[k\]: n \}\)/);
  });

  it('a stored threshold outside 70/80/90 stays an option', () => {
    expect(thresholdChoices(80)).toEqual([70, 80, 90]);
    expect(thresholdChoices(75)).toEqual([70, 75, 80, 90]);
    expect(thresholdChoices(undefined)).toEqual([70, 80, 90]);
  });
});

describe('a passive Assistant chip says why in its row', () => {
  it('the row carries the reason when there is no assistant', () => {
    const models = readFileSync(join(__dirname, '..', '..', 'dashboard', 'src', 'components', 'settings', 'window', 'pages', 'ModelsPage.tsx'), 'utf-8');
    expect(models).toMatch(/why=\{j\.job === 'assistant' && noAssistant \? t\('shell\.sw\.models\.noAssistant'\) : undefined\}/);
  });
});
