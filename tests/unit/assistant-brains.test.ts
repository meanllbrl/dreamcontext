/**
 * The Assistant reads every brain itself (owner, 2026-10-17): `assistant recall | index | read`.
 *   • RECALL — grouped per vault (one big vault's weak hits never bury another's only answer),
 *     the vault the query names leads, the hidden vault is its own memory.
 *   • READ — only Markdown (+ the two indexed JSON files) inside a registered brain: no
 *     `.secrets.json`, no `lab/credentials.json`, no `..`, no absolute path elsewhere, no
 *     symlink out, no unregistered path posing as a vault.
 *   • ROUTES — token-gated like every assistant verb, project text fenced, serving it taints;
 *     the Assistant's own memory does not.
 */
import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { Readable } from 'node:stream';
import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const HOME = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const h = fs.realpathSync(fs.mkdtempSync(`${os.tmpdir()}/assistant-brains-home-`));
  process.env.HOME = h;
  return h;
});

const state = await import('../../src/lib/assistant/session-state.js');
const routes = await import('../../src/server/routes/assistant.js');
const brains = await import('../../src/lib/assistant/brains.js');
const { addVault } = await import('../../src/lib/vaults.js');

const ORBIT = join(HOME, 'projects', 'orbit-math');
const NIMBUS = join(HOME, 'projects', 'nimbus');
const OWN = join(HOME, '.dreamcontext', 'assistant', '_dream_context');
const OUTSIDE = join(HOME, 'outside.md');

function write(path: string, body: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, body);
}

function doc(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

beforeAll(() => {
  process.env.DREAMCONTEXT_DESKTOP = '1';
  write(join(OWN, 'knowledge', 'owner-preferences.md'), doc('owner-preferences', 'How the owner likes answers', 'The owner prefers short answers in Turkish.'));
  write(join(OWN, 'core', '0.soul.md'), '# Soul\n\nA calm assistant above every project.\n');
  // orbit-math: a big vault whose many treadmill-free docs would crowd a merged list.
  const topics = ['fractions', 'geometry', 'probability', 'statistics', 'algebra', 'functions', 'sets', 'logic', 'ratios'];
  topics.forEach((t, i) => write(join(ORBIT, '_dream_context', 'knowledge', `lesson-${t}.md`),
    doc(`lesson-${t}`, `Lesson on ${t}`, `How we teach ${t} in week ${i + 1}.${i < 4 ? ' Exponents come up here, with a worksheet.' : ''}`)));
  write(join(ORBIT, '_dream_context', 'knowledge', 'design', 'ui-ux-pattern.md'), doc('ui-ux-pattern', 'The UI/UX pattern every screen follows', 'Cards, spacing and type scale.'));
  write(join(ORBIT, '_dream_context', 'state', '.secrets.json'), '{"key":"sk-live-123"}');
  write(join(ORBIT, '_dream_context', 'lab', 'credentials.json'), '{"token":"abc"}');
  write(join(ORBIT, '_dream_context', 'core', 'CHANGELOG.json'), '[]');
  write(join(ORBIT, '_dream_context', 'knowledge', 'notes.txt'), 'plain text');
  write(OUTSIDE, '# Not a brain file');
  symlinkSync(OUTSIDE, join(ORBIT, '_dream_context', 'knowledge', 'escape.md'));
  // nimbus: the only real answer lives in a session digest (rank-penalised as a capture).
  write(join(NIMBUS, '_dream_context', 'state', '.session-digests', 'abc123.md'),
    '---\ntype: session-digest\nsession_id: abc123\ncreated_at: 2026-10-15T17:05:06.659Z\n---\n# Session Digest\n\n## Decisions\n- The treadmill we picked: Stridewell T3, link https://shop.example/stridewell-t3\n');
  write(join(NIMBUS, '_dream_context', 'knowledge', 'long.md'), doc('long', 'A long file', 'x'.repeat(50_000)));
  write(join(NIMBUS, '_dream_context', 'knowledge', 'roadmap.md'), doc('roadmap', 'What ships next', 'The billing page, then the mobile app.'));
  const line = (o: object) => JSON.stringify(o);
  const session = [
    line({ type: 'user', uuid: 'u1', timestamp: '2026-10-10T10:00:00Z', message: { role: 'user', content: 'find me a treadmill' } }),
    line({ type: 'assistant', uuid: 'a1', timestamp: '2026-10-10T10:00:05Z', message: { role: 'assistant', content: [
      { type: 'text', text: 'First pick: Stridewell T3.' },
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } },
    ] } }),
    line({ type: 'user', uuid: 'u2', timestamp: '2026-10-10T10:00:06Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'API_KEY=sk-live-999' }] } }),
    line({ type: 'user', uuid: 'u3', timestamp: '2026-10-10T10:05:00Z', message: { role: 'user', content: 'something wider, max 10k' } }),
    line({ type: 'assistant', uuid: 'a2', timestamp: '2026-10-10T10:05:09Z', message: { role: 'assistant', content: [{ type: 'text', text: 'Final pick: Glidemax G9, https://shop.example/glidemax-g9' }] } }),
  ].join('\n');
  write(join(HOME, '.claude', 'projects', brains.transcriptDirName(NIMBUS), 'abc123.jsonl'), session);
  write(join(HOME, '.claude', 'projects', brains.transcriptDirName(join(HOME, 'elsewhere')), 'zzz999.jsonl'), session);
  addVault('orbit-math', ORBIT);
  addVault('nimbus', NIMBUS);
});

beforeEach(() => { state.clearTaint(); });

// ─── recallBrains ────────────────────────────────────────────────────────────────────

describe('recallBrains — grouped per vault', () => {
  it('finds the one digest that answers it even when another vault has many more docs', () => {
    const r = brains.recallBrains('treadmill picked');
    const nimbus = r.groups.find((g) => g.vault === 'nimbus');
    expect(nimbus?.hits[0]?.path).toBe('state/.session-digests/abc123.md');
    expect(nimbus?.hits[0]?.file).toBe(join(NIMBUS, '_dream_context', 'state', '.session-digests', 'abc123.md'));
  });

  it('caps each vault at its per-vault share and lists the vaults with nothing', () => {
    const r = brains.recallBrains('exponents worksheet', { perVault: 2 });
    expect(r.groups.find((g) => g.vault === 'orbit-math')?.hits).toHaveLength(2);
    expect(r.noMatch).toEqual(expect.arrayContaining(['nimbus', '__assistant__']));
  });

  it('a vault the query names leads, with twice the room', () => {
    const r = brains.recallBrains('nimbus treadmill exponents', { perVault: 1 });
    expect(r.groups[0]?.vault).toBe('nimbus');
    const orbit = brains.recallBrains('orbit-math exponents worksheet', { perVault: 2 });
    expect(orbit.groups[0]?.vault).toBe('orbit-math');
    expect(orbit.groups[0]?.hits).toHaveLength(4);
  });

  it('searches the Assistant\'s own memory under its reserved name', () => {
    const r = brains.recallBrains('prefers short answers');
    const own = r.groups.find((g) => g.own);
    expect(own?.vault).toBe('__assistant__');
  });

  it('--vault narrows it, and a name nothing matches is reported, not ignored', () => {
    const r = brains.recallBrains('treadmill', { vaults: ['NIMBUS', 'ghost'] });
    expect(r.groups.map((g) => g.vault)).toEqual(['nimbus']);
    expect(r.unknown).toEqual(['ghost']);
  });

  it('queryNamesVault matches the name as a word, not inside another name', () => {
    expect(brains.queryNamesVault("Nimbus'un treadmill linki", 'nimbus')).toBe(true);
    expect(brains.queryNamesVault('nimbus-marketing notes', 'nimbus')).toBe(false);
    expect(brains.queryNamesVault('orbit-math lesson', 'orbit-math')).toBe(true);
  });
});

// ─── indexBrains ─────────────────────────────────────────────────────────────────────

describe('indexBrains', () => {
  it('lists every knowledge file of every vault, with the path read takes', () => {
    const { indexes } = brains.indexBrains();
    const orbit = indexes.find((i) => i.vault === 'orbit-math');
    expect(orbit?.entries.map((e) => e.path)).toContain('knowledge/design/ui-ux-pattern.md');
    expect(orbit?.entries.find((e) => e.path === 'knowledge/design/ui-ux-pattern.md')?.description).toBe('The UI/UX pattern every screen follows');
  });
});

// ─── readBrainFile ───────────────────────────────────────────────────────────────────

describe('readBrainFile — only brain documents, only inside the brain', () => {
  it('reads by relative path, by absolute path, and with a leading _dream_context/', () => {
    const rel = brains.readBrainFile('orbit-math', 'knowledge/design/ui-ux-pattern.md');
    expect(rel.text).toContain('Cards, spacing and type scale.');
    expect(brains.readBrainFile('orbit-math', rel.file).path).toBe('knowledge/design/ui-ux-pattern.md');
    expect(brains.readBrainFile('orbit-math', '_dream_context/knowledge/design/ui-ux-pattern.md').path).toBe('knowledge/design/ui-ux-pattern.md');
    expect(brains.readBrainFile('orbit-math', 'core/CHANGELOG.json').text).toBe('[]');
  });

  const refused: Array<[string, string, string]> = [
    ['state/.secrets.json', 'not_readable', 'a secrets file'],
    ['lab/credentials.json', 'not_readable', 'lab credentials'],
    ['knowledge/notes.txt', 'not_readable', 'a non-Markdown file'],
    ['knowledge', 'not_readable', 'a directory'],
    ['../../nimbus/_dream_context/knowledge/long.md', 'outside_brain', 'a .. escape into another vault'],
    [OUTSIDE, 'outside_brain', 'an absolute path elsewhere'],
    ['knowledge/escape.md', 'outside_brain', 'a symlink pointing out'],
    ['knowledge/missing.md', 'not_found', 'a file that does not exist'],
  ];
  for (const [path, code, what] of refused) {
    it(`refuses ${what} (${code})`, () => {
      try {
        brains.readBrainFile('orbit-math', path);
        expect.unreachable(`read ${path}`);
      } catch (err) {
        expect(err).toBeInstanceOf(brains.BrainReadError);
        expect((err as InstanceType<typeof brains.BrainReadError>).code).toBe(code);
      }
    });
  }

  it('refuses an unregistered vault, and a path posing as a vault name', () => {
    for (const v of ['ghost', ORBIT, join(ORBIT, '_dream_context')]) {
      expect(() => brains.readBrainFile(v, 'knowledge/lesson-sets.md')).toThrow(/not a registered project/);
    }
  });

  it('pages a long file: more + the next offset', () => {
    const first = brains.readBrainFile('nimbus', 'knowledge/long.md', { limit: 20_000 });
    expect(first.text).toHaveLength(20_000);
    expect(first.more).toBe(true);
    const last = brains.readBrainFile('nimbus', 'knowledge/long.md', { offset: 40_000, limit: 20_000 });
    expect(last.more).toBe(false);
    expect(last.offset + last.text.length).toBe(last.total);
  });
});

// ─── readBrainSession ────────────────────────────────────────────────────────────────

describe('readBrainSession — a past session as the conversation it was', () => {
  it('is the owner\'s and the agent\'s words, ending with the final pick; no tool call or output', () => {
    const s = brains.readBrainSession('nimbus', 'abc123');
    expect(s.text).toContain('OWNER: find me a treadmill');
    expect(s.text.trimEnd().endsWith('AGENT: Final pick: Glidemax G9, https://shop.example/glidemax-g9')).toBe(true);
    expect(s.text).not.toContain('sk-live-999');
    expect(s.text).not.toContain('cat .env');
    expect(s.path).toBe('session:abc123');
  });

  it('without an offset it reads the END, so a long session shows its conclusion', () => {
    const s = brains.readBrainSession('nimbus', 'abc123', { limit: 80 });
    expect(s.text).toContain('Glidemax G9');
    expect(s.text).not.toContain('find me a treadmill');
    expect(s.offset).toBeGreaterThan(0);
  });

  it('only a session of THAT vault: another project\'s session id, an unsafe id, or no such session → not_found', () => {
    for (const id of ['zzz999', '../abc123', 'nope']) {
      expect(() => brains.readBrainSession('nimbus', id)).toThrow(brains.BrainReadError);
    }
  });
});

// ─── Routes ──────────────────────────────────────────────────────────────────────────

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

function mkReq(url: string, o: { token?: string | null; remote?: string } = {}): IncomingMessage {
  const token = o.token === undefined ? state.assistantToken() : o.token;
  return Object.assign(Readable.from([]), {
    method: 'GET',
    url,
    headers: { host: '127.0.0.1:4173', ...(token !== null ? { 'x-dreamcontext-assistant-token': token } : {}) },
    socket: { remoteAddress: o.remote ?? '127.0.0.1' },
  }) as unknown as IncomingMessage;
}

type Handler = (q: IncomingMessage, s: ServerResponse) => Promise<void>;
const call = async (h: Handler, url: string, o?: Parameters<typeof mkReq>[1]) => {
  const r = makeRes();
  await h(mkReq(url, o), r.res);
  return r;
};

describe('routes — gated, fenced, tainting', () => {
  const ROUTES: Array<[string, Handler, string]> = [
    ['recall', routes.handleAssistantRecall, '/api/assistant/recall?q=treadmill'],
    ['index', routes.handleAssistantIndex, '/api/assistant/index'],
    ['read', routes.handleAssistantRead, '/api/assistant/read?vault=nimbus&path=knowledge/long.md'],
  ];

  for (const [name, h, url] of ROUTES) {
    it(`${name}: no token → 401 not_assistant; non-loopback → 403; token → 200 and tainted`, async () => {
      expect((await call(h, url, { token: null })).body().error).toBe('not_assistant');
      expect((await call(h, url, { remote: '100.64.1.2' })).status()).toBe(403);
      expect(state.isTainted()).toBe(false);
      const ok = await call(h, url);
      expect(ok.status()).toBe(200);
      expect(JSON.stringify(ok.body())).toContain('<untrusted-project-output vault=');
      expect(state.isTainted()).toBe(true);
    });
  }

  it('recall fences each hit once and keeps path/file plain for read', async () => {
    const r = await call(routes.handleAssistantRecall, '/api/assistant/recall?q=treadmill%20picked&vault=nimbus');
    const hit = (r.body().groups as Array<{ vault: string; hits: Array<Record<string, string>> }>)[0].hits[0];
    expect(hit.path).toBe('state/.session-digests/abc123.md');
    expect(hit.text).toMatch(/^<untrusted-project-output vault="nimbus">[\s\S]*Stridewell T3[\s\S]*<\/untrusted-project-output>$/);
  });

  it('the Assistant\'s own memory alone does not taint', async () => {
    const r = await call(routes.handleAssistantRecall, '/api/assistant/recall?q=prefers%20short%20answers&vault=__assistant__');
    expect((r.body().groups as unknown[]).length).toBe(1);
    expect(state.isTainted()).toBe(false);
  });

  it('read refuses a secrets file with its named error and serves nothing', async () => {
    const r = await call(routes.handleAssistantRead, '/api/assistant/read?vault=orbit-math&path=state/.secrets.json');
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('not_readable');
    expect(JSON.stringify(r.body())).not.toContain('sk-live');
    expect(state.isTainted()).toBe(false);
  });

  it('read --session: fenced, tainting, and it says where the earlier part starts', async () => {
    const r = await call(routes.handleAssistantRead, '/api/assistant/read?vault=nimbus&session=abc123&limit=80');
    expect(r.status()).toBe(200);
    expect(String(r.body().text)).toMatch(/^<untrusted-project-output vault="nimbus">[\s\S]*Glidemax G9/);
    expect(r.body().earlier).toMatch(/^--offset \d+$/);
    expect(state.isTainted()).toBe(true);
  });

  it('read takes exactly one of path or session', async () => {
    const both = await call(routes.handleAssistantRead, '/api/assistant/read?vault=nimbus&path=knowledge/long.md&session=abc123');
    expect(both.body().error).toBe('invalid_query');
  });

  it('read pages: a long file says where the next part starts', async () => {
    const r = await call(routes.handleAssistantRead, '/api/assistant/read?vault=nimbus&path=knowledge/long.md&limit=20000');
    expect(r.body()).toMatchObject({ more: true, next: '--offset 20000' });
  });

  it('bad input gets a named 400', async () => {
    expect((await call(routes.handleAssistantRecall, '/api/assistant/recall?q=')).body().error).toBe('invalid_query');
    expect((await call(routes.handleAssistantRecall, '/api/assistant/recall?q=x&types=knowledge,bogus')).body().error).toBe('invalid_types');
    expect((await call(routes.handleAssistantRead, '/api/assistant/read?vault=nimbus')).body().error).toBe('invalid_query');
  });
});
