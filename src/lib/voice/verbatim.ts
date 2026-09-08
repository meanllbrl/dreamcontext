/**
 * DID THE SPEECH MODEL READ THE LINE, OR ANSWER IT?
 *
 * The speech half of J.A.R.V.I.S mode is a CHAT model asked to behave as a TTS engine, and
 * the request it is handed — one sentence of the agent's reply, in the user role — is
 * indistinguishable in shape from something addressed to it. Measured against the live API
 * on 2026-09-07, `openai/gpt-audio-mini` answers rather than reads whenever the line is
 * short and conversational:
 *
 *   sent   "Söyle, hangi konuya girelim."
 *   spoken "Tabii, şimdi o zaman bir konu seçebiliriz. Örneğin, günlük hayat, seyahat…"
 *   sent   "Evet, duyuyorum. Net geliyor."
 *   spoken "Teşekkür ederim, memnun olduğuna sevindim. Şimdi sana yardımcı olmamı istediğin…"
 *
 * That is what the owner heard as a loop: a reply is chunked into sentences and EVERY short
 * chunk comes back as a fresh conversational answer, so the voice keeps saying "Understood…"
 * over a transcript that says something else entirely. The prompt is what made it rare (2/7
 * verbatim before the script framing, 21/24 after) — but the residue is STOCHASTIC: the same
 * sentence read correctly in one round and was answered in the next. A prompt therefore
 * cannot be the fix on its own, and this module is the reason it does not have to be.
 *
 * WHAT MAKES THE CHECK POSSIBLE. The audio deltas carry a `transcript` field — the words the
 * model is actually speaking. It used to be discarded as "useless to us"; it is in fact the
 * only ground truth about what the owner is about to hear, and comparing it to the line we
 * sent turns "hope the prompt held" into a measurement.
 *
 * WHY A TOKEN LCS RATIO AND NOT EQUALITY. A correct read is not byte-identical: the model
 * drops a suffix, normalises a number, or re-punctuates. Measured, a genuine read scores
 * 0.70–1.00 against the line and an answer scores 0.11–0.27, so {@link VERBATIM_FLOOR} sits
 * in the empty middle of that gap rather than at either end.
 */

/** Words, case- and punctuation-insensitive, so a re-punctuated read still matches. */
export function speechTokens(text: string): string[] {
  return text
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]+/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * How much of the line survived into the speech, in 0..1: the longest common SUBSEQUENCE of
 * words over the longer of the two.
 *
 * A subsequence rather than a set, so word ORDER counts — an answer that happens to reuse
 * the line's vocabulary ("net geliyor" → "sesim net bir şekilde geliyor") must not pass by
 * accident. Dividing by the LONGER side is what catches the common failure directly: an
 * answer is almost always longer than the line it answered, and every added word costs.
 */
export function verbatimRatio(asked: string, spoken: string): number {
  const a = speechTokens(asked);
  const b = speechTokens(spoken);
  if (a.length === 0 || b.length === 0) return 0;
  // Two rolling rows rather than the full table: a chunk is a sentence, but MAX_TTS_CHARS
  // allows a long one and a direct POST is not obliged to be polite.
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = 0;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1]
        ? prev[j - 1] + 1
        : Math.max(prev[j], cur[j - 1]);
    }
    const swap = prev; prev = cur; cur = swap;
  }
  return prev[b.length] / Math.max(a.length, b.length);
}

/**
 * The pass mark. Measured separation on the live model: the worst genuine read scored 0.70,
 * the best answer-instead-of-read scored 0.27. Set at 0.5 — in the gap, and nearer the
 * failures, because the cost of the two mistakes is not symmetric: a false REJECT costs one
 * unspoken sentence that is still on screen, a false ACCEPT is the bug itself, the agent
 * saying something the owner never wrote.
 */
export const VERBATIM_FLOOR = 0.5;

/**
 * Was `spoken` a reading of `asked`?
 *
 * FAILS OPEN on an absent transcript, and that direction is deliberate. Every take measured
 * carried one (24/24), but a provider that stops sending the field must degrade to "speech
 * we cannot verify" and not to a mode that is silently mute — the check exists to stop the
 * wrong words being spoken, not to become a second way for the right ones to go missing.
 */
export function readVerbatim(asked: string, spoken: string): boolean {
  if (!spoken.trim()) return true;
  return verbatimRatio(asked, spoken) >= VERBATIM_FLOOR;
}
