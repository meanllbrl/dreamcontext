/**
 * A Super child's model and effort from the job's facts (plan iyilesme-360 C10, D19; criterion 14).
 * The pure rule (`childPolicy`) and the verbs that apply it: no model is `model_required` with the
 * table; Fable only on his word; an effort above the mode's default only with `--risk`, `--full` or
 * his words; a mode switch into develop lowers an unallowed effort. Fictional words; HOME is temp.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-policy-home-`);
});

const sent = vi.hoisted(() => ({ prompts: [] as string[], frames: [] as Array<Record<string, unknown>> }));
vi.mock('../../src/lib/window-control.js', async (orig) => {
  const real = await orig<typeof import('../../src/lib/window-control.js')>();
  return {
    ...real,
    sendSuperCommand: async (...a: Parameters<typeof real.sendSuperCommand>) => {
      if (a[1] !== 'delegate') return real.sendSuperCommand(...a);
      sent.prompts.push(String((a[2] as { prompt?: unknown }).prompt ?? ''));
      sent.frames.push(a[2] as Record<string, unknown>);
      return { ok: true, result: { sessionId: `child-${sent.prompts.length}` } };
    },
  };
});

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { emptySuperState, msgRef } from '../../src/lib/super/types.js';
import { _resetSuperInbox, markSuperEventTurn, noteSuperOwnerMsg } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { childPolicy, MODEL_REQUIRED_LINE } from '../../src/lib/model-facts.js';

describe('childPolicy (pure)', () => {
  it('a Claude child with no model is refused with the table', () => {
    expect(childPolicy({ mode: 'basic' }, [])).toEqual({ ok: false, error: 'model_required', message: MODEL_REQUIRED_LINE });
    expect(MODEL_REQUIRED_LINE).toContain('`--model sonnet`');
    expect(MODEL_REQUIRED_LINE).toContain('`--model opus`');
  });
  it('Fable only when his words name it', () => {
    expect(childPolicy({ mode: 'plan', model: 'fable' }, ['bunu düzelt'])).toMatchObject({ ok: false, error: 'model_refused' });
    expect(childPolicy({ mode: 'plan', model: 'claude-fable-5-2' }, ['Fable ile planla'])).toMatchObject({ ok: true, model: 'claude-fable-5-2' });
  });
  it('develop high only with --risk, --full or his words', () => {
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high' }, [])).toMatchObject({ ok: false, error: 'effort_refused' });
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high', risk: 'money' }, [])).toMatchObject({ ok: true, effort: 'high', risk: 'money', allowedBy: 'risk' });
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high', full: true }, [])).toMatchObject({ ok: true, allowedBy: 'full' });
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high' }, ['bunu derin düşünerek yap'])).toMatchObject({ ok: true, allowedBy: 'words' });
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'medium' }, [])).toMatchObject({ ok: true, effort: 'medium', allowedBy: 'flags' });
    expect(childPolicy({ mode: 'plan', model: 'opus', effort: 'high' }, [])).toMatchObject({ ok: true, allowedBy: 'flags' });
    expect(childPolicy({ mode: 'plan', model: 'opus', effort: 'xhigh' }, [])).toMatchObject({ ok: false, error: 'effort_refused' });
  });
  // r1 edge-cases-3: what allowed the effort a child runs still allows it at a later change that does not raise it.
  it('the effort a child already runs in the same mode is kept; a raise or another mode is checked again', () => {
    const prior = { mode: 'develop', effort: 'high', allowedBy: 'full' as const };
    expect(childPolicy({ mode: 'develop', model: 'sonnet', effort: 'high', prior }, [])).toMatchObject({ ok: true, effort: 'high', allowedBy: 'full' });
    expect(childPolicy({ mode: 'develop', model: 'sonnet', effort: 'medium', prior }, [])).toMatchObject({ ok: true, effort: 'medium', allowedBy: 'flags' });
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'xhigh', prior }, [])).toMatchObject({ ok: false, error: 'effort_refused' });
    expect(childPolicy({ mode: 'basic', model: 'opus', effort: 'high', prior }, [])).toMatchObject({ ok: false, error: 'effort_refused' });
    // A child made before this build: its running effort, no recorded allowance.
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high', prior: { mode: 'develop', effort: 'high' } }, [], { modelKept: true })).toMatchObject({ ok: true, allowedBy: 'flags' });
  });
  it('high or max count as his words only when said of the effort', () => {
    for (const w of ['high priority bir iş', 'max 3 dosya değişsin']) {
      expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high' }, [w]), w).toMatchObject({ ok: false, error: 'effort_refused' });
    }
    for (const w of ['high effort ile yap', 'efor max olsun', 'xhigh düşün']) {
      expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high' }, [w]), w).toMatchObject({ ok: true, allowedBy: 'words' });
    }
  });
  it('a mode switch lowers an effort the new mode does not allow, and says so', () => {
    expect(childPolicy({ mode: 'develop', model: 'opus', effort: 'high' }, [], { lowerOnModeSwitch: true })).toMatchObject({ ok: true, effort: 'medium', effortLowered: true });
  });
  it('an existing child with no recorded model keeps its tab\'s on update or resume', () => {
    expect(childPolicy({ mode: 'basic' }, [], { modelKept: true })).toMatchObject({ ok: true, model: '' });
  });
  it('Codex and Antigravity keep their own defaults', () => {
    expect(childPolicy({ mode: 'develop', tool: 'codex' }, [])).toMatchObject({ ok: true, skipped: true });
    expect(childPolicy({ mode: 'develop', tool: 'antigravity', effort: 'high' }, [])).toMatchObject({ ok: true, skipped: true });
  });
});

let dir: string;
let root: string;
let token = '';
const SUPER = 'sup-1';
const job = { prompt: 'Read and follow _dream_context/tmp/super-prompts/orbit/brief.md', brief: 'Orbit · develop', mode: 'develop' };
function req(body: unknown): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', 'x-dreamcontext-window-token': token }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
async function verb(name: string, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const out = { status: 0, json: {} as Record<string, unknown> };
  const r = out as unknown as ServerResponse;
  (r as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (r as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  await handleSuperVerb(req(body), r, { verb: name });
  return out;
}
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'super-policy-')));
  sent.prompts.length = 0; sent.frames.length = 0;
  _resetChatRegistry(); resetSuperIndex(); _resetSuperInbox(); resetWindowControl();
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: SUPER, enabled: true }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
});
afterEach(() => { markSuperEventTurn(SUPER, false); rmSync(dir, { recursive: true, force: true }); });

describe('the verbs apply it (criterion 14)', () => {
  it('delegate and pool add: no model refused, a high develop needs --risk, which the record keeps', async () => {
    markSuperEventTurn(SUPER, false);
    noteSuperOwnerMsg(SUPER, msgRef('orbit ödeme ekranını düzelt'), { words: 'orbit ödeme ekranını düzelt' });
    expect((await verb('delegate', job)).json.error).toBe('model_required');
    expect((await verb('pool-add', job)).json.error).toBe('model_required');
    expect((await verb('delegate', { ...job, model: 'opus', effort: 'high' })).json.error).toBe('effort_refused');
    expect((await verb('delegate', { ...job, model: 'opus', effort: 'high', risk: 'payroll' })).json.error).toBe('invalid_args');
    const ok = await verb('delegate', { ...job, model: 'opus', effort: 'high', risk: 'money' });
    expect(ok.status).toBe(200);
    expect(sent.frames[0]).toMatchObject({ model: 'opus', effort: 'high' });
    expect((await readSuperState(root)).children['child-1'].context?.policy).toMatchObject({ model: 'opus', effort: 'high', risk: 'money', allowedBy: 'risk' });
  });

  it('his words asking for depth are a grant the record keeps; a successor naming nothing takes the old settings', async () => {
    const words = 'bunu en yüksek seviyede düşünerek yap';
    markSuperEventTurn(SUPER, false);
    noteSuperOwnerMsg(SUPER, msgRef(words), { words });
    expect((await verb('delegate', { ...job, model: 'opus', effort: 'high' })).status).toBe(200);
    const pol = (await readSuperState(root)).children['child-1'].context?.policy;
    expect(pol).toMatchObject({ allowedBy: 'words', grants: [{ ref: msgRef(words), words }] });
    markSuperEventTurn(SUPER, true);
    expect((await verb('delegate', { prompt: 'Carry on Orbit from its handoff', brief: 'Orbit 2', mode: 'develop', succeeds: 'child-1' })).status).toBe(200);
    expect(sent.frames[1]).toMatchObject({ model: 'opus', effort: 'high' });
  });

  // r1 edge-cases-3: a successor naming another model keeps the effort its predecessor's --risk allowed.
  it('a successor on another model keeps the effort the predecessor was allowed', async () => {
    markSuperEventTurn(SUPER, false);
    noteSuperOwnerMsg(SUPER, msgRef('orbit ödeme'), { words: 'orbit ödeme' });
    expect((await verb('delegate', { ...job, model: 'opus', effort: 'high', risk: 'money' })).status).toBe(200);
    markSuperEventTurn(SUPER, true);
    const next = await verb('delegate', { prompt: 'Carry on Orbit from its handoff', brief: 'Orbit 2', mode: 'develop', succeeds: 'child-1', model: 'sonnet' });
    expect(next.status, JSON.stringify(next.json)).toBe(200);
    expect(sent.frames[1]).toMatchObject({ model: 'sonnet', effort: 'high' });
    expect((await readSuperState(root)).children['child-2'].context?.policy).toMatchObject({ model: 'sonnet', effort: 'high', risk: 'money' });
  });

  it('a pool row made before this build (no context) starts as today', async () => {
    const s = { ...emptySuperState(), session: SUPER, enabled: true, pool: [{ id: 'p-old1', title: 'Old row', prompt: 'Old job prompt, from before', hash: 'x', createdAt: 1, mode: 'develop' }] };
    writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify(s));
    resetSuperIndex();
    markSuperEventTurn(SUPER, true);
    expect((await verb('delegate', { from: 'p-old1' })).status).toBe(200);
  });
});
