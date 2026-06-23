import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleTasksSetToken, handleTasksTokenStatus } from '../../src/server/routes/tasks.js';
import { writeSetupConfig } from '../../src/lib/setup-config.js';
import type { SetupConfig } from '../../src/lib/setup-config.js';

/**
 * POST /api/tasks/token + GET /api/tasks/token-status — the dashboard's inline
 * API-key surface. Provider-agnostic: the route resolves the ACTIVE backend from
 * the saved config and delegates the token I/O to it. The token must land in the
 * gitignored secrets file (never in the response body or `.config.json`), and the
 * status route must report whether a key is set + where it comes from, masked.
 */

function makeRes(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
  let statusCode = 0;
  let responseBody: unknown = null;
  const res = {
    writeHead(code: number) { statusCode = code; },
    end(data: string) { try { responseBody = JSON.parse(data); } catch { responseBody = data; } },
    setHeader() {},
  } as unknown as ServerResponse;
  return { res, status: () => statusCode, body: () => responseBody as Record<string, unknown> };
}

function makePostReq(bodyObj: unknown): IncomingMessage {
  const readable = Readable.from([Buffer.from(JSON.stringify(bodyObj))]);
  return Object.assign(readable, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  }) as unknown as IncomingMessage;
}

const getReq = { method: 'GET', headers: {} } as unknown as IncomingMessage;

let tmpDir: string;
let contextRoot: string;
const SECRETS_REL = join('_dream_context', 'state', '.secrets.json');

function configFor(taskBackend: 'local' | 'clickup' | 'github'): SetupConfig {
  return {
    platforms: [],
    packs: [],
    multiProduct: false,
    setupVersion: '0.0.0',
    disableNativeMemory: true,
    taskBackend,
    cloudTaskManagement: taskBackend !== 'local',
    ...(taskBackend === 'clickup' ? { clickup: { teamId: 't', spaceId: 's', listId: 'l' } } : {}),
    ...(taskBackend === 'github' ? { github: { owner: 'o', repo: 'r' } } : {}),
  } as SetupConfig;
}

beforeEach(() => {
  // Env tokens would shadow the secrets file in resolve order — clear them so the
  // status route reflects what we wrote, not the runner's environment.
  for (const k of ['CLICKUP_TOKEN', 'CLICKUP_API_KEY', 'GITHUB_TOKEN', 'GH_TOKEN']) delete process.env[k];
  tmpDir = join(tmpdir(), `token-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  contextRoot = join(tmpDir, '_dream_context');
  mkdirSync(join(contextRoot, 'state'), { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/tasks/token-status', () => {
  it('reports no key when the active (clickup) backend has none configured', async () => {
    writeSetupConfig(tmpDir, configFor('clickup'));
    const { res, status, body } = makeRes();
    await handleTasksTokenStatus(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ backend: 'clickup', set: false, source: null, masked: null });
  });

  it('reports a saved key as set, sourced from secrets, masked (never the raw token)', async () => {
    writeSetupConfig(tmpDir, configFor('clickup'));
    const { res } = makeRes();
    await handleTasksSetToken(makePostReq({ token: 'pk_live_SUPERSECRET1234' }), res, {}, contextRoot);

    const status = makeRes();
    await handleTasksTokenStatus(getReq, status.res, {}, contextRoot);
    expect(status.body()).toMatchObject({ backend: 'clickup', set: true, source: 'secrets', masked: '••••••••1234' });
    expect(String(status.body().masked)).not.toContain('SUPERSECRET');
  });

  it('reports a key coming from an environment variable', async () => {
    writeSetupConfig(tmpDir, configFor('clickup'));
    process.env.CLICKUP_TOKEN = 'pk_env_abcd';
    const { res, body } = makeRes();
    await handleTasksTokenStatus(getReq, res, {}, contextRoot);
    expect(body()).toMatchObject({ backend: 'clickup', set: true, source: 'env' });
  });

  it('reports no remote token on a local-only project', async () => {
    writeSetupConfig(tmpDir, configFor('local'));
    const { res, status, body } = makeRes();
    await handleTasksTokenStatus(getReq, res, {}, contextRoot);
    expect(status()).toBe(200);
    expect(body()).toMatchObject({ backend: 'local', set: false, source: null, masked: null });
  });
});

describe('POST /api/tasks/token', () => {
  it('writes the token to the gitignored secrets file, never to the response or config', async () => {
    writeSetupConfig(tmpDir, configFor('github'));
    const { res, status, body } = makeRes();
    await handleTasksSetToken(makePostReq({ token: 'ghp_realtoken_9999' }), res, {}, contextRoot);

    expect(status()).toBe(200);
    expect(body()).toEqual({ ok: true, backend: 'github' });
    // The raw token never appears in the response payload.
    expect(JSON.stringify(body())).not.toContain('ghp_realtoken_9999');

    // It landed in the secrets file under the github block.
    const secrets = JSON.parse(readFileSync(join(tmpDir, SECRETS_REL), 'utf-8'));
    expect(secrets.github.token).toBe('ghp_realtoken_9999');

    // And the .gitignore covers it (the writer aborts otherwise).
    const gitignore = readFileSync(join(tmpDir, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('_dream_context/state/.secrets.json');
  });

  it('rejects an empty token', async () => {
    writeSetupConfig(tmpDir, configFor('clickup'));
    const { res, status, body } = makeRes();
    await handleTasksSetToken(makePostReq({ token: '   ' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('invalid_token');
  });

  it('refuses to set a token on a local-only project (no remote backend)', async () => {
    writeSetupConfig(tmpDir, configFor('local'));
    const { res, status, body } = makeRes();
    await handleTasksSetToken(makePostReq({ token: 'whatever' }), res, {}, contextRoot);
    expect(status()).toBe(400);
    expect(body().error).toBe('not_supported');
    expect(existsSync(join(tmpDir, SECRETS_REL))).toBe(false);
  });

  it('preserves a previously-saved token for the other provider (no clobber)', async () => {
    writeSetupConfig(tmpDir, configFor('github'));
    writeFileSync(
      join(tmpDir, SECRETS_REL),
      JSON.stringify({ clickup: { token: 'pk_keep_me' } }, null, 2),
      'utf-8',
    );
    const { res } = makeRes();
    await handleTasksSetToken(makePostReq({ token: 'ghp_new' }), res, {}, contextRoot);

    const secrets = JSON.parse(readFileSync(join(tmpDir, SECRETS_REL), 'utf-8'));
    expect(secrets.clickup.token).toBe('pk_keep_me');
    expect(secrets.github.token).toBe('ghp_new');
  });
});
