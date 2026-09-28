/**
 * Unit tests for the per-conversation tab-name memory (`session-titles.ts`) that lets
 * Past chats list a closed tab under the name it had, and for the roster → titles bridge
 * (`rosterTitleUpdates`) that feeds it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSessionTitles, recordSessionTitles } from '../../src/lib/session-titles.js';
import { recordAgentSession } from '../../src/lib/agent-session-map.js';
import { rosterTitleUpdates } from '../../src/server/routes/agent-sessions.js';

const A = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const B = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const C = 'cccccccc-dddd-4eee-8fff-000000000000';

let projectRoot: string;
let contextRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'dc-session-titles-'));
  contextRoot = join(projectRoot, '_dream_context');
  mkdirSync(contextRoot, { recursive: true });
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe('session titles', () => {
  it('round-trips, overwrites, and skips invalid ids and blank titles', () => {
    recordSessionTitles(contextRoot, [{ sessionId: A, title: '  Invoice export ' }, { sessionId: 'nope', title: 'x' }, { sessionId: B, title: '  ' }]);
    expect([...readSessionTitles(contextRoot)]).toEqual([[A, 'Invoice export']]);
    recordSessionTitles(contextRoot, [{ sessionId: A, title: 'Invoice export v2' }]);
    expect(readSessionTitles(contextRoot).get(A)).toBe('Invoice export v2');
  });

  it('does not rewrite the file when nothing changed', () => {
    recordSessionTitles(contextRoot, [{ sessionId: A, title: 'Same' }]);
    const path = join(contextRoot, 'state', '.session-titles.json');
    const content = readFileSync(path, 'utf-8');
    recordSessionTitles(contextRoot, [{ sessionId: A, title: 'Same' }]);
    // The `updated` stamp would differ on any rewrite, so identical bytes prove no write.
    expect(readFileSync(path, 'utf-8')).toBe(content);
  });

  it('reads a missing or corrupt store as empty', () => {
    expect(readSessionTitles(contextRoot).size).toBe(0);
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    writeFileSync(join(contextRoot, 'state', '.session-titles.json'), '{ nope');
    expect(readSessionTitles(contextRoot).size).toBe(0);
  });

  it('writes the gitignore entry for the machine-local file', () => {
    recordSessionTitles(contextRoot, [{ sessionId: A, title: 'x' }]);
    expect(existsSync(join(projectRoot, '.gitignore'))).toBe(true);
    expect(readFileSync(join(projectRoot, '.gitignore'), 'utf-8')).toContain('_dream_context/state/.session-titles.json');
  });
});

describe('rosterTitleUpdates', () => {
  const base = { bypass: false, minimized: false, size: 1 };

  it('keeps named conversations, skips defaults, clips, shells and automation runs', () => {
    const updates = rosterTitleUpdates(contextRoot, [
      { ...base, title: 'Invoice export', sessionId: A, kind: 'chat' },
      { ...base, title: 'Chat 3', sessionId: B, kind: 'chat' },
      { ...base, title: 'Agent', sessionId: B },
      { ...base, title: 'can you look at why the…', sessionId: B, kind: 'chat' },
      { ...base, title: 'zsh', sessionId: B, kind: 'shell' },
      { ...base, title: 'Nightly digest', sessionId: B, kind: 'automation' },
      { ...base, title: 'No conversation yet' },
    ]);
    expect(updates).toEqual([{ sessionId: A, title: 'Invoice export' }]);
  });

  it('files the name under the conversation the tab is actually on', () => {
    recordAgentSession(contextRoot, A, C); // tab pinned to A was /clear-ed onto C
    expect(rosterTitleUpdates(contextRoot, [{ ...base, title: 'Refactor', sessionId: A, kind: 'chat' }]))
      .toEqual([{ sessionId: C, title: 'Refactor' }]);
  });
});
