/**
 * The new Settings (task codex-tarzi-yeni-kabuk W2-C, AC 12): the four groups stand, search
 * finds rows by name and hint, Models has New chats, Super Agent, Assistant and Sleep each on
 * its existing key, Eco mode writes the brain-local default, no language picker, no Save
 * button; everything new is gated on the new shell, so classic Settings is unchanged.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { queryWords, textMatches } from '../../dashboard/src/components/settings/settingsSearch.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../../dashboard/src/${rel}`, import.meta.url)), 'utf-8');
const page = read('pages/SettingsPage.tsx');
const models = read('components/settings/ModelsSection.tsx');

describe('settings search', () => {
  it('matches every word of the query, any case, anywhere in the text', () => {
    expect(queryWords('  Super   MODEL ')).toEqual(['super', 'model']);
    expect(textMatches('Super Agent model — Opus at high', queryWords('model super'))).toBe(true);
    expect(textMatches('Super Agent', queryWords('super model'))).toBe(false);
  });

  it('draws every section while a query is typed, and only in the new shell', () => {
    expect(page).toMatch(/const searching = newShell && query\.trim\(\) !== '';/);
    expect(page).toMatch(/const show = \(id: SettingsSectionId\) => searching \|\| activeSection === id;/);
    // No section is gated on the active one alone any more: classic's `show` is exactly that.
    expect(page).not.toMatch(/\{activeSection === '[a-z]+' &&/);
  });

  it('paints matches with the Highlight API, never by rewriting markup', () => {
    const src = read('components/settings/settingsSearch.ts');
    expect(src).toMatch(/new HighlightCtor\(\.\.\.ranges\)/);
    expect(src).not.toMatch(/innerHTML|dangerouslySetInnerHTML/);
  });
});

describe('Models', () => {
  it('is a This machine section the new shell alone offers', () => {
    expect(page).toMatch(/\{ id: 'models', labelKey: 'shell\.settings\.models', newShellOnly: true \}/);
    expect(page).toMatch(/\(!item\.newShellOnly \|\| newShell\)/);
  });

  it('each row saves its existing key', () => {
    // Through patchAgentSettings, and a refused write is not shown as saved.
    expect(models).toMatch(/const r = await patchAgentSettings\(patch\)/);
    expect(models).toMatch(/patchOrThrow\(\{ chatDefaultModel: v \}\)/);
    expect(models).toMatch(/patchOrThrow\(\{ chatDefaultEffort: v \}\)/);
    expect(models).toMatch(/patchOrThrow\(\{ superModel: v \}\)/);
    expect(models).toMatch(/patchOrThrow\(\{ superEffort: v \}\)/);
    expect(models).toMatch(/saveProfile\(\{ model: v \}\)/);
    expect(models).toMatch(/saveProfile\(\{ effort: v \}\)/);
    // Sleep: every specialist at once through /api/config.
    expect(models).toMatch(/SLEEP_SPECIALISTS\.map\(\(n\) => \[n, \{ \[field\]: value === '' \? null : value \}\]\)/);
    expect(models).toMatch(/updateConfig\.mutateAsync\(\{ sleep: \{ specialists: patch as never \} \}\)/);
  });

  it('the Super Agent rows move to Models in the new shell and stay in classic', () => {
    expect(page).toMatch(/\{newShell \? \(\s*<SettingRow\s*title=\{t\('settings\.agents\.super_model'\)\}\s*hint=\{t\('shell\.settings\.models\.moved'\)\}/);
    expect(page).toMatch(/data-testid="settings-super-model"/);
  });

  it('no AI Team or Short text row, no language picker, no Save button', () => {
    expect(models).not.toMatch(/aiTeam|shortText/i);
    expect(page).not.toMatch(/language-picker|setLocale\(/);
    expect(models).not.toMatch(/>\s*Save\s*</);
  });
});

describe('Eco mode', () => {
  it('sits in the Chat section in the new shell and writes through its own route', () => {
    expect(page).toMatch(/\{newShell && <EcoModeRow \/>\}/);
    const row = read('components/settings/EcoModeRow.tsx');
    expect(row).toMatch(/api\.post<HandoffDefault>\('\/agent\/context-handoff-default', \{ enabled: next \}\)/);
  });
});
