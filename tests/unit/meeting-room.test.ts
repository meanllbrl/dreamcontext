import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addVault } from '../../src/lib/vaults.js';
import {
  MAX_MEETING_BODY_CHARS,
  activeThread,
  appendMessage,
  closeActiveThread,
  createThread,
  isThreadId,
  listThreads,
  meetingRoster,
  readThread,
  sanitizeMeetingBody,
  setParticipantState,
} from '../../src/lib/meeting-room.js';
import { sanitizeBody as peerMailSanitize } from '../../src/lib/peer-mail.js';

let home: string;

const PARTICIPANTS = [
  { name: 'alpha', whatItIs: 'The alpha project.' },
  { name: 'beta', whatItIs: '' },
];

beforeEach(() => {
  home = join(tmpdir(), `dc-meeting-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(home, { recursive: true });
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('sanitizeMeetingBody', () => {
  it('PRESERVES newlines — a multiline markdown announcement survives', () => {
    const input = '# House rules\n\n1. one\n2. two\n\n```ts\nconst a = 1;\n```';
    expect(sanitizeMeetingBody(input)).toBe(input);
  });

  it('diverges from peer-mail sanitizeBody, which collapses the same newlines', () => {
    const input = 'line one\nline two';
    expect(sanitizeMeetingBody(input)).toContain('\n');
    expect(peerMailSanitize(input)).not.toContain('\n');
  });

  it('normalizes CRLF to LF', () => {
    expect(sanitizeMeetingBody('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips other control chars (NUL, ESC, backspace)', () => {
    expect(sanitizeMeetingBody('a\x00b\x1bc\x08d\x7f')).toBe('abcd');
  });

  it('caps at MAX_PROMPT_CHARS parity (8000)', () => {
    expect(MAX_MEETING_BODY_CHARS).toBe(8000);
    expect(sanitizeMeetingBody('x'.repeat(9000))).toHaveLength(8000);
  });

  it('null/undefined/whitespace-only sanitize to the empty string', () => {
    expect(sanitizeMeetingBody(undefined as unknown as string)).toBe('');
    expect(sanitizeMeetingBody('   \n\n  ')).toBe('');
  });
});

describe('thread store — the one-active-thread invariant', () => {
  it('creates a thread with the announcement as its root message', () => {
    const t = createThread({ body: 'Hello everyone\n\ndetails', participants: PARTICIPANTS }, home);
    expect(t).not.toBeNull();
    expect(isThreadId(t!.id)).toBe(true);
    expect(t!.closedAt).toBeNull();
    expect(t!.title).toBe('Hello everyone');
    expect(t!.messages).toHaveLength(1);
    expect(t!.messages[0].root).toBe(true);
    expect(t!.messages[0].authorKind).toBe('user');
    expect(t!.participants.map((p) => p.state)).toEqual(['idle', 'idle']);
  });

  it('AT MOST ONE thread has closedAt=null: a new thread closes the active one first', () => {
    const first = createThread({ body: 'first', participants: PARTICIPANTS }, home);
    const second = createThread(
      { body: 'second', participants: PARTICIPANTS },
      home,
      new Date(Date.now() + 10),
    );
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();

    const open = listThreads(home).filter((s) => s.closedAt === null);
    expect(open).toHaveLength(1);
    expect(open[0].id).toBe(second!.id);
    expect(readThread(first!.id, home)!.closedAt).not.toBeNull();
    expect(activeThread(home)!.id).toBe(second!.id);
  });

  it('holds across N successive posts, and history keeps every thread', () => {
    for (let i = 0; i < 4; i++) {
      createThread({ body: `post ${i}` , participants: PARTICIPANTS }, home, new Date(Date.now() + i * 10));
    }
    const all = listThreads(home);
    expect(all).toHaveLength(4);
    expect(all.filter((s) => s.closedAt === null)).toHaveLength(1);
  });

  it('closeActiveThread archives; a rejected empty announcement changes nothing', () => {
    const t = createThread({ body: 'only one', participants: PARTICIPANTS }, home);
    expect(createThread({ body: '   ', participants: PARTICIPANTS }, home)).toBeNull();
    // The empty post must NOT have closed the active thread as a side effect.
    expect(activeThread(home)!.id).toBe(t!.id);
    closeActiveThread(home);
    expect(activeThread(home)).toBeNull();
    expect(closeActiveThread(home)).toBeNull();
  });

  it('a CLOSED thread still accepts appends — in-flight runs land truthfully', () => {
    const t = createThread({ body: 'root', participants: PARTICIPANTS }, home);
    closeActiveThread(home);
    const late = appendMessage(
      t!.id,
      { author: 'alpha', authorKind: 'agent', body: 'late answer' },
      home,
    );
    expect(late).not.toBeNull();
    const read = readThread(t!.id, home)!;
    expect(read.closedAt).not.toBeNull();
    expect(read.messages.map((m) => m.body)).toEqual(['root', 'late answer']);
  });

  it('participant state transitions persist, and errors clear on recovery', () => {
    const t = createThread({ body: 'root', participants: PARTICIPANTS }, home);
    setParticipantState(t!.id, 'alpha', 'error', 'timed out', home);
    let p = readThread(t!.id, home)!.participants.find((x) => x.name === 'alpha')!;
    expect(p.state).toBe('error');
    expect(p.error).toBe('timed out');
    setParticipantState(t!.id, 'alpha', 'replied', undefined, home);
    p = readThread(t!.id, home)!.participants.find((x) => x.name === 'alpha')!;
    expect(p.state).toBe('replied');
    expect(p.error).toBeUndefined();
    // Unknown participant: no throw, no ghost entry.
    setParticipantState(t!.id, 'nobody', 'replied', undefined, home);
    expect(readThread(t!.id, home)!.participants).toHaveLength(2);
  });

  it('corrupt thread JSON reads as null, and listThreads skips it', () => {
    const t = createThread({ body: 'good', participants: PARTICIPANTS }, home);
    const badId = `${Date.now() + 50}-deadbeef`;
    writeFileSync(join(home, '.dreamcontext', 'meeting-room', 'threads', `${badId}.json`), '{nope', 'utf-8');
    expect(readThread(badId, home)).toBeNull();
    expect(listThreads(home).map((s) => s.id)).toEqual([t!.id]);
  });

  it('rejects a path-shaped thread id outright', () => {
    expect(() => readThread('../escape', home)).toThrow(/Malformed/);
  });
});

describe('meetingRoster', () => {
  it('lists registered vaults that exist on disk, and drops ones whose brain is gone', () => {
    const good = join(home, 'proj-good');
    const gone = join(home, 'proj-gone');
    for (const p of [good, gone]) mkdirSync(join(p, '_dream_context'), { recursive: true });
    addVault('good', good, home);
    addVault('gone', gone, home);
    rmSync(join(gone, '_dream_context'), { recursive: true, force: true });

    const roster = meetingRoster(home);
    expect(roster.map((r) => r.name)).toEqual(['good']);
    expect(roster[0].projectRoot).toBe(good);
  });
});
