/**
 * The task read memo (main's light-app work) meets the card/journal split (C1).
 *
 * A task read carries its journal: `changelog` falls back to
 * `state/journal/<slug>.md`. A journal append from another writer (another
 * process's `tasks log`, an agent assignment, a pull) never touches the card's
 * stat, so a memo keyed on the card alone would serve a stale history. The
 * `task` memo is keyed on the journal's stat too.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalTaskBackend, resetTaskReadMemo } from '../../src/lib/task-backend/local.js';
import { appendJournalEntry } from '../../src/lib/task-journal.js';

let root: string;
let state: string;

function card(slug: string): void {
  writeFileSync(join(state, `${slug}.md`), [
    '---', `id: "task_${slug}"`, `name: "${slug}"`, 'status: "todo"',
    'created_at: "2026-10-18"', 'updated_at: "2026-10-18"', 'tags: []', 'parent_task: null', '---', '',
    '## Why', '', 'Because.', '',
    '## Acceptance Criteria', '', '- [ ] first', '',
  ].join('\n'));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-task-memo-journal-'));
  state = join(root, '_dream_context', 'state');
  mkdirSync(state, { recursive: true });
  resetTaskReadMemo();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('task read memo and the journal', () => {
  it('a journal append from outside the backend is seen by the next get', async () => {
    card('alpha');
    const first = await new LocalTaskBackend(state).get('alpha');
    expect(first?.changelog ?? '').not.toContain('appended elsewhere');
    appendJournalEntry(state, 'alpha', { kind: 'log', body: '- appended elsewhere' });
    const second = await new LocalTaskBackend(state).get('alpha');
    expect(second?.changelog).toContain('appended elsewhere');
  });

  it('a journal append through the backend is seen too', async () => {
    card('beta');
    const backend = new LocalTaskBackend(state);
    await backend.get('beta');
    await backend.addJournal('beta', { kind: 'log', body: '- logged through the backend' });
    const after = await new LocalTaskBackend(state).get('beta');
    expect(after?.changelog).toContain('logged through the backend');
  });

  it('with no change at all, the second read returns equal data', async () => {
    card('gamma');
    appendJournalEntry(state, 'gamma', { kind: 'log', body: '- one entry' });
    const a = await new LocalTaskBackend(state).get('gamma');
    const b = await new LocalTaskBackend(state).get('gamma');
    expect(b).toEqual(a);
  });
});
