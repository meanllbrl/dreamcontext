/**
 * `super read` reads a BOUNDED tail (plan-r7 D10, AC12): never more than 256 KB from the end of
 * a transcript however large, never the whole file, never `foldJsonl`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readTail, renderTail } from '../../src/lib/super/transcript-tail.js';
import { MAX_READ_BYTES } from '../../src/lib/super/types.js';

let dir: string;
let big: string;
const line = (o: unknown) => `${JSON.stringify(o)}\n`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-tail-'));
  big = join(dir, 'big.jsonl');
  // ~50 MB: one large filler block, then the conversation's real end.
  const fd = openSync(big, 'w');
  const filler = line({ type: 'assistant', message: { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 - 80) }] } });
  for (let i = 0; i < 50; i += 1) writeSync(fd, filler);
  writeSync(fd, line({ type: 'user', message: { content: 'ship it' } }));
  writeSync(fd, line({ type: 'user', message: { content: [{ type: 'text', text: 'and the note' }, { type: 'text', text: '<super-agent-note> x </super-agent-note>' }] } }));
  writeSync(fd, line({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }, { type: 'text', text: 'Shipped v2.' }] } }));
  closeSync(fd);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('readTail', () => {
  it('reads at most 256 KB from the end of a 50 MB transcript', async () => {
    const t = await readTail(big, 10 * 1024 * 1024);
    expect(MAX_READ_BYTES).toBe(256 * 1024);
    expect(t.size).toBeGreaterThan(50 * 1000 * 1000);
    expect(t.bytesRead).toBeLessThanOrEqual(MAX_READ_BYTES);
    expect(t.truncated).toBe(true);
  });

  it('renders the end as dialogue and tool calls, skipping server-written blocks', async () => {
    const out = renderTail(await readTail(big, 8 * 1024));
    expect(out.split('\n')).toEqual(['Owner: ship it', 'Owner: and the note', '[tool: Bash]', 'Claude: Shipped v2.']);
  });

  it('a cut first line is dropped, not misread', () => {
    expect(renderTail({ truncated: true, text: '"half a line"}\n{"type":"user","message":{"content":"hello"}}\n' })).toBe('Owner: hello');
  });

  it('never reads the whole file nor folds it', () => {
    // Code only: the header comment names `foldJsonl` to say it is not used.
    const src = readFileSync(new URL('../../src/lib/super/transcript-tail.ts', import.meta.url), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(src).not.toMatch(/readFile\(|readFileSync|foldJsonl|createReadStream/);
  });
});
