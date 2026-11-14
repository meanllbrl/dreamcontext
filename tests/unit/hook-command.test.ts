/**
 * Hook texts (plan npmsiz-beta C6′, W1): Codex texts frozen byte for byte (Codex trusts a hook by
 * the hash of its text); every Claude text an installer wrote or will write is RECOGNISED and
 * rewritten in place, so a project holding any of them ends with exactly ONE handler per event.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  CODEX_USER_GATE_COMMAND, WRITTEN, codexHookCommand, hookCommand, launcherHookCommand, legacyHookCommand, recognisedHookCommands,
} from '../../src/lib/hook-command.js';
import { HOOK_SPECS, ensureClaudeHooks } from '../../src/cli/commands/install-skill.js';

describe('Codex texts are frozen', () => {
  it('the project hook text is byte for byte today\'s', () => {
    expect(codexHookCommand('session-start')).toBe(
      'command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook session-start --format codex || exec npx dreamcontext hook session-start --format codex',
    );
  });
  it('the Mac-wide gate text is byte for byte today\'s', () => {
    expect(CODEX_USER_GATE_COMMAND).toBe('dreamcontext hook pre-tool-use --format codex');
  });
});

describe('Claude texts', () => {
  it('this release writes today\'s text', () => {
    expect(WRITTEN('stop')).toBe('command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook stop || exec npx dreamcontext hook stop');
    for (const spec of HOOK_SPECS) expect(spec.command).toBe(WRITTEN(spec.name));
  });
  it('recognises today\'s, the legacy npx and the app-launcher (D15) text, the written one first', () => {
    expect(recognisedHookCommands('stop')).toEqual([hookCommand('stop'), legacyHookCommand('stop'), launcherHookCommand('stop')]);
    expect(launcherHookCommand('stop')).toBe(
      'command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook stop || exec "$HOME/.dreamcontext/bin/cli/dreamcontext" hook stop',
    );
  });
});

describe('ensureClaudeHooks: any recognised text ends as exactly one handler per event', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-hook-recognise-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });
  const settings = () => join(dir, '.claude', 'settings.json');

  /** A settings file where every spec is installed with `text(name)`; `extra` adds a second copy with another text. */
  function write(text: (event: string) => string, extra?: (event: string) => string): void {
    const hooks: Record<string, Array<{ matcher?: string; hooks: Array<{ type: string; command: string; timeout: number }> }>> = {};
    for (const spec of HOOK_SPECS) {
      const cmds = [text(spec.name), ...(extra ? [extra(spec.name)] : [])];
      for (const command of cmds) {
        (hooks[spec.event] ??= []).push({ ...(spec.matcher ? { matcher: spec.matcher } : {}), hooks: [{ type: 'command', command, timeout: spec.timeout }] });
      }
    }
    mkdirSync(join(dir, '.claude'), { recursive: true });
    writeFileSync(settings(), JSON.stringify({ hooks }, null, 2));
  }

  function assertOnePerSpec(): void {
    const hooks = JSON.parse(readFileSync(settings(), 'utf-8')).hooks as Record<string, Array<{ matcher?: string; hooks: Array<{ command: string }> }>>;
    const all = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher ?? '', command: h.command }))));
    expect(all).toHaveLength(HOOK_SPECS.length);
    for (const spec of HOOK_SPECS) {
      expect(all.filter((h) => h.event === spec.event && h.matcher === (spec.matcher ?? '') && h.command === WRITTEN(spec.name))).toHaveLength(1);
    }
  }

  it.each([
    ['today\'s text', hookCommand],
    ['the legacy npx text', legacyHookCommand],
    ['the app-launcher (D15) text', launcherHookCommand],
  ])('a project holding %s', (_label, text) => {
    write(text);
    ensureClaudeHooks(dir);
    assertOnePerSpec();
    // Idempotent: a second update changes nothing.
    const once = readFileSync(settings(), 'utf-8');
    ensureClaudeHooks(dir);
    expect(readFileSync(settings(), 'utf-8')).toBe(once);
  });

  it('a project holding the launcher text AND today\'s (a newer and an older installer both ran) keeps one', () => {
    write(launcherHookCommand, hookCommand);
    ensureClaudeHooks(dir);
    assertOnePerSpec();
  });
});
