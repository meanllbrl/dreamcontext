/**
 * Unit tests for `parseViewBlock` — the validator for the `dream-view` fence
 * (insight / checklist / pin / progress; `pin` has its own file).
 *
 * Two things carry the real risk here and are pinned hardest:
 *   • NOTHING THROWS — invalid JSON, `null`, an array, an unknown `type`, any cap breach.
 *   • EVERY DROP IS VISIBLE — a rejected block always leaves a notice naming what happened.
 *
 * The `chart` and `page` types this file used to cover retired on 2026-08-26; the
 * "retired types degrade loudly" block below is what stops an old transcript, or an agent
 * running on a stale briefing, from blanking a message.
 */
import { describe, it, expect } from 'vitest';
import {
  parseViewBlock, MAX_CHECKLIST_ITEMS, MAX_VIEW_BYTES, VIEW_TYPES,
} from '../../dashboard/src/lib/chatViewSpec.js';
import type {
  ChecklistViewSpec, InsightViewSpec,
} from '../../dashboard/src/lib/chatViewSpec.js';

describe('parseViewBlock — nothing throws', () => {
  const cases: [string, string][] = [
    ['invalid JSON', '{not json'],
    ['null', 'null'],
    ['an array', '[{"type":"insight","id":"x"}]'],
    ['a bare string', '"hello"'],
    ['a number', '42'],
    ['an empty object', '{}'],
    ['a type-less object', '{"id":"x"}'],
  ];

  it.each(cases)('handles %s without throwing, and says why', (_label, json) => {
    expect(() => parseViewBlock(json)).not.toThrow();
    const r = parseViewBlock(json);
    expect(r.view).toBeNull();
    expect(r.notices.length).toBeGreaterThan(0);
  });

  it('names the unknown type it was asked for', () => {
    const r = parseViewBlock('{"type":"timeline"}');
    expect(r.view).toBeNull();
    expect(r.notices.join(' ')).toContain('timeline');
  });

  it(`rejects a block over ${MAX_VIEW_BYTES / 1024}KB with a notice, before parsing it`, () => {
    const json = JSON.stringify({ type: 'insight', id: 'x', pad: 'a'.repeat(MAX_VIEW_BYTES) });
    const r = parseViewBlock(json);
    expect(r.view).toBeNull();
    expect(r.notices.some((n) => /limit/i.test(n))).toBe(true);
  });
});

/**
 * The retirement itself. `chart` and `page` are no longer types — but a transcript written
 * before 2026-08-26 still holds their fences, and an agent whose context predates the
 * briefing change can still emit one. Both must land on the ordinary unknown-type path:
 * a notice naming what was asked for, and the prose around it untouched.
 */
describe('parseViewBlock — the retired chart/page types', () => {
  it.each([
    ['chart', '{"type":"chart","render":"line","series":[{"name":"a","points":[{"t":"1","v":2}]}]}'],
    ['page', '{"type":"page","body":[{"kind":"card","title":"Golf GTI"}]}'],
  ])('%s degrades loudly instead of rendering or crashing', (name, json) => {
    const r = parseViewBlock(json);
    expect(r.view).toBeNull();
    expect(r.notices.join(' ')).toContain(name);
  });

  it('is gone from VIEW_TYPES, so the briefing lockstep can never re-name it', () => {
    expect(VIEW_TYPES as readonly string[]).not.toContain('chart');
    expect(VIEW_TYPES as readonly string[]).not.toContain('page');
    expect([...VIEW_TYPES]).toEqual(['insight', 'checklist', 'pin', 'progress']);
  });
});

describe('parseViewBlock — type: insight', () => {
  it('validates the minimal form — a slug is the whole payload', () => {
    const r = parseViewBlock('{"type":"insight","id":"weekly-active-users"}');
    expect(r.notices).toEqual([]);
    expect(r.view).toEqual({ type: 'insight', id: 'weekly-active-users' });
  });

  it('lowercases and trims the slug so a capitalized one still resolves', () => {
    const r = parseViewBlock('{"type":"insight","id":"  Weekly-Active-Users  "}');
    expect((r.view as InsightViewSpec).id).toBe('weekly-active-users');
  });

  it.each([
    ['missing', '{"type":"insight"}'],
    ['empty', '{"type":"insight","id":"   "}'],
    ['a path traversal', '{"type":"insight","id":"../../etc/passwd"}'],
    ['a slash', '{"type":"insight","id":"lab/reports"}'],
    ['leading dash', '{"type":"insight","id":"-nope"}'],
    ['not a string', '{"type":"insight","id":42}'],
    ['over 80 chars', `{"type":"insight","id":"${'a'.repeat(81)}"}`],
  ])('drops an insight whose id is %s, with a notice', (_label, json) => {
    const r = parseViewBlock(json);
    expect(r.view).toBeNull();
    expect(r.notices.some((n) => /id/i.test(n))).toBe(true);
  });

  it('accepts both views and falls back to the card for anything else, loudly', () => {
    expect((parseViewBlock('{"type":"insight","id":"x","view":"card"}').view as InsightViewSpec).view).toBe('card');
    expect((parseViewBlock('{"type":"insight","id":"x","view":"full"}').view as InsightViewSpec).view).toBe('full');
    const bad = parseViewBlock('{"type":"insight","id":"x","view":"hologram"}');
    expect((bad.view as InsightViewSpec).view).toBeUndefined();
    expect(bad.notices.join(' ')).toContain('hologram');
  });

  it('carries a breakdown pivot through, filter included', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'insight', id: 'signups-by-country',
      breakdown: { rows: 'country', cols: 'plan', filter: { device: 'ios' } },
    }));
    expect((r.view as InsightViewSpec).breakdown).toEqual({
      rows: 'country', cols: 'plan', filter: { device: 'ios' },
    });
  });

  it('drops only the malformed HALF of a breakdown, keeping the insight itself', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'insight', id: 'x',
      breakdown: { rows: 'country', cols: '<script>', filter: 'not-an-object' },
    }));
    const view = r.view as InsightViewSpec;
    expect(view.id).toBe('x');
    expect(view.breakdown).toEqual({ rows: 'country' });
  });

  it('omits an entirely unusable breakdown rather than carrying an empty object', () => {
    const r = parseViewBlock('{"type":"insight","id":"x","breakdown":{"rows":"<>"}}');
    expect((r.view as InsightViewSpec).breakdown).toBeUndefined();
  });

  it('never mutates: the spec carries no field that could write back to the insight', () => {
    // The whole safety argument for embedding a board card in a chat answer is that the
    // block is READ-ONLY. If a future field ever lets a message set a tweak, this fails.
    const r = parseViewBlock(JSON.stringify({
      type: 'insight', id: 'x', tweaks: { window: '90d' }, sync: true, binding: 'okr-1',
    }));
    expect(Object.keys(r.view as object).sort()).toEqual(['id', 'type']);
  });
});

describe('parseViewBlock — type: checklist', () => {
  const checklist = (extra: Record<string, unknown> = {}) => JSON.stringify({
    type: 'checklist', id: 'asc-api-key', title: 'App Store Connect API key',
    items: [{ id: '1', text: 'Open Users and Access' }],
    ...extra,
  });

  it('validates a well-formed checklist', () => {
    const r = parseViewBlock(checklist({
      intro: 'Follow these steps.', submitLabel: 'Send',
      items: [
        { id: '1', text: 'Open the page' },
        { id: '2', text: 'Generate a key', wants: 'secret' },
        { id: '3', text: 'Attach the file', hint: 'the .p8', wants: 'file' },
      ],
    }));
    expect(r.notices).toEqual([]);
    const view = r.view as ChecklistViewSpec;
    expect(view.type).toBe('checklist');
    expect(view.id).toBe('asc-api-key');
    expect(view.intro).toBe('Follow these steps.');
    expect(view.submitLabel).toBe('Send');
    expect(view.items).toEqual([
      { id: '1', text: 'Open the page' },
      { id: '2', text: 'Generate a key', wants: 'secret' },
      { id: '3', text: 'Attach the file', hint: 'the .p8', wants: 'file' },
    ]);
  });

  it('drops a checklist whose id has disallowed characters, with a notice', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'checklist', id: 'bad id!', title: 'T', items: [],
    }));
    expect(r.view).toBeNull();
    expect(r.notices.some((n) => /id/i.test(n))).toBe(true);
  });

  it('drops a checklist missing an id or a title', () => {
    expect(parseViewBlock(JSON.stringify({ type: 'checklist', title: 'T', items: [] })).view).toBeNull();
    expect(parseViewBlock(JSON.stringify({ type: 'checklist', id: 'x', items: [] })).view).toBeNull();
  });

  it('drops an item missing id or text, keeps the rest', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'checklist', id: 'x', title: 'T',
      items: [{ id: '1', text: 'kept' }, { id: '2' }, { text: 'no id' }],
    }));
    const view = r.view as ChecklistViewSpec;
    expect(view.items).toEqual([{ id: '1', text: 'kept' }]);
  });

  it('ignores an invalid "wants" value rather than rejecting the item', () => {
    const r = parseViewBlock(JSON.stringify({
      type: 'checklist', id: 'x', title: 'T',
      items: [{ id: '1', text: 'kept', wants: 'teleport' }],
    }));
    const view = r.view as ChecklistViewSpec;
    expect(view.items[0].wants).toBeUndefined();
  });

  it(`MAX_CHECKLIST_ITEMS: excess items dropped with a notice, first ${MAX_CHECKLIST_ITEMS} kept`, () => {
    const items = Array.from({ length: MAX_CHECKLIST_ITEMS + 6 }, (_, i) => ({ id: `${i}`, text: `t${i}` }));
    const r = parseViewBlock(checklist({ items }));
    const view = r.view as ChecklistViewSpec;
    expect(view.items.length).toBe(MAX_CHECKLIST_ITEMS);
    expect(view.items[0].id).toBe('0');
    expect(r.notices.some((n) => n.includes('6'))).toBe(true);
  });
});
