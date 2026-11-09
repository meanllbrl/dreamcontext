/**
 * Owner 2026-11-09 (kitup): a Super refused a child's long shell command "whose end I couldn't
 * see", and the job stalled. The registry cut the command at 600 characters for the card, and
 * the Super's `event=permission` line was built from that cut text.
 *
 *  - the registry keeps the short line for cards AND the whole command for a decider;
 *  - the Super's event line carries the whole command, whatever the card shows;
 *  - its rule says a long or chained command is read in full, splitting is a last resort.
 *
 * Scratch HOME and vault only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-perm-full-home-`);
});

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PERMISSION_FULL_CAP, _resetChatRegistry, readPendingQuestion, registerChat } from '../../src/lib/assistant/chat-registry.js';
import { PERMISSION_LINE, superBatchText } from '../../src/lib/super/inbox.js';
import { emptySuperState, type SuperQueueItem, type SuperState } from '../../src/lib/super/types.js';

// A fictional chained command well past the card's 600 characters, its delete at the very end.
const steps = Array.from({ length: 30 }, (_, i) => `python3 /tmp/orbit-job/label_${i}.py --set gold --out /tmp/orbit-job/out_${i}.json`);
const LONG = `${steps.join(' && ')} && rm -rf /tmp/orbit-job/scratch`;
const frame = (command: string, id = 'r-long') => ({
  type: 'control_request', request_id: id,
  request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command, description: 'Label the gold set' }, decision_reason: 'Dangerous rm operation not ruled out', decision_reason_type: 'safetyCheck' },
});

describe('the registry keeps the whole command beside the card line', () => {
  it('a long command: the card line is cut, the decider text is whole', () => {
    expect(LONG.length).toBeGreaterThan(600);
    const q = readPendingQuestion(frame(LONG));
    expect(q?.text.length).toBe(601);
    expect(q?.text.endsWith('…')).toBe(true);
    expect(q?.fullText).toBe(LONG);
  });
  it('a short command carries no second copy', () => {
    const q = readPendingQuestion(frame('rm -rf /tmp/orbit-job/scratch'));
    expect(q?.text).toBe('rm -rf /tmp/orbit-job/scratch');
    expect(q?.fullText).toBeUndefined();
  });
  it('past the decider ceiling it is cut too, and says so', () => {
    const huge = 'x'.repeat(PERMISSION_FULL_CAP + 50);
    const q = readPendingQuestion(frame(huge));
    expect(q?.fullText?.length).toBe(PERMISSION_FULL_CAP + 1);
    expect(q?.fullText?.endsWith('…')).toBe(true);
  });
});

describe('the Super decides on the whole command', () => {
  let root: string;
  beforeEach(() => {
    _resetChatRegistry();
    root = mkdtempSync(join(tmpdir(), 'super-perm-full-'));
    mkdirSync(join(root, '_dream_context'), { recursive: true });
  });
  afterEach(() => { _resetChatRegistry(); rmSync(root, { recursive: true, force: true }); });

  it('its event=permission line holds the full command, not the card\'s cut line', () => {
    const h = registerChat({ sessionId: 'kid-1', conversationId: null, vault: 'orbit', mode: 'basic' });
    h.userSent('label the gold set');
    h.observe(frame(LONG));
    const s: SuperState = {
      ...emptySuperState(), session: 'sup', enabled: true,
      children: { 'kid-1': { sessionId: 'kid-1', brief: 'Persona v2 gold set', adopted: false, startedAt: 1, row: 'asking' } },
      queue: [{ id: 'q-p-00000001', sessionId: 'kid-1', kind: 'permission', requestId: 'r-long', state: 'pending', createdAt: 2, toSuper: true }] as SuperQueueItem[],
    };
    const text = superBatchText(root, s, s.queue, 'b1');
    expect(text).toContain('event=permission');
    expect(text).toContain('request=r-long');
    const wants = text.split('\n').find((l) => l.includes('Wants to run:')) ?? '';
    expect(wants).toContain('rm -rf /tmp/orbit-job/scratch');
    expect(wants).not.toContain('…');
    expect(text).toContain(LONG);
  });

  it('its rule: read a long or chained command in full; splitting is a last resort', () => {
    expect(PERMISSION_LINE).toContain('read all of it, every part of a chain');
    expect(PERMISSION_LINE).toContain('never by itself a reason to deny');
    expect(PERMISSION_LINE).toContain('a last resort');
  });
});
