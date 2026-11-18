/**
 * The spoken summary an agent writes INTO its answer for the owner's Telegram (plan
 * telegram-sesli-ozet, C3):
 *
 *   ```dream-voice <title, one line, optional>
 *   <the summary, written for the ear>
 *   ```
 *
 * The answer path that already sends that answer to Telegram speaks each block as a voice bubble
 * (`server/telegram/voice-reply.ts`) and sends the rest as before. At the Mac chat the block is a
 * voice-message card (dashboard `VoiceCard`), spoken only when its play button is tapped
 * (`POST /api/agent/voice/summary`).
 * Pure: no I/O.
 */

export interface VoiceBlock { title: string; text: string }

/** Longest info line kept as the title. The caption is redacted FIRST and cut to its own length
 *  after (`voiceCaptionHtml`): a cut through a key would leave too little of it to match. */
export const VOICE_TITLE_MAX = 400;

/** A `dream-voice` fence: its info line (title) and body. Three or more backticks or tildes,
 *  closed by the same run, as CommonMark; an unclosed fence is not a block. */
const FENCE_RE = /^([ \t]{0,3})(`{3,}|~{3,})[ \t]*dream-voice\b[ \t]*([^\n`]*)\n([\s\S]*?)\n[ \t]{0,3}\2[`~]*[ \t]*$/gm;

/** The answer without its `dream-voice` blocks, and the blocks in order. A block with no
 *  words is dropped (nothing to say, nothing shown). */
export function splitVoiceBlocks(md: string): { rest: string; voices: VoiceBlock[] } {
  if (!md || !md.includes('dream-voice')) return { rest: md, voices: [] };
  const voices: VoiceBlock[] = [];
  const rest = md.replace(FENCE_RE, (_all, _indent: string, _fence: string, info: string, body: string) => {
    const text = body.trim();
    if (text) voices.push({ title: info.trim().slice(0, VOICE_TITLE_MAX).trim(), text });
    return '';
  });
  if (!voices.length && rest === md) return { rest: md, voices: [] };
  return { rest: rest.replace(/\n{3,}/g, '\n\n').trim(), voices };
}

/** What one text sent to Telegram (an answer section, a member post) carries: its text, and the
 *  ONE block it speaks. Only the first block is spoken; any further block stays in the text. */
export function voiceAnswer(md: string): { text: string; voice: VoiceBlock | null } {
  const { rest, voices } = splitVoiceBlocks(md);
  if (!voices.length) return { text: rest, voice: null };
  const extra = voices.slice(1).map((v) => (v.title ? `**${v.title}**\n${v.text}` : v.text));
  return { text: [rest, ...extra].filter((t) => t.trim()).join('\n\n'), voice: voices[0]! };
}
