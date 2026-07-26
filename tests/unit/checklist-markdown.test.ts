/**
 * Unit tests for `buildSubmitMarkdown` (chat-interactive-views plan §1.14, T3) —
 * the exact, frozen shape of the single chat message a checklist Submit sends.
 * Downstream agent behaviour is written against this format, so the pinned
 * example from the plan is asserted character-for-character, not just loosely.
 */
import { describe, it, expect } from 'vitest';
import { buildSubmitMarkdown, MAX_SUBMIT_BYTES } from '../../dashboard/src/lib/checklistMarkdown.js';
import { emptyState, checklistReducer, type ChecklistState } from '../../dashboard/src/lib/checklistState.js';
import type { ChecklistViewSpec } from '../../dashboard/src/lib/chatViewSpec.js';

function ascApiKeySpec(): ChecklistViewSpec {
  return {
    type: 'checklist',
    id: 'asc-api-key',
    title: 'App Store Connect API key',
    items: [
      { id: 'open-integrations', text: 'Open Users and Access → Integrations' },
      { id: 'paste-key', text: 'Generate a key, then paste it here', wants: 'secret' },
      { id: 'attach-p8', text: 'Download the .p8 and attach it', wants: 'file' },
    ],
  };
}

describe('buildSubmitMarkdown', () => {
  it('reproduces the plan\'s pinned example exactly', () => {
    const spec = ascApiKeySpec();
    let state: ChecklistState = emptyState(spec);
    state = checklistReducer(state, { t: 'toggle', id: 'open-integrations' });
    state = checklistReducer(state, {
      t: 'setNote', id: 'open-integrations', text: 'found it under the Keys tab, not Integrations',
    });
    state = checklistReducer(state, { t: 'toggle', id: 'paste-key' });
    state = checklistReducer(state, {
      t: 'setNote', id: 'attach-p8', text: 'the download button was greyed out',
    });
    state = checklistReducer(state, {
      t: 'addFile', id: 'attach-p8', paths: ['/Users/me/Downloads/AuthKey_7X4KJ2M9QP.p8'],
    });
    const secrets = { 'paste-key': '7X4KJ2M9QP' };

    const md = buildSubmitMarkdown(spec, state, secrets);

    expect(md).toBe(
      'Checklist: App Store Connect API key — 2 of 3 done.\n'
      + '\n'
      + '- [x] Open Users and Access → Integrations\n'
      + '  - note: found it under the Keys tab, not Integrations\n'
      + '- [x] Generate a key, then paste it here\n'
      + '  - note: 7X4KJ2M9QP\n'
      + '- [ ] Download the .p8 and attach it\n'
      + '  - note: the download button was greyed out\n'
      + '  - file: /Users/me/Downloads/AuthKey_7X4KJ2M9QP.p8',
    );
  });

  it('emits just the checkbox line for an item with no note and no file', () => {
    const spec: ChecklistViewSpec = {
      type: 'checklist', id: 'bare', title: 'Bare checklist',
      items: [{ id: 'a', text: 'Do the thing' }],
    };
    const md = buildSubmitMarkdown(spec, emptyState(spec), {});
    expect(md).toBe('Checklist: Bare checklist — 0 of 1 done.\n\n- [ ] Do the thing');
  });

  it('never emits a "- note:" line when there is nothing to show', () => {
    const spec: ChecklistViewSpec = {
      type: 'checklist', id: 'bare', title: 'Bare checklist',
      items: [{ id: 'a', text: 'Do the thing' }],
    };
    const md = buildSubmitMarkdown(spec, emptyState(spec), {});
    expect(md).not.toContain('note:');
  });

  it('the header count reflects doneCount / total, not the raw checked map', () => {
    const spec: ChecklistViewSpec = {
      type: 'checklist', id: 'x', title: 'X',
      items: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
    };
    let state = emptyState(spec);
    state = checklistReducer(state, { t: 'toggle', id: 'a' });
    const md = buildSubmitMarkdown(spec, state, {});
    expect(md.split('\n')[0]).toBe('Checklist: X — 1 of 3 done.');
  });

  it('truncates to whole items with a visible marker when the checklist exceeds MAX_SUBMIT_BYTES', () => {
    const itemCount = 60;
    const spec: ChecklistViewSpec = {
      type: 'checklist',
      id: 'huge',
      title: 'Huge checklist',
      items: Array.from({ length: itemCount }, (_, i) => ({ id: `item-${i}`, text: `Step ${i}` })),
    };
    let state = emptyState(spec);
    // ~900 bytes of note per item * 60 items well exceeds the 32 KB cap.
    const longNote = 'x'.repeat(900);
    for (let i = 0; i < itemCount; i++) {
      state = checklistReducer(state, { t: 'setNote', id: `item-${i}`, text: longNote });
    }

    const md = buildSubmitMarkdown(spec, state, {});
    const byteLength = new TextEncoder().encode(md).length;

    expect(byteLength).toBeLessThanOrEqual(MAX_SUBMIT_BYTES);
    expect(md).toMatch(/…\(\d+ items truncated — the checklist was too long to send whole\.\)$/);
    // Some but not all items survived — proves whole-item cutting, not an
    // all-or-nothing collapse.
    const survivingLines = md.match(/^- \[/gm) ?? [];
    expect(survivingLines.length).toBeGreaterThan(0);
    expect(survivingLines.length).toBeLessThan(itemCount);
  });

  it('does not truncate a normal-sized checklist', () => {
    const spec = ascApiKeySpec();
    const md = buildSubmitMarkdown(spec, emptyState(spec), {});
    expect(md).not.toContain('truncated');
  });
});
