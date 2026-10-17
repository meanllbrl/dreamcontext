// Mac mode, the last pieces of AC4 (no query string in any log), AC16 (a fixed address starts at
// https://<hostname> with our own ingress config) and AC19 (uninstall removes the drop-in).
import { describe, it, expect, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { makeRequestHandler } from '../../src/server/index.js';
import { Router } from '../../src/server/router.js';
import { markPhoneSocket, setMacExposedVaults } from '../../src/server/phone-origin.js';
import { addVault } from '../../src/lib/vaults.js';
import { startTunnel } from '../../src/lib/handsfree/mac/tunnel.js';
import { MacSession } from '../../src/lib/handsfree/mac/session.js';
import { HandsfreeAuth, ensureMacHandsfreeDir, generatePassphrase, hashPassphrase } from '../../src/server/handsfree-auth.js';

describe('AC4: the phone listener never logs a query string', () => {
  it('an unhandled error on a phone socket logs the path only — the one-time token never reaches the log', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mac-extra-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    mkdirSync(join(home, 'proj', '_dream_context'), { recursive: true });
    addVault('proj', join(home, 'proj'));
    setMacExposedVaults(['proj']);
    const router = new Router();
    router.get('/api/health', async () => { throw new Error('boom'); });
    const handler = makeRequestHandler({ gate: () => true, router, dashboardDir: tmpdir(), contextRoot: null });
    const sock = { remoteAddress: '127.0.0.1' };
    markPhoneSocket(sock);
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    let status = 0;
    const res = { setHeader() {}, writeHead(c: number) { status = c; return res; }, end() {} } as unknown as ServerResponse;
    try {
      await handler({ method: 'GET', url: '/api/health?t=SECRET-ONE-TIME-TOKEN', headers: { host: 'a.trycloudflare.com' }, socket: sock } as unknown as IncomingMessage, res);
    } finally {
      spy.mockRestore();
      setMacExposedVaults([]);
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
      rmSync(home, { recursive: true, force: true });
    }
    expect(status).toBeGreaterThanOrEqual(400);
    expect(logged.join('\n')).not.toContain('SECRET-ONE-TIME-TOKEN');
    expect(logged.join('\n')).toContain('GET /api/health');
  });
});

describe('AC16: a fixed address starts at https://<hostname>, ingress written by us', () => {
  it('runs `tunnel run <id>` with our config and resolves the hostname once a connection registers', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mac-fixed-'));
    try {
      const argvOut = join(dir, 'argv.json');
      const bin = join(dir, 'fake.mjs');
      writeFileSync(bin, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify(process.argv.slice(2)));
setTimeout(() => process.stderr.write('INF Registered tunnel connection connIndex=0\\n'), 50); setInterval(() => {}, 1000);`);
      chmodSync(bin, 0o755);
      mkdirSync(join(dir, 'mac'));
      writeFileSync(join(dir, 'mac', 'tunnel.json'), '{}', { mode: 0o600 });
      const rec = { hostname: 'phone.example.com', tunnelId: '6f1c2e9a-a001-4a5b-8c9d-0123456789ab', name: 'dreamcontext-hf' };
      const run = await startTunnel({
        bin: process.execPath, macDir: join(dir, 'mac'), phonePort: 41999, fixed: rec, timeoutMs: 10_000,
        spawnImpl: (f, a, o) => spawn(f, [bin, ...a], { env: o.env, cwd: o.cwd, stdio: ['ignore', 'pipe', 'pipe'] }),
      });
      try {
        expect(run.url).toBe('https://phone.example.com');
        expect(run.mode).toBe('fixed');
        const argv = JSON.parse(readFileSync(argvOut, 'utf8')) as string[];
        expect(argv).toEqual(['tunnel', '--no-autoupdate', '--config', join(dir, 'mac', 'cloudflared-fixed.yml'), 'run', rec.tunnelId]);
        const yaml = readFileSync(join(dir, 'mac', 'cloudflared-fixed.yml'), 'utf8');
        expect(yaml).toContain('service: http://127.0.0.1:41999');
        expect(yaml).toContain('- service: http_status:404');
      } finally { run.child.kill('SIGKILL'); }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('AC19: uninstall removes the sudoers drop-in and the Mac dir', () => {
  it('one admin prompt removes the drop-in, then the Mac dir is gone', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mac-uninstall-'));
    try {
      const auth = new HandsfreeAuth({ dir: ensureMacHandsfreeDir(home) });
      auth.store.setPassphrase(await hashPassphrase('a b c d e f'));
      let installed = true;
      const removeSudoers = vi.fn(async () => { installed = false; return 'ok' as const; });
      const s = new MacSession({
        home, platform: 'darwin', auth: () => auth as never, hashPassphrase: (p) => hashPassphrase(p), generatePassphrase,
        startListener: async () => ({ port: 1 }), stopListener: async () => {}, setPublicOrigin: () => {}, setProbeNonce: () => {}, setPhoneSource: () => {},
        releasePhoneSessions: () => 0, notify: () => {},
        sudoersInstalled: () => installed, removeSudoers, readThermal: async () => 'nominal',
      });
      await s.uninstall();
      expect(removeSudoers).toHaveBeenCalledTimes(1);
      expect(installed).toBe(false);
      expect(existsSync(join(home, '.dreamcontext', 'handsfree-mac'))).toBe(false);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  it('the remove script refuses to follow a symlink and checks the file is gone', async () => {
    const { sudoersRemoveScript, SUDOERS_PATH } = await import('../../src/lib/handsfree/mac/power.js');
    expect(sudoersRemoveScript()).toBe(`/bin/test ! -L ${SUDOERS_PATH} && /bin/rm -f ${SUDOERS_PATH}; /bin/test ! -e ${SUDOERS_PATH}`);
  });
});
