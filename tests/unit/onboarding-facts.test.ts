import { describe, it, expect } from 'vitest';
import {
  SHELL_FACTS_SCRIPT, parseShellFacts, loginShellArgs, resolveTestSeamUrl, resolveProbeUrl, DEFAULT_PROBE_URL,
} from '../../src/lib/onboarding/runner.js';

describe('parseShellFacts', () => {
  it('reads only __DC__ lines, ignoring rc-file banners', () => {
    const out = [
      'Now using node v20.19.0 (npm v10.8.2)',
      '__DC__node=/Users/u/.nvm/versions/node/v20.19.0/bin/node',
      'conda: base activated',
      '__DC__nodeVersion=v20.19.0',
      '__DC__npm=/Users/u/.nvm/versions/node/v20.19.0/bin/npm',
      '__DC__dreamcontext=',
      '__DC__claude=/Users/u/.local/bin/claude\r',
      '__DC__gh=',
      '__DC__brew=/opt/homebrew/bin/brew',
      '__DC__clt=1',
      '__DC__git=/usr/bin/git',
      'echo __DC__claude=/evil (mid-line, ignored)',
    ].join('\n');
    const f = parseShellFacts(out, '/bin/zsh');
    expect(f).toEqual({
      shell: '/bin/zsh',
      node: '/Users/u/.nvm/versions/node/v20.19.0/bin/node',
      nodeVersion: 'v20.19.0',
      npm: '/Users/u/.nvm/versions/node/v20.19.0/bin/npm',
      claude: '/Users/u/.local/bin/claude',
      brew: '/opt/homebrew/bin/brew',
      cltInstalled: true,
      git: '/usr/bin/git',
    });
  });

  it('an empty answer leaves the fact absent; clt=0 is false', () => {
    const f = parseShellFacts('__DC__node=\n__DC__clt=0\n', '/bin/bash');
    expect(f.node).toBeUndefined();
    expect(f.cltInstalled).toBe(false);
  });
});

describe('SHELL_FACTS_SCRIPT', () => {
  it('only runs the macOS git stub once the developer tools are confirmed', () => {
    expect(SHELL_FACTS_SCRIPT).toMatch(/\[ "\$g" != \/usr\/bin\/git \] \|\| \[ "\$clt" = 1 \]/);
    expect(SHELL_FACTS_SCRIPT).toMatch(/"\$x" -p/);
  });

  it('runs under /bin/sh and reports git only when it actually ran', () => {
    expect(SHELL_FACTS_SCRIPT).toMatch(/if "\$g" --version >\/dev\/null 2>&1; then p git "\$g"; fi/);
  });
});

describe('loginShellArgs', () => {
  it('hands the script to /bin/sh as an operand the login shell never re-parses', () => {
    expect(loginShellArgs('/bin/zsh', 'echo hi')).toEqual(['-ilc', 'exec /bin/sh -c "$0"', 'echo hi']);
    expect(loginShellArgs('/opt/homebrew/bin/fish', 'echo hi')).toEqual(['-ilc', 'exec /bin/sh -c $argv[1]', 'echo hi']);
  });
});

describe('test-seam URLs', () => {
  it('accept only plain http on 127.0.0.1, decided by URL parsing', () => {
    const k = 'DREAMCONTEXT_ONBOARDING_PROBE_URL';
    expect(resolveTestSeamUrl(k, { [k]: 'http://127.0.0.1:4555/ping' })).toBe('http://127.0.0.1:4555/ping');
    for (const bad of [
      'https://127.0.0.1:4555/', 'http://localhost:4555/', 'http://127.0.0.1.evil.example/',
      'http://127.0.0.1@evil.example/', 'http://user:pw@127.0.0.1/', 'file:///etc/passwd', 'not a url',
    ]) {
      expect(resolveTestSeamUrl(k, { [k]: bad })).toBeNull();
    }
  });

  it('the probe URL defaults to the npm registry ping', () => {
    expect(resolveProbeUrl({})).toBe(DEFAULT_PROBE_URL);
    expect(resolveProbeUrl({ DREAMCONTEXT_ONBOARDING_PROBE_URL: 'http://evil.example/' })).toBe(DEFAULT_PROBE_URL);
  });
});
