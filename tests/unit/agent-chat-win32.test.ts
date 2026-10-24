import { describe, it, expect, vi } from 'vitest';
import { ChildProcess } from 'node:child_process';
import { chatSpawnCommand, reapChild, isShellSafePath, isWin32SafeTmpPath } from '../../src/server/routes/agent-chat.js';

describe('isWin32SafeTmpPath', () => {
  it('accepts real Windows temp paths, including short names and spaces', () => {
    for (const ok of [
      'C:\\Users\\berda\\AppData\\Local\\Temp\\dreamcontext-chat-surface-0b1f2c3d-aaaa-bbbb-cccc-1234567890ab.md',
      'C:\\Users\\BERDA~1\\AppData\\Local\\Temp\\dc_x-1.json',
      'C:\\Users\\John Smith\\AppData\\Local\\Temp\\a.json',
      'D:/tmp/a.json',
    ]) {
      expect(isWin32SafeTmpPath(ok), ok).toBe(true);
    }
  });

  it('rejects anything a shell would interpret, and paths without a drive', () => {
    for (const bad of [
      'C:\\tmp\\a"b.md', 'C:\\tmp\\$(id).md', 'C:\\tmp\\a`id`.md', 'C:\\tmp\\a!b.md',
      'C:\\tmp\\a\nb.md', 'C:\\tmp\\%TEMP%.md', 'C:\\tmp\\a\0b.md',
      '/tmp/a.md', '\\\\server\\share\\a.md', 'tmp\\a.md', '',
    ]) {
      expect(isWin32SafeTmpPath(bad), JSON.stringify(bad)).toBe(false);
    }
  });

  it('admits a non-ASCII profile or project folder (Öğretmen, Masaüstü) and spaces', () => {
    for (const ok of [
      'C:\\Users\\Öğretmen\\AppData\\Local\\Temp\\dreamcontext-chat-settings-1.json',
      'C:\\Users\\me\\Masaüstü\\proje\\.mcp.json',
      'C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\a.json',
      // Literal inside the hook's bash double quotes, and argv never meets a shell.
      "C:\\Users\\O'Brien\\AppData\\Local\\Temp\\a.json", 'C:\\Users\\A&B\\a.json', 'C:\\x\\a;b|c.json',
    ]) {
      expect(isWin32SafeTmpPath(ok), ok).toBe(true);
    }
  });

  it('leaves the POSIX guard untouched (a drive path still fails it)', () => {
    expect(isShellSafePath('C:\\Users\\x\\a.md')).toBe(false);
    expect(isShellSafePath('/tmp/dc_x-1.md')).toBe(true);
  });
});

describe('chatSpawnCommand', () => {
  const script = 'exec claude "-p"';

  it('win32: no shell, argv intact, not detached, hidden', () => {
    const argv = ['-p', '--append-system-prompt-file', 'C:\\Users\\John Smith\\Temp\\b.md', '--model', 'opus'];
    const c = chatSpawnCommand({ argv, script, platform: 'win32', shell: '/bin/zsh' });
    expect(c.args).toEqual(argv);
    expect(c.file).not.toMatch(/zsh|sh$/);
    expect(c.detached).toBe(false);
    expect(c.windowsHide).toBe(true);
  });

  it('darwin: the login shell runs the script, in its own process group', () => {
    const c = chatSpawnCommand({ argv: ['-p'], script, platform: 'darwin', shell: '/bin/zsh' });
    expect(c).toEqual({ file: '/bin/zsh', args: ['-ilc', script], detached: true, windowsHide: false });
  });

  it('linux behaves like darwin', () => {
    const c = chatSpawnCommand({ argv: ['-p'], script, platform: 'linux', shell: '/bin/bash' });
    expect(c.file).toBe('/bin/bash');
    expect(c.detached).toBe(true);
  });
});

describe('reapChild', () => {
  const asChild = (x: unknown) => x as Parameters<typeof reapChild>[0];

  it('never runs the tree kill for a plain fake, even on win32 with a pid', () => {
    const tree = vi.fn();
    const fake = { pid: 4242, kill: vi.fn() };
    reapChild(asChild(fake), undefined, 'win32', tree);
    reapChild(asChild(fake), 'SIGKILL', 'win32', tree);
    expect(tree).not.toHaveBeenCalled();
    expect(fake.kill).toHaveBeenNthCalledWith(1);
    expect(fake.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('kills the tree first for a real ChildProcess on win32, then the backstop kill', () => {
    const tree = vi.fn();
    const real = Object.assign(new ChildProcess(), { pid: 777 });
    const kill = vi.spyOn(real, 'kill').mockReturnValue(true);
    reapChild(asChild(real), 'SIGKILL', 'win32', tree);
    expect(tree).toHaveBeenCalledWith(-777, 'SIGKILL');
    expect(kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('is exactly child.kill() off win32, even for a real ChildProcess', () => {
    const tree = vi.fn();
    const real = Object.assign(new ChildProcess(), { pid: 777 });
    const kill = vi.spyOn(real, 'kill').mockReturnValue(true);
    reapChild(asChild(real), undefined, 'darwin', tree);
    expect(tree).not.toHaveBeenCalled();
    expect(kill).toHaveBeenCalledWith();
  });
});
