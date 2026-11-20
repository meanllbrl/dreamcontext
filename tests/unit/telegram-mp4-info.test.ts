import { describe, it, expect } from 'vitest';
import { mp4VideoParams } from '../../src/lib/telegram/mp4-info.js';
import { sendMedia, sendAlbum } from '../../src/server/telegram/pictures.js';

function box(type: string, ...body: Buffer[]): Buffer {
  const data = Buffer.concat(body);
  const h = Buffer.alloc(8);
  h.writeUInt32BE(8 + data.length, 0);
  h.write(type, 4, 'latin1');
  return Buffer.concat([h, data]);
}
function mvhd(scale: number, dur: number): Buffer {
  const b = Buffer.alloc(100);
  b.writeUInt32BE(scale, 12);
  b.writeUInt32BE(dur, 16);
  return box('mvhd', b);
}
function tkhd(w: number, h: number, rotate = false): Buffer {
  const b = Buffer.alloc(84);
  const m = 4 + 20 + 16;
  if (rotate) { b.writeInt32BE(0, m); b.writeInt32BE(0x10000, m + 4); b.writeInt32BE(-0x10000, m + 12); b.writeInt32BE(0, m + 16); }
  else { b.writeInt32BE(0x10000, m); b.writeInt32BE(0x10000, m + 16); }
  b.writeUInt32BE(w * 65536, m + 36);
  b.writeUInt32BE(h * 65536, m + 40);
  return box('tkhd', b);
}
const mp4 = (w: number, h: number, rotate = false) =>
  Buffer.concat([box('ftyp', Buffer.from('isom0000')), box('moov', mvhd(1000, 12_400), box('trak', tkhd(0, 0)), box('trak', tkhd(w, h, rotate)))]);

describe('mp4VideoParams', () => {
  it('landscape 1920x1080', () => {
    expect(mp4VideoParams(mp4(1920, 1080))).toEqual({ width: 1920, height: 1080, duration: 12, supports_streaming: true });
  });
  it('portrait 1080x1920', () => {
    expect(mp4VideoParams(mp4(1080, 1920))).toEqual({ width: 1080, height: 1920, duration: 12, supports_streaming: true });
  });
  it('a 90 degree matrix swaps width and height', () => {
    const p = mp4VideoParams(mp4(1920, 1080, true));
    expect([p.width, p.height]).toEqual([1080, 1920]);
  });
  it('an unreadable file gives no fields', () => {
    expect(mp4VideoParams(Buffer.from('not a video at all'))).toEqual({});
    expect(mp4VideoParams(mp4(1920, 1080).subarray(0, 60))).toEqual({});
  });
});

describe('video sends carry the params', () => {
  const file = { name: 'a.mp4', data: mp4(1920, 1080) };
  const make = () => {
    const calls: { method: string; params: Record<string, unknown> }[] = [];
    const ab = { binding: { chatId: 1 }, transport: { upload: async (method: string, params: Record<string, unknown>) => { calls.push({ method, params }); return { message_id: 5 }; } } } as never;
    return { ab, calls };
  };
  it('sendMedia', async () => {
    const { ab, calls } = make();
    await sendMedia(ab, { kind: 'video', file, title: 'v' } as never);
    expect(calls[0].params).toMatchObject({ width: 1920, height: 1080, duration: 12, supports_streaming: true });
  });
  it('sendAlbum video entries only', async () => {
    const { ab, calls } = make();
    await sendAlbum(ab, [{ kind: 'video', file, title: 'v' }, { kind: 'photo', file: { name: 'p.png', data: Buffer.from('x') }, title: 'p' }] as never);
    const media = calls[0].params.media as Record<string, unknown>[];
    expect(media[0]).toMatchObject({ type: 'video', width: 1920, height: 1080, supports_streaming: true });
    expect(media[1].width).toBeUndefined();
  });
});
