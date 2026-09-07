/**
 * The voice routes: speech IN (`/stt`), speech OUT (`/tts`), and what Settings needs to know
 * (`/status`, `PUT /config`).
 *
 * POSTURE, STATED RATHER THAN INHERITED. Both audio routes are `isDesktop()`-gated, sit
 * behind the process-level CSRF and network-token guards every route gets, and are
 * classified against `VAULT_AGNOSTIC_PREFIXES` in `src/server/index.ts` — STT is vault
 * SCOPED (Slice 2's correction pass reads the lexicon out of the vault's brain, so the
 * request must say which vault), TTS is vault AGNOSTIC (it reads no project state at all).
 * Writing that classification down is the point: `isVaultAgnostic` is a prefix list, and a
 * route nobody classified gets whichever answer its path accidentally matches.
 *
 * TWO RULES GOVERN EVERY HANDLER BELOW, AND NEITHER IS OPTIONAL:
 *
 * 1. NO UPSTREAM BODY IS EVER FORWARDED (AC13). OpenRouter's error text is logged here,
 *    redacted, and the client is told one of OUR codes. These routes are reached by the chat
 *    surface, whose transcripts get persisted and can be synced to a teammate's brain — an
 *    echoed error body is a key with a distribution channel.
 *
 * 2. THE CAPS ARE ENFORCED HERE (AC12). Not in the client's queue. See `lib/voice/limits.ts`
 *    for why an authenticated LAN peer makes that distinction real rather than theoretical.
 *
 * The client must be able to tell a PERMANENT problem from a transient one, so the failure
 * shape is a small closed set rather than a message:
 *   `stt_unconfigured` / `tts_unconfigured` — no key, or the model is gone. Degrade to text
 *      and SAY what is missing (AC14). Retrying this take will not help.
 *   `stt_failed` / `tts_failed` — this take blew up. A retry is entirely reasonable.
 *   `stt_busy` / `tts_busy` — a cap said no. Also transient.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson, sendError, parseJsonBody } from '../middleware.js';
import { isDesktop } from '../desktop.js';
import {
  voiceApiKey, voiceStatus, writeVoiceConfig, readVoiceConfig,
  DEFAULT_VOICE, AUTO_LANGUAGE,
} from '../../lib/voice/config.js';
import {
  OPENROUTER_BASE, OPENROUTER_HEADERS, logUpstream, resolveModel, clearModelCache,
} from '../../lib/voice/openrouter.js';
import {
  sttGate, ttsGate, MAX_STT_BYTES, MAX_TTS_CHARS,
} from '../../lib/voice/limits.js';
import { speakable } from '../../lib/voice/speakable.js';
import { correctTranscript, describeOps } from '../../lib/voice/correct.js';
import { buildVoiceLexicon } from '../../lib/voice/lexicon.js';

/**
 * The JARVIS character, and the reason no second provider is being bought.
 *
 * OpenAI has no British male voice, so the character cannot come from the voice list. It
 * comes from this parameter instead, which costs nothing and travels with every call. The
 * accepted trade is a deep voice plus a persona instruction. Because Gemini Flash TTS and
 * Voxtral sit behind the SAME endpoint, changing the voice later is a model-id change rather
 * than an integration.
 */
export const JARVIS_INSTRUCTIONS =
  'Speak as a calm, precise, unhurried assistant. Measured pace, level tone, dry warmth. '
  + 'Never theatrical, never breathless. Land the end of each sentence rather than rushing it.';

/**
 * Stream the request body with a PER-CHUNK cap, refusing mid-flight rather than buffering to
 * completion and then measuring. Lifted from `agent-drop.ts` verbatim, including the reason:
 * a naive buffer-then-check lets one hostile upload OOM the Node process.
 *
 * Resolves null when the cap was hit (413 already sent) or the stream errored.
 */
function readCappedAudio(req: IncomingMessage, res: ServerResponse): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    const finish = (v: Buffer | null) => { if (!done) { done = true; resolve(v); } };
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_STT_BYTES) {
        sendError(res, 413, 'too_large', 'The recording exceeds the 25 MB limit.');
        req.destroy();
        finish(null);
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => finish(Buffer.concat(chunks)));
    req.on('error', () => finish(null));
  });
}

/** The container the client recorded in, echoed back as a filename extension so the upstream
 *  multipart part is typed. Every container `MediaRecorder` can produce is on OpenAI's
 *  accepted list (wav, mp3, flac, m4a, ogg, webm, aac), which is why there is NO conversion
 *  step anywhere in this feature — the bytes go up exactly as they were recorded. */
const EXT_BY_MIME: Record<string, string> = {
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/aac': 'aac',
  'audio/flac': 'flac',
};

/** Map the client's declared content-type to an upload filename. Unknown types are sent as
 *  `.webm` rather than refused: the accepted list is upstream's, and guessing wrong there
 *  costs one clear error, while refusing here would kill voice on a container we did not
 *  anticipate. */
export function uploadFilenameFor(contentType: string | undefined): string {
  const base = String(contentType || '').split(';')[0].trim().toLowerCase();
  return `take.${EXT_BY_MIME[base] || 'webm'}`;
}

// ─── POST /api/agent/voice/stt ────────────────────────────────────────────────

export async function handleVoiceStt(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }

  // The gate is taken BEFORE the body is read, so a burst is refused without us first
  // buffering 25 MB per attacker request.
  const verdict = sttGate.acquire();
  if (verdict !== 'ok') {
    sendJson(res, 429, {
      error: 'stt_busy',
      message: verdict === 'busy'
        ? 'Another recording is still being transcribed.'
        : 'Too many recordings in the last minute.',
    });
    return;
  }

  try {
    const key = voiceApiKey();
    if (!key) {
      sendJson(res, 400, {
        error: 'stt_unconfigured',
        message: 'No OpenRouter key is set. Add one in Settings to speak to your agent.',
      });
      return;
    }

    const model = await resolveModel('transcription', { key });
    if (!model.ok) {
      // A missing key was handled above, so anything here is a catalogue or rename problem —
      // AC3b's "clear configuration error, never a silent 404 on first press".
      sendJson(res, model.reason === 'unreachable' ? 502 : 400, {
        error: model.reason === 'unreachable' ? 'stt_failed' : 'stt_unconfigured',
        message: model.detail,
      });
      return;
    }

    const audio = await readCappedAudio(req, res);
    if (!audio) return;                     // 413 already sent, or a read error
    if (audio.length === 0) {
      sendJson(res, 400, { error: 'stt_failed', message: 'The recording was empty.' });
      return;
    }

    const cfg = readVoiceConfig();
    const form = new FormData();
    form.append(
      'file',
      new Blob([new Uint8Array(audio)], { type: String(req.headers['content-type'] || 'audio/webm') }),
      uploadFilenameFor(req.headers['content-type'] as string | undefined),
    );
    form.append('model', model.id);
    form.append('response_format', 'json');
    // NO `prompt` is sent. OpenRouter documents the transcription `prompt` as "accepted and
    // ignored", so sending the project lexicon here would be a lie in the code about where
    // accuracy comes from. Accuracy comes from the correction pass (Slice 2).
    const language = (cfg.sttLanguage || AUTO_LANGUAGE).trim();
    if (language && language !== AUTO_LANGUAGE) form.append('language', language);

    const started = Date.now();
    let upstream: Response;
    try {
      upstream = await fetch(`${OPENROUTER_BASE}/audio/transcriptions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, ...OPENROUTER_HEADERS },
        body: form,
      });
    } catch (err) {
      console.error('[voice:stt] request failed', err);
      sendJson(res, 502, { error: 'stt_failed', message: 'Transcription failed. Try the take again.' });
      return;
    }

    if (!upstream.ok) {
      logUpstream('stt', upstream.status, await upstream.text().catch(() => ''), key);
      sendJson(res, 502, { error: 'stt_failed', message: 'Transcription failed. Try the take again.' });
      return;
    }

    let text = '';
    try {
      const body = (await upstream.json()) as { text?: unknown };
      text = typeof body?.text === 'string' ? body.text.trim() : '';
    } catch (err) {
      console.error('[voice:stt] unreadable upstream body', err);
      sendJson(res, 502, { error: 'stt_failed', message: 'Transcription failed. Try the take again.' });
      return;
    }

    sendJson(res, 200, { text, ms: Date.now() - started });
  } finally {
    sttGate.release();
  }
}

// ─── POST /api/agent/voice/tts ────────────────────────────────────────────────

export async function handleVoiceTts(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  _contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }

  const verdict = ttsGate.acquire();
  if (verdict !== 'ok') {
    sendJson(res, 429, { error: 'tts_busy', message: 'Too many speech requests.' });
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const text = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!text) {
      sendJson(res, 400, { error: 'tts_failed', message: 'No text to speak.' });
      return;
    }
    if (text.length > MAX_TTS_CHARS) {
      // The client chunks to roughly a sentence, so this is only ever reached by a direct
      // POST — which is exactly the case AC12 is about.
      sendJson(res, 413, { error: 'tts_busy', message: 'That chunk is too long to speak.' });
      return;
    }

    // The LAST line of defence, applied here rather than in the client. The chunker never
    // sends a fenced block in the first place (`speechQueue.ts` excludes them outright), so
    // what this catches is the residue of ordinary prose: a stray URL, a file path, an em
    // dash. Applied AFTER the character cap, so a hostile direct POST cannot pad its way
    // under the limit with markup that strips away.
    const spoken = speakable(text);
    if (!spoken) {
      // Nothing speakable survived — a chunk that was only a link, or only a fence. This is
      // not a failure, so it is not `tts_failed`: the queue treats 204 as "skip this one and
      // keep going", the same as it treats a failed chunk (AC10), but without logging noise.
      res.writeHead(204).end();
      return;
    }

    const key = voiceApiKey();
    if (!key) {
      sendJson(res, 400, {
        error: 'tts_unconfigured',
        message: 'No OpenRouter key is set. The mode still works as text.',
      });
      return;
    }

    const model = await resolveModel('speech', { key });
    if (!model.ok) {
      sendJson(res, model.reason === 'unreachable' ? 502 : 400, {
        error: model.reason === 'unreachable' ? 'tts_failed' : 'tts_unconfigured',
        message: model.detail,
      });
      return;
    }

    const cfg = readVoiceConfig();
    let upstream: Response;
    try {
      upstream = await fetch(`${OPENROUTER_BASE}/audio/speech`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          ...OPENROUTER_HEADERS,
        },
        body: JSON.stringify({
          model: model.id,
          input: spoken,
          voice: cfg.voice || DEFAULT_VOICE,
          response_format: 'mp3',
          instructions: JARVIS_INSTRUCTIONS,
        }),
      });
    } catch (err) {
      console.error('[voice:tts] request failed', err);
      sendJson(res, 502, { error: 'tts_failed', message: 'Speech failed for this chunk.' });
      return;
    }

    if (!upstream.ok) {
      logUpstream('tts', upstream.status, await upstream.text().catch(() => ''), key);
      sendJson(res, 502, { error: 'tts_failed', message: 'Speech failed for this chunk.' });
      return;
    }

    const audio = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(200, {
      'Content-Type': 'audio/mpeg',
      'Content-Length': audio.length,
      // Never cached to disk by an intermediary: it is the owner's conversation.
      'Cache-Control': 'no-store',
    });
    res.end(audio);
  } catch (err) {
    console.error('[voice:tts] unexpected failure', err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: 'tts_failed', message: 'Speech failed for this chunk.' });
    }
  } finally {
    ttsGate.release();
  }
}

// ─── GET /api/agent/voice/status · PUT /api/agent/voice/config ────────────────

export async function handleVoiceStatus(
  _req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // Deliberately NOT desktop-gated: the web dashboard renders no mic button, but its
  // Settings page still has to be able to say "voice is a desktop feature" truthfully rather
  // than showing a card in an unknown state.
  sendJson(res, 200, { ...voiceStatus(), desktop: isDesktop() });
}

export async function handleVoiceConfigPut(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const body = await parseJsonBody(req);
  if (!body) {
    sendError(res, 400, 'bad_body', 'Expected a JSON object.');
    return;
  }
  const patch: Record<string, string | boolean | null | undefined> = {};
  // `null` clears; `undefined` (an absent field) leaves the stored value alone — so the
  // Settings card can save the voice picker without blanking a key it never rendered.
  if ('openRouterKey' in body) patch.openRouterKey = body.openRouterKey === null ? null : String(body.openRouterKey ?? '');
  if ('voice' in body) patch.voice = String(body.voice ?? '');
  if ('sttLanguage' in body) patch.sttLanguage = String(body.sttLanguage ?? '');
  if ('correction' in body) patch.correction = Boolean(body.correction);

  try {
    writeVoiceConfig(patch);
  } catch (err) {
    console.error('[voice:config] write failed', err);
    sendError(res, 500, 'write_failed', 'Could not save the voice settings.');
    return;
  }
  // A new key means the previous "no model / no key" resolution is stale.
  clearModelCache();
  sendJson(res, 200, { ...voiceStatus(), desktop: isDesktop() });
}

// ─── POST /api/agent/voice/correct ────────────────────────────────────────────────────

/**
 * Repair project jargon in a raw transcript, and say whether the result may be sent without
 * asking (see `lib/voice/correct.ts` for the whole safety model — the short version is that
 * ANY change waits for the owner's keypress).
 *
 * VAULT-SCOPED, and this is the route that makes `/stt`'s classification matter: the lexicon
 * is read out of the vault's own brain, so a request that did not name a vault has no
 * vocabulary to correct against.
 *
 * Shares the STT gate rather than having its own. It is the same money-spending burst from
 * the same gesture — one push-to-talk is one transcription plus one correction — and two
 * independent counters would let a caller spend twice the intended budget per take.
 */
export async function handleVoiceCorrect(
  req: IncomingMessage,
  res: ServerResponse,
  _params: Record<string, string>,
  contextRoot: string,
): Promise<void> {
  if (!isDesktop()) {
    sendError(res, 403, 'desktop_only', 'Voice is only available in the desktop app.');
    return;
  }

  const verdict = sttGate.acquire();
  if (verdict !== 'ok') {
    sendJson(res, 429, { error: 'stt_busy', message: 'Too many voice requests.' });
    return;
  }

  try {
    const body = await parseJsonBody(req);
    const raw = typeof body?.text === 'string' ? body.text.trim() : '';
    if (!raw) {
      sendError(res, 400, 'bad_body', 'Expected { text }.');
      return;
    }

    const result = await correctTranscript(raw, { contextRoot });

    // EVERY proposed substitution is logged, accepted or not, so a bad correction the owner
    // waved through in a hurry is still detectable afterwards. The raw transcript is not
    // logged: it is the owner's speech, and the operations already say what changed.
    if (result.ops.length > 0) {
      console.info(`[voice:correct] ${result.ms}ms — ${describeOps(result.ops, buildVoiceLexicon(contextRoot))}`);
    }

    sendJson(res, 200, {
      action: result.action,
      text: result.text,
      raw: result.raw,
      ops: result.ops,
      reason: result.reason,
      ms: result.ms,
    });
  } catch (err) {
    // A correction that fails is NEVER a take that fails: the caller falls back to the raw
    // transcript, which is what the owner actually said.
    console.error('[voice:correct] unexpected failure', err);
    sendJson(res, 200, { action: 'auto', text: '', raw: '', ops: [], reason: 'error', ms: 0 });
  } finally {
    sttGate.release();
  }
}
