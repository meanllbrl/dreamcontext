/**
 * The teammate list's transcript cache (src/lib/headless-teammate.ts `summarizeTeammateFile`) —
 * task: the desktop app stays light on an 8GB MacBook Air, plan S4.
 *
 * `/api/agent/teammates` is polled every 3 s per pane and used to re-read and re-parse every
 * teammate's transcript (up to 16 MB each) synchronously on each poll. The summary's
 * transcript-derived part is now cached by (path, size, mtime) and read asynchronously; the
 * status (clock + process table) is still computed per call.
 *
 * Isolation: HOME is a temp dir; transcripts are written under its `.claude/projects`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readTeammateTranscript, resetTeammateDigests, summarizeTeammateFile, summarizeTeammateTranscript, teammateDigestReads,
} from '../../src/lib/headless-teammate.js';

const SID = 'aaaaaaaa-1111-2222-3333-444444444444';
const T = (s: number) => new Date(Date.UTC(2026, 8, 26, 10, 0, s)).toISOString();
const enqueue = (prompt: string) => ({ type: 'queue-operation', operation: 'enqueue', timestamp: T(0), content: prompt, sessionId: SID });
const toolUse = (id: string, name: string) => ({
  type: 'assistant', message: { model: 'claude-opus-5-5', stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input: { file_path: 'a.ts' } }] },
});
const toolResult = (id: string) => ({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] } });
const exit = { type: 'cost-state', sessionId: SID, totalDuration: 1000 };
const jsonl = (rows: unknown[]) => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

let home: string;
let file: string;
const NOW = Date.parse(T(100));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'teammate-cache-'));
  const d = join(home, '.claude', 'projects', 'slug');
  mkdirSync(d, { recursive: true });
  file = join(d, `${SID}.jsonl`);
  resetTeammateDigests();
});

afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function oracle(alive: boolean | null) {
  const f = readTeammateTranscript(SID, home)!;
  return summarizeTeammateTranscript(SID, f.raw, f.mtimeMs, NOW, alive);
}

describe('summarizeTeammateFile', () => {
  it('equals the whole-text summary, and an unchanged file is read once', async () => {
    writeFileSync(file, jsonl([enqueue('go'), toolUse('t1', 'Read'), toolResult('t1'), toolUse('t2', 'Grep')]));
    for (const alive of [true, false, null] as const) {
      expect(await summarizeTeammateFile(SID, NOW, alive, home)).toEqual(oracle(alive));
    }
    expect(teammateDigestReads()).toBe(1);
  });

  it('a changed transcript is read again', async () => {
    writeFileSync(file, jsonl([enqueue('go'), toolUse('t1', 'Read')]));
    utimesSync(file, 1_000, 1_000);
    await summarizeTeammateFile(SID, NOW, true, home);
    appendFileSync(file, jsonl([toolResult('t1'), exit]));
    const s = await summarizeTeammateFile(SID, NOW, true, home);
    expect(s).toEqual(oracle(true));
    expect(s?.status).toBe('failed');
    expect(teammateDigestReads()).toBe(2);
  });

  it('a finished run rewriting its open steps never leaks into the cached digest', async () => {
    writeFileSync(file, jsonl([enqueue('go'), toolUse('t1', 'Read')]));
    // Stopped: the open step is shown as an error...
    expect((await summarizeTeammateFile(SID, NOW, false, home))?.steps[0].status).toBe('error');
    // ...but the same cached transcript, alive, still shows it running.
    expect((await summarizeTeammateFile(SID, NOW, true, home))?.steps[0].status).toBe('running');
    expect(teammateDigestReads()).toBe(1);
  });

  it('no transcript, or a non-UUID id, is null', async () => {
    expect(await summarizeTeammateFile(SID, NOW, true, home)).toBeNull();
    expect(await summarizeTeammateFile('../../etc/passwd', NOW, true, home)).toBeNull();
  });
});
