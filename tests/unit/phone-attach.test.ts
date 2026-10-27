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
  it('takes the photo types a phone decodes, including the iPhone\'s HEIC', () => {
    for (const t of ['image/jpeg', 'image/jpg', 'image/png', 'image/heic', 'image/heif', 'image/webp', 'image/gif', 'image/avif']) expect(isPhonePhoto({ type: t }), t).toBe(true);
  });
  it('sends everything else as a file, including image types a browser cannot decode', () => {
    for (const t of ['application/zip', 'application/pdf', 'text/plain', 'video/mp4', 'image/svg+xml', 'image/vnd.adobe.photoshop', 'image/x-adobe-dng', 'image/tiff', '']) expect(isPhonePhoto({ type: t }), t).toBe(false);
  });
});

describe('splitPhonePicks', () => {
  const routes = (p: ReturnType<typeof splitPhonePicks<ReturnType<typeof f>>>) => p.picks.map((x) => `${x.file.name}:${x.route}`);
  it('routes a mixed pick, keeping the pick order', () => {
    const out = splitPhonePicks([f('a.zip', 'application/zip'), f('p.jpg', 'image/jpeg'), f('r.pdf', 'application/pdf'), f('d.psd', 'image/vnd.adobe.photoshop')], 6);
    expect(routes(out)).toEqual(['a.zip:file', 'p.jpg:photo', 'r.pdf:file', 'd.psd:file']);
    expect(out.overCap).toBe(false);
  });
  it('refuses a file over the cap or an empty one before upload, never a photo (the phone shrinks it)', () => {
    const out = splitPhonePicks([f('big.zip', 'application/zip', PHONE_MAX_FILE_BYTES + 1), f('huge.heic', 'image/heic', 40e6), f('e.txt', 'text/plain', 0), f('max.zip', 'application/zip', PHONE_MAX_FILE_BYTES)], 6);
    expect(routes(out)).toEqual(['big.zip:too-large', 'huge.heic:photo', 'e.txt:empty', 'max.zip:file']);
  });
  it('keeps at most the room left and says some were dropped', () => {
    const out = splitPhonePicks([f('a', 'text/plain'), f('b', 'text/plain'), f('c', 'text/plain')], 2);
    expect(routes(out)).toEqual(['a:file', 'b:file']);
    expect(out.overCap).toBe(true);
    expect(splitPhonePicks([f('a', 'text/plain')], -1).picks).toEqual([]);
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
