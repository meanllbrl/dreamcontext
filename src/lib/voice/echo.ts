/**
 * DID THE TRANSCRIPTION MODEL HEAR THE TAKE, OR JUST READ OUR PROMPT?
 *
 * Transcription here is a chat completion: the take rides as an `input_audio` part next to a
 * text part asking what was said (see `TRANSCRIBE_ASK`). When the model does not perceive the
 * audio — a quiet room, a take under a second — it does not say so. It answers the TEXT part
 * instead, and measured against the live API on 2026-09-07 the most common answer is our own
 * question, echoed back:
 *
 *   [1.5 s of room tone] → "What did I just say? Reply with ONLY my words, verbatim, in the
 *                           language I spoke. No quotes, no commentary, no translation…"
 *
 * Three times out of three. That string was then submitted to a TOOL-ENABLED agent as if the
 * owner had said it — it is the message in the owner's screenshot, and the agent, being an
 * obedient one, echoed it straight back. The same failure also arrives as commentary
 * ("The word you used is \"Tomorrow\".") rather than as a transcript.
 *
 * Two defences, and they are layered because neither is sufficient alone:
 *   • {@link NO_SPEECH} — the ask now names a sentinel for "no speech in this audio", which
 *     converts the silence case from an echo into a token we can act on (3/3 measured).
 *   • {@link isPromptEcho} — the ask is compared against the reply, because a sentinel only
 *     helps a model that is answering the question it was given. One that is reciting the
 *     question needs catching by shape.
 *
 * The bar for BOTH is the same as everywhere else in this feature: a transcript we are not
 * sure of is never submitted. An empty result is a silence the owner can simply repeat.
 */

import { speechTokens, verbatimRatio } from './verbatim.js';

/** What the ask tells the model to reply when the audio holds no speech. Matched
 *  case-insensitively and on its own — a take that genuinely contained these words is not a
 *  case worth protecting against a take that contained nothing. */
export const NO_SPEECH = 'NO_SPEECH';

/**
 * Is this "transcript" our own prompt coming back?
 *
 * Reuses the speech verifier's ratio: an echo is a near-copy of the ask, a real transcript
 * shares almost nothing with it. Measured, echoes score 0.75–1.00 against the ask (the model
 * trims the last sentence about as often as it repeats it whole), and the Turkish takes in
 * the test set score 0.00. The floor sits at 0.5 for the same reason as the speech one: the
 * two mistakes cost very different amounts, and a dropped take is the cheap one.
 */
export function isPromptEcho(text: string, ask: string): boolean {
  const t = text.trim();
  if (!t) return false;
  return verbatimRatio(ask, t) >= 0.5;
}

/**
 * The transcript as it may be submitted, or `''` for "nothing was heard".
 *
 * `''` is not an error: the client already treats an empty transcript as a silence, tells the
 * owner nothing was heard, and submits nothing (`useVoiceCapture.upload`). That is exactly
 * the right destination for all three failure shapes below.
 */
export function usableTranscript(raw: unknown, ask: string): string {
  const text = typeof raw === 'string' ? raw.trim() : '';
  if (!text) return '';
  // The sentinel, alone or dressed up ("NO_SPEECH." / "no_speech"). A reply that merely
  // CONTAINS it inside a real sentence is left alone — that is a transcript with an unlucky
  // word in it, not a verdict.
  const tokens = speechTokens(text);
  if (tokens.length <= 2 && tokens.join('') === speechTokens(NO_SPEECH).join('')) return '';
  if (isPromptEcho(text, ask)) return '';
  return text;
}
