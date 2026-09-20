import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');

describe('install.sh syntax', () => {
  it('passes sh -n (syntax check) without error', () => {
    expect(() =>
      execFileSync('sh', ['-n', INSTALL_SH], { stdio: 'pipe' }),
    ).not.toThrow();
  });
});

describe('install.sh security rules', () => {
  let content: string;

  it('file can be read', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    expect(content.length).toBeGreaterThan(0);
  });

  it('contains no eval', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    // Reject bare `eval ` or `eval(` — not `evaluate` or comment references
    expect(content).not.toMatch(/\beval\s+[^#]/);
  });

  it('contains no sudo', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    // Reject sudo as a command invocation (not in comments or strings)
    const lines = content.split('\n');
    for (const line of lines) {
      const stripped = line.replace(/#.*$/, '').trim();
      expect(stripped).not.toMatch(/\bsudo\b/);
    }
  });

  it('contains no nested remote pipe-to-sh (curl|wget ... | sh|bash)', () => {
    content = readFileSync(INSTALL_SH, 'utf-8');
    // The dangerous pattern: piping a remote fetch directly into sh/bash
    expect(content).not.toMatch(/\b(curl|wget)\b[^;|\n]*\|\s*(sh|bash)\b/);
  });
});

describe('package.json files[] includes install.sh', () => {
  it('files array contains install.sh', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8'));
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('install.sh');
  });
});

/**
 * Exercise install.sh's functions without running main(): drop the trailing
 * `main` line, source the rest, then call one function under a fabricated
 * environment (no node on PATH, a recording fake brew, no terminal). Most of
 * these paths end in `die`, so a non-zero exit is expected, not an error.
 */
function runHarness(
  body: string,
  opts: { brew?: boolean; env?: Record<string, string> } = {},
): { output: string; brewCalls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dc-install-'));
  const lib = join(dir, 'lib.sh');
  writeFileSync(lib, readFileSync(INSTALL_SH, 'utf-8').replace(/\nmain\n$/, '\n'), 'utf-8');

  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const brewLog = join(dir, 'brew-calls');
  writeFileSync(brewLog, '', 'utf-8');
  if (opts.brew) {
    const fake = join(bin, 'brew');
    writeFileSync(fake, `#!/bin/sh\necho "$*" >> ${brewLog}\nexit 0\n`, 'utf-8');
    chmodSync(fake, 0o755);
  }

  const script = join(dir, 'run.sh');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      `. ${lib}`,
      // A machine with neither node nor npm; only the fake brew (if any).
      `PATH="${bin}:/usr/bin:/bin"; export PATH`,
      `HOME="${dir}"; export HOME`,
      opts.brew ? '' : 'find_brew() { return 1; }',
      body,
    ].join('\n'),
    'utf-8',
  );

  let output = '';
  try {
    output = execFileSync('sh', [script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin', ...(opts.env ?? {}) },
      encoding: 'utf-8',
      timeout: 20_000,
    });
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    output = `${e.stdout ?? ''}${e.stderr ?? ''}`;
  }

  return { output, brewCalls: readFileSync(brewLog, 'utf-8') };
}

describe('install.sh bootstraps its own prerequisites', () => {
  it('installs Node.js via Homebrew when node is missing but brew exists', () => {
    const { output, brewCalls } = runHarness('ensure_node', { brew: true });
    expect(output).toContain('Node.js is not installed.');
    expect(brewCalls).toContain('install node');
  });

  it('offers to install Homebrew when neither node nor brew is present', () => {
    const { output } = runHarness('ensure_node');
    expect(output).toContain('Homebrew');
    expect(output).toContain('https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh');
  });

  it('never prompts (and never hangs) without a terminal — it declines and exits', () => {
    const { output } = runHarness('ensure_node');
    expect(output).toContain('error:');
    expect(output).toContain('https://nodejs.org');
  });

  it('DREAMCONTEXT_INSTALL_NO_NODE opts out of the automatic install', () => {
    const { output, brewCalls } = runHarness('ensure_node', {
      brew: true,
      env: { DREAMCONTEXT_INSTALL_NO_NODE: '1' },
    });
    expect(output).toContain('DREAMCONTEXT_INSTALL_NO_NODE');
    expect(brewCalls).toBe('');
  });

  it('writes the Homebrew PATH line into the shell profile exactly once', () => {
    const { output } = runHarness(
      [
        'SHELL=/bin/zsh; export SHELL',
        'persist_brew_path',
        'persist_brew_path',
        'cat "$HOME/.zprofile"',
      ].join('\n'),
      { brew: true },
    );
    const occurrences = output.split('# dreamcontext: added Homebrew to PATH').length - 1;
    expect(occurrences).toBe(1);
  });
});
