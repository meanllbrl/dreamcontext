// Mac mode's Return lands the phone's tabs on the desktop (owner, 2026-10-18: "telefonda açtığım
// session hands free kapanınca bilgisayara düşmüyor"). The phone keeps its own roster file while
// Mac mode is on; Return moves its tabs into the desktop's and bumps the generation, so a desktop
// window on the old roster re-hydrates instead of saving them away.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Readable } from 'node:stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  handleAgentSessionsGet, handleAgentSessionsPut, landPhoneRosterOnDesktop, MAX_SESSIONS, phoneTabsLanding, type SavedMeta,
} from '../../src/server/routes/agent-sessions.js';
import { macModeEnded } from '../../dashboard/src/components/handsfree/macStore.js';
import type { MacStatus } from '../../dashboard/src/components/handsfree/macContract.js';

const tab = (title: string, over: Partial<SavedMeta> = {}): SavedMeta => ({ title, bypass: false, minimized: false, size: 1, kind: 'chat', ...over });
const ids = (xs: readonly SavedMeta[]) => xs.map((m) => m.sessionId);
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

describe('phoneTabsLanding', () => {
  const desktop = [tab('Desk A', { sessionId: uuid(1), pane: 0 }), tab('Desk B', { sessionId: uuid(2), pane: 2 })];

  it('lands only the conversations the desktop lacks, once each, in one new pane right of the desktop\'s', () => {
    const phone = [
      tab('Adopted from the desk', { sessionId: uuid(1), pane: 0, active: true }),
      tab('Opened on the phone', { sessionId: uuid(3), pane: 0, active: true, mode: 'develop' }),
      tab('Opened on the phone (dup)', { sessionId: uuid(3) }),
      tab('Second phone chat', { sessionId: uuid(4), pane: 1, titleByAgent: true }),
    ];
    const { land, keep } = phoneTabsLanding(desktop, phone);
    expect(ids(land)).toEqual([uuid(3), uuid(4)]);
    expect(land.map((m) => m.pane)).toEqual([3, 3]);
    expect(land.some((m) => 'active' in m)).toBe(false);
    expect(land[0]).toMatchObject({ title: 'Opened on the phone', kind: 'chat', mode: 'develop' });
    expect(land[1].titleByAgent).toBe(true);
    // Moved, and the desktop's own tab stays the desktop's: the phone keeps nothing here.
    expect(keep).toEqual([]);
  });

  it('a phone tab under Bypass lands as Auto: no permission field travels into the desktop\'s file', () => {
    const { land } = phoneTabsLanding([], [tab('Bypass on the phone', { sessionId: uuid(5), bypass: true })]);
    expect(land).toEqual([expect.objectContaining({ sessionId: uuid(5), bypass: false, pane: 0 })]);
  });

  it('a shell, an entry with no conversation and a tab with no room left stay on the phone', () => {
    const full = Array.from({ length: MAX_SESSIONS - 1 }, (_, i) => tab(`Desk ${i}`, { sessionId: uuid(100 + i) }));
    const phone = [tab('Legacy', {}), tab('Shell', { sessionId: uuid(6), kind: 'shell' }), tab('Fits', { sessionId: uuid(7) }), tab('No room', { sessionId: uuid(8) })];
    const { land, keep } = phoneTabsLanding(full, phone);
    expect(ids(land)).toEqual([uuid(7)]);
    expect(keep.map((m) => m.title)).toEqual(['Legacy', 'Shell', 'No room']);
  });
});

describe('landPhoneRosterOnDesktop', () => {
  let scratch: string;
  let home: string;
  let contextRoot: string;
  const realDesktop = process.env.DREAMCONTEXT_DESKTOP;
  const deskFile = () => join(contextRoot, 'state', '.agent-sessions.json');
  const phoneFile = () => join(contextRoot, 'state', '.agent-sessions.phone.json');
  const write = (path: string, body: object) => writeFileSync(path, JSON.stringify(body));
  const read = (path: string) => JSON.parse(readFileSync(path, 'utf-8')) as { sessions: SavedMeta[]; generation?: number; chatPermissionMode: string };

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hf-land-'));
    home = join(scratch, 'home');
    contextRoot = join(scratch, 'proj', '_dream_context');
    mkdirSync(join(contextRoot, 'state'), { recursive: true });
    mkdirSync(home, { recursive: true });
    process.env.DREAMCONTEXT_DESKTOP = '1';
  });
  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
    if (realDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP;
    else process.env.DREAMCONTEXT_DESKTOP = realDesktop;
  });

  function res(): { res: ServerResponse; status: () => number; body: () => Record<string, unknown> } {
    let code = 0;
    let body: Record<string, unknown> = {};
    const r = { writeHead(c: number) { code = c; }, setHeader() {}, end(d: string) { body = JSON.parse(d); } } as unknown as ServerResponse;
    return { res: r, status: () => code, body: () => body };
  }
  async function get(): Promise<Record<string, unknown>> {
    const r = res();
    await handleAgentSessionsGet({} as IncomingMessage, r.res, {}, contextRoot, home);
    return r.body();
  }
  async function put(body: unknown): Promise<number> {
    const req = Readable.from([Buffer.from(JSON.stringify(body))]) as unknown as IncomingMessage;
    Object.assign(req, { method: 'PUT', headers: { 'content-type': 'application/json' } });
    const r = res();
    await handleAgentSessionsPut(req, r.res, {}, contextRoot, home);
    return r.status();
  }

  it('no phone roster: nothing lands and nothing is written', async () => {
    write(deskFile(), { sessions: [tab('Desk', { sessionId: uuid(1) })], chatPermissionMode: 'bypass' });
    const before = readFileSync(deskFile(), 'utf-8');
    expect(await landPhoneRosterOnDesktop(contextRoot)).toBe(0);
    expect(readFileSync(deskFile(), 'utf-8')).toBe(before);
    expect(existsSync(phoneFile())).toBe(false);
  });

  it('the phone\'s tabs join the desktop\'s, both generations bump, and an old desktop save re-hydrates instead of dropping them', async () => {
    write(deskFile(), { sessions: [tab('Desk', { sessionId: uuid(1), pane: 0, active: true })], chatPermissionMode: 'bypass' });
    write(phoneFile(), { sessions: [tab('Desk', { sessionId: uuid(1) }), tab('Phone chat', { sessionId: uuid(2), bypass: true })], chatPermissionMode: 'auto', generation: 4 });
    const seen = (await get()).generation;
    expect(seen).toBe(0);

    expect(await landPhoneRosterOnDesktop(contextRoot)).toBe(1);

    const desk = read(deskFile());
    expect(ids(desk.sessions)).toEqual([uuid(1), uuid(2)]);
    expect(desk.sessions[1]).toMatchObject({ title: 'Phone chat', bypass: false, pane: 1 });
    expect(desk.chatPermissionMode).toBe('bypass');
    expect(desk.generation).toBe(1);
    const phone = read(phoneFile());
    expect(phone.sessions).toEqual([]);
    expect(phone.generation).toBe(5);
    expect(phone.chatPermissionMode).toBe('auto');

    // The desktop window still on generation 0 saves its screen (without the phone's tab): refused.
    expect(await put({ sessions: [tab('Desk', { sessionId: uuid(1) })], chatPermissionMode: 'bypass', baseGeneration: seen })).toBe(409);
    expect(ids(read(deskFile()).sessions)).toEqual([uuid(1), uuid(2)]);
    // Its re-hydrate reads the landed tab.
    expect(await get()).toMatchObject({ generation: 1, sessions: [expect.objectContaining({ sessionId: uuid(1) }), expect.objectContaining({ sessionId: uuid(2), title: 'Phone chat' })] });
  });

  it('a second Return finds nothing to move and writes nothing', async () => {
    write(phoneFile(), { sessions: [tab('Phone chat', { sessionId: uuid(2) })], chatPermissionMode: 'auto' });
    expect(await landPhoneRosterOnDesktop(contextRoot)).toBe(1);
    const desk = readFileSync(deskFile(), 'utf-8');
    const phone = readFileSync(phoneFile(), 'utf-8');
    expect(await landPhoneRosterOnDesktop(contextRoot)).toBe(0);
    expect(readFileSync(deskFile(), 'utf-8')).toBe(desk);
    expect(readFileSync(phoneFile(), 'utf-8')).toBe(phone);
  });

  it('a desktop roster held by a writer past the wait throws; nothing moved', async () => {
    write(phoneFile(), { sessions: [tab('Phone chat', { sessionId: uuid(2) })], chatPermissionMode: 'auto' });
    writeFileSync(`${deskFile()}.lock`, JSON.stringify({ pid: process.pid, at: Date.now() }));
    await expect(landPhoneRosterOnDesktop(contextRoot, { waitMs: 50 })).rejects.toThrow(/locked/);
    expect(existsSync(deskFile())).toBe(false);
    expect(ids(read(phoneFile()).sessions)).toEqual([uuid(2)]);
  });
});

describe('macModeEnded (the desktop poller\'s Return signal)', () => {
  const st = (phase: MacStatus['phase']) => ({ phase }) as MacStatus;

  it('fires when a run ends, whoever pressed Return; never on the first reading or a failed start', () => {
    expect(macModeEnded(st('on'), st('off'))).toBe(true);
    expect(macModeEnded(st('stopping'), st('off'))).toBe(true);
    expect(macModeEnded(null, st('off'))).toBe(false);
    expect(macModeEnded(st('starting'), st('off'))).toBe(false);
    expect(macModeEnded(st('off'), st('off'))).toBe(false);
    expect(macModeEnded(st('on'), st('on'))).toBe(false);
  });
});
