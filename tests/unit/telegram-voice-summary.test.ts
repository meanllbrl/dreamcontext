/**
 * The owner's spoken summary on Telegram (plan telegram-sesli-ozet): a `dream-voice` block in an
 * answer that is going to Telegram becomes a voice bubble on that binding's bot, replying to his
 * message; at the Mac nothing is spoken; every failure says so and sends the text. The hub and the
 * member adapter run for real against a fake transport; the voice itself is injected.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { splitVoiceBlocks, voiceAnswer } from '../../src/lib/telegram/voice-block.js';
import { voiceCaptionHtml } from '../../src/lib/telegram/system-lines.js';
import { TelegramHub, type ActiveBinding } from '../../src/server/telegram/hub.js';
import { memberAdapter } from '../../src/server/telegram/member.js';
import { SUPER_TELEGRAM_LINE, superBriefing } from '../../src/server/chat-modes.js';
import { buildAskBlock } from '../../src/lib/automations/runner.js';
import type { SpeakSummaryResult } from '../../src/server/voice-speak.js';

type Sent = { method: string; chatId: number; text?: string; extra?: Record<string, unknown> };

function fakeTransport(log: Sent[]) {
  let mid = 100;
  return {
    sendMessage: async (chatId: number, html: string, extra: Record<string, unknown> = {}) => { log.push({ method: 'sendMessage', chatId, text: html, extra }); return { message_id: ++mid, text: html }; },
    sendVoice: async (chatId: number, file: { data: Buffer }, extra: Record<string, unknown> = {}) => { log.push({ method: 'sendVoice', chatId, extra: { ...extra, bytes: file.data.length } }); return { message_id: ++mid }; },
    sendChatAction: async (chatId: number, action: string) => { log.push({ method: 'sendChatAction', chatId, text: action }); return true; },
  };
}

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'tg-voice-sum-')); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

function setup(target: string, speak: (t: string) => Promise<SpeakSummaryResult>, contextRoot: string | null = null) {
  const log: Sent[] = [];
  const spoken: string[] = [];
  const hub = new TelegramHub({ home, speakSummary: async (t) => { spoken.push(t); return speak(t); } });
  const ab = {
    key: `0123456789abcdef/${target}`, scope: '0123456789abcdef', target,
    binding: { v: 1, token: 't', botId: 1, botUsername: 'b', chatId: 777, userId: 777, boundAt: '' },
    transport: fakeTransport(log), poller: null, done: Promise.resolve(), chain: Promise.resolve(),
    contextRoot, projectName: 'X',
  } as unknown as ActiveBinding;
  hub.active.set(ab.key, ab);
  return { hub, ab, log, spoken };
}

const OK = async (): Promise<SpeakSummaryResult> => ({ ok: true, ogg: Buffer.from('OggS-fake'), seconds: 52.3 });
const BLOCK = '```dream-voice Ajanda planının özeti\nDört boyda da iş yapılır. Kart seni bekliyor.\n```';

describe('the dream-voice block', () => {
  it('splits out of the answer; the rest is the answer as written', () => {
    const r = splitVoiceBlocks(`Kısaca:\n\n${BLOCK}\n\nBitti.`);
    expect(r.voices).toEqual([{ title: 'Ajanda planının özeti', text: 'Dört boyda da iş yapılır. Kart seni bekliyor.' }]);
    expect(r.rest).toBe('Kısaca:\n\nBitti.');
    expect(splitVoiceBlocks('düz metin')).toEqual({ rest: 'düz metin', voices: [] });
    // An unclosed fence is not a block.
    expect(splitVoiceBlocks('```dream-voice\nyarım').voices).toEqual([]);
  });

  it('one voice per text: a second block goes as text', () => {
    const r = voiceAnswer(`${BLOCK}\n\n\`\`\`dream-voice İkinci\nİkinci özet.\n\`\`\``);
    expect(r.voice?.title).toBe('Ajanda planının özeti');
    expect(r.text).toBe('**İkinci**\nİkinci özet.');
  });

  it('the caption redacts the whole title first, then cuts and escapes it', () => {
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefgh';
    const title = `${'a'.repeat(50)} ${key} <b>`;
    const html = voiceCaptionHtml(splitVoiceBlocks(`\`\`\`dream-voice ${title}\nmetin\n\`\`\``).voices[0]!.title);
    expect(html).not.toContain('ABCDEFGHIJ');
    expect(voiceCaptionHtml('a <b> & c')).toBe('🔊 a &lt;b&gt; &amp; c');
    expect(voiceCaptionHtml('')).toBe('🔊 Sesli özet');
  });
});

describe('Super answers (hub.onAssistantText)', () => {
  it('on Telegram: the block is a voice bubble replying to his message, the rest goes as text, the turn is answered', async () => {
    const { hub, ab, log, spoken } = setup('super', OK);
    const sid = 'sess-1';
    (hub as unknown as { superSessions: Map<string, string> }).superSessions.set(sid, ab.key);
    (hub as unknown as { presence: Map<string, unknown> }).presence.set(ab.key, { via: 'telegram', at: Date.now() });
    hub.noteReply(ab, 42, { ref: 'abc123', quote: 'sesli özetle', from: 'owner' });
    const landed = await hub.onAssistantText(sid, `<!-- re:abc123 -->\nÖzet geliyor.\n\n${BLOCK}`, { turns: [], inputs: undefined });
    expect(landed).toBe(true);
    expect(spoken).toEqual(['Dört boyda da iş yapılır. Kart seni bekliyor.']);
    const texts = log.filter((l) => l.method === 'sendMessage').map((l) => l.text).join('\n');
    expect(texts).toContain('Özet geliyor.');
    expect(texts).not.toContain('dream-voice');
    expect(texts).not.toContain('Dört boyda');
    const voice = log.find((l) => l.method === 'sendVoice')!;
    expect(voice.chatId).toBe(777);
    expect(voice.extra).toMatchObject({ caption: '🔊 Ajanda planının özeti', duration: 53, replyTo: 42 });
    expect(log.some((l) => l.method === 'sendChatAction' && l.text === 'record_voice')).toBe(true);
  });

  it('a voice-only answer still counts as landed (no "ended silent")', async () => {
    const { hub, ab } = setup('super', OK);
    (hub as unknown as { superSessions: Map<string, string> }).superSessions.set('s', ab.key);
    (hub as unknown as { presence: Map<string, unknown> }).presence.set(ab.key, { via: 'telegram', at: Date.now() });
    expect(await hub.onAssistantText('s', `<!-- re:abc123 -->\n${BLOCK}`, { turns: [], inputs: undefined })).toBe(true);
  });

  it('at the Mac: nothing is synthesised and nothing is sent', async () => {
    const { hub, ab, log, spoken } = setup('super', OK);
    (hub as unknown as { superSessions: Map<string, string> }).superSessions.set('s', ab.key);
    expect(await hub.onAssistantText('s', `<!-- re:abc123 -->\nÖzet.\n\n${BLOCK}`, { turns: [], inputs: undefined })).toBe(false);
    expect(spoken).toEqual([]);
    expect(log).toEqual([]);
  });

  it.each([
    ['no_key', "ses anahtarı yok"],
    ['no_ffmpeg', 'ffmpeg gerekli'],
    ['failed', 'hazırlanamadı'],
    ['too_long', 'çok uzun'],
  ] as const)('%s: its line, then the summary as text; no sendVoice', async (reason, words) => {
    const { hub, ab, log } = setup('super', async () => ({ ok: false, reason }));
    (hub as unknown as { superSessions: Map<string, string> }).superSessions.set('s', ab.key);
    (hub as unknown as { presence: Map<string, unknown> }).presence.set(ab.key, { via: 'telegram', at: Date.now() });
    expect(await hub.onAssistantText('s', `<!-- re:abc123 -->\n${BLOCK}`, { turns: [], inputs: undefined })).toBe(true);
    expect(log.some((l) => l.method === 'sendVoice')).toBe(false);
    const texts = log.filter((l) => l.method === 'sendMessage').map((l) => l.text ?? '');
    expect(texts[0]).toContain(words);
    expect(texts.join('\n')).toContain('Dört boyda da iş yapılır.');
  });
});

describe('a member bot (member.ts watchRun)', () => {
  it("speaks the block of the member's post through its own bot, replying to his message", async () => {
    const { hub, ab, log, spoken } = setup('ozetci', OK, join(home, '_dream_context'));
    const adapter = memberAdapter({
      say: () => ({ ok: true, status: 200, body: { runId: 'r1', entryId: 'ask' } }),
      readRun: () => [
        { id: 'ask', kind: 'user', text: 'sesli özetle' },
        { id: 'e1', kind: 'agent', text: `Tamam.\n\n${BLOCK}` },
        { id: 'e2', kind: 'system', event: 'ok', text: '' },
      ] as never,
      watchEveryMs: 1,
    });
    await adapter.onMessage(hub, ab.key, { message: { message_id: 9, text: 'sesli özetle', chat: { id: 777 }, from: { id: 777 } } });
    for (let i = 0; i < 100 && !log.some((l) => l.method === 'sendVoice'); i++) await new Promise((r) => setTimeout(r, 5));
    expect(spoken).toEqual(['Dört boyda da iş yapılır. Kart seni bekliyor.']);
    expect(log.find((l) => l.method === 'sendVoice')!.extra).toMatchObject({ replyTo: 9 });
    expect(log.filter((l) => l.method === 'sendMessage').map((l) => l.text).join('\n')).not.toContain('dream-voice');
  });
});

describe('the briefings', () => {
  it('the Super line (main and member Supers, every tool) asks for the block, capped, only when asked', () => {
    expect(SUPER_TELEGRAM_LINE).toContain('dream-voice');
    expect(SUPER_TELEGRAM_LINE).toContain('2500 characters');
    expect(SUPER_TELEGRAM_LINE).toContain('Never send one unasked');
    expect(superBriefing()).toContain(SUPER_TELEGRAM_LINE);
  });

  it("a member's ask block names the block", () => {
    expect(buildAskBlock('sesli özetle', { slug: 'ozetci', review: 'on' } as never)).toContain('dream-voice');
  });
});

describe('one door', () => {
  it('sendVoice is called only by the voice reply', () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const n of readdirSync(dir)) {
        const p = join(dir, n);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && /\bsendVoice\(|'sendVoice'/.test(readFileSync(p, 'utf-8'))) hits.push(p.slice(p.indexOf('src/')));
      }
    };
    walk(join(__dirname, '../../src'));
    expect(hits.sort()).toEqual(['src/lib/telegram/transport.ts', 'src/server/telegram/voice-reply.ts']);
  });
});
