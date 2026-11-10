import { describe, expect, it } from 'vitest';
import { imageSize, isTall, numberedCaption, pictureListMessages, sendPictures, type MediaItem } from '../../src/server/telegram/pictures.js';
import type { ActiveBinding } from '../../src/server/telegram/hub.js';

/** A real PNG header (signature + IHDR) of the given size. */
function png(w: number, h: number): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(64, 1)]);
}
const photo = (title: string, w = 800, h = 1200): MediaItem => ({ kind: 'photo', file: { name: 'a.png', data: png(w, h), contentType: 'image/png' }, title });

interface Call { method: string; params: Record<string, unknown>; files?: Record<string, unknown> }
function fakeBinding(fail: string[] = []): { ab: ActiveBinding; calls: Call[] } {
  const calls: Call[] = [];
  const transport = {
    async upload(method: string, params: Record<string, unknown>, files: Record<string, unknown>) {
      calls.push({ method, params, files });
      if (fail.includes(method)) throw new Error('400');
      return method === 'sendMediaGroup' ? [{ message_id: 1 }] : { message_id: calls.length };
    },
    async sendMessage(_chat: number, text: string, extra: Record<string, unknown> = {}) {
      calls.push({ method: 'sendMessage', params: { text, ...extra } });
      if (fail.includes('sendMessage')) throw new Error('400');
      return { message_id: calls.length, text };
    },
  };
  return { ab: { binding: { chatId: 42 }, transport } as unknown as ActiveBinding, calls };
}

// The owner's case (10 Nov, kitup): six stage pictures with long Turkish names.
const SIX = [
  'Headway upsell 1: infografik 19,99',
  'Headway upsell 2: workbook 9,99',
  'Liven upsell 1: AI arkadaş 49,99',
  'Liven upsell 1 indirimi: 39,99',
  'Liven upsell 2: paket 49,99',
  'Liven upsell 3: ömür boyu 29,99',
];

describe('a named group of pictures (stage, a question\'s drawings)', () => {
  it('every picture carries "N · name" as its own caption and a numbered list follows in album order', async () => {
    const { ab, calls } = fakeBinding();
    const { sent, unsent } = await sendPictures(ab, SIX.map((t) => photo(t)), { heading: (n) => `Sahnede ${n} resim:` });
    expect(sent).toHaveLength(6);
    expect(unsent).toHaveLength(0);
    const album = calls.find((c) => c.method === 'sendMediaGroup')!;
    const media = album.params.media as { caption?: string }[];
    expect(media.map((m) => m.caption)).toEqual(SIX.map((t, i) => `${i + 1} · ${t}`));
    const list = calls.filter((c) => c.method === 'sendMessage').map((c) => String(c.params.text));
    expect(list).toEqual([['<b>Sahnede 6 resim:</b>', ...SIX.map((t, i) => `${i + 1}. ${t}`)].join('\n')]);
    // Never the old run-on line.
    expect(list[0]).not.toContain(' · ');
  });

  it('a picture taller than 1:2 leaves the grid and goes whole on its own, numbered after the album', async () => {
    const { ab, calls } = fakeBinding();
    const items = [photo('Uzun ekran', 1170, 5000), photo('Kart A'), photo('Kart B')];
    expect(isTall(items[0])).toBe(true);
    await sendPictures(ab, items, { heading: (n) => `Sahnede ${n} resim:` });
    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendPhoto', 'sendMessage']);
    expect((calls[0].params.media as { caption?: string }[]).map((m) => m.caption)).toEqual(['1 · Kart A', '2 · Kart B']);
    expect(calls[1].params.caption).toBe('3 · Uzun ekran');
    expect(calls[2].params.text).toBe('<b>Sahnede 3 resim:</b>\n1. Kart A\n2. Kart B\n3. Uzun ekran');
  });

  it('a picture beyond Telegram\'s photo dimensions goes as a document so it stays whole', async () => {
    const { ab, calls } = fakeBinding();
    await sendPictures(ab, [photo('Çok uzun', 600, 9800), photo('Kart')], { heading: (n) => `${n} çizim:` });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendDocument', 'sendMessage']);
    expect(calls[1].params.caption).toBe('2 · Çok uzun');
  });

  it('a picture beyond the photo limits that is NOT tall (a panorama, a banner) leaves the album too, so it cannot sink it', async () => {
    const { ab, calls } = fakeBinding();
    const r = await sendPictures(ab, [photo('A'), photo('Panorama', 16000, 3000), photo('B'), photo('Afiş', 4000, 150)], { heading: (n) => `Sahnede ${n} resim:` });
    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendDocument', 'sendDocument', 'sendMessage']);
    expect((calls[0].params.media as { caption?: string }[]).map((m) => m.caption)).toEqual(['1 · A', '2 · B']);
    expect([calls[1].params.caption, calls[2].params.caption]).toEqual(['3 · Panorama', '4 · Afiş']);
    expect(r.unsent).toHaveLength(0);
    // The only ordinary picture next to an over-limit one: a photo; the over-limit one a document.
    const one = fakeBinding();
    await sendPictures(one.ab, [photo('Panorama', 16000, 3000), photo('A')], { heading: (n) => `${n} resim:` });
    expect(one.calls.map((c) => c.method)).toEqual(['sendPhoto', 'sendDocument', 'sendMessage']);
  });

  it('a 12 MB camera photo beyond the photo dimensions still goes, as a document', async () => {
    const big: MediaItem = { kind: 'photo', title: 'Kamera', file: { name: 'k.jpg', data: Buffer.concat([png(6240, 4160), Buffer.alloc(12 * 1024 * 1024)]), contentType: 'image/png' } };
    const { ab, calls } = fakeBinding();
    const r = await sendPictures(ab, [big, photo('A'), photo('B')], { heading: (n) => `${n} resim:` });
    expect(r.unsent).toHaveLength(0);
    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup', 'sendDocument', 'sendMessage']);
  });

  it('the list goes silently, and says when it did not go', async () => {
    const ok = fakeBinding();
    const r = await sendPictures(ok.ab, [photo('A'), photo('B')], { heading: (n) => `${n} resim:` });
    expect(ok.calls.at(-1)!.params.disable_notification).toBe(true);
    expect(r.listed).toBe(true);
    const bad = fakeBinding(['sendMessage']);
    expect((await sendPictures(bad.ab, [photo('A'), photo('B')], { heading: (n) => `${n} resim:` })).listed).toBe(false);
  });

  it('a failed album leaves its pictures unsent and lists only what went', async () => {
    const { ab, calls } = fakeBinding(['sendMediaGroup']);
    const r = await sendPictures(ab, [photo('A'), photo('B'), photo('Uzun', 500, 3000)], { heading: (n) => `Sahnede ${n} resim:` });
    expect(r.sent.map((m) => m.title)).toEqual(['Uzun']);
    expect(r.unsent.map((m) => m.title)).toEqual(['A', 'B']);
    expect(calls.at(-1)!.params.text).toBe('<b>Sahnede 1 resim:</b>\n3. Uzun');
  });

  it('one named picture: its name is its caption, no number, no list', async () => {
    const { ab, calls } = fakeBinding();
    await sendPictures(ab, [photo('Tek kart')], { heading: (n) => `Sahnede ${n} resim:` });
    expect(calls.map((c) => c.method)).toEqual(['sendPhoto']);
    expect(calls[0].params.caption).toBe('Tek kart');
  });

  it('slices of one card (no names) still go as a plain album with no captions', async () => {
    const { ab, calls } = fakeBinding();
    await sendPictures(ab, [photo('kart'), photo('kart')]);
    expect(calls.map((c) => c.method)).toEqual(['sendMediaGroup']);
    expect((calls[0].params.media as { caption?: string }[]).every((m) => m.caption === undefined)).toBe(true);
  });
});

describe('the shared picture text', () => {
  it('escapes, keeps Turkish, and clips a name to one line', () => {
    expect(numberedCaption(2, 'Çağrı <öneri> & şimşek\nikinci satır')).toBe('2 · Çağrı &lt;öneri&gt; &amp; şimşek ikinci satır');
  });

  it('a secret in a long name is redacted before the name is cut', () => {
    const name = `${'a'.repeat(190)} sk-ant-api03-${'B'.repeat(40)}`;
    expect(numberedCaption(1, name)).not.toContain('sk-ant');
    expect(pictureListMessages('Liste:', [{ n: 1, title: name }]).join('')).not.toContain('sk-ant');
  });

  it('splits a long list into messages of whole lines, the footer last', () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ n: i + 1, title: `Ürün ${i + 1} ${'ş'.repeat(30)}` }));
    const parts = pictureListMessages('Sahnede 10 resim:', rows, ['Ve 2 kart daha.'], 200);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(200);
    const lines = parts.join('\n').split('\n');
    expect(lines).toEqual(['<b>Sahnede 10 resim:</b>', ...rows.map((r) => `${r.n}. ${r.title}`), 'Ve 2 kart daha.']);
  });

  it('reads a PNG and a JPEG size, and refuses a header that is not one', () => {
    expect(imageSize(png(1170, 2532))).toEqual({ w: 1170, h: 2532 });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x09, 0xc4, 0x04, 0x92, 0x03, 0, 0, 0, 0]);
    expect(imageSize(jpeg)).toEqual({ w: 1170, h: 2500 });
    const fake = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(80, 7)]);
    expect(imageSize(fake)).toBeNull();
  });
});
