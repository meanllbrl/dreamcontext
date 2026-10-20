import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import {
  ensureClaudeHooks, hookCommand, legacyHookCommand, HOOK_SPECS, RETIRED_READ_TASK_GUARD_FILE,
} from '../../src/cli/commands/install-skill.js';

interface Handler { type: string; command: string; timeout?: number }
interface Group { matcher?: string; hooks: Handler[] }
type Hooks = Record<string, Group[]>;

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dc-hook-install-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const settingsPath = () => join(dir, '.claude', 'settings.json');
const readHooks = (): Hooks => JSON.parse(readFileSync(settingsPath(), 'utf-8')).hooks;
function writeSettings(settings: unknown): void {
  mkdirSync(join(dir, '.claude'), { recursive: true });
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

/** Every handler, flattened, with the event and matcher it sits under. */
function handlers(hooks: Hooks): Array<{ event: string; matcher: string; command: string; timeout?: number }> {
  return Object.entries(hooks).flatMap(([event, groups]) =>
    groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher ?? '', command: h.command, timeout: h.timeout }))));
}

/** What an installer before hookCommand wrote: the same specs with `npx dreamcontext hook <name>` and stale timeouts. */
function legacySettings(): { hooks: Hooks } {
  const hooks: Hooks = {};
  for (const spec of HOOK_SPECS) {
    const group: Group = { hooks: [{ type: 'command', command: legacyHookCommand(spec.name), timeout: 5 }] };
    if (spec.matcher) group.matcher = spec.matcher;
    (hooks[spec.event] ??= []).push(group);
  }
  return { hooks };
}

describe('hookCommand', () => {
  it('runs a dreamcontext on PATH directly and falls back to npx', () => {
    expect(hookCommand('stop')).toBe('command -v dreamcontext >/dev/null 2>&1 && exec dreamcontext hook stop || exec npx dreamcontext hook stop');
  });

  it('every installed hook uses it (no bare npx left)', () => {
    for (const spec of HOOK_SPECS) expect(spec.command).toBe(hookCommand(spec.name));
  });
});

describe('ensureClaudeHooks: legacy npx handlers are rewritten in place', () => {
  it('leaves exactly one handler per (event, matcher), on the new command, timeouts reconciled', () => {
    writeSettings(legacySettings());
    const result = ensureClaudeHooks(dir);
    expect(result.added).toEqual([]);
    expect(result.updated.length).toBe(HOOK_SPECS.length);

    const all = handlers(readHooks());
    expect(all).toHaveLength(HOOK_SPECS.length);
    for (const spec of HOOK_SPECS) {
      const matching = all.filter((h) => h.event === spec.event && h.matcher === (spec.matcher ?? ''));
      expect(matching).toHaveLength(1);
      expect(matching[0].command).toBe(hookCommand(spec.name));
      expect(matching[0].timeout).toBe(spec.timeout);
    }
    expect(all.some((h) => h.command.startsWith('npx '))).toBe(false);
  });

  it('is idempotent: a second run changes nothing and reports nothing', () => {
    writeSettings(legacySettings());
    ensureClaudeHooks(dir);
    const once = readFileSync(settingsPath(), 'utf-8');
    const second = ensureClaudeHooks(dir);
    expect(second).toEqual({ added: [], updated: [], migrated: false });
    expect(readFileSync(settingsPath(), 'utf-8')).toBe(once);
  });

  it('keeps a rewritten handler where it was: matcher, position and neighbouring user hooks', () => {
    writeSettings({
      permissions: { allow: ['Bash(npm test:*)'] },
      hooks: {
        PostToolUse: [
          { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user-hook' }] },
          { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'npx dreamcontext hook post-tool-use', timeout: 30 }] },
        ],
      },
    });
    ensureClaudeHooks(dir);
    const settings = JSON.parse(readFileSync(settingsPath(), 'utf-8'));
    expect(settings.permissions.allow).toEqual(['Bash(npm test:*)']);
    expect(settings.hooks.PostToolUse).toEqual([
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'echo user-hook' }] },
      { matcher: 'Edit|Write', hooks: [{ type: 'command', command: hookCommand('post-tool-use'), timeout: 30 }] },
    ]);
  });

  it('drops a legacy line an older installer added beside the current one', () => {
    writeSettings({
      hooks: {
        Stop: [
          { hooks: [{ type: 'command', command: hookCommand('stop'), timeout: 5 }] },
          { hooks: [{ type: 'command', command: 'npx dreamcontext hook stop', timeout: 5 }] },
        ],
      },
    });
    ensureClaudeHooks(dir);
    // One handler left, at the spec's timeout (45 s: a slow project's type-check runs at Stop).
    expect(readHooks().Stop).toEqual([{ hooks: [{ type: 'command', command: hookCommand('stop'), timeout: 45 }] }]);
  });

  it('the two PreToolUse gates (same command, different matchers) both survive', () => {
    writeSettings(legacySettings());
    ensureClaudeHooks(dir);
    const pre = readHooks().PreToolUse;
    expect(pre.map((g) => g.matcher).sort()).toEqual(['Agent', 'Edit|Write|MultiEdit']);
    for (const g of pre) expect(g.hooks).toEqual([{ type: 'command', command: hookCommand('pre-tool-use'), timeout: 5 }]);
  });
});

describe('ensureClaudeHooks: the reverted 0.33.0 task hooks are removed', () => {
  const GUARD_CMD = `node "$CLAUDE_PROJECT_DIR/.claude/hooks/${RETIRED_READ_TASK_GUARD_FILE}"`;
  const guardPath = () => join(dir, '.claude', 'hooks', RETIRED_READ_TASK_GUARD_FILE);
  const userRead = { type: 'command', command: 'node my-read-logger.js', timeout: 3 };

  /** What a 0.33.0 install left: the Read guard beside a user's own Read hook, and SessionEnd. */
  function settings033(): { hooks: Hooks } {
    return {
      hooks: {
        PostToolUse: [
          { matcher: 'Read', hooks: [{ type: 'command', command: GUARD_CMD, timeout: 10 }, userRead] },
          { matcher: 'Read', hooks: [{ type: 'command', command: GUARD_CMD, timeout: 10 }] },
        ],
        SessionEnd: [{ hooks: [{ type: 'command', command: hookCommand('session-end'), timeout: 5 }] }],
      },
    };
  }
  function writeGuard(body = '#!/usr/bin/env node\n/** dreamcontext Read-hook guard (PostToolUse, matcher Read). */\n'): void {
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
    writeFileSync(guardPath(), body);
  }

  it('drops both hooks, keeps the user\'s Read hook, and deletes the guard script and its empty folder', () => {
    writeSettings(settings033());
    writeGuard();
    expect(ensureClaudeHooks(dir).migrated).toBe(true);
    const hooks = readHooks();
    const commands = handlers(hooks).map((h) => h.command);
    expect(commands).not.toContain(GUARD_CMD);
    expect(commands).not.toContain(hookCommand('session-end'));
    expect(hooks.SessionEnd).toBeUndefined();
    expect(hooks.PostToolUse.filter((g) => g.matcher === 'Read')).toEqual([{ matcher: 'Read', hooks: [userRead] }]);
    expect(existsSync(guardPath())).toBe(false);
    expect(existsSync(join(dir, '.claude', 'hooks'))).toBe(false);
  });

  it('a second run reports no migration', () => {
    writeSettings(settings033());
    writeGuard();
    ensureClaudeHooks(dir);
    expect(ensureClaudeHooks(dir).migrated).toBe(false);
  });

  it('keeps a same-named file someone else wrote, and the folder it shares with other hooks', () => {
    writeSettings(settings033());
    writeGuard('// my own script\n');
    ensureClaudeHooks(dir);
    expect(readFileSync(guardPath(), 'utf-8')).toBe('// my own script\n');

    rmSync(guardPath());
    writeGuard();
    writeFileSync(join(dir, '.claude', 'hooks', 'mine.sh'), 'echo hi\n');
    ensureClaudeHooks(dir);
    expect(existsSync(guardPath())).toBe(false);
    expect(existsSync(join(dir, '.claude', 'hooks', 'mine.sh'))).toBe(true);
  });

  it('never deletes through a symlink', () => {
    writeSettings(settings033());
    const target = join(dir, 'elsewhere.cjs');
    writeFileSync(target, '/** dreamcontext Read-hook guard */\n');
    mkdirSync(join(dir, '.claude', 'hooks'), { recursive: true });
    symlinkSync(target, guardPath());
    ensureClaudeHooks(dir);
    expect(existsSync(target)).toBe(true);
    expect(lstatSync(guardPath()).isSymbolicLink()).toBe(true);
  });
});

describe('the installed command keeps the hook\'s exit code and stdout', () => {
  /** A bin dir holding `name`, a script that echoes its args and stdin, then exits `code`. */
  function fakeBin(name: string, code: number): string {
    const bin = mkdtempSync(join(dir, 'bin-'));
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\necho "${name}:$*"\ncat\nexit ${code}\n`);
    chmodSync(p, 0o755);
    return bin;
  }
  const run = (path: string, stdin: string) =>
    spawnSync('/bin/sh', ['-c', hookCommand('pre-tool-use')], { input: stdin, encoding: 'utf-8', env: { PATH: path } });

  it('a blocking exit 2 and its stdout pass through unchanged (dreamcontext on PATH)', () => {
    const bin = fakeBin('dreamcontext', 2);
    const r = run(`${bin}:/usr/bin:/bin`, '{"tool_name":"Write"}');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('dreamcontext:hook pre-tool-use\n{"tool_name":"Write"}');
  });

  it('a deny printed with exit 0 passes through unchanged', () => {
    const bin = fakeBin('dreamcontext', 0);
    const r = run(`${bin}:/usr/bin:/bin`, '{"permissionDecision":"deny"}');
    expect(r.status).toBe(0);
    expect(r.stdout).toBe('dreamcontext:hook pre-tool-use\n{"permissionDecision":"deny"}');
  });

  it('without dreamcontext on PATH it falls back to npx, exit code and stdout intact', () => {
    const bin = fakeBin('npx', 2);
    const r = run(`${bin}:/usr/bin:/bin`, 'in');
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('npx:dreamcontext hook pre-tool-use\nin');
  });
});

describe('skill/SKILL.md frontmatter hooks mirror the installed commands', () => {
  it('every frontmatter hook command is hookCommand(<its name>) of a spec on the same event', () => {
    const skill = readFileSync(join(__dirname, '..', '..', 'skill', 'SKILL.md'), 'utf-8');
    const front = skill.split('\n---\n')[0];
    const hooksBlock = front.slice(front.indexOf('\nhooks:\n'));
    let event = '';
    let seen = 0;
    for (const line of hooksBlock.split('\n')) {
      const ev = line.match(/^ {2}([A-Za-z]+):\s*$/);
      if (ev) event = ev[1];
      const cmd = line.match(/^\s+command:\s*"(.*)"\s*$/);
      if (!cmd) continue;
      seen++;
      const spec = HOOK_SPECS.find((s) => s.event === event && s.command === cmd[1]);
      expect(spec, `${event}: ${cmd[1]}`).toBeDefined();
    }
    expect(seen).toBeGreaterThanOrEqual(7);
  });
});
