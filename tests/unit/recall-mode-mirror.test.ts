import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { RECALL_MODES, DEFAULT_RECALL_MODE } from '../../src/lib/recall-mode.js';

/**
 * The dashboard cannot import from `src/`, so it mirrors the recall modes in three
 * places: the `RecallMode` type (useSleep.ts), the Settings option list
 * (SettingsPage.tsx) and the i18n copy (I18nContext.tsx). A mirror that drifts
 * offers a mode the server rejects, or hides one it accepts.
 *
 * Same guard, same reason, as `sleep-prompt-mirror.test.ts`.
 */

const DASH = join(__dirname, '..', '..', 'dashboard', 'src');
const read = (rel: string): string => readFileSync(join(DASH, rel), 'utf8');

const useSleep = read('hooks/useSleep.ts');
const settings = read('pages/SettingsPage.tsx');
const i18n = read('context/I18nContext.tsx');
const useRecall = read('hooks/useRecall.ts');

/** The `{ mode: '…', … }` entries of RECALL_MODE_OPTIONS, in declaration order. */
function settingsOptions(): Array<{ mode: string; line: string }> {
  const start = settings.indexOf('const RECALL_MODE_OPTIONS');
  if (start < 0) throw new Error('RECALL_MODE_OPTIONS not found in SettingsPage.tsx');
  const end = settings.indexOf('];', start);
  return [...settings.slice(start, end).matchAll(/^\s*\{ mode: '([a-z]+)'.*\},?$/gm)]
    .map((m) => ({ mode: m[1], line: m[0] }));
}

describe('the recall-mode dashboard mirror', () => {
  it('useSleep.ts declares exactly the server RECALL_MODES', () => {
    const m = useSleep.match(/export type RecallMode =([^;]+);/);
    expect(m).not.toBeNull();
    const declared = [...m![1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
    expect([...declared].sort()).toEqual([...RECALL_MODES].sort());
  });

  it('the Settings radio list offers exactly the server modes, default first', () => {
    const modes = settingsOptions().map((o) => o.mode);
    expect([...modes].sort()).toEqual([...RECALL_MODES].sort());
    expect(modes[0]).toBe(DEFAULT_RECALL_MODE);
  });

  it('the dashboard falls back to the server default, not a retired mode', () => {
    expect(useSleep).toContain(`data?.recall_mode ?? '${DEFAULT_RECALL_MODE}'`);
    expect(settings).toContain(`sleepState?.recall_mode ?? '${DEFAULT_RECALL_MODE}'`);
  });

  it('every option has its label and hint copy', () => {
    for (const { mode } of settingsOptions()) {
      expect(i18n, `label for ${mode}`).toContain(`'settings.recall.${mode}.label'`);
      expect(i18n, `hint for ${mode}`).toContain(`'settings.recall.${mode}.hint'`);
    }
  });

  it('hybrid is the recommended choice and carries no experimental marker', () => {
    const hybrid = settingsOptions().find((o) => o.mode === 'hybrid');
    expect(hybrid).toBeDefined();
    expect(hybrid!.line).not.toMatch(/experimental/i);
    expect(i18n).toMatch(/'settings\.recall\.hybrid\.label': 'Hybrid \(recommended\)'/);
    expect(settings).not.toContain('settings.recall.experimental');
    expect(i18n).not.toContain('settings.recall.experimental');
  });

  it('the retired Haiku mode is gone from the dashboard recall surface', () => {
    expect(i18n).not.toContain('settings.recall.haiku');
    expect(useRecall).not.toContain('haikuRecallOnce');
    expect(useRecall).not.toContain('/recall/haiku');
    for (const rel of ['components/search/BrainSearch.tsx', 'components/search/CommandPalette.tsx']) {
      const src = read(rel);
      expect(src, rel).not.toContain('haikuRecallOnce');
      expect(src, rel).not.toContain('intelliMode');
    }
  });
});
