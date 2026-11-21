import type { Command } from 'commander';
import chalk from 'chalk';
import { request } from 'node:http';
import { error, info, success } from '../../lib/format.js';
import { serverHint } from './handsfree-mac.js';

/**
 * `dreamcontext shares list|close` — live links from the terminal (plan D8). Shares live inside the
 * desktop app's server, so both subcommands call its `/api/shares` routes on loopback. The list
 * never carries a link, token or password; opening a link (and reading it back) is the owner's own
 * click in the app, never a CLI or agent call.
 */

export interface ShareRow {
  id: string; kind: 'app' | 'board'; vault: string; slug: string; name: string;
  state: string; stage: string | null; error?: string; people: number; password: boolean; ai: boolean; openedAt: string;
}

export class SharesCliError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function callShares<T>(method: 'GET' | 'POST', path: string, body?: unknown, home?: string): Promise<T> {
  const hint = serverHint(home);
  if (!hint) return Promise.reject(new SharesCliError('no_app', 'Open the dreamcontext desktop app first: live links run inside it.'));
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise<T>((resolveCall, reject) => {
    const req = request({
      host: '127.0.0.1', port: hint.port, method, path: `/api/shares${path}`,
      headers: { Host: `127.0.0.1:${hint.port}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
      timeout: 30_000,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let parsed: Record<string, unknown> = {};
        try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* empty */ }
        if ((res.statusCode ?? 500) >= 400) reject(new SharesCliError(String(parsed.error ?? 'failed'), String(parsed.message ?? `HTTP ${res.statusCode}`)));
        else resolveCall(parsed as T);
      });
    });
    req.on('error', (e) => reject(new SharesCliError('no_app', `Could not reach the desktop app: ${e.message}`)));
    req.on('timeout', () => req.destroy(new Error('timed out')));
    if (payload) req.write(payload);
    req.end();
  });
}

const STATE: Record<string, string> = { starting: 'starting', open: 'open', closing: 'closing', broken: 'connection lost' };

/** One line per share: what, state, people, password yes/no. Never a link. */
export function formatShareRow(s: ShareRow): string {
  const what = `${s.kind === 'app' ? 'app' : 'board'} ${s.name} (${s.vault}/${s.slug})`;
  const state = s.state === 'starting' && s.stage ? `starting: ${s.stage}` : (STATE[s.state] ?? s.state);
  const extra = [
    s.state === 'open' ? `${s.people} connected` : null,
    s.password ? 'password' : 'no password',
    s.ai ? 'AI on' : null,
    s.error ? `error: ${s.error}` : null,
  ].filter(Boolean).join(', ');
  return `${chalk.bold(s.id)}  ${what}  [${state}]  ${extra}`;
}

export function registerSharesCommand(program: Command): void {
  const shares = program
    .command('shares')
    .description('Live links (one app or one whiteboard over its own tunnel): list and close them. Opening one is the owner\'s click in the app');

  shares
    .command('list')
    .description('List live links: what is shared, state, people connected, password yes/no (never the link)')
    .option('--json', 'JSON output')
    .action(async (opts: { json?: boolean }) => {
      try {
        const out = await callShares<{ shares: ShareRow[] }>('GET', '');
        if (opts.json) { console.log(JSON.stringify(out.shares, null, 2)); return; }
        if (!out.shares.length) { info('No live links.'); return; }
        for (const s of out.shares) console.log(formatShareRow(s));
      } catch (e) {
        error((e as Error).message);
        process.exitCode = 1;
      }
    });

  shares
    .command('close')
    .description('Close a live link now (its guests see "Bu paylaşım kapandı"); `all` closes every one')
    .argument('<id>', 'The share id from `shares list`, or `all`')
    .action(async (id: string) => {
      try {
        if (!/^[A-Za-z0-9]{1,32}$/.test(id)) throw new SharesCliError('bad_id', 'Give a share id from `dreamcontext shares list`.');
        await callShares('POST', `/${id}/close`, { via: 'cli' });
        success(id === 'all' ? 'Every live link is closed.' : `Live link ${id} is closed.`);
      } catch (e) {
        error((e as Error).message);
        process.exitCode = 1;
      }
    });
}
