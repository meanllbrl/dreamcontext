/**
 * Unit tests for `parseViewBlock` — the validator for the `dream-view` fence
 * (insight / checklist / secret / run / pin / progress; `pin` has its own file).
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
  MAX_SECRET_FIELDS, MAX_RUN_COMMAND_CHARS,
} from '../../dashboard/src/lib/chatViewSpec.js';
import type {
  ChecklistViewSpec, InsightViewSpec, SecretViewSpec, RunViewSpec,
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
    expect([...VIEW_TYPES]).toEqual(['insight', 'checklist', 'secret', 'run', 'pin', 'progress', 'checkout']);
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

describe('parseViewBlock — type: secret', () => {
  const ok = '{"type":"secret","id":"fb","title":"Firebase token","fields":[{"key":"FIREBASE_TOKEN"}]}';

  it('accepts a minimal card and defaults the file to .env', () => {
    const r = parseViewBlock(ok);
    expect(r.notices).toEqual([]);
    const v = r.view as SecretViewSpec;
    expect(v).toMatchObject({ type: 'secret', id: 'fb', title: 'Firebase token', file: '.env' });
    expect(v.fields).toEqual([{ key: 'FIREBASE_TOKEN' }]);
  });

  it('keeps a .env-family path, including one in a subdirectory', () => {
    for (const file of ['.env.local', 'functions/.env']) {
      const r = parseViewBlock(`{"type":"secret","id":"a","title":"T","file":${JSON.stringify(file)},"fields":[{"key":"K"}]}`);
      expect((r.view as SecretViewSpec).file).toBe(file);
      expect(r.notices).toEqual([]);
    }
  });

  it.each([
    ['an absolute path', '/etc/passwd'],
    ['a traversal', '../.env'],
    ['a non-dotenv file', 'src/config.ts'],
  ])('falls back to .env and says so for %s', (_label, file) => {
    const r = parseViewBlock(`{"type":"secret","id":"a","title":"T","file":${JSON.stringify(file)},"fields":[{"key":"K"}]}`);
    expect((r.view as SecretViewSpec).file).toBe('.env');
    expect(r.notices.join(' ')).toMatch(/\.env-family/);
  });

  it('drops a field whose key is not an environment variable name, loudly', () => {
    const r = parseViewBlock('{"type":"secret","id":"a","title":"T","fields":[{"key":"A-B"},{"key":"OK"}]}');
    expect((r.view as SecretViewSpec).fields).toEqual([{ key: 'OK' }]);
    expect(r.notices.join(' ')).toMatch(/not a valid environment variable name/);
  });

  it('skips a card with no usable field rather than drawing an empty one', () => {
    const r = parseViewBlock('{"type":"secret","id":"a","title":"T","fields":[]}');
    expect(r.view).toBeNull();
    expect(r.notices.join(' ')).toMatch(/names no environment variable/);
  });

  it.each([
    ['no id', '{"type":"secret","title":"T","fields":[{"key":"K"}]}'],
    ['an id with a slash', '{"type":"secret","id":"a/b","title":"T","fields":[{"key":"K"}]}'],
    ['no title', '{"type":"secret","id":"a","fields":[{"key":"K"}]}'],
  ])('skips a card with %s, and says why', (_label, json) => {
    const r = parseViewBlock(json);
    expect(r.view).toBeNull();
    expect(r.notices.length).toBeGreaterThan(0);
  });

  it('caps the field count loudly', () => {
    const fields = Array.from({ length: MAX_SECRET_FIELDS + 3 }, (_, i) => `{"key":"K${i}"}`).join(',');
    const r = parseViewBlock(`{"type":"secret","id":"a","title":"T","fields":[${fields}]}`);
    expect((r.view as SecretViewSpec).fields).toHaveLength(MAX_SECRET_FIELDS);
    expect(r.notices.join(' ')).toMatch(/3 were dropped/);
  });
});

describe('parseViewBlock — type: run', () => {
  it('accepts a command and keeps it verbatim', () => {
    const r = parseViewBlock('{"type":"run","id":"fb","command":"firebase login","why":"opens a browser"}');
    expect(r.notices).toEqual([]);
    expect(r.view).toEqual({ type: 'run', id: 'fb', command: 'firebase login', why: 'opens a browser' });
  });

  it('keeps a relative cwd and refuses one that escapes', () => {
    expect((parseViewBlock('{"type":"run","id":"a","command":"ls","cwd":"functions"}').view as RunViewSpec).cwd)
      .toBe('functions');
    const escaped = parseViewBlock('{"type":"run","id":"a","command":"ls","cwd":"../.."}');
    expect((escaped.view as RunViewSpec).cwd).toBeUndefined();
    expect(escaped.notices.join(' ')).toMatch(/inside the project/);
    const absolute = parseViewBlock('{"type":"run","id":"a","command":"ls","cwd":"/etc"}');
    expect((absolute.view as RunViewSpec).cwd).toBeUndefined();
  });

  it('skips a multi-line command — a card must show in full what it will run', () => {
    const r = parseViewBlock('{"type":"run","id":"a","command":"echo one\\necho two"}');
    expect(r.view).toBeNull();
    expect(r.notices.join(' ')).toMatch(/several lines/);
  });

  it('skips a command past the cap and names the way out', () => {
    const r = parseViewBlock(`{"type":"run","id":"a","command":"${'x'.repeat(MAX_RUN_COMMAND_CHARS + 1)}"}`);
    expect(r.view).toBeNull();
    expect(r.notices.join(' ')).toMatch(/Write it to a script/);
  });

  it.each([
    ['no command', '{"type":"run","id":"a"}'],
    ['an empty command', '{"type":"run","id":"a","command":"   "}'],
    ['no id', '{"type":"run","command":"ls"}'],
  ])('skips a card with %s, and says why', (_label, json) => {
    const r = parseViewBlock(json);
    expect(r.view).toBeNull();
    expect(r.notices.length).toBeGreaterThan(0);
  });

  it('does NOT vet the command itself — the user reads it and presses the button', () => {
    // Pinned deliberately: a future "safety" allowlist here would be theatre (the agent can
    // spell the same command another way) and would imply a check the surface does not do.
    const r = parseViewBlock('{"type":"run","id":"a","command":"rm -rf ./build && npm ci"}');
    expect((r.view as RunViewSpec).command).toBe('rm -rf ./build && npm ci');
    expect(r.notices).toEqual([]);
  });
});
