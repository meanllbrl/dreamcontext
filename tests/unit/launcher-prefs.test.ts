/**
 * `~/.dreamcontext/launcher-ui.json` (task codex-tarzi-yeni-kabuk W1, D1): the new shell's switch
 * and window layout. The POST is a MERGE of the keys sent (each strictly coerced), so a caller
 * that sends `{view}` never pins `shell`; a corrupt file is kept as `.bad` and repaired; writes
 * from two windows at once both land. The phone listener's GET carries no project names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import {
  DRAWER_WIDTH_MAX, DRAWER_WIDTH_MIN, MAX_LAYOUT_PROJECTS, coerceLauncherUiPartial, handleLauncherUiGet, handleLauncherUiSet,
} from '../../src/server/routes/launcher.js';
import * as client from '../../dashboard/src/lib/launcherPrefs.js';
import { markPhoneSocket } from '../../src/server/phone-origin.js';

let home = '';
const realHome = process.env.HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dc-launcher-ui-'));
  process.env.HOME = home;
});
afterEach(() => {
  process.env.HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const file = () => join(home, '.dreamcontext', 'launcher-ui.json');

function res() {
  const out = { status: 0, body: null as any };
  return {
    out,
    res: {
      writeHead(code: number) { out.status = code; },
      setHeader() {},
      end(data: string) { try { out.body = JSON.parse(data); } catch { out.body = data; } },
    } as any,
  };
}

async function post(body: unknown) {
  const req: any = Readable.from([Buffer.from(JSON.stringify(body))]);
  req.headers = { 'content-type': 'application/json', host: '127.0.0.1' };
  req.method = 'POST';
  req.url = '/api/launcher/ui-settings';
  req.socket = {};
  const r = res();
  await handleLauncherUiSet(req, r.res, {}, null);
  return r.out;
}

async function get(socket: object = {}) {
  const r = res();
  await handleLauncherUiGet({ headers: {}, url: '/api/launcher/ui-settings', socket } as any, r.res, {}, null);
  return r.out;
}

describe('launcher-ui.json', () => {
  it('defaults: list view, no shell stored (the dashboard reads that as classic)', async () => {
    expect((await get()).body).toEqual({ view: 'list' });
  });

  it('merges: sending view alone keeps shell, and nothing is written as a default', async () => {
    await post({ shell: 'new' });
    await post({ view: 'space' });
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ shell: 'new', view: 'space' });
    await post({ lastVault: 'acme' });
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ shell: 'new', view: 'space', lastVault: 'acme' });
  });

  it('coerces strictly: bad values are dropped, never defaulted; names are never path-shaped', () => {
    expect(coerceLauncherUiPartial({ shell: 'NEW', view: 'grid', drawerOpen: 'yes' })).toEqual({});
    expect(coerceLauncherUiPartial({ lastVault: '../etc', projectOrder: ['acme', 'a.b', 'x/y', 'acme', 3, 'globex'] }))
      .toEqual({ projectOrder: ['acme', 'globex'] });
    expect(coerceLauncherUiPartial({ lastVault: null })).toEqual({ lastVault: null });
    expect(coerceLauncherUiPartial({ drawerWidth: 9999 }).drawerWidth).toBe(DRAWER_WIDTH_MAX);
    expect(coerceLauncherUiPartial({ drawerWidth: 1 }).drawerWidth).toBe(DRAWER_WIDTH_MIN);
    const many = Array.from({ length: 500 }, (_, i) => `p${i}`);
    expect(coerceLauncherUiPartial({ drawerExpanded: many }).drawerExpanded).toHaveLength(MAX_LAYOUT_PROJECTS);
    expect(coerceLauncherUiPartial({ evil: 1, __proto__: { x: 1 } } as never)).toEqual({});
  });

  it('a corrupt file is kept as .bad and repaired by the next write', async () => {
    mkdirSync(join(home, '.dreamcontext'), { recursive: true });
    writeFileSync(file(), '{ not json');
    expect((await get()).body).toEqual({ view: 'list' });
    await post({ shell: 'new' });
    expect(readFileSync(`${file()}.bad`, 'utf-8')).toBe('{ not json');
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ shell: 'new' });
  });

  it('two windows writing different keys at once: both land', async () => {
    await Promise.all([post({ shell: 'new' }), post({ lastVault: 'acme' }), post({ drawerOpen: false }), post({ view: 'space' })]);
    expect(JSON.parse(readFileSync(file(), 'utf-8'))).toEqual({ shell: 'new', lastVault: 'acme', drawerOpen: false, view: 'space' });
    expect(existsSync(`${file()}.bad`)).toBe(false);
  });

  it('a non-object body is refused', async () => {
    expect((await post([1, 2])).status).toBe(400);
  });

  it('the phone listener reads only view and shell, never a project name', async () => {
    await post({ shell: 'new', lastVault: 'acme', projectOrder: ['acme', 'globex'], drawerExpanded: ['acme'] });
    const socket = {};
    markPhoneSocket(socket);
    const body = (await get(socket)).body;
    expect(body).toEqual({ view: 'list', shell: 'new' });
    expect(JSON.stringify(body)).not.toMatch(/acme|globex/);
    expect((await get()).body.lastVault).toBe('acme');
  });

  it('the dashboard mirrors the server limits (drift)', () => {
    expect(client.MAX_LAYOUT_PROJECTS).toBe(MAX_LAYOUT_PROJECTS);
    expect(client.DRAWER_WIDTH_MIN).toBe(DRAWER_WIDTH_MIN);
    expect(client.DRAWER_WIDTH_MAX).toBe(DRAWER_WIDTH_MAX);
  });
});
