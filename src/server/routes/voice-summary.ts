/**
 * POST /api/agent/voice/summary: a `dream-voice` card's play button in the Mac chat. The whole
 * summary spoken as ONE WAV by `speakSummary` (the same model chain, voice, redaction, 3000-char
 * cap and `ttsGate` slots the Telegram voice message uses). Made only when the owner taps play.
 *
 * Desktop only, like `/tts`. The key is read inside `speakSummary` and never returned.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isDesktop } from '../desktop.js';
import { sendError, parseJsonBody } from '../middleware.js';
import { speakSummary, MAX_SUMMARY_CHARS } from '../voice-speak.js';

const VOICE_DEADLINE_MS = 90_000;

export async function handleVoiceSummary(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }
  const body = (await parseJsonBody(req).catch(() => null)) as Record<string, unknown> | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text) { sendError(res, 400, 'bad_request', 'No text to speak.'); return; }
  if (text.length > MAX_SUMMARY_CHARS * 2) { sendError(res, 413, 'too_long', 'That summary is too long to speak.'); return; }
  const gone = new AbortController();
  res.on('close', () => { if (!res.writableFinished) gone.abort(); });
  const r = await speakSummary(text, { format: 'wav', signal: AbortSignal.any([gone.signal, AbortSignal.timeout(VOICE_DEADLINE_MS)]) });
  if (!r.ok) {
    if (r.reason === 'nothing_speakable') { res.writeHead(204); res.end(); return; }
    sendError(res, r.reason === 'no_key' ? 400 : r.reason === 'too_long' ? 413 : 502, r.reason, 'The summary could not be spoken.');
    return;
  }
  const audio = r.wav!;
  res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': audio.length, 'Cache-Control': 'no-store' });
  res.end(audio);
}
