import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os');
  process.env.HOME = mkdtempSync(`${tmpdir()}/super-pdf-video-home-`);
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { imageGroupBase } from '../../src/lib/super/image-group.js';
import { _resetChatRegistry } from '../../src/lib/assistant/chat-registry.js';
import { SUPER_STATE_REL, readSuperState, resetSuperIndex } from '../../src/lib/super/store.js';
import { defaultLayout, defaultSizeFor, emptySuperState, isMediaKind, type SuperContainer, type SuperState } from '../../src/lib/super/types.js';
import * as client from '../../dashboard/src/lib/superTypes.js';
import { _resetSuperInbox } from '../../src/lib/super/inbox.js';
import { handleSuperVerb } from '../../src/server/routes/super.js';
import { mintWindowToken, resetWindowControl } from '../../src/lib/window-control.js';

let dir: string;
let root: string;
const SUPER = 'sup-pdfvideo';
const JOB = 'child-job-1';
let token = '';
const savedDesktop = process.env.DREAMCONTEXT_DESKTOP;

const card = (id: string, extra: Partial<SuperContainer> = {}): SuperContainer =>
  ({ id, kind: 'chat', ref: `ref-${id}`, shape: 'tall', place: 'float', ...extra });

function makeVault(state: Partial<SuperState> = {}): void {
  root = join(dir, 'acme', '_dream_context');
  mkdirSync(join(root, 'state'), { recursive: true });
  writeFileSync(join(root, SUPER_STATE_REL), JSON.stringify({
    ...emptySuperState(), session: SUPER, enabled: true,
    children: { [JOB]: { sessionId: JOB, brief: 'job', adopted: false, startedAt: 1 } },
    containers: [card('chat-a'), card('chat-b'), card('chat-c', { pos: { x: 0.9, y: 0.1 } }), card('task-d', { kind: 'task', shape: 'square' })],
    ...state,
  }));
  token = mintWindowToken({ send: () => true, vault: 'acme', contextRoot: root, sessionId: SUPER, mode: 'super' }).token;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'super-pdf-video-'));
  _resetChatRegistry();
  resetSuperIndex();
  _resetSuperInbox();
  resetWindowControl();
  process.env.DREAMCONTEXT_DESKTOP = '1';
});
afterEach(() => {
  if (savedDesktop === undefined) delete process.env.DREAMCONTEXT_DESKTOP; else process.env.DREAMCONTEXT_DESKTOP = savedDesktop;
  rmSync(dir, { recursive: true, force: true });
});

function req(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const r = new PassThrough() as unknown as IncomingMessage & PassThrough;
  Object.assign(r, { headers: { host: '127.0.0.1:4173', ...headers }, socket: { remoteAddress: '127.0.0.1' }, method: 'POST', url: '/' });
  setImmediate(() => { (r as unknown as PassThrough).end(JSON.stringify(body)); });
  return r;
}
function res(): ServerResponse & { status: number; json: Record<string, unknown> } {
  const out = { status: 0, json: {} as Record<string, unknown> } as ServerResponse & { status: number; json: Record<string, unknown> };
  (out as unknown as { writeHead: (s: number) => void }).writeHead = (s: number) => { out.status = s; };
  (out as unknown as { end: (b?: string) => void }).end = (b?: string) => { out.json = b ? JSON.parse(b) : {}; };
  return out;
}
async function verb(name: string, body: Record<string, unknown>) {
  const r = res();
  await handleSuperVerb(req(body, { 'x-dreamcontext-window-token': token }), r, { verb: name });
  return r;
}
const state = () => readSuperState(root);

/**
 * PDFs and clips on the stage (owner 2026-10-25: "the Super Agent must be able to show a PDF and,
 * for sure, a VIDEO"): `super open pdf|video <path…>` opens a project file as a card the window
 * draws with the chat's own viewers. One path rule with pictures (project-relative, no `..`, no
 * absolute path, no URL); a PDF opens large, a clip wide; several group like pictures, each kind
 * its own set; `--for` links them to a child's job; 2+ clips present as a filmstrip.
 */
beforeEach(() => makeVault());
const result = (r: { json: Record<string, unknown> }) => (r.json.result ?? {}) as Record<string, unknown>;
const open = (kind: string, refs: string[], extra: Record<string, unknown> = {}) =>
  verb('open', refs.length === 1 ? { kind, ref: refs[0], ...extra } : { kind, refs, ...extra });

describe('super open pdf|video — the guard', () => {
  it.each([
    ['pdf', '/Users/someone/secret.pdf', 'project-relative'],
    ['pdf', '../outside/a.pdf', 'project-relative'],
    ['pdf', 'docs/../../a.pdf', 'project-relative'],
    ['pdf', 'docs\\a.pdf', 'project-relative'],
    ['pdf', './a.pdf', 'project-relative'],
    ['pdf', 'docs//a.pdf', 'project-relative'],
    ['pdf', 'https://example.com/a.pdf', 'project-relative'],
    ['pdf', 'docs/a.html', 'a .pdf file'],
    ['pdf', 'docs/a.pdf.exe', 'a .pdf file'],
    ['video', '/tmp/clip.mp4', 'project-relative'],
    ['video', '../clip.mp4', 'project-relative'],
    ['video', 'http://localhost:5173/clip.mp4', 'project-relative'],
    ['video', 'clips/a.png', '.mp4, .m4v, .mov or .webm'],
    ['video', 'clips/a.mp3', '.mp4, .m4v, .mov or .webm'],
    ['video', 'clips/a.pdf', '.mp4, .m4v, .mov or .webm'],
    ['image', 'clips/a.mp4', '.png, .jpg'],
  ])('%s %s is refused (%s)', async (kind, ref, says) => {
    const r = await open(kind, [ref]);
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('invalid_ref');
    expect(String(r.json.message)).toContain(says);
    expect((await state()).containers.some((k) => k.kind === kind)).toBe(false);
  });

  it('a project-relative .pdf and every clip extension are taken', async () => {
    expect((await open('pdf', ['docs/Spec.PDF'])).status).toBe(200);
    for (const ext of ['mp4', 'm4v', 'mov', 'webm']) expect((await open('video', [`clips/a.${ext}`])).status).toBe(200);
  });

  it('--for names a media card\'s job only (image, pdf, video), never a web page', async () => {
    expect((await open('video', ['clips/a.mp4'], { for: JOB })).status).toBe(200);
    expect((await open('pdf', ['docs/a.pdf'], { for: JOB })).status).toBe(200);
    const s = await state();
    expect(s.containers.find((k) => k.kind === 'video')?.forChild).toBe(JOB);
    expect(s.containers.find((k) => k.kind === 'pdf')?.forChild).toBe(JOB);
    const web = await verb('open', { kind: 'web', ref: 'docs/page.html', for: JOB });
    expect(web.status).toBe(400);
    expect(String(web.json.message)).toContain('media only');
  });
});

describe('super open pdf|video — the cards', () => {
  it('a PDF opens large, a clip wide; a named size wins', async () => {
    await open('pdf', ['docs/a.pdf']);
    await open('video', ['clips/a.mp4']);
    await open('video', ['clips/b.mp4'], { size: 'medium', group: false });
    const s = await state();
    const by = (ref: string) => s.containers.find((k) => k.ref === ref);
    expect(by('docs/a.pdf')).toMatchObject({ kind: 'pdf', size: 'large', place: 'float' });
    expect(by('clips/a.mp4')).toMatchObject({ kind: 'video', size: 'wide', place: 'float' });
    expect(by('clips/b.mp4')?.size).toBe('medium');
    // Not a page: neither is pushed side by side by itself.
    expect(s.view.mode).toBe('float');
  });

  it('several clips (or PDFs) in one call are one group, named for their folder, else "Videos" / "PDFs"', async () => {
    const v = await open('video', ['clips/demo/a.mp4', 'clips/demo/b.mp4'], { titles: ['First', 'Second'] });
    expect(v.status).toBe(200);
    expect(result(v).autoGroup).toBe(true);
    const p = await open('pdf', ['tmp/a.pdf', 'tmp/b.pdf']);
    const s = await state();
    const names = s.groups.map((g) => g.name).sort();
    expect(names).toEqual(['PDFs', 'demo']);
    expect(s.containers.filter((k) => k.kind === 'video').map((k) => k.title)).toEqual(['First', 'Second']);
    expect(result(p).autoGroup).toBe(true);
    expect(imageGroupBase(['a.mp4', 'b.mp4'], 'video')).toBe('Videos');
  });

  it('the chain joins a card of its own kind only: a clip after a picture stands alone', async () => {
    await open('image', ['shots/a.png']);
    const r = await open('video', ['clips/a.mp4']);
    expect(result(r).group).toBeUndefined();
    const again = await open('video', ['clips/b.mp4']);
    expect(result(again).autoGroup).toBe(true);
    const g = (await state()).groups[0];
    expect(g.cards.every((id) => id.startsWith('video-'))).toBe(true);
  });

  it('a PDF opened between two pictures leaves their chain be (one chain per kind)', async () => {
    await open('image', ['shots/a.png']);
    await open('pdf', ['docs/a.pdf']);
    const r = await open('image', ['shots/b.png']);
    expect(result(r).autoGroup).toBe(true);
    const g = (await state()).groups[0];
    expect(g.cards.length).toBe(2);
    expect(g.cards.every((id) => id.startsWith('image-'))).toBe(true);
  });

  it('2+ clips present as a filmstrip; one PDF as a spotlight', async () => {
    await open('video', ['clips/a.mp4', 'clips/b.mp4'], { group: false });
    const ids = (await state()).containers.filter((k) => k.kind === 'video').map((k) => k.id);
    const r = await verb('present', { containers: ids });
    expect(r.status).toBe(200);
    expect((await state()).view).toMatchObject({ mode: 'present', layout: 'filmstrip' });
    await verb('present', { containers: [] });
    await open('pdf', ['docs/a.pdf']);
    const pdf = (await state()).containers.find((k) => k.kind === 'pdf')!.id;
    await verb('present', { containers: [pdf] });
    expect((await state()).view).toMatchObject({ mode: 'present', layout: 'spotlight' });
  });
});

describe('the kinds on both sides of the wire', () => {
  it('the window knows pdf and video, and picks the same layouts', () => {
    expect(client.CONTAINER_KINDS).toContain('pdf');
    expect(client.CONTAINER_KINDS).toContain('video');
    const clips = [{ kind: 'video' as const, ref: 'a.mp4' }, { kind: 'video' as const, ref: 'b.mp4' }];
    const mixed = [{ kind: 'video' as const, ref: 'a.mp4' }, { kind: 'image' as const, ref: 'b.png' }];
    expect(defaultLayout(clips)).toBe('filmstrip');
    expect(client.defaultLayout(clips)).toBe('filmstrip');
    expect(defaultLayout(mixed)).toBe('compare');
    expect(client.defaultLayout(mixed)).toBe('compare');
    expect([isMediaKind('pdf'), isMediaKind('video'), isMediaKind('image'), isMediaKind('web')]).toEqual([true, true, true, false]);
    expect([defaultSizeFor('pdf'), defaultSizeFor('video'), defaultSizeFor('image'), defaultSizeFor('agenda')]).toEqual(['large', 'wide', 'small', 'large']);
  });
});
