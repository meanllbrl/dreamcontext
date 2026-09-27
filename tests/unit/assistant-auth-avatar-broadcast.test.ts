/**
 * Three W1 contracts of the dreamcontext Assistant that are small enough to share a file:
 *   • AUTH — `/api/assistant/*` refuses a missing / wrong / stale token and any non-loopback
 *     caller, each with its NAMED error (the words the assistant repeats to the owner).
 *   • AVATAR — ≤ 2 MB, PNG/JPEG/WebP by magic bytes only, SVG refused, a fixed file name, and
 *     no client-supplied name ever reaches the filesystem.
 *   • BROADCAST — one row per vault, replied|failed|timeout|missing, 3 in flight at most, and
 *     each vault's own agent (the headless runner, in that vault's root) does the writing.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const h = fs.mkdtempSync(`${os.tmpdir()}/assistant-aab-home-`);
  process.env.HOME = h;
  return h;
});

const state = await import('../../src/lib/assistant/session-state.js');
const routes = await import('../../src/server/routes/assistant.js');
const avatar = await import('../../src/lib/assistant/avatar.js');
const { broadcast, BROADCAST_CONCURRENCY, buildBroadcastPrompt } = await import('../../src/lib/assistant/broadcast.js');
const { addVault } = await import('../../src/lib/vaults.js');

function makeRes() {
  let status = 0;
  let body: Record<string, unknown> = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data?: string) { try { body = JSON.parse(String(data)); } catch { body = {}; } },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

function mkReq(o: { method?: string; url?: string; token?: string; remote?: string; raw?: Buffer }): IncomingMessage {
  return Object.assign(Readable.from(o.raw ? [o.raw] : []), {
    method: o.method ?? 'GET',
    url: o.url ?? '/api/assistant/projects',
    headers: { host: '127.0.0.1:4173', ...(o.token !== undefined ? { 'x-dreamcontext-assistant-token': o.token } : {}) },
    socket: { remoteAddress: o.remote ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  mkdirSync(join(HOME, '.dreamcontext', 'assistant', '_dream_context'), { recursive: true });
});

// ─── Auth ────────────────────────────────────────────────────────────────────────────

describe('auth — named refusals', () => {
  const run = async (o: Parameters<typeof mkReq>[0]) => {
    const r = makeRes();
    await routes.handleAssistantProjects(mkReq(o), r.res);
    return r;
  };

  it('a missing token → 401 not_assistant, "only the dreamcontext Assistant can drive the app"', async () => {
    const r = await run({});
    expect(r.status()).toBe(401);
    expect(r.body()).toMatchObject({ error: 'not_assistant', message: 'only the dreamcontext Assistant can drive the app' });
  });

  it('a wrong token → 401 bad_token', async () => {
    const wrong = state.assistantToken().slice(0, -4) + 'ffff';
    const r = await run({ token: wrong === state.assistantToken() ? wrong.replace(/.$/, '0') : wrong });
    expect(r.status()).toBe(401);
    expect(r.body().error).toBe('bad_token');
  });

  it('a STALE token (a previous server process) → 401 app_restarted', async () => {
    const stale = `dca_${'0'.repeat(12)}_${'a'.repeat(48)}`;
    const r = await run({ token: stale });
    expect(r.status()).toBe(401);
    expect(r.body()).toMatchObject({ error: 'app_restarted', message: 'the app restarted — this turn cannot drive it' });
  });

  it('a NON-LOOPBACK caller is refused even with the right token → 403', async () => {
    const r = await run({ token: state.assistantToken(), remote: '100.64.1.2' });
    expect(r.status()).toBe(403);
    expect(r.body().error).toBe('assistant_local_only');
  });

  it('outside the desktop app → 403', async () => {
    process.env.DREAMCONTEXT_DESKTOP = '0';
    try {
      const r = await run({ token: state.assistantToken() });
      expect(r.status()).toBe(403);
    } finally { process.env.DREAMCONTEXT_DESKTOP = '1'; }
  });

  it('the right token from loopback → 200', async () => {
    const r = await run({ token: state.assistantToken() });
    expect(r.status()).toBe(200);
  });

  it('every token-gated route refuses without the token', async () => {
    const handlers: Array<(q: IncomingMessage, s: ServerResponse) => Promise<void>> = [
      routes.handleAssistantProjects, routes.handleAssistantSessions, routes.handleAssistantWatch,
      routes.handleAssistantBroadcast, (q, s) => routes.handleAssistantUi(q, s, { verb: 'open' }),
    ];
    for (const h of handlers) {
      const r = makeRes();
      await h(mkReq({ method: 'POST' }), r.res);
      expect(r.status()).toBe(401);
    }
  });

  it('checkAssistantToken classifies', () => {
    expect(state.checkAssistantToken(undefined)).toBe('missing');
    expect(state.checkAssistantToken('')).toBe('missing');
    expect(state.checkAssistantToken(state.assistantToken())).toBe('ok');
    expect(state.checkAssistantToken('garbage')).toBe('wrong');
  });
});

// ─── Avatar ──────────────────────────────────────────────────────────────────────────

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');

describe('avatar — magic bytes, size, fixed name, no traversal', () => {
  const upload = async (raw: Buffer, url = '/api/assistant/avatar') => {
    const r = makeRes();
    await routes.handleAssistantAvatarSet(mkReq({ method: 'POST', url, raw }), r.res);
    return r;
  };
  const assets = () => join(HOME, '.dreamcontext', 'assistant', 'assets');

  it('sniffs PNG / JPEG / WebP and refuses SVG and everything else', () => {
    expect(avatar.sniffImage(PNG)).toBe('png');
    expect(avatar.sniffImage(JPG)).toBe('jpg');
    expect(avatar.sniffImage(WEBP)).toBe('webp');
    expect(avatar.sniffImage(SVG)).toBeNull();
    expect(avatar.sniffImage(Buffer.from('GIF89a'))).toBeNull();
  });

  it('writes a PNG to the fixed name assets/avatar.png', async () => {
    const r = await upload(PNG);
    expect(r.status()).toBe(200);
    expect(readdirSync(assets())).toEqual(['avatar.png']);
  });

  it('a format change replaces the old file — never two avatars', async () => {
    await upload(PNG);
    await upload(WEBP);
    expect(readdirSync(assets())).toEqual(['avatar.webp']);
  });

  it('refuses SVG (400 bad_type), even named .png', async () => {
    const r = await upload(SVG, '/api/assistant/avatar?name=avatar.png');
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('bad_type');
  });

  it('refuses over 2 MB (413)', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(avatar.AVATAR_MAX_BYTES)]);
    const r = await upload(big);
    expect(r.status()).toBe(413);
  });

  it('a traversal attempt in the URL is ignored — the name never comes from the client', async () => {
    rmSync(assets(), { recursive: true, force: true });
    const r = await upload(JPG, '/api/assistant/avatar?name=../../../evil.png&filename=..%2F..%2Fx.png');
    expect(r.status()).toBe(200);
    expect(readdirSync(assets())).toEqual(['avatar.jpg']);
    expect(existsSync(join(HOME, '.dreamcontext', 'evil.png'))).toBe(false);
    expect(existsSync(join(HOME, 'evil.png'))).toBe(false);
  });

  it('avatarPath refuses any extension outside the whitelist, including traversal', () => {
    expect(() => avatar.avatarPath('../../x', HOME)).toThrow();
    expect(() => avatar.avatarPath('svg', HOME)).toThrow();
    expect(() => avatar.avatarPath('png/../../x', HOME)).toThrow();
    expect(avatar.avatarPath('png', HOME)).toBe(join(HOME, '.dreamcontext', 'assistant', 'assets', 'avatar.png'));
  });

  it('owner routes refuse a non-loopback caller', async () => {
    const r = makeRes();
    await routes.handleAssistantAvatarSet(mkReq({ method: 'POST', remote: '100.64.1.2', raw: PNG }), r.res);
    expect(r.status()).toBe(403);
  });
});

// ─── Broadcast ───────────────────────────────────────────────────────────────────────

describe('broadcast — one row per vault, 3 in parallel, each vault\'s own agent writes', () => {
  beforeAll(() => {
    for (const n of ['a1', 'a2', 'a3', 'a4', 'a5', 'gone']) {
      const root = join(HOME, 'bp', n);
      mkdirSync(join(root, '_dream_context'), { recursive: true });
      addVault(n, root, HOME);
    }
    rmSync(join(HOME, 'bp', 'gone'), { recursive: true, force: true });
  });

  it('replied | failed | timeout | missing, in vault order', async () => {
    const cwds: string[] = [];
    const rows = await broadcast('Use pnpm.', {
      home: HOME,
      runner: async (peer, prompt) => {
        cwds.push(peer.projectRoot);
        expect(prompt).toContain('Use pnpm.');
        if (peer.name === 'a2') return { ok: false, reply: '', sessionId: null, error: 'the peer run exited 1' };
        if (peer.name === 'a3') return { ok: false, reply: '', sessionId: null, error: 'timed out after 300s' };
        return { ok: true, reply: `wrote it in ${peer.name}`, sessionId: null };
      },
    });
    expect(rows.map((r) => [r.vault, r.status])).toEqual([
      ['a1', 'replied'], ['a2', 'failed'], ['a3', 'timeout'], ['a4', 'replied'], ['a5', 'replied'], ['gone', 'missing'],
    ]);
    // Each run happens IN that vault's own project root — its own agent does the writing.
    expect(cwds.sort()).toEqual(['a1', 'a2', 'a3', 'a4', 'a5'].map((n) => join(HOME, 'bp', n)));
  });

  it('never more than 3 in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await broadcast('x', {
      home: HOME,
      runner: async () => {
        inFlight++; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 15));
        inFlight--;
        return { ok: true, reply: 'ok', sessionId: null };
      },
    });
    expect(BROADCAST_CONCURRENCY).toBe(3);
    expect(peak).toBe(3);
  });

  it('--to limits the targets; an unknown name is missing', async () => {
    const rows = await broadcast('x', { home: HOME, to: ['a1', 'nope'], runner: async () => ({ ok: true, reply: 'ok', sessionId: null }) });
    expect(rows.map((r) => [r.vault, r.status])).toEqual([['a1', 'replied'], ['nope', 'missing']]);
  });

  it('the prompt frames the message as the owner\'s, relayed verbatim', () => {
    const p = buildBroadcastPrompt('Always use pnpm.');
    expect(p).toContain('<<<OWNER-MESSAGE\nAlways use pnpm.\nOWNER-MESSAGE');
    expect(p).toMatch(/write it where it belongs/);
  });
});
