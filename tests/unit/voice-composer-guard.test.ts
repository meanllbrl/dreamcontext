/**
 * The composer's voice guards — AC15 (where the mic may appear) and AC3f/AC3k (what a second
 * press does while a take is unresolved).
 *
 * WHY THIS FILE IS A SOURCE SCAN. `Composer.tsx` is a React component with CSS imports, and
 * root vitest runs under plain Node with no jsdom, so it cannot be mounted here. The repo
 * already answers this exact problem the same way — see `chat-draft-carry.test.ts`, which
 * pins two respawn sites by reading the source because "the bug came from code that ISN'T
 * there", the class of defect a review misses and a scan catches.
 *
 * WHAT THAT BUYS AND WHAT IT DOES NOT. A scan proves the GUARD EXISTS and that its branches
 * are the specified ones; it cannot prove the runtime behaviour, so AC3f and AC3k stay
 * unticked pending the manual checklist. AC15 is different in kind: its whole claim is a
 * render CONDITION, and the condition is right here in the source — there is nothing about it
 * left for a device to reveal.
 *
 * Written after a clean validator pass flagged both as gaps that needed no microphone to
 * close, and were simply not covered.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const read = (p: string) => readFileSync(join(ROOT, p), 'utf-8');

const COMPOSER = 'dashboard/src/components/sleepy/chat/Composer.tsx';

/**
 * Source with COMMENTS removed but strings kept.
 *
 * Comments have to go: this file's mechanisms are documented at length in `Composer.tsx`, and
 * a naive substring scan would pass on the prose EXPLAINING the rule rather than the code
 * holding it — which teaches the next person to delete the explanation instead of the
 * property. Strings stay: the mode is identified by the literal `'jarvis'`.
 */
function code(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')      // block comments
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 '); // line comments (not the // of a URL)
}

const composer = code(read(COMPOSER));

// ── AC15: where the mic may appear ───────────────────────────────────────────────────────

describe('AC15 — the mic exists in exactly one mode, on exactly one platform', () => {
  it('gates on BOTH the mode and the desktop shell, in one expression', () => {
    // One flag, both conditions, so the two can never drift apart into a mic that renders on
    // the web because someone edited only the mode half.
    expect(composer).toMatch(/const voiceEnabled = mode === 'jarvis' && isDesktop\(\)/);
  });

  it('renders NOTHING mic-related unless that flag is true', () => {
    // Every voice affordance in the toolbar — the button and both notice rows — must sit
    // behind `voiceEnabled`. A JSX block that forgot it would be a mic on the web dashboard,
    // which has no microphone path at all: no Info.plist usage string to carry, and no
    // WKWebView to grant against. The button would exist and could never work.
    const micBlocks = composer.match(/\{voiceEnabled[^\n]*&&/g) ?? [];
    expect(micBlocks.length).toBeGreaterThanOrEqual(3);
    // And the button itself is inside one of them, not floating in the toolbar.
    const at = composer.indexOf('chat-cmp-mic');
    expect(at).toBeGreaterThan(-1);
    const guardBefore = composer.lastIndexOf('{voiceEnabled', at);
    expect(guardBefore).toBeGreaterThan(-1);
    // Nothing closes the guarded block between the guard and the button.
    expect(composer.slice(guardBefore, at)).not.toContain(')}');
  });

  it('reads the desktop shell from the shared detector, never a hand-rolled probe', () => {
    // `lib/desktop.ts`'s `isDesktop()` is the one place that knows what the Tauri webview
    // looks like. A local `navigator.userAgent` sniff here would be a second answer to a
    // question that already has one.
    expect(composer).toMatch(/import \{[^}]*\bisDesktop\b[^}]*\} from '\.\.\/\.\.\/\.\.\/lib\/desktop'/);
    expect(composer).not.toMatch(/__TAURI__|userAgent/);
  });
});

// ── AC3f / AC3k: the busy guard and the pending-text policy ──────────────────────────────

describe('AC3f — a take in flight cannot be raced', () => {
  it('refuses a press while capture or transcription is unresolved', () => {
    // The mic press itself is guarded, and `voice.busy` covers recording AND transcribing
    // (see `useVoiceCapture`'s returned `busy`). `voiceCorrecting` extends it across the
    // correction round trip, which is the ~1-2s window a habitual double-tap lands in.
    expect(composer).toMatch(/if \(!voiceEnabled \|\| voice\.busy \|\| voiceCorrecting\) return;/);
  });

  it('the button is DISABLED across the whole post-release pipeline, not just while recording', () => {
    expect(composer).toMatch(/disabled=\{!connected \|\| voice\.state === 'transcribing' \|\| voiceCorrecting\}/);
  });

  it('an async transcript NEVER overwrites text the owner typed while it was in flight', () => {
    // The rule: compare the live draft against a snapshot taken when the take BEGAN. Untouched
    // → the transcript becomes the message. Touched → it is APPENDED and left unsent, because
    // the owner's half-finished sentence is theirs to finish.
    expect(composer).toMatch(/draftAtTakeRef\.current = /);
    expect(composer).toMatch(/const untouched = typed === draftAtTakeRef\.current;/);
    // The appended branch must not auto-submit. `voiceSubmitTick` is the ONLY submit trigger
    // on the voice path, so it is enough to prove it is unreachable when `untouched` is false.
    const onTranscript = composer.slice(composer.indexOf('const onTranscript'), composer.indexOf('const startTake'));
    const notUntouched = onTranscript.indexOf('if (!untouched)');
    const tick = onTranscript.indexOf('setVoiceSubmitTick');
    expect(notUntouched).toBeGreaterThan(-1);
    expect(tick).toBeGreaterThan(notUntouched); // the early return for edited text comes first
    expect(onTranscript.slice(notUntouched, tick)).toContain('return;');
  });

  it('submits through a TICK, never inline — `commit` reads a ref only a render refreshes', () => {
    // Submitting in the same tick as `setDraft` would send the PREVIOUS draft: a message the
    // owner never spoke. The effect runs after the render that refreshed `liveRef`.
    expect(composer).toMatch(/if \(voiceSubmitTick > 0\) submitRef\.current\('auto'\);/);
  });
});

describe('AC3k — a second press over PENDING text follows the specified policy', () => {
  const startTake = composer.slice(composer.indexOf('const startTake'), composer.indexOf('const endTake'));

  it('refuses when the owner has hand-edited the pending text', () => {
    // Once they have typed into it, it is their text — AC3f's promise extends to
    // machine-produced pending text too.
    expect(startTake).toMatch(/if \(liveRef\.current\.draft !== pending\.text\)/);
    const refuse = startTake.indexOf('!== pending.text');
    expect(startTake.slice(refuse, refuse + 400)).toMatch(/setVoiceNotice\(/);
    expect(startTake.slice(refuse, refuse + 400)).toContain('return;');
  });

  it('DISCARDS and re-records when the pending text is untouched', () => {
    // Tapping the mic while looking at a bad correction IS the owner choosing to redo it.
    // Refusing there would be obstruction.
    expect(startTake).toMatch(/setPending\(null\)/);
    expect(startTake).toMatch(/console\.info\(/); // the discarded transcript is logged
  });

  it('the two branches are ordered refuse-first, so an edit can never be discarded', () => {
    const refuseAt = startTake.indexOf('!== pending.text');
    const discardAt = startTake.indexOf('setPending(null)');
    expect(refuseAt).toBeGreaterThan(-1);
    expect(discardAt).toBeGreaterThan(refuseAt);
  });

  it('a fresh take after a discard snapshots an EMPTY draft, not the text it just cleared', () => {
    // Otherwise the next transcript would compare against the discarded text, read as
    // "hand-edited", and refuse to submit a take nobody had touched.
    expect(startTake).toMatch(/draftAtTakeRef\.current = pending \? '' : liveRef\.current\.draft;/);
  });
});

// ── Barge-in reaches the queue from the two composer-owned triggers ──────────────────────

describe('the composer silences audio from both of its own controls (AC9\'s composer half)', () => {
  it('the mic press barges in synchronously', () => {
    expect(composer).toMatch(/session\.bargeInSpeech\?\.\(\);\s*\n\s*voice\.start\(\);/);
  });

  it('Stop silences before it interrupts', () => {
    expect(composer).toMatch(/session\.bargeInSpeech\?\.\(\); session\.interrupt\(\);/);
  });
});
