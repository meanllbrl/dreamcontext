import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { contrastWithWhite, iconColor, iconIssue, iconLetter, isDefaultIcon, renderDefaultIcon, servableIcon } from '../../src/lib/apps/icon.js';

const LOGO = resolve('assets/notify-icon.icns');
const dirs: string[] = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'dc-apps-icon-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

/** Decode what a real PNG reader would: signature, chunks, pixel layout. */
function decode(png: Buffer): { width: number; height: number; pixel: (x: number, y: number) => number[] } {
  expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  const chunks: Record<string, Buffer> = {};
  for (let at = 8; at < png.length;) {
    const len = png.readUInt32BE(at);
    chunks[png.toString('latin1', at + 4, at + 8)] = png.subarray(at + 8, at + 8 + len);
    at += 12 + len;
  }
  expect(Object.keys(chunks)).toEqual(['IHDR', 'IDAT', 'IEND']);
  const width = chunks.IHDR.readUInt32BE(0);
  const height = chunks.IHDR.readUInt32BE(4);
  expect([chunks.IHDR[8], chunks.IHDR[9]]).toEqual([8, 6]);
  const raw = inflateSync(chunks.IDAT);
  const row = 1 + width * 4;
  expect(raw.length).toBe(row * height);
  return { width, height, pixel: (x, y) => Array.from(raw.subarray(y * row + 1 + x * 4, y * row + 1 + x * 4 + 4)) };
}

describe('the default icon', () => {
  it('is a valid 1024 PNG: transparent corners, the slug colour on the tile, a white letter', () => {
    const { width, height, pixel } = decode(renderDefaultIcon('yuk-izleme', 'Yük İzleme'));
    expect([width, height]).toEqual([1024, 1024]);
    expect(pixel(0, 0)[3]).toBe(0);
    const tile = pixel(150, 512);
    expect(tile[3]).toBe(255);
    expect(tile.slice(0, 3)).not.toEqual([255, 255, 255]);
    let white = 0;
    for (let y = 300; y < 724; y += 8) for (let x = 300; x < 724; x += 8) if (pixel(x, y).slice(0, 3).every((c) => c === 255)) white++;
    expect(white).toBeGreaterThan(100);
  });

  it('gives one slug one colour, and the same bytes every time', () => {
    expect(iconColor('meta-ads')).toEqual(iconColor('meta-ads'));
    expect(iconColor('meta-ads')).not.toEqual(iconColor('meta-adz'));
    expect(renderDefaultIcon('meta-ads', 'Meta Ads').equals(renderDefaultIcon('meta-ads', 'Meta Ads'))).toBe(true);
    // A rename changes the letter, never the colour.
    expect(decode(renderDefaultIcon('meta-ads', 'Zed')).pixel(150, 512)).toEqual(decode(renderDefaultIcon('meta-ads', 'Meta Ads')).pixel(150, 512));
  });

  it('spreads slugs over colours and keeps every one readable under the white letter', () => {
    const colours = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const c = iconColor(`app-${i}`);
      colours.add(c.join());
      expect(contrastWithWhite(c)).toBeGreaterThanOrEqual(3.5);
    }
    expect(colours.size).toBeGreaterThan(150);
  });

  it('draws the first letter of the name, Turkish marks included, else the slug', () => {
    expect(iconLetter('Yük İzleme', 'yuk-izleme')).toBe('Y');
    expect(iconLetter('Şube Raporu', 'sube')).toBe('Ş');
    expect(iconLetter('Öğrenci', 'x')).toBe('Ö');
    expect(iconLetter('İzin', 'x')).toBe('İ');
    expect(iconLetter('3D Studio', 'x')).toBe('D');
    expect(iconLetter('広告', 'reklam')).toBe('R');
    for (const name of ['Ş', 'Ğ', 'Ç', 'Ü', 'İ', 'Q', 'G', 'S']) expect(decode(renderDefaultIcon('a', name)).width).toBe(1024);
  });

  it('knows when nobody replaced it', () => {
    const f = join(tmp(), 'icon.png');
    writeFileSync(f, renderDefaultIcon('a', 'A'));
    expect(isDefaultIcon(f, 'a', 'A')).toBe(true);
    writeFileSync(f, 'mine');
    expect(isDefaultIcon(f, 'a', 'A')).toBe(false);
    expect(isDefaultIcon(null, 'a', 'A')).toBe(false);
  });
});

describe('what an icon can do', () => {
  it('serves PNG and JPEG only', () => {
    expect(servableIcon('/a/icon.png')).toBe('/a/icon.png');
    expect(servableIcon('/a/icon.JPG')).toBe('/a/icon.JPG');
    expect(servableIcon('/a/icon.icns')).toBeNull();
    expect(servableIcon(null)).toBeNull();
  });

  it('names the logo, an icon the card cannot show, and leaves a real icon alone', () => {
    expect(iconIssue(LOGO, LOGO)?.code).toBe('dreamcontext_logo');
    const dir = tmp();
    const own = join(dir, 'own.icns');
    writeFileSync(own, 'own-icns');
    expect(iconIssue(own, LOGO)?.code).toBe('not_servable');
    const png = join(dir, 'icon.png');
    writeFileSync(png, 'png');
    expect(iconIssue(png, LOGO)).toBeNull();
    expect(iconIssue(null, LOGO)).toBeNull();
    // A logo renamed to .png is still the logo.
    const renamed = join(dir, 'logo.png');
    writeFileSync(renamed, readFileSync(LOGO));
    expect(iconIssue(renamed, LOGO)?.code).toBe('dreamcontext_logo');
  });
});
