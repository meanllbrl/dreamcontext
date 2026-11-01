/** TABLO row 12: a picture the owner sends reaches the tool as an image, not only as a path. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pictureAttachments, picturePaths } from '../../../src/lib/t3-bridge/pictures.js';

let root = '';
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe('pictures on the bridge', () => {
  it('reads the composer lines, quoted or not, relative to the project', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-pic-'));
    mkdirSync(join(root, 'tmp'));
    writeFileSync(join(root, 'tmp', 'a.png'), 'png');
    writeFileSync(join(root, "it's.jpg"), 'jpg');
    writeFileSync(join(root, 'notes.txt'), 'text');
    const text = `[Picture 1: tmp/a.png]\nthe lid\n[Picture 2: '${join(root, "it'\\''s.jpg")}']\nand\n[Picture 3: notes.txt]\n[Picture 4: missing.png]`;
    expect(picturePaths(text, root)).toEqual([join(root, 'tmp', 'a.png'), join(root, "it's.jpg")]);
  });

  it('copies each into the attachment folder and names it as an image', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-pic-'));
    writeFileSync(join(root, 'a.jpeg'), 'jpg');
    const dir = join(root, 'att');
    const [a] = pictureAttachments('[Picture 1: a.jpeg]', root, dir);
    expect(a).toMatchObject({ type: 'image', mimeType: 'image/jpeg', sizeBytes: 3, name: 'a.jpeg' });
    expect(a!.id).toMatch(/^dc-pic-[0-9a-f]{32}$/);
    expect(existsSync(join(dir, `${a!.id}.jpg`))).toBe(true);
  });

  it('a link or a folder named like a picture is not a picture', () => {
    root = mkdtempSync(join(tmpdir(), 'dc-pic-'));
    writeFileSync(join(root, 'real.png'), 'png');
    symlinkSync(join(root, 'real.png'), join(root, 'link.png'));
    mkdirSync(join(root, 'dir.png'));
    expect(picturePaths('[Picture 1: link.png]\n[Picture 2: dir.png]', root)).toEqual([]);
  });
});
