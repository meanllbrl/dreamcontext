import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CLOUD_DEVICE_API_ROUTES,
  CLOUD_PUBLIC_ROUTES,
  classifyCloudRoute,
  isCloud,
  runWith,
  setCloudPhaseSource,
  spawnAsWorker,
  workerSpawnPlan,
  type CloudPhase,
} from '../../src/server/cloud-mode.js';
import {
  DEVICE_COOKIE,
  HandsfreeAuth,
  TRANSFER_NONCE_HEADER,
  hashPassphrase,
  setHandsfreeAuthForTests,
  sha256Hex,
  transferAuthorization,
  transferKeyFromSecret,
} from '../../src/server/handsfree-auth.js';
import { cloudGate, cloudUpgradeRefusal, handleCors, isCrossSiteWrite } from '../../src/server/middleware.js';
import { isAgentHost, isAgentRequest } from '../../src/server/desktop.js';

const ENV_KEYS = ['DREAMCONTEXT_CLOUD', 'DREAMCONTEXT_DESKTOP', 'DC_HF_ORIGIN', 'GITHUB_TOKEN', 'DC_HF_TRANSFER_SECRET'];
const saved: Record<string, string | undefined> = {};
let dir: string;
let auth: HandsfreeAuth;
let deviceId: string;
let phase: CloudPhase;
const OWN = 'https://dc-hf-test-8080.app.github.dev';
const key = transferKeyFromSecret('transfer-secret');

beforeEach(async () => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  process.env.DREAMCONTEXT_CLOUD = '1';
  delete process.env.DREAMCONTEXT_DESKTOP;
  process.env.DC_HF_ORIGIN = OWN;
  dir = mkdtempSync(join(tmpdir(), 'hf-gate-'));
  auth = new HandsfreeAuth({ dir });
  auth.store.installVerifiers({ generation: 1, passphrase: await hashPassphrase('a b c d e f'), transferSha256: sha256Hex('transfer-secret') });
  deviceId = auth.store.createDevice();
  setHandsfreeAuthForTests(auth);
  phase = 'active';
  setCloudPhaseSource(() => phase);
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  setHandsfreeAuthForTests(null);
  setCloudPhaseSource(() => 'sealed');
  rmSync(dir, { recursive: true, force: true });
});

interface Res { res: ServerResponse; status: () => number | null; headers: Record<string, string>; body: () => string }

function mockRes(): Res {
  let status: number | null = null;
  let body = '';
  const headers: Record<string, string> = {};
  const res = {
    setHeader(n: string, v: string) { headers[n.toLowerCase()] = String(v); },
    writeHead(code: number, h?: Record<string, string | number>) {
      status = code;
      for (const [k, v] of Object.entries(h ?? {})) headers[k.toLowerCase()] = String(v);
      return res;
    },
    end(b?: string) { body = b ?? ''; },
  } as unknown as ServerResponse;
  return { res, status: () => status, headers, body: () => body };
}

/** Every forwarded request looks like this to the server (W0): loopback, Host localhost:8080. */
function req(method: string, url: string, h: Record<string, string> = {}): IncomingMessage {
  return {
    method,
    url,
    headers: { host: 'localhost:8080', 'x-forwarded-host': 'dc-hf-test-8080.app.github.dev', ...h },
    socket: { remoteAddress: '127.0.0.1' },
  } as unknown as IncomingMessage;
}

const cookie = () => ({ cookie: `${DEVICE_COOKIE}=${deviceId}` });

function gate(r: IncomingMessage): Res & { passed: boolean } {
  const m = mockRes();
  const passed = cloudGate(r, m.res);
  return { ...m, passed };
}

describe('cloud flag', () => {
  it('is its own flag, never the desktop one', () => {
    expect(isCloud()).toBe(true);
    delete process.env.DREAMCONTEXT_CLOUD;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    expect(isCloud()).toBe(false);
  });
});

describe('spawnAsWorker', () => {
  it('execs through setpriv as dcuser:dcwork with every capability set cleared', () => {
    const plan = workerSpawnPlan('claude', ['-p', 'hi'], { cwd: '/Users/x/proj' });
    expect(plan.file).toBe('/usr/bin/setpriv');
    expect(plan.argv).toEqual([
      '--reuid=dcuser', '--regid=dcwork', '--clear-groups', '--inh-caps=-all', '--ambient-caps=-all', '--no-new-privs',
      '--', 'claude', '-p', 'hi',
    ]);
    expect(plan.cwd).toBe('/Users/x/proj');
  });

  it('passes only the allow-listed env, plus the chosen account dir', () => {
    process.env.GITHUB_TOKEN = 'ghs_should_never_leak';
    process.env.DC_HF_TRANSFER_SECRET = 'nope';
    const plan = workerSpawnPlan('claude', [], { cwd: '/', account: { configDir: '/Users/x/.dreamcontext/claude-accounts/a' }, env: { DREAMCONTEXT_SESSION: 's1' } });
    expect(Object.keys(plan.env).sort()).toEqual(['CLAUDE_CONFIG_DIR', 'DREAMCONTEXT_SESSION', 'HOME', 'LANG', 'LOGNAME', 'PATH', 'SHELL', 'TERM', 'USER']);
    expect(plan.env.USER).toBe('dcuser');
    expect(plan.env.SHELL).toBe('/bin/bash');
    expect(plan.env.CLAUDE_CONFIG_DIR).toBe('/Users/x/.dreamcontext/claude-accounts/a');
    expect(JSON.stringify(plan)).not.toContain('ghs_should_never_leak');
  });

  it('refuses secrets, another account dir and git config injection from the caller', () => {
    for (const k of ['DC_HF_ANYTHING', 'GITHUB_TOKEN', 'GH_TOKEN', 'CLAUDE_CONFIG_DIR', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_GLOBAL', 'CODESPACE_NAME', 'LD_PRELOAD']) {
      expect(() => workerSpawnPlan('git', [], { cwd: '/', env: { [k]: 'x' } }), k).toThrow(/may not be passed/);
    }
    expect(() => workerSpawnPlan('ls', [], { cwd: 'relative' })).toThrow(/absolute/);
  });

  it('runs git with no system config, the public global config, no hooks and no fsmonitor', () => {
    const plan = workerSpawnPlan('git', ['status', '--porcelain=v2'], { cwd: '/', env: { GIT_INDEX_FILE: '/tmp/i' } });
    expect(plan.argv.slice(7)).toEqual(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v2']);
    expect(plan.env.GIT_CONFIG_NOSYSTEM).toBe('1');
    expect(plan.env.GIT_CONFIG_GLOBAL).toBe('/workspaces/dc-server-pub/gitconfig');
    expect(plan.env.GIT_INDEX_FILE).toBe('/tmp/i');
  });

  it('is cloud-only', () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    expect(() => spawnAsWorker('true', [], { cwd: '/' })).toThrow(/cloud-only/);
  });
});

describe('runner contract', () => {
  const run = runWith((cmd, args, cwd, env) => spawn(cmd, args, { cwd, env: { ...process.env, ...env }, detached: true }));

  it('pipes input, buffers output and reports the exit code', async () => {
    const r = await run('sh', ['-c', 'cat; echo err >&2; exit 3'], { cwd: '/', input: Buffer.from('hello') });
    expect(r.code).toBe(3);
    expect(r.stdout.toString()).toBe('hello');
    expect(r.stderr.toString()).toBe('err\n');
  });

  it('streams stdout to stdoutTo without ending it', async () => {
    const sink = new PassThrough();
    const chunks: Buffer[] = [];
    sink.on('data', (c: Buffer) => chunks.push(c));
    const r = await run('sh', ['-c', 'printf abc'], { cwd: '/', stdoutTo: sink });
    expect(r.stdout.length).toBe(0);
    expect(Buffer.concat(chunks).toString()).toBe('abc');
    expect(sink.writableEnded).toBe(false);
  });

  it('kills the process group on timeout', async () => {
    const r = await run('sh', ['-c', 'sleep 5'], { cwd: '/', timeoutMs: 100 });
    expect(r.signal).toBe('SIGKILL');
  });
});

describe('cloud API allow-list (static)', () => {
  it('is pinned', () => {
    expect([...CLOUD_DEVICE_API_ROUTES].sort()).toEqual([
      'GET /api/agent/accounts',
      'GET /api/agent/bg-output',
      'GET /api/agent/board-assets',
      'GET /api/agent/capabilities',
      'GET /api/agent/chat-history',
      'GET /api/agent/chat-sessions',
      'GET /api/agent/file',
      'GET /api/agent/model-config',
      'GET /api/agent/session-facts',
      'GET /api/agent/session-model',
      'GET /api/agent/session-stats',
      'GET /api/agent/sessions',
      'GET /api/agent/slash-commands',
      'GET /api/agent/task-progress',
      'GET /api/agent/teammate-history',
      'GET /api/agent/teammates',
      'GET /api/agent/usage-limits',
      'GET /api/chat/html-kit',
      'GET /api/config',
      'GET /api/vaults',
      'POST /api/agent/accounts/auto-switch',
      'POST /api/agent/accounts/preferred',
      'POST /api/agent/prompt',
      'POST /api/handsfree/logout',
      'PUT /api/agent/sessions',
    ]);
    expect([...CLOUD_PUBLIC_ROUTES].sort()).toEqual([
      'GET /api/health',
      'GET /handsfree-offline.html',
      'GET /handsfree-sw.js',
      'GET /login',
      'GET /manifest.webmanifest',
      'POST /api/handsfree/login',
    ]);
  });

  it('names only routes the server really registers (drift test)', () => {
    const src = readFileSync(join(__dirname, '../../src/server/index.ts'), 'utf-8');
    for (const entry of CLOUD_DEVICE_API_ROUTES) {
      const [method, path] = entry.split(' ');
      if (path.startsWith('/api/handsfree/')) continue; // wave 2 registers the handsfree routes
      expect(src, entry).toContain(`router.${method.toLowerCase()}('${path}',`);
    }
  });

  it('classifies everything else under /api as unavailable', () => {
    expect(classifyCloudRoute('POST', '/api/lab/sync')).toBe('unavailable');
    expect(classifyCloudRoute('PUT', '/api/whiteboards/nav')).toBe('unavailable');
    expect(classifyCloudRoute('GET', '/api/tasks')).toBe('unavailable');
    expect(classifyCloudRoute('POST', '/api/agent/accounts/login')).toBe('unavailable');
    expect(classifyCloudRoute('GET', '/api/agent/mcp')).toBe('unavailable');
    expect(classifyCloudRoute('PATCH', '/api/config')).toBe('unavailable');
    expect(classifyCloudRoute('GET', '/api')).toBe('unavailable');
    expect(classifyCloudRoute('HEAD', '/api/health')).toBe('public');
    expect(classifyCloudRoute('POST', '/api/handsfree/login')).toBe('public');
    expect(classifyCloudRoute('GET', '/api/handsfree/login')).toBe('transfer');
    expect(classifyCloudRoute('POST', '/api/handsfree/trip')).toBe('transfer');
    expect(classifyCloudRoute('GET', '/')).toBe('device');
    expect(classifyCloudRoute('GET', '/assets/index.js')).toBe('device');
  });
});

describe('cloudGate', () => {
  it('marks every response, including refusals, with X-Dreamcontext-Cloud', () => {
    for (const r of [req('GET', '/api/tasks'), req('GET', '/api/health'), req('GET', '/api/agent/chat-history')]) {
      expect(gate(r).headers['x-dreamcontext-cloud']).toBe('1');
    }
  });

  it('never trusts loopback: an unauthenticated forwarded request is refused', () => {
    const g = gate(req('GET', '/api/agent/chat-history'));
    expect(g.passed).toBe(false);
    expect(g.status()).toBe(401);
  });

  it('sends a signed-out navigation to /login', () => {
    const g = gate(req('GET', '/', { accept: 'text/html,application/xhtml+xml' }));
    expect(g.status()).toBe(302);
    expect(g.headers.location).toBe('/login');
  });

  it('lets the public routes through with no credential', () => {
    expect(gate(req('GET', '/login')).passed).toBe(true);
    expect(gate(req('GET', '/handsfree-sw.js')).passed).toBe(true);
    expect(gate(req('GET', '/handsfree-offline.html', { 'x-tunnel-skip-antiphishing-page': 'true', accept: 'text/html' })).passed).toBe(true);
    expect(gate(req('POST', '/api/handsfree/login', { origin: 'http://localhost:8080' })).passed).toBe(true);
    const h = gate(req('GET', '/api/health'));
    expect(h.passed).toBe(true);
    expect(h.headers[TRANSFER_NONCE_HEADER.toLowerCase()]).toMatch(/^[a-z0-9]+\.[\w-]+\.[\w-]+$/);
  });

  it('serves a device its allow-listed API and UI', () => {
    expect(gate(req('GET', '/api/agent/chat-history?session=x', cookie())).passed).toBe(true);
    expect(gate(req('GET', '/', { ...cookie(), accept: 'text/html' })).passed).toBe(true);
  });

  it('refuses every other /api route with cloud_unavailable, even for a device', () => {
    for (const [m, p] of [['POST', '/api/lab/sync'], ['PUT', '/api/whiteboards/nav'], ['GET', '/api/agent/mcp'], ['POST', '/api/agent/reveal']]) {
      const g = gate(req(m, p, { ...cookie(), origin: 'http://localhost:8080' }));
      expect(g.status(), `${m} ${p}`).toBe(403);
      expect(JSON.parse(g.body()).error).toBe('cloud_unavailable');
    }
  });

  it('pins the Origin of writes: the forwarder rewrite and DC_HF_ORIGIN pass, nothing else', () => {
    const put = (origin?: string) => gate(req('PUT', '/api/agent/sessions', { ...cookie(), ...(origin ? { origin } : {}) }));
    expect(put('http://localhost:8080').passed).toBe(true);
    expect(put(OWN).passed).toBe(true);
    expect(put().status()).toBe(403);
    expect(put('https://evil.example').status()).toBe(403);
    expect(put('http://localhost:4173').status()).toBe(403);
    expect(put('http://127.0.0.1:8080').status()).toBe(403);
  });

  it('answers a preflight with no CORS grant', () => {
    const g = gate(req('OPTIONS', '/api/agent/sessions', { origin: 'https://evil.example' }));
    expect(g.passed).toBe(false);
    expect(g.status()).toBe(204);
    expect(g.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('honours the phase: sealed refuses the phone, quiescing refuses its writes', () => {
    phase = 'sealed';
    expect(gate(req('GET', '/api/agent/chat-history', cookie())).status()).toBe(503);
    expect(gate(req('GET', '/login')).passed).toBe(true);
    phase = 'quiescing';
    expect(gate(req('GET', '/api/agent/chat-history', cookie())).passed).toBe(true);
    expect(gate(req('PUT', '/api/agent/sessions', { ...cookie(), origin: OWN })).status()).toBe(423);
  });

  it('fails closed until the phase source is wired', () => {
    setCloudPhaseSource(() => { throw new Error('unwired'); });
    expect(gate(req('GET', '/api/agent/chat-history', cookie())).status()).toBe(503);
  });

  describe('transfer routes', () => {
    const proof = (method: string, target: string) => ({ authorization: transferAuthorization(key, auth.issueNonce(), method, target) });

    it('accept a valid HMAC proof', () => {
      expect(gate(req('POST', '/api/handsfree/trip', { origin: OWN, ...proof('POST', '/api/handsfree/trip') })).passed).toBe(true);
    });

    it('refuse a device cookie, with or without a proof', () => {
      expect(gate(req('POST', '/api/handsfree/trip', { origin: OWN, ...cookie() })).status()).toBe(403);
      expect(gate(req('POST', '/api/handsfree/trip', { origin: OWN, ...cookie(), ...proof('POST', '/api/handsfree/trip') })).status()).toBe(403);
    });

    it('refuse no proof, a replayed proof and a raw bearer', () => {
      expect(gate(req('GET', '/api/handsfree/status')).status()).toBe(401);
      const p = proof('GET', '/api/handsfree/status');
      expect(gate(req('GET', '/api/handsfree/status', p)).passed).toBe(true);
      expect(gate(req('GET', '/api/handsfree/status', p)).status()).toBe(401);
      expect(gate(req('GET', '/api/handsfree/status', { authorization: 'Bearer transfer-secret' })).status()).toBe(401);
    });

    it('a transfer proof cannot call a device route', () => {
      const g = gate(req('GET', '/api/agent/chat-history', { ...cookie(), ...proof('GET', '/api/agent/chat-history') }));
      expect(g.status()).toBe(403);
    });
  });
});

describe('cloudUpgradeRefusal', () => {
  const ws = (h: Record<string, string>, path = '/api/agent/chat?resume=x') => req('GET', path, { upgrade: 'websocket', ...h });

  it('admits only the chat socket, with a device session, our Origin and phase active', () => {
    expect(cloudUpgradeRefusal(ws({ ...cookie(), origin: 'http://localhost:8080' }))).toBeNull();
    expect(cloudUpgradeRefusal(ws({ ...cookie(), origin: OWN }))).toBeNull();
    expect(cloudUpgradeRefusal(ws({ origin: 'http://localhost:8080' }))).toBe(401);
    expect(cloudUpgradeRefusal(ws({ ...cookie() }))).toBe(403);
    expect(cloudUpgradeRefusal(ws({ ...cookie(), origin: 'https://evil.example' }))).toBe(403);
    expect(cloudUpgradeRefusal(ws({ ...cookie(), origin: OWN }, '/api/agent/terminal'))).toBe(403);
    phase = 'quiescing';
    expect(cloudUpgradeRefusal(ws({ ...cookie(), origin: OWN }))).toBe(403);
  });
});

describe('agent gates', () => {
  it('cloud: a device session, never loopback alone', () => {
    expect(isAgentHost()).toBe(true);
    expect(isAgentRequest(req('GET', '/'))).toBe(false);
    expect(isAgentRequest(req('GET', '/', cookie()))).toBe(true);
  });

  it('desktop: loopback, exactly as before', () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    process.env.DREAMCONTEXT_DESKTOP = '1';
    expect(isAgentHost()).toBe(true);
    expect(isAgentRequest(req('GET', '/'))).toBe(true);
    const lan = { ...req('GET', '/'), socket: { remoteAddress: '192.168.1.5' } } as unknown as IncomingMessage;
    expect(isAgentRequest(lan)).toBe(false);
  });

  it('neither: no agent host', () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    expect(isAgentHost()).toBe(false);
    expect(isAgentRequest(req('GET', '/', cookie()))).toBe(false);
  });
});

describe('off cloud mode the laptop chain is unchanged', () => {
  it('still reflects loopback CORS and allows loopback-origin writes', () => {
    delete process.env.DREAMCONTEXT_CLOUD;
    const m = mockRes();
    expect(handleCors(req('GET', '/api/tasks', { origin: 'http://localhost:4173' }), m.res)).toBe(false);
    expect(m.headers['access-control-allow-origin']).toBe('http://localhost:4173');
    expect(isCrossSiteWrite(req('POST', '/api/tasks', { origin: 'http://localhost:4173' }))).toBe(false);
    expect(isCrossSiteWrite(req('POST', '/api/tasks', { origin: 'https://evil.example' }))).toBe(true);
    expect(isCrossSiteWrite(req('POST', '/api/tasks'))).toBe(false);
  });
});
