/**
 * New work on a big idle Super child, and the folded texts a handoff turn carries (plan
 * super-cocuk-tasarruf D2, D3; criteria 4, 5 and 6, the pure parts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CARRIED_HEADING, newWorkLead, userTextsSinceSync, withCarriedTexts } from '../../src/lib/super/send-rotation.js';

const LADDER = { nudgeAt: 250_000 };
const base = { enabled: true, ctx: 300_000, ladder: LADDER, keep: false, task: null, tool: 'claude', record: null };

describe('newWorkLead', () => {
  it('a task child at or past its first rung gets one [dreamcontext] line naming tasks handoff with --next', () => {
    const line = newWorkLead({ ...base, task: 'orbit-checkout' })!;
    expect(line.startsWith('[dreamcontext]')).toBe(true);
    expect(line).toContain('~300k');
    expect(line).toContain('dreamcontext tasks handoff orbit-checkout');
    expect(line).toContain('--next');
    expect(line.split('\n')).toHaveLength(1);
    expect(newWorkLead({ ...base, ctx: 250_000, task: 'orbit-checkout' })).not.toBeNull();
  });

  it('a task-less child is told to hand the job back with the HANDOFF: mark', () => {
    const line = newWorkLead(base)!;
    expect(line).toContain('`HANDOFF:`');
    expect(line).not.toContain('tasks handoff');
  });

  it('no line: Eco off, --keep, a bridge child, under the rung, unread context', () => {
    expect(newWorkLead({ ...base, enabled: false })).toBeNull();
    expect(newWorkLead({ ...base, keep: true })).toBeNull();
    expect(newWorkLead({ ...base, tool: 'codex' })).toBeNull();
    expect(newWorkLead({ ...base, tool: 'antigravity' })).toBeNull();
    expect(newWorkLead({ ...base, ctx: 249_999 })).toBeNull();
    expect(newWorkLead({ ...base, ctx: null })).toBeNull();
  });

  it('no line on a pane whose record is pending or mid-rotation; a record stuck past 120 s no longer silences it', () => {
    const now = Date.parse('2026-11-22T10:10:00.000Z');
    expect(newWorkLead({ ...base, record: {}, now })).toBeNull();
    expect(newWorkLead({ ...base, record: { actedAt: '2026-11-22T10:09:30.000Z' }, now })).toBeNull();
    expect(newWorkLead({ ...base, record: { actedAt: '2026-11-22T10:07:00.000Z' }, now })).not.toBeNull();
    expect(newWorkLead({ ...base, record: { actedAt: '2026-11-22T10:09:30.000Z', consumedAt: '2026-11-22T10:09:40.000Z' }, now })).not.toBeNull();
    // A record a resume banner consumed (consumedAt, no actedAt) is done, not pending.
    expect(newWorkLead({ ...base, record: { consumedAt: '2026-11-22T10:09:40.000Z' }, now })).not.toBeNull();
  });
});

describe('userTextsSinceSync', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-send-rot-')); });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const FIXTURE = join(__dirname, '../fixtures/super-reply-sections/transcript.jsonl');

  it('reads the measured queued_command line, its <owner-msg> stub dropped per block', () => {
    const p = join(dir, 't.jsonl');
    writeFileSync(p, readFileSync(FIXTURE, 'utf-8'));
    const texts = userTextsSinceSync(p, Date.parse('2026-10-24T09:00:30.000Z'));
    expect(texts[0]).toBe('[About agenda line note=n4k2 section=waiting]\nline: "Pick the font for the Orbit pricing card"\n\nwhich one did we land on?');
    expect(texts.some((t) => t.includes('<owner-msg'))).toBe(false);
    // The first user turn (09:00:07) is before `since`.
    expect(texts.some((t) => t.includes('Is the Orbit checkout form'))).toBe(false);
  });

  it('plain user turns after since; slash echoes, task notifications, stubs and tool results are not carried', () => {
    const p = join(dir, 't.jsonl');
    const at = (s: number) => new Date(Date.parse('2026-11-22T10:00:00.000Z') + s * 1000).toISOString();
    const rec = (s: number, content: unknown, extra: Record<string, unknown> = {}) => JSON.stringify({ type: 'user', timestamp: at(s), message: { role: 'user', content }, ...extra });
    writeFileSync(p, [
      rec(1, 'before'),
      rec(20, '<command-name>/clear</command-name>'),
      rec(21, [{ type: 'text', text: '<task-notification>done</task-notification>' }]),
      rec(22, [{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
      rec(23, [{ type: 'text', text: 'also fix the footer' }, { type: 'text', text: '<owner-msg ref="abc"/>' }]),
      rec(24, 'meta', { isMeta: true }),
      JSON.stringify({ type: 'attachment', timestamp: at(25), attachment: { type: 'queued_command', prompt: 'and the header' } }),
      '{torn',
    ].join('\n'));
    expect(userTextsSinceSync(p, Date.parse(at(10)))).toEqual(['also fix the footer', 'and the header']);
  });

  it('an unreadable path carries nothing', () => {
    expect(userTextsSinceSync(join(dir, 'missing.jsonl'), 0)).toEqual([]);
    expect(userTextsSinceSync(null, 0)).toEqual([]);
  });

  it('withCarriedTexts: none = the prompt byte-identical; some = one fixed heading', () => {
    expect(withCarriedTexts('Handoff: continue.', [])).toBe('Handoff: continue.');
    expect(withCarriedTexts('Handoff: continue.', ['  '])).toBe('Handoff: continue.');
    const out = withCarriedTexts('Handoff: continue.', ['a', 'b']);
    expect(out).toBe(`Handoff: continue.\n\n${CARRIED_HEADING}\n---\na\n---\nb`);
  });
});
