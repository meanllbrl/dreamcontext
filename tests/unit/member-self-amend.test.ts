/**
 * An AI Team member corrects its OWN instructions from the owner's feedback in its chat (owner
 * 2026-11-15: "kendi instrakşınlarını düzeltebilmeleri lazım", and his saying it is his approval),
 * through the real `team-amend` route with a member Super's token:
 *
 *  - itself: written, still approved, no card, his words on the trace row, taken back in one call;
 *  - another member: refused `own_member_only`, nothing written;
 *  - the daily ceiling is unchanged, quoted or not (lifting it for his words is a follow-up task);
 *  - a change that came by git (nobody here stamped it) still asks: the amendment never goes over it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/amend-home-`);
});

import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, resetSuperIndex, withSuperState } from '../../src/lib/super/store.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { createAgent, getAgent } from '../../src/lib/agents/store.js';
import { createAutomation, getRunTarget } from '../../src/lib/automations/store.js';
import { checkApproval } from '../../src/lib/automations/registry.js';
import { allPendingQuestions } from '../../src/lib/automations/hitl.js';
import { listAmendments, revertAmendment } from '../../src/lib/agents/amendments.js';
import { superMemberSection } from '../../src/server/chat-modes.js';

let dir: string;
let root: string;
let project: string;
let doctorToken = '';
const DOCTOR_SUPER = 'doc-super-1';

const OLD_PROMPT = 'Check the logs every morning.\nNever restart a service; ask the owner first.\nReport what broke.';
/** His feedback takes out a rule line ("ask the owner first"): the risk filter flags it, and from
 *  his own member's chat it lands anyway. */
const NEW_PROMPT = 'Check the logs every morning.\nRestart a crashed worker yourself, then tell the owner.\nReport what broke.';
const HIS_WORDS = 'bir dahakine çöken worker\'ı kendin yeniden başlat, sonra bana haber ver';

beforeEach(async () => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'amend-')));
  project = join(dir, 'acme');
  root = join(project, '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({ ...emptySuperState(), session: 'main-super', enabled: true }));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  // The doctor's own routine runs on a schedule: one amendment a day is its ceiling.
  createAgent(root, { slug: 'doctor', title: 'Doctor', prompt: OLD_PROMPT }, { approve: { now: new Date() } });
  createAutomation(root, { slug: 'doctor-daily', title: 'doctor daily', agent: 'doctor', days: 'daily', at: '09:00', job: 'Run the morning check.' } as never, { approve: { now: new Date() } });
  createAgent(root, { slug: 'scout', title: 'Scout', prompt: OLD_PROMPT }, { approve: { now: new Date() } });
  await withSuperState(root, 'm:doctor', (s) => Object.assign(s, { enabled: true, session: DOCTOR_SUPER }));
  doctorToken = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: DOCTOR_SUPER, mode: 'super', superId: 'm:doctor' }).token;
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function amend(body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': doctorToken }), r, { verb: 'team-amend' });
  return r;
}
const approved = (slug: string, kind: 'agent' | 'automation' = 'agent') => checkApproval(project, getRunTarget(root, slug, kind)!, undefined, 'run').approved;

describe('a member corrects its own instructions from his feedback', () => {
  it('itself: written, still approved, no card, his words on the trace, taken back in one call', async () => {
    const r = await amend({ member: 'doctor', why: 'he wants crashed workers restarted without asking', quote: HIS_WORDS, prompt: NEW_PROMPT });
    expect(r.status).toBe(200);
    expect(r.json.result).toMatchObject({ changed: ['prompt'], flagged: [expect.stringContaining('rule')] });
    expect((r.json.result as Record<string, unknown>).waits).toBeUndefined();
    expect(getAgent(root, 'doctor')?.prompt).toBe(NEW_PROMPT);
    expect(approved('doctor')).toBe(true);
    expect(approved('doctor-daily', 'automation')).toBe(true);
    expect(allPendingQuestions(root)).toHaveLength(0);
    const [row] = listAmendments(project, 'doctor');
    expect(row).toMatchObject({ by: 'super', session: DOCTOR_SUPER, quote: HIS_WORDS });
    expect(row.why).toContain(HIS_WORDS);
    expect(row.waits).toBeUndefined();
    revertAmendment(root, 'doctor', row.id);
    expect(getAgent(root, 'doctor')?.prompt).toBe(OLD_PROMPT);
    expect(approved('doctor')).toBe(true);
  });

  it('another member: refused own_member_only, nothing written', async () => {
    const before = readFileSync(join(root, 'agents', 'scout.md'), 'utf-8');
    const r = await amend({ member: 'scout', why: 'x', quote: HIS_WORDS, prompt: NEW_PROMPT });
    expect(r.status).toBe(403);
    expect(r.json.error).toBe('own_member_only');
    expect(readFileSync(join(root, 'agents', 'scout.md'), 'utf-8')).toBe(before);
    expect(listAmendments(project, 'scout')).toHaveLength(0);
  });

  it('the daily ceiling is unchanged: a quote is recorded, it lifts no ceiling (follow-up task)', async () => {
    const step = (n: number) => `${OLD_PROMPT}\nKeep step ${n} short.`;
    // Unattended member: one amendment a day, quoted or not.
    expect((await amend({ member: 'doctor', why: 'first', quote: 'her adımı kısa tut', prompt: step(1) })).status).toBe(200);
    const capped = await amend({ member: 'doctor', why: 'second', quote: 'uzun açıklama yazma', prompt: step(2) });
    expect(capped.status).toBe(429);
    expect(capped.json.error).toBe('amend_limit');
    expect(approved('doctor')).toBe(true);
  });

  it('a change that came by git still asks: the self-amendment never goes over it', async () => {
    // A teammate's edit: the file moved, nothing here stamped it.
    const file = join(root, 'agents', 'doctor.md');
    writeFileSync(file, readFileSync(file, 'utf-8').replace('Report what broke.', 'Report what broke to ops.'));
    expect(approved('doctor')).toBe(false);
    const r = await amend({ member: 'doctor', why: 'his feedback', quote: HIS_WORDS, prompt: NEW_PROMPT });
    expect(r.status).toBe(409);
    expect(r.json.error).toBe('amend_unreviewed_change');
    expect(approved('doctor')).toBe(false);
  });

  it('its briefing tells it how, and that it is itself only', () => {
    const brief = superMemberSection({ slug: 'doctor', title: 'Doctor', field: 'logs' });
    expect(brief).toContain('dreamcontext super team amend doctor --why');
    expect(brief).toContain('--quote "<his exact words>"');
    expect(brief).toContain('Yourself only');
  });

  it('its briefing has it READ what waits on him before answering, and send the card with Onayla (owner 2026-11-19)', () => {
    const brief = superMemberSection({ slug: 'doctor', title: 'Doctor', field: 'logs' });
    expect(brief).toContain('never answer from memory');
    expect(brief).toContain('dreamcontext automations list --agent doctor');
    expect(brief).toContain('dreamcontext automations questions');
    expect(brief).toContain('{"type":"automation","slug":"<routine>"}');
  });
});
