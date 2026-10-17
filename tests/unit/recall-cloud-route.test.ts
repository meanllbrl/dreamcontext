import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  createRecallCloudRoutes,
  requireLocalDashboardRead,
  requireLocalDashboardWrite,
  type RecallCloudRoutes,
} from '../../src/server/routes/recall-cloud.js';
import { CLOUD_DISCLOSURE_VERSION } from '../../src/lib/embeddings/egress-rules.js';
import { readRecallCloudConfig, readVaultConsent, recallCloudKeyInfo } from '../../src/lib/recall-cloud-config.js';
import type { buildCloudIndex } from '../../src/lib/embeddings/vector-store.js';

/**
 * The cloud-recall routes: the guard (foreign Origin, DNS rebinding, missing Origin, non-loopback
 * socket, hands-free cloud), the consent contract, single-flight indexing, and the promise that no
 * response ever carries a key. Everything runs against a temp home and a temp vault.
 */

const HOST = '127.0.0.1:4173';
const ORIGIN = `http://${HOST}`;
const KEY = 'sk-or-v1-PLANTED-RECALL-KEY-0123456789';
const VOICE_KEY = 'sk-or-v1-PLANTED-VOICE-KEY-9876543210';

interface Opts { host?: string; origin?: string | null; remote?: string }

function req(method: 'GET' | 'POST', url: string, body?: unknown, o: Opts = {}): IncomingMessage {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
  const headers: Record<string, string> = { host: o.host ?? HOST };
  const origin = o.origin === undefined ? (method === 'GET' ? null : ORIGIN) : o.origin;
  if (origin !== null) headers.origin = origin;
  Object.assign(stream, { method, url, headers, socket: { remoteAddress: o.remote ?? '127.0.0.1' } });
  return stream;
}

type Handler = (q: IncomingMessage, s: ServerResponse, p: Record<string, string>, root: string) => Promise<void>;

async function call(h: Handler, q: IncomingMessage, root: string) {
  const out = { status: 0, text: '' };
  const r = { writeHead(c: number) { out.status = c; return r; }, end(b?: string) { out.text = b ?? ''; } };
  await h(q, r as unknown as ServerResponse, {}, root);
  return { status: out.status, text: out.text, json: JSON.parse(out.text) as Record<string, unknown> };
}

let tmp: string;
let home: string;
let root: string;
let routes: RecallCloudRoutes;
let build: ReturnType<typeof vi.fn>;
const ENV = ['DREAMCONTEXT_RECALL_OPENROUTER_KEY', 'OPENROUTER_API_KEY'];

const MUTATIONS: Array<{ name: string; pick: (r: RecallCloudRoutes) => Handler; url: string; body: unknown }> = [
  { name: 'key', pick: (r) => r.setKey, url: '/api/recall/cloud/key', body: { key: KEY } },
  { name: 'key/copy-voice', pick: (r) => r.copyVoiceKey, url: '/api/recall/cloud/key/copy-voice', body: { confirmed: true } },
  { name: 'enable', pick: (r) => r.enable, url: '/api/recall/cloud/enable', body: { tier: 'cloud-index', consent: true, disclosureVersion: CLOUD_DISCLOSURE_VERSION } },
  { name: 'disable', pick: (r) => r.disable, url: '/api/recall/cloud/disable', body: {} },
  { name: 'index', pick: (r) => r.startIndex, url: '/api/recall/cloud/index', body: {} },
];
const READS: Array<{ name: string; pick: (r: RecallCloudRoutes) => Handler; url: string }> = [
  { name: 'status', pick: (r) => r.status, url: '/api/recall/cloud/status' },
  { name: 'index/status', pick: (r) => r.indexStatus, url: '/api/recall/cloud/index/status' },
];

function snapshotTree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(`${p}:${statSync(p).size}:${readFileSync(p, 'utf-8')}`);
    }
  };
  walk(dir);
  return out.sort();
}

const setKeyDirect = async (): Promise<void> => {
  const r = await call(routes.setKey, req('POST', '/api/recall/cloud/key', { key: KEY }), root);
  expect(r.status).toBe(200);
};

beforeEach(() => {
  for (const k of ENV) vi.stubEnv(k, '');
  tmp = mkdtempSync(join(tmpdir(), 'dc-cloud-route-'));
  home = join(tmp, 'home');
  root = join(tmp, 'vault', '_dream_context');
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, 'state'), { recursive: true });
  build = vi.fn(async () => ({ embedded: 0, reused: 0, evicted: 0, spentUsd: 0, aborted: null }));
  routes = createRecallCloudRoutes({ home, loadCorpus: () => [], build: build as unknown as typeof buildCloudIndex });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe('the guard on mutating routes', () => {
  for (const m of MUTATIONS) {
    describe(m.name, () => {
      it('refuses a foreign Origin', async () => {
        const r = await call(m.pick(routes), req('POST', m.url, m.body, { origin: 'https://evil.example' }), root);
        expect(r.status).toBe(403);
      });

      it('refuses DNS rebinding: Origin == Host == a foreign name, from a loopback socket', async () => {
        const r = await call(m.pick(routes), req('POST', m.url, m.body, { host: 'evil.example:4173', origin: 'http://evil.example:4173' }), root);
        expect(r.status).toBe(403);
      });

      it('refuses a missing Origin', async () => {
        const r = await call(m.pick(routes), req('POST', m.url, m.body, { origin: null }), root);
        expect(r.status).toBe(403);
      });

      it('refuses a non-loopback socket even with a perfect Host and Origin', async () => {
        const r = await call(m.pick(routes), req('POST', m.url, m.body, { remote: '192.168.1.20' }), root);
        expect(r.status).toBe(403);
      });

      it('refuses a Host without a port, and an https Origin', async () => {
        expect((await call(m.pick(routes), req('POST', m.url, m.body, { host: '127.0.0.1', origin: 'http://127.0.0.1' }), root)).status).toBe(403);
        expect((await call(m.pick(routes), req('POST', m.url, m.body, { origin: `https://${HOST}` }), root)).status).toBe(403);
      });

      it('changes nothing when refused', async () => {
        await call(m.pick(routes), req('POST', m.url, m.body, { origin: 'https://evil.example' }), root);
        expect(existsSync(join(home, '.dreamcontext'))).toBe(false);
      });
    });
  }

  it('accepts all three loopback spellings of Host', () => {
    for (const host of ['localhost:4173', '127.0.0.1:4173', '[::1]:4173']) {
      expect(requireLocalDashboardWrite(req('POST', '/x', {}, { host, origin: `http://${host}` }))).toBe(true);
    }
  });

  it('accepts an IPv4-mapped IPv6 loopback peer', () => {
    expect(requireLocalDashboardWrite(req('POST', '/x', {}, { remote: '::ffff:127.0.0.1' }))).toBe(true);
  });
});

describe('the guard on read routes', () => {
  for (const g of READS) {
    describe(g.name, () => {
      it('answers a same-origin GET that carries no Origin', async () => {
        expect((await call(g.pick(routes), req('GET', g.url), root)).status).toBe(200);
      });

      it('refuses a rebound Host', async () => {
        expect((await call(g.pick(routes), req('GET', g.url, undefined, { host: 'evil.example:4173', origin: 'http://evil.example:4173' }), root)).status).toBe(403);
        expect((await call(g.pick(routes), req('GET', g.url, undefined, { host: 'evil.example:4173' }), root)).status).toBe(403);
      });

      it('refuses a GET that carries a foreign Origin', async () => {
        expect((await call(g.pick(routes), req('GET', g.url, undefined, { origin: 'https://evil.example' }), root)).status).toBe(403);
      });
    });
  }

  it('no GET mutates anything', async () => {
    await setKeyDirect();
    const before = snapshotTree(tmp);
    for (const g of READS) await call(g.pick(routes), req('GET', g.url), root);
    expect(snapshotTree(tmp)).toEqual(before);
  });

  it('does not answer under the same rules a write needs (read guard is the weaker of the two)', () => {
    expect(requireLocalDashboardRead(req('GET', '/x'))).toBe(true);
    expect(requireLocalDashboardWrite(req('GET', '/x', undefined, { origin: null }))).toBe(false);
  });
});

describe('the key never leaves', () => {
  it('appears in no response, no error and no audit line', async () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'voice.json'), JSON.stringify({ openRouterKey: VOICE_KEY }));
    const texts: string[] = [];
    const keep = async (h: Handler, q: IncomingMessage): Promise<void> => { texts.push((await call(h, q, root)).text); };

    await keep(routes.setKey, req('POST', '/k', { key: KEY }));
    await keep(routes.status, req('GET', '/s'));
    await keep(routes.enable, req('POST', '/e', { tier: 'cloud', consent: true, disclosureVersion: CLOUD_DISCLOSURE_VERSION }));
    await keep(routes.startIndex, req('POST', '/i', {}));
    await keep(routes.indexStatus, req('GET', '/is'));
    await keep(routes.setKey, req('POST', '/k', { key: 'short' }));
    await keep(routes.enable, req('POST', '/e', { tier: 'cloud' }));
    await keep(routes.copyVoiceKey, req('POST', '/c', { confirmed: true }));
    await keep(routes.status, req('GET', '/s'));
    await keep(routes.disable, req('POST', '/d', {}));
    await keep(routes.setKey, req('POST', '/k', { key: `${KEY} with space` }));
    await keep(routes.setKey, req('POST', '/k', { key: 'x'.repeat(2000) }));

    const audit = readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8');
    for (const text of [...texts, audit]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toContain(VOICE_KEY);
      expect(text).not.toContain('openRouterKey');
    }
    // The status says the key exists and where it lives, nothing more.
    const status = JSON.parse(texts[1]) as Record<string, unknown>;
    expect(status).toMatchObject({ key: true, keySource: 'file', keyOrigin: 'manual' });
  });

  it('reports a key from the environment as present with source env', async () => {
    vi.stubEnv('DREAMCONTEXT_RECALL_OPENROUTER_KEY', KEY);
    const r = await call(routes.status, req('GET', '/s'), root);
    expect(r.json).toMatchObject({ key: true, keySource: 'env' });
    expect(r.text).not.toContain(KEY);
  });

  it('stores a pasted key and audits it as a dashboard event', async () => {
    await setKeyDirect();
    expect(recallCloudKeyInfo(home)).toMatchObject({ present: true, source: 'file', origin: 'manual' });
    const audit = readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(audit).toEqual([expect.objectContaining({ event: 'key_set', surface: 'dashboard' })]);
  });

  it('rejects keys that are too short, contain whitespace, or are enormous', async () => {
    for (const key of ['short', `${KEY} x`, `${KEY}\n\nx`, 'k'.repeat(600), 42, undefined]) {
      const r = await call(routes.setKey, req('POST', '/k', { key }), root);
      expect(r.status).toBe(400);
    }
    expect(recallCloudKeyInfo(home).present).toBe(false);
  });
});

describe('copy my Voice key', () => {
  const plantVoiceKey = (): void => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(join(home, '.dreamcontext', 'voice.json'), JSON.stringify({ openRouterKey: VOICE_KEY }));
  };

  it('needs an explicit confirmation in the body', async () => {
    plantVoiceKey();
    for (const body of [undefined, {}, { confirmed: 'yes' }, { confirmed: false }]) {
      const r = await call(routes.copyVoiceKey, req('POST', '/c', body), root);
      expect(r.status).toBe(400);
    }
    expect(recallCloudKeyInfo(home).present).toBe(false);
  });

  it('answers 409 when there is no Voice key', async () => {
    const r = await call(routes.copyVoiceKey, req('POST', '/c', { confirmed: true }), root);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('no_voice_key');
  });

  it('copies it, labels the origin, audits it, and reports only a boolean', async () => {
    plantVoiceKey();
    const before = await call(routes.status, req('GET', '/s'), root);
    expect(before.json.voiceKeyAvailable).toBe(true);
    const r = await call(routes.copyVoiceKey, req('POST', '/c', { confirmed: true }), root);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ key: true, keySource: 'file', keyOrigin: 'voice-copy' });
    expect(r.text).not.toContain(VOICE_KEY);
    const audit = readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8');
    expect(audit).toContain('"event":"key_copy_voice"');
    expect(audit).toContain('"surface":"dashboard"');
  });
});

describe('enable', () => {
  const enableBody = (over: Record<string, unknown> = {}) => ({
    tier: 'cloud-index', consent: true, disclosureVersion: CLOUD_DISCLOSURE_VERSION, ...over,
  });

  it('refuses without consent === true', async () => {
    await setKeyDirect();
    for (const consent of [undefined, false, 'true', 1, null]) {
      const r = await call(routes.enable, req('POST', '/e', enableBody({ consent })), root);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('consent_required');
    }
    expect(readVaultConsent(root, home)).toBeNull();
  });

  it('refuses a wrong or missing disclosureVersion', async () => {
    await setKeyDirect();
    for (const disclosureVersion of [CLOUD_DISCLOSURE_VERSION + 1, 0, String(CLOUD_DISCLOSURE_VERSION), undefined]) {
      const r = await call(routes.enable, req('POST', '/e', enableBody({ disclosureVersion })), root);
      expect(r.status).toBe(400);
      expect(r.json.error).toBe('disclosure_mismatch');
    }
    expect(readVaultConsent(root, home)).toBeNull();
  });

  it('refuses a bad tier and an unknown rerank model', async () => {
    await setKeyDirect();
    expect((await call(routes.enable, req('POST', '/e', enableBody({ tier: 'local' })), root)).status).toBe(400);
    expect((await call(routes.enable, req('POST', '/e', enableBody({ tier: 'cloud', rerankModel: 'evil/model' })), root)).status).toBe(400);
    expect(readVaultConsent(root, home)).toBeNull();
  });

  it('refuses when no key exists', async () => {
    const r = await call(routes.enable, req('POST', '/e', enableBody()), root);
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('no_key');
    expect(readVaultConsent(root, home)).toBeNull();
  });

  it('grants a cloud-index consent from the dashboard with no rerank model, and sets hybrid', async () => {
    await setKeyDirect();
    const r = await call(routes.enable, req('POST', '/e', enableBody({ rerankModel: 'voyageai/rerank-2.5' })), root);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tier: 'cloud-index', consent: 'valid', consentSurface: 'dashboard', rerankModel: null });
    expect(readVaultConsent(root, home)).toMatchObject({ tier: 'cloud-index', surface: 'dashboard', rerankModel: null, disclosureVersion: CLOUD_DISCLOSURE_VERSION });
    const sleep = JSON.parse(readFileSync(join(root, 'state', '.sleep.json'), 'utf-8')) as { recall_mode: string };
    expect(sleep.recall_mode).toBe('hybrid');
    const audit = readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8');
    expect(audit).toMatch(/"event":"grant"[^\n]*"surface":"dashboard"/);
  });

  it('grants the cloud tier with the chosen rerank model', async () => {
    await setKeyDirect();
    const r = await call(routes.enable, req('POST', '/e', enableBody({ tier: 'cloud', rerankModel: 'voyageai/rerank-2.5' })), root);
    expect(r.json).toMatchObject({ tier: 'cloud', rerankModel: 'voyageai/rerank-2.5' });
  });

  it('serves a disclosure for each tier, pinned to the current version', async () => {
    const r = await call(routes.status, req('GET', '/s'), root);
    const d = r.json.disclosure as { version: number; lines: Record<string, string[]> };
    expect(d.version).toBe(CLOUD_DISCLOSURE_VERSION);
    expect(d.lines['cloud-index'].join('\n')).toContain('Voyage AI');
    expect(d.lines.cloud.join('\n')).toContain('first 512 characters');
  });
});

describe('disable', () => {
  it('revokes the consent and audits it as a dashboard event', async () => {
    await setKeyDirect();
    await call(routes.enable, req('POST', '/e', { tier: 'cloud-index', consent: true, disclosureVersion: CLOUD_DISCLOSURE_VERSION }), root);
    expect(readVaultConsent(root, home)).not.toBeNull();
    const r = await call(routes.disable, req('POST', '/d', {}), root);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ tier: 'local', consent: 'none' });
    expect(readVaultConsent(root, home)).toBeNull();
    expect(readRecallCloudConfig(home).openRouterKey).toBe(KEY);
    const events = readFileSync(join(home, '.dreamcontext', 'recall-cloud-audit.log'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as { event: string; surface: string });
    expect(events.filter((e) => e.event === 'revoke').map((e) => e.surface)).toContain('dashboard');
  });
});

describe('the index build', () => {
  const consent = async (): Promise<void> => {
    await setKeyDirect();
    await call(routes.enable, req('POST', '/e', { tier: 'cloud-index', consent: true, disclosureVersion: CLOUD_DISCLOSURE_VERSION }), root);
  };

  it('refuses without a consent and a key', async () => {
    const r = await call(routes.startIndex, req('POST', '/i', {}), root);
    expect(r.status).toBe(409);
    expect(build).not.toHaveBeenCalled();
  });

  it('is single flight per vault and reports progress, then ready', async () => {
    await consent();
    let finish!: (v: Awaited<ReturnType<typeof buildCloudIndex>>) => void;
    build.mockImplementation((_root: string, _p: string, _c: unknown, o: { onProgress?: (d: number, t: number, s: number) => void }) =>
      new Promise((resolve) => { o.onProgress?.(5, 20, 0.001); finish = resolve; }));

    const first = await call(routes.startIndex, req('POST', '/i', {}), root);
    const second = await call(routes.startIndex, req('POST', '/i', {}), root);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(build).toHaveBeenCalledTimes(1);
    expect(build.mock.calls[0][3]).toMatchObject({ trigger: 'explicit', home });

    const mid = await call(routes.indexStatus, req('GET', '/is'), root);
    expect(mid.json).toMatchObject({ state: 'building', done: 5, total: 20, progress: 25 });

    finish({ embedded: 20, reused: 0, evicted: 0, spentUsd: 0.002, aborted: null });
    await vi.waitFor(async () => {
      const s = await call(routes.indexStatus, req('GET', '/is'), root);
      expect(s.json.state).toBe('ready');
    });
    // A finished build can be started again.
    await call(routes.startIndex, req('POST', '/i', {}), root);
    expect(build).toHaveBeenCalledTimes(2);
  });

  it('turns an aborted or failed build into a machine code, never a message', async () => {
    await consent();
    build.mockResolvedValueOnce({ embedded: 0, reused: 0, evicted: 0, spentUsd: 0, aborted: 'max_usd' });
    await call(routes.startIndex, req('POST', '/i', {}), root);
    await vi.waitFor(async () => expect((await call(routes.indexStatus, req('GET', '/is'), root)).json).toMatchObject({ state: 'error', error: 'max_usd' }));

    build.mockRejectedValueOnce(new Error(`boom ${KEY}`));
    await call(routes.startIndex, req('POST', '/i', {}), root);
    const failed = await vi.waitFor(async () => {
      const s = await call(routes.indexStatus, req('GET', '/is'), root);
      expect(s.json).toMatchObject({ state: 'error', error: 'unexpected' });
      return s;
    });
    expect(failed.text).not.toContain(KEY);
  });
});
