// GitHub Codespaces over REST with an injected fetch (zero network): create with the W0
// settings, quota refusals, start/stop/delete/get, the private template repo and its blob
// shas (AC19), and the token never leaking into errors.
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { CodespacesProvider, IDLE_TIMEOUT_MINUTES, nextQuotaReset, RETENTION_PERIOD_MINUTES } from '../../src/lib/handsfree/codespaces.js';
import { gitBlobSha, ProviderQuotaError } from '../../src/lib/handsfree/provider.js';

interface Call { method: string; path: string; body: unknown; auth: string | null }

function api(routes: (c: Call) => { status: number; json?: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const h = new Headers(init?.headers as Record<string, string>);
    const c: Call = { method: init?.method ?? 'GET', path: new URL(url).pathname, body: init?.body ? JSON.parse(String(init.body)) : null, auth: h.get('authorization') };
    calls.push(c);
    const r = routes(c);
    return new Response(r.json === undefined ? '' : JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const CS = { name: 'owner-cs-abc', state: 'Available', machine: { name: 'basicLinux32gb' }, web_url: 'https://github.com/codespaces/owner-cs-abc', retention_expires_at: null, last_used_at: null };

describe('CodespacesProvider', () => {
  it('creates the codespace from the private repo with idle 240, retention 43200 and the devcontainer path', async () => {
    const { calls, fetchImpl } = api((c) => {
      if (c.path === '/repos/owner/dreamcontext-handsfree') return { status: 200, json: { id: 42, private: true } };
      if (c.path === '/user/codespaces') return { status: 201, json: CS };
      return { status: 404 };
    });
    const p = new CodespacesProvider({ token: 'gho_secret', owner: 'owner', fetchImpl });
    const info = await p.create({ machine: 'basicLinux32gb' });
    expect(info).toMatchObject({ name: 'owner-cs-abc', state: 'available', url: 'https://owner-cs-abc-8080.app.github.dev' });
    const create = calls.find((c) => c.path === '/user/codespaces')!;
    expect(create.body).toEqual({
      repository_id: 42, machine: 'basicLinux32gb', devcontainer_path: '.devcontainer/devcontainer.json',
      idle_timeout_minutes: IDLE_TIMEOUT_MINUTES, retention_period_minutes: RETENTION_PERIOD_MINUTES, display_name: 'dreamcontext hands-free',
    });
    expect(IDLE_TIMEOUT_MINUTES).toBe(240);
    expect(RETENTION_PERIOD_MINUTES).toBe(43_200);
    expect(calls.every((c) => c.auth === 'Bearer gho_secret')).toBe(true);
  });

  it('a 402 on start is a quota refusal naming when it resets; never echoes the token', async () => {
    const { fetchImpl } = api(() => ({ status: 402, json: { message: 'Payment required' } }));
    const p = new CodespacesProvider({ token: 'gho_secret', owner: 'owner', fetchImpl, now: () => new Date('2026-10-04T10:00:00Z') });
    const err = await p.start('owner-cs-abc').catch((e) => e);
    expect(err).toBeInstanceOf(ProviderQuotaError);
    expect(err.resetsAt).toBe('2026-11-01T00:00:00.000Z');
    expect(String(err.message)).not.toContain('gho_secret');
    expect(nextQuotaReset(new Date('2026-12-15T00:00:00Z'))).toBe('2027-01-01T00:00:00.000Z');
  });

  it('get answers null for a codespace GitHub deleted; stop/delete tolerate 404; quota is unreadable (null)', async () => {
    const { fetchImpl } = api(() => ({ status: 404, json: { message: 'Not Found' } }));
    const p = new CodespacesProvider({ token: 't', owner: 'owner', fetchImpl });
    expect(await p.get('owner-cs-abc')).toBeNull();
    await p.stop('owner-cs-abc');
    await p.delete('owner-cs-abc');
    expect(await p.remainingQuotaCoreMinutes()).toBeNull();
    await expect(p.get('../evil')).rejects.toThrow(/bad codespace name/);
  });

  it('ensures a PRIVATE repo (creates it when missing, refuses a public one)', async () => {
    let exists = false;
    const { calls, fetchImpl } = api((c) => {
      if (c.method === 'GET' && c.path === '/repos/owner/dreamcontext-handsfree') return exists ? { status: 200, json: { id: 7, private: false } } : { status: 404 };
      if (c.method === 'POST' && c.path === '/user/repos') return { status: 201, json: { id: 7 } };
      return { status: 404 };
    });
    const p = new CodespacesProvider({ token: 't', owner: 'owner', fetchImpl });
    expect(await p.ensure()).toBe('owner/dreamcontext-handsfree');
    expect(calls.find((c) => c.path === '/user/repos')!.body).toMatchObject({ name: 'dreamcontext-handsfree', private: true });
    exists = true;
    await expect(p.ensure()).rejects.toThrow(/not private/);
  });

  it('writes only files whose blob differs and reports git blob shas (what the contents API calls sha)', async () => {
    const same = Buffer.from('{"name":"hf"}\n');
    const changed = Buffer.from('#!/bin/sh\necho new\n');
    const { calls, fetchImpl } = api((c) => {
      if (c.method === 'GET' && c.path.endsWith('/devcontainer.json')) return { status: 200, json: { sha: gitBlobSha(same) } };
      if (c.method === 'GET' && c.path.endsWith('/entrypoint.sh')) return { status: 200, json: { sha: 'f'.repeat(40) } };
      if (c.method === 'PUT') return { status: 200, json: {} };
      return { status: 404 };
    });
    const p = new CodespacesProvider({ token: 't', owner: 'owner', fetchImpl });
    const shas = await p.writeFiles({ '.devcontainer/devcontainer.json': same, '.devcontainer/entrypoint.sh': changed }, 'msg');
    const puts = calls.filter((c) => c.method === 'PUT');
    expect(puts.map((c) => c.path)).toEqual(['/repos/owner/dreamcontext-handsfree/contents/.devcontainer/entrypoint.sh']);
    expect(puts[0].body).toMatchObject({ message: 'msg', content: changed.toString('base64'), sha: 'f'.repeat(40) });
    expect(shas['.devcontainer/entrypoint.sh']).toBe(gitBlobSha(changed));
    // gitBlobSha is git's own blob id.
    expect(gitBlobSha(changed)).toBe(execFileSync('git', ['hash-object', '--stdin'], { input: changed, encoding: 'utf8' }).trim());
  });
});
