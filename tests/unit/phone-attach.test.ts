/**
 * What the hands-free phone does with each pick from its attach sheet (dashboard
 * lib/phoneAttach.ts, owner 2026-10-27 "zip ve dosya da yükleyebilelim"): a raster photo goes the
 * photo path, anything else (zip, PDF, text, SVG, video) goes as a file, a file over the Mac's
 * cap is refused before upload, and the composer's file input no longer narrows the sheet.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { PHONE_MAX_FILE_BYTES, formatFileSize, isPhonePhoto, splitPhonePicks } from '../../dashboard/src/lib/phoneAttach.js';
import { PHONE_MAX_FILE_BYTES as SERVER_MAX_FILE_BYTES } from '../../src/lib/handsfree/mac/photo-limits.js';

const f = (name: string, type: string, size = 100) => ({ name, type, size });

describe('isPhonePhoto', () => {
  it('takes raster images, including the iPhone\'s HEIC', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/heic', 'image/webp']) expect(isPhonePhoto({ type: t }), t).toBe(true);
  });
  it('sends everything else as a file', () => {
    for (const t of ['application/zip', 'application/pdf', 'text/plain', 'video/mp4', 'image/svg+xml', '']) expect(isPhonePhoto({ type: t }), t).toBe(false);
  });
});

describe('splitPhonePicks', () => {
  it('splits a mixed pick into photos and files, in order', () => {
    const picks = [f('a.zip', 'application/zip'), f('p.jpg', 'image/jpeg'), f('r.pdf', 'application/pdf'), f('n.txt', 'text/plain')];
    const out = splitPhonePicks(picks, 6);
    expect(out.photos.map((x) => x.name)).toEqual(['p.jpg']);
    expect(out.files.map((x) => x.name)).toEqual(['a.zip', 'r.pdf', 'n.txt']);
    expect(out.tooLarge).toEqual([]);
    expect(out.overCap).toBe(false);
  });
  it('refuses a file over the cap before upload, but never a photo (the phone shrinks it)', () => {
    const out = splitPhonePicks([f('big.zip', 'application/zip', PHONE_MAX_FILE_BYTES + 1), f('huge.heic', 'image/heic', 40e6)], 6);
    expect(out.tooLarge.map((x) => x.name)).toEqual(['big.zip']);
    expect(out.photos.map((x) => x.name)).toEqual(['huge.heic']);
  });
  it('keeps at most the room left and says some were dropped', () => {
    const out = splitPhonePicks([f('a', 'text/plain'), f('b', 'text/plain'), f('c', 'text/plain')], 2);
    expect(out.files.map((x) => x.name)).toEqual(['a', 'b']);
    expect(out.overCap).toBe(true);
    expect(splitPhonePicks([f('a', 'text/plain')], -1).files).toEqual([]);
  });
});

describe('formatFileSize', () => {
  it('reads like a chip', () => {
    expect(formatFileSize(812)).toBe('812 B');
    expect(formatFileSize(14 * 1024)).toBe('14 KB');
    expect(formatFileSize(3.4 * 1024 * 1024)).toBe('3.4 MB');
    expect(formatFileSize(24 * 1024 * 1024)).toBe('24 MB');
  });
});

describe('the mirror and the input', () => {
  it('the dashboard\'s file cap is the server\'s', () => {
    expect(PHONE_MAX_FILE_BYTES).toBe(SERVER_MAX_FILE_BYTES);
  });
  it('the phone\'s file input does not narrow the sheet to images', () => {
    const src = readFileSync(new URL('../../dashboard/src/components/sleepy/chat/Composer.tsx', import.meta.url), 'utf-8');
    const input = /<input[\s\S]*?data-testid="phone-photo-input"[\s\S]*?\/>/.exec(src)?.[0] ?? '';
    expect(input).toContain('type="file"');
    expect(input).not.toMatch(/\baccept=/);
  });
});
