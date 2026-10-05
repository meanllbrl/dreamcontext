/**
 * chat-seed.ts: what an existing conversation is about, read from disk when a `--resume`
 * respawn registers — the stored tab title, else the first prompt, plus the newest assistant
 * texts, from a BOUNDED head/tail read. Temp HOME and contextRoot only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedForConversation } from '../../src/lib/assistant/chat-seed.js';

const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

const user = (text: string) => JSON.stringify({ type: 'user', message: { role: 'user', content: text } });
const assistant = (text: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', id: 't1', name: 'Bash', input: {} }] }, ...extra });

let home: string;
let root: string;

function transcript(lines: string[]): string {
  const dir = join(home, '.claude', 'projects', '-tmp-acme');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `${ID}.jsonl`);
  writeFileSync(p, lines.join('\n'));
  return p;
}

const storeTitle = (title: string) => {
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, 'state', '.session-titles.json'), JSON.stringify({ titles: { [ID]: { title, updated: '2026-10-05T00:00:00.000Z' } } }));
};

describe('seedForConversation', () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'chat-seed-home-'));
    root = mkdtempSync(join(tmpdir(), 'chat-seed-ctx-'));
    transcript([
      user('fix the login bug please'),
      assistant('Looking at the auth module.'),
      assistant('SIDECHAIN TEXT', { isSidechain: true }),
      assistant('Fixed: the token was never refreshed.'),
      '{"type":"assistant","message":{"content":[{"type":"text","text":"cut of',
    ]);
  });
  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('the stored tab title wins over the first prompt', () => {
    storeTitle('Login refresh bug');
    const seed = seedForConversation(root, [ID], { home });
    expect(seed.title).toBe('Login refresh bug');
    expect(seed.lastAssistantText).toEqual(['Looking at the auth module.', 'Fixed: the token was never refreshed.']);
  });

  it('without a stored title the first human prompt is the title; sidechain and cut lines are ignored', () => {
    const seed = seedForConversation(root, [ID], { home });
    expect(seed.title).toBe('fix the login bug please');
    expect(seed.lastAssistantText!.join(' ')).not.toContain('SIDECHAIN');
    expect(seed.lastAssistantText!.join(' ')).not.toContain('cut of');
  });

  it('with several human prompts in the head, the FIRST one is the title', () => {
    transcript([user('the first ask'), assistant('ok'), user('a second ask'), assistant('ok'), user('a third ask')]);
    expect(seedForConversation(root, [ID], { home }).title).toBe('the first ask');
  });

  it('a 64-128 KB transcript whose short tail holds no reply falls back to the head\'s replies', () => {
    const filler = Array.from({ length: 100 }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `x${i}`, content: 'y'.repeat(800) }] } }));
    transcript([user('go'), assistant('the head reply'), ...filler]);
    expect(seedForConversation(root, [ID], { home }).lastAssistantText).toEqual(['the head reply']);
  });

  it('a null contextRoot still reads the transcript', () => {
    expect(seedForConversation(null, [ID], { home }).title).toBe('fix the login bug please');
  });

  it('a missing transcript or a bad id is {} without throwing', () => {
    expect(seedForConversation(root, ['bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'], { home })).toEqual({});
    expect(seedForConversation(root, ['../../etc/passwd'], { home })).toEqual({});
    expect(seedForConversation(join(root, 'nope'), [], { home: join(home, 'nope') })).toEqual({});
  });

  it('keeps only the newest three assistant texts', () => {
    transcript([user('go'), ...Array.from({ length: 6 }, (_, i) => assistant(`reply ${i}`))]);
    expect(seedForConversation(root, [ID], { home }).lastAssistantText).toEqual(['reply 3', 'reply 4', 'reply 5']);
  });

  it('a transcript past 128 KB still yields its first prompt and last reply (bounded head + tail)', () => {
    const filler = Array.from({ length: 400 }, (_, i) => JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: `x${i}`, content: 'y'.repeat(800) }] } }));
    transcript([user('the very first ask'), assistant('early reply'), ...filler, assistant('the final word')]);
    const seed = seedForConversation(root, [ID], { home });
    expect(seed.title).toBe('the very first ask');
    expect(seed.lastAssistantText).toEqual(['the final word']);
  });
});
