/**
 * D3 carry (super-cocuk-tasarruf), criterion 5: a message folded into the acting turn after
 * `tasks handoff` wrote the record rides the continue prompt once, under one fixed heading. A
 * record from an earlier turn carries nothing, an unreadable transcript rotates as today, and a
 * turn with nothing after the record leaves the prompt byte-identical. Scratch vault, synthetic
 * "Acme" fixtures.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readHandoffRecord, writeHandoffRecord, type HandoffRecord } from '../../src/lib/context-watch.js';
import { handleRotationAtResult } from '../../src/server/routes/handoff-rotation.js';
import { CARRIED_HEADING } from '../../src/lib/super/send-rotation.js';

const PANE = '5f607182-93a4-4b5c-8d6e-7f8091a2b3c4';
let dir: string;
let root: string;
let transcript: string;

const T0 = Date.parse('2026-11-22T10:00:00.000Z');
const iso = (s: number) => new Date(T0 + s * 1000).toISOString();
const userLine = (s: number, text: string) => JSON.stringify({ type: 'user', timestamp: iso(s), message: { role: 'user', content: text } });
const record = (atS: number): HandoffRecord => ({ task: 'acme-build', title: 'Acme build', at: iso(atS), contextTokens: 150_000, fromSession: PANE, tab: null });

function rotate(o: { turnStartedAt?: number; transcriptPath?: string | null }): { decision: string; turns: string[] } {
  const turns: string[] = [];
  const decision = handleRotationAtResult({
    contextRoot: root, pane: PANE, isSuper: false, frame: { type: 'result' }, isLimit: false,
    observedConversation: PANE, lastMainContext: 150_000, writeUserTurn: (t) => turns.push(t), startRun: () => {},
    ...o,
  });
  return { decision, turns };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dc-rot-carry-'));
  root = join(dir, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  transcript = join(dir, 't.jsonl');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('the rotation carries what the old session got after its handoff entry', () => {
  it('a record written in this turn carries the later texts, once, under the fixed heading', () => {
    writeFileSync(transcript, [userLine(1, 'build the Acme page'), userLine(20, 'use the blue header')].join('\n') + '\n');
    writeHandoffRecord(root, PANE, record(10));
    const { decision, turns } = rotate({ turnStartedAt: T0, transcriptPath: transcript });
    expect(decision).toBe('record');
    expect(turns[0]).toBe('/clear');
    expect(turns[1]).toContain(CARRIED_HEADING);
    expect(turns[1]).toContain('use the blue header');
    expect(turns[1]).not.toContain('build the Acme page');
    expect(turns[1].split('use the blue header').length - 1).toBe(1);
    expect(readHandoffRecord(root, PANE)?.actedAt).toBeTruthy();
  });

  it('a record from an earlier turn carries nothing: the prompt is the one with no carry', () => {
    writeFileSync(transcript, userLine(20, 'use the blue header') + '\n');
    writeHandoffRecord(root, PANE, record(10));
    const carried = rotate({ turnStartedAt: T0 + 15_000, transcriptPath: transcript }).turns[1];
    writeHandoffRecord(root, PANE, record(10));
    const plain = rotate({ turnStartedAt: 0, transcriptPath: transcript }).turns[1];
    expect(carried).not.toContain(CARRIED_HEADING);
    expect(carried).toBe(plain);
  });

  it('nothing after the record, or an unreadable transcript: byte-identical to no carry', () => {
    writeFileSync(transcript, userLine(1, 'build the Acme page') + '\n');
    writeHandoffRecord(root, PANE, record(10));
    const none = rotate({ turnStartedAt: T0, transcriptPath: transcript }).turns[1];
    writeHandoffRecord(root, PANE, record(10));
    const missing = rotate({ turnStartedAt: T0, transcriptPath: join(dir, 'missing.jsonl') }).turns[1];
    writeHandoffRecord(root, PANE, record(10));
    const plain = rotate({ turnStartedAt: 0, transcriptPath: null }).turns[1];
    expect(none).toBe(plain);
    expect(missing).toBe(plain);
  });
});
