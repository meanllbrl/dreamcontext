import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handleLauncherLogoRemove, handleLauncherLogoSet } from '../../src/server/routes/launcher.js';
import { addVault } from '../../src/lib/vaults.js';
import { findVaultLogo } from '../../src/lib/vault-logo.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const GIF = Buffer.from('GIF89a-----');

function makeRes() {
  let status = 0;
  let body: { error?: string; logo?: boolean; logoStamp?: number | null } = {};
  const res = {
    writeHead(code: number) { status = code; },
    setHeader() {},
    end(data: string) { body = JSON.parse(data); },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => body };
}

const req = (vault: string, bytes: Buffer[] = []) => Object.assign(Readable.from(bytes), {
  method: 'POST',
  url: `/api/launcher/logo?vault=${encodeURIComponent(vault)}`,
  headers: {},
}) as unknown as IncomingMessage;

describe('launcher logo routes', () => {
  let home: string;
  let originalHome: string | undefined;
  let context: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dc-logo-'));
    originalHome = process.env.HOME;
    process.env.HOME = home;
    const root = join(home, 'acme');
    context = join(root, '_dream_context');
    mkdirSync(join(context, 'assets'), { recursive: true });
    addVault('acme', root);
  });

  afterEach(() => {
    process.env.HOME = originalHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('sets a verified raster into the vault', async () => {
    const r = makeRes();
    await handleLauncherLogoSet(req('acme', [PNG]), r.res, {}, null);
    expect(r.status()).toBe(200);
    expect(r.body().logo).toBe(true);
    expect(r.body().logoStamp).toEqual(expect.any(Number));
    expect(findVaultLogo(context)?.mime).toBe('image/png');
  });

  it('refuses a GIF and keeps the logo it would have deleted', async () => {
    writeFileSync(join(context, 'assets', 'logo.png'), PNG);
    const r = makeRes();
    await handleLauncherLogoSet(req('acme', [GIF]), r.res, {}, null);
    expect(r.status()).toBe(400);
    expect(r.body().error).toBe('not_an_image');
    expect(findVaultLogo(context)).not.toBeNull();
    expect(existsSync(join(context, 'assets', 'logo.gif'))).toBe(false);
  });

  it('refuses bytes that are no image, whatever the file claims', async () => {
    const r = makeRes();
    await handleLauncherLogoSet(req('acme', [Buffer.from('<svg onload="x()"/>')]), r.res, {}, null);
    expect(r.status()).toBe(400);
    expect(findVaultLogo(context)).toBeNull();
  });

  it('removes every candidate, so a shadowed logo does not surface', async () => {
    writeFileSync(join(context, 'assets', 'logo.png'), PNG);
    writeFileSync(join(context, 'assets', 'logo.svg'), '<svg/>');
    writeFileSync(join(context, 'assets', 'other.png'), PNG);
    const r = makeRes();
    await handleLauncherLogoRemove(req('acme'), r.res, {}, null);
    expect(r.status()).toBe(200);
    expect(r.body()).toMatchObject({ logo: false, logoStamp: null });
    expect(findVaultLogo(context)).toBeNull();
    expect(existsSync(join(context, 'assets', 'other.png'))).toBe(true);
  });

  it('writes and deletes nothing for a name that is not registered', async () => {
    for (const handler of [handleLauncherLogoSet, handleLauncherLogoRemove]) {
      const r = makeRes();
      await handler(req('../acme', [PNG]), r.res, {}, null);
      expect(r.status()).toBe(404);
      expect(r.body().error).toBe('unknown_vault');
    }
  });
});
