import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleLauncherStatus,
  handleLauncherUnregister,
  handleLauncherUpdate,
  handleLauncherFederationGraph,
  handleLauncherConnectionCreate,
  handleLauncherConnectionRemove,
  handleLauncherShareable,
} from '../../src/server/routes/launcher.js';
import {
  handleBrainSettingsGet,
  handleBrainSettingsPut,
} from '../../src/server/routes/ui-settings.js';
import { addVault, listVaults } from '../../src/lib/vaults.js';
import { listConnections } from '../../src/lib/connections.js';
import { updateSetupConfig, readSetupConfig } from '../../src/lib/setup-config.js';
import { dreamcontextVersion } from '../../src/lib/manifest.js';

// ─── Test harness (HOME-override isolates the global vault registry) ────────────

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
  return Object.assign(Readable.from(chunks), {
    method,
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

let tmpHome: string;
let base: string;
let originalHome: string | undefined;

/** Create a registered vault with a setup config, return its project root. */
function makeVault(name: string, opts?: { setupVersion?: string; shareable?: boolean }): string {
  const projectRoot = join(base, name);
  mkdirSync(join(projectRoot, '_dream_context', 'state'), { recursive: true });
  addVault(name, projectRoot);
  updateSetupConfig(projectRoot, {
    setupVersion: opts?.setupVersion ?? dreamcontextVersion(),
    shareable: opts?.shareable ?? false,
  });
  return projectRoot;
}

beforeEach(() => {
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  tmpHome = join(tmpdir(), `dc-lfed-home-${stamp}`);
  base = join(tmpdir(), `dc-lfed-base-${stamp}`);
  mkdirSync(tmpHome, { recursive: true });
  mkdirSync(base, { recursive: true });
  originalHome = process.env.HOME;
  process.env.HOME = tmpHome;
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  rmSync(tmpHome, { recursive: true, force: true });
  rmSync(base, { recursive: true, force: true });
});

// ─── Status (green / yellow / red) ──────────────────────────────────────────────

describe('GET /api/launcher/status', () => {
  it('flags up-to-date, behind, and deleted projects', async () => {
    makeVault('fresh'); // setupVersion === current CLI → not needsUpdate
    makeVault('stale', { setupVersion: '0.0.1' }); // behind → needsUpdate
    const goneRoot = makeVault('gone');
    rmSync(goneRoot, { recursive: true, force: true }); // folder removed → !exists

    const { res, status, body } = makeRes();
    await handleLauncherStatus(makeReq('GET'), res, {}, null);
    expect(status()).toBe(200);

    const byName = Object.fromEntries(body().vaults.map((v: any) => [v.name, v]));
    expect(byName.fresh.exists).toBe(true);
    expect(byName.fresh.needsUpdate).toBe(false);
    expect(byName.stale.exists).toBe(true);
    expect(byName.stale.needsUpdate).toBe(true);
    expect(byName.gone.exists).toBe(false);
    expect(byName.gone.needsUpdate).toBe(false); // a gone folder is never "update-able"
    expect(body().latestVersion).toBe(dreamcontextVersion());
  });
});

// ─── Unregister ─────────────────────────────────────────────────────────────────

describe('POST /api/launcher/unregister', () => {
  it('removes a vault from the registry (folder untouched)', async () => {
    const root = makeVault('keep');
    makeVault('drop');
    const { res, status, body } = makeRes();
    await handleLauncherUnregister(makeReq('POST', { name: 'drop' }), res, {}, null);
    expect(status()).toBe(200);
    expect(body().removed).toBe(true);
    expect(body().vaults.map((v: any) => v.name)).toEqual(['keep']);
    expect(existsSync(root)).toBe(true); // the kept project's folder is intact
  });

  it('400s on a missing name', async () => {
    const { res, status } = makeRes();
    await handleLauncherUnregister(makeReq('POST', {}), res, {}, null);
    expect(status()).toBe(400);
  });
});

// ─── Update (validation paths; the happy path spawns a real CLI child) ──────────

describe('POST /api/launcher/update', () => {
  it('400s on an unknown vault', async () => {
    const { res, status, body } = makeRes();
    await handleLauncherUpdate(makeReq('POST', { name: 'nope' }), res, {}, null);
    expect(status()).toBe(400);
    expect(body().error).toBe('unknown_vault');
  });

  it('400s when the folder is gone', async () => {
    const root = makeVault('vanished');
    rmSync(root, { recursive: true, force: true });
    const { res, status, body } = makeRes();
    await handleLauncherUpdate(makeReq('POST', { name: 'vanished' }), res, {}, null);
    expect(status()).toBe(400);
    expect(body().error).toBe('missing_vault');
  });
});

// ─── Federation graph + connection mutations ────────────────────────────────────

describe('federation graph', () => {
  it('aggregates out/both connections into directed reads-edges', async () => {
    makeVault('a');
    makeVault('b', { shareable: true });
    // a reads b.
    await handleLauncherConnectionCreate(
      makeReq('POST', { from: 'a', to: 'b' }), makeRes().res, {}, null,
    );

    // The connection landed on a's side as an `out` edge.
    const aRoot = join(base, 'a', '_dream_context');
    expect(listConnections(aRoot).map((c) => ({ v: c.vault, d: c.direction })))
      .toEqual([{ v: 'b', d: 'out' }]);

    const { res, status, body } = makeRes();
    await handleLauncherFederationGraph(makeReq('GET'), res, {}, null);
    expect(status()).toBe(200);
    expect(body().nodes.map((n: any) => n.name).sort()).toEqual(['a', 'b']);
    expect(body().edges).toEqual([{ source: 'a', target: 'b', active: true }]);
  });

  it('marks an edge inactive when the target is not shareable', async () => {
    makeVault('a');
    makeVault('b', { shareable: false });
    await handleLauncherConnectionCreate(
      makeReq('POST', { from: 'a', to: 'b' }), makeRes().res, {}, null,
    );
    const { res, body } = makeRes();
    await handleLauncherFederationGraph(makeReq('GET'), res, {}, null);
    expect(body().edges[0].active).toBe(false);
  });

  it('removes a connection', async () => {
    makeVault('a');
    makeVault('b', { shareable: true });
    await handleLauncherConnectionCreate(
      makeReq('POST', { from: 'a', to: 'b' }), makeRes().res, {}, null,
    );
    const { res, status, body } = makeRes();
    await handleLauncherConnectionRemove(makeReq('POST', { from: 'a', to: 'b' }), res, {}, null);
    expect(status()).toBe(200);
    expect(body().removed).toBe(true);
    const aRoot = join(base, 'a', '_dream_context');
    expect(listConnections(aRoot)).toEqual([]);
  });

  it('400s creating a self-connection', async () => {
    makeVault('a');
    const { res, status } = makeRes();
    await handleLauncherConnectionCreate(makeReq('POST', { from: 'a', to: 'a' }), res, {}, null);
    expect(status()).toBe(400);
  });
});

// ─── Shareable toggle ───────────────────────────────────────────────────────────

describe('POST /api/launcher/shareable', () => {
  it('flips the read gate in the project config', async () => {
    const root = makeVault('p', { shareable: false });
    const { res, status, body } = makeRes();
    await handleLauncherShareable(makeReq('POST', { name: 'p', shareable: true }), res, {}, null);
    expect(status()).toBe(200);
    expect(body().shareable).toBe(true);
    expect(readSetupConfig(root)?.shareable).toBe(true);
  });
});

// ─── Brain settings persistence ─────────────────────────────────────────────────

describe('brain settings', () => {
  it('returns {} for a fresh project and round-trips a PUT', async () => {
    const root = makeVault('bs');
    const ctx = join(root, '_dream_context');

    const g1 = makeRes();
    await handleBrainSettingsGet(makeReq('GET'), g1.res, {}, ctx);
    expect(g1.body().settings).toEqual({});

    const blob = { display: { textFadeThreshold: 0.42, nodeSize: 0.8 } };
    const p = makeRes();
    await handleBrainSettingsPut(makeReq('PUT', { settings: blob }), p.res, {}, ctx);
    expect(p.status()).toBe(200);

    const g2 = makeRes();
    await handleBrainSettingsGet(makeReq('GET'), g2.res, {}, ctx);
    expect(g2.body().settings).toEqual(blob);
  });

  it('400s when settings is not an object', async () => {
    const root = makeVault('bs2');
    const ctx = join(root, '_dream_context');
    const { res, status } = makeRes();
    await handleBrainSettingsPut(makeReq('PUT', { settings: [1, 2, 3] }), res, {}, ctx);
    expect(status()).toBe(400);
  });
});
