/**
 * install.ps1 — the Windows one-command install (`irm …/install.ps1 | iex`).
 *
 * The static rules always run. The behaviour cases run the real script under PowerShell when
 * one is available (`pwsh` on PATH, or DREAMCONTEXT_TEST_PWSH pointing at one), against a local
 * HTTP server standing in for nodejs.org: a download of the wrong size or with the wrong
 * checksum is thrown away and nothing is installed; DREAMCONTEXT_INSTALL_NO_NODE downloads
 * nothing; and run through `iex`, a failure neither closes the caller's session nor leaves its
 * preference variables changed. The success path edits the user PATH in the registry, so it is
 * only exercised on a real Windows machine.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';

const REPO_ROOT = join(__dirname, '..', '..');
const SCRIPT = readFileSync(join(REPO_ROOT, 'install.ps1'), 'utf-8');

describe('install.ps1 static rules', () => {
  it('ships in the npm package next to install.sh (jsDelivr serves it from there)', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf-8')) as { files: string[] };
    expect(pkg.files).toContain('install.ps1');
    expect(pkg.files).toContain('install.sh');
  });

  it('never exits (under iex an `exit` closes the user\'s window) and never re-pipes code into iex', () => {
    const code = SCRIPT.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(code).not.toMatch(/^\s*exit\b/im);
    expect(code).not.toMatch(/\bInvoke-Expression\b|\|\s*iex\b/i);
  });

  it('asks for no admin rights and touches no execution policy', () => {
    expect(SCRIPT).not.toMatch(/-Verb\s+RunAs|Set-ExecutionPolicy|-ExecutionPolicy|HKLM:/i);
    expect(SCRIPT).not.toMatch(/SetEnvironmentVariable\([^)]*'Machine'/i); // reading the machine Path is fine
    expect(SCRIPT).toMatch(/HKCU:\\Environment/);
  });

  it('downloads only over https and checks size AND sha256 before unpacking', () => {
    expect(SCRIPT).toMatch(/\$NodeBaseUrl = 'https:\/\//);
    const sizeAt = SCRIPT.indexOf('.Length -ne $pin.Size');
    const shaAt = SCRIPT.indexOf("Get-FileHash -LiteralPath $archive -Algorithm SHA256");
    const unpackAt = SCRIPT.indexOf('Expand-Archive');
    expect(sizeAt).toBeGreaterThan(0);
    expect(shaAt).toBeGreaterThan(sizeAt);
    expect(unpackAt).toBeGreaterThan(shaAt);
  });

  it('runs npm.cmd / dreamcontext.cmd, never the .ps1 shims the default execution policy blocks', () => {
    expect(SCRIPT).toMatch(/Find-Exe 'npm\.cmd'/);
    expect(SCRIPT).toMatch(/Find-Exe 'dreamcontext\.cmd'/);
    expect(SCRIPT).toMatch(/install -g dreamcontext@latest/);
  });

  it('mirrors install.sh: the three switches, app install, then update or setup', () => {
    for (const sw of ['DREAMCONTEXT_INSTALL_NO_NODE', 'DREAMCONTEXT_INSTALL_NO_APP', 'DREAMCONTEXT_INSTALL_NO_SETUP']) {
      expect(SCRIPT).toContain(`'${sw}'`);
    }
    expect(SCRIPT).toMatch(/& \$Dc app install/);
    expect(SCRIPT).toMatch(/& \$Dc update/);
    expect(SCRIPT).toMatch(/& \$Dc setup/);
  });
});

// ─── Behaviour, under a real PowerShell ─────────────────────────────────────────

/** An ABSOLUTE pwsh: the cases below run it with a PATH that holds nothing (no node.exe). */
function findPwsh(): string | null {
  const explicit = process.env.DREAMCONTEXT_TEST_PWSH;
  if (explicit && existsSync(explicit)) return explicit;
  try {
    const out = execFileSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', '(Get-Process -Id $PID).Path'], {
      encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000,
    }).trim();
    return out && existsSync(out) ? out : null;
  } catch {
    return null;
  }
}
const PWSH = findPwsh();

describe.skipIf(!PWSH)('install.ps1 under PowerShell (private Node.js download)', () => {
  const BYTES = Buffer.from('not really a zip, only checked for size and checksum');
  const SHA = createHash('sha256').update(BYTES).digest('hex');
  let server: Server;
  let base = '';
  let requests = 0;
  let dir: string;
  let home: string;
  let temp: string;

  beforeAll(async () => {
    server = createServer((_req, res) => { requests += 1; res.writeHead(200); res.end(BYTES); });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

  beforeEach(() => {
    requests = 0;
    dir = mkdtempSync(join(tmpdir(), 'dc-ps1-'));
    home = join(dir, 'home');
    temp = join(dir, 'temp');
    for (const d of [home, temp, join(home, 'AppData', 'Roaming'), join(dir, 'emptybin')]) mkdirSync(d, { recursive: true });
  });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  /** The script with the x64 pin pointed at the local server, and that size/checksum. */
  function scriptWith(size: number, sha: string): string {
    const text = SCRIPT
      .replace(/^(\s*)\$NodeBaseUrl = '[^']*'$/m, `$1$NodeBaseUrl = '${base}'`)
      .replace(/^(\s*'win-x64' = @\{ File = '[^']+'; )Sha256 = '[0-9a-f]{64}'; Size = \d+ \}$/m, `$1Sha256 = '${sha}'; Size = ${size} }`);
    expect(text).toContain(base);
    expect(text).toContain(sha);
    const p = join(dir, 'install.ps1');
    writeFileSync(p, text, 'utf-8');
    return p;
  }

  function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
    // The real environment (PowerShell needs SystemRoot and friends on Windows), minus the
    // installer's own switches and any Path spelling, then this case's home, temp and PATH.
    const base: NodeJS.ProcessEnv = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (/^(path|processor_architew6432|dreamcontext_install_.*)$/i.test(k)) continue;
      base[k] = v;
    }
    return {
      ...base,
      // No node.exe reachable: the script must take the private-Node path.
      PATH: join(dir, 'emptybin'),
      USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), HOME: home,
      TMPDIR: temp, TMP: temp, TEMP: temp,
      PROCESSOR_ARCHITECTURE: 'AMD64',
      ...extra,
    };
  }

  /** Run the script file; a failure's message comes back on one plain line (PowerShell 7's error
   *  view wraps and colours it). */
  function runScript(file: string, e: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
    const cmd = `try { & '${file.replace(/'/g, "''")}' } catch { 'FAILED: ' + $_.Exception.Message; exit 1 }`;
    return runPwsh(['-Command', cmd], e);
  }

  function runPwsh(args: string[], e: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      execFile(PWSH!, ['-NoProfile', '-NonInteractive', ...args], { env: e, timeout: 120_000 }, (err, stdout, stderr) => {
        resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: `${stdout}\n${stderr}` });
      });
    });
  }

  const nothingInstalled = () => {
    const nodeRoot = join(home, '.dreamcontext', 'node');
    expect(existsSync(join(nodeRoot, '24.21.0'))).toBe(false);
    expect(existsSync(nodeRoot) ? readdirSync(nodeRoot) : []).toEqual([]);
    expect(readdirSync(temp).filter((n) => n.startsWith('dreamcontext-node-'))).toEqual([]);
  };

  it('throws a download of the wrong size away and installs nothing', async () => {
    const r = await runScript(scriptWith(BYTES.length + 1, SHA), env());
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/wrong size, so it was thrown away/);
    expect(requests).toBe(1);
    nothingInstalled();
  }, 150_000);

  it('throws a download that fails its checksum away and installs nothing', async () => {
    const r = await runScript(scriptWith(BYTES.length, '0'.repeat(64)), env());
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/did not match its checksum, so it was thrown away/);
    nothingInstalled();
  }, 150_000);

  it('DREAMCONTEXT_INSTALL_NO_NODE downloads nothing', async () => {
    const r = await runScript(scriptWith(BYTES.length, SHA), env({ DREAMCONTEXT_INSTALL_NO_NODE: '1' }));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/DREAMCONTEXT_INSTALL_NO_NODE is set/);
    expect(requests).toBe(0);
    nothingInstalled();
  }, 150_000);

  it('a computer with no pinned build stops before downloading', async () => {
    const r = await runScript(scriptWith(BYTES.length, SHA), env({ PROCESSOR_ARCHITECTURE: 'x86' }));
    expect(r.out).toMatch(/no private Node\.js build for this computer/);
    expect(requests).toBe(0);
  }, 150_000);

  it('through iex, a failure keeps the caller\'s session and its preferences', async () => {
    const p = scriptWith(BYTES.length, SHA);
    const cmd = `$ErrorActionPreference = 'Continue'; $ProgressPreference = 'Continue'; `
      + `try { Invoke-Expression (Get-Content -Raw -LiteralPath '${p.replace(/'/g, "''")}') } catch { 'caught: ' + $_.Exception.Message }; `
      + `'after: ' + $ErrorActionPreference + ' ' + $ProgressPreference`;
    const r = await runPwsh(['-Command', cmd], env({ DREAMCONTEXT_INSTALL_NO_NODE: '1' }));
    expect(r.out).toMatch(/caught: dreamcontext install: Node\.js >= 18 is required/);
    expect(r.out).toMatch(/after: Continue Continue/);
  }, 150_000);
});
