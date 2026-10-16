// AC18: `dreamcontext handsfree mac …` mirrors the panel; secrets are printed only on a TTY.
import { describe, it, expect, afterEach } from 'vitest';
import { Command } from 'commander';
import http from 'node:http';
import net from 'node:net';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { callMac, registerHandsfreeMacCommand, serverHint, showSecret } from '../../src/cli/commands/handsfree-mac.js';

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
