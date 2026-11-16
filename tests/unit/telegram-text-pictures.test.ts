/**
 * Owner 2026-11-13 ("fotoğrafları görmüyorum" → "telegramdan attıklarını"): every picture the
 * Super shows him reaches his phone while he is on Telegram, from the project, a child's
 * worktree or the temp folder, and one that cannot go says which and why. Proven end to end
 * against a fake Bot API server through the real transport (multipart uploads, no real Telegram).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { imageName, markdownImages, markdownToTelegramHtml, toTelegramMessages } from '../../src/lib/telegram/format.js';
import { classifyOutbound, mediaMagicOk, readOutbound } from '../../src/lib/telegram/files.js';
import { TelegramTransport } from '../../src/lib/telegram/transport.js';
import { sendAnswerBlocks } from '../../src/server/telegram/blocks.js';
import { cardOut, type CardContext } from '../../src/server/telegram/cards.js';
import { superMediaRoots } from '../../src/server/telegram/media-roots.js';
import type { SuperContainer } from '../../src/lib/super/types.js';
import { renderScene } from '../../src/lib/whiteboards/render.js';
import { uploadTiming } from '../../src/server/telegram/pictures.js';

/** A real PNG header (signature + IHDR) of the given size. */
function png(w = 800, h = 600): Buffer {
  const head = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(head, 0);
  head.writeUInt32BE(13, 8);
  head.write('IHDR', 12, 'latin1');
  head.writeUInt32BE(w, 16);
  head.writeUInt32BE(h, 20);
  return Buffer.concat([head, Buffer.alloc(64)]);
}

let base: string;
let project: string;
let ctxRoot: string;
let shots: string;
let worktree: string;
let outside: string;
const put = (p: string, data: Buffer | string): string => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, data); return p; };

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tg-text-pics-')));
  project = join(base, 'brain');
  ctxRoot = join(project, '_dream_context');
  shots = join(base, 'tmp-shots');
  worktree = join(base, 'worktrees', 'code-child');
  outside = join(base, 'elsewhere');
  for (const d of [ctxRoot, shots, worktree, outside]) mkdirSync(d, { recursive: true });
});
afterEach(() => { rmSync(base, { recursive: true, force: true }); });

describe('markdown pictures in a Telegram text', () => {
  it('finds local and web pictures, never inside a code span or a fence', () => {
    const md = [
      'Bitti. ![başarısız run](/tmp/rk2-shots/light-03.png)',
      '- ![Klasörler](<_dream_context/tmp/a b.png>)',
      '`![kod](x.png)`',
      '```',
      '![fence](y.png)',
      '```',
      '![web](https://example.com/p.png)',
      '![...](file:///tmp/z%20q.png "title")',
    ].join('\n');
    expect(markdownImages(md)).toEqual([
      { alt: 'başarısız run', src: '/tmp/rk2-shots/light-03.png', web: false },
      { alt: 'Klasörler', src: '_dream_context/tmp/a b.png', web: false },
      { alt: 'web', src: 'https://example.com/p.png', web: true },
      { alt: '...', src: '/tmp/z q.png', web: false },
    ]);
    expect(imageName({ alt: '...', src: '/tmp/z q.png' })).toBe('z q.png');
  });

  it("hub mode: a local picture leaves the text (the hub sends it), a web one is a link; never raw '![…](…)'", () => {
    const html = markdownToTelegramHtml('Kanıt:\n- ![başarısız run](/tmp/a.png)\nBak ![w](https://example.com/p.png) burada\n`![kod](x.png)`', { blocks: 'hub' });
    expect(html).not.toContain('![başarısız');
    expect(html).not.toContain('/tmp/a.png');
    expect(html).not.toMatch(/^• ?$/m);
    expect(html).toContain('<a href="https://example.com/p.png">w</a>');
    expect(html).toContain('<code>![kod](x.png)</code>');
  });

  it('a path with parentheses is one path; a message holding only a quoted picture is not sent empty', () => {
    expect(markdownImages('![a](/tmp/shot(1).png) sonra')).toEqual([{ alt: 'a', src: '/tmp/shot(1).png', web: false }]);
    expect(markdownToTelegramHtml('![a](/tmp/shot(1).png) sonra', { blocks: 'hub' })).toBe('sonra');
    expect(toTelegramMessages('> ![a](/tmp/a.png)', { blocks: 'hub' })).toEqual([]);
    expect(toTelegramMessages('~~![a](/tmp/a.png)~~', { blocks: 'hub' })).toEqual([]);
    // Markup of the words around a picture stays as written.
    expect(markdownToTelegramHtml('**Önce** ![a](/tmp/a.png) **Sonra**', { blocks: 'hub' })).toBe('<b>Önce</b> <b>Sonra</b>');
    expect(markdownToTelegramHtml('~~eski~~ ![a](/tmp/a.png) ~~yeni~~', { blocks: 'hub' })).toBe('<s>eski</s> <s>yeni</s>');
    // Markup left around a removed picture never opens a fence that eats what follows.
    expect(markdownToTelegramHtml('~~![a](/tmp/a.png)~~\nikinci satır\n## ![b](/tmp/b.png)\n**![c](/tmp/c.png)** son', { blocks: 'hub' })).toBe('ikinci satır\nson');
  });

  it("mac mode: a local picture is one named line, never the raw markdown", () => {
    const html = markdownToTelegramHtml('![başarısız run](/tmp/a.png)');
    expect(html).toBe("Resim: başarısız run (Mac'te)");
  });
});

describe('media-only roots (a child worktree, a linked repo, the temp folder)', () => {
  const opts = () => ({ roots: [project], projectRoot: project, mediaRoots: [worktree, shots], isGitIgnored: () => true });

  it('a real picture under a media root leaves, even git-ignored', () => {
    const p = put(join(worktree, 'tmp', 'shot.png'), png());
    const r = readOutbound(p, opts());
    expect(r.ok).toBe(true);
  });

  it('a non-media file under a media root stays (outside_root), and so does a fake picture (not_media)', () => {
    expect(classifyOutbound(put(join(worktree, 'src', 'a.ts'), 'x'), opts())).toEqual({ ok: false, reason: 'not_media' });
    expect(readOutbound(put(join(shots, 'fake.png'), 'OPENAI_KEY=sk-123'), opts())).toEqual({ ok: false, reason: 'not_media' });
  });

  it('the secret class and .git still refuse under a media root', () => {
    expect(classifyOutbound(put(join(worktree, '.git', 'x.png'), png()), opts())).toEqual({ ok: false, reason: 'git_dir' });
    expect(classifyOutbound(put(join(worktree, '.ssh', 'k.png'), png()), opts())).toEqual({ ok: false, reason: 'secret_class' });
  });

  it('a picture outside every root is still refused', () => {
    expect(classifyOutbound(put(join(outside, 'b.png'), png()), opts())).toEqual({ ok: false, reason: 'outside_root' });
  });

  it('magic bytes per kind', () => {
    expect(mediaMagicOk('a.png', png())).toBe(true);
    expect(mediaMagicOk('a.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe(true);
    expect(mediaMagicOk('a.pdf', Buffer.from('%PDF-1.4'))).toBe(true);
    expect(mediaMagicOk('a.mp4', Buffer.from('\0\0\0\x18ftypmp42', 'latin1'))).toBe(true);
    expect(mediaMagicOk('a.png', Buffer.from('not a png at all'))).toBe(false);
  });

  it("superMediaRoots: the project's git worktrees and the OS temp folder, never / or the home folder", async () => {
    execFileSync('git', ['init', '-q', project]);
    execFileSync('git', ['-C', project, '-c', 'user.email=a@b.c', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'i']);
    const child = join(base, 'brain-child');
    execFileSync('git', ['-C', project, 'worktree', 'add', '-q', child]);
    const roots = await superMediaRoots(ctxRoot, base);
    expect(roots).toContain(realpathSync(child));
    expect(roots).toContain(realpathSync(tmpdir()));
    expect(roots).toContain(realpathSync('/tmp'));
    expect(roots).not.toContain('/');
    expect(roots).not.toContain(base);
  });

  it('a stage image card from a child worktree goes as a picture; one from elsewhere says why', async () => {
    const shot = put(join(worktree, 'tmp', 'sonra.png'), png());
    const far = put(join(outside, 'x.png'), png());
    const ctx: CardContext = { contextRoot: ctxRoot, sessionId: 's', pictures: true, snapshot: async () => null, isGitIgnored: () => true, mediaRoots: [worktree] };
    const card = (ref: string): SuperContainer => ({ id: 'image-1', kind: 'image', ref, shape: 'square', place: 'main', title: 'Sonra' } as SuperContainer);
    const a = await cardOut(ctx, card(shot));
    expect(a.kind).toBe('media');
    const b = await cardOut(ctx, card(far));
    expect(b).toMatchObject({ kind: 'text' });
    expect((b as { line: string }).line).toMatch(/gönderilmedi: proje klasörünün dışında/);
  });
});

// ─── End to end: a fake Bot API server, the real transport ─────────────────

interface Hit { method: string; body: string; files: string[] }

async function fakeBot(): Promise<{ server: Server; url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  let id = 100;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('latin1');
      const method = (req.url ?? '').split('/').pop() ?? '';
      const files = [...body.matchAll(/filename="([^"]+)"/g)].map((m) => Buffer.from(m[1], 'latin1').toString('utf8'));
      hits.push({ method, body: Buffer.concat(chunks).toString('utf8'), files });
      res.setHeader('content-type', 'application/json');
      const result = method === 'sendMediaGroup' ? [{ message_id: ++id }, { message_id: ++id }] : { message_id: ++id, text: '' };
      res.end(JSON.stringify({ ok: true, result }));
    });
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, hits };
}

describe('end to end: the Super answer with pictures reaches the fake bot', () => {
  it("sends the text without raw markdown, the pictures as one album, and one line per picture that did not go", async () => {
    const bot = await fakeBot();
    try {
      put(join(shots, 'light-03-run-failed-collapsed.png'), png());
      put(join(ctxRoot, 'tmp', 'super', 'klasor.png'), png());
      put(join(worktree, 'tmp', 'cocuk.png'), png());
      put(join(outside, 'uzak.png'), png());
      put(join(shots, 'sahte.png'), 'not a picture');
      const text = [
        '<!-- re:abc123 -->',
        '**Terminal takılması çözüldü.**',
        `- Uçtan uca kontrol geçti. ![başarısız run kapanmış](${join(shots, 'light-03-run-failed-collapsed.png')})`,
        '![Klasörler](_dream_context/tmp/super/klasor.png)',
        `![çocuk](${join(worktree, 'tmp', 'cocuk.png')})`,
        `![uzak](${join(outside, 'uzak.png')})`,
        `![sahte](${join(shots, 'sahte.png')})`,
        '![yok](_dream_context/tmp/yok.png)',
      ].join('\n');
      const transport = new TelegramTransport({ token: '123:abc', baseUrl: bot.url, timeoutMs: 5000 });
      const ab = { key: 'k', target: 'super', scope: 'p', contextRoot: ctxRoot, binding: { chatId: 42 }, transport } as never;
      const hub = {
        send: (_ab: unknown, html: string, extra = {}) => transport.sendMessage(42, html, extra),
        notice: async () => {}, reply: async () => {}, sendButtons: async () => '',
        rootOf: (a: { contextRoot: string | null }) => a.contextRoot,
      } as never;
      // What hub.onAssistantText does: the text in hub mode, then the answer's extras.
      for (const html of toTelegramMessages(text, { blocks: 'hub' })) await transport.sendMessage(42, html);
      await sendAnswerBlocks(hub, ab, text, 'no-such-session', { snapshot: async () => null, mediaRoots: async () => [worktree, shots], isGitIgnored: () => true });

      const methods = bot.hits.map((h) => h.method);
      // No separate "Sahnede N resim" listing any more (owner 2026-11-13): each picture's own caption names it.
      expect(methods).toEqual(['sendMessage', 'sendMediaGroup', 'sendMessage']);
      const [first, album, why] = bot.hits;
      expect(first.body).toContain('Terminal takılması çözüldü');
      expect(first.body).not.toContain('](');
      expect(album.files).toEqual(['light-03-run-failed-collapsed.png', 'klasor.png', 'cocuk.png']);
      expect(album.body).toContain('1 · başarısız run kapanmış');
      expect(album.body).toContain('2 · Klasörler');
      expect(why.body).toContain('Resim: uzak (gönderilmedi: proje klasörünün dışında');
      expect(why.body).toContain('Resim: sahte (gönderilmedi: resim, video ya da PDF değil');
      expect(why.body).toContain('Resim: yok (gönderilmedi: dosya bulunamadı');
    } finally { bot.server.close(); }
  });

  it('one picture goes as one photo with its name as the caption', async () => {
    const bot = await fakeBot();
    try {
      const p = put(join(shots, 'tek.png'), png());
      const transport = new TelegramTransport({ token: '123:abc', baseUrl: bot.url, timeoutMs: 5000 });
      const ab = { key: 'k', target: 'super', scope: 'p', contextRoot: ctxRoot, binding: { chatId: 42 }, transport } as never;
      const hub = { send: (_a: unknown, html: string) => transport.sendMessage(42, html), notice: async () => {}, reply: async () => {}, sendButtons: async () => '', rootOf: (a: { contextRoot: string | null }) => a.contextRoot } as never;
      await sendAnswerBlocks(hub, ab, `Bak: ![tek resim](${p})`, 'no-such-session', { snapshot: async () => null, mediaRoots: async () => [shots] });
      expect(bot.hits.map((h) => h.method)).toEqual(['sendPhoto']);
      expect(bot.hits[0].files).toEqual(['tek.png']);
      expect(bot.hits[0].body).toContain('tek resim');
    } finally { bot.server.close(); }
  });
});

describe('a whiteboard exported section by section (owner 2026-11-17)', () => {
  const setup = async () => {
    const bot = await fakeBot();
    const transport = new TelegramTransport({ token: '123:abc', baseUrl: bot.url, timeoutMs: 5000 });
    const ab = { key: 'k', target: 'super', scope: 'p', contextRoot: ctxRoot, binding: { chatId: 42 }, transport } as never;
    const hub = { send: (_a: unknown, html: string) => transport.sendMessage(42, html), notice: async () => {}, reply: async () => {}, sendButtons: async () => '', rootOf: (a: { contextRoot: string | null }) => a.contextRoot } as never;
    return { bot, ab, hub };
  };

  it('every picture goes: more than one album goes as several albums, numbered on', async () => {
    const { bot, ab, hub } = await setup();
    try {
      const lines = Array.from({ length: 12 }, (_, i) => `![bölüm ${i + 1}](${put(join(shots, `b${i + 1}.png`), png())})`);
      await sendAnswerBlocks(hub, ab, lines.join('\n'), 'no-such-session', { snapshot: async () => null, mediaRoots: async () => [shots] });
      expect(bot.hits.map((h) => h.method)).toEqual(['sendMediaGroup', 'sendMediaGroup']);
      expect(bot.hits[0].files).toHaveLength(10);
      expect(bot.hits[1].files).toEqual(['b11.png', 'b12.png']);
      expect(bot.hits[1].body).toContain('11 · bölüm 11');
      expect(bot.hits.some((h) => h.body.includes('en çok'))).toBe(false);
    } finally { bot.server.close(); }
  });

  it('a lone picture in a later album keeps its running number, a tall one too', async () => {
    const { bot, ab, hub } = await setup();
    try {
      const lines = Array.from({ length: 11 }, (_, i) => `![bölüm ${i + 1}](${put(join(shots, `c${i + 1}.png`), png())})`);
      lines.push(`![uzun](${put(join(shots, 'uzun.png'), png(300, 1700))})`);
      await sendAnswerBlocks(hub, ab, lines.join('\n'), 'no-such-session', { snapshot: async () => null, mediaRoots: async () => [shots] });
      expect(bot.hits.map((h) => h.method)).toEqual(['sendMediaGroup', 'sendPhoto', 'sendPhoto']);
      expect(bot.hits[1].body).toContain('11 · bölüm 11');
      expect(bot.hits[2].body).toContain('12 · uzun');
    } finally { bot.server.close(); }
  });

  it("Telegram's flood limit is waited out: the refused album goes again after retry_after", async () => {
    const hits: string[] = [];
    let refused = false;
    const server = createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        const method = (req.url ?? '').split('/').pop() ?? '';
        hits.push(method);
        res.setHeader('content-type', 'application/json');
        if (method === 'sendMediaGroup' && !refused) {
          refused = true;
          res.statusCode = 429;
          res.end(JSON.stringify({ ok: false, error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }));
          return;
        }
        res.end(JSON.stringify({ ok: true, result: method === 'sendMediaGroup' ? [{ message_id: 1 }] : { message_id: 2 } }));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const waits: number[] = [];
    const realWait = uploadTiming.wait;
    uploadTiming.wait = async (ms) => { waits.push(ms); };
    try {
      const transport = new TelegramTransport({ token: '123:abc', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, timeoutMs: 5000 });
      const ab = { key: 'k', target: 'super', scope: 'p', contextRoot: ctxRoot, binding: { chatId: 42 }, transport } as never;
      const sent: string[] = [];
      const hub = { send: async (_a: unknown, html: string) => { sent.push(html); }, notice: async () => {}, reply: async () => {}, sendButtons: async () => '', rootOf: (a: { contextRoot: string | null }) => a.contextRoot } as never;
      const text = [1, 2].map((i) => `![b${i}](${put(join(shots, `f${i}.png`), png())})`).join('\n');
      const n = await sendAnswerBlocks(hub, ab, text, 'no-such-session', { snapshot: async () => null, mediaRoots: async () => [shots] }).then(() => hits.length);
      expect(n).toBe(2);
      expect(hits).toEqual(['sendMediaGroup', 'sendMediaGroup']);
      expect(waits).toEqual([3000]);
      expect(sent.join('')).not.toContain('gönderilmedi');
    } finally {
      uploadTiming.wait = realWait;
      server.close();
    }
  });

  it('a layout check (whiteboard render) still goes, named a draft; an export goes under its own name', async () => {
    const { bot, ab, hub } = await setup();
    try {
      const board = [{ id: 'r', type: 'rectangle', x: 0, y: 0, width: 40, height: 40, version: 1, isDeleted: false, opacity: 100, index: 'a0' }] as never;
      const layout = put(join(shots, 'pano.png'), renderScene(board, { region: { x: 0, y: 0, w: 50, h: 50 }, scale: 1 }).png);
      const real = put(join(shots, 'pano-export.png'), renderScene(board, { region: { x: 0, y: 0, w: 50, h: 50 }, scale: 1, pictures: () => null }).png);
      await sendAnswerBlocks(hub, ab, `![pano](${layout})\n![bölüm 1](${real})`, 'no-such-session', { snapshot: async () => null, mediaRoots: async () => [shots] });
      expect(bot.hits.map((h) => h.method)).toEqual(['sendMediaGroup']);
      expect(bot.hits[0].body).toContain('1 · Yerleşim taslağı, panonun görüntüsü değil · pano');
      expect(bot.hits[0].body).toContain('2 · bölüm 1');
      expect(bot.hits[0].body).not.toContain('taslağı, panonun görüntüsü değil · bölüm 1');
    } finally { bot.server.close(); }
  });
});
