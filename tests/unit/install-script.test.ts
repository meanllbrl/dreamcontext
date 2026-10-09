import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REPO_ROOT = join(__dirname, '..', '..');
const INSTALL_SH = join(REPO_ROOT, 'install.sh');

/**
 * A stand-in for the official Node.js archive: the same top-level folder shape
 * (`node-v…/bin/node`, `bin/npm`), so `tar --strip-components=1` is exercised for real,
 * with a `node` that answers the two questions install.sh asks it.
 */
function buildFixtureArchive(): { path: string; sha256: string; size: number } {
  const dir = mkdtempSync(join(tmpdir(), 'dc-node-fixture-'));
  const top = join(dir, 'node-v24.21.0-darwin-arm64', 'bin');
  mkdirSync(top, { recursive: true });
  writeFileSync(
    join(top, 'node'),
    '#!/bin/sh\ncase "$1" in\n  --version) echo v24.21.0 ;;\n  -e) printf 24 ;;\nesac\n',
    'utf-8',
  );
  writeFileSync(join(top, 'npm'), '#!/bin/sh\nexit 0\n', 'utf-8');
  chmodSync(join(top, 'node'), 0o755);
  chmodSync(join(top, 'npm'), 0o755);
  const path = join(dir, 'fixture.tar.gz');
  execFileSync('tar', ['-czf', path, '-C', dir, 'node-v24.21.0-darwin-arm64']);
  const bytes = readFileSync(path);
  return { path, sha256: createHash('sha256').update(bytes).digest('hex'), size: statSync(path).size };
}

const FIXTURE = buildFixtureArchive();

/** Point the pin table at the fixture and pretend to be an Apple Silicon Mac on a new macOS. */
const FAKE_PIN = [
  "node_platform_key() { printf 'darwin-arm64'; }",
  'macos_at_least() { return 0; }',
  `node_pin_for() { NODE_PIN_FILE="fixture.tar.gz"; NODE_PIN_SHA256="${FIXTURE.sha256}"; NODE_PIN_SIZE=${FIXTURE.size}; }`,
].join('\n');

/** A `curl` that logs its arguments and writes `src` (default: the fixture) to its `-o` path. */
function fixtureCurl(src: string = FIXTURE.path): string {
  return [
    '#!/bin/sh',
    'echo "$*" >> "$HOME/curl-calls"',
    'out=""',
    'while [ $# -gt 0 ]; do',
    '  if [ "$1" = "-o" ]; then out="$2"; shift; fi',
    '  shift',
    'done',
    `cp '${src}' "$out"`,
  ].join('\n') + '\n';
}

/** A fresh, empty TMPDIR, so a test can prove install.sh cleaned up after itself. */
function freshTmp(): string {
  return mkdtempSync(join(tmpdir(), 'dc-install-tmp-'));
}

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
  opts: { brew?: boolean; env?: Record<string, string>; stubs?: Record<string, string>; dir?: string } = {},
): { output: string; brewCalls: string; dir: string } {
  const dir = opts.dir ?? mkdtempSync(join(tmpdir(), 'dc-install-'));
  const lib = join(dir, 'lib.sh');
  writeFileSync(lib, readFileSync(INSTALL_SH, 'utf-8').replace(/\nmain\n$/, '\n'), 'utf-8');

  const bin = join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const brewLog = join(dir, 'brew-calls');
  writeFileSync(brewLog, '', 'utf-8');
  for (const [name, content] of Object.entries(opts.stubs ?? {})) {
    const stub = join(bin, name);
    writeFileSync(stub, content, 'utf-8');
    chmodSync(stub, 0o755);
  }
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

  return { output, brewCalls: readFileSync(brewLog, 'utf-8'), dir };
}

describe('install.sh bootstraps its own prerequisites', () => {
  it('installs Node.js via Homebrew when node is missing but brew exists', () => {
    const { output, brewCalls } = runHarness('ensure_node', { brew: true });
    expect(output).toContain('Node.js is not installed.');
    expect(brewCalls).toContain('install node');
  });

  it('without Homebrew it installs the private Node.js instead of installing Homebrew', () => {
    const { output, brewCalls } = runHarness(`${FAKE_PIN}\nensure_node`, {
      stubs: { curl: fixtureCurl() },
      env: { TMPDIR: freshTmp() },
    });
    expect(output).not.toContain('raw.githubusercontent.com/Homebrew');
    expect(output).toContain('Node.js v24.21.0 ready.');
    expect(brewCalls).toBe('');
  });

  it('never prompts (and never hangs) without a terminal: a failed download exits with a hint', () => {
    const { output } = runHarness(`${FAKE_PIN}\nensure_node`, {
      stubs: { curl: '#!/bin/sh\nexit 22\n' },
      env: { TMPDIR: freshTmp() },
    });
    expect(output).toContain('error:');
    expect(output).toContain('Could not download Node.js');
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

describe('install.sh private Node.js (no Homebrew)', () => {
  it('builds the same layout as the desktop app: <version>, current link, npmrc prefix, npm-global', () => {
    const tmp = freshTmp();
    const { output, dir } = runHarness(`${FAKE_PIN}\ninstall_managed_node`, {
      stubs: { curl: fixtureCurl() },
      env: { TMPDIR: tmp },
    });
    const root = join(dir, '.dreamcontext', 'node');
    expect(output).toContain('Node.js v24.21.0 installed');
    expect(lstatSync(join(root, 'current')).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, 'current'))).toBe('24.21.0');
    expect(existsSync(join(root, '24.21.0', 'bin', 'node'))).toBe(true);
    expect(readFileSync(join(root, '24.21.0', 'etc', 'npmrc'), 'utf-8')).toBe(
      `prefix=${join(dir, '.dreamcontext', 'npm-global')}\n`,
    );
    expect(statSync(join(dir, '.dreamcontext', 'npm-global')).isDirectory()).toBe(true);
    // No staging folder left behind, and the private download folder is gone.
    expect(readdirSync(root).filter((n) => n.startsWith('.'))).toEqual([]);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('downloads https-only with TLS 1.2+ into a private mktemp -d folder', () => {
    const { dir } = runHarness(`${FAKE_PIN}\ninstall_managed_node`, {
      stubs: { curl: fixtureCurl() },
      env: { TMPDIR: freshTmp() },
    });
    const calls = readFileSync(join(dir, 'curl-calls'), 'utf-8');
    expect(calls).toContain('--proto =https');
    expect(calls).toContain('--tlsv1.2');
    expect(calls).toContain('https://nodejs.org/dist/v24.21.0/fixture.tar.gz');
    const script = readFileSync(INSTALL_SH, 'utf-8');
    expect(script).toMatch(/managed_work=\$\(mktemp -d\)/);
  });

  it('throws a download of the wrong size away and installs nothing', () => {
    const tmp = freshTmp();
    const junk = join(mkdtempSync(join(tmpdir(), 'dc-junk-')), 'junk');
    writeFileSync(junk, 'not node', 'utf-8');
    const { output, dir } = runHarness(`${FAKE_PIN}\ninstall_managed_node`, {
      stubs: { curl: fixtureCurl(junk) },
      env: { TMPDIR: tmp },
    });
    expect(output).toContain('wrong size');
    expect(existsSync(join(dir, '.dreamcontext', 'node', '24.21.0'))).toBe(false);
    expect(existsSync(join(dir, '.dreamcontext', 'node', 'current'))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('throws a download that fails its checksum away and installs nothing', () => {
    const tmp = freshTmp();
    const pin = FAKE_PIN.replace(FIXTURE.sha256, '0'.repeat(64));
    const { output, dir } = runHarness(`${pin}\ninstall_managed_node`, {
      stubs: { curl: fixtureCurl() },
      env: { TMPDIR: tmp },
    });
    expect(output).toContain('did not match its checksum');
    expect(existsSync(join(dir, '.dreamcontext', 'node', '24.21.0'))).toBe(false);
    expect(readdirSync(tmp)).toEqual([]);
  });

  it('refuses a symlinked ~/.dreamcontext and writes nothing through it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-install-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-elsewhere-'));
    symlinkSync(elsewhere, join(dir, '.dreamcontext'));
    const { output } = runHarness(`${FAKE_PIN}\ninstall_managed_node`, {
      dir,
      stubs: { curl: fixtureCurl() },
      env: { TMPDIR: freshTmp() },
    });
    expect(output).toContain('is a link');
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(existsSync(join(dir, 'curl-calls'))).toBe(false);
  });

  it('refuses a symlinked node folder and writes nothing through it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-install-'));
    const elsewhere = mkdtempSync(join(tmpdir(), 'dc-elsewhere-'));
    mkdirSync(join(dir, '.dreamcontext'));
    symlinkSync(elsewhere, join(dir, '.dreamcontext', 'node'));
    const { output } = runHarness(`${FAKE_PIN}\ninstall_managed_node`, {
      dir,
      stubs: { curl: fixtureCurl() },
      env: { TMPDIR: freshTmp() },
    });
    expect(output).toContain('is a link');
    expect(readdirSync(elsewhere)).toEqual([]);
  });

  it('reinstalling keeps npm-global (the global CLI) and repoints current', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dc-install-'));
    runHarness(`${FAKE_PIN}\ninstall_managed_node`, { dir, stubs: { curl: fixtureCurl() }, env: { TMPDIR: freshTmp() } });
    const cli = join(dir, '.dreamcontext', 'npm-global', 'bin');
    mkdirSync(cli, { recursive: true });
    writeFileSync(join(cli, 'dreamcontext'), '#!/bin/sh\n', 'utf-8');
    const { output } = runHarness(`${FAKE_PIN}\ninstall_managed_node`, {
      dir,
      stubs: { curl: fixtureCurl() },
      env: { TMPDIR: freshTmp() },
    });
    expect(output).toContain('Node.js v24.21.0 installed');
    expect(existsSync(join(cli, 'dreamcontext'))).toBe(true);
    const root = join(dir, '.dreamcontext', 'node');
    expect(readlinkSync(join(root, 'current'))).toBe('24.21.0');
    // The replaced copy moved aside is removed once the new one runs.
    expect(readdirSync(root).filter((n) => n.includes('.old-'))).toEqual([]);
  });

  it('writes the PATH lines once, with a literal $HOME and the shared marker', () => {
    const { output } = runHarness(
      [
        'SHELL=/bin/zsh; export SHELL',
        'persist_node_path',
        'persist_node_path',
        'cat "$HOME/.zshrc"',
      ].join('\n'),
    );
    expect(output.split('# dreamcontext: Node.js on PATH').length - 1).toBe(1);
    expect(output).toContain('export PATH="$HOME/.dreamcontext/node/current/bin:$PATH"');
    expect(output).toContain('export PATH="$HOME/.dreamcontext/npm-global/bin:$PATH"');
    expect(output.split('.dreamcontext/node/current/bin').length - 1).toBe(1);
  });

  it('leaves a profile alone when the app already wrote the same folders', () => {
    const { output } = runHarness(
      [
        'SHELL=/bin/zsh; export SHELL',
        `printf '%s\\n' '# dreamcontext: Node.js on PATH' 'export PATH="$HOME/.dreamcontext/node/current/bin:$PATH"' 'export PATH="$HOME/.dreamcontext/npm-global/bin:$PATH"' > "$HOME/.zshrc"`,
        'persist_node_path',
        'cat "$HOME/.zshrc"',
      ].join('\n'),
    );
    expect(output).not.toContain('Added Node.js to your PATH');
    expect(output.split('# dreamcontext: Node.js on PATH').length - 1).toBe(1);
  });

  it('uses fish syntax in config.fish', () => {
    const { output } = runHarness(
      ['SHELL=/usr/local/bin/fish; export SHELL', 'persist_node_path', 'cat "$HOME/.config/fish/config.fish"'].join('\n'),
    );
    expect(output).toContain('set -gx PATH "$HOME/.dreamcontext/node/current/bin" $PATH');
    expect(output).toContain('set -gx PATH "$HOME/.dreamcontext/npm-global/bin" $PATH');
  });
});
