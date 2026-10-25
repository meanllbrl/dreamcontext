import { describe, it, expect } from 'vitest';
import { Script } from 'node:vm';
import { autoUpgradeLaunch, WIN_HIDDEN_RUNNER } from '../../src/lib/version-check.js';

const ARGS = ['install', '-g', 'dreamcontext@latest'];

describe('autoUpgradeLaunch', () => {
  it('off Windows it is exactly the detached npm spawn it always was', () => {
    for (const platform of ['darwin', 'linux'] as const) {
      expect(autoUpgradeLaunch('npm', ARGS, platform, '/usr/bin/node')).toEqual({
        file: 'npm',
        args: ARGS,
        options: { detached: true, stdio: 'ignore', shell: false },
      });
    }
  });

  it('on Windows the detached child is our node running the hidden runner, never cmd/npm directly', () => {
    const l = autoUpgradeLaunch('npm', ARGS, 'win32', 'C:\\Program Files\\nodejs\\node.exe', 'C:\\Users\\me');
    expect(l.file).toBe('C:\\Program Files\\nodejs\\node.exe');
    expect(l.args).toEqual(['-e', WIN_HIDDEN_RUNNER, 'npm install -g dreamcontext@latest']);
    // In the home folder: cmd looks for `npm` in the working folder before PATH, and the hook
    // that triggers this runs inside a project.
    expect(l.options).toEqual({ detached: true, stdio: 'ignore', shell: false, windowsHide: true, cwd: 'C:\\Users\\me' });
  });

  it('the runner starts the command hidden, through a shell, and waits for it', () => {
    expect(WIN_HIDDEN_RUNNER).toContain('spawnSync');
    expect(WIN_HIDDEN_RUNNER).toContain('windowsHide: true');
    expect(WIN_HIDDEN_RUNNER).toContain('shell: true');
    expect(WIN_HIDDEN_RUNNER).toContain('process.argv[1]');
  });

  it('the runner compiles as JavaScript (compiled, never run)', () => {
    expect(() => new Script(WIN_HIDDEN_RUNNER)).not.toThrow();
  });
});
