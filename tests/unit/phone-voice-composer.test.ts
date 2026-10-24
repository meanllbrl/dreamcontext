// The hands-free phone's hold-to-talk (task the-hands-free-phone-sends-a-voice-message-that-the-
// mac-s-whisper-turns-into-text, AC1, AC3-AC5): the same mic as the desktop's push-to-talk, drawn
// on Mac mode's phone only while the Mac has local dictation, and none of the desktop voice the
// tunnel refuses (read-aloud, warm, prefs, the voice log). Checked against the source (root vitest
// runs under plain Node); the painted phone is scripts/verify/handsfree-phone-voice.mjs.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url).pathname;
const code = (p: string) => readFileSync(join(ROOT, p), 'utf-8').replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1 ');
const composer = code('dashboard/src/components/sleepy/chat/Composer.tsx');

describe('the phone composer\'s mic', () => {
  it('is on only on Mac mode\'s phone and only while the Mac reports dictation installed (AC3)', () => {
    const hook = code('dashboard/src/hooks/useAgentCapabilities.ts');
    const fn = hook.slice(hook.indexOf('export function usePhoneDictation'), hook.indexOf('export function isSleepAgentReady'));
    expect(fn).toMatch(/return phone && data\?\.dictation === true;/);
    expect(fn).toMatch(/const phone = isMacPhoneSurface\(\);/);
    const caps = code('src/server/routes/agent-terminal.ts');
    expect(caps).toMatch(/dictation: desktop && findWhisper\(\) !== null,/);
  });

  it('reads the capabilities cache passively: no fetch off the phone, no interval per pane (review r1)', () => {
    const hook = code('dashboard/src/hooks/useAgentCapabilities.ts');
    const fn = hook.slice(hook.indexOf('export function usePhoneDictation'), hook.indexOf('export function isSleepAgentReady'));
    expect(fn).toMatch(/queryKey: \['agent-capabilities'\]/);
    expect(fn).toMatch(/enabled: phone,/);
    expect(fn).not.toMatch(/refetchInterval/);
  });

  it('a hold on a touch screen is never a scroll, zoom, selection or callout (review r1)', () => {
    const css = readFileSync(join(ROOT, 'dashboard/src/components/sleepy/chat/composer.css'), 'utf-8');
    const rule = css.slice(css.lastIndexOf('.chat-cmp-mic {'));
    for (const d of ['touch-action: none;', 'user-select: none;', '-webkit-user-select: none;', '-webkit-touch-callout: none;']) expect(rule).toContain(d);
  });

  it('turns the existing push-to-talk on with ONE added term on the gate line (AC1, AC5)', () => {
    // The desktop half is the K7 mic gate (jarvis plan r9); the phone stays ONE added term.
    expect(composer).toMatch(/const phoneVoice = usePhoneDictation\(\);\s*const voiceEnabled = \(isDesktop\(\) && \(mode === 'assistant' \|\| dictationReady\)\) \|\| phoneVoice;/);
  });

  it('keeps the laptop\'s voice off the phone: no read-aloud switch, no warm/prefs, no hotkey wording (AC4)', () => {
    expect(composer).toMatch(/\{voiceEnabled && \(mode === 'assistant' \|\| mode === 'super'\) && !phoneVoice && \(\s*<button\s+type="button"\s+className="chat-cmp-iconbtn chat-cmp-readaloud"/);
    expect(composer).toMatch(/if \(!voiceEnabled \|\| phoneVoice\) return;\s*void fetch\('\/api\/agent\/voice\/warm'/);
    // At rest the phone's mic carries no caption at all (owner, 2026-10-21: short hints).
    expect(composer).toMatch(/!\(phoneVoice && voice\.state === 'idle'\)/);
    const trace = code('dashboard/src/lib/voice/turnTrace.ts');
    expect(trace).toMatch(/if \(!phoneAllows\('POST', '\/api\/agent\/voice\/log'\)\) return;\s*void fetch\('\/api\/agent\/voice\/log'/);
  });

  it('the take still goes through the WebKit capture path and the one open route', () => {
    const capture = code('dashboard/src/lib/voice/useVoiceCapture.ts');
    expect(capture).toMatch(/fetch\('\/api\/agent\/voice\/stt'/);
    expect(capture).toMatch(/wavFromTake\(/);
  });

  it('the phone\'s take ends and is sent at its cap, like a release; the laptop has none (edge-cases review)', () => {
    expect(composer).toMatch(/useVoiceCapture\(\{ vault, onTranscript, onLevel, conv: convId, \.\.\.\(phoneVoice \? \{ maxMs: PHONE_MAX_TAKE_MS \} : \{\}\) \}\)/);
    const capture = code('dashboard/src/lib/voice/useVoiceCapture.ts');
    expect(capture).toMatch(/if \(maxMsRef\.current && ms >= maxMsRef\.current\) stopRef\.current\(\);/);
    expect(capture).toMatch(/stopRef\.current = stop;/);
  });
});
