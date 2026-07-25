/**
 * Unit tests for claude-path.ts — the fix for "the CLI is installed but the agent
 * surface says it isn't". Claude Code lands in `~/.local/bin`, which is on no
 * default PATH, so an install that skips the `export PATH` echo leaves `claude`
 * on disk and invisible to every `$SHELL -ilc 'exec claude …'` spawn.
 *
 * Covers binary discovery, the append-never-prepend PATH augmentation (a `claude`
 * the shell already resolves must never be redirected), per-shell rc targeting +
 * syntax, and idempotency (repeat installs must not stack duplicate PATH entries).
 *
 * HOME is redirected to a scratch dir for every test — `os.homedir()` reads
 * `process.env.HOME` on POSIX — so no test ever touches the real ~/.zshrc.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  claudeBinDirs, findClaudeBin, claudeAwarePath, claudePathExportLine,
  ensureClaudeOnShellPath, RC_MARKER,
} from '../../src/lib/claude-path.js';

let home = '';
let realHome: string | undefined;

/** Create a fake `claude` executable at `<home>/<rel>/claude`, return its dir. */
function installFakeClaude(rel = '.local/bin'): string {
  const dir = join(home, rel);
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, 'claude');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(bin, 0o755);
  return dir;
}

beforeEach(() => {
  realHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'dc-claude-path-'));
  process.env.HOME = home;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

// ─── discovery ──────────────────────────────────────────────────────────────────

describe('claudeBinDirs', () => {
  it('leads with ~/.local/bin — where both the native installer and the npm package land', () => {
    expect(claudeBinDirs()[0]).toBe(join(home, '.local', 'bin'));
  });

  it('covers the legacy migrate-installer target', () => {
    expect(claudeBinDirs()).toContain(join(home, '.claude', 'local'));
  });

  it('has no duplicates (dirs are probed once each)', () => {
    const dirs = claudeBinDirs();
    expect(new Set(dirs).size).toBe(dirs.length);
  });
});

describe('findClaudeBin', () => {
  it('finds a binary the shell would miss, in ~/.local/bin', () => {
    const dir = installFakeClaude();
    expect(findClaudeBin()).toBe(join(dir, 'claude'));
  });

  it('finds the legacy ~/.claude/local install', () => {
    const dir = installFakeClaude('.claude/local');
    expect(findClaudeBin()).toBe(join(dir, 'claude'));
  });

  it('prefers ~/.local/bin when both locations have one', () => {
    installFakeClaude('.claude/local');
    const preferred = installFakeClaude();
    expect(findClaudeBin()).toBe(join(preferred, 'claude'));
  });
});

// ─── PATH augmentation ──────────────────────────────────────────────────────────

describe('claudeAwarePath', () => {
  it('appends the install dir so a login shell can resolve `claude`', () => {
    const dir = installFakeClaude();
    expect(claudeAwarePath('/usr/bin:/bin')).toBe(`/usr/bin:/bin:${dir}`);
  });

  it('APPENDS, never prepends — a claude already on PATH keeps winning', () => {
    installFakeClaude();
    const out = claudeAwarePath('/opt/dev/bin:/usr/bin');
    expect(out.startsWith('/opt/dev/bin:/usr/bin')).toBe(true);
  });

  it('is a no-op when the dir is already on PATH (no duplicate entries)', () => {
    const dir = installFakeClaude();
    const base = `/usr/bin:${dir}:/bin`;
    expect(claudeAwarePath(base)).toBe(base);
  });

  it('returns the base untouched when no claude is installed anywhere known', () => {
    expect(claudeAwarePath('/usr/bin:/bin')).toBe('/usr/bin:/bin');
  });
});

// ─── the echo ───────────────────────────────────────────────────────────────────

describe('claudePathExportLine', () => {
  it('writes the $HOME-relative export for zsh (portable across machines)', () => {
    expect(claudePathExportLine(join(home, '.local', 'bin'), '/bin/zsh'))
      .toBe('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('uses fish syntax for fish', () => {
    expect(claudePathExportLine(join(home, '.local', 'bin'), '/opt/homebrew/bin/fish'))
      .toBe('set -gx PATH "$HOME/.local/bin" $PATH');
  });

  it('keeps an absolute path when the dir lives outside $HOME', () => {
    expect(claudePathExportLine('/opt/homebrew/bin', '/bin/zsh'))
      .toBe('export PATH="/opt/homebrew/bin:$PATH"');
  });
});

describe('ensureClaudeOnShellPath', () => {
  it('appends the missing export to ~/.zshrc, under a marked block', () => {
    const dir = installFakeClaude();
    writeFileSync(join(home, '.zshrc'), 'export EDITOR=vim\n', 'utf-8');

    const fix = ensureClaudeOnShellPath(dir, '/bin/zsh');

    expect(fix.wrote).toEqual([join(home, '.zshrc')]);
    const rc = readFileSync(join(home, '.zshrc'), 'utf-8');
    expect(rc).toContain('export EDITOR=vim');       // existing content preserved
    expect(rc).toContain(RC_MARKER);
    expect(rc).toContain('export PATH="$HOME/.local/bin:$PATH"');
  });

  it('creates the rc file when the user has none', () => {
    const dir = installFakeClaude();
    const fix = ensureClaudeOnShellPath(dir, '/bin/zsh');
    expect(fix.wrote).toEqual([join(home, '.zshrc')]);
    expect(readFileSync(join(home, '.zshrc'), 'utf-8')).toContain('$HOME/.local/bin');
  });

  it('is idempotent — a second install never stacks a duplicate PATH entry', () => {
    const dir = installFakeClaude();
    ensureClaudeOnShellPath(dir, '/bin/zsh');
    const after1 = readFileSync(join(home, '.zshrc'), 'utf-8');

    const fix2 = ensureClaudeOnShellPath(dir, '/bin/zsh');

    expect(fix2.wrote).toEqual([]);
    expect(fix2.alreadyConfigured).toEqual([join(home, '.zshrc')]);
    expect(readFileSync(join(home, '.zshrc'), 'utf-8')).toBe(after1);
  });

  it('leaves an rc that already exports the dir alone, however it was written', () => {
    const dir = installFakeClaude();
    writeFileSync(join(home, '.zshrc'), `export PATH="${dir}:$PATH"\n`, 'utf-8');

    const fix = ensureClaudeOnShellPath(dir, '/bin/zsh');

    expect(fix.wrote).toEqual([]);
    expect(fix.alreadyConfigured).toEqual([join(home, '.zshrc')]);
  });

  it('separates the block from a file that does not end in a newline', () => {
    const dir = installFakeClaude();
    writeFileSync(join(home, '.zshrc'), 'export EDITOR=vim', 'utf-8'); // no trailing \n
    ensureClaudeOnShellPath(dir, '/bin/zsh');
    expect(readFileSync(join(home, '.zshrc'), 'utf-8')).toContain(`export EDITOR=vim\n\n${RC_MARKER}`);
  });

  it('writes ~/.bashrc for bash, and extends ~/.bash_profile only when it exists', () => {
    const dir = installFakeClaude();

    const noProfile = ensureClaudeOnShellPath(dir, '/bin/bash');
    expect(noProfile.wrote).toEqual([join(home, '.bashrc')]);
    expect(existsSync(join(home, '.bash_profile'))).toBe(false); // must not shadow ~/.profile

    rmSync(join(home, '.bashrc'));
    writeFileSync(join(home, '.bash_profile'), '# login\n', 'utf-8');
    const withProfile = ensureClaudeOnShellPath(dir, '/bin/bash');
    expect(withProfile.wrote).toEqual([join(home, '.bashrc'), join(home, '.bash_profile')]);
  });

  it('writes fish syntax into ~/.config/fish/config.fish, creating the directory', () => {
    const dir = installFakeClaude();
    const fix = ensureClaudeOnShellPath(dir, '/opt/homebrew/bin/fish');
    const cfg = join(home, '.config', 'fish', 'config.fish');
    expect(fix.wrote).toEqual([cfg]);
    expect(readFileSync(cfg, 'utf-8')).toContain('set -gx PATH "$HOME/.local/bin" $PATH');
  });

  it('falls back to ~/.profile for a shell it does not know', () => {
    const dir = installFakeClaude();
    const fix = ensureClaudeOnShellPath(dir, '/bin/dash');
    expect(fix.wrote).toEqual([join(home, '.profile')]);
  });

  it('reports neither written nor already-configured when the rc cannot be written', () => {
    const dir = installFakeClaude();
    // A directory where the rc file should be: every write attempt throws EISDIR.
    mkdirSync(join(home, '.zshrc'));
    const fix = ensureClaudeOnShellPath(dir, '/bin/zsh');
    expect(fix.wrote).toEqual([]);
    expect(fix.alreadyConfigured).toEqual([]);
    expect(fix.line).toBe('export PATH="$HOME/.local/bin:$PATH"'); // caller shows this manually
  });
});
