import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleFederationInboxGet,
  handleFederationSyncPost,
} from '../../src/server/routes/federation.js';
import { addVault } from '../../src/lib/vaults.js';
import { writeSetupConfig, type SetupConfig } from '../../src/lib/setup-config.js';
import { addConnection, listConnections } from '../../src/lib/connections.js';
import {
  consumeEntry,
  inboxDir,
  writeInboxEntry,
  type DigestEntry,
} from '../../src/lib/federation-inbox.js';

const BASE: SetupConfig = {
  platforms: [],
  packs: [],
  multiProduct: false,
  setupVersion: '0.7.0',
  disableNativeMemory: true,
};

function makeDir(prefix: string): string {
  const dir = join(tmpdir(), `dc-${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeVault(base: string, name: string, home: string): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'knowledge'), { recursive: true });
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  writeSetupConfig(projectRoot, { ...BASE, shareable: true });
  addVault(name, projectRoot, home);
  return projectRoot;
}

function writeKnowledge(projectRoot: string, slug: string, body: string): void {
  writeFileSync(
    join(projectRoot, '_dream_context', 'knowledge', `${slug}.md`),
    `---\nname: ${slug}\ntype: knowledge\ntags:\n  - caching\n---\n\n${body}\n`,
    'utf-8',
  );
}

function makeRes(): { res: ServerResponse; status: () => number; body: () => any } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) {
      try { responseBody = JSON.parse(data); } catch { responseBody = data; }
    },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as any };
}

function makeReq(method: string, bodyObj?: unknown): IncomingMessage {
  const chunks = bodyObj === undefined ? [] : [Buffer.from(JSON.stringify(bodyObj))];
  const readable = Readable.from(chunks);
  return Object.assign(readable, {
    method,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

function makeEntry(vault: string, entryId: string): DigestEntry {
  return {
    version: 1,
    id: `${vault}:${entryId}`,
    origin: { vault, entryId, sourceTimestamp: '2026-06-10' },
    kind: 'knowledge',
    title: `Entry ${entryId}`,
    summary: `summary ${entryId}`,
    recallScore: 1,
    links: [],
  };
}

describe('federation routes', () => {
  let home: string;
  let base: string;
  let originalHome: string | undefined;
  let senderProjectRoot: string;
  let senderCtx: string;

  beforeEach(() => {
    home = makeDir('fedroute-home');
    base = makeDir('fedroute-base');
    originalHome = process.env.HOME;
    process.env.HOME = home;
    vi.restoreAllMocks();
    senderProjectRoot = makeVault(base, 'sender', home);
    senderCtx = join(senderProjectRoot, '_dream_context');
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
  });

  it('GET /api/federation/inbox lists pending + consumed entries', async () => {
    // One pending, one consumed.
    writeInboxEntry(senderCtx, makeEntry('alpha', 'pending1'));
    writeInboxEntry(senderCtx, makeEntry('beta', 'consumed1'));
    const { inboxFilename } = await import('../../src/lib/federation-inbox.js');
    consumeEntry(senderCtx, inboxFilename('beta', 'consumed1'));

    const { res, status, body } = makeRes();
    await handleFederationInboxGet(makeReq('GET'), res, {}, senderCtx);

    expect(status()).toBe(200);
    expect(body().pending).toHaveLength(1);
    expect(body().pending[0].origin.vault).toBe('alpha');
    expect(body().consumed).toHaveLength(1);
    expect(body().consumed[0].origin.vault).toBe('beta');
  });

  it('POST /api/federation/sync returns computed deltas and writes NOTHING', async () => {
    // A consenting peer with sender-relevant content.
    const peerProjectRoot = makeVault(base, 'peer', home);
    const peerCtx = join(peerProjectRoot, '_dream_context');
    writeKnowledge(senderProjectRoot, 'caching-strategy', 'caching strategy notes for the gateway');
    // Peer declares interest via a tag so the digest has terms to match.
    writeKnowledge(peerProjectRoot, 'peer-doc', 'caching gateway interests of the peer');

    addConnection(senderCtx, 'sender', 'peer', 'out', ['caching', 'gateway'], home);
    addConnection(peerCtx, 'peer', 'sender', 'in', null, home);

    // Snapshot the peer inbox + watermark BEFORE the dry-run.
    const peerInboxBefore = existsSync(inboxDir(peerCtx))
      ? readdirSync(inboxDir(peerCtx))
      : [];
    const watermarkBefore = listConnections(senderCtx).find((c) => c.vault === 'peer')?.last_synced_at ?? null;

    const { res, status, body } = makeRes();
    await handleFederationSyncPost(makeReq('POST', {}), res, {}, senderCtx);

    expect(status()).toBe(200);
    expect(body().dryRun).toBe(true);
    expect(Array.isArray(body().deltas)).toBe(true);
    const peerDelta = body().deltas.find((d: any) => d.vault === 'peer');
    expect(peerDelta).toBeTruthy();
    expect(peerDelta.consented).toBe(true);
    // The dry-run actually computed a non-empty delta (real preview, not a stub).
    expect(peerDelta.entries.length).toBeGreaterThanOrEqual(1);

    // The dry-run wrote NOTHING: peer inbox unchanged, watermark unchanged.
    const peerInboxAfter = existsSync(inboxDir(peerCtx))
      ? readdirSync(inboxDir(peerCtx))
      : [];
    expect(peerInboxAfter).toEqual(peerInboxBefore);
    const watermarkAfter = listConnections(senderCtx).find((c) => c.vault === 'peer')?.last_synced_at ?? null;
    expect(watermarkAfter).toBe(watermarkBefore);
  });
});
