/**
 * G4 drift (tg-grup C4): a group's chat id is reachable ONLY through the hub's `sendRoom`. Every
 * other transport send in the Telegram code addresses the binding's PRIVATE chat, by an expression
 * this test names. A new send site, a new file that sends, or a send whose chat is anything else
 * fails here, so a later change cannot route a card, a file or a picture to a group by accident.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const REPO = join(__dirname, '..', '..');
const DIRS = ['src/server/telegram', 'src/lib/telegram'];
const FILES = ['src/server/super-schedule.ts'];
const METHODS = ['sendMessage', 'editMessageText', 'editMessageReplyMarkup', 'sendChatAction', 'sendPhoto', 'sendMediaGroup', 'sendDocument', 'sendVoice', 'sendVideo', 'sendSticker', 'sendAnimation', 'sendAudio', 'copyMessage', 'forwardMessage'];

/** The private chat, as the code spells it. */
const PRIVATE_CHAT = new Set(['ab.binding.chatId', 'o.ab.binding.chatId', 'binding.chatId', 'b.chatId', 'b.binding.chatId']);
/** The files allowed to call a send method at all. */
const SENDERS = new Set([
  'src/server/telegram/hub.ts', 'src/server/telegram/runs.ts', 'src/server/telegram/pictures.ts', 'src/server/telegram/voice-reply.ts',
  'src/server/telegram/manager.ts', 'src/lib/telegram/member-forward.ts', 'src/lib/telegram/away.ts',
]);

function sources(): { rel: string; text: string }[] {
  const out: { rel: string; text: string }[] = [];
  for (const d of DIRS) {
    for (const f of readdirSync(join(REPO, d))) if (f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'transport.ts') out.push({ rel: `${d}/${f}`, text: readFileSync(join(REPO, d, f), 'utf8') });
  }
  for (const f of FILES) out.push({ rel: f, text: readFileSync(join(REPO, f), 'utf8') });
  return out;
}

/** The body of a method in a class file: from its signature to its closing two-space brace. */
function bodyOf(text: string, signature: string): { start: number; end: number } {
  const start = text.indexOf(signature);
  expect(start, signature).toBeGreaterThan(-1);
  const end = text.indexOf('\n  }\n', start);
  return { start, end };
}

interface Site { rel: string; at: number; method: string; chat: string }

function sites(): Site[] {
  const out: Site[] = [];
  const names = METHODS.join('|');
  for (const { rel, text } of sources()) {
    // transport.sendX(<chat>, …)
    for (const m of text.matchAll(new RegExp(`\\.(${names})\\(\\s*([^,)]+)`, 'g'))) out.push({ rel, at: m.index!, method: m[1], chat: m[2].trim() });
    // transport.call('sendX', { chat_id: <chat> … }) and transport.upload('sendX', { chat_id: <chat> … })
    for (const m of text.matchAll(new RegExp(`\\.(?:call|upload)(?:<[^>]*>)?\\(\\s*'(${names})'\\s*,\\s*\\{([^}]*)`, 'g'))) {
      const chat = /chat_id:\s*([^,}\s]+)/.exec(m[2])?.[1] ?? '(none)';
      out.push({ rel, at: m.index!, method: m[1], chat });
    }
  }
  return out;
}

describe('a group is reached only through sendRoom (G4)', () => {
  it('every send site addresses the private chat, except sendRoom, the pairing reply and the voice reply\'s private const', () => {
    const hub = readFileSync(join(REPO, 'src/server/telegram/hub.ts'), 'utf8');
    const room = bodyOf(hub, '  async sendRoom(');
    const pairing = bodyOf(hub, '  private async onPairingUpdate(');
    const voice = readFileSync(join(REPO, 'src/server/telegram/voice-reply.ts'), 'utf8');
    const bad: string[] = [];
    for (const s of sites()) {
      if (PRIVATE_CHAT.has(s.chat)) continue;
      if (s.rel === 'src/server/telegram/hub.ts' && s.chat === 'chatId' && s.at > room.start && s.at < room.end) continue;
      // A pairing's "Mac'te onay bekleniyor" goes to the /start sender's chat (PairingBook takes a
      // private /start only), before any binding exists.
      if (s.rel === 'src/server/telegram/hub.ts' && s.chat === 'chatId' && s.at > pairing.start && s.at < pairing.end) continue;
      if (s.rel === 'src/server/telegram/voice-reply.ts' && s.chat === 'chatId' && /const chatId = ab\.binding\.chatId;/.test(voice)) continue;
      bad.push(`${s.rel}: ${s.method}(${s.chat})`);
    }
    expect(bad).toEqual([]);
  });

  it('only the known files send at all', () => {
    const files = [...new Set(sites().map((s) => s.rel))].sort();
    for (const f of files) expect(SENDERS.has(f), f).toBe(true);
  });

  it('sendRoom sends text or typing only: no buttons, no file, no picture', () => {
    const hub = readFileSync(join(REPO, 'src/server/telegram/hub.ts'), 'utf8');
    const { start, end } = bodyOf(hub, '  async sendRoom(');
    const body = hub.slice(start, end);
    expect(body).toContain('if (!isGroupKind(kind))');
    expect(body).toContain('ab.transport.sendMessage(chatId, html, {})');
    expect(body).not.toMatch(/reply_markup|sendPhoto|sendDocument|sendMediaGroup|sendVoice|upload/);
    // Called from the group branch, the room runner and the bind confirm only.
    const callers = sources().filter((s) => s.text.includes('sendRoom(')).map((s) => relative(REPO, join(REPO, s.rel))).sort();
    expect(callers).toEqual(['src/server/telegram/hub.ts', 'src/server/telegram/room-agent.ts']);
  });

  it('the room runner never calls the transport itself', () => {
    const room = readFileSync(join(REPO, 'src/server/telegram/room-agent.ts'), 'utf8');
    expect(room).not.toMatch(new RegExp(`\\.(${METHODS.join('|')})\\(`));
    expect(room).not.toMatch(/\.call\('send/);
  });
});
