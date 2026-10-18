import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  analyzeTranscript, analyzeTranscriptResumable, readSessionAnalysisCache, writeSessionAnalysisCache,
  type SessionAnalysisCache,
} from '../../src/cli/commands/hook.js';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-incr-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const at = (min: number) => new Date(Date.parse('2026-10-18T10:00:00.000Z') + min * 60_000).toISOString();

/**
 * Records in the shapes the analysis reads: typed user turns (one with a decision phrase),
 * assistant text and tool_use blocks written one record per block with the message's usage
 * repeated (and growing), task slugs from a command and from a task file path, records keyed by
 * uuid or by nothing at all, a malformed line, and timestamps on both sides of a bound.
 */
function records(n: number, offset = 0): string[] {
  const out: string[] = [];
  for (let i = offset; i < offset + n; i++) {
    out.push(JSON.stringify({ type: 'user', timestamp: at(i), uuid: `u-${i}`, message: { role: 'user', content: i % 3 === 0 ? `we decided to use plan ${i} instead of the old one` : `next step ${i}` } }));
    const id = `msg_${i}`;
    out.push(JSON.stringify({ type: 'assistant', timestamp: at(i), message: { id, role: 'assistant', content: [{ type: 'text', text: `working on ${i}. `.repeat(20) }], usage: { input_tokens: 3, cache_creation_input_tokens: 1000 + i, output_tokens: 10 } } }));
    out.push(JSON.stringify({ type: 'assistant', timestamp: at(i), message: { id, role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: i % 2 ? 'Edit' : 'Bash', input: i % 2 ? { file_path: `/p/_dream_context/state/task-${i % 4}.md` } : { command: `dreamcontext tasks log slug-${i % 5} "x"` } }], usage: { input_tokens: 3, cache_creation_input_tokens: 1000 + i, output_tokens: 50 + i } } }));
    out.push(JSON.stringify({ type: 'user', timestamp: at(i), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'ok\n'.repeat(5) }] } }));
    if (i % 7 === 0) out.push(JSON.stringify({ type: 'assistant', timestamp: at(i), message: { role: 'assistant', content: [{ type: 'text', text: 'no id, no uuid' }], usage: { output_tokens: 5 } } }));
    if (i % 11 === 0) out.push('{"broken": ');
  }
  return out;
}

const SINCE = at(5);

describe('analyzeTranscriptResumable', () => {
  it('a transcript that only grows gives the full parse at every step, cut on any byte', () => {
    const path = join(dir, 's.jsonl');
    const all = records(40).join('\n') + '\n';
    const cuts = [0, 777, 2048, 2049, 9000, all.length - 30, all.length];
    const cache: SessionAnalysisCache = { entries: {} };
    writeFileSync(path, '');
    let written = 0;
    for (const cut of cuts) {
      appendFileSync(path, all.slice(written, cut));
      written = cut;
      for (const since of [SINCE]) {
        expect(analyzeTranscriptResumable(path, since, {}, cache)).toEqual(analyzeTranscript(path, since));
      }
    }
    expect(cache.entries[path].size).toBe(Buffer.byteLength(all));
  });

  it('agrees without a bound and without the startup subtraction (sub-agent transcripts)', () => {
    const path = join(dir, 's.jsonl');
    const cache: SessionAnalysisCache = { entries: {} };
    writeFileSync(path, records(10).join('\n') + '\n');
    expect(analyzeTranscriptResumable(path, null, { subtractStartup: false }, cache)).toEqual(analyzeTranscript(path, null, { subtractStartup: false }));
    appendFileSync(path, records(10, 10).join('\n') + '\n');
    expect(analyzeTranscriptResumable(path, null, { subtractStartup: false }, cache)).toEqual(analyzeTranscript(path, null, { subtractStartup: false }));
  });

  it('a trailing partial line counts like a full parse counts it, and is re-read once complete', () => {
    const path = join(dir, 's.jsonl');
    const cache: SessionAnalysisCache = { entries: {} };
    const lines = records(6);
    writeFileSync(path, lines.slice(0, -1).join('\n') + '\n' + lines[lines.length - 1]); // last record has no newline yet
    expect(analyzeTranscriptResumable(path, SINCE, {}, cache)).toEqual(analyzeTranscript(path, SINCE));
    appendFileSync(path, '\n' + records(3, 6).join('\n') + '\n');
    expect(analyzeTranscriptResumable(path, SINCE, {}, cache)).toEqual(analyzeTranscript(path, SINCE));
  });

  it('a rewritten, shrunk or re-bounded transcript is read again in full', () => {
    const path = join(dir, 's.jsonl');
    const cache: SessionAnalysisCache = { entries: {} };
    writeFileSync(path, records(20).join('\n') + '\n');
    analyzeTranscriptResumable(path, SINCE, {}, cache);

    // Same length, different bytes before the checkpoint (a rewrite, not an append).
    const original = readFileSync(path, 'utf-8');
    writeFileSync(path, original.replace('next step 1"', 'next step 9"'));
    appendFileSync(path, records(2, 20).join('\n') + '\n');
    expect(analyzeTranscriptResumable(path, SINCE, {}, cache)).toEqual(analyzeTranscript(path, SINCE));

    writeFileSync(path, records(4).join('\n') + '\n'); // shrunk
    expect(analyzeTranscriptResumable(path, SINCE, {}, cache)).toEqual(analyzeTranscript(path, SINCE));

    const later = at(30); // a consolidation ran: the bound moved
    expect(analyzeTranscriptResumable(path, later, {}, cache)).toEqual(analyzeTranscript(path, later));
  });

  it('the checkpoint survives a round trip through the session cache file', () => {
    const path = join(dir, 's.jsonl');
    writeFileSync(path, records(12).join('\n') + '\n');
    const first: SessionAnalysisCache = { entries: {} };
    analyzeTranscriptResumable(path, SINCE, {}, first);
    writeSessionAnalysisCache('sess-1', first, dir);
    appendFileSync(path, records(5, 12).join('\n') + '\n');
    const reread = readSessionAnalysisCache('sess-1', dir);
    expect(reread.entries[path].size).toBe(first.entries[path].size);
    expect(analyzeTranscriptResumable(path, SINCE, {}, reread)).toEqual(analyzeTranscript(path, SINCE));
    expect(readSessionAnalysisCache('nobody', dir)).toEqual({ entries: {} });
  });

  it('a missing or empty transcript is zero and leaves no checkpoint', () => {
    const cache: SessionAnalysisCache = { entries: {} };
    const path = join(dir, 'none.jsonl');
    expect(analyzeTranscriptResumable(path, SINCE, {}, cache)).toEqual(analyzeTranscript(path, SINCE));
    writeFileSync(path, '');
    expect(analyzeTranscriptResumable(path, SINCE, {}, cache)).toEqual(analyzeTranscript(path, SINCE));
    expect(cache.entries).toEqual({});
  });
});
