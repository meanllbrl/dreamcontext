/**
 * Stickers for the big moments only (plan goal 3): a binding goes live, hands-free starts, a long
 * job finishes, something broke.
 *
 * DEFERRED in W1 (noted on the task): the four 512 px static WEBP files have to be drawn from the
 * Sleepy mascot (the shipped `desktop/src-tauri/sleepy/*.webp` are 2.6 MB animations, over
 * Telegram's 512 KB static sticker limit). Until `assets/telegram/stickers/<moment>.webp` ships,
 * `stickerFor` returns null and the hub sends the moment's emoji line instead; nothing else changes.
 */
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type StickerMoment = 'bound' | 'handsfree' | 'done' | 'broke';
export const STICKER_MOMENTS: readonly StickerMoment[] = ['bound', 'handsfree', 'done', 'broke'];
/** The line sent while a moment has no sticker file. */
export const STICKER_FALLBACK: Record<StickerMoment, string> = {
  bound: '🌙 Bağlandık.',
  handsfree: '🌙 Hands-free açık.',
  done: '✅',
  broke: '⚠',
};
/** Telegram's static sticker limit. */
export const STICKER_MAX_BYTES = 512 * 1024;

/** `<package>/assets/telegram/stickers` (dist/lib/telegram → ../../../assets). */
export function stickerDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'assets', 'telegram', 'stickers');
}

/** The sticker's bytes, or null when the file is absent, not a plain file, or too big. */
export function stickerFor(moment: StickerMoment, dir: string = stickerDir()): Buffer | null {
  let fd: number;
  try { fd = openSync(join(dir, `${moment}.webp`), constants.O_RDONLY | constants.O_NOFOLLOW); } catch { return null; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size === 0 || st.size > STICKER_MAX_BYTES) return null;
    const buf = readFileSync(fd);
    return buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP' ? buf : null;
  } finally {
    closeSync(fd);
  }
}
