/**
 * Reading an Antigravity conversation. The step layout is the one measured on agent 1.4.1; the rows
 * here are built by hand with fictional words.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { antigravityProfileDir } from '../../src/lib/antigravity-accounts.js';
import { conversationToClaudeJsonl, ownerWords, protoFields, writeAntigravityTranscript } from '../../src/lib/antigravity-conversation.js';
import { findTranscriptBySessionId } from '../../src/lib/transcript-locate.js';

const vi = (n: number): number[] => { const o: number[] = []; let v = n; while (v > 127) { o.push((v % 128) | 128); v = Math.floor(v / 128); } o.push(v); return o; };
const num = (no: number, v: number): number[] => [...vi(no * 8), ...vi(v)];
const bytes = (no: number, b: number[]): number[] => [...vi(no * 8 + 2), ...vi(b.length), ...b];
const str = (no: number, s: string): number[] => bytes(no, [...new TextEncoder().encode(s)]);
const meta = (seconds: number, input = 0, output = 0): number[] => bytes(5, [...bytes(1, num(1, seconds)), ...(input ? bytes(9, [...num(2, input), ...num(3, output)]) : [])]);
const user = (prompt: string, at = 1_800_000_000) => ({ type: 14, payload: Uint8Array.from([...meta(at), ...bytes(19, str(2, prompt))]) });
const model = (text: string, calls: Array<[string, string, string]> = [], tokens = 10) => ({
  type: 15,
  payload: Uint8Array.from([...meta(1_800_000_001, tokens, 2), ...bytes(20, [...(text ? str(1, text) : []), ...calls.flatMap(([id, name, args]) => bytes(7, [...str(1, id), ...str(2, name), ...str(3, args)]))])]),
});
const lines = (s: string): any[] => s.trim().split('\n').map((l) => JSON.parse(l));

describe('ownerWords', () => {
  const wrap = (t: string) => `<dreamcontext-instructions>\nMode: Default.\n</dreamcontext-instructions>\n\n<user_request>\n${t}\n\n<dreamcontext-brain>\nthe snapshot\n</dreamcontext-brain>\n\n<dreamcontext-prompt>\nrecall\n</dreamcontext-prompt>\n</user_request> <dreamcontext-runtime>\nYou are Antigravity\n</dreamcontext-runtime>`;

  it('takes the typed words out of the first prompt of a thread', () => {
    expect(ownerWords(wrap('fix the toast'))).toBe('fix the toast');
  });
  it('and out of a later one, with no instructions block', () => {
    expect(ownerWords('why is it red\n\n<dreamcontext-prompt>\nrecall\n</dreamcontext-prompt> <dreamcontext-runtime>\nx\n</dreamcontext-runtime>')).toBe('why is it red');
  });
  it('and when a long message carried its context first', () => {
    expect(ownerWords('<dreamcontext-brain>\nthe snapshot\n</dreamcontext-brain>\n\n<dreamcontext-prompt>\nr\n</dreamcontext-prompt>\n\nlong words here <dreamcontext-runtime>\nx\n</dreamcontext-runtime>')).toBe('long words here');
  });
  it('a turn that is ours is nobody\'s words', () => {
    expect(ownerWords('<dreamcontext_tab_title>\nName it\n</dreamcontext_tab_title>')).toBeNull();
    expect(ownerWords('<dreamcontext-brain>\nnever closed')).toBeNull();
  });
});

describe('protoFields', () => {
  it('reads nothing from bytes that are not a message, and does not throw', () => {
    expect(protoFields(Uint8Array.from([0xff, 0xff, 0xff]))).toEqual([]);
    expect(protoFields(Uint8Array.from([0x0a, 0x7f, 0x01]))).toEqual([]);
  });
});

describe('conversationToClaudeJsonl', () => {
  it('keeps the words, the tools under our names and the tokens, and none of what was injected', () => {
    const out = lines(conversationToClaudeJsonl([
      user('fix the toast\n\n<dreamcontext-brain>\nSECRET-SNAPSHOT\n</dreamcontext-brain>'),
      model('', [['c1', 'run_command', '{"CommandLine":"npm test"}'], ['c2', 'create_file', '{"TargetFile":"/p/a.ts"}']], 500),
      { type: 21, payload: Uint8Array.from(meta(1_800_000_002)) },
      model('done'),
    ], 'thread-1'));
    expect(JSON.stringify(out)).not.toContain('SECRET-SNAPSHOT');
    expect(out[0]).toMatchObject({ type: 'user', sessionId: 'thread-1', message: { content: 'fix the toast' } });
    expect(out[0].timestamp).toBe('2027-01-15T08:00:00.000Z');
    expect(out[1].message.content.map((b: any) => [b.name, b.input])).toEqual([['Bash', { command: 'npm test' }], ['Write', { file_path: '/p/a.ts' }]]);
    expect(out[1].message.usage).toEqual({ input_tokens: 500, output_tokens: 2 });
    expect(out[2].message.content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('drops the hidden tab-naming turn with its answer', () => {
    const out = lines(conversationToClaudeJsonl([user('hi'), model('hello'), user('<dreamcontext_tab_title>\nName\n</dreamcontext_tab_title>'), model('{"type":"title"}')], 't'));
    expect(out).toHaveLength(2);
  });

  it('a format it cannot read gives no transcript, not a wrong one', () => {
    expect(conversationToClaudeJsonl([{ type: 14, payload: Uint8Array.from([0xff, 0xff]) }], 't')).toBe('');
  });
});

describe('writeAntigravityTranscript', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-agy-conv-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });
  const place = (id: string): void => {
    const dir = join(antigravityProfileDir('primary', home), 'antigravity-acp', 'conversations');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.db`), '');
  };

  it('writes a private file every transcript reader can find by the thread id', () => {
    place('abc-123');
    const path = writeAntigravityTranscript('abc-123', 'primary', { home, readRows: () => [user('hello'), model('hi')] })!;
    expect(lines(readFileSync(path, 'utf-8'))).toHaveLength(2);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600); // Windows has no POSIX mode bits
    expect(findTranscriptBySessionId(['abc-123'], home)).toBe(path);
  });

  it('refuses a thread id that could climb, a thread with no file, and a read that fails', () => {
    expect(writeAntigravityTranscript('../x', 'primary', { home })).toBeNull();
    expect(writeAntigravityTranscript('nothing', 'primary', { home })).toBeNull();
    place('bad');
    expect(writeAntigravityTranscript('bad', 'primary', { home, readRows: () => { throw new Error('locked'); } })).toBeNull();
  });
});
