/**
 * `super read` defaults to the child's last reply, whole (field 2026-10-20/21: a 64 KB tail of a
 * 16 MB transcript ended in tool output and read as nothing; long replies were cut), and
 * `super state` fills each child's own `status` (it was null; the live row lived in `status[]`).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastReply } from '../../src/lib/super/transcript-tail.js';
import { childLastLine, liveChildStatus } from '../../src/server/routes/super.js';

let dir: string;
let big: string;
const line = (o: unknown) => `${JSON.stringify(o)}\n`;
const longReply = Array.from({ length: 40 }, (_, i) => `line ${i + 1} of the plan`).join('\n');

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-reply-'));
  big = join(dir, 'big.jsonl');
  const fd = openSync(big, 'w');
  const filler = line({ type: 'user', message: { content: [{ type: 'tool_result', content: 'y'.repeat(1024 * 1024 - 80) }] } });
  for (let i = 0; i < 8; i += 1) writeSync(fd, filler);
  writeSync(fd, line({ type: 'user', message: { content: 'plan it' } }));
  // One reply, two text blocks around a tool call, the CLI's one-line-per-block shape.
  writeSync(fd, line({ type: 'assistant', timestamp: '2026-10-21T10:00:00Z', message: { id: 'msg_1', content: [{ type: 'text', text: 'Here is the plan:' }] } }));
  writeSync(fd, line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: longReply }] } }));
  writeSync(fd, line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }));
  // A sub-agent's line is never the child's reply.
  writeSync(fd, line({ type: 'assistant', isSidechain: true, message: { id: 'msg_s', content: [{ type: 'text', text: 'sub-agent says hi' }] } }));
  // ~8 MB of tool output after it: the 64 KB tail sees nothing readable.
  for (let i = 0; i < 8; i += 1) writeSync(fd, filler);
  closeSync(fd);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readLastReply', () => {
  it('returns the last assistant reply whole from a 16 MB transcript ending in tool output', async () => {
    const r = await readLastReply(big);
    expect(r.size).toBeGreaterThan(16 * 1024 * 1024);
    expect(r.text).toBe(`Here is the plan:\n\n${longReply}`);
    expect(r.text.split('\n')).toHaveLength(42);
    expect(r.at).toBe('2026-10-21T10:00:00Z');
    expect(r.text).not.toContain('sub-agent');
  });

  it('stops at the scan bound instead of reading the whole file', async () => {
    const r = await readLastReply(big, 1024 * 1024);
    expect(r.text).toBe('');
    expect(r.scanned).toBeLessThanOrEqual(1024 * 1024 + 256 * 1024);
  });

  it('reads a reply on the file\'s first line and a reply with no message id', async () => {
    const f = join(dir, 'one.jsonl');
    writeFileSync(f, line({ type: 'assistant', message: { content: [{ type: 'text', text: 'only one' }] } }).trimEnd());
    expect((await readLastReply(f)).text).toBe('only one');
  });

  it('a usage-limit or API-error banner is not the reply: the one before it is', async () => {
    const f = join(dir, 'limit.jsonl');
    writeFileSync(f, [
      line({ type: 'assistant', message: { id: 'm1', content: [{ type: 'text', text: 'Real answer.' }] } }),
      line({ type: 'assistant', isApiErrorMessage: true, message: { id: 'm2', model: '<synthetic>', content: [{ type: 'text', text: 'You\'ve hit your session limit' }] } }),
    ].join(''));
    const r = await readLastReply(f);
    expect(r.text).toBe('Real answer.');
    // ...and says the child stopped there, so the older reply is not read as its latest word.
    expect(r.stoppedBy).toBe('banner');
    expect((await readLastReply(big)).stoppedBy).toBeUndefined();
  });

  it('answers empty when no reply exists yet', async () => {
    const f = join(dir, 'none.jsonl');
    writeFileSync(f, line({ type: 'user', message: { content: 'hello' } }));
    expect((await readLastReply(f)).text).toBe('');
  });
});

describe('super state: a child\'s live status', () => {
  it.each([
    [{}, 'working', false, 'working'],
    [{}, 'idle', false, 'idle'],
    [{}, 'asking', false, 'asking'],
    [{ endedAt: 1 }, null, false, 'ended'],
    [{ endedAt: 1 }, 'gone', true, 'ended'],
    [{ endedAt: 1 }, 'working', false, 'working'],
    [{}, null, true, 'parked'],
    [{}, 'gone', false, 'gone'],
  ] as const)('%o, activity %s, parked %s -> %s', (ch, act, parked, want) => {
    expect(liveChildStatus(ch, act, parked)).toBe(want);
  });

  const banner = 'You\'ve hit your session limit · resets 9:30pm (Europe/Istanbul)';

  it('never shows a limit banner as the last line, and no limit once the chat moved on', () => {
    expect(childLastLine(['did the thing', banner], 'working')).toEqual({ line: 'did the thing', limit: null });
  });

  it('reports the limit only while it is the newest text and nothing runs', () => {
    expect(childLastLine(['did the thing', banner], 'idle')).toEqual({ line: 'did the thing', limit: banner });
    expect(childLastLine([banner, 'back on another account'], 'idle')).toEqual({ line: 'back on another account', limit: null });
    expect(childLastLine([], 'gone')).toEqual({ line: '', limit: null });
  });
});
