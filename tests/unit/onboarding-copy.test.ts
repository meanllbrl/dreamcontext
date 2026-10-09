import { describe, it, expect } from 'vitest';
import { CHECK_COPY, REASON_COPY, FIX_COPY, CLI_COPY, INITIALIZER_KICKOFF_PROMPT } from '../../src/lib/onboarding/copy.js';
import { CHECK_IDS, FIX_IDS } from '../../src/lib/onboarding/types.js';
import { managedNodeRoot, stableNodeExecPath, manualCommand, detectLinuxPackageManager } from '../../src/lib/onboarding/platform.js';

const BANNED = /\b(npm|PATH|node-pty|xcode|brew|shell)\b/i;

function allStrings(): string[] {
  return [
    ...Object.values(CHECK_COPY).flatMap((c) => [c.title, c.why]),
    ...Object.values(REASON_COPY),
    ...Object.values(FIX_COPY).flatMap((f) => Object.values(f).filter((v): v is string => typeof v === 'string')),
    ...Object.values(CLI_COPY),
    INITIALIZER_KICKOFF_PROMPT,
  ];
}

describe('onboarding copy', () => {
  it('covers every check and fix', () => {
    expect(Object.keys(CHECK_COPY).sort()).toEqual([...CHECK_IDS].sort());
    expect(Object.keys(FIX_COPY).sort()).toEqual([...FIX_IDS].sort());
  });

  it('has no em dash anywhere', () => {
    for (const s of allStrings()) expect(s, s).not.toMatch(/—/);
  });

  it('titles and why-lines name no tool or mechanism', () => {
    for (const { title, why } of Object.values(CHECK_COPY)) {
      expect(title, title).not.toMatch(BANNED);
      expect(why, why).not.toMatch(BANNED);
    }
  });

  it('both GitHub scope notes name repositories, organizations and gists', () => {
    for (const note of [FIX_COPY['github-signin'].scopesNote, FIX_COPY['gh-signin'].scopesNote]) {
      expect(note).toMatch(/repositories/);
      expect(note).toMatch(/organizations/);
      expect(note).toMatch(/gists/);
    }
  });

  it('calls the agent Claude and keeps the CLI git lines', () => {
    expect(CHECK_COPY.claude.title).toBe('Claude');
    expect(CLI_COPY.gitWaiting).toMatch(/press Enter to skip/);
    expect(CLI_COPY.gitLater).toMatch(/dreamcontext doctor --machine/);
  });
});

describe('platform helpers', () => {
  it('stableNodeExecPath maps a managed version folder to current, leaves others alone', () => {
    const home = '/Users/öğretmen';
    expect(stableNodeExecPath(`${home}/.dreamcontext/node/24.9.0/bin/node`, home)).toBe(`${home}/.dreamcontext/node/current/bin/node`);
    expect(stableNodeExecPath('/opt/homebrew/bin/node', home)).toBe('/opt/homebrew/bin/node');
    expect(stableNodeExecPath(`${home}/.dreamcontext/nodeX/bin/node`, home)).toBe(`${home}/.dreamcontext/nodeX/bin/node`);
    expect(managedNodeRoot(home)).toBe(`${home}/.dreamcontext/node`);
  });

  it('names the right manual command per platform and distro', () => {
    expect(manualCommand('git-install', 'darwin')).toBe('xcode-select --install');
    expect(manualCommand('git-install', 'win32')).toBe('winget install Git.Git');
    expect(manualCommand('git-install', 'linux', 'dnf')).toBe('sudo dnf install git');
    expect(manualCommand('node-shell-path', 'darwin')).toBeUndefined();
  });

  it('reads the distro from os-release ID, then ID_LIKE', () => {
    expect(detectLinuxPackageManager(() => 'ID=ubuntu\nID_LIKE=debian\n')).toBe('apt');
    expect(detectLinuxPackageManager(() => 'ID="rocky"\nID_LIKE="rhel centos fedora"\n')).toBe('dnf');
    expect(detectLinuxPackageManager(() => 'ID=nixos\n')).toBeNull();
    expect(detectLinuxPackageManager(() => { throw new Error('ENOENT'); })).toBeNull();
  });
});
