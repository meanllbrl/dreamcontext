/**
 * Is this transcript what the owner said, or whisper's garble? Pure; no I/O.
 *
 * ── THE SIGNALS, AND WHERE EACH THRESHOLD CAME FROM (measured 2026-10-24) ─────────────────
 * Twelve of the owner's own phone takes, replayed through the same `large-v3-turbo`:
 *   • DECODING CONFIDENCE (`avg_logprob`, duration-weighted over segments) is the one signal
 *     that separated them. The 8 good takes scored -0.02..-0.14; the weak ones forced to
 *     Turkish -0.57 and -0.80; the Icelandic misdetections -0.67..-1.04.
 *   • A LANGUAGE OUTSIDE THE CONTEXT is suspect — unless the take is clearly decoded, which is
 *     how a genuinely new language still gets through (the app stays multilingual).
 *   • THE SCRIPT: þ ð æ ø å never occur in Turkish or English; one of them under a tr/en
 *     decision is the Icelandic spelling of a Turkish sentence.
 *   • NO SPEECH while text exists, and whisper's decode LOOP ("bir yürüyen bir yürüyen…"),
 *     caught from the text alone with whisper's own compression-ratio threshold.
 *
 * whisper's `detected_language_probability` is deliberately NOT a signal: it was 0.97-0.99 on
 * every Icelandic misdetection.
 */

import { deflateSync } from 'node:zlib';

export type Verdict = 'clean' | 'suspect' | 'garbled';

/** One segment of a `verbose_json` answer — only the fields read here. */
export interface WhisperSegment {
  start?: number;
  end?: number;
  avg_logprob?: number;
  no_speech_prob?: number;
}

/** One transcription pass, as `transcribeLocal` returns it. */
export interface ScoredInput {
  text: string;
  /** The language the pass was decoded in: the pin, or what `auto` detected (normalized). */
  language: string | null;
  /** True when the language was pinned rather than detected. */
  forced: boolean;
  segments: WhisperSegment[];
}

export interface Score {
  verdict: Verdict;
  reasons: string[];
  /** Duration-weighted `avg_logprob`, or null when whisper sent no segments. */
  logprob: number | null;
  /** A letter from {@link FOREIGN_LETTERS} under a tr/en decision. */
  scriptFlag: boolean;
  /** The pass's language is in the context set (or the set is empty). */
  inContext: boolean;
  /** The pass looped (compression or a repeated n-gram). */
  loop: boolean;
}

/** Below this: garbled. */
export const GARBLED_LOGPROB = -0.5;
/** Below this (down to {@link GARBLED_LOGPROB}): suspect. */
export const SUSPECT_LOGPROB = -0.35;
/** A language outside the context is accepted as new at or above this, with no other signal. */
export const NEW_LANGUAGE_LOGPROB = -0.25;
/** No speech above this while text exists: garbled. */
export const NO_SPEECH_PROB = 0.6;
/** whisper's own `compression_ratio_threshold`. */
export const COMPRESSION_RATIO = 2.4;
/** An n-gram (1-5 words) repeated this many times in a row is a loop. */
export const LOOP_REPEATS = 4;
/** Letters outside the language's alphabet at this share or more: suspect. */
export const FOREIGN_SHARE = 0.02;

/** Letters that never occur in Turkish or English. One is enough under a tr/en decision. */
const FOREIGN_LETTERS = /[þðæøåÞÐÆØÅ]/;

/** Alphabets per language. tr and en ship; an unknown language skips the script signal. The
 *  Turkish table carries q, w, x and the circumflexes: the owner's speech is full of English
 *  project words. */
const ALPHABETS: Readonly<Record<string, RegExp>> = {
  tr: /[a-zçğıöşüâîûA-ZÇĞİÖŞÜÂÎÛ]/,
  en: /[a-zA-Zéèêëàâäïîôöüûçñ]/,
};

/** Duration-weighted mean `avg_logprob`; null when there is nothing to weigh. */
export function weightedLogprob(segments: WhisperSegment[]): number | null {
  let sum = 0;
  let weight = 0;
  for (const s of segments) {
    if (typeof s.avg_logprob !== 'number' || !Number.isFinite(s.avg_logprob)) continue;
    const w = Math.max(0.01, (s.end ?? 0) - (s.start ?? 0));
    sum += s.avg_logprob * w;
    weight += w;
  }
  return weight > 0 ? sum / weight : null;
}

/** Text bytes over deflated bytes, as whisper measures a loop. */
export function compressionRatio(text: string): number {
  const raw = Buffer.from(text, 'utf-8');
  if (raw.length === 0) return 0;
  return raw.length / deflateSync(raw).length;
}

/** Any 1-5-word n-gram repeated {@link LOOP_REPEATS} times in a row. */
export function hasRepeatedNgram(text: string): boolean {
  const words = text.toLocaleLowerCase('tr').replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  for (let n = 1; n <= 5; n++) {
    for (let i = 0; i + n * LOOP_REPEATS <= words.length; i++) {
      const gram = words.slice(i, i + n).join(' ');
      let k = 1;
      while (k < LOOP_REPEATS && words.slice(i + k * n, i + (k + 1) * n).join(' ') === gram) k++;
      if (k >= LOOP_REPEATS) return true;
    }
  }
  return false;
}

const rank: Record<Verdict, number> = { clean: 0, suspect: 1, garbled: 2 };
const worse = (a: Verdict, b: Verdict): Verdict => (rank[a] >= rank[b] ? a : b);

/** Score one pass against the language context's `set`. */
export function score(pass: ScoredInput, ctx: { set: string[] }): Score {
  const reasons: string[] = [];
  let verdict: Verdict = 'clean';
  const text = pass.text.trim();
  const logprob = weightedLogprob(pass.segments);
  // No words, nothing to judge: an empty take stays the page's "nothing heard", never a spoken
  // "Anlayamadım" (a breath or a knock that passed the silence gate).
  if (!text) return { verdict: 'clean', reasons: [], logprob, scriptFlag: false, inContext: true, loop: false };

  if (logprob !== null && logprob < GARBLED_LOGPROB) {
    verdict = 'garbled'; reasons.push('weak');
  } else if (logprob !== null && logprob < SUSPECT_LOGPROB) {
    verdict = 'suspect'; reasons.push('weak');
  }

  const noSpeech = Math.max(0, ...pass.segments.map((s) => (typeof s.no_speech_prob === 'number' ? s.no_speech_prob : 0)));
  if (text && noSpeech > NO_SPEECH_PROB) { verdict = 'garbled'; reasons.push('no-speech'); }

  const loop = !!text && (compressionRatio(text) > COMPRESSION_RATIO || hasRepeatedNgram(text));
  if (loop) { verdict = 'garbled'; reasons.push('loop'); }

  const inContext = !ctx.set.length || (!!pass.language && ctx.set.includes(pass.language));
  const clear = logprob !== null && logprob >= NEW_LANGUAGE_LOGPROB;

  // The script is read against the pass's own language when it has a table; an UNCLEAR pass
  // outside the context is read against the context's language too, so an Icelandic `auto`
  // pass under a Turkish context cannot win on a technicality. A clear new language is not.
  let scriptFlag = false;
  const decision = pass.language && ALPHABETS[pass.language]
    ? pass.language
    : (!inContext && !clear && ctx.set[0] && ALPHABETS[ctx.set[0]] ? ctx.set[0] : null);
  const alphabet = decision ? ALPHABETS[decision] : undefined;
  if (alphabet && text) {
    if (FOREIGN_LETTERS.test(text)) {
      scriptFlag = true;
      verdict = worse(verdict, 'suspect'); reasons.push('script');
    } else {
      const letters = [...text].filter((ch) => /\p{L}/u.test(ch));
      const foreign = letters.filter((ch) => !alphabet.test(ch)).length;
      if (letters.length && foreign / letters.length >= FOREIGN_SHARE) {
        verdict = worse(verdict, 'suspect'); reasons.push('alphabet');
      }
    }
  }

  // Last, because "a genuinely new language" means NO other signal fired.
  if (!inContext && text) {
    const clearlyNew = reasons.length === 0 && clear;
    if (!clearlyNew) { verdict = worse(verdict, 'suspect'); reasons.push('out-of-context'); }
  }

  return { verdict, reasons, logprob, scriptFlag, inContext, loop };
}

/** A scored pass, for {@link pick}. */
export interface Candidate<T> { pass: T & ScoredInput; score: Score }

/**
 * The pass to act on, and whether it may be sent. One sort key: verdict (clean < suspect <
 * garbled), then script flag (unflagged first), then in-context first, then higher logprob.
 * Under a tr/en decision a winner that still carries þ ð æ ø å is garbled: never sent.
 */
export function pick<T>(candidates: Array<Candidate<T>>): { winner: Candidate<T>; verdict: Verdict } {
  const lp = (c: Candidate<T>) => c.score.logprob ?? -Infinity;
  const sorted = [...candidates].sort((a, b) =>
    rank[a.score.verdict] - rank[b.score.verdict]
    || Number(a.score.scriptFlag) - Number(b.score.scriptFlag)
    || Number(b.score.inContext) - Number(a.score.inContext)
    || lp(b) - lp(a));
  const winner = sorted[0];
  const verdict = winner.score.scriptFlag ? 'garbled' : winner.score.verdict;
  return { winner, verdict };
}
