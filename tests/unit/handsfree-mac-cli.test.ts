// AC18: `dreamcontext handsfree mac …` mirrors the panel; secrets are printed only on a TTY.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { Command } from 'commander';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bagModeLine, callMac, registerHandsfreeMacCommand, serverHint, showSecret, startBody, startVaults } from '../../src/cli/commands/handsfree-mac.js';
import { addVault } from '../../src/lib/vaults.js';

let home = '';
afterEach(() => { if (home) rmSync(home, { recursive: true, force: true }); home = ''; });

describe('handsfree mac CLI', () => {
  it('registers every subcommand the panel has', () => {
    const hf = new Command('handsfree');
    registerHandsfreeMacCommand(hf);
    const mac = hf.commands.find((c) => c.name() === 'mac')!;
    expect(mac.commands.map((c) => c.name()).sort()).toEqual(['devices', 'password', 'setup', 'start', 'status', 'stop', 'tunnel', 'uninstall']);
    expect(mac.commands.find((c) => c.name() === 'devices')!.commands.map((c) => c.name())).toEqual(['revoke-all']);
    expect(mac.commands.find((c) => c.name() === 'tunnel')!.commands.map((c) => c.name()).sort()).toEqual(['fixed', 'quick']);
  });

  it('AC16: start exposes every --project (registered names), else the project it runs in; otherwise a listed error', () => {
    home = mkdtempSync(join(tmpdir(), 'mac-cli-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      for (const n of ['alpha', 'beta']) { mkdirSync(join(home, n, '_dream_context'), { recursive: true }); addVault(n, join(home, n)); }
      expect(startVaults(['alpha', 'beta', 'alpha'], home)).toEqual(['alpha', 'beta']);
      expect(() => startVaults(['alpha', 'nope'], home)).toThrow(/Not a registered project: nope\. Registered projects: alpha, beta/);
      expect(startVaults([], join(home, 'beta'))).toEqual(['beta']);
      expect(() => startVaults([], home)).toThrow(/--project <name>.*Registered projects: alpha, beta/);
      const hf = new Command('handsfree');
      registerHandsfreeMacCommand(hf);
      const start = hf.commands.find((c) => c.name() === 'mac')!.commands.find((c) => c.name() === 'start')!;
      expect(start.options.map((o) => o.long)).toContain('--project');
    } finally {
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });

  it('bag mode: start has --bag / --no-bag; the body carries bagMode only when a flag chose it', () => {
    const hf = new Command('handsfree');
    registerHandsfreeMacCommand(hf);
    const start = hf.commands.find((c) => c.name() === 'mac')!.commands.find((c) => c.name() === 'start')!;
    expect(start.options.map((o) => o.long)).toEqual(expect.arrayContaining(['--bag', '--no-bag']));
    expect(startBody(['a'], undefined)).toEqual({ vaults: ['a'] });
    expect(startBody(['a'], false)).toEqual({ vaults: ['a'], bagMode: false });
    expect(startBody(['a'], true)).toEqual({ vaults: ['a'], bagMode: true });
  });

  it('bag mode: `start --no-bag` / `--bag` / no flag send false / true / nothing to the desktop server', async () => {
    home = mkdtempSync(join(tmpdir(), 'mac-cli-'));
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    const bodies: string[] = [];
    const srv = http.createServer((q, r) => {
      const chunks: Buffer[] = [];
      q.on('data', (c: Buffer) => chunks.push(c));
      q.on('end', () => {
        if (q.url === '/api/handsfree/mac/start') bodies.push(Buffer.concat(chunks).toString('utf8'));
        r.setHeader('Content-Type', 'application/json');
        r.end(q.url === '/api/handsfree/mac/start' ? '{"phase":"on","url":"https://a-b.trycloudflare.com","bagMode":false}' : '{}');
      });
    });
    try {
      mkdirSync(join(home, 'alpha', '_dream_context'), { recursive: true });
      addVault('alpha', join(home, 'alpha'));
      await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
      const port = (srv.address() as net.AddressInfo).port;
      mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
      writeFileSync(join(home, '.dreamcontext', 'handsfree-mac', 'server.json'), JSON.stringify({ pid: process.pid, port }));
      const io = { isTTY: false, out: () => {} };
      const log = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        for (const flags of [['--no-bag'], ['--bag'], []]) {
          const hf = new Command('handsfree');
          registerHandsfreeMacCommand(hf, () => io);
          await hf.parseAsync(['mac', 'start', '--project', 'alpha', ...flags], { from: 'user' });
        }
        expect(log.mock.calls.flat().join('\n')).toContain('Mac mode is on (normal mode)');
      } finally { log.mockRestore(); }
      expect(bodies.map((b) => JSON.parse(b))).toEqual([
        { vaults: ['alpha'], bagMode: false },
        { vaults: ['alpha'], bagMode: true },
        { vaults: ['alpha'] },
      ]);
    } finally {
      srv.close();
      if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    }
  });

  it('bag mode: the status line names the run\'s mode while on, the next start\'s while off', () => {
    expect(bagModeLine({ phase: 'on', bagMode: true })).toBe('bag mode: on (heavy processes slow down while the Mac is hot)');
    expect(bagModeLine({ phase: 'on', bagMode: false })).toBe('bag mode: off (full performance)');
    expect(bagModeLine({ phase: 'off', bagMode: true })).toBe('bag mode for the next start: on');
    expect(bagModeLine({ phase: 'off', bagMode: false })).toBe('bag mode for the next start: off');
  });

  it('prints a secret to a terminal only; a pipe gets a pointer to the app', () => {
    const tty: string[] = [];
    const pipe: string[] = [];
    expect(showSecret({ isTTY: true, out: (l) => tty.push(l) }, 'pass', 'alpha bravo')).toBe(true);
    expect(tty.join('\n')).toContain('alpha bravo');
    expect(showSecret({ isTTY: false, out: (l) => pipe.push(l) }, 'pass', 'alpha bravo')).toBe(false);
    expect(pipe.join('\n')).not.toContain('alpha bravo');
    expect(pipe.join('\n')).toMatch(/not a terminal/);
  });

  it('talks to the desktop server named in server.json on loopback; no app → a clear error', async () => {
    home = mkdtempSync(join(tmpdir(), 'mac-cli-'));
    await expect(callMac('GET', 'status', undefined, home)).rejects.toThrow(/Open the dreamcontext desktop app/);
    const seen: string[] = [];
    const srv = http.createServer((q, r) => { seen.push(`${q.method} ${q.url} ${q.headers.host}`); r.setHeader('Content-Type', 'application/json'); r.end('{"phase":"off"}'); });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as net.AddressInfo).port;
    mkdirSync(join(home, '.dreamcontext', 'handsfree-mac'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'handsfree-mac', 'server.json'), JSON.stringify({ pid: process.pid, port }));
    expect(serverHint(home)).toEqual({ pid: process.pid, port });
    expect(await callMac('GET', 'status', undefined, home)).toEqual({ phase: 'off' });
    expect(seen).toEqual([`GET /api/handsfree/mac/status 127.0.0.1:${port}`]);
    srv.close();
  });
});
