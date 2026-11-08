/**
 * `hook … --format codex` and the scoped guard (Track T W3). With DREAMCONTEXT_CONTEXT_BY=bridge
 * (set on a desktop Codex chat's `codex app-server`), a project's opt-in `.codex/hooks.json` prints
 * no context (the bridge already injected it: no double injection) — but the pre-tool-use `.env`
 * gate STILL fires, for a Claude-shaped Edit and for a Codex patch. Without the flag nothing about
 * a Claude hook changes (hook-golden.test.ts).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { codexHookAnswer, codexToolCallsAsClaude } from '../../src/cli/commands/hook.js';

const ROOT = join(__dirname, '../..');
const CLI = join(ROOT, 'dist', 'index.js');
const base = realpathSync(mkdtempSync(join(tmpdir(), 'dc-guard-scope-')));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const HOME = join(base, 'home');
const PROJ = join(base, 'acme-shop');
const ctx = join(PROJ, '_dream_context');
for (const d of [join(HOME, '.dreamcontext'), join(ctx, 'core'), join(ctx, 'state'), join(ctx, 'marketing')]) mkdirSync(d, { recursive: true });
writeFileSync(join(ctx, 'core', '0.soul.md'), '---\nname: "acme-shop"\ntype: soul\nupdated: "2026-01-02"\n---\n\n## Project Identity\n\nA fictional storefront.\n');
writeFileSync(join(ctx, 'state', '.config.json'), JSON.stringify({ platforms: [], packs: [], setupVersion: '1' }));
writeFileSync(join(ctx, 'marketing', '.env'), 'ACME_FAKE=not-a-secret\n');

const run = (hook: string, payload: object, extraEnv: Record<string, string> = {}) => {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME, DREAMCONTEXT_BRAIN_SYNC: '0', DREAMCONTEXT_RECALL_CLOUD: '0', DREAMCONTEXT_VERSION_CHECK: '0', ...extraEnv };
  delete env.DREAMCONTEXT_CHAT_TAB;
  if (!extraEnv.DREAMCONTEXT_CONTEXT_BY) delete env.DREAMCONTEXT_CONTEXT_BY;
  return spawnSync(process.execPath, [CLI, 'hook', hook, '--format', 'codex'], { cwd: PROJ, env, input: JSON.stringify(payload), encoding: 'utf-8', timeout: 60_000 });
};
const PATCH = '*** Begin Patch\n*** Update File: _dream_context/marketing/.env\n@@\n-ACME_FAKE=not-a-secret\n+ACME_FAKE=stolen\n*** End Patch';

describe('the Codex hook shape (pure)', () => {
  it('plain text becomes additionalContext on context events, JSON passes through, other events print nothing', () => {
    expect(JSON.parse(codexHookAnswer('SessionStart', 'snapshot'))).toEqual({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'snapshot' } });
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    expect(codexHookAnswer('PreToolUse', deny)).toBe(deny + '\n');
    expect(codexHookAnswer('PreCompact', 'some text')).toBe('');
    expect(codexHookAnswer('UserPromptSubmit', '   ')).toBe('');
  });

  it('a Codex patch is read as one Write/Edit per file; a shell call as Bash', () => {
    expect(codexToolCallsAsClaude('apply_patch', { command: PATCH })).toEqual([{ toolName: 'Edit', toolInput: { file_path: '_dream_context/marketing/.env' } }]);
    expect(codexToolCallsAsClaude('shell', { command: ['npm', 'test'] })).toEqual([{ toolName: 'Bash', toolInput: { command: 'npm test' } }]);
    expect(codexToolCallsAsClaude('Read', { file_path: 'x' })).toEqual([{ toolName: 'Read', toolInput: { file_path: 'x' } }]);
  });
});

describe.skipIf(!existsSync(CLI))('the scoped guard (built CLI)', () => {
  it('outside a bridge session the Codex hook gives the snapshot as additionalContext', () => {
    const r = run('session-start', { source: 'startup', cwd: PROJ });
    expect(r.status).toBe(0);
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: { hookEventName: string; additionalContext: string } };
    expect(out.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(out.hookSpecificOutput.additionalContext).toContain('acme-shop');
  }, 60_000);

  it('inside a bridge session the context hooks print nothing (no double injection)', () => {
    for (const [hook, payload] of [['session-start', { source: 'startup' }], ['user-prompt-submit', { prompt: 'how does checkout work' }], ['pre-compact', { trigger: 'auto' }], ['stop', { session_id: 'x' }]] as const) {
      const r = run(hook, payload, { DREAMCONTEXT_CONTEXT_BY: 'bridge' });
      expect(r.status, hook).toBe(0);
      expect(r.stdout, hook).toBe('');
    }
  }, 120_000);

  it('…but the .env gate still fires, for a Claude-shaped Edit and for a Codex patch', () => {
    for (const payload of [
      { tool_name: 'Edit', tool_input: { file_path: join(ctx, 'marketing', '.env') }, cwd: PROJ },
      { tool_name: 'apply_patch', tool_input: { command: PATCH }, cwd: PROJ },
    ]) {
      const r = run('pre-tool-use', payload, { DREAMCONTEXT_CONTEXT_BY: 'bridge' });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toMatchObject({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } });
    }
  }, 60_000);
});
