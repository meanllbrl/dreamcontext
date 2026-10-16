import type { Command } from 'commander';
import chalk from 'chalk';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { error, info, success, warn } from '../../lib/format.js';
import type { MacDevice, MacStatus } from '../../lib/handsfree/mac/contract.js';

/**
 * `dreamcontext handsfree mac …` — Mac mode from the terminal. Mac mode lives INSIDE the desktop
 * app's server (the phone must adopt the chats that process runs), so every subcommand calls
 * that server's `/api/handsfree/mac/*` routes on loopback; the server leaves its port in
 * `~/.dreamcontext/handsfree-mac/server.json`. Secrets (the passphrase, the QR URL) are printed
 * only when stdout is a terminal — never into a pipe, a log or an agent's transcript.
 */

export interface MacCliIo {
  isTTY: boolean;
  out: (line: string) => void;
}

const realIo = (): MacCliIo => ({ isTTY: !!process.stdout.isTTY, out: (l) => console.log(l) });

export function serverHint(home: string = homedir()): { pid: number; port: number } | null {
  try {
    const h = JSON.parse(readFileSync(join(home, '.dreamcontext', 'handsfree-mac', 'server.json'), 'utf8')) as { pid?: unknown; port?: unknown };
    if (!Number.isInteger(h.pid) || !Number.isInteger(h.port)) return null;
    try { process.kill(h.pid as number, 0); } catch { return null; }
    return { pid: h.pid as number, port: h.port as number };
  } catch { return null; }
}

export class MacCliError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function callMac<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown, home?: string): Promise<T> {
  const hint = serverHint(home);
  if (!hint) return Promise.reject(new MacCliError('no_app', 'Open the dreamcontext desktop app first: Mac mode runs inside it.'));
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise<T>((resolveCall, reject) => {
    const req = request({
      host: '127.0.0.1', port: hint.port, method, path: `/api/handsfree/mac/${path}`,
      headers: { Host: `127.0.0.1:${hint.port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout: 15 * 60_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty */ }
        if ((res.statusCode ?? 500) >= 400) reject(new MacCliError(String(parsed.error ?? 'failed'), String(parsed.message ?? `HTTP ${res.statusCode}`)));
        else resolveCall(parsed as T);
      });
    });
    req.on('error', (e) => reject(new MacCliError('no_app', `Could not reach the desktop app: ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

/** Print a secret only to a terminal. Returns whether it was shown. */
export function showSecret(io: MacCliIo, label: string, value: string | null | undefined): boolean {
  if (!value) return false;
  if (!io.isTTY) { io.out(`${label}: (not printed: stdout is not a terminal; open the app to see it)`); return false; }
  io.out(`${label}: ${chalk.bold(value)}`);
  return true;
}

export function printStatus(s: MacStatus, io: MacCliIo): void {
  io.out(`  Mac mode: ${s.phase}${s.url ? `  ${s.url}` : ''}`);
  io.out(`  setup: sleep permission ${s.setup.sudoers ? 'installed' : 'missing'}, passphrase ${s.setup.passphrase ? 'set' : 'not set'}`);
  io.out(`  address: ${s.mode === 'fixed' && s.fixedHostname ? `fixed (${s.fixedHostname})` : 'quick (a new address every start)'}`);
  if (s.phase === 'on') {
    io.out(`  battery: ${s.battery.percent ?? '?'}%${s.battery.charging ? ' (charging)' : ''}${s.sleepAllowed ? ' — sleep allowed again (battery low)' : ''}`);
    io.out(`  signed-in phones: ${s.deviceCount}`);
  }
  if (s.lastError) io.out(`  last error: ${s.lastError}`);
}

function failCli(err: unknown): never {
  error((err as Error)?.message ?? String(err));
  process.exit(1);
}

export function registerHandsfreeMacCommand(hf: Command, io: () => MacCliIo = realIo): void {
  const mac = hf.command('mac').description('Mac mode: drive this laptop from your phone through a tunnel link (no cloud machine)');

  mac.command('setup')
    .description('Install the sleep permission (one admin prompt) and create the phone passphrase')
    .option('--new-passphrase', 'replace the passphrase (signs every phone out)')
    .action(async (o: { newPassphrase?: boolean }) => {
      try {
        const r = await callMac<MacStatus & { passphrase: string | null }>('POST', 'setup', { newPassphrase: !!o.newPassphrase });
        success('Mac mode is set up');
        if (r.passphrase) { showSecret(io(), '  phone passphrase (shown once)', r.passphrase); }
      } catch (err) { failCli(err); }
    });

  mac.command('start')
    .description('Start Mac mode: tunnel link, phone listener, keep awake + Low Power Mode')
    .action(async () => {
      try {
        const s = await callMac<MacStatus>('POST', 'start');
        success(`Mac mode is on: ${s.url}`);
        const qr = await callMac<{ url: string }>('POST', 'qr');
        showSecret(io(), '  one-time sign-in link (5 min)', qr.url);
        info('Or open the address on your phone and type the passphrase.');
      } catch (err) { failCli(err); }
    });

  mac.command('stop')
    .description('Return: close the tunnel, sign every phone out, allow sleep again')
    .action(async () => {
      try { await callMac('POST', 'stop'); success('Mac mode is off; sleep and Low Power Mode are restored'); } catch (err) { failCli(err); }
    });

  mac.command('status')
    .description('Show Mac mode')
    .action(async () => {
      try { printStatus(await callMac<MacStatus>('GET', 'status'), io()); } catch (err) { failCli(err); }
    });

  mac.command('password')
    .description('Set a new phone passphrase (signs every phone out)')
    .action(async () => {
      try {
        const r = await callMac<{ passphrase: string }>('POST', 'password');
        success('new passphrase set; every phone is signed out');
        showSecret(io(), '  phone passphrase (shown once)', r.passphrase);
      } catch (err) { failCli(err); }
    });

  const devices = mac.command('devices').description('Phones signed in to this Mac')
    .action(async () => {
      try {
        const r = await callMac<{ devices: MacDevice[] }>('GET', 'devices');
        if (!r.devices.length) { info('no phone is signed in'); return; }
        for (const d of r.devices) io().out(`  ${d.label}  since ${d.createdAt}`);
      } catch (err) { failCli(err); }
    });
  devices.command('revoke-all')
    .description('Sign every phone out now (cuts a turn a phone is running)')
    .action(async () => {
      try { const r = await callMac<{ revoked: number }>('POST', 'devices/revoke-all'); success(`${r.revoked} phone(s) signed out`); } catch (err) { failCli(err); }
    });

  const tun = mac.command('tunnel').description('The phone address: quick (default) or fixed (your own domain on Cloudflare)');
  tun.command('fixed <hostname>')
    .description('Set up a fixed address on your Cloudflare domain (opens Cloudflare in your browser)')
    .option('--overwrite-dns', 'Replace a DNS record the hostname already has (whatever it serves stops answering)')
    .action(async (hostname: string, opts: { overwriteDns?: boolean }) => {
      try {
        info('A browser window opens on Cloudflare: pick the domain to authorise this Mac.');
        const r = await callMac<{ hostname: string }>('POST', 'tunnel/fixed', { hostname, ...(opts.overwriteDns ? { overwrite: true } : {}) });
        success(`fixed address ready: https://${r.hostname}`);
      } catch (err) {
        if (err instanceof MacCliError && err.code === 'mac_hostname_in_use') warn(`${hostname} already has a DNS record; re-run with --overwrite-dns to replace it`);
        failCli(err);
      }
    });
  tun.command('quick')
    .description('Go back to a quick address (a new one every start)')
    .action(async () => {
      try { await callMac('DELETE', 'tunnel/fixed'); success('quick address from the next start'); } catch (err) { failCli(err); }
    });

  mac.command('uninstall')
    .description('Remove the sleep permission (one admin prompt) and every Mac-mode file')
    .action(async () => {
      try { await callMac('POST', 'uninstall'); success('Mac mode is removed'); } catch (err) { if (err instanceof MacCliError && err.code === 'no_app') warn('open the desktop app to uninstall (the admin prompt comes from it)'); failCli(err); }
    });
}
