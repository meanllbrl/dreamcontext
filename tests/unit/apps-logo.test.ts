import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { appLogoDir, appLogoPath, clearAppLogo, LogoError, logoBytes, setAppLogo, MAX_LOGO_BYTES } from '../../src/lib/apps/app-logo.js';

/** The owner's own app logo on this Mac (owner, 2026-11-09): typed by bytes, kept outside the repo. */

function png(w = 4, h = 4): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]);
const ID = 'a'.repeat(32);
const SVG = '<?xml version="1.0"?>\n<!-- logo -->\n<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 8 8"><defs><linearGradient id="g"/></defs><rect fill="url(#g)" width="8" height="8"/><use xlink:href="#g"/></svg>';

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'dc-logo-test-')); });
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe('logoBytes: the bytes decide the type', () => {
  it('a PNG and a JPEG are kept as they are', () => {
    expect(logoBytes(png()).ext).toBe('.png');
    expect(logoBytes(JPEG).ext).toBe('.jpg');
  });
  it('refuses anything else, an empty upload and an oversized one', () => {
    expect(() => logoBytes(Buffer.from('GIF89a......'))).toThrow(LogoError);
    expect(() => logoBytes(Buffer.from('#!/bin/sh\nrm -rf ~'))).toThrow(/PNG or JPG/);
    expect(() => logoBytes(Buffer.alloc(0))).toThrow(/No image/);
    expect(() => logoBytes(Buffer.concat([png(), Buffer.alloc(MAX_LOGO_BYTES)]))).toThrow(/5 MB/);
    // A .png name on garbage bytes is still garbage.
    expect(() => logoBytes(Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('nope')]))).toThrow(/cannot be read/);
  });
  it('SVG never reaches the server as SVG: the page draws it into a PNG first', () => {
    // Parsing or rendering an uploaded SVG here was broken three review rounds running
    // (escapes, mixed quotes, a decoy href): the bytes are refused, whatever they hold.
    expect(() => logoBytes(Buffer.from(SVG))).toThrow(LogoError);
    expect(() => logoBytes(Buffer.from('<svg><image href="/Users/me/red.png"/></svg>'))).toThrow(/PNG or JPG/);
  });
});

describe('stored beside the settings, read back only when it is safe', () => {
  it('set, replace in the other format, reset', () => {
    const p = setAppLogo(home, ID, png());
    expect(p).toBe(join(appLogoDir(home), `${ID}.png`));
    expect(appLogoPath(home, ID)).toBe(p);
    setAppLogo(home, ID, JPEG);
    expect(appLogoPath(home, ID)).toBe(join(appLogoDir(home), `${ID}.jpg`));
    expect(existsSync(p)).toBe(false);
    expect(clearAppLogo(home, ID)).toBe(true);
    expect(appLogoPath(home, ID)).toBeNull();
    expect(clearAppLogo(home, ID)).toBe(false);
  });
  it('a bad config id is never a path', () => {
    expect(() => setAppLogo(home, '../x', png())).toThrow(LogoError);
    expect(appLogoPath(home, '../../etc')).toBeNull();
    expect(appLogoPath(home, undefined)).toBeNull();
  });
  it('a symlinked logo, or a symlinked folder, is not read', () => {
    const outside = join(home, 'secret.png');
    writeFileSync(outside, png());
    mkdirSync(appLogoDir(home), { recursive: true });
    symlinkSync(outside, join(appLogoDir(home), `${ID}.png`));
    expect(appLogoPath(home, ID)).toBeNull();
    // Writing over it replaces the link, never writes through it.
    setAppLogo(home, ID, JPEG);
    expect(readFileSync(outside).equals(png())).toBe(true);
    rmSync(appLogoDir(home), { recursive: true, force: true });
    const elsewhere = join(home, 'elsewhere');
    mkdirSync(elsewhere);
    writeFileSync(join(elsewhere, `${ID}.png`), png());
    symlinkSync(elsewhere, appLogoDir(home));
    expect(appLogoPath(home, ID)).toBeNull();
    expect(() => setAppLogo(home, ID, png())).toThrow(/symlink/);
  });
});
