/**
 * The server twin of the chat card's `loneMedia` (preview-media.ts): a preview that is only one
 * project picture or clip. Same rule as the card, pinned by its source and by cases.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isLocalImageRef, loneMedia } from '../../src/lib/telegram/preview-media.js';

const body = (src: string, name: string): string => {
  const at = src.indexOf(`export function ${name}(`);
  const end = src.indexOf('\n}\n', at);
  return src.slice(at, end).replace(/\s+/g, ' ');
};

describe('loneMedia (server twin)', () => {
  it('matches the chat card\'s own functions', () => {
    const card = readFileSync(join(__dirname, '../../dashboard/src/components/sleepy/chat/previewImages.ts'), 'utf8');
    const ours = readFileSync(join(__dirname, '../../src/lib/telegram/preview-media.ts'), 'utf8');
    for (const fn of ['loneMedia', 'isLocalImageRef']) expect(body(ours, fn)).toBe(body(card, fn));
  });

  it('one project picture or clip, nothing else', () => {
    expect(loneMedia('<img src="_dream_context/tmp/super/a.png">')).toEqual({ kind: 'image', src: '_dream_context/tmp/super/a.png' });
    expect(loneMedia(' <video src=\'tmp/a.mp4\'></video> ')).toEqual({ kind: 'video', src: 'tmp/a.mp4' });
    expect(loneMedia('<div><img src="a.png"></div>')).toBeNull();
    expect(loneMedia('<img src="a.png"><p>x</p>')).toBeNull();
    expect(loneMedia('<img src="https://x.test/a.png">')).toBeNull();
    expect(loneMedia('<img src="data:image/png;base64,AA">')).toBeNull();
    expect(loneMedia(undefined)).toBeNull();
    expect(isLocalImageRef('/api/agent/file?p=a')).toBe(false);
  });
});
