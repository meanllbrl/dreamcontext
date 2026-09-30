/**
 * Editing an agent never saves the list preview as its prompt (2026-09-30).
 *
 * The edit dialog seeded its prompt field from `AutomationSummary.description`, which is the
 * prompt cut to 600 characters for the list. "Save and re-approve" wrote that back: the
 * `tarif-korpus-haftalik` manifest lost Adım 1-6 mid-word and was approved as such. Two
 * locks: the dialog reads the full prompt, and the server refuses the truncation from any
 * client still built the old way.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isPreviewTruncation } from '../../src/server/routes/automations.js';

const ROOT = join(import.meta.dirname, '..', '..');

describe('a save that is only the preview of a longer prompt is refused', () => {
  const long = `Sen bir ajansın. ${'Adım uzun bir metin. '.repeat(60)}Son satır.`;

  it('refuses exactly the 600-character preview, trimmed either way', () => {
    expect(isPreviewTruncation(long.trim().slice(0, 600), long)).toBe(true);
    expect(isPreviewTruncation(`  ${long.trim().slice(0, 600)}  `, `\n${long}\n`)).toBe(true);
  });

  it('lets a real edit through, and any edit of a short prompt', () => {
    expect(isPreviewTruncation(`${long} Bir satır daha.`, long)).toBe(false);
    expect(isPreviewTruncation(long.slice(0, 400), long)).toBe(false);
    expect(isPreviewTruncation('kısa', 'kısa')).toBe(false);
  });
});

describe('the edit dialog seeds its prompt from the manifest, not the preview', () => {
  const src = readFileSync(join(ROOT, 'dashboard/src/components/agents/AgentDialog.tsx'), 'utf-8');

  it('never initialises the prompt field from agent.description', () => {
    expect(src).not.toMatch(/useState\(\s*agent\?\.description/);
  });

  it('reads the full prompt from the detail route and gates Save on it', () => {
    expect(src).toContain('detail.isFetchedAfterMount ? detail.data?.automation.prompt');
    expect(src).toMatch(/const canSave = promptReady/);
  });
});
