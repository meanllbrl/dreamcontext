// Hands-free (Mac mode) is macOS only, and Windows must SAY so rather than half-work: the server
// reports `supported: false`, setup / start / the fixed address refuse before they touch sudo, a
// tunnel or cloudflared, the CLI answers with the platform, and the panel hides the button and the
// settings card. This file is NOT in tests/windows-skip.ts: it is the lock the Windows CI job runs
// (mac-session.test.ts, which covers the Mac side, is skipped there).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Command } from 'commander';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MacSession, MacModeError, type MacSessionDeps } from '../../src/lib/handsfree/mac/session.js';
import { HandsfreeAuth, ensureMacHandsfreeDir, generatePassphrase, hashPassphrase } from '../../src/server/handsfree-auth.js';
import { macOnlyMessage, registerHandsfreeMacCommand } from '../../src/cli/commands/handsfree-mac.js';
import { macModeOffered } from '../../dashboard/src/components/handsfree/macContract.js';

let home: string;
let auth: HandsfreeAuth;
let touched: string[];

function session(platform: NodeJS.Platform, over: Partial<MacSessionDeps> = {}): MacSession {
  const touch = (what: string) => async () => { touched.push(what); throw new Error(`${what} must not run off macOS`); };
  return new MacSession({
    home,
    serverPid: 777,
    platform,
    auth: () => auth as never,
    hashPassphrase: (p) => hashPassphrase(p),
    generatePassphrase: () => generatePassphrase(),
    startListener: touch('listener') as never,
    stopListener: async () => {},
    setPublicOrigin: () => {},
    setProbeNonce: () => {},
    setPhoneSource: () => {},
    releasePhoneSessions: () => 0,
    notify: () => {},
    powerRun: (async (file: string) => { touched.push(file); return { code: 1, stdout: '', stderr: '' }; }) as never,
    ensureBinary: touch('cloudflared download') as never,
    setupFixedTunnel: touch('fixed tunnel') as never,
    installSudoers: touch('sudoers') as never,
    sudoersInstalled: () => false,
    isAlive: () => false,
    commandOf: () => '',
    kill: vi.fn(),
    ...over,
  });
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'hf-win-gate-'));
  auth = new HandsfreeAuth({ dir: ensureMacHandsfreeDir(home) });
  touched = [];
});
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

async function refusal(p: Promise<unknown>): Promise<string> {
  try { await p; } catch (e) { return e instanceof MacModeError ? e.code : `not a MacModeError: ${String(e)}`; }
  return 'resolved';
}

describe('Mac mode on win32 (server)', () => {
  it('status says it is not supported; on a Mac it is', () => {
    expect(session('win32').status().supported).toBe(false);
    expect(session('linux').status().supported).toBe(false);
    expect(session('darwin').status().supported).toBe(true);
  });

  it('setup, start and the fixed address refuse before touching sudo, a listener, a tunnel or cloudflared', async () => {
    const s = session('win32');
    expect(await refusal(s.setup())).toBe('mac_unsupported_platform');
    expect(await refusal(s.start({ vaults: ['alpha'] }))).toBe('mac_unsupported_platform');
    expect(await refusal(s.setupFixed('hands.example.com'))).toBe('mac_unsupported_platform');
    expect(touched).toEqual([]);
    expect(s.status().phase).toBe('off');
  });
});

describe('`dreamcontext handsfree mac …` on win32 (CLI)', () => {
  it('says macOS only, not "open the app first", for every subcommand', async () => {
    expect(macOnlyMessage('darwin')).toBeNull();
    expect(macOnlyMessage('win32')).toMatch(/macOS only/);
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      for (const argv of [['mac', 'status'], ['mac', 'setup'], ['mac', 'start', '--project', 'alpha'], ['mac', 'tunnel', 'fixed', 'hands.example.com']]) {
        const hf = new Command('handsfree').exitOverride();
        registerHandsfreeMacCommand(hf, () => ({ isTTY: false, out: () => {} }), 'win32');
        await expect(hf.parseAsync(argv, { from: 'user' })).rejects.toThrow('exit 1');
      }
      const printed = [...err.mock.calls, ...log.mock.calls].flat().join('\n');
      expect(printed).toMatch(/macOS only/);
      expect(printed).not.toMatch(/Open the dreamcontext desktop app first/);
    } finally {
      exit.mockRestore(); err.mockRestore(); log.mockRestore();
    }
  });
});

describe('the panel on win32 (dashboard)', () => {
  it('offers Mac mode only where the server did not say unsupported', () => {
    expect(macModeOffered({ supported: false } as never)).toBe(false);
    expect(macModeOffered({ supported: true } as never)).toBe(true);
    // No reading yet, or an older server without the field: the Mac's behaviour, unchanged.
    expect(macModeOffered(null)).toBe(true);
    expect(macModeOffered({} as never)).toBe(true);
  });

  it('the chrome button and the settings card both hide on that answer', () => {
    const read = (f: string) => readFileSync(new URL(`../../dashboard/src/components/handsfree/${f}`, import.meta.url), 'utf-8');
    expect(read('HandsfreeButton.tsx')).toMatch(/if \(!isDesktop\(\) \|\| !vault \|\| !macModeOffered\(mac\)\) return null;/);
    expect(read('HandsfreeSettingsCard.tsx')).toMatch(/if \(!isDesktop\(\) \|\| !macModeOffered\(mac\)\) return null;/);
    expect(read('HandsfreeSettingsCard.tsx')).toMatch(/const mac = useMacStatus\(\);/);
  });
});
