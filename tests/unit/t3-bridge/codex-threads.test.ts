/**
 * A Codex thread is served only to the project that owns it (W1 criterion 6): owner = the cwd its
 * rollout's `session_meta` recorded, realpath'd. Foreign → refused; unresolvable → refused; the
 * chat-history route answers 403 for both, on every socket (the route has no phone exception).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { codexThreadOwnership, findCodexRollout } from '../../../src/lib/t3-bridge/codex-threads.js';
import { codexHistoryFor } from '../../../src/lib/t3-bridge/codex-history-route.js';
import { bridgeResumeTarget } from '../../../src/lib/t3-bridge/spawn.js';
import { isInjectedUserText, parseCodexRolloutHistory } from '../../../src/lib/t3-bridge/codex-history.js';

const MINE = '01a18e98-8ce8-7c51-ae13-7cea70b806e8';
const THEIRS = '01a18e98-0000-7c51-ae13-7cea70b80600';
let root = '';
let codexHome = '';
let project = '';
let other = '';

function rollout(id: string, cwd: string): void {
  const dir = join(codexHome, 'sessions', '2026', '10', '30');
  mkdirSync(dir, { recursive: true });
  const lines = [
    { type: 'session_meta', payload: { id, cwd } },
    { type: 'response_item', payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'BRIEFING SECRET' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>\n<cwd>/x</cwd>' }] } },
    { type: 'response_item', timestamp: '2026-10-30T20:55:29.427Z', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add a footer to the landing page' }] } },
    { type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: 'index.html' } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Footer added.' }] } },
  ];
  writeFileSync(join(dir, `rollout-2026-10-30T23-55-25-${id}.jsonl`), lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dc-codex-threads-'));
  codexHome = join(root, '.codex');
  project = join(root, 'acme-app');
  other = join(root, 'other-app');
  mkdirSync(join(project, '_dream_context'), { recursive: true });
  mkdirSync(other, { recursive: true });
  rollout(MINE, project);
  rollout(THEIRS, other);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('codex thread ownership', () => {
  it('owned, foreign, unresolvable', () => {
    expect(codexThreadOwnership(MINE, project, codexHome)).toBe('owned');
    expect(codexThreadOwnership(THEIRS, project, codexHome)).toBe('foreign');
    expect(codexThreadOwnership('01a18e98-ffff-7c51-ae13-7cea70b806ff', project, codexHome)).toBe('unresolvable');
    expect(findCodexRollout('../../etc/passwd', codexHome)).toBeNull();
  });

  it('compares real paths: a symlink to the project owns its threads, a lookalike prefix does not', () => {
    const link = join(root, 'acme-link');
    symlinkSync(project, link);
    expect(codexThreadOwnership(MINE, link, codexHome)).toBe('owned');
    mkdirSync(join(root, 'acme-app-2'));
    expect(codexThreadOwnership(MINE, join(root, 'acme-app-2'), codexHome)).toBe('foreign');
  });

  it('history: owned thread served without injected context; foreign and unresolvable refused', async () => {
    const ctx = join(project, '_dream_context');
    const ok = await codexHistoryFor({ tool: 'codex', id: 'pane', liveId: MINE, contextRoot: ctx, codexHome });
    expect(ok).not.toBe('refuse');
    const items = (ok as { items: Array<{ kind: string; text?: string; result?: unknown }> }).items;
    expect(items.map((i) => i.kind)).toEqual(['user', 'tool', 'text']);
    expect(JSON.stringify(items)).not.toContain('BRIEFING SECRET');
    expect(JSON.stringify(items)).not.toContain('environment_context');
    expect(await codexHistoryFor({ tool: 'codex', id: 'pane', liveId: THEIRS, contextRoot: ctx, codexHome })).toBe('refuse');
    // Asked without `tool` (an older client): still refused when the id is a foreign Codex thread.
    expect(await codexHistoryFor({ tool: null, id: THEIRS, liveId: THEIRS, contextRoot: ctx, codexHome })).toBe('refuse');
    // A mapped id that cannot be found is unresolvable: refused.
    expect(await codexHistoryFor({ tool: 'codex', id: 'pane', liveId: '01a18e98-ffff-7c51-ae13-7cea70b806ff', contextRoot: ctx, codexHome })).toBe('refuse');
    // A new pane that was never mapped has no history yet (nothing to leak).
    expect(await codexHistoryFor({ tool: 'codex', id: 'pane', liveId: 'pane', contextRoot: ctx, codexHome })).toEqual({ items: [] });
    // Not a Codex pane, no Codex thread: the Claude path answers.
    expect(await codexHistoryFor({ tool: null, id: 'x', liveId: 'x', contextRoot: ctx, codexHome })).toBeNull();
  });

  it('a reopened pane resumes only its own project thread, and never one a live pane holds', () => {
    const base = { tool: 'codex' as const, resumeId: '7c4a1b2e-3d4f-4a5b-8c6d-0e1f2a3b4c5d', projectRoot: project, codexHome };
    expect(bridgeResumeTarget({ ...base, mapped: MINE, held: new Set() })).toBe(MINE);
    expect(bridgeResumeTarget({ ...base, mapped: THEIRS, held: new Set() })).toBe('');
    expect(bridgeResumeTarget({ ...base, mapped: MINE, held: new Set([MINE]) })).toBe('');
  });

  it('injected user text is recognised', () => {
    expect(isInjectedUserText('<environment_context>x')).toBe(true);
    expect(isInjectedUserText('  <user_instructions>')).toBe(true);
    expect(isInjectedUserText('Fix the <div> in the header')).toBe(false);
    expect(parseCodexRolloutHistory('not json\n')).toEqual([]);
  });
});
