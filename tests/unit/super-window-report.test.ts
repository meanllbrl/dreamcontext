/**
 * A Super Agent's screen verb never succeeds silently (owner 2026-11-14, Tilki: `super present`
 * answered its view while the owner's screen never moved): its reply names `window`, `sent` when
 * the record's push reached a window socket, `none` with a note when it reached none. And the
 * window opens the Super it does not hold yet by TAKING the live process, never respawning it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-window-report-home-`);
});

import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';
import { pushSuperState, superPushMark, superPushedSince } from '../../src/lib/super/inbox.js';
import { emptySuperState } from '../../src/lib/super/types.js';
import { reportWindow, WINDOW_NONE_NOTE } from '../../src/server/routes/super.js';
import { superPaneReattach } from '../../dashboard/src/components/sleepy/super/sessionHome.js';

const PIN = '5e4f6071-8293-4a04-8b15-c26d37e48f59';
let dir: string;
let root: string;

const state = () => ({ ...emptySuperState(), session: PIN, enabled: true });
function bridge(open: boolean) {
  return mintWindowToken({ send: () => open, vault: 'acme', contextRoot: root, sessionId: PIN, mode: 'super', superId: 'main' });
}

/** A response that keeps what was written. */
function fakeRes() {
  const out: { status?: number; headers?: Record<string, unknown>; body?: string } = {};
  const res = {
    writeHead: (status: number, headers: Record<string, unknown>) => { out.status = status; out.headers = headers; return res; },
    end: (body?: string) => { out.body = body; return res; },
  };
  return { res: res as unknown as ServerResponse, out };
}
const send = (res: ServerResponse, status: number, data: unknown) => {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
};

beforeEach(() => {
  resetWindowControl();
  dir = mkdtempSync(join(tmpdir(), 'super-window-report-'));
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
});
afterEach(() => {
  resetWindowControl();
  rmSync(dir, { recursive: true, force: true });
});

describe('superPushedSince', () => {
  it('says whether the last push after the mark reached a window socket, null when none was pushed', () => {
    const mark = superPushMark();
    expect(superPushedSince(PIN, mark)).toBeNull();
    pushSuperState(root, state());
    expect(superPushedSince(PIN, mark)).toBe(false);
    const b = bridge(true);
    pushSuperState(root, state());
    expect(superPushedSince(PIN, mark)).toBe(true);
    b.release();
    expect(superPushedSince(PIN, superPushMark())).toBeNull();
    expect(superPushedSince(null, mark)).toBeNull();
  });
});

describe('reportWindow', () => {
  it('a push that reached the window: `window: sent`, the length matches the body', () => {
    bridge(true);
    const { res, out } = fakeRes();
    reportWindow(res, PIN, superPushMark());
    pushSuperState(root, state());
    send(res, 200, { ok: true, result: { view: { mode: 'present', cards: ['web-1'] } } });
    const body = JSON.parse(out.body!);
    expect(body.result).toEqual({ view: { mode: 'present', cards: ['web-1'] }, window: 'sent' });
    expect(out.headers!['Content-Length']).toBe(Buffer.byteLength(out.body!));
  });

  it('no window socket took it: `window: none` and the note, never a silent success', () => {
    bridge(false);
    const { res, out } = fakeRes();
    reportWindow(res, PIN, superPushMark());
    pushSuperState(root, state());
    send(res, 200, { ok: true, result: { container: 'web-1', place: 'others' } });
    expect(JSON.parse(out.body!).result).toEqual({ container: 'web-1', place: 'others', window: 'none', windowNote: WINDOW_NONE_NOTE });
  });

  it('a refusal, or a verb that wrote nothing, is sent as it came', () => {
    const { res, out } = fakeRes();
    reportWindow(res, PIN, superPushMark());
    pushSuperState(root, state());
    send(res, 409, { ok: false, error: 'owner_sized' });
    expect(JSON.parse(out.body!)).toEqual({ ok: false, error: 'owner_sized' });
    const second = fakeRes();
    reportWindow(second.res, PIN, superPushMark());
    send(second.res, 200, { ok: true, result: { view: { mode: 'float' } } });
    expect(JSON.parse(second.out.body!).result).toEqual({ view: { mode: 'float' } });
  });
});

describe('superPaneReattach', () => {
  it('the window takes a Super it reopens; a fresh one and a remote screen open as before', () => {
    expect(superPaneReattach(false)).toBe('1');
    expect(superPaneReattach(true)).toBe('');
    expect(superPaneReattach(false, true)).toBe('');
  });
});
