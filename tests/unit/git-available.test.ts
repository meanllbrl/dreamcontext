import { describe, it, expect } from 'vitest';
import { gitAvailable, type GitProbe } from '../../src/lib/git-sync/git.js';

function probe(over: Partial<GitProbe>): GitProbe & { ran: string[] } {
  const ran: string[] = [];
  return {
    platform: 'darwin',
    resolveGit: () => '/usr/bin/git',
    cltInstalled: () => { ran.push('xcode-select -p'); return false; },
    gitRuns: () => { ran.push('git --version'); return true; },
    ...over,
    ran,
  } as GitProbe & { ran: string[] };
}

describe('gitAvailable', () => {
  it('on a Mac without the developer tools never runs the /usr/bin/git stub', () => {
    const p = probe({});
    expect(gitAvailable(p)).toBe(false);
    expect(p.ran).toEqual(['xcode-select -p']);
  });

  it('runs the stub once the tools are installed', () => {
    const p = probe({ cltInstalled: () => true });
    expect(gitAvailable(p)).toBe(true);
  });

  it('a git outside /usr/bin (Homebrew) is run without asking about the tools', () => {
    const p = probe({ resolveGit: () => '/opt/homebrew/bin/git' });
    expect(gitAvailable(p)).toBe(true);
    expect(p.ran).toEqual(['git --version']);
  });

  it('no git on PATH: false, nothing spawned', () => {
    const p = probe({ resolveGit: () => null });
    expect(gitAvailable(p)).toBe(false);
    expect(p.ran).toEqual([]);
  });

  it('on Linux /usr/bin/git is real git', () => {
    const p = probe({ platform: 'linux' });
    expect(gitAvailable(p)).toBe(true);
    expect(p.ran).toEqual(['git --version']);
  });
});
