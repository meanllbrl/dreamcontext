/**
 * Unit tests for `claudeUpdateRow` and `shouldWarnInChat` (dashboard/src/lib/claudeUpdate.ts):
 * how the System doctor and the Chat surface report the installed Claude Code CLI's version.
 *
 * Why it exists: every claude dreamcontext spawns is headless, and Claude Code's own updater
 * only runs in its interactive TUI, so app users' CLIs froze on old versions (and old models)
 * with nothing on screen saying so.
 *
 * The contract worth pinning: only a KNOWN problem (behind, behind with auto-updates off, a
 * failed update) warns and offers Update now; a check that couldn't answer stays silent, and a
 * running update offers no second button.
 */
import { describe, it, expect } from 'vitest';
import { claudeUpdateRow, shouldWarnInChat, type ClaudeUpdateInfo } from '../../dashboard/src/lib/claudeUpdate.js';

const base: ClaudeUpdateInfo = {
  installed: '2.1.284',
  latest: '2.1.289',
  channel: 'latest',
  outdated: false,
  state: 'current',
  updateCommand: 'claude update',
};

describe('claudeUpdateRow', () => {
  it('no report (no CLI, not the desktop app, an older server) renders no row', () => {
    expect(claudeUpdateRow(undefined)).toBeNull();
  });

  it('unknown (offline, registry unreachable) stays silent', () => {
    expect(claudeUpdateRow({ ...base, state: 'unknown' })).toBeNull();
  });

  it('current shows the version quietly and offers nothing', () => {
    const row = claudeUpdateRow({ ...base, installed: '2.1.289', state: 'current' })!;
    expect(row.tone).toBe('muted');
    expect(row.statusKey).toBe('system.update.current');
    expect(row.vars.installed).toBe('2.1.289');
    expect(row.offerUpdate).toBe(false);
  });

  it('current without a known version has nothing to say', () => {
    expect(claudeUpdateRow({ ...base, installed: null, state: 'current' })).toBeNull();
  });

  it('updated reads green with the new version and offers nothing', () => {
    const row = claudeUpdateRow({ ...base, installed: '2.1.289', state: 'updated' })!;
    expect(row.tone).toBe('ok');
    expect(row.statusKey).toBe('system.update.updated');
    expect(row.vars.installed).toBe('2.1.289');
    expect(row.offerUpdate).toBe(false);
  });

  it('outdated warns with both versions and offers Update now', () => {
    const row = claudeUpdateRow({ ...base, outdated: true, state: 'outdated' })!;
    expect(row.tone).toBe('warn');
    expect(row.statusKey).toBe('system.update.outdated');
    expect(row.vars).toEqual({ installed: '2.1.284', latest: '2.1.289' });
    expect(row.disabledBy).toBeUndefined();
    expect(row.offerUpdate).toBe(true);
  });

  it('disabled is still outdated, says where auto-update was turned off, and still offers Update now', () => {
    const row = claudeUpdateRow({ ...base, outdated: true, state: 'disabled', disabledBy: 'DISABLE_AUTOUPDATER' })!;
    expect(row.tone).toBe('warn');
    expect(row.statusKey).toBe('system.update.outdated');
    expect(row.disabledBy).toBe('DISABLE_AUTOUPDATER');
    expect(row.offerUpdate).toBe(true);
  });

  it('disabled without a named source still says auto-update is off', () => {
    expect(claudeUpdateRow({ ...base, outdated: true, state: 'disabled' })!.disabledBy).toBeTruthy();
  });

  it('failed warns, carries the error tail, and offers a retry', () => {
    const row = claudeUpdateRow({ ...base, outdated: true, state: 'failed', error: 'EACCES: permission denied\n' })!;
    expect(row.tone).toBe('warn');
    expect(row.statusKey).toBe('system.update.failed');
    expect(row.detail).toBe('EACCES: permission denied');
    expect(row.offerUpdate).toBe(true);
  });

  it('failed with no output carries no empty detail', () => {
    expect(claudeUpdateRow({ ...base, state: 'failed', error: '  ' })!.detail).toBeUndefined();
  });

  it('updating is muted and offers no second button', () => {
    const row = claudeUpdateRow({ ...base, outdated: true, state: 'updating' })!;
    expect(row.tone).toBe('muted');
    expect(row.statusKey).toBe('system.update.updating');
    expect(row.offerUpdate).toBe(false);
  });

  it('a missing version prints a placeholder rather than "null"', () => {
    const row = claudeUpdateRow({ ...base, latest: null, outdated: true, state: 'outdated' })!;
    expect(row.vars.latest).toBe('?');
  });
});

describe('shouldWarnInChat', () => {
  it('warns when behind, behind with auto-update off, or after a failed update', () => {
    expect(shouldWarnInChat({ ...base, outdated: true, state: 'outdated' })).toBe(true);
    expect(shouldWarnInChat({ ...base, outdated: true, state: 'disabled', disabledBy: 'DISABLE_UPDATES' })).toBe(true);
    expect(shouldWarnInChat({ ...base, state: 'failed' })).toBe(true);
  });

  it('stays quiet when current, updated, updating, unknown or absent', () => {
    expect(shouldWarnInChat(undefined)).toBe(false);
    expect(shouldWarnInChat({ ...base, state: 'current' })).toBe(false);
    expect(shouldWarnInChat({ ...base, state: 'updated' })).toBe(false);
    expect(shouldWarnInChat({ ...base, outdated: true, state: 'updating' })).toBe(false);
    expect(shouldWarnInChat({ ...base, outdated: true, state: 'unknown' })).toBe(false);
  });

  it('agrees with the doctor row: every chat warning is a row that offers Update now', () => {
    const states: ClaudeUpdateInfo['state'][] = ['current', 'outdated', 'updating', 'updated', 'failed', 'disabled', 'unknown'];
    for (const state of states) {
      const u = { ...base, state };
      if (shouldWarnInChat(u)) expect(claudeUpdateRow(u)?.offerUpdate).toBe(true);
    }
  });
});
