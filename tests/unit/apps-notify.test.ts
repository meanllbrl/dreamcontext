import { afterAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_SOUND_HELP, APP_SOUNDS, RUNNER_NOTIFY_FLAG, notifyFromApp, resolveAppSound, runnerCanNotify, runnerEnv } from '../../src/lib/apps/app-notify.js';
import { icnsToPng } from '../../src/lib/apps/icns-raster.js';
import { NOTIFY_SOUND_OK } from '../../src/lib/automations/notifier.js';
import { readNotifications } from '../../src/lib/notification-log.js';
import { normalizeNotifications } from '../../dashboard/src/components/appLink/inboxModel.js';

const dirs: string[] = [];
const tmp = () => { const d = realpathSync(mkdtempSync(join(tmpdir(), 'dc-app-dir-'))); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const rec = { vault: 'acme', slug: 'hello', hash: 'abcdef0123456789' };
const bundleOf = (home: string) => join(home, 'Applications', 'Dreamcontext Apps', 'hello-abcdef.app');

function bundleWith(home: string, binary: string): string {
  const b = bundleOf(home);
  mkdirSync(join(b, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(join(b, 'Contents', 'MacOS', 'app-runner'), binary);
  return b;
}

describe('sound', () => {
  it('true and default are a sound that exists; a name is that name', () => {
    expect(resolveAppSound(true)).toBe(NOTIFY_SOUND_OK);
    expect(resolveAppSound('default')).toBe(NOTIFY_SOUND_OK);
    expect(APP_SOUNDS).toContain(NOTIFY_SOUND_OK);
    for (const s of APP_SOUNDS) expect(resolveAppSound(s)).toBe(s);
  });
  it('none, false and absent are silent', () => {
    for (const v of ['none', false, undefined]) expect(resolveAppSound(v)).toBeUndefined();
  });
  it('an unknown value is refused and the help names what is valid', () => {
    for (const v of ['Nope', 'glass', 1, null, {}, '']) expect(resolveAppSound(v)).toBeNull();
    for (const w of ['true', 'false', 'default', 'none', 'Glass', 'Sosumi']) expect(APP_SOUND_HELP).toContain(w);
  });
});

describe('who posts', () => {
  it('reads the capability from the binary, so an older runner never gets the flag', () => {
    const home = tmp();
    expect(runnerCanNotify(bundleOf(home))).toBe(false);
    expect(runnerCanNotify(bundleWith(home, `elf ${RUNNER_NOTIFY_FLAG} elf`))).toBe(true);
    const old = tmp();
    expect(runnerCanNotify(bundleWith(old, 'an older runner'))).toBe(false);
  });

  it('a capable bundle posts itself: sound in the payload, the history row names the app', async () => {
    const home = tmp();
    const post = vi.fn(async () => true);
    const fallback = vi.fn(() => true);
    const via = await notifyFromApp({ title: 'Hello', body: 'hi', rec, sound: 'Glass', historyLink: 'dreamcontext://x', home }, { platform: 'darwin', canNotify: () => true, post, fallback });
    expect(via).toBe('app');
    expect(fallback).not.toHaveBeenCalled();
    expect(post.mock.calls[0][0]).toBe(join(bundleOf(home), 'Contents', 'MacOS', 'app-runner'));
    expect(JSON.parse(post.mock.calls[0][1])).toEqual({ title: 'Hello', body: 'hi', sound: 'Glass' });
    const [row] = readNotifications(5, home);
    expect(row).toMatchObject({ title: 'Hello', link: 'dreamcontext://x', file: bundleOf(home), app: { vault: 'acme', slug: 'hello' } });
    expect(normalizeNotifications([row])[0].app).toEqual({ vault: 'acme', slug: 'hello' });
  });

  it('silence leaves the sound out of the payload', async () => {
    const post = vi.fn(async () => true);
    await notifyFromApp({ title: 'T', body: 'b', rec, home: tmp() }, { platform: 'darwin', canNotify: () => true, post });
    expect(JSON.parse(post.mock.calls[0][1])).toEqual({ title: 'T', body: 'b' });
  });

  it.each([
    ['an older bundle', { canNotify: () => false }],
    ['a post macOS refused', { canNotify: () => true, post: async () => false }],
    ['another platform', { canNotify: () => true, platform: 'linux' as const }],
  ])('%s falls back to dreamcontext, sound and click intact', async (_n, deps) => {
    const home = tmp();
    const fallback = vi.fn(() => true);
    expect(await notifyFromApp({ title: 'T', body: 'b', rec, sound: 'Ping', home }, { platform: 'darwin', fallback, ...deps })).toBe('dreamcontext');
    expect(fallback.mock.calls[0]).toEqual(['T', 'b', home, expect.objectContaining({ sound: 'Ping', openTarget: bundleOf(home), historyApp: { vault: 'acme', slug: 'hello' } })]);
  });

  it('null when neither route could post', async () => {
    expect(await notifyFromApp({ title: 'T', body: 'b', rec, home: tmp() }, { platform: 'darwin', canNotify: () => false, fallback: () => false })).toBeNull();
  });

  it('a history row from before apps carried one reads as no app', () => {
    expect(normalizeNotifications([{ id: 'n', at: '2026-11-01T00:00:00Z', title: 'T', body: '', link: null, file: null }])[0].app).toBeUndefined();
  });
});

describe('what the server hands the runner', () => {
  it('only the variables a post needs, never the server\'s tokens', () => {
    expect(Object.keys(runnerEnv('/h')).sort()).toEqual(['HOME', 'LANG', 'PATH']);
    expect(runnerEnv('/h').HOME).toBe('/h');
  });
});

describe('an .icns icon in the notch and the history', () => {
  it('is a cached PNG; the same file is converted once', async () => {
    const home = tmp();
    const exec = vi.fn(async (_c: string, args: string[]) => { writeFileSync(args[args.length - 1], 'png'); });
    const src = join(home, 'icon.icns');
    writeFileSync(src, 'icns');
    const out = await icnsToPng(src, home, exec);
    expect(out).toMatch(/\.png$/);
    expect(await icnsToPng(src, home, exec)).toBe(out);
    expect(exec).toHaveBeenCalledTimes(1);
  });
  it('anything else, or a failed conversion, is no icon', async () => {
    const home = tmp();
    const src = join(home, 'icon.icns');
    writeFileSync(src, 'icns');
    expect(await icnsToPng(join(home, 'icon.png'), home, vi.fn())).toBeNull();
    expect(await icnsToPng(src, home, async () => { throw new Error('sips'); })).toBeNull();
  });
});

describe('the contract in source', () => {
  it('the flag is the runner\'s flag', () => {
    expect(readFileSync('desktop/app-runner/src/model.rs', 'utf-8')).toContain(`NOTIFY_FLAG: &str = "${RUNNER_NOTIFY_FLAG}"`);
  });
  it('the skill reference tells sound the way the code does', () => {
    const doc = readFileSync('skill-apps/references/sdk.md', 'utf-8');
    for (const s of APP_SOUNDS) expect(doc).toContain(`\`${s}\``);
    expect(doc).toContain('`true` or `"default"`');
    expect(doc).toContain('`false` or `"none"`');
  });
});
